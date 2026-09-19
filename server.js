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

// Pieto camera vision endpoint.
// Send { prompt, image } where image is a base64 data URL such as
// data:image/jpeg;base64,...
app.post('/vision', async (req, res) => {
  try {
    const { prompt, image } = req.body || {};

    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({
        error: 'OPENROUTER_API_KEY is not configured on the server.'
      });
    }

    if (!image || typeof image !== 'string') {
      return res.status(400).json({
        error: 'Missing image. Send a base64 data URL in the image field.'
      });
    }

    // Accept either a complete data URL or raw base64.
    const imageUrl = image.startsWith('data:image/')
      ? image
      : `data:image/jpeg;base64,${image}`;

    const userPrompt =
      typeof prompt === 'string' && prompt.trim()
        ? prompt.trim()
        : 'Describe what you can see in this camera image. Be concise and useful.';

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://pieto2-server.onrender.com',
        'X-Title': 'Pieto'
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_VISION_MODEL || 'google/gemma-4-31b-it:free',
        messages: [
          {
            role: 'system',
            content:
              'You are Pieto, a helpful visual AI assistant. Analyze the provided camera image carefully. Answer the user directly, avoid inventing details, and clearly say when something cannot be determined from the image. Keep answers concise enough to be spoken aloud. Support English, Hindi, and Hinglish.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              {
                type: 'image_url',
                image_url: { url: imageUrl }
              }
            ]
          }
        ],
        temperature: 0.2,
        max_tokens: 300
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || data?.error || 'OpenRouter vision request failed',
        details: data
      });
    }

    const answer = data?.choices?.[0]?.message?.content;

    res.json({
      ok: true,
      model: data.model || process.env.OPENROUTER_VISION_MODEL || 'google/gemma-4-31b-it:free',
      answer: typeof answer === 'string' ? answer : '',
      raw: data
    });
  } catch (err) {
    res.status(500).json({
      error: err.message || 'Vision request failed'
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Pieto server',
    openrouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
    visionModel: process.env.OPENROUTER_VISION_MODEL || 'google/gemma-4-31b-it:free'
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Pieto server running on port ${PORT}`));
