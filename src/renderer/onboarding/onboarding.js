'use strict';
/**
 * Onboarding renderer.
 *
 * Six steps: welcome, microphone check, shortcuts, a live dictation playground,
 * app connections, and a summary. The playground is a real text field, so the
 * user's first dictation genuinely goes through the whole pipeline rather than
 * being simulated.
 */

const steps = [...document.querySelectorAll('.step')];
const progress = document.getElementById('progress');
let index = 0;

progress.innerHTML = steps.map(() => '<span></span>').join('');

function show(next) {
  index = Math.max(0, Math.min(steps.length - 1, next));
  steps.forEach((s, i) => s.classList.toggle('is-active', i === index));
  [...progress.children].forEach((d, i) => d.classList.toggle('is-done', i <= index));

  const step = steps[index].dataset.step;
  if (step === 'mic') startMicCheck();
  else stopMicCheck();
  if (step === 'apps') loadApps();
  if (step === 'try') document.getElementById('playground').focus();
  if (step === 'done') renderSummary();
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-next]')) show(index + 1);
  if (e.target.closest('[data-back]')) show(index - 1);
});

// --- Microphone check -----------------------------------------------------
// Runs locally in this window. Nothing is recorded or kept; it only proves the
// device works and is picking the user up.

let micStream = null;
let micCtx = null;
let micRaf = null;
let peak = 0;

async function startMicCheck() {
  const state = document.getElementById('micState');
  const next = document.getElementById('micNext');
  if (micStream) return;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    state.textContent = describeMicError(err);
    state.className = 'mic-state is-bad';
    // Never trap the user on a step they cannot pass.
    next.disabled = false;
    next.textContent = 'Continue anyway';
    return;
  }

  state.textContent = 'Listening… say something';
  state.className = 'mic-state';

  micCtx = new AudioContext();
  const source = micCtx.createMediaStreamSource(micStream);
  const analyser = micCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  const fill = document.getElementById('meterFill');

  const tick = () => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const level = Math.min(1, Math.sqrt(sum / buf.length) * 7);
    fill.style.width = `${Math.round(level * 100)}%`;

    peak = Math.max(peak, level);
    if (peak > 0.12) {
      state.textContent = 'Microphone is working';
      state.className = 'mic-state is-ok';
      next.disabled = false;
    }
    micRaf = requestAnimationFrame(tick);
  };
  tick();
}

function stopMicCheck() {
  if (micRaf) { cancelAnimationFrame(micRaf); micRaf = null; }
  if (micCtx) { micCtx.close().catch(() => {}); micCtx = null; }
  if (micStream) { for (const t of micStream.getTracks()) t.stop(); micStream = null; }
}

function describeMicError(err) {
  if (err.name === 'NotAllowedError') return 'Permission denied. Enable it in Windows Settings › Privacy › Microphone.';
  if (err.name === 'NotFoundError') return 'No microphone found on this device.';
  if (err.name === 'NotReadableError') return 'Another app is using the microphone.';
  return err.message;
}

// --- Shortcuts ------------------------------------------------------------

function chordHtml(accelerator) {
  return String(accelerator || '')
    .replace(/CommandOrControl|Control/g, 'Ctrl')
    .split('+')
    .map((k) => `<kbd>${k.trim()}</kbd>`)
    .join('');
}

async function loadShortcuts() {
  const status = await window.voiceos.status();
  const hk = status.hotkeys || {};
  if (hk.dictation) document.getElementById('chordDictation').innerHTML = chordHtml(hk.dictation);
  if (hk.agent) document.getElementById('chordAgent').innerHTML = chordHtml(hk.agent);

  // Say so when a preferred chord was unavailable, rather than quietly showing
  // a different one than the user expects.
  const cfg = await window.voiceos.getConfig();
  const note = document.getElementById('shortcutNote');
  const swapped = [];
  if (hk.dictation && hk.dictation !== cfg.hotkeys.dictationToggle) swapped.push('Dictation');
  if (hk.agent && hk.agent !== cfg.hotkeys.agentToggle) swapped.push('Agent');
  note.innerHTML = swapped.length
    ? `Another app on this machine already owns the usual ${swapped.join(' and ')} chord, ` +
      'so VoiceOS picked the next free one. You can change these in Settings.'
    : 'You can change these later in Settings.';
}

// --- Playground -----------------------------------------------------------

const playground = document.getElementById('playground');
document.getElementById('clearPlayground').addEventListener('click', () => {
  playground.value = '';
  playground.focus();
});

window.voiceos.onSessionResult((result) => {
  const status = document.getElementById('tryStatus');
  const meta = status.parentElement;
  if (result && result.ok && result.text) {
    status.textContent = `Heard in ${result.ms}ms · ${result.stt ? result.stt.model : ''}`;
    meta.classList.add('is-ok');
  } else {
    status.textContent = 'Nothing heard — try again, a little louder';
    meta.classList.remove('is-ok');
  }
});

// --- Apps -----------------------------------------------------------------

let appData = null;

async function loadApps() {
  if (appData) return;
  appData = await window.voiceos.apps();
  // Only offer what can actually run here, easiest-to-connect first.
  const rows = [...appData.official, ...appData.extras]
    .filter((a) => a.available)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 14);

  document.getElementById('appList').innerHTML = rows.map((a) => `
    <label class="app-row ${a.enabled ? 'is-on' : ''}" data-app="${esc(a.id)}">
      ${a.icon ? `<img src="../shared/icons/${esc(a.icon)}" alt="" />` : `<span class="glyph">${a.glyph || '•'}</span>`}
      <span class="app-row-name">${esc(a.name)}<br /><span class="app-row-note">${authLabel(a.auth)}</span></span>
      <input type="checkbox" ${a.enabled ? 'checked' : ''} />
    </label>`).join('');
}

function rank(a) {
  return { none: 0, local: 1, browser: 2, token: 3, oauth: 4 }[a.auth] ?? 9;
}

function authLabel(auth) {
  return {
    none: 'Ready now',
    local: 'Pick a folder',
    token: 'Free token',
    oauth: 'Free sign-in',
    browser: 'Uses your browser'
  }[auth] || auth;
}

document.getElementById('appList').addEventListener('change', async (e) => {
  const row = e.target.closest('.app-row');
  if (!row) return;
  const on = row.querySelector('input').checked;
  row.classList.toggle('is-on', on);
  await window.voiceos.setAppEnabled(row.dataset.app, on);
  const all = [...appData.official, ...appData.extras].find((a) => a.id === row.dataset.app);
  if (all) all.enabled = on;
});

// --- Summary --------------------------------------------------------------

async function renderSummary() {
  const status = await window.voiceos.status();
  const hk = status.hotkeys || {};
  const connected = appData
    ? [...appData.official, ...appData.extras].filter((a) => a.enabled).length
    : 0;

  document.getElementById('summary').innerHTML = `
    <dl>
      <dt>Dictation</dt><dd>${chordHtml(hk.dictation || 'Ctrl+Shift+Space')}</dd>
      <dt>Agent</dt><dd>${chordHtml(hk.agent || 'Ctrl+Alt+A')}</dd>
      <dt>Speech model</dt><dd>${esc(basename(status.stt.model || 'not installed'))}</dd>
      <dt>Apps connected</dt><dd>${connected}</dd>
      <dt>Your data</dt><dd>Stays on this machine</dd>
    </dl>`;
}

document.getElementById('finish').addEventListener('click', async () => {
  stopMicCheck();
  await window.voiceos.completeOnboarding();
});

// --- Helpers --------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function basename(p) { return String(p).split(/[\\/]/).pop(); }

show(0);
loadShortcuts();
