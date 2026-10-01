'use strict';
/**
 * WAV writing and resampling.
 *
 * Audio is captured in the renderer (Chromium's getUserMedia gives us a mic
 * without any native dependency), downsampled to the 16 kHz mono PCM that
 * Whisper expects, then written here as a RIFF file for whisper.cpp to read.
 */
const fs = require('fs');
const path = require('path');

const TARGET_SAMPLE_RATE = 16000;

/** Builds a 44-byte canonical RIFF/WAVE header for 16-bit PCM. */
function wavHeader({ sampleRate = TARGET_SAMPLE_RATE, channels = 1, dataLength }) {
  const header = Buffer.alloc(44);
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);          // fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/**
 * Writes 16-bit PCM to a .wav file.
 * @param {Buffer|Uint8Array|ArrayBuffer} pcm little-endian signed 16-bit samples
 */
function writeWav(filePath, pcm, { sampleRate = TARGET_SAMPLE_RATE, channels = 1 } = {}) {
  const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const header = wavHeader({ sampleRate, channels, dataLength: buf.length });
  fs.writeFileSync(filePath, Buffer.concat([header, buf]));
  return {
    path: filePath,
    bytes: header.length + buf.length,
    durationMs: Math.round((buf.length / 2 / channels / sampleRate) * 1000)
  };
}

/**
 * Converts Float32 samples in [-1, 1] to signed 16-bit PCM.
 * Clamps rather than wrapping, so a loud passage distorts gracefully instead of
 * inverting into noise.
 */
function floatToPcm16(float32) {
  const out = Buffer.alloc(float32.length * 2);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, i * 2);
  }
  return out;
}

/**
 * Downsamples Float32 audio to the target rate.
 *
 * Averages every source sample contributing to an output sample, which acts as
 * a cheap low-pass filter. Naive index-picking would alias high frequencies
 * down into the speech band and measurably hurts recognition.
 */
function downsampleFloat32(input, inputRate, outputRate = TARGET_SAMPLE_RATE) {
  if (outputRate === inputRate) return input;
  if (outputRate > inputRate) {
    throw new Error(`Refusing to upsample ${inputRate}Hz to ${outputRate}Hz; capture at >= ${outputRate}Hz`);
  }
  const ratio = inputRate / outputRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      count++;
    }
    out[i] = count ? sum / count : 0;
  }
  return out;
}

/** Root-mean-square level, used for the waveform and for silence detection. */
function rms(float32) {
  if (!float32.length) return 0;
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

/**
 * Trims leading and trailing silence.
 *
 * Whisper pads to a 30s window regardless, but trimming lets the adaptive
 * audio-context sizing pick a smaller window, which is where the speedup comes
 * from. Padding is kept around the speech so consonants are not clipped.
 */
function trimSilence(float32, { threshold = 0.01, padMs = 120, sampleRate = TARGET_SAMPLE_RATE } = {}) {
  const frame = Math.max(1, Math.floor(sampleRate * 0.02)); // 20ms frames
  let first = -1;
  let last = -1;
  for (let i = 0; i + frame <= float32.length; i += frame) {
    if (rms(float32.subarray(i, i + frame)) > threshold) {
      if (first === -1) first = i;
      last = i + frame;
    }
  }
  if (first === -1) return new Float32Array(0); // nothing but silence
  const pad = Math.floor((padMs / 1000) * sampleRate);
  return float32.subarray(Math.max(0, first - pad), Math.min(float32.length, last + pad));
}

module.exports = {
  TARGET_SAMPLE_RATE,
  wavHeader,
  writeWav,
  floatToPcm16,
  downsampleFloat32,
  rms,
  trimSilence
};
