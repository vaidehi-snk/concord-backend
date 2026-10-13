/**
 * One place that talks to Gemini. Everything else calls generateText /
 * generateJSON and never builds a URL itself.
 *
 * Built around what actually went wrong in production:
 *  - a model name was retired under us (gemini-2.0-flash) → configurable
 *    model + an ordered fallback list, skipping models that 404
 *  - "This model is currently experiencing high demand" (503/429) → retry
 *    with backoff before giving up
 *  - JSON wrapped in ```fences``` → responseMimeType + defensive parsing
 * Callers must always have a non-LLM fallback; this throws on failure.
 */

const DEFAULT_MODELS = ['gemini-3.6-flash', 'gemini-3-flash', 'gemini-2.5-flash'];

function modelList() {
  const configured = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : [];
  return [...new Set([...configured, ...DEFAULT_MODELS])];
}

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callModel(model, prompt, { temperature = 0.2, json = false, maxOutputTokens = 2048, file } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const generationConfig = { temperature, maxOutputTokens };
  if (json) generationConfig.responseMimeType = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), file ? 60000 : 30000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: file ? [{ inline_data: { mime_type: file.mimeType, data: file.data.toString('base64') } }, { text: prompt }] : [{ text: prompt }] }], generationConfig }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const err = new Error(data?.error?.message || `Gemini HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!text.trim()) {
      const err = new Error('Empty response from Gemini');
      err.status = 502;
      throw err;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

let lastWorkingModel = null;

async function generateText(prompt, opts = {}) {
  if (!isConfigured()) throw new Error('GEMINI_API_KEY not set');
  const models = lastWorkingModel ? [lastWorkingModel, ...modelList().filter((m) => m !== lastWorkingModel)] : modelList();
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const text = await callModel(model, prompt, opts);
        lastWorkingModel = model;
        return text;
      } catch (err) {
        lastErr = err;
        // 404 / 400 "not found / not supported" → this model is gone, try the next one
        if (err.status === 404 || /not found|not supported|deprecated/i.test(err.message)) break;
        // 429 / 5xx / overload → back off and retry the same model
        if (err.status === 429 || err.status >= 500 || /demand|overload|unavailable/i.test(err.message)) {
          await sleep(600 * (attempt + 1) ** 2);
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error('All Gemini models failed');
}

function parseJSONLoose(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Model did not return valid JSON');
  }
}

async function generateJSON(prompt, opts = {}) {
  const text = await generateText(prompt, { ...opts, json: true, temperature: opts.temperature ?? 0 });
  return parseJSONLoose(text);
}

// Vision: send a scanned PDF or a phone photo with the prompt (Gemini reads both natively)
async function generateJSONFromFile(prompt, file, opts = {}) {
  const text = await generateText(prompt, { ...opts, file, json: true, temperature: 0, maxOutputTokens: 4096 });
  return parseJSONLoose(text);
}

module.exports = { generateText, generateJSON, generateJSONFromFile, isConfigured, parseJSONLoose };
