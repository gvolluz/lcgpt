(() => {
  const el = (sel) => document.querySelector(sel);
  const els = (sel) => Array.from(document.querySelectorAll(sel));

  const healthStatus = el('#healthStatus');
  const messagesEl = el('#messages');
  const userInput = el('#userInput');
  const sendBtn = el('#sendBtn');
  const clearContextBtn = el('#clearContextBtn');
  const systemPromptEl = el('#systemPrompt');
  const modelSelect = el('#modelSelect');
  const savePromptBtn = el('#savePromptBtn');
  const promptNameInput = el('#promptName');
  const promptsList = el('#promptsList');
  const contextInfo = el('#contextInfo');
  const newConvBtn = el('#newConvBtn');
  const saveConvBtn = el('#saveConvBtn');
  const sidebarToggle = el('#sidebarToggle');
  const setDefaultBtn = el('#setDefaultBtn');

  // Local state
  // Full transcript is always kept for display. Context is a moving window starting at `contextStart`.
  let transcript = []; // [{role, content}]
  let contextStart = 0; // index in `transcript` from which messages are sent to OpenAI
  let sending = false;
  let conversationId = genId();
  let autosaveTimer = null;
  let autosaveInFlight = false;

  // Persist minimal UI prefs (model/sidebar/default prompt cache) between reloads
  const LS = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
  };
  modelSelect.value = LS.get('model', modelSelect.value);
  modelSelect.addEventListener('change', () => LS.set('model', modelSelect.value));

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

  // Sidebar toggle
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      const cur = !!LS.get('sidebarHidden', false);
      const next = !cur;
      LS.set('sidebarHidden', next);
      applySidebarHidden(next);
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

  function genId() {
    return Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36);
  }

  function updateContextInfo() {
    const count = Math.max(0, transcript.length - contextStart);
    if (contextInfo) contextInfo.textContent = `Context: ${count}`;
  }

  async function sendMessage() {
    const text = userInput.value.trim();
    if (!text || sending) return;

    // Append user message locally to transcript
    transcript.push({ role: 'user', content: text });
    renderMessages();
    userInput.value = '';

    // Build payload using only the context window
    const contextMessages = transcript.slice(contextStart);
    const payload = {
      systemPrompt: systemPromptEl.value || '',
      model: modelSelect.value,
      messages: contextMessages,
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
      renderMessages();
    } catch (e) {
      const err = e && e.message ? e.message : String(e);
      transcript.push({ role: 'assistant', content: `Error: ${err}` });
      renderMessages();
    } finally {
      setSending(false);
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

  // Events
  sendBtn.addEventListener('click', sendMessage);
  clearContextBtn.addEventListener('click', clearContext);
  savePromptBtn.addEventListener('click', savePrompt);
  if (setDefaultBtn) setDefaultBtn.addEventListener('click', setDefaultPromptFromUI);
  if (newConvBtn) newConvBtn.addEventListener('click', newConversation);
  if (saveConvBtn) saveConvBtn.addEventListener('click', () => saveConversation(true));
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Init
  renderMessages();
  refreshPrompts();
  // Try to load default system prompt on startup
  loadDefaultPromptIntoUI(true);
  startAutosave();
})();
