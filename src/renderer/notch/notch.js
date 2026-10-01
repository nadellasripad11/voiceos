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
  dot: document.getElementById('dot'),
  label: document.getElementById('label'),
  hint: document.getElementById('hint'),
  wave: document.getElementById('wave'),
  timer: document.getElementById('timer'),
  close: document.getElementById('close'),
  body: document.getElementById('body'),
  asked: document.getElementById('asked'),
  askedText: document.getElementById('askedText'),
  answer: document.getElementById('answer'),
  answerText: document.getElementById('answerText'),
  found: document.getElementById('found'),
  foundList: document.getElementById('foundList'),
  confirm: document.getElementById('confirm'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmDetail: document.getElementById('confirmDetail'),
  actions: document.getElementById('actions'),
  meta: document.getElementById('meta')
};

const MODE_LABELS = { dictation: 'Dictation', agent: 'Agent', edit: 'Edit' };

const capture = {
  stream: null, context: null, source: null, processor: null, analyser: null,
  chunks: [], sampleRate: 0, startedAt: 0, timerHandle: null, rafHandle: null,
  silenceSince: 0, hasSpoken: false, config: null, mode: 'dictation', stopping: false
};

/** The text currently shown, so Insert and Copy know what to act on. */
let currentResult = null;
let pendingConfirm = null;

// --- State ---------------------------------------------------------------

function setState(state, { label, hint } = {}) {
  el.stage.dataset.state = state;
  if (label !== undefined) el.label.textContent = label;
  if (hint !== undefined) el.hint.textContent = hint;
}

function clearBody() {
  el.asked.classList.remove('has-content');
  el.answer.classList.remove('has-content');
  el.askedText.textContent = '';
  el.answerText.textContent = '';
  el.found.hidden = true;
  el.foundList.innerHTML = '';
  el.confirm.hidden = true;
  el.meta.textContent = '';
  pendingConfirm = null;
  for (const c of el.actions.querySelectorAll('.chip')) {
    c.classList.remove('is-done');
    c.textContent = c.dataset.act === 'insert' ? 'Insert'
      : c.dataset.act === 'copy' ? 'Copy' : 'Ask again';
  }
}

function showAsked(text) {
  if (!text) return;
  el.askedText.textContent = text;
  el.asked.classList.add('has-content');
}

function showAnswer(text) {
  if (!text) return;
  // Paragraphs only. Rendering arbitrary model output as HTML would be an
  // injection path, so everything is inserted as text nodes.
  el.answerText.innerHTML = '';
  for (const para of String(text).split(/\n{2,}/)) {
    const p = document.createElement('p');
    p.textContent = para.trim();
    if (p.textContent) el.answerText.appendChild(p);
  }
  el.answer.classList.add('has-content');
}

function showFound(items = []) {
  if (!items.length) { el.found.hidden = true; return; }
  el.foundList.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'found-item';

    if (item.icon) {
      const img = document.createElement('img');
      img.className = 'found-icon';
      img.src = `../shared/icons/${item.icon}`;
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
  el.found.hidden = false;
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

function drawWave() {
  const { width, height } = el.wave;
  waveCtx.clearRect(0, 0, width, height);
  const bw = width / BARS;
  const mid = height / 2;

  for (let i = 0; i < BARS; i++) {
    const level = levels[i];
    const h = Math.max(3, level * height * 0.92);
    const x = i * bw + bw * 0.26;
    const w = bw * 0.48;
    const alpha = 0.28 + level * 0.72;
    waveCtx.fillStyle = `rgba(251, 66, 104, ${alpha.toFixed(3)})`;
    roundRect(waveCtx, x, mid - h / 2, w, h, Math.min(w / 2, h / 2));
    waveCtx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function animate() {
  if (capture.analyser) {
    const buf = new Float32Array(capture.analyser.fftSize);
    capture.analyser.getFloatTimeDomainData(buf);
    levels.push(Math.min(1, rms(buf) * 7));
  } else {
    levels.push(0);
  }
  levels.shift();
  drawWave();
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
    mode, config, chunks: [], stopping: false, silenceSince: 0, hasSpoken: false
  });

  clearBody();
  currentResult = null;
  setState('listening', { label: MODE_LABELS[mode] || mode, hint: 'Listening…' });
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
    window.voiceos.reportLevel(Math.min(1, level * 7));
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
  if (elapsed > (vad.maxUtteranceMs || 120000)) return finishCapture();

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

  setState('thinking', { label: MODE_LABELS[mode] || mode, hint: 'Transcribing…' });

  const merged = mergeChunks(chunks);
  if (!merged.length) return fail('Nothing recorded', 'No audio arrived from the microphone.');

  const pcm = floatToPcm16(downsample(merged, sampleRate, TARGET_RATE));
  try {
    await window.voiceos.submitAudio({ pcm: pcm.buffer, sampleRate: TARGET_RATE, mode });
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
  setState('error', { label: title, hint: '' });
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

// --- Events from the main process ----------------------------------------

/** The island's rounding depends on which bezel it is fused to. */
function applyPosition(position) {
  if (position) document.documentElement.dataset.position = position;
}

window.voiceos.onSessionIdle(({ hotkeys, position } = {}) => {
  applyPosition(position);
  teardownCapture();
  stopTimer();
  clearBody();
  currentResult = null;
  el.timer.textContent = '';
  const key = (hotkeys && hotkeys.dictation) || 'Ctrl+Shift+Space';
  setState('idle', { label: 'VoiceOS', hint: `Press ${prettyKey(key)} to dictate` });
});

window.voiceos.onSessionStart(({ mode, config, position }) => {
  applyPosition(position);
  startCapture(mode, config);
});
window.voiceos.onSessionStop(() => finishCapture());
window.voiceos.onSessionCancel(() => window.voiceos.requestIdle());

window.voiceos.onSessionStage(({ stage }) => {
  const labels = { transcribing: 'Transcribing…', polishing: 'Polishing…', inserting: 'Inserting…', thinking: 'Thinking…' };
  if (labels[stage]) setState('thinking', { hint: labels[stage] });
});

/** Dictation finished: show what was heard and where it went. */
window.voiceos.onSessionResult((result) => {
  stopTimer();
  el.timer.textContent = '';
  if (!result || !result.ok) {
    const reason = result && result.reason;
    return fail(reason === 'silence' ? 'No speech heard' : 'Nothing to insert',
                reason === 'silence' ? 'Try again a little closer to the microphone.' : (reason || ''));
  }
  currentResult = result;
  setState('answer', { label: 'Dictation', hint: result.inserted ? 'Inserted' : 'Ready to paste' });
  clearBody();
  showAnswer(result.text);
  el.meta.textContent = [
    `${result.ms}ms`,
    result.stt && result.stt.model,
    result.target && result.target.process
  ].filter(Boolean).join(' · ');
});

/** Agent finished: the answer, what it looked at, and anything awaiting approval. */
window.voiceos.onAgentResult((payload) => {
  stopTimer();
  el.timer.textContent = '';
  currentResult = payload;
  setState('answer', { label: 'Agent', hint: '' });
  clearBody();
  showAsked(payload.question);
  showAnswer(payload.answer);
  showFound(payload.found || []);

  if (payload.confirm) {
    pendingConfirm = payload.confirm;
    el.confirmTitle.textContent = payload.confirm.title || 'Confirm this action';
    el.confirmDetail.textContent = payload.confirm.detail || '';
    el.confirm.hidden = false;
  }
  el.meta.textContent = [payload.ms && `${payload.ms}ms`, payload.model].filter(Boolean).join(' · ');
});

window.voiceos.onSessionError(({ message, detail }) => fail(message, detail));

// --- Card actions ---------------------------------------------------------

el.actions.addEventListener('click', async (e) => {
  const btn = e.target.closest('.chip');
  if (!btn || !currentResult) return;
  const text = currentResult.answer || currentResult.text || '';

  if (btn.dataset.act === 'insert') {
    await window.voiceos.insertText(text);
    markDone(btn, 'Inserted');
  } else if (btn.dataset.act === 'copy') {
    await window.voiceos.copyText(text);
    markDone(btn, 'Copied');
  } else if (btn.dataset.act === 'again') {
    window.voiceos.startMode(el.label.textContent === 'Agent' ? 'agent' : 'dictation');
  }
});

function markDone(btn, label) {
  const original = btn.textContent;
  btn.textContent = label;
  btn.classList.add('is-done');
  setTimeout(() => { btn.textContent = original; btn.classList.remove('is-done'); }, 1500);
}

el.confirm.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !pendingConfirm) return;
  const approved = btn.dataset.act === 'approve';
  el.confirm.hidden = true;
  await window.voiceos.resolveConfirm({ id: pendingConfirm.id, approved });
  pendingConfirm = null;
  if (!approved) el.meta.textContent = 'Cancelled';
});

el.close.addEventListener('click', () => window.voiceos.cancel());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.voiceos.cancel();
});

// --- Pointer passthrough --------------------------------------------------
// The window covers a band across the top of the screen permanently, so it only
// takes mouse input while the pointer is over the card itself.

let interactive = false;
function setInteractive(next) {
  if (interactive === next) return;
  interactive = next;
  window.voiceos.setInteractive(next);
}

window.addEventListener('mousemove', (e) => {
  const r = el.card.getBoundingClientRect();
  setInteractive(
    e.clientX >= r.left && e.clientX <= r.right &&
    e.clientY >= r.top && e.clientY <= r.bottom
  );
});
window.addEventListener('mouseleave', () => setInteractive(false));

el.card.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  if (el.stage.dataset.state === 'idle') window.voiceos.startMode('dictation');
});

drawWave();
setState('idle');
