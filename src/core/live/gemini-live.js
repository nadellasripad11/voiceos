'use strict';
/**
 * Talking to Gemini Live: one connection that hears, thinks and speaks.
 *
 * The usual path is three hops — transcribe, think, synthesise — each a
 * request, each waiting on the last. Live does all three on Google's side and
 * streams the spoken answer back as it is generated. Measured against a real
 * clip: first audio 728ms after the speaker stops (gemini-3.8-live), against
 * 1.6-2.4s for the three-hop path, and the laptop does none of the work.
 *
 * What leaves the machine: the clip of one request, after the wake word or a
 * hotkey — the same clip the cloud transcription would have sent. The wake
 * word stays local, and nothing streams while nobody is talking to Jarvis.
 *
 * The end of speech is decided here, not by Google: the console's own silence
 * detection already knows when the user stopped, and telling the server
 * outright saved ~1.5s against its automatic detection.
 */
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** Gemini's schema dialect: no $schema, no additionalProperties, and so on. */
function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (['$schema', 'additionalProperties', 'default', 'examples'].includes(k)) continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

class GeminiLive extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.apiKey
   * @param {string} [o.model]
   * @param {string} [o.voice] a prebuilt Gemini voice
   * @param {number} [o.idleMs] close after this long with no turn
   */
  constructor({ apiKey, model = 'gemini-3.8-live', voice = 'Charon', idleMs = 60000, logger = console } = {}) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.voice = voice;
    this.idleMs = idleMs;
    this.logger = logger;
    this.ws = null;
    this.ready = null;
    this.idleTimer = null;
  }

  get open() { return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN); }

  /**
   * Opens the session, or reuses the open one — so a conversation keeps its
   * context from one turn to the next.
   */
  connect({ systemInstruction, tools = [] }) {
    if (this.open && this.ready) return this.ready;
    this.close();
    const ws = new WebSocket(URL, { headers: { 'x-goog-api-key': this.apiKey } });
    this.ws = ws;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gemini Live did not answer in time')), 8000);
      ws.once('open', () => ws.send(JSON.stringify({ setup: {
        model: `models/${this.model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } }
        },
        systemInstruction: { parts: [{ text: systemInstruction }] },
        tools: tools.length ? [{ functionDeclarations: tools.map((t) => ({
          name: t.name, description: t.description, parameters: cleanSchema(t.parameters)
        })) }] : [],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } }
      } })));
      ws.on('message', (raw) => {
        let d;
        try { d = JSON.parse(raw); } catch { return; }
        if (d.setupComplete) { clearTimeout(timer); resolve(this); return; }
        this.handle(d);
      });
      ws.once('error', (err) => { clearTimeout(timer); reject(err); });
      ws.once('close', (code, reason) => {
        clearTimeout(timer);
        const why = String(reason || '').slice(0, 200);
        if (this.ws === ws) { this.ws = null; this.ready = null; }
        // A close before setup is an error the caller falls back on.
        reject(new Error(`Gemini Live closed (${code}${why ? `: ${why}` : ''})`));
        this.emit('closed', { code, reason: why });
      });
    });
    return this.ready;
  }

  handle(d) {
    const sc = d.serverContent;
    if (sc) {
      if (sc.inputTranscription && sc.inputTranscription.text) this.emit('heard', sc.inputTranscription.text);
      if (sc.outputTranscription && sc.outputTranscription.text) this.emit('said', sc.outputTranscription.text);
      for (const p of (sc.modelTurn && sc.modelTurn.parts) || []) {
        if (p.inlineData && p.inlineData.data) this.emit('audio', Buffer.from(p.inlineData.data, 'base64'));
      }
      if (sc.interrupted) this.emit('interrupted');
      if (sc.turnComplete) this.emit('turnComplete');
    }
    if (d.toolCall) this.emit('toolCall', d.toolCall.functionCalls || []);
    if (d.goAway) this.emit('goAway', d.goAway);
  }

  /** Sends one finished utterance: 16kHz mono 16-bit PCM. */
  sendUtterance(pcm) {
    if (!this.open) throw new Error('Gemini Live is not connected');
    this.touch();
    this.ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
    // In ~100ms pieces, as a microphone would deliver it.
    for (let i = 0; i < pcm.length; i += 3200) {
      this.ws.send(JSON.stringify({ realtimeInput: { audio: {
        data: pcm.subarray(i, i + 3200).toString('base64'), mimeType: 'audio/pcm;rate=16000'
      } } }));
    }
    this.ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
  }

  /** Sends a typed turn. */
  sendText(text) {
    if (!this.open) throw new Error('Gemini Live is not connected');
    this.touch();
    this.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }));
  }

  /** Answers the model's tool calls. */
  sendToolResponses(responses) {
    if (!this.open) return;
    this.touch();
    this.ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
  }

  /** Closes after a quiet minute, so nothing stays connected for no reason. */
  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.logger.info?.('[live] quiet for a while; closing the session');
      this.close();
    }, this.idleMs);
  }

  close() {
    clearTimeout(this.idleTimer);
    if (this.ws) { try { this.ws.close(); } catch { /* already closed */ } }
    this.ws = null;
    this.ready = null;
  }
}

/** Wraps 24kHz mono 16-bit PCM as a WAV, for the console's player. */
function pcmToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

module.exports = { GeminiLive, pcmToWav, cleanSchema };
