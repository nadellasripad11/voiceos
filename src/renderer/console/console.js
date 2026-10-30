'use strict';
/**
 * The console.
 *
 * A window onto what the assistant is doing, driven entirely by the events the
 * main process already broadcasts. It holds no state the app does not have:
 * if this window is closed and reopened it catches up from the next event
 * rather than showing a stale picture it invented.
 *
 * The drawing lives in scene.js. This file decides what the page says: which
 * phase is lit, what the cards read, what was heard and what came back.
 */

// Without the preload (opened in a plain browser to work on the layout) every
// call becomes a no-op rather than a crash, so the page is still workable.
const vo = window.voiceos || new Proxy({}, { get: () => () => () => {} });
const scene = window.Scene || { start() {}, setState() {}, setLevel() {} };

const $ = (id) => document.getElementById(id);
const el = {
  root: document.documentElement,

  request: $('currentRequest'),
  requestStatus: $('requestStatus'),
  caption: $('coreCaption'),
  retry: $('retryButton'),
  lights: $('lights'),

  voiceTitle: $('voiceTitle'),
  voiceSub: $('voiceSub'),
  systemsTitle: $('systemsTitle'),
  systemsList: $('systemsList'),

  clockDate: $('clockDate'),
  clockTime: $('clockTime'),
  clockSky: $('clockSky'),

  taskList: $('taskList'),
  tasksEmpty: $('tasksEmpty'),
  taskCount: $('taskCount'),
  vitals: $('vitalsList'),
  vitalsEmpty: $('vitalsEmpty'),
  envList: $('envList'),

  logList: $('logList'),
  logEmpty: $('logEmpty'),
  logCount: $('logCount'),
  foundList: $('foundList'),
  foundEmpty: $('foundEmpty'),

  askForm: $('askForm'),
  askInput: $('askInput'),

  alert: $('securityAlert'),
  alertText: $('securityText'),
  securityBadge: $('securityBadge'),
  alertDot: $('alertDot'),
  securityList: $('securityList'),
  securityEmpty: $('securityEmpty')
};

// --- time of day -----------------------------------------------------------
function partOfDay(d = new Date()) {
  const h = d.getHours();
  return h < 5 ? 'evening' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

let lastWeather = '';

const greetingLine = () => `Good ${partOfDay()}, sir. How can I help?`;

/** The clock, the date, the greeting in the reply. Once a second is plenty. */
function tick() {
  const now = new Date();
  el.clockTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  el.clockDate.textContent = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  if (!captionShown) el.caption.textContent = greetingLine();
}

// --- state -----------------------------------------------------------------
/*
 * Five phases, from the design, mapped onto what actually happens to a
 * request: heard, transcribed, thought about, planned, done. A phase is only
 * lit when that is genuinely the step it is on.
 */
const STATES = {
  idle: { phase: null, title: "I'm listening..", sub: 'Say "hey jarvis", type, or share a thought.', status: 'Ask me anything, sir.' },
  listening: { phase: 'listening', title: 'Go ahead, sir.', sub: 'I stop listening when you pause.', status: 'Listening…' },
  thinking: { phase: 'reasoning', title: 'Working on it.', sub: 'One moment.', status: 'Working on it…' },
  speaking: { phase: 'acting', title: 'Speaking.', sub: 'Talk over me to interrupt.', status: 'Answering.' },
  error: { phase: null, title: 'Something went wrong.', sub: '', status: 'Something went wrong.' }
};

/** Which status light each phase turns on. */
const LIGHT_FOR = {
  listening: null,
  analysing: 'optimisation',
  reasoning: 'processing',
  planning: 'processing',
  acting: 'connections'
};

let currentState = 'idle';
let currentPhase = null;
let singularity = null; // the website's scene, made at first paint
/** The latest question answered, for Try again, editing and up-arrow. */
let lastQuestion = '';
/**
 * Whether a conversation is running.
 *
 * Set when the wake word or a follow-up starts a turn, cleared when a
 * follow-up window passes in silence. It is what stops the microphone
 * reopening for ever after a single question.
 */
let conversationOpen = false;

function setState(name, { sub = null, phase } = {}) {
  const spec = STATES[name] || STATES.idle;
  currentState = name;
  el.root.dataset.state = name;
  el.voiceTitle.textContent = spec.title;
  el.voiceSub.textContent = sub === null ? spec.sub : sub;
  el.requestStatus.textContent = spec.status;
  scene.setState(name);
  if (singularity) singularity.wake();
  setPhase(phase === undefined ? spec.phase : phase);
  for (const li of el.lights.children) {
    if (li.dataset.light === 'synthesis') li.classList.toggle('is-on', name === 'speaking');
  }
  if (name !== 'listening') setLevel(0);
}

function setPhase(phase) {
  currentPhase = phase;
  const light = phase ? LIGHT_FOR[phase] : null;
  for (const li of el.lights.children) {
    if (li.dataset.light === 'synthesis' || li.dataset.light === 'memory') continue;
    li.classList.toggle('is-on', li.dataset.light === light);
  }
}

let micLevel = 0;
function setLevel(v) {
  micLevel = Math.max(0, Math.min(1, v));
  scene.setLevel(micLevel);
}

/**
 * What was heard goes in the request at the top; what Jarvis says goes in the
 * reply above the composer, which shows the greeting when there is nothing.
 *
 * @param {string} text
 * @param {'you'|'jarvis'|'fault'|null} who
 */
let captionShown = false;
function caption(text, who = null) {
  const value = String(text || '').trim();
  if (who === 'you') {
    el.request.textContent = value || 'What would you like to do?';
    return;
  }
  captionShown = Boolean(value);
  if (!captionShown) {
    el.caption.textContent = greetingLine();
    return;
  }
  renderRich(el.caption, value);
  el.caption.scrollTop = el.caption.scrollHeight;
}

// --- tasks -----------------------------------------------------------------
/**
 * What it is doing right now, and the last few things it did.
 *
 * Finished items are kept briefly rather than vanishing: a task that completes
 * in 200ms would otherwise flash and leave the user unsure it ran at all.
 */
const tasks = [];
const TASK_KEEP = 6;

function addTask(label) {
  const task = { id: Math.random().toString(36).slice(2), label, at: Date.now(), done: false };
  tasks.unshift(task);
  while (tasks.length > TASK_KEEP) tasks.pop();
  renderTasks();
  return task;
}

/**
 * Closes the open tasks, with what came of them.
 *
 * A spinner that simply vanishes tells you nothing: you cannot see whether it
 * worked, what it found, or why it gave up. So a finished task keeps its line
 * and gains an outcome and a status — which is the one thing their HUD does
 * that ours did not.
 */
function finishTasks({ outcome = null, failed = false } = {}) {
  for (const t of tasks) {
    if (t.done) continue;
    t.done = failed ? 'failed' : 'yes';
    t.tag = failed ? 'failed' : 'done';
    t.ms = Date.now() - t.at;
    // Only the last thing it was doing gets the answer attached; the earlier
    // steps were steps, and repeating the outcome against each would be noise.
    if (outcome && t === tasks[0]) t.outcome = outcome;
  }
  renderTasks();
}

function renderTasks() {
  el.taskList.innerHTML = '';
  el.tasksEmpty.hidden = tasks.length > 0;
  const running = tasks.filter((t) => !t.done).length;
  el.taskCount.textContent = running ? String(running) : '';
  for (const t of tasks) {
    const li = document.createElement('li');
    li.dataset.done = t.done || 'no';
    const spin = document.createElement('i');
    spin.className = 'spin';

    const body = document.createElement('div');
    body.textContent = t.label;

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      + (t.ms ? '  ·  ' + (t.ms < 1000 ? t.ms + 'ms' : (t.ms / 1000).toFixed(1) + 's') : '');
    body.appendChild(when);

    if (t.outcome) {
      const out = document.createElement('span');
      out.className = 'outcome';
      renderRich(out, t.outcome);
      body.appendChild(out);
    }
    if (t.tag) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = t.tag;
      body.appendChild(tag);
    }

    li.append(spin, body);
    el.taskList.appendChild(li);
  }
}

// --- showing an answer -----------------------------------------------------
/**
 * Puts a model's answer on screen as the shape it was written in.
 *
 * Models answer in markdown whether or not anyone asked them to, and this was
 * showing it raw: a news brief arrived as one wall of text with literal
 * asterisks and dashes in the middle of sentences.
 *
 * Built as DOM nodes rather than assigned as HTML, deliberately. An answer can
 * contain text the model read off a web page, and innerHTML would make every
 * page the assistant visits a place to put a script tag.
 *
 * @param {HTMLElement} host emptied, then filled
 * @param {string} text
 */
function renderRich(host, text) {
  host.textContent = '';
  const body = String(text || '').trim();
  if (!body) return;

  let list = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { list = null; continue; }

    const bullet = line.match(/^(?:[-*\u2022]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      if (!list) { list = document.createElement('ul'); list.className = 'md-list'; host.appendChild(list); }
      const li = document.createElement('li');
      addInline(li, bullet[1]);
      list.appendChild(li);
      continue;
    }

    list = null;
    const heading = line.match(/^#{1,6}\s+(.*)$/) || line.match(/^([A-Z][A-Z &/]{2,24}):?$/);
    const para = document.createElement(heading ? 'h4' : 'p');
    if (heading) para.className = 'md-head';
    // The task agent's honesty label and its "Saved to" line are footnotes,
    // shown as such rather than as part of the answer.
    else if (/^\(Written by me\b|^Saved to [A-Z]:\\/.test(line)) para.className = 'md-note';
    addInline(para, heading ? heading[1] : line);
    host.appendChild(para);
  }
}

/** Bold and code within a line, as nodes. */
function addInline(host, text) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let at = 0;
  for (const m of String(text).matchAll(pattern)) {
    if (m.index > at) host.appendChild(document.createTextNode(text.slice(at, m.index)));
    const token = m[0];
    const el_ = document.createElement(token.startsWith('`') ? 'code' : 'strong');
    el_.textContent = token.slice(token.startsWith('`') ? 1 : 2, token.startsWith('`') ? -1 : -2);
    host.appendChild(el_);
    at = m.index + token.length;
  }
  if (at < text.length) host.appendChild(document.createTextNode(text.slice(at)));
}

// --- the day's output ------------------------------------------------------
/**
 * What it has done today, counted rather than estimated.
 *
 * Their HUD leads with output — things done, hours saved — where ours led with
 * health. Health matters when something is broken; the rest of the time this
 * is the more interesting number.
 *
 * Kept in the page rather than persisted: it is a day's tally, and a console
 * that is closed and reopened starting from zero is honest about what it saw.
 */
const metrics = { tasks: 0, asked: 0, savedMs: 0, times: [] };

/** Roughly what the same job would have taken by hand, by kind. */
const BY_HAND_MS = {
  canvas_grades: 120000, canvas_assignments: 120000, list_email: 90000,
  read_email: 60000, list_events: 60000, create_event: 90000, send_email: 180000,
  search_web: 60000, answer_from_web: 60000, fetch_page: 90000, do_task: 600000,
  search_files: 90000, my_day: 180000, weather: 30000, default: 45000
};

function countTask(toolName, ms) {
  metrics.tasks++;
  metrics.savedMs += Math.max(0, (BY_HAND_MS[toolName] || BY_HAND_MS.default) - (ms || 0));
  renderMetrics();
}

function countAsked(ms) {
  metrics.asked++;
  if (ms != null) metrics.times.push(ms);
  renderMetrics();
}

function renderMetrics() {
  const mins = Math.round(metrics.savedMs / 60000);
  const median = metrics.times.length
    ? [...metrics.times].sort((a, b) => a - b)[Math.floor(metrics.times.length / 2)]
    : null;
  $('mTasks').textContent = String(metrics.tasks);
  $('mAsked').textContent = String(metrics.asked);
  $('mSaved').textContent = mins >= 60 ? (mins / 60).toFixed(1) + 'h' : mins + 'm';
  $('mFast').textContent = median == null ? '—'
    : median < 1000 ? median + 'ms' : (median / 1000).toFixed(1) + 's';
}

// --- the exchange log ------------------------------------------------------
const log = [];
const LOG_KEEP = 40;

function addExchange(question) {
  const entry = { question, answer: '', at: Date.now(), ms: null, via: null };
  log.unshift(entry);
  while (log.length > LOG_KEEP) log.pop();
  renderLog();
  return entry;
}

function renderLog() {
  el.logList.innerHTML = '';
  el.logEmpty.hidden = log.length > 0;
  el.logCount.textContent = log.length ? String(log.length) : '';
  for (const e of log) {
    const li = document.createElement('li');

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [
      new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      e.via || null,
      e.ms != null ? `${e.ms}ms` : null
    ].filter(Boolean).join('  ·  ');

    const you = document.createElement('div');
    you.className = 'you';
    you.textContent = e.question;

    li.append(meta, you);

    if (e.answer) {
      const him = document.createElement('div');
      him.className = 'him';
      renderRich(him, e.answer);
      li.appendChild(him);
    }
    el.logList.appendChild(li);
  }
}

// --- sources ---------------------------------------------------------------
function renderFound(items) {
  if (!items || !items.length) return;
  el.foundList.innerHTML = '';
  el.foundEmpty.hidden = true;
  for (const f of items.slice(0, 8)) {
    const li = document.createElement('li');
    const glyph = document.createElement('span');
    glyph.textContent = f.glyph || '•';
    const body = document.createElement('div');
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = f.title || '';
    body.appendChild(t);
    if (f.subtitle) {
      const s = document.createElement('div');
      s.className = 's';
      s.textContent = f.subtitle;
      body.appendChild(s);
    }
    li.append(glyph, body);
    el.foundList.appendChild(li);
  }
}

// --- systems ---------------------------------------------------------------
/**
 * The five dots on the Systems card, and the full readings behind them.
 *
 * A dot is blue only when that part is actually up. The design shows five
 * blue dots, and five blue dots that were always blue would be decoration.
 */
let lastVitals = null;
function renderVitals(v) {
  if (!v) return;
  lastVitals = v;

  const ok = {
    language: v.brain && v.brain !== 'none' ? 'yes' : 'no',
    voice: v.voice && v.voice !== 'muted' ? 'yes' : 'off',
    hearing: v.stt && v.stt !== 'none' ? 'yes' : 'no',
    tools: 'yes',
    memory: v.memoryLow ? 'warn' : 'yes'
  };
  const detail = { language: v.brain, voice: v.voice, hearing: v.stt, tools: v.wake ? `wake word: ${v.wake}` : '', memory: v.memory };
  let down = 0;
  for (const li of el.systemsList.children) {
    const state = ok[li.dataset.sys] || 'off';
    li.dataset.ok = state;
    li.title = detail[li.dataset.sys] || '';
    if (state === 'no' || state === 'warn') down++;
  }
  el.systemsTitle.textContent = down ? `${down} system${down > 1 ? 's' : ''} need${down > 1 ? '' : 's'} attention` : 'Systems online';

  const memLight = el.lights.querySelector('[data-light="memory"]');
  if (memLight) memLight.classList.toggle('is-warn', Boolean(v.memoryLow));

  if (v.weather) {
    lastWeather = v.weather;
    el.clockSky.textContent = v.weather;
  }

  fillRows(el.vitals, el.vitalsEmpty, [
    ['brain', v.brain, false],
    ['voice', v.voice, false],
    ['hearing', v.stt, false],
    ['wake word', v.wake, false],
    ['memory', v.memory, v.memoryLow]
  ]);
  fillRows(el.envList, null, [
    ['weather', v.weather || null, false],
    ['memory', v.memory, v.memoryLow],
    ['microphone', v.wake && v.wake !== 'off' ? 'open, in memory only' : 'closed', false],
    ['version', v.version || null, false]
  ]);
}

function fillRows(list, empty, rows) {
  list.textContent = '';
  if (empty) empty.hidden = rows.some(([, value]) => Boolean(value));
  for (const [k, value, warn] of rows) {
    if (!value) continue;
    const li = document.createElement('li');
    if (warn) li.dataset.warn = 'yes';
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = k;
    const val = document.createElement('span');
    val.className = 'v';
    val.textContent = value;
    li.append(key, val);
    list.appendChild(li);
  }
}

// --- views -----------------------------------------------------------------
const TITLES = {
  conversations: 'Conversations', tasks: 'Tasks', knowledge: 'Knowledge',
  systems: 'Systems', environment: 'Environment'
};

function showView(name) {
  el.root.dataset.view = name;
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('is-active', b.dataset.view === name);
  for (const p of document.querySelectorAll('.pane')) p.classList.toggle('is-on', p.dataset.pane === name);
  $('sheetTitle').textContent = TITLES[name] || '';
  if (name === 'environment') {
    el.securityBadge.hidden = true;
    el.alertDot.hidden = true;
  }
}

// --- events from the app ---------------------------------------------------
vo.onSessionStart((payload = {}) => {
  setState('listening');
  caption('');
  if (payload.mode === 'agent') addTask('Listening for a question');
});

vo.onSessionStage((payload = {}) => {
  if (payload.stage !== 'thinking') return;
  const tool = payload.tool || (payload.detail && payload.detail.tool);
  const step = payload.detail && payload.detail.step;
  // A step inside a tool that is already running (the browser opening a page,
  // clicking, typing): said where you can see it, not added as another task.
  if (step) {
    el.voiceTitle.textContent = step + '…';
    el.voiceSub.textContent = 'Working in the browser. You can watch it there.';
    const running = tasks.find((t) => !t.done && t.tool === tool);
    if (running) { running.label = step; renderTasks(); }
    return;
  }
  if (tool) {
    // A long job is planned before it is done; everything else is just done.
    setState('thinking', { phase: tool === 'do_task' ? 'planning' : 'acting' });
    const t = addTask(`Running ${tool.replace(/_/g, ' ')}`);
    t.tool = tool;
  } else {
    // Thinking again after a tool has run is deciding what to do next.
    setState('thinking', { phase: currentPhase === 'acting' ? 'planning' : 'reasoning' });
  }
});

vo.onTranscript((payload = {}) => {
  if (!payload.text) return;
  caption(payload.text, 'you');
  if (currentState === 'thinking' && currentPhase === 'analysing') setPhase('reasoning');
});

vo.onAgentPartial((payload = {}) => {
  if (payload.retracted) { caption(''); return; }
  if (payload.text) {
    setState('speaking');
    caption(payload.text, 'jarvis');
  }
});

vo.onAgentResult((payload = {}) => {
  // The app announces each answer before it has one ({pending: true}). That
  // was being treated as the answer: every question counted twice, running
  // tasks were ticked off before they ran, and "You said" was wiped the
  // moment work began. Now it only makes sure the question is in the log.
  if (payload.pending) {
    if (payload.question && !(log[0] && !log[0].answer && log[0].question === payload.question)) {
      addExchange(payload.question);
    }
    return;
  }
  // Everything that ran counts, and the answer is the outcome of the last one.
  for (const t of tasks) if (!t.done && t.tool) countTask(t.tool, Date.now() - t.at);
  countAsked(payload.ms);
  finishTasks({ outcome: payload.answer || null, failed: payload.answer == null });
  const entry = log[0] && !log[0].answer ? log[0] : addExchange(payload.question || '');
  entry.question = payload.question || entry.question;
  entry.answer = payload.answer || '';
  entry.ms = payload.ms ?? null;
  entry.via = payload.usedRouter ? 'router' : (payload.model || null);
  renderLog();
  renderFound(payload.found);
  caption(payload.answer || '', 'jarvis');
  if (payload.question && payload.question !== 'Watching') { lastQuestion = payload.question; el.retry.hidden = false; }
  settleSoon();
});

/**
 * Back to idle once an answer is done with, if nothing else claims the state.
 *
 * Nothing used to: a typed answer, or any answer with the voice off, left the
 * console saying "working" or "speaking" until something else happened. The
 * spoken reply, when there is one, starts within a second or two and holds the
 * state itself; this only steps in when there is nothing left to wait for.
 */
let settleTimer = null;
function settleSoon(ms = 2500) {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    const busy = audio && (audio.playing || audio.recording);
    if (!busy && (currentState === 'thinking' || currentState === 'speaking')) setState('idle');
  }, ms);
}

vo.onSessionResult((payload = {}) => {
  if (!payload.text) return;
  const entry = addExchange(payload.text);
  entry.via = payload.mode || null;
  entry.ms = payload.ms ?? null;
  renderLog();
});

vo.onSpeak(() => setState('speaking'));

vo.onSessionStop(() => { finishTasks(); setState('idle'); });
// The answer stays on screen after it is spoken; it goes when the next
// question starts, so there is time to read it.
vo.onSessionIdle(() => { finishTasks(); setState('idle'); });
vo.onSessionCancel(() => { finishTasks(); setState('idle'); caption('Cancelled.', 'jarvis'); });

vo.onSessionError((payload = {}) => {
  finishTasks({ outcome: payload.detail || payload.message || null, failed: true });
  setState('error', { sub: payload.message || 'Something went wrong' });
  caption([payload.message, payload.detail].filter(Boolean).join(' — '), 'fault');
});

vo.onWakeState((payload = {}) => {
  if (payload.level != null && currentState === 'listening') setLevel(payload.level);
});

vo.onVitals((v) => renderVitals(v));

const warnings = [];
vo.onSecurityWarning((payload = {}) => {
  const text = payload.sample
    ? `From ${payload.tool}: "${payload.sample}"`
    : (payload.text || 'It was ignored.');
  el.alertText.textContent = text;
  el.alert.hidden = false;
  el.securityBadge.hidden = false;
  el.alertDot.hidden = false;

  warnings.unshift({ text, at: Date.now() });
  el.securityEmpty.hidden = true;
  el.securityList.textContent = '';
  for (const w of warnings.slice(0, 20)) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = `Ignored · ${new Date(w.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    li.append(b, document.createTextNode(w.text));
    el.securityList.appendChild(li);
  }
});

$('securityDismiss').addEventListener('click', () => { el.alert.hidden = true; });

// --- the browser agent, live -------------------------------------------------
/*
 * Shown while the browser agent works, so what is being done in the user's
 * name is visible; it lingers a few seconds after, then goes.
 */
let browserHideTimer = null;
vo.onBrowserFrame((f = {}) => {
  const view = $('browserView');
  clearTimeout(browserHideTimer);
  if (f.done) { browserHideTimer = setTimeout(() => { view.hidden = true; }, 4000); return; }
  if (!f.data) return;
  $('browserFrame').src = `data:image/jpeg;base64,${f.data}`;
  if (f.url) $('browserUrl').textContent = f.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60);
  view.hidden = false;
});

// --- the camera, one picture at a time --------------------------------------
/*
 * Asked to look, the console opens the camera, takes one picture once the
 * exposure settles, and closes the camera again — it is never left running.
 * The picture is shown, so it is always visible what was seen.
 */
vo.onCameraRequest(async ({ id } = {}) => {
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => setTimeout(r, 700)); // let the exposure settle
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    for (const track of stream.getTracks()) track.stop();
    stream = null;
    const view = $('browserView');
    $('browserFrame').src = `data:image/jpeg;base64,${data}`;
    $('browserUrl').textContent = 'camera · just now';
    view.hidden = false;
    clearTimeout(browserHideTimer);
    browserHideTimer = setTimeout(() => { view.hidden = true; }, 8000);
    vo.cameraFrame(id, { data });
  } catch (err) {
    vo.cameraFrame(id, { error: err.message || 'no camera' });
  } finally {
    if (stream) for (const track of stream.getTracks()) track.stop();
  }
});

// --- asking before acting --------------------------------------------------
/*
 * One at a time: a second request waits behind the first rather than
 * replacing it, so an approval can never land on the wrong question.
 */
const confirms = [];
function showConfirm() {
  const next = confirms[0];
  const card = $('confirmCard');
  if (!next) { card.hidden = true; return; }
  $('confirmTitle').textContent = next.title || 'Go ahead?';
  $('confirmDetail').textContent = next.detail || '';
  // Deliberately not focused: someone mid-sentence in the ask box pressing
  // Enter must not approve a purchase they have not read.
  card.hidden = false;
}
function answerConfirm(approved) {
  const current = confirms.shift();
  if (current) vo.resolveConfirm(current.id, approved);
  showConfirm();
}
vo.onConfirm((payload = {}) => {
  if (!payload.id) return;
  confirms.push(payload);
  if (confirms.length === 1) showConfirm();
});
$('confirmYes').addEventListener('click', () => answerConfirm(true));
$('confirmNo').addEventListener('click', () => answerConfirm(false));

// --- things a person clicks ------------------------------------------------
function ask(question, { retry = false } = {}) {
  const q = String(question || '').trim();
  if (!q) return;
  // Typing is the clearest thing a person can do: whatever was being heard or
  // said gives way to it.
  if (audio) { audio.silence(); audio.discardCapture(); }
  conversationOpen = false;
  addExchange(q);
  addTask('Thinking about a typed question');
  setState('thinking');
  caption(q, 'you');
  (retry && vo.retry ? vo.retry(q) : vo.ask(q)).then((r) => {
    if (r && r.ok === false && r.reason) {
      finishTasks({ outcome: r.reason, failed: true });
      setState('error', { sub: r.reason });
    }
  }).catch((err) => {
    finishTasks({ outcome: err.message, failed: true });
    setState('error', { sub: 'Something went wrong' });
    caption(err.message, 'fault');
  });
}

el.askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const question = el.askInput.value.trim();
  if (!question) return;
  el.askInput.value = '';
  ask(question);
});

// --- try again, edit, recall, copy ------------------------------------------
// Try again asks the latest question afresh (dropping a shortcut that gave the
// answer); clicking the request puts it back in the box to edit; up-arrow in
// an empty box recalls it; clicking the reply copies it.
el.retry.addEventListener('click', () => { if (lastQuestion) ask(lastQuestion, { retry: true }); });
$('requestIsland').addEventListener('click', () => {
  if (!lastQuestion) return;
  el.askInput.value = lastQuestion;
  el.askInput.focus();
  el.askInput.select();
});
el.askInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && !el.askInput.value && lastQuestion) { e.preventDefault(); el.askInput.value = lastQuestion; }
});
el.caption.addEventListener('click', () => {
  if (!captionShown) return;
  navigator.clipboard.writeText(el.caption.innerText).then(() => {
    el.caption.classList.add('is-copied');
    el.requestStatus.textContent = 'Copied.';
    setTimeout(() => el.caption.classList.remove('is-copied'), 400);
  }).catch(() => {});
});

// Speaking is the same as Ctrl+Shift: press to start, press again to send.
const speakNow = () => vo.startMode('agent');
$('askMic').addEventListener('click', speakNow);
$('voiceBtn').addEventListener('click', speakNow);

for (const btn of document.querySelectorAll('.action')) {
  btn.addEventListener('click', () => {
    if (btn.dataset.ask) { ask(btn.dataset.ask); return; }
    // The open-ended ones need the rest of the sentence from the user.
    el.askInput.value = btn.dataset.fill || '';
    el.askInput.focus();
    el.askInput.setSelectionRange(el.askInput.value.length, el.askInput.value.length);
  });
}

$('btnSettings').addEventListener('click', () => vo.openSettings());
$('btnSearch').addEventListener('click', () => el.askInput.focus());
$('btnAlerts').addEventListener('click', () => showView('environment'));
$('avatar').addEventListener('click', () => showView('home'));
$('sheetClose').addEventListener('click', () => showView('home'));

$('winMin').addEventListener('click', () => vo.minimize());
$('winMax').addEventListener('click', () => vo.maximize());
$('winClose').addEventListener('click', () => vo.close());

for (const btn of document.querySelectorAll('.nav-item')) {
  btn.addEventListener('click', () => {
    const name = btn.dataset.view;
    showView(el.root.dataset.view === name && name !== 'home' ? 'home' : name);
  });
}

window.addEventListener('keydown', (e) => {
  // Escape closes a sheet first, then cancels whatever is running, as it
  // does everywhere else in the app.
  if (e.key === 'Escape') {
    // An open question is answered "no" first: Escape never means "yes".
    if (confirms.length) { answerConfirm(false); return; }
    if (el.root.dataset.view !== 'home') showView('home');
    else vo.cancel();
  }
  // Typing anywhere goes to the box, so there is no hunting for it.
  if (e.key.length === 1 && document.activeElement !== el.askInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
    el.askInput.focus();
  }
});

// --- the microphone --------------------------------------------------------
/**
 * The console hears and speaks now; the island used to.
 *
 * It opens the microphone once and keeps it, because the wake word needs a
 * continuous stream. That is also why closing this window hides it rather than
 * destroying it — a closed window has no microphone, and an assistant that
 * stops listening when you tidy your desktop is not much of one.
 */
const audio = window.ConsoleAudio ? new window.ConsoleAudio(vo, {
  onLevel: (l) => {
    if (currentState === 'listening') setLevel(l);
    vo.reportLevel(l);
  },
  // A run of silence means they have finished speaking. Without this the
  // recording ran until something else stopped it — 73 seconds in one case,
  // which then cost 20 seconds to transcribe into mostly nothing.
  // 'send' means they finished a sentence; 'abandon' means a follow-up
  // window opened and nobody said anything, so the conversation is over.
  onUtteranceEnd: (verdict) => {
    if (verdict === 'abandon') {
      audio.discardCapture();
      conversationOpen = false;
      setState('idle');
      // The app is still waiting to hear something; tell it nothing is coming.
      vo.nothingHeard();
      return;
    }
    // Between the last word and the transcript, it is analysing what it heard.
    setState('thinking', { phase: 'analysing' });
    audio.endCapture();
  }
}) : null;

if (audio) {
  /*
   * Listening follows the window: closing it destroys this page, and the
   * microphone goes with it. Stopped explicitly as well, so the tracks are
   * released the moment the window starts closing rather than whenever the
   * process gets round to it. Minimised still counts as open, the way a call
   * keeps going when you minimise it.
   */
  window.addEventListener('pagehide', () => audio.stop());

  audio.start().then((r) => {
    if (r && r.ok === false) {
      setState('error', { sub: 'no microphone' });
      caption(`I cannot hear: ${r.error}`);
    }
  });

  // The app decides when a question starts and stops; this only records.
  // handsFree means the user decides when it ends; otherwise silence does.
  /** Set when the keys were let go while the microphone was still opening. */
  let stoppedBeforeCapture = false;

  vo.onSessionStart(async ({ mode = 'agent', config: cfg, handsFree = false, followUp = false, wake = false } = {}) => {
    if (wake || followUp) conversationOpen = true;
    stoppedBeforeCapture = false;
    // Ctrl+Shift with the window closed opens it first, so the microphone may
    // still be coming up; recording starts the moment it is.
    const mic = await audio.start();
    if (mic && mic.ok === false) {
      setState('error', { sub: 'no microphone' });
      caption(`I cannot hear: ${mic.error}`, 'fault');
      vo.cancel();
      return;
    }
    // Let go before there was anything to record: the app is waiting for
    // audio that will never come, so tell it, rather than leave it waiting
    // for the watchdog.
    if (stoppedBeforeCapture) { vo.cancel(); return; }
    audio.beginCapture(mode, {
      vad: cfg && cfg.stt ? cfg.stt.vad : null,
      handsFree,
      followUp,
      followUpMs: (cfg && cfg.conversation && cfg.conversation.followUpMs) || 5000
    });
  });
  vo.onSessionStop(() => {
    if (audio.recording) { audio.endCapture(); return; }
    stoppedBeforeCapture = true;
    // Stopped with nothing recorded and nothing sent (the follow-up had
    // already given up, or the microphone never opened): the app would wait
    // for audio that is not coming until its watchdog fired.
    if (!audio.submitted) vo.nothingHeard();
  });
  // Cancelled means thrown away: sending the recording on would only have the
  // app receive it, find no session, and drop it.
  vo.onSessionCancel(() => { audio.silence(); audio.discardCapture(); });
  vo.onSpeak((payload) => audio.speak(payload || {}));

  /**
   * The next turn, once it has finished speaking.
   *
   * This is what makes it a conversation rather than a series of commands:
   * you answer, it listens again, and nothing has to be pressed. Only the
   * renderer knows when playback actually ended — asking any earlier means
   * recording itself reading the previous answer back.
   */
  /**
   * They started talking over the answer.
   *
   * The reply is already stopped by the time this runs; what is left is to
   * take the interruption as the next turn, which is what makes it feel like
   * interrupting a person rather than pressing stop.
   */
  audio.onBargeIn = () => {
    caption('');
    setState('listening');
    conversationOpen = true;
    vo.bargeIn();
  };

  audio.onSpeechFinished = () => {
    if (!conversationOpen || !audio.micOn) { setState('idle'); return; }
    vo.startFollowUp();
  };
}

// --- first paint -----------------------------------------------------------
scene.start();
// The website's singularity, moved the way the site moves it: busier while
// thinking, following the microphone while listening, pulsing while speaking.
// Unlike the site it holds still while idle: always moving cost ~30% of a
// core on this laptop, and even redrawing the still picture ~20%.
if (window.createSingularity) {
  window.ORBIT_IDLE_MS = 0;
  singularity = window.createSingularity(document.getElementById('singularity'), {
    getMotion: () => currentState !== 'idle',
    getEnergy: () => (currentState === 'thinking' ? 0.8 : currentState === 'speaking' ? 0.5 : 0),
    getSpeechLevel: () => (currentState === 'speaking' ? 0.3 + 0.2 * Math.sin(performance.now() / 110) : currentState === 'listening' ? micLevel : 0),
    getState: () => (currentState === 'error' ? 'idle' : currentState)
  });
}
setState('idle');
tick();
setInterval(tick, 1000);
showView('home');
renderTasks();
renderLog();
renderMetrics();

(async () => {
  try {
    const status = await vo.getStatus();
    if (status) {
      renderVitals({ ...(status.vitals || {}), version: status.version ? `v${status.version}` : null });
    }
  } catch {
    // The console is a view. Without a status it simply waits for events.
  }
})();
