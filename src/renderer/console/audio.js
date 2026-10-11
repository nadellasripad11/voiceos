'use strict';
/**
 * Ears and voice for the console.
 *
 * This work used to live in the island overlay, which meant the assistant only
 * heard you while an invisible always-on-top window existed. The console is the
 * app now, so the microphone belongs to it.
 *
 * Three jobs, all on one microphone stream:
 *   - the wake word, which needs a steady trickle of 16kHz frames
 *   - a question, which needs the whole utterance buffered and sent at once
 *   - the reply, which arrives as audio clips to play in order
 *
 * One getUserMedia for all of it. Asking twice gives two audio graphs for the
 * same sound, and on this machine that is memory for nothing.
 */

const TARGET_RATE = 16000;

/**
 * How loud, and for how long, counts as talking over the reply.
 *
 * Well above the ordinary speech threshold (0.008) because echo cancellation
 * is good, not perfect, and roughly a quarter second of it because a single
 * loud block is a noise rather than a sentence.
 */
const BARGE_IN_LEVEL = 0.05;
const BARGE_IN_BLOCKS = 4;
/**
 * And this many times louder than the room was before Jarvis started talking.
 * A person interrupting is close to the microphone and well above whatever is
 * playing across the room; a television carrying on is not.
 */
const BARGE_IN_OVER_ROOM = 3;
/** What the wake detector expects per frame: 80ms at 16kHz. */
const WAKE_FRAME = 1280;

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

function rms(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum / arr.length);
}

class ConsoleAudio {
  /**
   * @param {object} bridge the preload surface
   * @param {(level: number) => void} onLevel loudness, 0..1, for the reactor
   */
  constructor(bridge, { onLevel = () => {}, onUtteranceEnd = () => {} } = {}) {
    this.bridge = bridge;
    this.onLevel = onLevel;
    /** Called when a run of silence says the person has finished speaking. */
    this.onUtteranceEnd = onUtteranceEnd;
    /** Called once the whole spoken reply has played out. */
    this.onSpeechFinished = () => {};
    /** Called when the user starts talking over the reply. */
    this.onBargeIn = () => {};
    /** Consecutive loud blocks while speaking, so a cough cannot interrupt. */
    this.overTalk = 0;
    /** How loud the room is when nobody is talking to Jarvis, averaged over a few seconds. */
    this.room = 0.01;
    /** Whether this session's recording was sent, so a stop with nothing sent can say so. */
    this.submitted = false;
    /** Whether anything was playing, so the finish fires once rather than per clip. */
    this.wasSpeaking = false;

    this.stream = null;
    this.ctx = null;
    this.node = null;
    /** Whether the microphone should be open: false once the window closes. */
    this.wanted = false;
    /** The open in progress, so two callers share one getUserMedia. */
    this.starting = null;

    /** Leftover samples that did not fill a wake frame. */
    this.wakeTail = new Float32Array(0);
    /** Set while a question is being recorded. */
    this.capture = null;

    this.speechQueue = [];
    this.speaking = null;
    this.speechTurn = 0;
  }

  /**
   * Opens the microphone and starts feeding the wake detector.
   *
   * Failure is reported rather than thrown: no microphone is a thing to tell
   * the user about, not a reason for the window to be broken.
   */
  async start() {
    this.wanted = true;
    if (this.ctx) return { ok: true };
    if (!this.starting) this.starting = this.openMic().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** Whether the microphone is open right now. */
  get micOn() { return Boolean(this.ctx); }

  /**
   * Closes the microphone completely: the tracks are stopped, so Windows'
   * microphone-in-use indicator goes away and nothing is heard — not the wake
   * word, not anything. This is what closing the window means.
   */
  stop() {
    this.wanted = false;
    this.capture = null;
    this.silence();
    this.wakeTail = new Float32Array(0);
    if (this.node) { this.node.onaudioprocess = null; try { this.node.disconnect(); } catch { /* already gone */ } }
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }

  async openMic() {
    try {
      // autoGainControl matters more than it looks. The wake model scores a
      // phrase against a threshold, and without gain the microphone delivers
      // speech too quiet to clear it — which is exactly what happened when
      // this moved off the island and the constraint was left behind: audio
      // arrived, frames were counted, and "hey jarvis" never fired once.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }

    // Closed while the browser was still asking for the microphone: give it
    // straight back rather than listen to a window nobody has open.
    if (!this.wanted) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
      return { ok: false, error: 'closed' };
    }

    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);

    this.node.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const level = rms(input);
      this.onLevel(Math.min(1, level * 7));

      // Talking over it stops it, the way interrupting a person does. The
      // microphone stays open through the reply for exactly this — a assistant
      // that cannot be interrupted makes you wait out an answer you already
      // know is wrong.
      //
      // The browser's echo cancellation is doing the hard part: without it the
      // reply coming back through the speakers would interrupt it constantly.
      // The bar is still set well above the ordinary speech threshold, and
      // several blocks in a row are required, because a door or a cough
      // cutting it off mid-sentence is worse than not being able to interrupt.
      if (this.speaking) {
        const bar = Math.max(BARGE_IN_LEVEL, this.room * BARGE_IN_OVER_ROOM);
        this.overTalk = level >= bar ? this.overTalk + 1 : 0;
        if (this.overTalk >= BARGE_IN_BLOCKS) {
          this.overTalk = 0;
          this.silence();
          this.onBargeIn();
        }
        return;
      }
      this.overTalk = 0;
      // The room's level, learnt only while nobody is being recorded, so a
      // question does not teach it that talking is the background.
      if (!this.capture) this.room += (level - this.room) * 0.03;

      const down = downsample(input, this.ctx.sampleRate, TARGET_RATE);

      // While a question is being recorded it is the question that matters;
      // the wake detector would only hear the user answering it.
      if (this.capture) {
        this.capture.chunks.push(new Float32Array(down));
        const verdict = this.shouldStop(level);
        if (verdict) {
          this.capture.stopping = true;
          this.onUtteranceEnd(verdict);
        }
        return;
      }
      this.feedWake(down);
    };

    source.connect(this.node);
    // Required for the processor to run, but muted: routing the microphone to
    // the speakers would be a feedback loop.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink);
    sink.connect(this.ctx.destination);

    return { ok: true };
  }

  /** Hands the detector whole frames, keeping the remainder for the next block. */
  feedWake(down) {
    const joined = new Float32Array(this.wakeTail.length + down.length);
    joined.set(this.wakeTail, 0);
    joined.set(down, this.wakeTail.length);

    let offset = 0;
    while (joined.length - offset >= WAKE_FRAME) {
      const frame = joined.subarray(offset, offset + WAKE_FRAME);
      offset += WAKE_FRAME;
      this.bridge.wakeAudio({ pcm: floatToPcm16(frame).buffer });
    }
    this.wakeTail = joined.slice(offset);
  }

  /**
   * Starts recording a question.
   *
   * @param {string} mode
   * @param {object} [vad] silence settings; without them the recording runs
   *   until something else stops it
   * @param {boolean} [handsFree] the user decides when it ends, so a pause to
   *   think must not cut them off
   */
  beginCapture(mode = 'agent', { vad = null, handsFree = false, followUp = false, followUpMs = 5000 } = {}) {
    this.submitted = false;
    this.capture = {
      mode, handsFree, vad, followUp, followUpMs,
      chunks: [],
      startedAt: Date.now(),
      // The room, measured rather than assumed: tracks the quietest level
      // seen and drifts up slowly, so it settles in about a second and
      // follows the room instead of trusting one number.
      noiseFloor: null,
      hasSpoken: false,
      silenceSince: 0,
      stopping: false
    };
  }

  /**
   * Ends the utterance after a run of silence.
   *
   * Without this a wake-word session recorded until something else stopped
   * it — one in the log ran for 73 seconds, then took 20 seconds to
   * transcribe, and produced "Okay. Okay. Okay." because most of it was an
   * empty room. That is most of what "the whole system is slow" was.
   *
   * Silence may only end a recording once speech has actually been heard;
   * counting from the start cut people off while they drew breath.
   *
   * @returns {'send'|'abandon'|null} 'send' when they have finished speaking,
   *   'abandon' when a follow-up window passed with nobody saying anything,
   *   null to keep listening
   */
  shouldStop(level) {
    const c = this.capture;
    if (!c || c.stopping) return null;
    const vad = c.vad;
    if (!vad || !vad.enabled) return null;

    const elapsed = Date.now() - c.startedAt;
    if (elapsed > (vad.maxUtteranceMs || 20000)) return 'send';

    c.noiseFloor = c.noiseFloor === null
      ? level
      : Math.min(level, c.noiseFloor * 1.02 + 0.00002);

    const speaking = Math.max(vad.threshold || 0.008, c.noiseFloor * (vad.noiseFactor || 3.5));

    if (level >= speaking) {
      c.hasSpoken = true;
      c.silenceSince = 0;
      return null;
    }

    if (!c.hasSpoken) {
      // A follow-up opens the microphone without anyone asking it to, so it
      // closes again quickly when the conversation is simply over. Without
      // this it would sit recording an empty room for the full cap after
      // every single answer.
      if (c.followUp && elapsed > c.followUpMs) return 'abandon';
      return null;
    }
    if (elapsed < (vad.minRecordMs || 1200)) return null;
    // Hands-free means the user says when it ends.
    if (c.handsFree) return null;

    if (!c.silenceSince) { c.silenceSince = Date.now(); return null; }
    return Date.now() - c.silenceSince > (vad.silenceMs || 900) ? 'send' : null;
  }

  /**
   * Stops recording and sends what was said.
   *
   * @returns {Promise<object|null>} whatever the app made of it
   */
  async endCapture() {
    const capture = this.capture;
    this.capture = null;
    if (!capture || !capture.chunks.length) return null;

    let total = 0;
    for (const c of capture.chunks) total += c.length;
    const samples = new Float32Array(total);
    let at = 0;
    for (const c of capture.chunks) { samples.set(c, at); at += c.length; }

    const pcm = floatToPcm16(samples);
    this.submitted = true;
    return this.bridge.submitAudio({
      pcm: pcm.buffer,
      sampleRate: TARGET_RATE,
      mode: capture.mode
    });
  }

  get recording() { return Boolean(this.capture); }

  /** Whether a reply is playing or still queued to play. */
  get playing() { return Boolean(this.speaking || this.speechQueue.length); }

  /** Drops the recording without sending it, for a follow-up nobody answered. */
  discardCapture() {
    this.capture = null;
  }

  /**
   * Queues a clip of the reply.
   *
   * Clips arrive faster than they play, and a new answer must interrupt the
   * old one rather than queue behind it — otherwise asking a second question
   * means listening to the answer to the first.
   */
  speak({ data, turn = 0 }) {
    if (!data) return;
    if (turn !== this.speechTurn) {
      this.speechTurn = turn;
      this.speechQueue = [];
      if (this.speaking) { try { this.speaking.pause(); } catch { /* already gone */ } }
      this.speaking = null;
    }
    this.speechQueue.push({ data, turn });
    this.drain();
  }

  drain() {
    if (this.speaking) return;
    if (!this.speechQueue.length) {
      // The reply is over. Only this point is safe to listen again from:
      // reopening the microphone any earlier records it reading the answer
      // back to itself.
      if (this.wasSpeaking) {
        this.wasSpeaking = false;
        try { this.onSpeechFinished(); } catch { /* a listener must not break playback */ }
      }
      return;
    }
    this.wasSpeaking = true;
    const next = this.speechQueue.shift();
    if (next.turn !== this.speechTurn) return this.drain();

    const audio = new Audio(`data:audio/wav;base64,${next.data}`);
    this.speaking = audio;
    const done = () => { this.speaking = null; this.drain(); };
    audio.addEventListener('ended', done);
    audio.addEventListener('error', done);
    audio.play().catch(done);
  }

  /** Drops whatever is still queued, for when the user cancels. */
  silence() {
    this.speechQueue = [];
    if (this.speaking) { try { this.speaking.pause(); } catch { /* already gone */ } }
    this.speaking = null;
  }
}

window.ConsoleAudio = ConsoleAudio;
