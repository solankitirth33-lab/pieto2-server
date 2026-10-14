const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

app.use(cors());
app.use(express.json({ limit: '12mb' }));

// Existing Claude chat endpoint — kept unchanged for compatibility.
app.post('/chat', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pieto camera vision endpoint (Gemini).
// Send { prompt, image } where image is a base64 data URL or raw base64.
app.post('/vision', async (req, res) => {
  try {
    const { prompt, image } = req.body || {};

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY is not configured on the server.'
      });
    }

    if (!image || typeof image !== 'string') {
      return res.status(400).json({
        error: 'Missing image. Send a base64 data URL in the image field.'
      });
    }

    // Split "data:image/jpeg;base64,XXXX" into mime type + raw base64.
    const match = image.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/);
    const mimeType = match ? match[1] : 'image/jpeg';
    const base64Data = match ? match[2] : image;

    const userPrompt =
      typeof prompt === 'string' && prompt.trim()
        ? prompt.trim()
        : 'Describe what you can see in this camera image. Be concise and useful.';

    const model = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text:
                'You are Pieto, a helpful visual AI assistant. Analyze the provided camera image carefully. Answer the user directly, avoid inventing details, and clearly say when something cannot be determined from the image. Keep answers concise enough to be spoken aloud. Support English, Hindi, and Hinglish.'
            }]
          },
          contents: [{
            role: 'user',
            parts: [
              { text: userPrompt },
              { inline_data: { mime_type: mimeType, data: base64Data } }
            ]
          }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1024
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || 'Gemini vision request failed',
        details: data
      });
    }

    const answer = (data?.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '')
      .join('')
      .trim();

    res.json({
      ok: true,
      model,
      answer,
      raw: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Vision request failed' });
  }
});


// Pieto voice transcription endpoint.
// The frontend records microphone audio and sends it here as base64.
// This deliberately avoids Android SpeechRecognizer so Android error 11
// cannot break Pieto voice mode.
app.post('/transcribe', async (req, res) => {
  try {
    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'OPENROUTER_API_KEY is not configured on the server.' });
    }

    const { audio, audioMime } = req.body || {};
    if (!audio || typeof audio !== 'string') {
      return res.status(400).json({ error: 'Missing audio. Send base64 audio in the audio field.' });
    }

    const mime = typeof audioMime === 'string' && audioMime.trim()
      ? audioMime.split(';')[0]
      : 'audio/webm';
    const extension = mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm';
    const model = process.env.OPENROUTER_STT_MODEL || 'openai/whisper-large-v3-turbo';

    const binary = Buffer.from(audio, 'base64');
    const boundary = `----PietoBoundary${Date.now()}`;
    const chunks = [];
    const addField = (name, value) => {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    };
    addField('model', model);
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pieto.${extension}"\r\nContent-Type: ${mime}\r\n\r\n`));
    chunks.push(binary);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'HTTP-Referer': 'https://pieto2-server.onrender.com',
        'X-Title': 'Pieto'
      },
      body: Buffer.concat(chunks)
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || data?.error || 'OpenRouter transcription failed',
        details: data
      });
    }

    res.json({
      ok: true,
      model: data.model || model,
      text: typeof data.text === 'string' ? data.text.trim() : ''
    });
  } catch (err) {
    console.error('Pieto transcription error:', err);
    res.status(500).json({ error: err.message || 'Transcription failed' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Pieto server',
    openrouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    visionModel: process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash',
    sttModel: process.env.OPENROUTER_STT_MODEL || 'openai/whisper-large-v3-turbo'
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Pieto server running on port ${PORT}`));
