// J.A.R.V.I.S. on the web.
//
// The scene (singularity, core field, opening sequence) is the Orbit visual
// layer, used with its author's permission. Everything here — the panels, the
// quick actions, the conversation, the calls to the Jarvis server — is
// VoiceOS's own.
//
// The page talks to /api/* on the same site: Cloudflare Pages Functions that
// hold the keys and do the thinking. Until those are deployed, asking says so
// rather than pretending.

import { createSingularity } from './singularity.js';
import { playStartup } from './startup.js';
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

const $ = (s) => document.querySelector(s);
const app = $('.orbit-app');

// --- the scene ----------------------------------------------------------------
let state = 'idle';
let energy = 0;
let speechLevel = 0;
createSingularity($('#singularity'), {
  getEnergy: () => energy,
  getSpeechLevel: () => speechLevel,
  getState: () => state
});
playStartup(app);

const PHASES = {
  idle: ["I'm listening..", 'Say something, or tap a suggestion.'],
  listening: ['Go ahead, sir.', 'I stop listening when you pause.'],
  thinking: ['Working on it.', 'One moment.'],
  speaking: ['Speaking.', 'Ask me something else whenever you like.'],
  error: ['Something went wrong.', '']
};
function setState(next, sub = null) {
  state = next === 'error' ? 'idle' : next;
  document.documentElement.dataset.state = next;
  const [title, line] = PHASES[next] || PHASES.idle;
  $('#voice-title').textContent = title;
  $('#voice-sub').textContent = sub ?? line;
  energy = next === 'thinking' ? 0.8 : next === 'speaking' ? 0.5 : 0;
  for (const li of document.querySelectorAll('#lights li')) {
    const on = (li.dataset.light === 'processing' && next === 'thinking') ||
      (li.dataset.light === 'synthesis' && next === 'speaking') ||
      (li.dataset.light === 'connections' && next === 'thinking');
    li.classList.toggle('is-on', on);
  }
}

// --- the clock -------------------------------------------------------------------
function partOfDay(d = new Date()) {
  const h = d.getHours();
  return h < 5 ? 'evening' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}
function tick() {
  const now = new Date();
  $('#clock-time').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  $('#clock-date').textContent = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
tick();
setInterval(tick, 1000);

// --- woven waves (voice card, system status) -----------------------------------
function weave(canvas, { amp, width, lines, phase, taper, k1, k2 }) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  for (let i = 0; i < lines; i++) {
    const off = (i / (lines - 1) - 0.5) * 2;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2.5) {
      const u = x / w;
      const env = taper ? Math.pow(Math.sin(Math.PI * u), 1.3) : 0.3 + 0.7 * Math.sin(Math.PI * u);
      const y = h / 2 + Math.sin(u * k1 + phase) * amp * env + off * Math.sin(u * k2 - phase * 0.7 + 0.6) * width * env
        + Math.sin(u * 11 + i * 0.45 + phase * 1.3) * 1.2 * env;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(20, 38, 74, ${0.14 + 0.3 * (1 - Math.abs(off))})`;
    ctx.lineWidth = 0.55;
    ctx.stroke();
  }
}
let phase = 0;
let lastWave = 0;
function waves(t) {
  // Idle costs a few frames a second; busy gets a smooth 30.
  if (t - lastWave > (state === 'idle' ? 160 : 33)) {
    lastWave = t;
    phase += state === 'idle' ? 0.02 : 0.08;
    const mic = Math.min(1, speechLevel * 1.6);
    weave($('#voice-wave'), { amp: 12 + mic * 14, width: 12 + mic * 8, lines: 30, phase, taper: true, k1: 6.6, k2: 4.4 });
    weave($('#status-wave'), { amp: 18 + energy * 8, width: 15 + energy * 5, lines: 30, phase: phase * 0.8 + 2.2, taper: false, k1: 6.2, k2: 3.1 });
  }
  requestAnimationFrame(waves);
}
requestAnimationFrame(waves);

// --- views (the left navigation) -------------------------------------------------
const TITLES = { conversations: 'Conversations', tasks: 'Tasks', knowledge: 'Knowledge', systems: 'Systems', environment: 'Environment' };
function showView(name) {
  app.dataset.view = name;
  for (const b of document.querySelectorAll('.jv-nav-item')) b.classList.toggle('is-active', b.dataset.view === name);
  for (const p of document.querySelectorAll('.jv-pane')) p.hidden = p.dataset.pane !== name;
  $('#sheet-title').textContent = TITLES[name] || '';
  $('#sheet').hidden = name === 'home';
}
for (const b of document.querySelectorAll('.jv-nav-item')) {
  b.addEventListener('click', () => showView(app.dataset.view === b.dataset.view && b.dataset.view !== 'home' ? 'home' : b.dataset.view));
}
$('#sheet-close').addEventListener('click', () => showView('home'));
$('#tool-alerts').addEventListener('click', () => showView('environment'));
$('#tool-search').addEventListener('click', () => $('#message-input').focus());
$('#avatar').addEventListener('click', () => showView('home'));
showView('home');

// --- the conversation -------------------------------------------------------------
const log = [];
const tasks = [];
const found = [];
let asked = 0;

/** An answer as formatted, safe HTML: model text can quote the web. */
function rich(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(String(text || '')));
}

function renderLog() {
  const list = $('#log-list');
  list.textContent = '';
  for (const e of log) {
    const li = document.createElement('li');
    const you = document.createElement('div'); you.className = 'you'; you.textContent = e.question;
    const him = document.createElement('div'); him.className = 'him'; rich(him, e.answer || '…');
    li.append(you, him);
    list.append(li);
  }
  $('#log-empty').hidden = log.length > 0;
}

function renderTasks() {
  const list = $('#task-list');
  list.textContent = '';
  for (const t of tasks.slice(0, 12)) {
    const li = document.createElement('li');
    li.dataset.done = t.done ? (t.failed ? 'failed' : 'yes') : 'no';
    li.innerHTML = '<i class="spin"></i>';
    const body = document.createElement('div');
    body.textContent = t.label;
    li.append(body);
    list.append(li);
  }
  $('#tasks-empty').hidden = tasks.length > 0;
  $('#m-asked').textContent = String(asked);
  $('#m-done').textContent = String(tasks.filter((t) => t.done && !t.failed).length);
}

function renderFound() {
  const list = $('#found-list');
  list.textContent = '';
  for (const f of found.slice(0, 12)) {
    const li = document.createElement('li');
    const a = document.createElement(f.url ? 'a' : 'span');
    if (f.url) { a.href = f.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    a.textContent = f.title || f.url || '';
    li.append(a);
    if (f.subtitle) { const s = document.createElement('small'); s.textContent = f.subtitle; li.append(s); }
    list.append(li);
  }
  $('#found-empty').hidden = found.length > 0;
}

/** Asks the Jarvis server, and shows what comes back. */
async function ask(question) {
  const q = String(question || '').trim();
  if (!q) return;
  asked++;
  const entry = { question: q, answer: '' };
  log.unshift(entry);
  const task = { label: q.length > 48 ? `${q.slice(0, 48)}…` : q, done: false };
  tasks.unshift(task);
  $('#current-request').textContent = q;
  $('#request-status').textContent = 'Working on your request…';
  rich($('#current-response'), 'Thinking…');
  setState('thinking');
  renderLog(); renderTasks();
  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ question: q })
    });
    if (res.status === 401) throw new Error('Sign in first: this Jarvis is password protected.');
    if (res.status === 404) throw new Error('The Jarvis server is not connected to this site yet.');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
    entry.answer = data.answer || 'Done.';
    rich($('#current-response'), entry.answer);
    $('#request-status').textContent = 'Done';
    for (const f of data.found || []) found.unshift(f);
    task.done = true;
    setState('speaking');
    setTimeout(() => { if (state === 'speaking') setState('idle'); }, 2500);
  } catch (err) {
    entry.answer = err.message;
    rich($('#current-response'), err.message);
    $('#request-status').textContent = 'Not answered';
    task.done = true; task.failed = true;
    setState('error', err.message);
  }
  renderLog(); renderTasks(); renderFound();
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#message-input');
  const q = input.value;
  input.value = '';
  ask(q);
});
for (const b of document.querySelectorAll('.jv-action')) {
  b.addEventListener('click', () => {
    if (b.dataset.ask) { ask(b.dataset.ask); return; }
    const input = $('#message-input');
    input.value = b.dataset.fill || '';
    input.focus();
  });
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') showView('home');
  if (e.key.length === 1 && document.activeElement !== $('#message-input') && !e.ctrlKey && !e.metaKey && !e.altKey) $('#message-input').focus();
});

setState('idle');
renderLog(); renderTasks(); renderFound();
