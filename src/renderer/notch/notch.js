'use strict';
/**
 * Notch renderer.
 *
 * Owns microphone capture and the four display states. Audio is captured here
 * because Chromium's getUserMedia means no native audio dependency, and the
 * waveform is drawn from the same samples.
 *
 * Audio leaves as 16 kHz mono 16-bit PCM, exactly what Whisper consumes, so the
 * main process does no conversion.
 */

const TARGET_RATE = 16000;

const el = {
  stage: document.getElementById('stage'),
  card: document.getElementById('card'),
  hint: document.getElementById('hint'),
  wave: document.getElementById('wave'),
  timer: document.getElementById('timer'),
  appBadge: document.getElementById('appBadge'),
  compose: document.getElementById('compose'),
  composeInput: document.getElementById('composeInput'),
  send: document.getElementById('send'),
  replay: document.getElementById('replay'),
  foundWrap: document.getElementById('foundWrap'),
  foundLabel: document.getElementById('foundLabel'),
  close: document.getElementById('close'),
  body: document.getElementById('body'),
  askedText: document.getElementById('askedText'),
  answerText: document.getElementById('answerText'),
  foundList: document.getElementById('foundList'),
  meta: document.getElementById('meta'),
  confirm: document.getElementById('confirm'),
  confirmApp: document.getElementById('confirmApp'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmRows: document.getElementById('confirmRows'),
  confirmIcon: document.getElementById('confirmIcon'),
  confirmGo: document.getElementById('confirmGo'),
  confirmEdit: document.getElementById('confirmEdit')
};

const MODE_LABELS = { dictation: 'Dictation', agent: 'Agent', edit: 'Edit' };

const capture = {
  stream: null, context: null, source: null, processor: null, analyser: null,
  chunks: [], sampleRate: 0, startedAt: 0, timerHandle: null, rafHandle: null,
  silenceSince: 0, hasSpoken: false, config: null, mode: 'dictation', stopping: false
};

/** The text currently shown, so Insert and Copy know what to act on. */
let currentResult = null;

/**
 * The last answer, kept after the island collapses.
 *
 * An answer dismisses itself so the island does not sit over the user's work,
 * but the content is retained so hovering brings it straight back rather than
 * forcing them to ask again.
 */
let lastAnswer = null;
let collapseTimer = null;
const ANSWER_DWELL_MS = 5000;
let pendingConfirm = null;

// --- State ---------------------------------------------------------------

function setState(state, { hint } = {}) {
  el.stage.dataset.state = state;
  if (hint !== undefined) el.hint.textContent = hint;
}

function clearBody() {
  el.askedText.textContent = '';
  el.answerText.innerHTML = '';
  el.foundList.innerHTML = '';
  el.foundWrap.hidden = true;
  el.meta.textContent = '';
}

/**
 * Shows an approval request.
 *
 * Everything that will happen is spelled out as labelled rows, so the user is
 * approving a specific message to a specific recipient rather than a vague
 * "run this action".
 */
function showConfirm(confirm) {
  pendingConfirm = confirm;
  el.confirmApp.textContent = confirm.app || 'VoiceOS';
  el.confirmTitle.textContent = confirm.title || 'Confirm this action?';
  el.confirmGo.textContent = confirm.verb || 'Do it';
  el.confirmEdit.hidden = !confirm.editable;

  if (confirm.icon) {
    el.confirmIcon.src = `../shared/icons/${confirm.icon}`;
    el.confirmIcon.hidden = false;
  } else {
    el.confirmIcon.hidden = true;
  }

  el.confirmRows.innerHTML = '';
  for (const [label, value] of Object.entries(confirm.rows || {})) {
    if (!value) continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    el.confirmRows.append(dt, dd);
  }
  // Free-text detail with no labelled rows still deserves to be shown.
  if (!el.confirmRows.children.length && confirm.detail) {
    const dd = document.createElement('dd');
    dd.textContent = confirm.detail;
    dd.style.gridColumn = '1 / -1';
    el.confirmRows.appendChild(dd);
  }

  el.confirm.hidden = false;
}

function hideConfirm() {
  el.confirm.hidden = true;
  pendingConfirm = null;
}

function showAsked(text) {
  el.askedText.textContent = text || '';
}

function showAnswer(text) {
  // Paragraphs only, as text nodes. Rendering model output as HTML would be an
  // injection path straight into the overlay.
  el.answerText.innerHTML = '';
  for (const para of String(text || '').split(/\n{2,}/)) {
    const p = document.createElement('p');
    p.textContent = para.trim();
    if (p.textContent) el.answerText.appendChild(p);
  }
}

function showFound(items = []) {
  el.foundList.innerHTML = '';
  if (!items.length) { el.foundWrap.hidden = true; return; }
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'found-item';
    if (item.icon) {
      const img = document.createElement('img');
      img.className = 'found-icon';
      img.src = '../shared/icons/' + item.icon;
      img.alt = '';
      li.appendChild(img);
    } else {
      const span = document.createElement('span');
      span.className = 'found-glyph';
      span.textContent = item.glyph || '•';
      li.appendChild(span);
    }
    const main = document.createElement('div');
    main.className = 'found-main';
    const title = document.createElement('div');
    title.className = 'found-title';
    title.textContent = item.title || '';
    main.appendChild(title);
    if (item.subtitle) {
      const sub = document.createElement('div');
      sub.className = 'found-sub';
      sub.textContent = item.subtitle;
      main.appendChild(sub);
    }
    li.appendChild(main);
    el.foundList.appendChild(li);
  }
  el.foundWrap.hidden = false;
}

// --- Timer ---------------------------------------------------------------

function startTimer() {
  capture.startedAt = Date.now();
  stopTimer();
  capture.timerHandle = setInterval(() => {
    el.timer.textContent = `${((Date.now() - capture.startedAt) / 1000).toFixed(1)}s`;
  }, 100);
}

function stopTimer() {
  if (capture.timerHandle) { clearInterval(capture.timerHandle); capture.timerHandle = null; }
}

// --- Waveform ------------------------------------------------------------

const waveCtx = el.wave.getContext('2d');
const BARS = 44;
const levels = new Array(BARS).fill(0);

function drawWave(phase = 0) {
  const { width, height } = el.wave;
  waveCtx.clearRect(0, 0, width, height);

  const mid = height / 2;
  const grad = waveCtx.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0.00, '#5e5ce6');
  grad.addColorStop(0.28, '#64d2ff');
  grad.addColorStop(0.55, '#ff6482');
  grad.addColorStop(0.78, '#bf5af2');
  grad.addColorStop(1.00, '#5e5ce6');

  // Three offset strands give the ribbon depth without drawing three waveforms.
  const strands = [
    { amp: 1.0, speed: 1.0, alpha: 0.95, lw: 2.4 },
    { amp: 0.62, speed: 1.6, alpha: 0.5, lw: 1.8 },
    { amp: 0.38, speed: 2.3, alpha: 0.3, lw: 1.4 }
  ];

  for (const strand of strands) {
    waveCtx.beginPath();
    for (let x = 0; x <= width; x++) {
      const t = x / width;
      // Taper the ends so the ribbon fades out instead of cutting off.
      const taper = Math.sin(Math.PI * t);
      const level = sampleLevel(t);
      const y = mid + Math.sin(t * Math.PI * 4 + phase * strand.speed)
        * level * mid * 0.92 * strand.amp * taper;
      if (x === 0) waveCtx.moveTo(x, y);
      else waveCtx.lineTo(x, y);
    }
    waveCtx.strokeStyle = grad;
    waveCtx.globalAlpha = strand.alpha;
    waveCtx.lineWidth = strand.lw;
    waveCtx.lineCap = 'round';
    waveCtx.stroke();
  }
  waveCtx.globalAlpha = 1;
}

/** Reads the smoothed level history at a position along the ribbon. */
function sampleLevel(t) {
  const i = Math.min(levels.length - 1, Math.max(0, Math.round(t * (levels.length - 1))));
  return Math.max(0.04, levels[i]);
}

const BAR_INTERVAL_MS = 85;   // ~12 new bars a second
const SMOOTHING = 0.35;       // how quickly a bar chases its target

let lastAdvance = 0;
let currentLevel = 0;

function animate(now = performance.now()) {
  if (capture.analyser) {
    const buf = new Float32Array(capture.analyser.fftSize);
    capture.analyser.getFloatTimeDomainData(buf);
    const target = Math.min(1, rms(buf) * 7);
    // Ease toward the measured level so a single loud frame does not spike.
    currentLevel += (target - currentLevel) * SMOOTHING;
  } else {
    currentLevel += (0 - currentLevel) * SMOOTHING;
  }

  if (now - lastAdvance >= BAR_INTERVAL_MS) {
    lastAdvance = now;
    levels.push(currentLevel);
    levels.shift();
  }

  drawWave(now / 420);
  capture.rafHandle = requestAnimationFrame(animate);
}

function rms(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum / arr.length);
}

// --- Capture -------------------------------------------------------------

async function startCapture(mode, config) {
  if (capture.stream) return;
  Object.assign(capture, {
    mode, config, chunks: [], stopping: false, silenceSince: 0, hasSpoken: false, warned: false
  });

  clearBody();
  currentResult = null;
  lastAnswer = null;
  cancelCollapse();
  setState('listening', { hint: 'Listening…' });
  startTimer();

  try {
    capture.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (err) {
    fail('Microphone unavailable', describeMicError(err));
    return;
  }

  capture.context = new AudioContext();
  capture.sampleRate = capture.context.sampleRate;
  capture.source = capture.context.createMediaStreamSource(capture.stream);

  capture.analyser = capture.context.createAnalyser();
  capture.analyser.fftSize = 1024;
  capture.analyser.smoothingTimeConstant = 0.55;
  capture.source.connect(capture.analyser);

  // ScriptProcessor is deprecated but needs no separate module file and works
  // offline; AudioWorklet would add a file fetched over a custom protocol for
  // no practical gain here.
  capture.processor = capture.context.createScriptProcessor(4096, 1, 1);
  capture.processor.onaudioprocess = (event) => {
    if (capture.stopping) return;
    const input = event.inputBuffer.getChannelData(0);
    capture.chunks.push(new Float32Array(input));
    const level = rms(input);
    bridge.reportLevel(Math.min(1, level * 7));
    maybeAutoStop(level);
  };
  capture.source.connect(capture.processor);
  // A ScriptProcessor only fires while connected to a destination; a silent
  // gain node keeps it running without the mic being audible.
  const mute = capture.context.createGain();
  mute.gain.value = 0;
  capture.processor.connect(mute);
  mute.connect(capture.context.destination);

  animate();
}

/**
 * Ends the utterance after a run of silence.
 *
 * Silence may only end the session once speech has actually been heard;
 * counting from the moment recording starts cut people off while they drew
 * breath before their first word.
 */
function maybeAutoStop(level) {
  const vad = capture.config && capture.config.stt && capture.config.stt.vad;
  if (!vad || !vad.enabled) return;

  const elapsed = Date.now() - capture.startedAt;
  const limit = vad.maxUtteranceMs || 1200000;

  // Warn before cutting someone off mid-sentence, then finish and insert what
  // they said rather than discarding a long session.
  const warnAt = vad.warnAtMs || Math.max(0, limit - 60000);
  if (!capture.warned && elapsed > warnAt) {
    capture.warned = true;
    const left = Math.max(1, Math.round((limit - elapsed) / 60000));
    setState('listening', { hint: `Finishing in ${left} minute${left === 1 ? '' : 's'}…` });
  }
  if (elapsed > limit) return finishCapture();

  if (level >= vad.threshold) {
    capture.hasSpoken = true;
    capture.silenceSince = 0;
    return;
  }
  if (!capture.hasSpoken) return;
  if (elapsed < (vad.minRecordMs || 1200)) return;

  if (!capture.silenceSince) capture.silenceSince = Date.now();
  else if (Date.now() - capture.silenceSince > vad.silenceMs) finishCapture();
}

async function finishCapture() {
  if (!capture.stream || capture.stopping) return;
  capture.stopping = true;
  stopTimer();

  const sampleRate = capture.sampleRate;
  const chunks = capture.chunks;
  const mode = capture.mode;
  teardownCapture();

  setState('thinking', { hint: 'Transcribing…' });

  const merged = mergeChunks(chunks);
  if (!merged.length) return fail('Nothing recorded', 'No audio arrived from the microphone.');

  const pcm = floatToPcm16(downsample(merged, sampleRate, TARGET_RATE));
  try {
    await bridge.submitAudio({ pcm: pcm.buffer, sampleRate: TARGET_RATE, mode });
  } catch (err) {
    fail('Could not process audio', err.message);
  }
}

function teardownCapture() {
  if (capture.rafHandle) { cancelAnimationFrame(capture.rafHandle); capture.rafHandle = null; }
  if (capture.processor) {
    capture.processor.onaudioprocess = null;
    try { capture.processor.disconnect(); } catch {}
    capture.processor = null;
  }
  if (capture.source) { try { capture.source.disconnect(); } catch {} capture.source = null; }
  capture.analyser = null;
  if (capture.context) { capture.context.close().catch(() => {}); capture.context = null; }
  if (capture.stream) { for (const t of capture.stream.getTracks()) t.stop(); capture.stream = null; }
  capture.chunks = [];
  levels.fill(0);
  drawWave();
}

function fail(title, detail) {
  stopTimer();
  el.timer.textContent = '';
  setState('error', { hint: '' });
  clearBody();
  showAnswer(detail);
}

// --- Audio maths ---------------------------------------------------------

function mergeChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

/** Averaging downsample: acts as a low-pass filter so highs do not alias. */
function downsample(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0, count = 0;
    for (let j = start; j < end; j++) { sum += input[j]; count++; }
    out[i] = count ? sum / count : 0;
  }
  return out;
}

function floatToPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function describeMicError(err) {
  if (err.name === 'NotAllowedError') return 'Microphone permission was denied. Allow it in Windows Settings › Privacy › Microphone.';
  if (err.name === 'NotFoundError') return 'No microphone was found on this device.';
  if (err.name === 'NotReadableError') return 'Another application is using the microphone.';
  return err.message;
}

function prettyKey(accelerator) {
  return String(accelerator).replace(/CommandOrControl|Control/g, 'Ctrl').replace(/\+/g, ' + ');
}

/** Shows the answer and starts its dismissal countdown. */
function presentAnswer(render) {
  lastAnswer = render;
  render();
  scheduleCollapse();
}

function scheduleCollapse(delay = ANSWER_DWELL_MS) {
  clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    // Never collapse out from under an approval the user still has to answer.
    if (pendingConfirm) return scheduleCollapse(2000);
    collapseToIdle();
  }, delay);
}

function cancelCollapse() { clearTimeout(collapseTimer); collapseTimer = null; }

function collapseToIdle() {
  cancelCollapse();
  setState('idle', { hint: '' });
}

/** Hovering the collapsed island restores the answer it was showing. */
function restoreAnswer() {
  if (!lastAnswer) return;
  cancelCollapse();
  lastAnswer();
}

// --- Events from the main process ----------------------------------------

// The preview harness renders this page without a preload, so the bridge can
// legitimately be absent. Falling back to a no-op keeps the page inspectable
// instead of dying on the first subscription.
const bridge = window.voiceos || new Proxy({}, { get: () => () => () => {} });


/** The island's rounding depends on which bezel it is fused to. */
function applyPosition(position) {
  if (position) document.documentElement.dataset.position = position;
}

bridge.onSessionIdle(({ hotkeys, position } = {}) => {
  applyPosition(position);
  teardownCapture();
  stopTimer();
  clearBody();
  hideConfirm();
  currentResult = null;
  el.timer.textContent = '';
  el.appBadge.hidden = true;
  setState('idle', { hint: '' });

  // The footer states the chord that actually bound, which is not always the
  // preferred one.
  const dictate = (hotkeys && hotkeys.dictation) || 'Ctrl+Shift';
  // The placeholder states the chord that actually bound, which is not always
  // the preferred one.
  if (el.composeInput) {
    el.composeInput.placeholder = `Type or hold ${prettyKey(dictate)} to speak`;
  }
});

bridge.onSessionStart(({ mode, config, position }) => {
  applyPosition(position);
  startCapture(mode, config);
});
bridge.onSessionStop(() => finishCapture());

bridge.onSessionApp((app) => {
  if (!app) return;
  el.appBadge.innerHTML = '';
  if (app.icon) {
    const img = document.createElement('img');
    img.src = '../shared/icons/' + app.icon;
    img.alt = '';
    el.appBadge.appendChild(img);
  } else {
    const g = document.createElement('span');
    g.className = 'g';
    g.textContent = app.glyph || '◻';
    el.appBadge.appendChild(g);
  }
  const name = document.createElement('span');
  name.textContent = app.name || app.process;
  el.appBadge.appendChild(name);
  el.appBadge.hidden = false;
});
bridge.onSessionCancel(() => bridge.requestIdle());

bridge.onSessionStage(({ stage }) => {
  const labels = { transcribing: 'Transcribing…', polishing: 'Polishing…', inserting: 'Inserting…', thinking: 'Thinking…' };
  if (labels[stage]) setState('thinking', { hint: labels[stage] });
});

/** Dictation finished: show what was heard and where it went. */
bridge.onSessionResult((result) => {
  stopTimer();
  el.timer.textContent = '';
  if (!result || !result.ok) {
    const reason = result && result.reason;
    return fail(reason === 'silence' ? 'No speech heard' : 'Nothing to insert',
                reason === 'silence' ? 'Try again a little closer to the microphone.' : (reason || ''));
  }
  currentResult = result;
  presentAnswer(() => {
    setState('answer', { hint: '' });
    clearBody();
    showAnswer(result.text);
    el.meta.textContent = [
      result.ms ? `${result.ms}ms` : null,
      result.target && result.target.process
    ].filter(Boolean).join(' · ');
  });
});

/** Agent finished: the answer, what it looked at, and anything awaiting approval. */
bridge.onAgentResult((payload) => {
  // The first message carries only the question, so the user sees what was
  // heard while the agent is still working.
  if (payload.pending) {
    stopTimer();
    el.timer.textContent = '';
    cancelCollapse();
    setState('thinking', { hint: 'Working…' });
    clearBody();
    showAsked(payload.question);
    return;
  }
  stopTimer();
  el.timer.textContent = '';
  currentResult = payload;
  presentAnswer(() => {
    setState('answer', { hint: '' });
    clearBody();
    showAsked(payload.question);
    showAnswer(payload.answer);
    showFound(payload.found || []);
    if (payload.confirm) showConfirm(payload.confirm);
    el.meta.textContent = [payload.ms ? `${payload.ms}ms` : null, payload.model]
      .filter(Boolean).join(' · ');
  });
});

bridge.onAgentConfirm((confirm) => showConfirm(confirm));

bridge.onSessionError(({ message, detail }) => fail(message, detail));

/**
 * Plays a spoken reply.
 *
 * Only one reply is ever audible: a new answer cuts off the previous one rather
 * than letting two voices overlap.
 */
let speaking = null;
bridge.onSpeak(({ data }) => {
  if (!data) return;
  if (speaking) { try { speaking.pause(); } catch {} }
  speaking = new Audio("data:audio/wav;base64," + data);
  speaking.play()
    .then(() => bridge.speechStatus({ ok: true }))
    .catch((err) => {
      console.error("[tts] playback blocked: " + err.message);
      bridge.speechStatus({ ok: false, error: err.message });
    });
});

// --- Card actions ---------------------------------------------------------

/**
 * Clicking the answer copies it.
 *
 * The reference design carries no buttons, so the affordance is the text
 * itself; the confirmation is the meta line, which is already there for
 * timings and does not add anything to the layout.
 */
el.answerText.addEventListener('click', async () => {
  if (!currentResult) return;
  const text = currentResult.answer || currentResult.text || '';
  if (!text) return;
  await bridge.copyText(text);
  const previous = el.meta.textContent;
  el.meta.textContent = 'Copied';
  setTimeout(() => { el.meta.textContent = previous; }, 1500);
});

el.confirm.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !pendingConfirm) return;
  const act = btn.dataset.act;
  const id = pendingConfirm.id;
  hideConfirm();

  if (act === 'edit') {
    // Editing hands the draft back rather than sending it.
    await bridge.resolveConfirm({ id, approved: false, edit: true });
    el.meta.textContent = 'Opened for editing';
    return;
  }
  await bridge.resolveConfirm({ id, approved: act === 'approve' });
  el.meta.textContent = act === 'approve' ? 'Sent' : 'Cancelled';
});

el.close.addEventListener('click', () => bridge.cancel());

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (composeFocused) {
    el.composeInput.value = "";
    el.composeInput.blur();
    return;
  }
  if (pendingConfirm) {
    const id = pendingConfirm.id;
    hideConfirm();
    bridge.resolveConfirm({ id, approved: false });
    return;
  }
  bridge.cancel();
});

// --- Typing ---------------------------------------------------------------
// The window is deliberately not focusable, so dictated text lands in the
// user's own field rather than here. Typing needs focus, so it is asked for
// on demand and handed straight back, and the two input paths never fight.

let composeFocused = false;

el.composeInput.addEventListener("mousedown", () => {
  bridge.setFocusable(true);
});

el.composeInput.addEventListener("focus", () => {
  composeFocused = true;
  cancelCollapse();
});

el.composeInput.addEventListener("blur", () => {
  composeFocused = false;
  bridge.setFocusable(false);
  if (el.stage.dataset.state === "answer") scheduleCollapse();
});

el.composeInput.addEventListener("input", () => {
  el.send.classList.toggle("is-ready", el.composeInput.value.trim().length > 0);
});

el.compose.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el.composeInput.value.trim();
  if (!text) return;
  el.composeInput.value = "";
  el.send.classList.remove("is-ready");
  el.composeInput.blur();
  cancelCollapse();
  clearBody();
  showAsked(text);
  setState("thinking", { hint: "Thinking\u2026" });
  bridge.ask(text);
});

// --- Replay ---------------------------------------------------------------

el.replay.addEventListener("click", async () => {
  if (!currentResult) return;
  const text = currentResult.answer || currentResult.text || "";
  if (!text) return;
  el.replay.classList.add("is-busy");
  cancelCollapse();
  try { await bridge.speak(text); } finally {
    setTimeout(() => el.replay.classList.remove("is-busy"), 1200);
  }
});

// --- Hit testing ----------------------------------------------------------
// Electron does not deliver mouse moves to a window that is both click-through
// and non-focusable, so this window cannot tell when the pointer is over it.
// The main process polls the cursor instead; all it needs from here is where
// the island currently is.

/** Reports the interactive rectangles in window-relative CSS pixels. */
function reportHitRect() {
  const rects = [];
  const card = el.card.getBoundingClientRect();
  if (card.width > 0) {
    rects.push({ x: card.left, y: card.top, width: card.width, height: card.height });
  }
  if (el.confirm && !el.confirm.hidden) {
    const sheet = el.confirm.getBoundingClientRect();
    if (sheet.width > 0) {
      rects.push({ x: sheet.left, y: sheet.top, width: sheet.width, height: sheet.height });
    }
  }
  bridge.setHitRects(rects);
}

// The island changes shape with every state, so the rectangle is re-reported
// whenever it resizes or the state attribute changes.
new ResizeObserver(() => reportHitRect()).observe(el.card);
new MutationObserver(() => reportHitRect())
  .observe(el.stage, { attributes: true, attributeFilter: ['data-state'] });
setTimeout(reportHitRect, 60);


el.card.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  if (el.stage.dataset.state === 'idle') bridge.startMode('dictation');
});

// Square against a bezel, rounded when floating free.
bridge.onDocked((docked) => { document.documentElement.dataset.docked = docked || 'top'; });

// Hover is reported by the main process, since this window never receives the
// move events itself.
bridge.onHover((over) => {
  document.documentElement.dataset.hover = over ? 'true' : 'false';
  if (!over) return;
  if (el.stage.dataset.state === 'idle') restoreAnswer();
  else cancelCollapse();
});

drawWave();
setState('idle');
