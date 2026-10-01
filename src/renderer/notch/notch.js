'use strict';
/**
 * Notch overlay renderer.
 *
 * Owns microphone capture. Chromium's getUserMedia means no native audio
 * dependency at all, and the renderer is also the natural place to draw the
 * waveform from the same data.
 *
 * Audio leaves here as 16 kHz mono 16-bit PCM, which is exactly what Whisper
 * consumes, so the main process does no conversion work.
 */

const TARGET_RATE = 16000;

const el = {
  stage: document.getElementById('stage'),
  mode: document.getElementById('mode'),
  hint: document.getElementById('hint'),
  transcript: document.getElementById('transcript'),
  timer: document.getElementById('timer'),
  wave: document.getElementById('wave'),
  cancel: document.getElementById('cancel'),
  toast: document.getElementById('toast'),
  toastTitle: document.getElementById('toastTitle'),
  toastDetail: document.getElementById('toastDetail')
};

const MODE_LABELS = { dictation: 'Dictation', agent: 'Agent', edit: 'Edit' };

const capture = {
  stream: null,
  context: null,
  source: null,
  processor: null,
  analyser: null,
  chunks: [],
  sampleRate: 0,
  startedAt: 0,
  timerHandle: null,
  rafHandle: null,
  silenceSince: 0,
  hasSpoken: false,
  levelReported: false,
  config: null,
  mode: 'dictation',
  stopping: false
};

// --- UI helpers -----------------------------------------------------------

function setState(state, hint) {
  el.stage.dataset.state = state;
  if (hint !== undefined) el.hint.textContent = hint;
}

function showToast(title, detail) {
  el.toastTitle.textContent = title || '';
  el.toastDetail.textContent = detail || '';
  el.toast.hidden = false;
}

function hideToast() {
  el.toast.hidden = true;
}

function startTimer() {
  capture.startedAt = Date.now();
  stopTimer();
  capture.timerHandle = setInterval(() => {
    const s = (Date.now() - capture.startedAt) / 1000;
    el.timer.textContent = `${s.toFixed(1)}s`;
  }, 100);
}

function stopTimer() {
  if (capture.timerHandle) {
    clearInterval(capture.timerHandle);
    capture.timerHandle = null;
  }
}

// --- Waveform -------------------------------------------------------------

const waveCtx = el.wave.getContext('2d');
const BAR_COUNT = 56;
const levels = new Array(BAR_COUNT).fill(0);

function drawWave() {
  const { width, height } = el.wave;
  waveCtx.clearRect(0, 0, width, height);

  const barWidth = width / BAR_COUNT;
  const mid = height / 2;
  for (let i = 0; i < BAR_COUNT; i++) {
    const level = levels[i];
    // A floor keeps the bar visible as a quiet line instead of vanishing.
    const h = Math.max(2, level * height * 0.95);
    const x = i * barWidth;
    // Bars take the accent red while recording and neutral ink once we are
    // processing, matching the status dot so the two never disagree.
    const recording = el.stage.dataset.state === 'listening';
    const alpha = 0.3 + level * 0.7;
    waveCtx.fillStyle = recording
      ? `rgba(251, 66, 104, ${alpha.toFixed(3)})`
      : `rgba(107, 114, 128, ${(alpha * 0.8).toFixed(3)})`;
    roundRect(waveCtx, x + barWidth * 0.22, mid - h / 2, barWidth * 0.56, h, barWidth * 0.28);
    waveCtx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function pushLevel(level) {
  levels.push(Math.min(1, level));
  levels.shift();
}

function animate() {
  if (capture.analyser) {
    const buf = new Float32Array(capture.analyser.fftSize);
    capture.analyser.getFloatTimeDomainData(buf);
    // Scaled so normal speech fills most of the bar height.
    pushLevel(rms(buf) * 7);
  } else {
    pushLevel(0);
  }
  drawWave();
  capture.rafHandle = requestAnimationFrame(animate);
}

function rms(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum / arr.length);
}

// --- Capture --------------------------------------------------------------

async function startCapture(mode, config) {
  if (capture.stream) return;
  capture.mode = mode;
  capture.config = config;
  capture.chunks = [];
  capture.stopping = false;
  capture.silenceSince = 0;
  capture.hasSpoken = false;
  capture.levelReported = false;
  hideToast();
  el.transcript.textContent = '';
  el.mode.textContent = MODE_LABELS[mode] || mode;
  setState('listening', 'Listening…');
  startTimer();

  try {
    capture.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  } catch (err) {
    setState('error', 'No microphone');
    showToast('Microphone unavailable', describeMicError(err));
    return;
  }

  capture.context = new AudioContext();
  capture.sampleRate = capture.context.sampleRate;
  capture.source = capture.context.createMediaStreamSource(capture.stream);

  capture.analyser = capture.context.createAnalyser();
  capture.analyser.fftSize = 1024;
  capture.analyser.smoothingTimeConstant = 0.6;
  capture.source.connect(capture.analyser);

  // ScriptProcessor is deprecated but needs no separate module file, works
  // offline, and is reliable for this one job. AudioWorklet would add a file to
  // load over a custom protocol for no practical gain here.
  const BUFFER = 4096;
  capture.processor = capture.context.createScriptProcessor(BUFFER, 1, 1);
  capture.processor.onaudioprocess = (event) => {
    if (capture.stopping) return;
    const input = event.inputBuffer.getChannelData(0);
    capture.chunks.push(new Float32Array(input));
    const level = rms(input);
    window.voiceos.reportLevel(Math.min(1, level * 7));
    maybeAutoStop(level);
  };
  capture.source.connect(capture.processor);
  // ScriptProcessor only fires while connected to a destination. A zero-gain
  // node keeps it running without the mic being audible through the speakers.
  const mute = capture.context.createGain();
  mute.gain.value = 0;
  capture.processor.connect(mute);
  mute.connect(capture.context.destination);

  animate();
}

/**
 * Ends the utterance after a run of silence, so the user need not press again.
 *
 * Silence is only allowed to end the session once speech has actually been
 * heard. Counting silence from the moment recording starts meant that pausing
 * to think, or simply drawing breath, ended the session before the first word.
 */
function maybeAutoStop(level) {
  const vad = capture.config && capture.config.stt && capture.config.stt.vad;
  if (!vad || !vad.enabled) return;

  const elapsed = Date.now() - capture.startedAt;
  if (elapsed > (vad.maxUtteranceMs || 120000)) {
    finishCapture('max length reached');
    return;
  }

  if (level >= vad.threshold) {
    capture.hasSpoken = true;
    capture.silenceSince = 0;
    // Surface the level so the user can see the mic is actually picking them up.
    if (!capture.levelReported) {
      capture.levelReported = true;
      setState('listening', 'Listening…');
    }
    return;
  }

  // Nothing above threshold yet: keep waiting rather than giving up.
  if (!capture.hasSpoken) return;
  if (elapsed < (vad.minRecordMs || 1200)) return;

  if (!capture.silenceSince) capture.silenceSince = Date.now();
  else if (Date.now() - capture.silenceSince > vad.silenceMs) finishCapture('silence');
}

async function finishCapture(reason) {
  if (!capture.stream || capture.stopping) return;
  capture.stopping = true;
  stopTimer();
  setState('transcribing', 'Transcribing…');

  const sampleRate = capture.sampleRate;
  const chunks = capture.chunks;
  teardownCapture();

  const merged = mergeChunks(chunks);
  if (!merged.length) {
    setState('error', 'Nothing recorded');
    showToast('Nothing recorded', 'No audio arrived from the microphone.');
    return;
  }

  const downsampled = downsample(merged, sampleRate, TARGET_RATE);
  const pcm = floatToPcm16(downsampled);

  try {
    await window.voiceos.submitAudio({
      pcm: pcm.buffer,
      sampleRate: TARGET_RATE,
      mode: capture.mode
    });
  } catch (err) {
    setState('error', 'Failed');
    showToast('Could not process audio', err.message);
  }
}

function teardownCapture() {
  if (capture.rafHandle) {
    cancelAnimationFrame(capture.rafHandle);
    capture.rafHandle = null;
  }
  if (capture.processor) {
    capture.processor.onaudioprocess = null;
    try { capture.processor.disconnect(); } catch {}
    capture.processor = null;
  }
  if (capture.source) {
    try { capture.source.disconnect(); } catch {}
    capture.source = null;
  }
  capture.analyser = null;
  if (capture.context) {
    capture.context.close().catch(() => {});
    capture.context = null;
  }
  if (capture.stream) {
    for (const track of capture.stream.getTracks()) track.stop();
    capture.stream = null;
  }
  capture.chunks = [];
  levels.fill(0);
  drawWave();
}

// --- Audio maths ----------------------------------------------------------

function mergeChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
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
    let sum = 0;
    let count = 0;
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
  if (err.name === 'NotAllowedError') {
    return 'Microphone permission was denied. Allow it in Windows Settings → Privacy → Microphone.';
  }
  if (err.name === 'NotFoundError') return 'No microphone was found on this device.';
  if (err.name === 'NotReadableError') return 'Another application is using the microphone.';
  return err.message;
}

// --- Wiring ---------------------------------------------------------------

window.voiceos.onSessionIdle(({ hotkeys } = {}) => {
  teardownCapture();
  stopTimer();
  hideToast();
  el.transcript.textContent = '';
  el.timer.textContent = '';
  el.mode.textContent = 'VoiceOS';
  const key = (hotkeys && hotkeys.dictation) || 'Ctrl+Shift+Space';
  el.hint.textContent = `Press ${prettyKey(key)} to dictate`;
  setState('idle');
});

/** Turns an Electron accelerator into something readable on the pill. */
function prettyKey(accelerator) {
  return String(accelerator)
    .replace(/CommandOrControl|Control/g, 'Ctrl')
    .replace(/\+/g, ' + ');
}

window.voiceos.onSessionStart(({ mode, config }) => {
  startCapture(mode, config);
});

window.voiceos.onSessionStop(() => {
  finishCapture('user stopped');
});

window.voiceos.onSessionCancel(() => {
  teardownCapture();
  stopTimer();
  setState('idle', '');
  hideToast();
});

window.voiceos.onSessionStage(({ stage }) => {
  const labels = {
    transcribing: 'Transcribing…',
    polishing: 'Polishing…',
    inserting: 'Inserting…'
  };
  setState(stage, labels[stage] || stage);
});

window.voiceos.onSessionResult((result) => {
  if (!result || !result.ok) {
    const reason = result && result.reason;
    setState('error', reason === 'silence' ? 'No speech heard' : 'Nothing to insert');
    return;
  }
  setState('done', result.inserted ? `Inserted in ${result.ms}ms` : 'Copied to clipboard');
  el.transcript.textContent = result.text;
});

window.voiceos.onSessionError(({ message, detail }) => {
  setState('error', message);
  showToast(message, detail);
});

el.cancel.addEventListener('click', () => {
  window.voiceos.cancel();
});

// --- Pointer passthrough ---------------------------------------------------
// The window covers a strip of the screen permanently, so it only takes mouse
// input while the pointer is actually over the pill. Everywhere else, clicks
// fall through to the app underneath.
const pillEl = document.getElementById('pill');
let interactive = false;

function setInteractive(next) {
  if (interactive === next) return;
  interactive = next;
  window.voiceos.setInteractive(next);
}

window.addEventListener('mousemove', (e) => {
  const r = pillEl.getBoundingClientRect();
  const inside =
    e.clientX >= r.left && e.clientX <= r.right &&
    e.clientY >= r.top && e.clientY <= r.bottom;
  setInteractive(inside);
});

window.addEventListener('mouseleave', () => setInteractive(false));

// Clicking the resting pill starts dictation, so the overlay is usable without
// the keyboard.
pillEl.addEventListener('click', (e) => {
  if (e.target.closest('.cancel')) return;
  if (el.stage.dataset.state === 'idle') window.voiceos.startMode('dictation');
});

// Esc works whenever the overlay happens to have pointer focus; the main
// process also owns a global Escape binding for when it does not.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.voiceos.cancel();
});

drawWave();
setState('idle', '');
