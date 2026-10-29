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

// --- talking to the server ------------------------------------------------------
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body || {})
  });
  if (res.status === 401) { showSignIn(); throw new Error('Sign in first.'); }
  if (res.status === 404 || res.status === 405) throw new Error('The Jarvis server is not connected to this site yet.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

// --- memory, kept in this browser -------------------------------------------------
/*
 * What Jarvis remembers lives here, on this device, and is sent with each
 * question so he can use it. The server learns from each exchange and says
 * what to add or drop; it keeps nothing itself.
 */
const MEMORY_KEY = 'jv-memory';
function loadMemory() { try { return JSON.parse(localStorage.getItem(MEMORY_KEY)) || []; } catch { return []; } }
function saveMemory(list) { try { localStorage.setItem(MEMORY_KEY, JSON.stringify(list.slice(-200))); } catch { /* private mode */ } }
let memory = loadMemory();
function remember(facts = []) {
  for (const f of facts) if (f && !memory.some((m) => m.toLowerCase() === String(f).toLowerCase())) memory.push(String(f));
  saveMemory(memory);
}
function forget(about) {
  const words = String(about || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (!words.length) return;
  memory = memory.filter((m) => !words.every((w) => m.toLowerCase().includes(w)));
  saveMemory(memory);
}
async function learnFrom(question, answer) {
  try {
    const r = await post('/api/learn', { question, answer, memory: memory.slice(-60) });
    const recent = memory.slice(-60);
    const drop = new Set((r.remove || []).map((n) => recent[n - 1]));
    if (drop.size) memory = memory.filter((m) => !drop.has(m));
    remember(r.add || []);
  } catch { /* learning is a bonus */ }
}

// --- speaking typed answers -------------------------------------------------------
/** A British male voice from the browser, if it has one. Free, and on the device. */
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const plain = String(text || '').replace(/[*_#`>]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/\s+/g, ' ').trim();
  if (!plain) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(plain.slice(0, 900));
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find((v) => /en-GB/i.test(v.lang) && /male|ryan|george|daniel|thomas|arthur/i.test(v.name))
    || voices.find((v) => /en-GB/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang)) || null;
  u.rate = 1.05;
  let pulse = null;
  u.onstart = () => { setState('speaking'); pulse = setInterval(() => { speechLevel = 0.25 + Math.random() * 0.35; }, 120); };
  u.onend = u.onerror = () => { clearInterval(pulse); speechLevel = 0; if (state === 'speaking') setState('idle'); };
  speechSynthesis.speak(u);
}

/** Asks the Jarvis server, and shows (and says) what comes back. */
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
    const history = log.slice(1, 7).filter((e) => e.answer).reverse().map((e) => ({ question: e.question, answer: e.answer }));
    const data = await post('/api/ask', { question: q, tz: TZ, history, memory: memory.slice(-60) });
    entry.answer = data.answer || 'Done.';
    rich($('#current-response'), entry.answer);
    $('#request-status').textContent = 'Done';
    for (const f of data.found || []) found.unshift(f);
    if (data.memoryAdd && data.memoryAdd.length) remember(data.memoryAdd);
    if (data.memoryForget) forget(data.memoryForget);
    task.done = true;
    setState('idle');
    speak(entry.answer);
    learnFrom(q, entry.answer);
  } catch (err) {
    entry.answer = err.message;
    rich($('#current-response'), err.message);
    $('#request-status').textContent = 'Not answered';
    task.done = true; task.failed = true;
    setState('error', err.message);
  }
  renderLog(); renderTasks(); renderFound();
}

// --- voice: Gemini Live, straight from the browser --------------------------------
/*
 * The server hands over a single-use pass (never the key); the page connects
 * to Gemini Live with it, streams the microphone, and plays the answer as it
 * arrives. Tools Jarvis asks for run on the server. The microphone is only on
 * while the voice session is; pressing the button again ends it.
 */
const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
let voice = null;

function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }

async function startVoice() {
  if (voice) { stopVoice(); return; }
  setState('thinking', 'Connecting…');
  try {
    const pass = await post('/api/live-token', { tz: TZ, memory: memory.slice(-60) });
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ws = new WebSocket(`${LIVE_URL}?access_token=${encodeURIComponent(pass.token)}`);
    const inCtx = new AudioContext();
    const outCtx = new AudioContext({ sampleRate: 24000 });
    const v = voice = { ws, mic, inCtx, outCtx, playAt: 0, sources: [], heard: '', said: '', idle: null };
    const clean = (x) => (Array.isArray(x) ? x.map(clean) : x && typeof x === 'object'
      ? Object.fromEntries(Object.entries(x).filter(([k]) => !['additionalProperties', '$schema', 'default'].includes(k)).map(([k, val]) => [k, clean(val)])) : x);

    ws.onopen = () => ws.send(JSON.stringify({ setup: {
      model: `models/${pass.model}`,
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } } },
      systemInstruction: { parts: [{ text: pass.instruction }] },
      tools: [{ functionDeclarations: pass.tools.map((t) => ({ name: t.name, description: t.description, parameters: clean(t.parameters) })) }],
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    } }));

    ws.onmessage = async (ev) => {
      const d = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text());
      if (d.setupComplete) { streamMic(v); setState('listening'); return; }
      const sc = d.serverContent;
      if (sc) {
        if (sc.inputTranscription && sc.inputTranscription.text) { v.heard += sc.inputTranscription.text; $('#current-request').textContent = v.heard.trim(); }
        if (sc.outputTranscription && sc.outputTranscription.text) { v.said += sc.outputTranscription.text; rich($('#current-response'), v.said.trim()); }
        for (const part of (sc.modelTurn && sc.modelTurn.parts) || []) if (part.inlineData) play(v, part.inlineData.data);
        if (sc.interrupted) { for (const src of v.sources) { try { src.stop(); } catch { /* done */ } } v.sources = []; v.playAt = 0; }
        if (sc.turnComplete && (v.heard.trim() || v.said.trim())) {
          const q = v.heard.trim(), a = v.said.trim();
          log.unshift({ question: q || '(voice)', answer: a }); asked++;
          renderLog(); renderTasks();
          if (q && a) learnFrom(q, a);
          v.heard = ''; v.said = '';
        }
      }
      if (d.toolCall) {
        setState('thinking');
        const responses = [];
        for (const call of d.toolCall.functionCalls || []) {
          let r = { text: 'That did not work.' };
          try { r = await post('/api/tool', { name: call.name, args: call.args || {}, tz: TZ }); } catch (err) { r = { text: err.message }; }
          if (r.memoryAdd) remember(r.memoryAdd);
          if (r.memoryForget) forget(r.memoryForget);
          for (const f of r.found || []) found.unshift(f);
          responses.push({ id: call.id, name: call.name, response: { result: r.text } });
        }
        renderFound();
        ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
      }
    };
    ws.onclose = () => { if (voice === v) stopVoice(); };
    ws.onerror = () => { if (voice === v) { stopVoice(); setState('error', 'The voice connection dropped.'); } };
  } catch (err) {
    stopVoice();
    setState('error', err.name === 'NotAllowedError' ? 'Allow the microphone to talk to Jarvis.' : err.message);
  }
}

function streamMic(v) {
  const source = v.inCtx.createMediaStreamSource(v.mic);
  const node = v.inCtx.createScriptProcessor(4096, 1, 1);
  const ratio = v.inCtx.sampleRate / 16000;
  node.onaudioprocess = (e) => {
    if (v.ws.readyState !== 1) return;
    const input = e.inputBuffer.getChannelData(0);
    const n = Math.floor(input.length / ratio);
    const pcm = new Int16Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
      pcm[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
      sum += x * x;
    }
    if (state === 'listening') speechLevel = Math.min(1, Math.sqrt(sum / n) * 7);
    v.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(new Uint8Array(pcm.buffer)), mimeType: 'audio/pcm;rate=16000' } } }));
  };
  const mute = v.inCtx.createGain(); mute.gain.value = 0;
  source.connect(node); node.connect(mute); mute.connect(v.inCtx.destination);
  v.node = node;
}

function play(v, data) {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const buf = v.outCtx.createBuffer(1, pcm.length, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
  const src = v.outCtx.createBufferSource();
  src.buffer = buf;
  src.connect(v.outCtx.destination);
  const at = Math.max(v.outCtx.currentTime + 0.02, v.playAt);
  src.start(at);
  v.playAt = at + buf.duration;
  v.sources.push(src);
  setState('speaking');
  speechLevel = 0.45;
  src.onended = () => {
    v.sources = v.sources.filter((s) => s !== src);
    if (!v.sources.length && voice === v) { speechLevel = 0; setState('listening'); }
  };
}

function stopVoice() {
  const v = voice;
  voice = null;
  if (!v) return;
  try { v.node && v.node.disconnect(); } catch { /* gone */ }
  for (const t of v.mic ? v.mic.getTracks() : []) t.stop();
  try { v.ws.close(); } catch { /* closed */ }
  v.inCtx && v.inCtx.close().catch(() => {});
  v.outCtx && v.outCtx.close().catch(() => {});
  speechLevel = 0;
  setState('idle');
}

$('#mic-button').addEventListener('click', () => startVoice());
$('#voice-mic').addEventListener('click', () => startVoice());

// --- signing in -----------------------------------------------------------------
function showSignIn() { $('#signin').hidden = false; $('#signin-password').focus(); }
$('#signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#signin-password').value;
  $('#signin-error').textContent = '';
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ password: pw }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not sign in.');
    $('#signin').hidden = true;
    $('#signin-password').value = '';
    if (!started) begin();
    afterSignIn();
  } catch (err) { $('#signin-error').textContent = err.message; }
});

async function afterSignIn() {
  // The weather under the clock: one quick tool call, no model involved.
  try {
    const r = await post('/api/tool', { name: 'weather', args: {}, tz: TZ });
    const m = String(r.text || '').match(/(-?\d+°[FC]) and ([a-z ]+)/i);
    if (m) $('#clock-sky').textContent = `${m[2]}  ${m[1]}`;
  } catch { /* the clock does not need it */ }
}

// Sign in first, over the plain page; the intro plays once you are in.
let started = false;
function begin() {
  started = true;
  $('#startup').style.removeProperty('display');
  document.documentElement.classList.add('is-starting');
  playStartup(app);
}
(async () => {
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('no server');
    const s = await res.json();
    for (const li of document.querySelectorAll('.jv-systems li')) li.classList.toggle('is-off', /Voice/.test(li.textContent) ? !s.voice : !s.brain);
    if (!s.signedIn) {
      $('#startup').style.display = 'none';
      document.documentElement.classList.remove('is-starting');
      showSignIn();
    } else { begin(); afterSignIn(); }
  } catch {
    if (!started) begin();
    $('#voice-sub').textContent = 'The Jarvis server is not connected to this site yet.';
  }
})();

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
