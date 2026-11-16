const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(cors());
app.use(express.json({ limit: '12mb' }));

/* ------------------------------------------------------------------ *
 * Helpers: timeout fetch, retry, tiny in-memory rate limiter + cache
 * ------------------------------------------------------------------ */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Simple fixed-window limiter per IP (no extra dependency).
function rateLimit({ windowMs, max, name }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({
        ok: false,
        error: `Too many ${name} requests. Please wait a moment and try again.`
      });
    }
    next();
  };
}

// Small LRU cache so identical image prompts don't burn credits twice.
class LRU {
  constructor(limit) { this.limit = limit; this.map = new Map(); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }
}

/* ------------------------------------------------------------------ *
 * Chat quality layer (Claude) — server-side prompt engineering.
 * The app's own system prompt is kept untouched; we only append to it.
 * ------------------------------------------------------------------ */

const QUALITY_ADDENDUM = `

[Answer-quality rules]
- Understand the real goal behind the question. Give the direct answer first, then brief supporting detail. No filler, no repeating the question.
- Think step by step privately for math, logic, and multi-part problems; show only the clear final reasoning and result. Double-check numbers and units before answering.
- Never invent facts, links, citations, or APIs. If you are unsure or lack current information, say so plainly and suggest how to verify.
- If the question is ambiguous and a wrong guess would waste the user's time, ask ONE short clarifying question; otherwise state your assumption and answer.
- Match the user's language and register: reply in English, Hindi (Devanagari), or Hinglish (Roman script) the same way the user writes.
- Keep replies concise by default; go deeper only when the topic needs it or the user asks. Use short paragraphs, and use lists or tables only when they genuinely help.
- For spoken-style or very short messages, reply naturally and briefly.`;

const CODING_ADDENDUM = `

[Coding rules]
- Write complete, runnable code, not fragments with "..." placeholders. Include imports, setup, and a short usage example when useful.
- Put all code in fenced blocks with the correct language tag. Explain after the code, briefly.
- Prefer simple, readable, idiomatic solutions. Handle errors and edge cases (empty input, null, timeouts, invalid values) where they matter.
- When debugging: identify the root cause first, show the minimal fix, and explain why it works. Don't rewrite unrelated code.
- State the language/framework versions you assume when it matters. Mention security issues (injection, secrets in code, unsafe input) if you spot them.
- For algorithms, mention time/space complexity in one line.
- Never use deprecated APIs when a current alternative exists; if unsure of an API, say so rather than guessing.`;

const CODING_HINT = new RegExp(
  [
    '```', '\\bcode\\b', '\\bcoding\\b', '\\bscript\\b', '\\bfunction\\b', '\\bbug\\b', '\\bdebug',
    '\\berror\\b', '\\bexception\\b', '\\bstack ?trace', '\\bcompile', '\\bAPI\\b', '\\bJSON\\b',
    '\\bSQL\\b', '\\bregex\\b', '\\bpython\\b', '\\bjavascript\\b', '\\btypescript\\b', '\\bnode(\\.js)?\\b',
    '\\breact\\b', '\\bjava\\b', '\\bkotlin\\b', '\\bswift\\b', '\\bc\\+\\+', '\\bc#', '\\bhtml\\b', '\\bcss\\b',
    '\\bandroid\\b', '\\bflutter\\b', '\\bgit\\b', '\\bdocker\\b', '\\balgorithm', '\\bprogram',
    'console\\.log', 'def ', 'import ', 'npm ', 'pip '
  ].join('|'),
  'i'
);

function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
      }
    }
  }
  return '';
}

function looksLikeCoding(messages) {
  return CODING_HINT.test(lastUserText(messages));
}

// Append our rules to whatever system prompt the app sent (string or block array).
function enhanceSystem(system, coding) {
  const extra = QUALITY_ADDENDUM + (coding ? CODING_ADDENDUM : '');
  if (Array.isArray(system)) return [...system, { type: 'text', text: extra }];
  return (typeof system === 'string' ? system : '') + extra;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

const chatLimiter = rateLimit({ windowMs: 60_000, max: Number(process.env.CHAT_RATE_PER_MIN) || 40, name: 'chat' });

app.post('/chat', chatLimiter, async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' });
    }

    const body = { ...(req.body || {}) };
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: 'Missing messages array.' });
    }

    // Quality layer (opt-out per request with { raw: true }).
    if (!body.raw) {
      const coding = looksLikeCoding(body.messages);
      body.system = enhanceSystem(body.system, coding);
      // Code answers get cut off at small limits — give them room.
      const floor = coding ? 4096 : 1500;
      body.max_tokens = Math.min(Math.max(Number(body.max_tokens) || 0, floor), 8192);
    }
    delete body.raw;
    if (!body.model) body.model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';

    // Retry transient upstream failures (rate limit / overloaded) with backoff.
    let response, data;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await fetchWithTimeout(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(body)
          },
          120000
        );
        data = await response.json();
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        await sleep(600 * attempt);
        continue;
      }
      if (response.ok || !RETRYABLE.has(response.status) || attempt === maxAttempts) break;
      await sleep(800 * attempt);
    }

    res.status(response.status).json(data);
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    res.status(timedOut ? 504 : 500).json({
      error: timedOut ? 'The AI took too long to respond. Please try again.' : (err.message || 'Chat request failed')
    });
  }
});

/* ------------------------------------------------------------------ *
 * Vision (Gemini) — unchanged behaviour
 * ------------------------------------------------------------------ */

app.post('/vision', async (req, res) => {
  try {
    const { prompt, image } = req.body || {};

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    }
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'Missing image. Send a base64 data URL in the image field.' });
    }

    const match = image.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/);
    const mimeType = match ? match[1] : 'image/jpeg';
    const base64Data = match ? match[2] : image;

    const userPrompt =
      typeof prompt === 'string' && prompt.trim()
        ? prompt.trim()
        : 'Describe what you can see in this camera image. Be concise and useful.';

    const model = process.env.GEMINI_VISION_MODEL || 'gemini-3.8-flash';

    const response = await fetchWithTimeout(
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
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
        })
      },
      60000
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

    res.json({ ok: true, model, answer, raw: data });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Vision request failed' });
  }
});

/* ------------------------------------------------------------------ *
 * Voice transcription (Gemini) — unchanged behaviour
 * ------------------------------------------------------------------ */

app.post('/transcribe', async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    }

    const { audio, audioMime } = req.body || {};
    if (!audio || typeof audio !== 'string') {
      return res.status(400).json({ error: 'Missing audio. Send base64 audio in the audio field.' });
    }

    const mime = typeof audioMime === 'string' && audioMime.trim()
      ? audioMime.split(';')[0].trim()
      : 'audio/webm';
    const base64Audio = audio.replace(/^data:[^;]+;base64,/, '');
    const model = process.env.GEMINI_STT_MODEL || 'gemini-3.8-flash';

    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              {
                text: 'Transcribe this audio exactly as spoken. The speech may be English, Hindi, or Hinglish. Return only the transcription text, nothing else. If there is no speech, return an empty string.'
              },
              { inline_data: { mime_type: mime, data: base64Audio } }
            ]
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 1024 }
        })
      },
      60000
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || 'Gemini transcription failed',
        details: data
      });
    }

    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '')
      .join('')
      .trim();

    res.json({ ok: true, model, text });
  } catch (err) {
    console.error('Pieto transcription error:', err.message);
    res.status(500).json({ error: err.message || 'Transcription failed' });
  }
});

/* ------------------------------------------------------------------ *
 * Image generation — Pollinations.ai
 *   Env: POLLINATIONS_API_KEY (sk_... server key)
 *        POLLINATIONS_MODEL   (default "flux"; fallbacks below)
 * Response shape is unchanged for the app: { ok, model, image: "data:image/jpeg;base64,..." }
 * ------------------------------------------------------------------ */

const POLLINATIONS_BASE = 'https://gen.pollinations.ai/image';
const IMAGE_MODEL_CHAIN = [
  process.env.POLLINATIONS_MODEL || 'flux',
  'zimage',
  'flux-2-dev'
].filter((m, i, a) => a.indexOf(m) === i);

const imageCache = new LRU(30);

// Free, local prompt improvement: strip "draw me a..." chatter, add style/quality hints
// unless the user already specified a style.
const STYLE_WORDS = /\b(photo(?:realistic|graph)?|realistic|cinematic|anime|cartoon|3d|render|pixel art|watercolou?r|oil painting|sketch|illustration|vector|logo|flat design|isometric|low poly|studio ghibli|cyberpunk|minimalist|painting|digital art)\b/i;

function improveImagePrompt(raw) {
  let p = String(raw || '').trim().replace(/\s+/g, ' ');

  p = p
    .replace(/^(?:please\s+)?(?:can you\s+|could you\s+)?(?:generate|create|make|draw|paint|show me|give me)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:image|picture|photo|pic|drawing|illustration)?\s*(?:of|showing)?\s*/i, '')
    .trim() || p;

  if (!STYLE_WORDS.test(p)) {
    p += ', highly detailed, sharp focus, natural lighting, high quality';
  } else {
    p += ', highly detailed, high quality';
  }
  return p.slice(0, 1500);
}

const imageLimiter = rateLimit({ windowMs: 60_000, max: Number(process.env.IMAGE_RATE_PER_MIN) || 8, name: 'image' });

app.post('/image-generation', imageLimiter, async (req, res) => {
  try {
    const { prompt, width, height, model: requestedModel } = req.body || {};

    if (!process.env.POLLINATIONS_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Image generation is not configured (POLLINATIONS_API_KEY missing on the server).'
      });
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ ok: false, error: 'Please provide an image prompt.' });
    }

    const finalPrompt = improveImagePrompt(prompt);
    const w = Math.min(Math.max(parseInt(width, 10) || 1024, 256), 1536);
    const h = Math.min(Math.max(parseInt(height, 10) || 1024, 256), 1536);

    const cacheKey = `${finalPrompt}|${w}x${h}|${requestedModel || ''}`;
    const cached = imageCache.get(cacheKey);
    if (cached && !req.body.fresh) {
      return res.json({ ok: true, cached: true, ...cached });
    }

    const models = typeof requestedModel === 'string' && /^[\w.-]{1,40}$/.test(requestedModel)
      ? [requestedModel, ...IMAGE_MODEL_CHAIN]
      : IMAGE_MODEL_CHAIN;

    let lastError = 'Image generation failed.';
    let lastStatus = 502;

    for (const model of models) {
      const seed = Math.floor(Math.random() * 2_000_000_000);
      const url =
        `${POLLINATIONS_BASE}/${encodeURIComponent(finalPrompt)}` +
        `?model=${encodeURIComponent(model)}&width=${w}&height=${h}&seed=${seed}&nologo=true&safe=false`;

      let response;
      try {
        response = await fetchWithTimeout(
          url,
          { headers: { Authorization: `Bearer ${process.env.POLLINATIONS_API_KEY}` } },
          90000
        );
      } catch (err) {
        lastError = err.name === 'AbortError' ? 'Image generation timed out.' : 'Could not reach the image service.';
        lastStatus = err.name === 'AbortError' ? 504 : 502;
        continue; // try next model
      }

      const contentType = response.headers.get('content-type') || '';

      if (response.ok && contentType.startsWith('image/')) {
        const buf = await response.buffer();
        if (buf.length < 500) { lastError = 'The image service returned an empty image.'; continue; }
        const mime = contentType.split(';')[0].trim();
        const result = { model, image: `data:${mime};base64,${buf.toString('base64')}` };
        imageCache.set(cacheKey, result);
        return res.json({ ok: true, ...result });
      }

      // Error body is JSON: { success:false, error:{ code, message } }
      let msg = '';
      try {
        const j = await response.json();
        msg = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : '');
      } catch (_) { /* ignore */ }

      lastStatus = response.status || 502;
      lastError = msg || `Image service error (${response.status}).`;

      // Auth/balance problems won't be fixed by another model — stop early.
      if ([401, 402, 403].includes(response.status)) {
        console.error('Pollinations auth/billing error:', response.status, msg);
        break;
      }
      if (response.status === 400) break; // bad prompt/params
    }

    console.error('Pieto image generation failed:', lastStatus, lastError);
    const status = [401, 402, 403].includes(lastStatus) ? 502 : (lastStatus >= 400 ? lastStatus : 502);
    return res.status(status).json({ ok: false, error: lastError });
  } catch (err) {
    console.error('Pieto image generation error:', err.message);
    return res.status(500).json({ ok: false, error: 'Image generation request failed.' });
  }
});

/* ------------------------------------------------------------------ */

app.get('/', (req, res) => res.json({ ok: true, service: 'Pieto server' }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Pieto server',
    version: '1.2.0',
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    pollinationsConfigured: Boolean(process.env.POLLINATIONS_API_KEY),
    visionModel: process.env.GEMINI_VISION_MODEL || 'gemini-3.8-flash',
    sttModel: process.env.GEMINI_STT_MODEL || 'gemini-3.8-flash',
    imageModels: IMAGE_MODEL_CHAIN
  });
});

// Never leak stack traces; also catches oversized/invalid JSON bodies.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  console.error('Unhandled error:', err && err.message);
  res.status(500).json({ error: 'Server error.' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Pieto server running on port ${PORT}`));
