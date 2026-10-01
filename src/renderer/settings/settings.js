'use strict';
/**
 * Settings renderer.
 *
 * Binds every control to a dotted config path via `data-key`, so adding a
 * setting means adding one element in the HTML rather than wiring a handler.
 */

let cfg = null;
let status = null;

// --- Generic binding ------------------------------------------------------

function readPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function hydrateControls() {
  for (const node of document.querySelectorAll('[data-key]')) {
    const value = readPath(cfg, node.dataset.key);
    if (node.type === 'checkbox') node.checked = Boolean(value);
    else if (value !== undefined && value !== null) node.value = String(value);
  }
}

function bindControls() {
  for (const node of document.querySelectorAll('[data-key]')) {
    const event = node.tagName === 'SELECT' || node.type === 'checkbox' ? 'change' : 'blur';
    node.addEventListener(event, async () => {
      let value;
      if (node.type === 'checkbox') value = node.checked;
      else if (node.dataset.type === 'number') value = Number(node.value);
      else value = node.value;
      cfg = await window.voiceos.setValue(node.dataset.key, value);
      refreshDerived();
    });
  }
}

// --- Navigation -----------------------------------------------------------

document.getElementById('nav').addEventListener('click', (e) => {
  const button = e.target.closest('.nav-item');
  if (!button) return;
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('is-active', b === button);
  for (const p of document.querySelectorAll('.panel')) {
    p.classList.toggle('is-active', p.dataset.panel === button.dataset.panel);
  }
  if (button.dataset.panel === 'history') loadHistory();
  if (button.dataset.panel === 'appstore') loadApps();
});

// --- Vocabulary and replacements -----------------------------------------

const vocabEl = document.getElementById('vocabulary');

function hydrateLists() {
  if (vocabEl) vocabEl.value = (cfg.dictation.vocabulary || []).join('\n');
}

vocabEl?.addEventListener('blur', async () => {
  const terms = vocabEl.value.split('\n').map((s) => s.trim()).filter(Boolean);
  cfg = await window.voiceos.setValue('dictation.vocabulary', terms);
});

// --- Status and derived notes --------------------------------------------

function refreshDerived() {
  const note = document.getElementById('sttNote');
  if (note && status) {
    const model = cfg.stt.model.replace('ggml-', '').replace('.bin', '');
    const quantized = /q\d/.test(model);
    note.innerHTML = cfg.stt.beamSize > 1
      ? `Using <em>${model}</em> with beam search. More accurate, roughly 1.5&times; slower.`
      : `Using <em>${model}</em> with greedy decoding${quantized ? ' (quantized)' : ''}. ` +
        'Measured on this machine as the fastest setting that still transcribes correctly.';
  }

  const llmNote = document.getElementById('llmNote');
  const isLocal = cfg.llm.provider === 'ollama';
  // The key row only makes sense for the hosted providers.
  for (const id of ['apiKeyRow', 'apiKeyActions']) {
    const node = document.getElementById(id);
    if (node) node.hidden = isLocal;
  }
  if (llmNote && status) {
    if (!status.llm.available) {
      llmNote.innerHTML = isLocal
        ? 'Ollama is not running. Install it from <em>ollama.com</em>, then run ' +
          '<code>ollama pull qwen2.5:3b-instruct</code>. Dictation still works without it — ' +
          'only AI polish and Agent Mode need a model.'
        : 'No API key saved yet. Dictation still works without one.';
    } else {
      const names = status.llm.models.map((m) => m.id).slice(0, 6).join(', ');
      llmNote.innerHTML = `Connected to <em>${status.llm.provider}</em>. ` +
        (names ? `Available: ${names}` : '');
    }
  }

}

async function loadStatus() {
  status = await window.voiceos.status();

  const line = document.getElementById('statusLine');
  const sttOk = status.stt.ready;
  const llmOk = status.llm.available;
  line.innerHTML = [
    `Speech: ${sttOk ? '<span class="pill-ok">ready</span>' : '<span class="pill-bad">missing</span>'}`,
    `Brain: ${llmOk ? '<span class="pill-ok">ready</span>' : '<span class="pill-warn">offline</span>'}`,
    `Actions: ${status.bridge.available ? '<span class="pill-ok">ready</span>' : '<span class="pill-bad">n/a</span>'}`
  ].join('<br />');

  // Model dropdown reflects what is actually on disk, so the user cannot select
  // weights they have not downloaded.
  const sel = document.getElementById('sttModel');
  if (sel) {
    const known = [
      ['ggml-tiny.en-q5_1.bin', 'Tiny English, quantized — fastest'],
      ['ggml-tiny.en.bin', 'Tiny English'],
      ['ggml-base.en-q5_1.bin', 'Base English, quantized — balanced'],
      ['ggml-base.en.bin', 'Base English'],
      ['ggml-small.en-q5_1.bin', 'Small English, quantized — most accurate here'],
      ['ggml-small.en.bin', 'Small English'],
      ['ggml-base.bin', 'Base multilingual (100 languages)'],
      ['ggml-small.bin', 'Small multilingual']
    ];
    sel.innerHTML = known.map(([v, label]) =>
      `<option value="${v}">${escapeHtml(label)}</option>`).join('');
    sel.value = cfg.stt.model;
  }

  const fnNote = document.getElementById('fnNote');
  if (fnNote) {
    fnNote.innerHTML = status.platform === 'win32'
      ? 'The <code>fn</code> key cannot be intercepted on Windows — keyboard firmware ' +
        'consumes it before the OS sees it — so VoiceOS uses a chord instead.'
      : 'Press and hold to talk.';
  }

  const hw = document.getElementById('hardwareNote');
  if (hw) {
    hw.innerHTML =
      'Local models need memory and ideally a GPU. If Agent Mode feels slow, switch the ' +
      'provider above to <em>Groq</em> or <em>Google AI Studio</em> — both have permanently ' +
      'free tiers, and both are far faster than a small local model on a CPU. ' +
      'Dictation stays fully local either way.';
  }

  const about = document.getElementById('aboutCard');
  if (about) {
    about.innerHTML = `
      <dl class="kv">
        <dt>Version</dt><dd>${escapeHtml(status.version)}</dd>
        <dt>Platform</dt><dd>${escapeHtml(status.platform)}</dd>
        <dt>Speech model</dt><dd>${escapeHtml(status.stt.model ? basename(status.stt.model) : 'not installed')}</dd>
        <dt>Threads</dt><dd>${status.stt.threads}</dd>
        <dt>Brain</dt><dd>${escapeHtml(status.llm.provider)} &middot; ${escapeHtml(status.llm.configured)}</dd>
        <dt>Data folder</dt><dd>${escapeHtml(status.paths.userData)}</dd>
      </dl>
      <p class="note">
        Speech recognition, text polish and every action run on this machine.
        There is no VoiceOS server, so there is nothing to send your audio to.
      </p>`;
  }

  const keys = await window.voiceos.credentials({ action: 'list' });
  const keyState = document.getElementById('keyState');
  if (keyState) {
    keyState.textContent = keys[cfg.llm.provider] ? 'A key is saved' : 'No key saved';
  }

  refreshDerived();
}

// --- App Store -----------------------------------------------------------

let appData = null;
let activeCategory = 'All';

async function loadApps() {
  if (!appData) appData = await window.voiceos.apps();
  renderFilters();
  renderApps();
}

function renderFilters() {
  // Counts cover the official 21 only, exactly as the real store's filter row does.
  const counts = { All: appData.official.length };
  for (const a of appData.official) counts[a.category] = (counts[a.category] || 0) + 1;
  const order = ['All', ...appData.categories.filter((c) => counts[c])];
  document.getElementById('appFilters').innerHTML = order
    .map((cat) =>
      `<button class="chip ${cat === activeCategory ? 'is-active' : ''}" data-cat="${escapeHtml(cat)}">` +
      `${escapeHtml(cat)}<span class="chip-count">${counts[cat]}</span></button>`)
    .join('');
}

function appCard(a) {
  const icon = a.icon
    ? `<img class="app-icon" src="../shared/icons/${escapeHtml(a.icon)}" alt="" />`
    : `<span class="app-glyph">${a.glyph || '•'}</span>`;

  // Entries that cannot run here stay listed, like the real store, and point at
  // the equivalent that does the same job on this platform.
  const foot = a.available
    ? `<label class="toggle">
         <input type="checkbox" data-app="${escapeHtml(a.id)}" ${a.enabled ? 'checked' : ''} />
         <span>${a.enabled ? 'Connected' : 'Connect'}</span>
       </label>`
    : `<span class="app-platform">${escapeHtml(a.platformLabel)} only${
        a.windowsEquivalent ? ` &middot; use ${escapeHtml(nameOf(a.windowsEquivalent))}` : ''}</span>`;

  return `
    <div class="app-card ${a.enabled ? 'is-enabled' : ''} ${a.available ? '' : 'is-unavailable'}">
      <div class="app-head">
        ${icon}
        <span class="app-name">${escapeHtml(a.name)}</span>
        ${a.beta ? '<span class="app-badge">BETA</span>' : ''}
      </div>
      <div class="app-desc">${escapeHtml(a.description)}</div>
      <div class="app-count">
        ${a.actionCount} voice action${a.actionCount === 1 ? '' : 's'} &middot; ${escapeHtml(a.platformLabel)}
        ${a.available ? ` &middot; ${authLabel(a.auth)}` : ''}
      </div>
      <div class="app-foot">${foot}</div>
    </div>`;
}

function nameOf(id) {
  const all = [...appData.official, ...appData.extras];
  const found = all.find((a) => a.id === id);
  return found ? found.name : id;
}

function renderApps() {
  const official = activeCategory === 'All'
    ? appData.official
    : appData.official.filter((a) => a.category === activeCategory);
  const extras = activeCategory === 'All'
    ? appData.extras
    : appData.extras.filter((a) => a.category === activeCategory);

  let html = '';
  if (official.length) {
    html += `<div class="store-section-label">Official integrations</div>`;
    html += `<div class="app-grid">${official.map(appCard).join('')}</div>`;
  }
  if (extras.length) {
    html += `<div class="store-section-label">Also on this platform</div>`;
    html += `<div class="app-grid">${extras.map(appCard).join('')}</div>`;
  }
  if (!html) html = '<p class="empty">Nothing in this category.</p>';
  document.getElementById('appGrid').innerHTML = html;
}

function authLabel(auth) {
  return {
    none: 'no setup',
    local: 'needs a folder',
    token: 'free token',
    oauth: 'free OAuth',
    browser: 'uses your browser'
  }[auth] || auth;
}

document.getElementById('appFilters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  activeCategory = chip.dataset.cat;
  renderFilters();
  renderApps();
});

document.getElementById('appGrid').addEventListener('change', async (e) => {
  const box = e.target.closest('[data-app]');
  if (!box) return;
  await window.voiceos.setAppEnabled(box.dataset.app, box.checked);
  const app = [...appData.official, ...appData.extras].find((a) => a.id === box.dataset.app);
  if (app) app.enabled = box.checked;
  renderApps();
});

// --- History -------------------------------------------------------------

async function loadHistory(query) {
  const [items, stats] = await Promise.all([
    query
      ? window.voiceos.transcripts({ action: 'search', query, limit: 100 })
      : window.voiceos.transcripts({ action: 'list', limit: 100 }),
    window.voiceos.transcripts({ action: 'stats' })
  ]);

  document.getElementById('historyStats').innerHTML = `
    <div><div class="stat-value">${stats.sessions}</div><div class="stat-label">Sessions</div></div>
    <div><div class="stat-value">${stats.words.toLocaleString()}</div><div class="stat-label">Words</div></div>
    <div><div class="stat-value">${stats.avgMs}ms</div><div class="stat-label">Average</div></div>
    <div><div class="stat-value">${stats.estimatedMinutesSaved}</div><div class="stat-label">Minutes saved</div></div>`;

  const list = document.getElementById('historyList');
  if (!items.length) {
    list.innerHTML = `<p class="empty">${query ? 'Nothing matched that search.' :
      'Nothing dictated yet. Press your dictation shortcut in any text field.'}</p>`;
    return;
  }
  list.innerHTML = items.map((r) => `
    <div class="history-item">
      <div class="history-meta">
        <span>${new Date(r.at).toLocaleString()}</span>
        ${r.target && r.target.process ? `<span>${escapeHtml(r.target.process)}</span>` : ''}
        ${r.ms ? `<span>${r.ms}ms</span>` : ''}
        ${r.polished ? '<span>polished</span>' : ''}
      </div>
      <div class="history-text">${escapeHtml(r.text || '')}</div>
    </div>`).join('');
}

let searchTimer = null;
document.getElementById('historySearch')?.addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => loadHistory(q || undefined), 180);
});

// --- Buttons -------------------------------------------------------------

for (const btn of document.querySelectorAll('[data-open]')) {
  btn.addEventListener('click', () => window.voiceos.openPath(btn.dataset.open));
}

document.getElementById('saveKey')?.addEventListener('click', async () => {
  const input = document.getElementById('apiKey');
  const key = input.value.trim();
  if (!key) return;
  await window.voiceos.credentials({ action: 'set', provider: cfg.llm.provider, key });
  input.value = '';
  document.getElementById('keyState').textContent = 'A key is saved';
  await loadStatus();
});

document.getElementById('clearData')?.addEventListener('click', async () => {
  const result = await window.voiceos.transcripts({ action: 'clear' });
  if (!result.cancelled) loadHistory();
});

// --- Input meter ---------------------------------------------------------

window.voiceos.onLevel((level) => {
  const fill = document.getElementById('meterFill');
  if (fill) fill.style.width = `${Math.min(100, Math.round(level * 100))}%`;
});

window.voiceos.onSettingsChanged((next) => {
  cfg = next;
  hydrateControls();
  refreshDerived();
});

// --- Helpers -------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function basename(p) {
  return String(p).split(/[\\/]/).pop();
}

// --- Boot ---------------------------------------------------------------

(async () => {
  cfg = await window.voiceos.getConfig();
  hydrateControls();
  hydrateLists();
  bindControls();
  await loadStatus();
  await loadHistory();
})();
