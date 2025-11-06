(() => {
  const el = (sel) => document.querySelector(sel);
  const els = (sel) => Array.from(document.querySelectorAll(sel));

  const healthStatus = el('#healthStatus');
  const usageStatus = el('#usageStatus');
  const rateStatus = el('#rateStatus');
  const messagesEl = el('#messages');
  const userInput = el('#userInput');
  const sendBtn = el('#sendBtn');
  const clearContextBtn = el('#clearContextBtn');
  const systemPromptEl = el('#systemPrompt');
  const modelSelect = el('#modelSelect');
  const reasoningSelect = el('#reasoningSelect');
  const reasoningRow = el('#reasoningRow');
  const savePromptBtn = el('#savePromptBtn');
  const promptNameInput = el('#promptName');
  const promptsList = el('#promptsList');
  const contextInfo = el('#contextInfo');
  const attachBtn = el('#attachBtn');
  const fileInput = el('#fileInput');
  const attachmentsEl = el('#attachments');
  const newConvBtn = el('#newConvBtn');
  const saveConvBtn = el('#saveConvBtn');
  const sidebarToggle = el('#sidebarToggle');
  const logsToggle = el('#logsToggle');
  const clearLogsBtn = el('#clearLogsBtn');
  const logsList = el('#logsList');
  const logsFilterExternal = el('#logsFilterExternal');
  const logsFilterServer = el('#logsFilterServer');
  const setDefaultBtn = el('#setDefaultBtn');
  const modelSearch = el('#modelSearch');
  const modelSearchClear = el('#modelSearchClear');
  // Prompt analysis UI
  const analyzePromptBtn = el('#analyzePromptBtn');
  const promptAnalysisModal = el('#promptAnalysisModal');
  const promptAnalysisBody = el('#promptAnalysisBody');
  const promptAnalysisClose = el('#promptAnalysisClose');
  const applyImprovedPromptBtn = el('#applyImprovedPromptBtn');
  const appendImprovedPromptBtn = el('#appendImprovedPromptBtn');
  const copyImprovedPromptBtn = el('#copyImprovedPromptBtn');
  // Daily conversations UI
  const dailyConvsSection = el('#dailyConvsSection');
  const dailyConvsInner = el('#dailyConvsInner');
  const toggleDailyConvs = el('#toggleDailyConvs');
  const convDate = el('#convDate');
  const convSearch = el('#convSearch');
  const convSearchClear = el('#convSearchClear');
  const dailyConvsList = el('#dailyConvsList');
  const convSelectAll = el('#convSelectAll');
  const convImportBtn = el('#convImportBtn');
  const convImportInput = el('#convImportInput');
  const convExportBtn = el('#convExportBtn');
  const convDeleteBtn = el('#convDeleteBtn');
  const convRefreshBtn = el('#convRefreshBtn');

  // Local state
  // Full transcript is always kept for display. Context is a moving window starting at `contextStart`.
  let transcript = []; // [{role, content}]
  let contextStart = 0; // index in `transcript` from which messages are sent to OpenAI
  let sending = false;
  let conversationId = genId();
  let autosaveTimer = null;
  let autosaveInFlight = false;
  // Attachments (text-only v1)
  let attachments = []; // [{name, size, content}]
  const MAX_FILE_SIZE = 512 * 1024; // 512 KB per file
  const MAX_TOTAL_SIZE = 2 * 1024 * 1024; // 2 MB total per send
  const ALLOWED_EXTS = ['txt','md','markdown','json','csv','tsv','js','ts','jsx','tsx','py','rb','java','cs','go','rs','cpp','c','h','hpp','html','htm','css','xml','yml','yaml','toml','ini','sql','sh','bat','ps1'];
  // Usage totals (session)
  let sessionUsage = { prompt: 0, completion: 0, total: 0 };

  // Persist minimal UI prefs (model/sidebar/default prompt cache) between reloads
  const LS = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
  };
  // Dynamic model list will populate modelSelect; keep last selection in localStorage
  modelSelect.addEventListener('change', () => {
    LS.set('model', modelSelect.value);
    // Toggle reasoning selector visibility based on selected model
    updateReasoningVisibility();
  });

  // Sidebar visibility persistence
  function applySidebarHidden(hidden) {
    document.body.classList.toggle('sidebar-hidden', !!hidden);
    if (sidebarToggle) sidebarToggle.setAttribute('aria-pressed', hidden ? 'true' : 'false');
  }
  const sidebarHidden = !!LS.get('sidebarHidden', false);
  applySidebarHidden(sidebarHidden);

  // Default prompt cache
  let defaultPromptCache = LS.get('defaultPromptCache', null);

  // Health check
  fetch('/api/health').then(r => r.json()).then(({ ok, hasApiKey }) => {
    if (ok && hasApiKey) {
      healthStatus.textContent = 'Ready';
      healthStatus.classList.remove('error');
    } else if (ok && !hasApiKey) {
      healthStatus.textContent = 'No API key';
      healthStatus.classList.add('error');
    } else {
      healthStatus.textContent = 'Server error';
      healthStatus.classList.add('error');
    }
  }).catch(() => {
    healthStatus.textContent = 'Offline';
    healthStatus.classList.add('error');
  });

  // Models list (dynamic)
  const MODEL_CACHE_KEY = 'modelsCache';
  const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
  function readModelCache() {
    const cached = LS.get(MODEL_CACHE_KEY, null);
    if (!cached) return null;
    if (!cached.time || !cached.models) return null;
    if (Date.now() - cached.time > MODEL_CACHE_TTL_MS) return null;
    return cached.models;
  }
  async function fetchModelsDynamic() {
    try {
      const resp = await fetch('/api/models');
      if (!resp.ok) throw new Error('Failed to fetch');
      const data = await resp.json();
      const models = data.models || [];
      LS.set(MODEL_CACHE_KEY, { time: Date.now(), models });
      return models;
    } catch {
      return null;
    }
  }
  function isReasoningModelId(id) { return /^(o3|o4)/i.test(String(id)); }

  // Model search/filter state
  let fullModelList = [];
  const MODEL_SEARCH_LS_KEY = 'modelSearchQuery';

  function populateModelSelect(models, preserveSelection = true) {
    const prev = preserveSelection ? modelSelect.value : null;
    modelSelect.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id;
      modelSelect.appendChild(opt);
    }
    // Restore previous selection if still available; else select first
    if (preserveSelection && prev && Array.from(modelSelect.options).some(o => o.value === prev)) {
      modelSelect.value = prev;
    } else if (modelSelect.options.length) {
      modelSelect.value = modelSelect.options[0].value;
    }
    // Persist and update reasoning UI
    if (modelSelect.value) LS.set('model', modelSelect.value);
    updateReasoningVisibility();
  }

  function getModelQuery() {
    return (modelSearch && modelSearch.value || '').trim().toLowerCase();
  }

  function applyModelFilterFromQuery() {
    const q = getModelQuery();
    let list = fullModelList;
    if (q) {
      const parts = q.split(/\s+/).filter(Boolean);
      list = fullModelList.filter(m => {
        const id = m.id.toLowerCase();
        return parts.every(p => id.includes(p));
      });
    }
    if (!list.length && fullModelList.length) {
      // ensure at least something is shown to avoid empty select
      list = fullModelList;
    }
    populateModelSelect(list, true);
  }

  function debounce(fn, ms) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  async function ensureModels() {
    let models = readModelCache();
    if (!models) models = await fetchModelsDynamic();
    if (!models || !models.length) {
      // fallback list
      models = [
        { id: 'gpt-4o-mini', supports_reasoning: false },
        { id: 'gpt-4o', supports_reasoning: false },
        { id: 'gpt-4.1-mini', supports_reasoning: false },
        { id: 'gpt-4.1', supports_reasoning: false },
        { id: 'o4-mini', supports_reasoning: true },
        { id: 'o3-mini', supports_reasoning: true }
      ];
    }
    fullModelList = models;
    // Restore last selected model and search query
    if (modelSearch) {
      modelSearch.value = LS.get(MODEL_SEARCH_LS_KEY, '') || '';
    }
    applyModelFilterFromQuery();
    // Try to restore last chosen model if present
    const last = LS.get('model', fullModelList[0]?.id || 'gpt-4o-mini');
    if (Array.from(modelSelect.options).some(o => o.value === last)) {
      modelSelect.value = last;
    }
    LS.set('model', modelSelect.value);
    updateReasoningVisibility();
  }
  function updateReasoningVisibility() {
    const id = modelSelect.value;
    const show = isReasoningModelId(id);
    if (reasoningRow) reasoningRow.style.display = show ? '' : 'none';
    if (!show && reasoningSelect) reasoningSelect.value = 'off';
  }

  // Sidebar toggle
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      const cur = !!LS.get('sidebarHidden', false);
      const next = !cur;
      LS.set('sidebarHidden', next);
      applySidebarHidden(next);
    });
  }
  if (logsToggle) {
    logsToggle.addEventListener('click', () => {
      const cur = !!LS.get('logsHidden', false);
      const next = !cur;
      LS.set('logsHidden', next);
      applyLogsHidden(next);
    });
  }
  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/logs', { method: 'DELETE' });
        await fetchLogsOnce();
      } catch {}
    });
  }

  // Default prompt helpers
  async function fetchDefaultPrompt() {
    try {
      const resp = await fetch('/api/prompts/default');
      const data = await resp.json();
      return data.defaultPrompt || null;
    } catch { return null; }
  }
  async function loadDefaultPromptIntoUI(force = false) {
    // If we already have a cached default and not forcing, prefer it to avoid a request
    let def = !force ? defaultPromptCache : null;
    if (!def) def = await fetchDefaultPrompt();
    if (def && typeof def.content === 'string') {
      systemPromptEl.value = def.content;
      defaultPromptCache = def;
      LS.set('defaultPromptCache', def);
    }
  }
  async function setDefaultPromptFromUI() {
    const content = systemPromptEl.value || '';
    const name = (promptNameInput && promptNameInput.value.trim()) || undefined;
    try {
      const resp = await fetch('/api/prompts/default', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Failed to set default prompt');
      defaultPromptCache = data.defaultPrompt || null;
      LS.set('defaultPromptCache', defaultPromptCache);
      // gentle feedback
      if (setDefaultBtn) {
        const old = setDefaultBtn.textContent;
        setDefaultBtn.textContent = 'Saved as default ✓';
        setTimeout(() => { setDefaultBtn.textContent = old; }, 1200);
      }
    } catch (e) {
      alert(e.message || String(e));
    }
  }

  // Rendering helpers for Markdown
  function renderBubbleContent(bubbleEl, role, text) {
    if (role === 'assistant' && window.marked && window.DOMPurify) {
      try {
        // Configure marked once (idempotent)
        if (!renderBubbleContent._markedConfigured) {
          if (window.marked && marked.setOptions) {
            marked.setOptions({
              breaks: true
            });
          }
          renderBubbleContent._markedConfigured = true;
        }
        const html = DOMPurify.sanitize(marked.parse(String(text || '')));
        bubbleEl.classList.add('markdown');
        bubbleEl.innerHTML = html;
        // Syntax highlight if hljs is available
        if (window.hljs) {
          bubbleEl.querySelectorAll('pre code').forEach((block) => {
            try { hljs.highlightElement(block); } catch {}
          });
        }
        return;
      } catch {}
    }
    // Fallback: plain text
    bubbleEl.textContent = text;
  }

  // Rendering
  function renderMessages() {
    updateContextInfo();
    if (!transcript.length) {
      messagesEl.innerHTML = '<div class="empty">No messages yet. Ask a question to start.</div>';
      return;
    }
    messagesEl.innerHTML = '';
    transcript.forEach((m, idx) => {
      // Insert divider just before the first message that is still in context
      if (idx === contextStart && idx !== 0) {
        const divider = document.createElement('div');
        divider.className = 'divider';
        divider.textContent = 'Context cleared — messages above are not sent to the model';
        messagesEl.appendChild(divider);
      }
      const div = document.createElement('div');
      div.className = `msg ${m.role}`;
      div.innerHTML = `<div class="role">${m.role}</div><div class="bubble"></div>`;
      const bubble = div.querySelector('.bubble');
      if (m.role === 'assistant') {
        renderBubbleContent(bubble, m.role, m.content);
      } else {
        bubble.textContent = m.content;
      }
      messagesEl.appendChild(div);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setSending(v) {
    sending = v;
    sendBtn.disabled = v;
    userInput.disabled = v;
    if (v) {
      sendBtn.textContent = 'Sending…';
      messagesEl.classList.add('loading');
    } else {
      sendBtn.textContent = 'Send';
      messagesEl.classList.remove('loading');
    }
  }

  // Rate limits (Option A1) — current API rate limits from server snapshot
  let ratePollTimer = null;
  function fmtNum(n) { return typeof n === 'number' && Number.isFinite(n) ? Intl.NumberFormat().format(n) : '—'; }
  function fmtReset(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60); const rs = s % 60;
    return rs ? `${m}m ${rs}s` : `${m}m`;
  }
  async function fetchRateLimitsOnce() {
    try {
      const resp = await fetch('/api/usage');
      if (!resp.ok) throw new Error('usage fetch failed');
      const data = await resp.json();
      renderRateBadge(data);
    } catch (e) {
      // hide if unavailable
      if (rateStatus) rateStatus.style.display = 'none';
    }
  }
  function renderRateBadge(data) {
    if (!rateStatus) return;
    const req = data && data.requests || null;
    const tok = data && data.tokens || null;
    if (!req && !tok) { rateStatus.style.display = 'none'; return; }
    const reqPart = `Req ${fmtNum(req?.remaining)}/${fmtNum(req?.limit)}${req?.resetMs!=null?` (${fmtReset(req.resetMs)})`:''}`;
    const tokPart = `Tok ${fmtNum(tok?.remaining)}/${fmtNum(tok?.limit)}${tok?.resetMs!=null?` (${fmtReset(tok.resetMs)})`:''}`;
    rateStatus.textContent = `Limits — ${reqPart} · ${tokPart}`;
    const lu = data && data.lastUpdated ? new Date(data.lastUpdated).toLocaleString() : 'n/a';
    rateStatus.title = `Current API rate limits\nRequests: remaining=${req?.remaining ?? 'n/a'}, limit=${req?.limit ?? 'n/a'}, resets in ${fmtReset(req?.resetMs)}\nTokens: remaining=${tok?.remaining ?? 'n/a'}, limit=${tok?.limit ?? 'n/a'}, resets in ${fmtReset(tok?.resetMs)}\nLast updated: ${lu}`;
    rateStatus.style.display = '';
  }
  function startRatePolling() {
    if (ratePollTimer) clearInterval(ratePollTimer);
    fetchRateLimitsOnce();
    ratePollTimer = setInterval(fetchRateLimitsOnce, 60_000);
  }

  // ===== Logs panel =====
  function applyLogsHidden(hidden) {
    document.body.classList.toggle('logs-hidden', !!hidden);
    if (logsToggle) logsToggle.setAttribute('aria-pressed', hidden ? 'true' : 'false');
  }
  const logsHidden = !!LS.get('logsHidden', false);
  applyLogsHidden(logsHidden);

  let logsPollTimer = null;
  let logsData = [];
  // Logs filters (persisted)
  const LOGS_FILTER_EXT_KEY = 'logsFilterExternal';
  const LOGS_FILTER_SRV_KEY = 'logsFilterServer';
  function getLogsFilterState() {
    const ext = !!LS.get(LOGS_FILTER_EXT_KEY, true); // default: show external
    const srv = !!LS.get(LOGS_FILTER_SRV_KEY, false); // default: hide backend
    return { ext, srv };
  }
  function applyLogsFilterUI() {
    const { ext, srv } = getLogsFilterState();
    if (logsFilterExternal) logsFilterExternal.checked = ext;
    if (logsFilterServer) logsFilterServer.checked = srv;
  }
  applyLogsFilterUI();
  if (logsFilterExternal) logsFilterExternal.addEventListener('change', () => {
    LS.set(LOGS_FILTER_EXT_KEY, !!logsFilterExternal.checked);
    renderLogs();
  });
  if (logsFilterServer) logsFilterServer.addEventListener('change', () => {
    LS.set(LOGS_FILTER_SRV_KEY, !!logsFilterServer.checked);
    renderLogs();
  });

  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString(); } catch { return String(ts); }
  }
  function renderLogs() {
    if (!logsList) return;
    logsList.innerHTML = '';
    const { ext, srv } = getLogsFilterState();
    // Apply client-side filters based on kind
    const filtered = logsData.filter(l => (l.kind === 'openai' && ext) || (l.kind === 'server' && srv));
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = logsData.length ? 'No entries match the current filters.' : 'No API calls yet.';
      logsList.appendChild(empty);
      return;
    }
    for (const l of filtered) {
      const div = document.createElement('div');
      const ok = Number(l.status) < 400;
      div.className = `log-item ${ok ? 'success' : 'error'}`;
      const icon = l.kind === 'openai' ? '⚡' : '🌐';
      const right = [];
      if (typeof l.durationMs === 'number') right.push(`${Math.round(l.durationMs)}ms`);
      if (typeof l.status !== 'undefined') right.push(`#${l.status}`);
      const metaBits = [];
      if (l.meta?.model) metaBits.push(`model: ${l.meta.model}`);
      if (l.meta?.tokens != null) metaBits.push(`tokens: ${l.meta.tokens}`);
      if (l.note) metaBits.push(`note: ${l.note}`);
      if (l.error && ok === false) metaBits.push(`error: ${l.error}`);
      div.innerHTML = `
        <div class="icon">${icon}</div>
        <div class="main">
          <div><strong>${l.route || ''}</strong> <span class="log-badge">${l.method || ''}</span></div>
          <div class="meta">${metaBits.join(' · ')}</div>
        </div>
        <div class="right">
          <div>${fmtTime(l.ts)}</div>
          <div>${right.join(' · ')}</div>
        </div>
      `;
      logsList.appendChild(div);
    }
  }
  async function fetchLogsOnce() {
    try {
      const resp = await fetch('/api/logs?limit=200');
      if (!resp.ok) throw new Error('logs fetch failed');
      const data = await resp.json();
      logsData = data.logs || [];
      renderLogs();
      // Update toggle title with recent errors count
      if (logsToggle) {
        const errs = logsData.filter(l => Number(l.status) >= 400).length;
        logsToggle.title = `Toggle API call log panel${errs ? ` — ${errs} error(s)` : ''}`;
      }
    } catch (e) {
      // ignore
    }
  }
  function startLogsPolling() {
    if (logsPollTimer) clearInterval(logsPollTimer);
    fetchLogsOnce();
    logsPollTimer = setInterval(fetchLogsOnce, 5000);
  }

  // Usage badge update
  function updateUsageBadge(lastPrompt, lastCompletion, lastTotal) {
    if (!usageStatus) return;
    const fmt = (n) => Intl.NumberFormat().format(n);
    const last = `last: ${fmt(lastTotal)} (p:${fmt(lastPrompt)}, c:${fmt(lastCompletion)})`;
    const sum = `sum: ${fmt(sessionUsage.total)} (p:${fmt(sessionUsage.prompt)}, c:${fmt(sessionUsage.completion)})`;
    usageStatus.textContent = `Usage — ${last} · ${sum}`;
    usageStatus.style.display = '';
    usageStatus.title = 'Token usage (per last response and session totals)';
  }

  // Attachments rendering
  function renderAttachments() {
    if (!attachmentsEl) return;
    attachmentsEl.innerHTML = '';
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      chip.innerHTML = `<span class="name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span><button title="Remove">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        attachments.splice(i, 1);
        renderAttachments();
      });
      attachmentsEl.appendChild(chip);
    }
  }

  function validateAndReadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let total = attachments.reduce((s, a) => s + (a.size || 0), 0);
    const errors = [];
    const reads = [];
    for (const f of files) {
      const name = f.name || 'file';
      const size = f.size || 0;
      const ext = String(name.split('.').pop() || '').toLowerCase();
      if (!ALLOWED_EXTS.includes(ext)) {
        errors.push(`${name}: unsupported type`);
        continue;
      }
      if (size > MAX_FILE_SIZE) {
        errors.push(`${name}: too large (> ${Math.round(MAX_FILE_SIZE/1024)} KB)`);
        continue;
      }
      if (total + size > MAX_TOTAL_SIZE) {
        errors.push(`${name}: exceeds total limit (${Math.round(MAX_TOTAL_SIZE/1024)} KB)`);
        continue;
      }
      total += size;
      reads.push(new Promise((resolve) => {
        const reader = new FileReader();
        reader.onerror = () => resolve(null);
        reader.onload = () => resolve({ name, size, content: reader.result });
        reader.readAsText(f);
      }));
    }
    Promise.all(reads).then(results => {
      const ok = results.filter(Boolean);
      attachments.push(...ok);
      renderAttachments();
      if (errors.length) {
        alert('Some files were skipped:\n' + errors.join('\n'));
      }
    });
  }

  function genId() {
    return Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36);
  }

  function updateContextInfo() {
    const count = Math.max(0, transcript.length - contextStart);
    if (contextInfo) contextInfo.textContent = `Context: ${count}`;
  }

  async function sendMessage() {
    const text = userInput.value.trim();
    if ((!text && attachments.length === 0) || sending) return;

    // Build user content including attachments (if any)
    let userContent = text;
    if (attachments.length) {
      let attachBlock = attachments.map(a => `File: ${a.name}\n\n\u0060\u0060\u0060\n${a.content}\n\u0060\u0060\u0060`).join("\n\n");
      userContent = text ? `${text}\n\n--- Attachments ---\n\n${attachBlock}` : `--- Attachments ---\n\n${attachBlock}`;
    }

    // Append user message locally to transcript
    transcript.push({ role: 'user', content: userContent });
    renderMessages();
    userInput.value = '';
    // Clear attachments after enqueueing message
    attachments = [];
    renderAttachments();

    // Build payload using only the context window
    const contextMessages = transcript.slice(contextStart);
    const payload = {
      systemPrompt: systemPromptEl.value || '',
      model: modelSelect.value,
      messages: contextMessages,
      reasoningEffort: (reasoningSelect && reasoningSelect.value) || 'off',
    };

    try {
      setSending(true);
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Request failed');
      const reply = data.reply || '';
      transcript.push({ role: 'assistant', content: reply });
      // Usage handling
      if (data.usage) {
        const p = Number(data.usage.promptTokens || 0) || 0;
        const c = Number(data.usage.completionTokens || 0) || 0;
        const t = Number(data.usage.totalTokens || (p + c)) || 0;
        sessionUsage.prompt += p;
        sessionUsage.completion += c;
        sessionUsage.total += t;
        updateUsageBadge(p, c, t);
      }
      renderMessages();
    } catch (e) {
      const err = e && e.message ? e.message : String(e);
      transcript.push({ role: 'assistant', content: `Error: ${err}` });
      renderMessages();
    } finally {
      setSending(false);
      // Refresh rate limits and logs immediately after a call
      try { fetchRateLimitsOnce(); } catch {}
      try { fetchLogsOnce(); } catch {}
    }
  }

  // Clear context: keep transcript, but stop sending earlier messages
  function clearContext() {
    contextStart = transcript.length; // future sends will only include messages after this point
    renderMessages();
    userInput.focus();
  }

  function newConversation() {
    transcript = [];
    contextStart = 0;
    conversationId = genId();
    userInput.value = '';
    renderMessages();
    // Load default system prompt for new conversation, if any
    loadDefaultPromptIntoUI();
  }

  async function saveConversation(manual = true) {
    const payload = {
      conversationId,
      model: modelSelect.value,
      systemPrompt: systemPromptEl.value || '',
      transcript,
      autosave: !manual,
    };
    try {
      const resp = await fetch('/api/conversations/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Failed to save conversation');
      if (manual) {
        alert(`Saved to ${data.path}`);
      }
    } catch (e) {
      if (manual) console.error(e);
    }
  }

  function startAutosave() {
    if (autosaveTimer) clearInterval(autosaveTimer);
    autosaveTimer = setInterval(async () => {
      if (autosaveInFlight) return;
      if (!transcript.length) return;
      autosaveInFlight = true;
      try { await saveConversation(false); } catch {} finally { autosaveInFlight = false; }
    }, 60_000);
  }

  // Saved prompts CRUD
  async function refreshPrompts() {
    promptsList.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const resp = await fetch('/api/prompts');
      const data = await resp.json();
      const prompts = data.prompts || [];
      if (!prompts.length) {
        promptsList.innerHTML = '<div class="empty">No saved prompts yet.</div>';
        return;
      }
      promptsList.innerHTML = '';
      for (const p of prompts) {
        const row = document.createElement('div');
        row.className = 'prompt-item';
        row.innerHTML = `
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="actions">
            <button data-act="load">Load</button>
            <button data-act="delete">Delete</button>
          </div>
        `;
        row.querySelector('[data-act="load"]').addEventListener('click', () => {
          systemPromptEl.value = p.content || '';
        });
        row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
          if (!confirm(`Delete prompt "${p.name}"?`)) return;
          await fetch(`/api/prompts/${encodeURIComponent(p.name)}`, { method: 'DELETE' });
          refreshPrompts();
        });
        promptsList.appendChild(row);
      }
    } catch (e) {
      promptsList.innerHTML = `<div class="empty error">Failed to load prompts</div>`;
    }
  }

  async function savePrompt() {
    const name = promptNameInput.value.trim();
    const content = systemPromptEl.value;
    if (!name) {
      promptNameInput.focus();
      promptNameInput.classList.add('error');
      setTimeout(() => promptNameInput.classList.remove('error'), 1000);
      return;
    }
    try {
      const resp = await fetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content })
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save');
      }
      refreshPrompts();
    } catch (e) {
      alert(e.message || String(e));
    }
  }

  // Helpers
  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  // ===== System Prompt Analysis =====
  let lastImprovedPrompt = '';
  function openPromptAnalysisModal() {
    if (!promptAnalysisModal) return;
    promptAnalysisModal.style.display = 'flex';
  }
  function closePromptAnalysisModal() {
    if (!promptAnalysisModal) return;
    promptAnalysisModal.style.display = 'none';
  }
  function buildPromptAnalysisRequestText(systemPromptText) {
    const sp = systemPromptText || '';
    return (
`You are an expert at authoring high-quality system prompts for assistants.

Task:
- Analyze the following system prompt and identify potential issues (ambiguity, missing guardrails, verbosity, conflicting instructions, lack of persona/formatting, safety, grounding, tool-use hints).
- Propose an improved version that is concise, explicit, and robust.
- Keep it model-agnostic (unless model-specific guidance is critical).
- Maintain the original intent and domain.

Return strictly JSON only (no prose), using this schema:
{
  "improved_prompt": string,   // the complete revised system prompt
  "rationale": string,         // short explanation of key changes
  "suggestions": string[],     // optional bullet suggestions
  "risks": string[]            // optional pitfalls to consider
}

Here is the original system prompt to analyze:
<<<SYSTEM_PROMPT_START>>>
${sp}
<<<SYSTEM_PROMPT_END>>>`);
  }
  function tryExtractJson(text) {
    if (!text) return null;
    // First try: raw JSON
    try { const obj = JSON.parse(text); if (obj && typeof obj === 'object') return obj; } catch {}
    // Second: fenced code block with JSON
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (m && m[1]) {
      try { const obj = JSON.parse(m[1]); if (obj && typeof obj === 'object') return obj; } catch {}
    }
    return null;
  }
  function renderPromptAnalysisResult(objOrText) {
    lastImprovedPrompt = '';
    if (!promptAnalysisBody) return;
    promptAnalysisBody.innerHTML = '';
    let improved = '';
    if (objOrText && typeof objOrText === 'object') {
      improved = String(objOrText.improved_prompt || '').trim();
      const rationale = String(objOrText.rationale || '').trim();
      const suggestions = Array.isArray(objOrText.suggestions) ? objOrText.suggestions : [];
      const risks = Array.isArray(objOrText.risks) ? objOrText.risks : [];
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <div class="section">
          <h3 style="margin:6px 0 4px; font-size:13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em;">Improved Prompt</h3>
          <pre style="white-space: pre-wrap; background: #0a0f15; border:1px solid var(--border); padding:10px; border-radius:8px;">${escapeHtml(improved)}</pre>
        </div>
        <div class="section">
          <h3 style="margin:6px 0 4px; font-size:13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em;">Rationale</h3>
          <div style="color: var(--text);">${escapeHtml(rationale || '—')}</div>
        </div>
        <div class="section">
          <h3 style="margin:6px 0 4px; font-size:13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em;">Suggestions</h3>
          ${suggestions.length ? ('<ul>' + suggestions.map(s => `<li>${escapeHtml(s)}</li>`).join('') + '</ul>') : '<div class="muted">—</div>'}
        </div>
        <div class="section">
          <h3 style="margin:6px 0 4px; font-size:13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em;">Risks</h3>
          ${risks.length ? ('<ul>' + risks.map(s => `<li>${escapeHtml(s)}</li>`).join('') + '</ul>') : '<div class="muted">—</div>'}
        </div>
      `;
      promptAnalysisBody.appendChild(wrap);
    } else {
      // Couldn't parse JSON; render raw markdown safely in a bubble-like container
      const raw = String(objOrText || '').trim();
      const wrap = document.createElement('div');
      const bubble = document.createElement('div');
      bubble.className = 'bubble markdown';
      renderBubbleContent(bubble, 'assistant', raw);
      wrap.appendChild(bubble);
      promptAnalysisBody.appendChild(wrap);
      // Best-effort: extract first fenced block as improved prompt
      const m = raw.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
      if (m && m[1]) improved = m[1].trim(); else improved = '';
    }
    lastImprovedPrompt = improved;
    // Enable/disable footer actions depending on availability
    if (applyImprovedPromptBtn) applyImprovedPromptBtn.disabled = !lastImprovedPrompt;
    if (appendImprovedPromptBtn) appendImprovedPromptBtn.disabled = !lastImprovedPrompt;
    if (copyImprovedPromptBtn) copyImprovedPromptBtn.disabled = !lastImprovedPrompt;
  }
  async function analyzeCurrentSystemPrompt() {
    const current = systemPromptEl && systemPromptEl.value ? systemPromptEl.value : '';
    if (!current.trim()) {
      alert('System prompt is empty. Please enter a system prompt first.');
      return;
    }
    // Prepare modal
    if (promptAnalysisBody) {
      promptAnalysisBody.innerHTML = '<div class="empty">Analyzing your system prompt…</div>';
    }
    openPromptAnalysisModal();
    // Build payload using /api/chat without adding it as system (to avoid priming bias)
    const metaPrompt = buildPromptAnalysisRequestText(current);
    const payload = {
      systemPrompt: '',
      model: modelSelect && modelSelect.value ? modelSelect.value : 'gpt-4o-mini',
      messages: [{ role: 'user', content: metaPrompt }],
      reasoningEffort: (reasoningSelect && reasoningSelect.value) || 'off',
    };
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Request failed');
      const reply = data.reply || '';
      const parsed = tryExtractJson(reply);
      renderPromptAnalysisResult(parsed || reply);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (promptAnalysisBody) {
        promptAnalysisBody.innerHTML = `<div class="empty error">Failed to analyze: ${escapeHtml(msg)}</div>`;
      }
    } finally {
      try { fetchRateLimitsOnce(); } catch {}
      try { fetchLogsOnce(); } catch {}
    }
  }

  // Start logs polling
  startLogsPolling();

  // Events
  sendBtn.addEventListener('click', sendMessage);
  clearContextBtn.addEventListener('click', clearContext);
  savePromptBtn.addEventListener('click', savePrompt);
  if (setDefaultBtn) setDefaultBtn.addEventListener('click', setDefaultPromptFromUI);
  if (newConvBtn) newConvBtn.addEventListener('click', newConversation);
  if (saveConvBtn) saveConvBtn.addEventListener('click', () => saveConversation(true));
  if (attachBtn) attachBtn.addEventListener('click', () => fileInput && fileInput.click());
  if (fileInput) fileInput.addEventListener('change', (e) => {
    validateAndReadFiles(e.target.files);
    fileInput.value = '';
  });
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  // Prompt analysis events
  if (analyzePromptBtn) analyzePromptBtn.addEventListener('click', () => {
    // Disable footer actions until we have a result
    if (applyImprovedPromptBtn) applyImprovedPromptBtn.disabled = true;
    if (appendImprovedPromptBtn) appendImprovedPromptBtn.disabled = true;
    if (copyImprovedPromptBtn) copyImprovedPromptBtn.disabled = true;
    analyzeCurrentSystemPrompt();
  });
  if (promptAnalysisClose) promptAnalysisClose.addEventListener('click', closePromptAnalysisModal);
  if (promptAnalysisModal) promptAnalysisModal.addEventListener('click', (e) => {
    if (e.target === promptAnalysisModal) closePromptAnalysisModal();
  });
  if (applyImprovedPromptBtn) applyImprovedPromptBtn.addEventListener('click', () => {
    if (!lastImprovedPrompt) return;
    systemPromptEl.value = lastImprovedPrompt;
    closePromptAnalysisModal();
  });
  if (appendImprovedPromptBtn) appendImprovedPromptBtn.addEventListener('click', () => {
    if (!lastImprovedPrompt) return;
    const cur = systemPromptEl.value || '';
    systemPromptEl.value = cur ? (cur + '\n\n' + lastImprovedPrompt) : lastImprovedPrompt;
    closePromptAnalysisModal();
  });
  if (copyImprovedPromptBtn) copyImprovedPromptBtn.addEventListener('click', async () => {
    if (!lastImprovedPrompt) return;
    try { await navigator.clipboard.writeText(lastImprovedPrompt); } catch {}
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && promptAnalysisModal && promptAnalysisModal.style.display !== 'none') {
      e.preventDefault();
      closePromptAnalysisModal();
    }
  });
  // Model search events
  if (modelSearch) {
    const debounced = debounce(() => {
      LS.set(MODEL_SEARCH_LS_KEY, modelSearch.value || '');
      applyModelFilterFromQuery();
    }, 120);
    modelSearch.addEventListener('input', debounced);
    modelSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        modelSearch.value = '';
        LS.set(MODEL_SEARCH_LS_KEY, '');
        applyModelFilterFromQuery();
      }
    });
  }
  if (modelSearchClear) {
    modelSearchClear.addEventListener('click', () => {
      if (!modelSearch) return;
      modelSearch.value = '';
      LS.set(MODEL_SEARCH_LS_KEY, '');
      applyModelFilterFromQuery();
      modelSearch.focus();
    });
  }

  // ===== Daily conversations (listing + search) =====
  const DC_LS_VISIBLE = 'dailyConvsVisible';
  function todayYmd() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${dd}`;
  }
  async function fetchDailyConvs(date, q) {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    if (q) params.set('q', q);
    const resp = await fetch(`/api/conversations?${params.toString()}`);
    if (!resp.ok) throw new Error('Failed to fetch conversations');
    return resp.json();
  }
  // Selection state for daily conversations (keys are `${date}|${id}`)
  let convSelection = new Set();
  function currentConvDate() {
    return (convDate && convDate.value) ? convDate.value : todayYmd();
  }
  function keyFor(date, id) { return `${date}|${id}`; }
  function isSelected(date, id) { return convSelection.has(keyFor(date, id)); }
  function setSelected(date, id, sel) {
    const k = keyFor(date, id);
    if (sel) convSelection.add(k); else convSelection.delete(k);
  }
  function clearSelection() { convSelection.clear(); }
  function selectedForDate(date) {
    const out = [];
    for (const k of convSelection) {
      const [d, id] = k.split('|');
      if (d === date) out.push({ date: d, id });
    }
    return out;
  }
  function updateConvActionsState() {
    const date = currentConvDate();
    const selCount = selectedForDate(date).length;
    if (convExportBtn) convExportBtn.disabled = selCount === 0;
    if (convDeleteBtn) convDeleteBtn.disabled = selCount === 0;
    if (convSelectAll) {
      // Determine if all visible items are selected (set later after render)
      const total = dailyConvsList ? dailyConvsList.querySelectorAll('.conv-item').length : 0;
      const checked = dailyConvsList ? dailyConvsList.querySelectorAll('.conv-item input[type="checkbox"]:checked').length : 0;
      convSelectAll.indeterminate = checked > 0 && checked < total;
      convSelectAll.checked = total > 0 && checked === total;
    }
  }
  function downloadAs(filename, jsonObj) {
    const blob = new Blob([JSON.stringify(jsonObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  async function exportSelectedConvs() {
    const date = currentConvDate();
    const items = selectedForDate(date);
    if (!items.length) return;
    try {
      if (items.length === 1) {
        const one = items[0];
        const params = new URLSearchParams({ date: one.date, id: one.id });
        const resp = await fetch(`/api/conversations/export?${params.toString()}`);
        if (!resp.ok) throw new Error('Export failed');
        const obj = await resp.json();
        downloadAs(`conversation-${one.date}-${one.id}.json`, obj);
      } else {
        const resp = await fetch('/api/conversations/export', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items })
        });
        if (!resp.ok) {
          const data = await resp.json().catch(()=>({}));
          throw new Error(data.error || 'Export failed');
        }
        const bundle = await resp.json();
        downloadAs(`conversations-${date}-${items.length}.json`, bundle);
      }
    } catch (e) {
      alert(e.message || String(e));
    }
  }

  async function deleteSelectedConvs() {
    const date = currentConvDate();
    const items = selectedForDate(date);
    if (!items.length) return;
    if (!confirm(`Delete ${items.length} conversation(s) for ${date}? This cannot be undone.`)) return;
    try {
      const resp = await fetch('/api/conversations/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Delete failed');
      clearSelection();
      await debouncedFetchConvs();
    } catch (e) {
      alert(e.message || String(e));
    }
  }

  async function importConversationsFromFile(file) {
    try {
      const text = await file.text();
      let payload;
      try { payload = JSON.parse(text); } catch { throw new Error('Invalid JSON file'); }
      let overwrite = false;
      if (confirm('Overwrite existing conversations if ID already exists for that day? Click OK to overwrite, Cancel to keep both.')) {
        overwrite = true;
      }
      const body = { overwrite };
      // Accept array, object with items, or single object
      if (Array.isArray(payload)) body.items = payload;
      else if (payload && typeof payload === 'object' && (Array.isArray(payload.items) || payload.id)) {
        Object.assign(body, payload.items ? { items: payload.items } : {});
        if (payload.id) body.items = [payload];
      } else {
        throw new Error('Unsupported JSON structure');
      }
      const resp = await fetch('/api/conversations/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Import failed');
      alert(`Imported: ${data.imported}, overwritten: ${data.overwritten}, skipped: ${data.skipped}`);
      await debouncedFetchConvs();
    } catch (e) {
      alert(e.message || String(e));
    }
  }

  function renderDailyConvs(items) {
    if (!dailyConvsList) return;
    dailyConvsList.innerHTML = '';
    const date = currentConvDate();
    if (!items || !items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No conversations.';
      dailyConvsList.appendChild(empty);
      if (convSelectAll) { convSelectAll.checked = false; convSelectAll.indeterminate = false; }
      updateConvActionsState();
      return;
    }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'conv-item';
      const time = (()=>{ try { return new Date(it.lastUpdated).toLocaleTimeString(); } catch { return ''; } })();
      const checked = isSelected(date, it.id);
      row.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px;">
          <label><input type="checkbox" class="conv-check" data-id="${escapeHtml(it.id)}" ${checked ? 'checked' : ''} /></label>
          <div class="title" title="${escapeHtml(it.path)}">${escapeHtml(it.id)} <span class="muted">(${it.messageCount ?? '—'} msgs)</span></div>
        </div>
        <div class="meta">${escapeHtml(it.model || '')} · ${time} · ${Math.round((it.size||0)/1024)} KB</div>
        <div class="preview">${escapeHtml(it.preview || '')}</div>
        <div class="actions">
          <button data-act="copy">Copy path</button>
          <button data-act="export">Export</button>
          <button data-act="delete">Delete</button>
        </div>
      `;
      row.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(it.path); } catch {}
      });
      row.querySelector('[data-act="export"]').addEventListener('click', async () => {
        try {
          const params = new URLSearchParams({ date, id: it.id });
          const resp = await fetch(`/api/conversations/export?${params.toString()}`);
          if (!resp.ok) throw new Error('Export failed');
          const obj = await resp.json();
          downloadAs(`conversation-${date}-${it.id}.json`, obj);
        } catch (e) { alert(e.message || String(e)); }
      });
      row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        if (!confirm(`Delete conversation ${it.id} for ${date}?`)) return;
        try {
          const resp = await fetch(`/api/conversations/${encodeURIComponent(date)}/${encodeURIComponent(it.id)}`, { method: 'DELETE' });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data?.error || 'Delete failed');
          setSelected(date, it.id, false);
          await debouncedFetchConvs();
        } catch (e) { alert(e.message || String(e)); }
      });
      // Checkbox handler
      const cb = row.querySelector('input.conv-check');
      cb.addEventListener('change', () => {
        setSelected(date, it.id, cb.checked);
        updateConvActionsState();
      });
      dailyConvsList.appendChild(row);
    }
    updateConvActionsState();
  }
  let convFetchTimer = null;
  const debouncedFetchConvs = debounce(async () => {
    if (!dailyConvsInner || dailyConvsInner.style.display === 'none') return;
    const date = convDate && convDate.value ? convDate.value : todayYmd();
    const q = convSearch && convSearch.value ? convSearch.value.trim() : '';
    try {
      dailyConvsList.innerHTML = '<div class="empty">Loading…</div>';
      const data = await fetchDailyConvs(date, q);
      renderDailyConvs(data.items || []);
    } catch (e) {
      dailyConvsList.innerHTML = '<div class="empty error">Failed to load</div>';
    }
  }, 200);
  function initDailyConvsUI() {
    if (!dailyConvsSection) return;
    // Hidden by default (collapsed); show header and persist state
    const visible = !!LS.get(DC_LS_VISIBLE, false);
    dailyConvsInner.style.display = visible ? '' : 'none';
    if (toggleDailyConvs) {
      toggleDailyConvs.textContent = visible ? 'Hide' : 'Show';
      toggleDailyConvs.setAttribute('aria-pressed', visible ? 'true' : 'false');
      toggleDailyConvs.addEventListener('click', () => {
        const cur = !!LS.get(DC_LS_VISIBLE, false);
        const next = !cur;
        LS.set(DC_LS_VISIBLE, next);
        dailyConvsInner.style.display = next ? '' : 'none';
        toggleDailyConvs.textContent = next ? 'Hide' : 'Show';
        toggleDailyConvs.setAttribute('aria-pressed', next ? 'true' : 'false');
        if (next) debouncedFetchConvs();
      });
    }
    // Default date = today
    if (convDate && !convDate.value) convDate.value = todayYmd();
    if (convDate) convDate.addEventListener('change', () => { clearSelection(); debouncedFetchConvs(); });
    if (convSearch) convSearch.addEventListener('input', () => { clearSelection(); debouncedFetchConvs(); });
    if (convSearchClear) convSearchClear.addEventListener('click', () => {
      if (!convSearch) return;
      convSearch.value = '';
      clearSelection();
      debouncedFetchConvs();
      convSearch.focus();
    });
    // Select all
    if (convSelectAll) convSelectAll.addEventListener('change', () => {
      const date = currentConvDate();
      const boxes = dailyConvsList ? Array.from(dailyConvsList.querySelectorAll('input.conv-check')) : [];
      for (const cb of boxes) {
        cb.checked = convSelectAll.checked;
        const id = cb.getAttribute('data-id');
        setSelected(date, id, cb.checked);
      }
      updateConvActionsState();
    });
    // Import
    if (convImportBtn && convImportInput) {
      convImportBtn.addEventListener('click', () => convImportInput.click());
      convImportInput.addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) await importConversationsFromFile(f);
        convImportInput.value = '';
      });
    }
    // Export selected
    if (convExportBtn) convExportBtn.addEventListener('click', exportSelectedConvs);
    // Delete selected
    if (convDeleteBtn) convDeleteBtn.addEventListener('click', deleteSelectedConvs);
    // Refresh
    if (convRefreshBtn) convRefreshBtn.addEventListener('click', () => { clearSelection(); debouncedFetchConvs(); });

    if (visible) debouncedFetchConvs();
  }

  // Hook into save to refresh list when visible
  async function saveConversation(manual = true) {
    const payload = {
      conversationId,
      model: modelSelect.value,
      systemPrompt: systemPromptEl.value || '',
      transcript,
      autosave: !manual,
    };
    try {
      const resp = await fetch('/api/conversations/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Failed to save conversation');
      if (manual) {
        alert(`Saved to ${data.path}`);
      }
      // Refresh list if visible and date is today
      if (dailyConvsInner && dailyConvsInner.style.display !== 'none') {
        const dVal = convDate && convDate.value ? convDate.value : todayYmd();
        // If current panel date equals today, refresh
        const today = todayYmd();
        if (dVal === today) debouncedFetchConvs();
      }
    } catch (e) {
      if (manual) console.error(e);
    }
  }

  // Init
  renderMessages();
  refreshPrompts();
  // Try to load default system prompt on startup
  loadDefaultPromptIntoUI(true);
  ensureModels().then(() => { try { fetchLogsOnce(); } catch {} });
  startAutosave();
  startRatePolling();
  initDailyConvsUI();
})();
