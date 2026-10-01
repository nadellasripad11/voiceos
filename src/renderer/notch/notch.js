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
  close: document.getElementById('close'),
  body: document.getElementById('body'),
  askedText: document.getElementById('askedText'),
  answerText: document.getElementById('answerText'),
  foundList: document.getElementById('foundList'),
  meta: document.getElementById('meta'),
  kbdA: document.getElementById('kbdA'),
  kbdB: document.getElementById('kbdB'),
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
  el.foundList.hidden = true;
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
  if (!items.length) { el.foundList.hidden = true; return; }
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
  el.foundList.hidden = false;
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
    mode, config, chunks: [], stopping: false, silenceSince: 0, hasSpoken: false
  });

  clearBody();
  currentResult = null;
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
  setState('idle', { hint: '' });

  // The footer states the chord that actually bound, which is not always the
  // preferred one.
  const dictate = (hotkeys && hotkeys.dictation) || 'Ctrl+Shift';
  const parts = prettyKey(dictate).split(' + ');
  if (el.kbdA) el.kbdA.textContent = (parts[0] || 'ctrl').toLowerCase();
  if (el.kbdB) el.kbdB.textContent = (parts[1] || 'shift').toLowerCase();
});

bridge.onSessionStart(({ mode, config, position }) => {
  applyPosition(position);
  startCapture(mode, config);
});
bridge.onSessionStop(() => finishCapture());
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
  setState('answer', { hint: result.inserted ? 'Inserted' : 'Ready to paste' });
  clearBody();
  showAnswer(result.text);
  el.meta.textContent = [
    `${result.ms}ms`,
    result.stt && result.stt.model,
    result.target && result.target.process
  ].filter(Boolean).join(' · ');
});

/** Agent finished: the answer, what it looked at, and anything awaiting approval. */
bridge.onAgentResult((payload) => {
  // The first message carries only the question, so the user sees what was
  // heard while the agent is still working.
  if (payload.pending) {
    stopTimer();
    el.timer.textContent = '';
    setState('thinking', { hint: 'Working…' });
    clearBody();
    showAsked(payload.question);
    return;
  }
  stopTimer();
  el.timer.textContent = '';
  currentResult = payload;
  setState('answer', { hint: '' });
  clearBody();
  showAsked(payload.question);
  showAnswer(payload.answer);
  showFound(payload.found || []);

  if (payload.confirm) showConfirm(payload.confirm);
  else hideConfirm();
  el.meta.textContent = [payload.ms && `${payload.ms}ms`, payload.model].filter(Boolean).join(' · ');
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
  speaking = new Audio('data:audio/wav;base64,' + data);
  speaking.play().catch((err) => console.warn('[tts] playback blocked:', err.message));
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
  if (pendingConfirm) {
    const id = pendingConfirm.id;
    hideConfirm();
    bridge.resolveConfirm({ id, approved: false });
    return;
  }
  bridge.cancel();
});

// --- Pointer passthrough --------------------------------------------------
// The window covers a band across the top of the screen permanently, so it only
// takes mouse input while the pointer is over the card itself.

let interactive = false;
function setInteractive(next) {
  if (interactive === next) return;
  interactive = next;
  bridge.setInteractive(next);
}

function within(node, x, y) {
  if (!node || node.hidden) return false;
  const r = node.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

window.addEventListener('mousemove', (e) => {
  setInteractive(within(el.card, e.clientX, e.clientY) || within(el.confirm, e.clientX, e.clientY));
});
window.addEventListener('mouseleave', () => setInteractive(false));

el.card.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  if (el.stage.dataset.state === 'idle') bridge.startMode('dictation');
});

drawWave();
setState('idle');
