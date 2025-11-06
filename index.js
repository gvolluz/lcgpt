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

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize OpenAI client
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.warn('Warning: OPENAI_API_KEY is not set. Set it in .env or environment variables.');
}
const openai = new OpenAI({ apiKey });

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(apiKey) });
});

// Chat endpoint
// Expects: { messages: [{role, content}], systemPrompt?: string, model?: string }
app.post('/api/chat', async (req, res) => {
  try {
    if (!apiKey) {
      return res.status(400).json({ error: 'OPENAI_API_KEY not set on server' });
    }
    const { messages = [], systemPrompt = '', model = 'gpt-4o-mini' } = req.body || {};

    const chatMessages = [];
    if (systemPrompt && systemPrompt.trim().length > 0) {
      chatMessages.push({ role: 'system', content: systemPrompt.trim() });
    }
    for (const m of messages) {
      if (m && m.role && m.content !== undefined) {
        chatMessages.push({ role: m.role, content: String(m.content) });
      }
    }

    const completion = await openai.chat.completions.create({
      model,
      messages: chatMessages,
      temperature: 0.7,
    });

    const choice = completion.choices?.[0];
    const reply = choice?.message?.content ?? '';

    res.json({ reply, raw: completion });
  } catch (err) {
    console.error('Chat error:', err);
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
  try {
    const { conversationId, model, systemPrompt = '', transcript = [], autosave = false } = req.body || {};
    const id = String(conversationId || '').trim() || Math.random().toString(36).slice(2, 10);
    const d = new Date();
    const { year, month, day, hours, minutes, seconds } = localDateParts(d);
    const dateDir = `${year}-${month}-${day}`; // local date
    const dir = path.join(CONV_ROOT, dateDir);
    ensureDir(dir);

    const ts = `${year}${month}${day}-${hours}${minutes}${seconds}`; // local timestamp
    const file = path.join(dir, `${ts}-${id}${autosave ? '.autosave' : ''}.json`);

    const record = {
      id,
      savedAt: d.toISOString(),
      autosave: Boolean(autosave),
      model: model || 'gpt-4o-mini',
      systemPrompt: String(systemPrompt || ''),
      transcript: Array.isArray(transcript) ? transcript : [],
      stats: { messages: Array.isArray(transcript) ? transcript.length : 0 }
    };

    // Atomic-ish write via temp then rename
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
    fs.renameSync(tmp, file);

    res.json({ ok: true, path: path.relative(DATA_DIR, file).replace(/\\/g, '/') });
  } catch (e) {
    console.error('Save conversation error:', e);
    res.status(500).json({ error: e.message || 'Failed to save conversation' });
  }
});

app.listen(PORT, () => {
  console.log(`LCGPT server running at http://localhost:${PORT}`);
});
