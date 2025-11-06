require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.resolve(__dirname);
const PROMPTS_FILE = path.join(DATA_DIR, 'prompts.json');
const DEFAULT_PROMPT_FILE = path.join(DATA_DIR, 'default_prompt.json');
const CONV_ROOT = path.join(DATA_DIR, 'conversations');
const MODELS_CACHE_FILE = path.join(DATA_DIR, 'models_cache.json');

// Ensure prompts storage exists
function ensurePromptsFile() {
  try {
    if (!fs.existsSync(PROMPTS_FILE)) {
      fs.writeFileSync(PROMPTS_FILE, JSON.stringify({}), 'utf-8');
    } else {
      // validate JSON
      const raw = fs.readFileSync(PROMPTS_FILE, 'utf-8') || '{}';
      JSON.parse(raw);
    }
  } catch (e) {
    console.error('Failed to initialize prompts storage:', e);
    fs.writeFileSync(PROMPTS_FILE, JSON.stringify({}), 'utf-8');
  }
  try {
    if (!fs.existsSync(DEFAULT_PROMPT_FILE)) {
      fs.writeFileSync(DEFAULT_PROMPT_FILE, JSON.stringify(null), 'utf-8');
    } else {
      const raw = fs.readFileSync(DEFAULT_PROMPT_FILE, 'utf-8');
      if (raw && raw.trim()) JSON.parse(raw);
    }
  } catch (e) {
    console.error('Failed to initialize default prompt storage:', e);
    fs.writeFileSync(DEFAULT_PROMPT_FILE, JSON.stringify(null), 'utf-8');
  }
}
ensurePromptsFile();

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== Simple in-memory API calls log (ring buffer) =====
const LOG_MAX = 300;
let apiLogs = []; // [{id, ts, kind: 'openai'|'server', route, method?, status, durationMs?, meta?, note?, error?}]
function pushLog(entry) {
  try {
    const item = { id: Math.random().toString(36).slice(2, 10), ts: Date.now(), ...entry };
    apiLogs.push(item);
    if (apiLogs.length > LOG_MAX) apiLogs = apiLogs.slice(-LOG_MAX);
  } catch {}
}

app.get('/api/logs', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const kind = req.query.kind; // optional filter
  const since = Number(req.query.since) || 0; // optional timestamp filter
  let list = apiLogs;
  if (kind === 'openai' || kind === 'server') list = list.filter(l => l.kind === kind);
  if (since > 0) list = list.filter(l => l.ts > since);
  const out = list.slice(-limit);
  res.json({ logs: out });
});

app.delete('/api/logs', (req, res) => {
  apiLogs = [];
  res.json({ ok: true });
});

// Log all API routes (except ones we already instrument) with duration
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  // Avoid duplicate entries for routes with manual logging and logs polling
  const skip = req.path === '/api/logs' || req.path === '/api/models' || req.path === '/api/chat';
  if (skip) return next();
  const start = Date.now();
  res.on('finish', () => {
    pushLog({ kind: 'server', route: req.path, method: req.method, status: res.statusCode, durationMs: Date.now() - start });
  });
  next();
});

// Initialize OpenAI client
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.warn('Warning: OPENAI_API_KEY is not set. Set it in .env or environment variables.');
}
const openai = new OpenAI({ apiKey });

// In-memory rate limit snapshot (last seen from OpenAI headers)
let lastRateLimits = {
  requests: { remaining: null, limit: null, reset: null, resetMs: null },
  tokens: { remaining: null, limit: null, reset: null, resetMs: null },
  lastUpdated: null,
};

function parseResetToMs(resetVal) {
  if (!resetVal || typeof resetVal !== 'string') return null;
  const v = resetVal.trim().toLowerCase();
  // Try duration formats like "123ms", "2s", "1m"
  const m = v.match(/^(\d+)(ms|s|m)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (Number.isFinite(n)) {
      if (unit === 'ms') return n;
      if (unit === 's') return n * 1000;
      if (unit === 'm') return n * 60 * 1000;
    }
  }
  // Try ISO datetime
  const t = Date.parse(resetVal);
  if (!Number.isNaN(t)) {
    const diff = t - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

function extractRateLimits(headers) {
  if (!headers) return;
  const h = (k) => headers[k] || headers[k.toLowerCase()] || headers[k.toUpperCase()];
  const reqRem = h('x-ratelimit-remaining-requests');
  const reqLim = h('x-ratelimit-limit-requests');
  const reqReset = h('x-ratelimit-reset-requests');
  const tokRem = h('x-ratelimit-remaining-tokens');
  const tokLim = h('x-ratelimit-limit-tokens');
  const tokReset = h('x-ratelimit-reset-tokens');
  const now = Date.now();
  const next = {
    requests: {
      remaining: reqRem != null ? Number(reqRem) : lastRateLimits.requests.remaining,
      limit: reqLim != null ? Number(reqLim) : lastRateLimits.requests.limit,
      reset: reqReset ?? lastRateLimits.requests.reset,
      resetMs: reqReset ? parseResetToMs(String(reqReset)) : lastRateLimits.requests.resetMs,
    },
    tokens: {
      remaining: tokRem != null ? Number(tokRem) : lastRateLimits.tokens.remaining,
      limit: tokLim != null ? Number(tokLim) : lastRateLimits.tokens.limit,
      reset: tokReset ?? lastRateLimits.tokens.reset,
      resetMs: tokReset ? parseResetToMs(String(tokReset)) : lastRateLimits.tokens.resetMs,
    },
    lastUpdated: now,
  };
  lastRateLimits = next;
}

// Health check
app.get('/api/health', (req, res) => {
  const t0 = Date.now();
  try {
    const payload = { ok: true, hasApiKey: Boolean(apiKey) };
    res.json(payload);
    pushLog({ kind: 'server', route: '/api/health', method: 'GET', status: 200, durationMs: Date.now() - t0 });
  } catch (e) {
    pushLog({ kind: 'server', route: '/api/health', method: 'GET', status: 500, durationMs: Date.now() - t0, error: e?.message || String(e) });
    res.status(500).json({ ok: false, error: 'health failed' });
  }
});

// Current usage (rate-limit) snapshot — Option A1
app.get('/api/usage', async (req, res) => {
  try {
    if (!apiKey) return res.status(400).json({ error: 'OPENAI_API_KEY not set on server' });

    const snap = lastRateLimits || {};
    const now = Date.now();
    function normalize(bucket) {
      if (!bucket) return null;
      const remaining = Number.isFinite(bucket.remaining) ? bucket.remaining : null;
      const limit = Number.isFinite(bucket.limit) ? bucket.limit : null;
      const resetMs = Number.isFinite(bucket.resetMs) ? Math.max(0, bucket.resetMs) : null;
      const resetAt = resetMs != null ? (now + resetMs) : null;
      return { remaining, limit, resetMs, resetAt };
    }
    const requests = normalize(snap.requests);
    const tokens = normalize(snap.tokens);

    res.json({
      ok: true,
      serverTime: now,
      lastUpdated: snap.lastUpdated || null,
      requests,
      tokens,
    });
  } catch (e) {
    console.error('Usage snapshot error:', e);
    res.status(500).json({ error: e.message || 'Failed to get usage snapshot' });
  }
});

// ===== Models cache (daily) =====
let modelsCache = null; // { lastFetched: number(ms), models: [{id, supports_chat, supports_reasoning, supports_temperature?}] }
function readModelsCache() {
  try {
    if (!fs.existsSync(MODELS_CACHE_FILE)) return null;
    const raw = fs.readFileSync(MODELS_CACHE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.models)) return null;
    return data;
  } catch { return null; }
}
function writeModelsCache(cache) {
  try {
    fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (e) {
    console.warn('Failed to write models cache:', e?.message || e);
  }
}
function getCachedModels() {
  if (!modelsCache) modelsCache = readModelsCache();
  return modelsCache && Array.isArray(modelsCache.models) ? modelsCache.models : [];
}
function isCacheFresh() {
  if (!modelsCache || !modelsCache.lastFetched) return false;
  const ONE_DAY = 24 * 60 * 60 * 1000;
  return (Date.now() - modelsCache.lastFetched) < ONE_DAY;
}
function updateModelCapability(id, patch) {
  if (!id) return;
  if (!modelsCache) modelsCache = { lastFetched: 0, models: [] };
  const idx = modelsCache.models.findIndex(m => m.id === id);
  if (idx === -1) {
    modelsCache.models.push({ id, supports_chat: true, supports_reasoning: /^(o3|o4)|-reason/i.test(id), ...patch });
  } else {
    modelsCache.models[idx] = { ...modelsCache.models[idx], ...patch };
  }
  writeModelsCache(modelsCache);
}

async function refreshModelsFromOpenAI() {
  const resp = await openai.models.list();
  // Capture rate limit headers from models.list as a cheap refresh point
  try {
    const hdrs = resp?.response?.headers;
    if (hdrs) {
      const obj = typeof hdrs.toJSON === 'function' ? hdrs.toJSON() : (typeof hdrs.get === 'function' ? {
        'x-ratelimit-remaining-requests': hdrs.get('x-ratelimit-remaining-requests'),
        'x-ratelimit-limit-requests': hdrs.get('x-ratelimit-limit-requests'),
        'x-ratelimit-reset-requests': hdrs.get('x-ratelimit-reset-requests'),
        'x-ratelimit-remaining-tokens': hdrs.get('x-ratelimit-remaining-tokens'),
        'x-ratelimit-limit-tokens': hdrs.get('x-ratelimit-limit-tokens'),
        'x-ratelimit-reset-tokens': hdrs.get('x-ratelimit-reset-tokens'),
      } : null);
      if (obj) extractRateLimits(obj);
    }
  } catch {}
  const data = resp?.data || [];
  const fetched = data
    .map(m => ({ id: m.id }))
    .filter(m => typeof m.id === 'string')
    .map(m => ({
      id: m.id,
      supports_chat: /gpt-|^o[34]|-mini|-latest|-chat/i.test(m.id),
      supports_reasoning: /^(o3|o4)|-reason/i.test(m.id)
    }))
    .filter(m => m.supports_chat);
  // Merge with existing cache to preserve supports_temperature flags
  const existing = new Map((modelsCache?.models || []).map(m => [m.id, m]));
  const merged = fetched.map(m => {
    const prev = existing.get(m.id);
    return prev ? { ...m, supports_temperature: prev.supports_temperature } : m;
  });
  modelsCache = { lastFetched: Date.now(), models: Array.from(new Map(merged.map(m => [m.id, m])).values()).sort((a,b)=>a.id.localeCompare(b.id)) };
  writeModelsCache(modelsCache);
  return modelsCache.models;
}

// Models list (uses daily cache)
app.get('/api/models', async (req, res) => {
  const t0 = Date.now();
  try {
    if (!apiKey) {
      const err = 'OPENAI_API_KEY not set on server';
      pushLog({ kind: 'server', route: '/api/models', method: 'GET', status: 400, durationMs: Date.now()-t0, error: err });
      return res.status(400).json({ error: err });
    }
    if (!modelsCache) modelsCache = readModelsCache();
    if (isCacheFresh()) {
      const out = { models: getCachedModels() };
      pushLog({ kind: 'server', route: '/api/models', method: 'GET', status: 200, durationMs: Date.now()-t0, note: 'cache' });
      return res.json(out);
    }
    const models = await refreshModelsFromOpenAI();
    pushLog({ kind: 'openai', route: 'models.list', status: 200, durationMs: Date.now()-t0, meta: { count: models.length } });
    res.json({ models });
  } catch (e) {
    console.error('List models error:', e);
    // If fetch failed, try to return stale cache if present
    const fallback = getCachedModels();
    if (fallback.length) {
      pushLog({ kind: 'server', route: '/api/models', method: 'GET', status: 200, durationMs: Date.now()-t0, note: 'stale-cache' });
      return res.json({ models: fallback });
    }
    pushLog({ kind: 'server', route: '/api/models', method: 'GET', status: 500, durationMs: Date.now()-t0, error: e?.message || String(e) });
    res.status(500).json({ error: e.message || 'Failed to list models' });
  }
});

// Chat endpoint
// Expects: { messages: [{role, content}], systemPrompt?: string, model?: string, reasoningEffort?: 'off'|'low'|'medium'|'high' }
app.post('/api/chat', async (req, res) => {
  const t0 = Date.now();
  try {
    if (!apiKey) {
      const err = 'OPENAI_API_KEY not set on server';
      pushLog({ kind: 'server', route: '/api/chat', method: 'POST', status: 400, durationMs: Date.now()-t0, error: err });
      return res.status(400).json({ error: err });
    }
    const { messages = [], systemPrompt = '', model = 'gpt-4o-mini', reasoningEffort = 'off' } = req.body || {};

    const chatMessages = [];
    if (systemPrompt && systemPrompt.trim().length > 0) {
      chatMessages.push({ role: 'system', content: systemPrompt.trim() });
    }
    for (const m of messages) {
      if (m && m.role && m.content !== undefined) {
        chatMessages.push({ role: m.role, content: String(m.content) });
      }
    }

    const isReasoningCapable = /^o[34]/i.test(String(model));
    const useReasoning = isReasoningCapable && reasoningEffort && reasoningEffort !== 'off';

    let reply = '';
    let usage = null;
    let raw = null;

    function supportsTemperatureFor(id) {
      const list = getCachedModels();
      const found = list.find(m => m.id === id);
      if (found && found.supports_temperature === false) return false;
      return true; // default assume supported
    }
    function isTempUnsupportedError(e) {
      if (!e) return false;
      const msg = (e.message || e.error || e.toString() || '').toLowerCase();
      return msg.includes("unsupported value: 'temperature'") || msg.includes('does not support') && msg.includes('temperature');
    }

    // Reasoning path (Responses API)
    if (useReasoning) {
      const tryWithTemp = supportsTemperatureFor(model);
      for (let attempt = 0; attempt < 2 && !reply; attempt++) {
        const includeTemp = attempt === 0 ? tryWithTemp : false;
        try {
          const reqBody = { model, input: chatMessages, reasoning: { effort: reasoningEffort } };
          if (includeTemp) reqBody.temperature = 0.7;
          const tCall = Date.now();
          const response = await openai.responses.create(reqBody);
          const dur = Date.now() - tCall;
          raw = response;
          try {
            const hdrs = response?.response?.headers;
            if (hdrs) {
              const obj = typeof hdrs.toJSON === 'function' ? hdrs.toJSON() : (typeof hdrs.get === 'function' ? {
                'x-ratelimit-remaining-requests': hdrs.get('x-ratelimit-remaining-requests'),
                'x-ratelimit-limit-requests': hdrs.get('x-ratelimit-limit-requests'),
                'x-ratelimit-reset-requests': hdrs.get('x-ratelimit-reset-requests'),
                'x-ratelimit-remaining-tokens': hdrs.get('x-ratelimit-remaining-tokens'),
                'x-ratelimit-limit-tokens': hdrs.get('x-ratelimit-limit-tokens'),
                'x-ratelimit-reset-tokens': hdrs.get('x-ratelimit-reset-tokens'),
              } : null);
              if (obj) extractRateLimits(obj);
            }
          } catch {}
          // Extract text
          reply = response.output_text || '';
          if (!reply && Array.isArray(response.output)) {
            const firstText = response.output
              .flatMap(o => Array.isArray(o.content) ? o.content : [])
              .find(c => c.type === 'output_text' || c.type === 'text');
            if (firstText && firstText.text) reply = firstText.text;
          }
          // Normalize usage
          if (response.usage) {
            const u = response.usage;
            usage = {
              promptTokens: u.input_tokens ?? u.prompt_tokens ?? null,
              completionTokens: u.output_tokens ?? u.completion_tokens ?? null,
              totalTokens: u.total_tokens ?? ((u.input_tokens || 0) + (u.output_tokens || 0))
            };
          }
          pushLog({ kind: 'openai', route: 'responses.create', status: 200, durationMs: dur, meta: { model, tokens: usage?.totalTokens ?? null, effort: reasoningEffort } });
          break; // success
        } catch (e) {
          if (includeTemp && isTempUnsupportedError(e)) {
            console.warn(`Model ${model} does not support temperature — retrying without it.`);
            updateModelCapability(model, { supports_temperature: false });
            pushLog({ kind: 'openai', route: 'responses.create', status: 400, durationMs: Date.now()-t0, meta: { model }, error: 'temperature_unsupported' });
            continue; // retry without temp
          }
          // Other error → break reasoning path and fallback to chat.completions
          console.warn('Responses API failed, falling back to chat.completions:', e?.message || e);
          pushLog({ kind: 'openai', route: 'responses.create', status: 500, durationMs: Date.now()-t0, meta: { model }, error: e?.message || String(e) });
          break;
        }
      }
      // If we tried without temp and still no reply, we will fall back below
    }

    // Chat Completions path (if no reply yet)
    if (!reply) {
      const tryWithTemp = supportsTemperatureFor(model);
      for (let attempt = 0; attempt < 2 && !reply; attempt++) {
        const includeTemp = attempt === 0 ? tryWithTemp : false;
        try {
          const reqBody = { model, messages: chatMessages };
          if (includeTemp) reqBody.temperature = 0.7;
          const tCall = Date.now();
          const completion = await openai.chat.completions.create(reqBody);
          const dur = Date.now() - tCall;
          raw = completion;
          try {
            const hdrs = completion?.response?.headers;
            if (hdrs) {
              const obj = typeof hdrs.toJSON === 'function' ? hdrs.toJSON() : (typeof hdrs.get === 'function' ? {
                'x-ratelimit-remaining-requests': hdrs.get('x-ratelimit-remaining-requests'),
                'x-ratelimit-limit-requests': hdrs.get('x-ratelimit-limit-requests'),
                'x-ratelimit-reset-requests': hdrs.get('x-ratelimit-reset-requests'),
                'x-ratelimit-remaining-tokens': hdrs.get('x-ratelimit-remaining-tokens'),
                'x-ratelimit-limit-tokens': hdrs.get('x-ratelimit-limit-tokens'),
                'x-ratelimit-reset-tokens': hdrs.get('x-ratelimit-reset-tokens'),
              } : null);
              if (obj) extractRateLimits(obj);
            }
          } catch {}
          const choice = completion.choices?.[0];
          reply = choice?.message?.content ?? '';
          const u = completion.usage || {};
          usage = {
            promptTokens: u.prompt_tokens ?? null,
            completionTokens: u.completion_tokens ?? null,
            totalTokens: u.total_tokens ?? ((u.prompt_tokens || 0) + (u.completion_tokens || 0))
          };
          pushLog({ kind: 'openai', route: 'chat.completions.create', status: 200, durationMs: dur, meta: { model, tokens: usage?.totalTokens ?? null } });
          break; // success
        } catch (e) {
          if (includeTemp && isTempUnsupportedError(e)) {
            console.warn(`Model ${model} does not support temperature — retrying without it.`);
            updateModelCapability(model, { supports_temperature: false });
            pushLog({ kind: 'openai', route: 'chat.completions.create', status: 400, durationMs: Date.now()-t0, meta: { model }, error: 'temperature_unsupported' });
            continue; // retry without temp
          }
          pushLog({ kind: 'openai', route: 'chat.completions.create', status: 500, durationMs: Date.now()-t0, meta: { model }, error: e?.message || String(e) });
          throw e; // propagate other errors
        }
      }
    }

    if (!reply) {
      const err = 'No reply from model';
      pushLog({ kind: 'server', route: '/api/chat', method: 'POST', status: 502, durationMs: Date.now()-t0, error: err });
      throw new Error(err);
    }

    pushLog({ kind: 'server', route: '/api/chat', method: 'POST', status: 200, durationMs: Date.now()-t0, meta: { model, tokens: usage?.totalTokens ?? null } });
    res.json({ reply, raw, usage });
  } catch (err) {
    console.error('Chat error:', err);
    pushLog({ kind: 'server', route: '/api/chat', method: 'POST', status: 500, durationMs: Date.now()-t0, error: err?.message || String(err) });
    res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

// Prompt storage APIs
// Data format in prompts.json: { [name: string]: { name, content, updatedAt } }
function readPrompts() {
  try {
    const raw = fs.readFileSync(PROMPTS_FILE, 'utf-8') || '{}';
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    return {};
  }
}
function writePrompts(map) {
  fs.writeFileSync(PROMPTS_FILE, JSON.stringify(map, null, 2), 'utf-8');
}

app.get('/api/prompts', (req, res) => {
  const data = readPrompts();
  const list = Object.values(data).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({ prompts: list });
});

// Default system prompt APIs
function readDefaultPrompt() {
  try {
    const raw = fs.readFileSync(DEFAULT_PROMPT_FILE, 'utf-8');
    return raw && raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeDefaultPrompt(obj) {
  fs.writeFileSync(DEFAULT_PROMPT_FILE, JSON.stringify(obj, null, 2), 'utf-8');
}

// GET current default
app.get('/api/prompts/default', (req, res) => {
  const cur = readDefaultPrompt();
  res.json({ defaultPrompt: cur });
});

// POST set/update default
// Body: { name?: string, content: string }
app.post('/api/prompts/default', (req, res) => {
  try {
    const { name, content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'Content must be a string' });
    const record = {
      name: name ? String(name).trim() : undefined,
      content,
      updatedAt: new Date().toISOString()
    };
    writeDefaultPrompt(record);
    res.json({ ok: true, defaultPrompt: record });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to set default prompt' });
  }
});

app.post('/api/prompts', (req, res) => {
  try {
    const { name, content } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    if (typeof content !== 'string') return res.status(400).json({ error: 'Content must be a string' });
    const data = readPrompts();
    const key = String(name).trim();
    data[key] = { name: key, content, updatedAt: new Date().toISOString() };
    writePrompts(data);
    res.json({ ok: true, prompt: data[key] });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to save prompt' });
  }
});

app.delete('/api/prompts/:name', (req, res) => {
  try {
    const key = req.params.name;
    const data = readPrompts();
    if (data[key]) {
      delete data[key];
      writePrompts(data);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to delete prompt' });
  }
});

// Conversation saving (manual + autosave)
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function pad2(n) { return String(n).padStart(2, '0'); }
function localDateParts(d = new Date()) {
  const year = d.getFullYear();
  const month = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hours = pad2(d.getHours());
  const minutes = pad2(d.getMinutes());
  const seconds = pad2(d.getSeconds());
  return { year, month, day, hours, minutes, seconds };
}

app.post('/api/conversations/save', (req, res) => {
  const t0 = Date.now();
  try {
    const { conversationId, model, systemPrompt = '', transcript = [], autosave = false } = req.body || {};
    const id = String(conversationId || '').trim() || Math.random().toString(36).slice(2, 10);
    const d = new Date();
    const { year, month, day } = localDateParts(d);
    const dateDir = `${year}-${month}-${day}`; // local date (folder)
    const dir = path.join(CONV_ROOT, dateDir);
    ensureDir(dir);

    // Single file per day per conversation id
    const file = path.join(dir, `${id}.json`);

    const record = {
      id,
      savedAt: d.toISOString(),
      autosave: Boolean(autosave),
      model: model || 'gpt-4o-mini',
      systemPrompt: String(systemPrompt || ''),
      transcript: Array.isArray(transcript) ? transcript : [],
      stats: { messages: Array.isArray(transcript) ? transcript.length : 0 }
    };

    // Atomic write via temp then rename, always updating the same daily file
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
    fs.renameSync(tmp, file);

    const rel = path.relative(DATA_DIR, file).replace(/\\/g, '/');
    pushLog({ kind: 'server', route: '/api/conversations/save', method: 'POST', status: 200, durationMs: Date.now()-t0, meta: { path: rel } });
    res.json({ ok: true, path: rel });
  } catch (e) {
    console.error('Save conversation error:', e);
    pushLog({ kind: 'server', route: '/api/conversations/save', method: 'POST', status: 500, durationMs: Date.now()-t0, error: e?.message || String(e) });
    res.status(500).json({ error: e.message || 'Failed to save conversation' });
  }
});

// List daily conversations with optional content search
// GET /api/conversations?date=YYYY-MM-DD&q=term1+term2
app.get('/api/conversations', (req, res) => {
  const t0 = Date.now();
  try {
    const date = (req.query.date || '').toString().trim();
    let dateDir;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      dateDir = date;
    } else {
      const { year, month, day } = localDateParts(new Date());
      dateDir = `${year}-${month}-${day}`; // default today
    }
    const dir = path.join(CONV_ROOT, dateDir);
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];

    if (!fs.existsSync(dir)) {
      pushLog({ kind: 'server', route: '/api/conversations', method: 'GET', status: 200, durationMs: Date.now()-t0, note: 'no-folder' });
      return res.json({ items: [], date: dateDir });
    }
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json'));
    const items = [];
    for (const f of files) {
      const full = path.join(dir, f);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      let raw;
      try { raw = fs.readFileSync(full, 'utf-8'); } catch { continue; }
      if (terms.length) {
        const lc = raw.toLowerCase();
        const ok = terms.every(t => lc.includes(t));
        if (!ok) continue;
      }
      let meta = {};
      try { meta = JSON.parse(raw); } catch { meta = {}; }
      const rel = path.relative(DATA_DIR, full).replace(/\\/g, '/');
      const firstUser = Array.isArray(meta.transcript) ? (meta.transcript.find(m => m.role === 'user')?.content || '') : '';
      items.push({
        id: meta.id || f.replace(/\.json$/i, ''),
        path: rel,
        model: meta.model || null,
        lastUpdated: stat.mtimeMs,
        size: stat.size,
        messageCount: Array.isArray(meta.transcript) ? meta.transcript.length : (meta.stats?.messages || null),
        preview: firstUser.slice(0, 200)
      });
    }
    items.sort((a,b)=> b.lastUpdated - a.lastUpdated);
    pushLog({ kind: 'server', route: '/api/conversations', method: 'GET', status: 200, durationMs: Date.now()-t0, meta: { count: items.length, date: dateDir } });
    res.json({ items, date: dateDir });
  } catch (e) {
    pushLog({ kind: 'server', route: '/api/conversations', method: 'GET', status: 500, durationMs: Date.now()-t0, error: e?.message || String(e) });
    res.status(500).json({ error: e.message || 'Failed to list conversations' });
  }
});

// ===== Conversations export/import/delete =====
function sanitizeId(id) {
  return String(id || '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 120) || 'conv';
}
function ymdFromIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const { year, month, day } = localDateParts(d);
  return `${year}-${month}-${day}`;
}

// Read one conversation by date + id
function readConversation(dateDir, id) {
  const dir = path.join(CONV_ROOT, dateDir);
  const file = path.join(dir, `${sanitizeId(id)}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

// GET export single: /api/conversations/export?date=YYYY-MM-DD&id=...
app.get('/api/conversations/export', (req, res) => {
  const t0 = Date.now();
  try {
    const id = sanitizeId(req.query.id || '');
    const date = (req.query.date || '').toString().trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !id) {
      pushLog({ kind: 'server', route: '/api/conversations/export', method: 'GET', status: 400, durationMs: Date.now()-t0, error: 'bad params' });
      return res.status(400).json({ error: 'Provide date=YYYY-MM-DD and id' });
    }
    const obj = readConversation(date, id);
    if (!obj) {
      pushLog({ kind: 'server', route: '/api/conversations/export', method: 'GET', status: 404, durationMs: Date.now()-t0, error: 'not found' });
      return res.status(404).json({ error: 'Not found' });
    }
    const filename = `conversation-${date}-${id}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    pushLog({ kind: 'server', route: '/api/conversations/export', method: 'GET', status: 200, durationMs: Date.now()-t0, meta: { date, id } });
    res.end(JSON.stringify(obj, null, 2));
  } catch (e) {
    pushLog({ kind: 'server', route: '/api/conversations/export', method: 'GET', status: 500, durationMs: Date.now()-t0, error: e?.message || String(e) });
    res.status(500).json({ error: e.message || 'Failed to export' });
  }
});

// POST bulk export: { items: [{date, id}, ...] }
app.post('/api/conversations/export', (req, res) => {
  const t0 = Date.now();
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const out = [];
    let notFound = 0;
    for (const it of items) {
      const date = (it?.date || '').toString().trim();
      const id = sanitizeId(it?.id || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !id) continue;
      const obj = readConversation(date, id);
      if (obj) out.push(obj); else notFound++;
    }
    const bundle = { manifest: { version: 1, exportedAt: new Date().toISOString(), count: out.length }, items: out };
    pushLog({ kind: 'server', route: '/api/conversations/export', method: 'POST', status: 200, durationMs: Date.now()-t0, meta: { count: out.length, notFound } });
    res.json(bundle);
  } catch (e) {
    pushLog({ kind: 'server', route: '/api/conversations/export', method: 'POST', status: 500, durationMs: Date.now()-t0, error: e?.message || String(e) });
    res.status(500).json({ error: e.message || 'Failed to export' });
  }
});

// POST import: accepts one conversation object, an array, or { items: [...] }.
// Body: { overwrite?: boolean, dateOverride?: 'YYYY-MM-DD', items?: [...]} or direct items
app.post('/api/conversations/import', (req, res) => {
  const t0 = Date.now();
  try {
    const overwrite = !!req.body?.overwrite;
    const dateOverride = (req.body?.dateOverride || '').toString().trim();
    let items = [];
    if (Array.isArray(req.body)) items = req.body;
    else if (Array.isArray(req.body?.items)) items = req.body.items;
    else if (req.body && typeof req.body === 'object' && req.body.id) items = [req.body];
    if (!items.length) return res.status(400).json({ error: 'No items to import' });

    const results = [];
    let imported = 0, overwritten = 0, skipped = 0;

    for (const obj of items) {
      if (!obj || typeof obj !== 'object') { skipped++; continue; }
      const id0 = sanitizeId(obj.id || genId());
      const dateDir = /^\d{4}-\d{2}-\d{2}$/.test(dateOverride) ? dateOverride : (ymdFromIso(obj.savedAt) || (function(){ const {year,month,day}=localDateParts(new Date()); return `${year}-${month}-${day}`; })());
      const dir = path.join(CONV_ROOT, dateDir);
      ensureDir(dir);
      let id = id0;
      let file = path.join(dir, `${id}.json`);
      if (fs.existsSync(file)) {
        if (overwrite) {
          overwritten++;
        } else {
          // find next available suffix -2, -3, ... up to -99
          let n = 2;
          while (n < 100) {
            const cand = `${id0}-${n}`;
            const f2 = path.join(dir, `${cand}.json`);
            if (!fs.existsSync(f2)) { id = cand; file = f2; break; }
            n++;
          }
          if (n >= 100 && fs.existsSync(file)) { skipped++; continue; }
        }
      }
      // Ensure minimum fields
      const record = {
        id,
        savedAt: obj.savedAt || new Date().toISOString(),
        autosave: Boolean(obj.autosave),
        model: obj.model || 'gpt-4o-mini',
        systemPrompt: String(obj.systemPrompt || ''),
        transcript: Array.isArray(obj.transcript) ? obj.transcript : [],
        stats: { messages: Array.isArray(obj.transcript) ? obj.transcript.length : (obj.stats?.messages || 0) }
      };
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
      fs.renameSync(tmp, file);
      results.push({ id, date: dateDir, path: path.relative(DATA_DIR, file).replace(/\\/g, '/') });
      imported++;
    }

    pushLog({ kind: 'server', route: '/api/conversations/import', method: 'POST', status: 200, durationMs: Date.now()-t0, meta: { imported, overwritten, skipped } });
    res.json({ ok: true, imported, overwritten, skipped, items: results });
  } catch (e) {
    pushLog({ kind: 'server', route: '/api/conversations/import', method: 'POST', status: 500, durationMs: Date.now()-t0, error: e?.message || String(e) });
    res.status(500).json({ error: e.message || 'Failed to import' });
  }
});

// DELETE single: /api/conversations/:date/:id
app.delete('/api/conversations/:date/:id', (req, res) => {
  const t0 = Date.now();
  try {
    const date = (req.params.date || '').toString().trim();
    const id = sanitizeId(req.params.id || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !id) return res.status(400).json({ error: 'Bad date or id' });
    const file = path.join(CONV_ROOT, date, `${id}.json`);
    if (!fs.existsSync(file)) return res.json({ ok: true, deleted: 0 });
    fs.unlinkSync(file);
    pushLog({ kind: 'server', route: '/api/conversations/:date/:id', method: 'DELETE', status: 200, durationMs: Date.now()-t0, meta: { date, id } });
    res.json({ ok: true, deleted: 1 });
  } catch (e) {
    pushLog({ kind: 'server', route: '/api/conversations/:date/:id', method: 'DELETE', status: 500, durationMs: Date.now()-t0, error: e?.message || String(e) });
    res.status(500).json({ error: e.message || 'Failed to delete' });
  }
});

// POST bulk delete: { items: [{date,id}]} or { filter: { date, q }}
app.post('/api/conversations/delete', (req, res) => {
  const t0 = Date.now();
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    let list = [];
    if (items && items.length) {
      list = items.map(it => ({ date: String(it.date||''), id: sanitizeId(it.id||'') }))
        .filter(it => /^\d{4}-\d{2}-\d{2}$/.test(it.date) && it.id);
    } else if (req.body?.filter && typeof req.body.filter === 'object') {
      const date = (req.body.filter.date || '').toString().trim();
      const q = (req.body.filter.q || '').toString().trim();
      // Reuse listing logic to determine matches
      const req2 = { query: { date, q } };
      let payload;
      try {
        const dateDir = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : (function(){ const {year,month,day}=localDateParts(new Date()); return `${year}-${month}-${day}`; })();
        const dir = path.join(CONV_ROOT, dateDir);
        if (fs.existsSync(dir)) {
          const terms = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
          const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json'));
          for (const f of files) {
            const full = path.join(dir, f);
            let raw; try { raw = fs.readFileSync(full,'utf-8'); } catch { continue; }
            if (terms.length) {
              const lc = raw.toLowerCase();
              const ok = terms.every(t => lc.includes(t));
              if (!ok) continue;
            }
            const id = f.replace(/\.json$/i, '');
            list.push({ date: dateDir, id });
          }
        }
      } catch {}
    }
    let deleted = 0, errors = 0;
    for (const it of list) {
      try {
        const file = path.join(CONV_ROOT, it.date, `${it.id}.json`);
        if (fs.existsSync(file)) { fs.unlinkSync(file); deleted++; }
      } catch { errors++; }
    }
    pushLog({ kind: 'server', route: '/api/conversations/delete', method: 'POST', status: 200, durationMs: Date.now()-t0, meta: { requested: list.length, deleted, errors } });
    res.json({ ok: true, requested: list.length, deleted, errors });
  } catch (e) {
    pushLog({ kind: 'server', route: '/api/conversations/delete', method: 'POST', status: 500, durationMs: Date.now()-t0, error: e?.message || String(e) });
    res.status(500).json({ error: e.message || 'Failed to delete conversations' });
  }
});

app.listen(PORT, () => {
  console.log(`LCGPT server running at http://localhost:${PORT}`);
});
