'use strict';
/**
 * The VoiceOS window.
 *
 * Every control binds to a dotted config path through `data-key`, so adding a
 * setting means adding one element in the HTML rather than wiring a handler.
 */

let cfg = null;
let status = null;
let appData = null;
let activeCategory = 'All';

// --- Generic binding ------------------------------------------------------

const readPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

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
  const panel = button.dataset.panel;
  if (panel === 'history') loadHistory();
  if (panel === 'apps') loadApps();
  if (panel === 'insights') loadInsights();
});

// --- Dashboard ------------------------------------------------------------

function renderDashboard() {
  if (!status) return;

  const tiles = [
    {
      value: status.stt.ready ? 'Ready' : 'Missing',
      label: 'Speech',
      sub: status.stt.model ? basename(status.stt.model) : 'Run npm run setup',
      tone: status.stt.ready ? 'ok' : 'bad'
    },
    {
      value: status.llm.available ? 'Connected' : 'Offline',
      label: 'Brain',
      sub: status.llm.available ? status.llm.provider : 'Direct commands still work',
      tone: status.llm.available ? 'ok' : 'warn'
    },
    {
      value: status.bridge.available ? 'Ready' : 'N/A',
      label: 'Actions',
      sub: 'Typing, screen, media',
      tone: status.bridge.available ? 'ok' : 'bad'
    },
    {
      value: status.tts && status.tts.ready ? 'Ready' : 'Off',
      label: 'Voice',
      sub: status.tts && status.tts.voice ? status.tts.voice : 'Run npm run setup',
      tone: status.tts && status.tts.ready ? 'ok' : 'warn'
    }
  ];

  document.getElementById('healthTiles').innerHTML = tiles.map((t) => `
    <div class="tile is-${t.tone}">
      <div class="tile-value">${escapeHtml(t.value)}</div>
      <div class="tile-label">${escapeHtml(t.label)}</div>
      <div class="tile-sub">${escapeHtml(t.sub)}</div>
    </div>`).join('');

  // Show the chord that actually bound, which is not always the preferred one.
  const hk = status.hotkeys || {};
  const rows = [
    ['Dictation', hk.dictation, cfg.hotkeys.dictationToggle],
    ['Agent', hk.agent, cfg.hotkeys.agentToggle],
    ['Edit selection', hk.edit, cfg.hotkeys.editToggle]
  ];
  document.getElementById('shortcutRows').innerHTML = rows.map(([name, actual, preferred]) => `
    <div class="shortcut">
      <div>
        <div class="shortcut-name">${escapeHtml(name)}</div>
        ${actual && preferred && actual !== preferred
          ? `<div class="shortcut-note">${escapeHtml(prettyKey(preferred))} was taken by another app</div>`
          : ''}
      </div>
      <div class="chord">${actual ? chordHtml(actual) : '<kbd>unbound</kbd>'}</div>
    </div>`).join('');
}

// --- Insights -------------------------------------------------------------

async function loadInsights() {
  const [stats, items] = await Promise.all([
    window.voiceos.transcripts({ action: 'stats' }),
    window.voiceos.transcripts({ action: 'list', limit: 500 })
  ]);

  document.getElementById('insightTiles').innerHTML = `
    <div class="tile"><div class="tile-value">${stats.sessions}</div><div class="tile-label">Sessions</div></div>
    <div class="tile"><div class="tile-value">${(stats.words || 0).toLocaleString()}</div><div class="tile-label">Words spoken</div></div>
    <div class="tile"><div class="tile-value">${stats.avgMs}ms</div><div class="tile-label">Average</div></div>
    <div class="tile"><div class="tile-value">${stats.estimatedMinutesSaved}m</div><div class="tile-label">Time saved</div>
      <div class="tile-sub">vs typing at 40 wpm</div></div>`;

  const counts = {};
  for (const r of items) {
    const app = (r.target && r.target.process) || 'unknown';
    counts[app] = (counts[app] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = ranked.length ? ranked[0][1] : 1;

  document.getElementById('appBars').innerHTML = ranked.length
    ? ranked.map(([app, n]) => `
      <div class="bar-row">
        <span class="bar-name">${escapeHtml(app)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.round((n / max) * 100)}%"></span></span>
        <span class="bar-count">${n}</span>
      </div>`).join('')
    : '<p class="empty">Nothing dictated yet.</p>';
}

// --- History --------------------------------------------------------------

async function loadHistory(query) {
  const items = query
    ? await window.voiceos.transcripts({ action: 'search', query, limit: 100 })
    : await window.voiceos.transcripts({ action: 'list', limit: 100 });

  const list = document.getElementById('historyList');
  if (!items.length) {
    list.innerHTML = `<p class="empty">${query ? 'Nothing matched that search.' :
      'Nothing yet. Press your dictation shortcut in any text field.'}</p>`;
    return;
  }
  list.innerHTML = items.map((r) => `
    <div class="history-item">
      <div class="history-meta">
        <span>${new Date(r.at).toLocaleString()}</span>
        ${r.mode ? `<span>${escapeHtml(r.mode)}</span>` : ''}
        ${r.target && r.target.process ? `<span>${escapeHtml(r.target.process)}</span>` : ''}
        ${r.ms ? `<span>${r.ms}ms</span>` : ''}
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

// --- Apps -----------------------------------------------------------------

async function loadApps() {
  if (!appData) appData = await window.voiceos.apps();
  renderFilters();
  renderApps();
}

function renderFilters() {
  const counts = { All: appData.official.length };
  for (const a of appData.official) counts[a.category] = (counts[a.category] || 0) + 1;
  const order = ['All', ...appData.categories.filter((c) => counts[c])];
  document.getElementById('appFilters').innerHTML = order.map((cat) =>
    `<button class="chip ${cat === activeCategory ? 'is-active' : ''}" data-cat="${escapeHtml(cat)}">` +
    `${escapeHtml(cat)}<span class="chip-count">${counts[cat]}</span></button>`).join('');
}

function appCard(a) {
  const icon = a.icon
    ? `<img class="app-icon" src="../shared/icons/${escapeHtml(a.icon)}" alt="" />`
    : `<span class="app-glyph">${a.glyph || '•'}</span>`;

  const foot = a.available
    ? `<label class="switch"><input type="checkbox" data-app="${escapeHtml(a.id)}" ${a.enabled ? 'checked' : ''} /><span></span></label>`
    : `<span class="app-platform">${escapeHtml(a.platformLabel)} only${
        a.windowsEquivalent ? ` · use ${escapeHtml(nameOf(a.windowsEquivalent))}` : ''}</span>`;

  return `
    <div class="app-card ${a.enabled ? 'is-enabled' : ''} ${a.available ? '' : 'is-unavailable'}">
      <div class="app-head">
        ${icon}
        <span class="app-name">${escapeHtml(a.name)}</span>
        ${a.beta ? '<span class="app-badge">BETA</span>' : ''}
      </div>
      <div class="app-desc">${escapeHtml(a.description)}</div>
      <div class="app-count">${a.actionCount} voice action${a.actionCount === 1 ? '' : 's'} · ${escapeHtml(a.platformLabel)}</div>
      <div class="app-foot">${foot}</div>
    </div>`;
}

function nameOf(id) {
  const found = [...appData.official, ...appData.extras].find((a) => a.id === id);
  return found ? found.name : id;
}

function renderApps() {
  const pick = (list) => activeCategory === 'All' ? list : list.filter((a) => a.category === activeCategory);
  const official = pick(appData.official);
  const extras = pick(appData.extras);

  let html = '';
  if (official.length) {
    html += '<div class="store-section-label">Official integrations</div>';
    html += `<div class="app-grid">${official.map(appCard).join('')}</div>`;
  }
  if (extras.length) {
    html += '<div class="store-section-label">Also on this platform</div>';
    html += `<div class="app-grid">${extras.map(appCard).join('')}</div>`;
  }
  document.getElementById('appGrid').innerHTML = html || '<p class="empty">Nothing in this category.</p>';
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

// --- Agent panel ----------------------------------------------------------

document.getElementById('speedSeg')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-speed]');
  if (!btn) return;
  for (const b of e.currentTarget.querySelectorAll('button')) b.classList.toggle('is-on', b === btn);
  cfg = await window.voiceos.setValue('tts.speed', Number(btn.dataset.speed));
});

document.getElementById('previewVoice')?.addEventListener('click', async (e) => {
  const btn = e.target;
  btn.textContent = 'Speaking…';
  try {
    await window.voiceos.previewVoice('This is how I will sound when I answer you.');
  } finally {
    setTimeout(() => { btn.textContent = 'Preview'; }, 1600);
  }
});

document.getElementById('toggleMemory')?.addEventListener('click', (e) => {
  const body = document.getElementById('memoryBody');
  body.hidden = !body.hidden;
  e.target.textContent = body.hidden ? 'Show' : 'Hide';
  if (!body.hidden) {
    body.textContent = 'Agent Mode has not learned anything about you yet. '
      + 'Things you tell it during conversations will appear here, and stay on this device.';
  }
});

document.getElementById('saveKey')?.addEventListener('click', async () => {
  const input = document.getElementById('apiKey');
  const key = input.value.trim();
  if (!key) return;
  await window.voiceos.credentials({ action: 'set', provider: cfg.llm.provider, key });
  input.value = '';
  await loadStatus();
});

document.getElementById('clearData')?.addEventListener('click', async () => {
  const result = await window.voiceos.transcripts({ action: 'clear' });
  if (!result.cancelled) { loadHistory(); loadInsights(); }
});

for (const btn of document.querySelectorAll('[data-open]')) {
  btn.addEventListener('click', () => window.voiceos.openPath(btn.dataset.open));
}

// --- Derived --------------------------------------------------------------

function refreshDerived() {
  const sttNote = document.getElementById('sttNote');
  if (sttNote) {
    const model = String(cfg.stt.model).replace('ggml-', '').replace('.bin', '');
    sttNote.innerHTML = `Using <em>${escapeHtml(model)}</em>. Measured on this machine as the fastest setting that still transcribes correctly.`;
  }

  const isLocal = cfg.llm.provider === 'ollama';
  const keyRow = document.getElementById('apiKeyRow');
  if (keyRow) keyRow.hidden = isLocal;

  const llmNote = document.getElementById('llmNote');
  if (llmNote && status) {
    if (status.llm.available) {
      const names = (status.llm.models || []).map((m) => m.id).slice(0, 5).join(', ');
      llmNote.innerHTML = `Connected to <em>${escapeHtml(status.llm.provider)}</em>.${names ? ` Available: ${escapeHtml(names)}` : ''}`;
    } else if (isLocal) {
      llmNote.innerHTML = 'Ollama is not running. Direct commands like <em>"what\'s playing"</em> or '
        + '<em>"remind me in 20 minutes"</em> still work without it — only open-ended questions need a model. '
        + 'Install it from ollama.com, then <code>ollama pull qwen2.5:3b-instruct</code>.';
    } else {
      llmNote.innerHTML = 'No API key saved yet. Direct commands still work without one.';
    }
  }

  const voiceName = document.getElementById('voiceName');
  if (voiceName && cfg.tts.voice) {
    const parts = String(cfg.tts.voice).split('-');
    voiceName.textContent = parts[1] ? parts[1][0].toUpperCase() + parts[1].slice(1) : cfg.tts.voice;
  }

  const seg = document.getElementById('speedSeg');
  if (seg) {
    for (const b of seg.querySelectorAll('button')) {
      b.classList.toggle('is-on', Number(b.dataset.speed) === Number(cfg.tts.speed));
    }
  }

  const avatar = document.getElementById('avatar');
  const userName = document.getElementById('userName');
  const first = (cfg.user && cfg.user.firstName) || '';
  const last = (cfg.user && cfg.user.lastName) || '';
  if (userName) userName.textContent = [first, last].filter(Boolean).join(' ') || 'You';
  if (avatar) avatar.textContent = (first[0] || 'S').toUpperCase();
}

async function loadStatus() {
  status = await window.voiceos.status();

  const sel = document.getElementById('sttModel');
  if (sel) {
    const known = [
      ['ggml-tiny.en-q5_1.bin', 'Tiny English, quantized — fastest'],
      ['ggml-tiny.en.bin', 'Tiny English'],
      ['ggml-base.en-q5_1.bin', 'Base English, quantized — balanced'],
      ['ggml-base.en.bin', 'Base English'],
      ['ggml-small.en-q5_1.bin', 'Small English, quantized — most accurate here'],
      ['ggml-base.bin', 'Base multilingual (100 languages)']
    ];
    sel.innerHTML = known.map(([v, label]) => `<option value="${v}">${escapeHtml(label)}</option>`).join('');
    sel.value = cfg.stt.model;
  }

  const voiceSel = document.getElementById('voiceSelect');
  if (voiceSel && status.tts) {
    const voices = status.tts.voices || [];
    voiceSel.innerHTML = (voices.length ? voices : [cfg.tts.voice])
      .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    voiceSel.value = cfg.tts.voice;
  }

  renderDashboard();
  refreshDerived();
}

// --- Live input meter -----------------------------------------------------

window.voiceos.onLevel((level) => {
  const fill = document.getElementById('meterFill');
  if (fill) fill.style.width = `${Math.min(100, Math.round(level * 100))}%`;
});

// Voice previews are synthesized in the main process and played here.
let previewAudio = null;
window.voiceos.onSpeak(({ data }) => {
  if (!data) return;
  if (previewAudio) { try { previewAudio.pause(); } catch {} }
  previewAudio = new Audio('data:audio/wav;base64,' + data);
  previewAudio.play().catch(() => {});
});

window.voiceos.onSettingsChanged((next) => {
  cfg = next;
  hydrateControls();
  refreshDerived();
});

// --- Helpers --------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function basename(p) { return String(p).split(/[\\/]/).pop(); }
function prettyKey(a) { return String(a).replace(/CommandOrControl|Control/g, 'Ctrl'); }
function chordHtml(a) {
  return prettyKey(a).split('+').map((k) => `<kbd>${escapeHtml(k.trim())}</kbd>`).join('');
}

// --- Boot -----------------------------------------------------------------

const vocabEl = document.getElementById('vocabulary');
vocabEl?.addEventListener('blur', async () => {
  const terms = vocabEl.value.split('\n').map((s) => s.trim()).filter(Boolean);
  cfg = await window.voiceos.setValue('dictation.vocabulary', terms);
});

(async () => {
  cfg = await window.voiceos.getConfig();
  hydrateControls();
  if (vocabEl) vocabEl.value = (cfg.dictation.vocabulary || []).join('\n');
  bindControls();
  await loadStatus();
})();
