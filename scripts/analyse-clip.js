'use strict';
/**
 * Measures the voice in a video clip.
 *
 *   npx electron scripts/analyse-clip.js "<file.mp4>" ["<file2.mp4>"]
 *
 * Written because matching a voice by ear is not something I can do, and
 * guessing at it produced bm_george at 138 Hz when the target is nearer 100.
 * Chromium decodes the audio, and pitch and speaking rate come out as numbers
 * that can be compared against what our own voices measure.
 *
 * Electron rather than Node: decoding AAC needs a media stack, and the app
 * already ships one.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

const files = process.argv.slice(2).filter((a) => /\.(mp4|m4a|mp3|wav|webm)$/i.test(a));

const PAGE = `
<!doctype html><meta charset="utf-8"><body><script>
/** Median fundamental frequency over voiced frames, by autocorrelation. */
function medianF0(samples, rate) {
  const frame = Math.round(rate * 0.04);
  const hop = Math.round(rate * 0.02);
  const minLag = Math.floor(rate / 300);
  const maxLag = Math.floor(rate / 60);
  const found = [];
  for (let start = 0; start + frame < samples.length; start += hop) {
    let energy = 0;
    for (let i = 0; i < frame; i++) energy += samples[start + i] ** 2;
    if (Math.sqrt(energy / frame) < 0.015) continue;
    let bestLag = 0, bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      for (let i = 0; i < frame - lag; i++) c += samples[start + i] * samples[start + i + lag];
      c /= (frame - lag);
      if (c > bestCorr) { bestCorr = c; bestLag = lag; }
    }
    if (bestLag && bestCorr / (energy / frame) > 0.3) found.push(rate / bestLag);
  }
  if (!found.length) return null;
  found.sort((a, b) => a - b);
  return {
    median: found[Math.floor(found.length / 2)],
    p10: found[Math.floor(found.length * 0.1)],
    p90: found[Math.floor(found.length * 0.9)],
    voicedFrames: found.length
  };
}

/** Share of the clip carrying speech, and how broken up it is. */
function pacing(samples, rate) {
  const frame = Math.round(rate * 0.02);
  let voiced = 0, total = 0, runs = 0, inRun = false;
  for (let s = 0; s + frame < samples.length; s += frame) {
    let e = 0;
    for (let i = 0; i < frame; i++) e += samples[s + i] ** 2;
    const loud = Math.sqrt(e / frame) > 0.015;
    if (loud) { voiced++; if (!inRun) { runs++; inRun = true; } } else inRun = false;
    total++;
  }
  return { voicedShare: total ? voiced / total : 0, phrases: runs };
}

/**
 * Writes 16kHz mono 16-bit PCM, which is what whisper wants.
 *
 * Pitch and pauses can be measured from the waveform; words per minute cannot,
 * and words per minute is the number that decides how fast our voice should
 * talk. So the audio comes back out and gets transcribed.
 */
function toWav(samples, rate) {
  const target = 16000;
  const ratio = rate / target;
  const n = Math.floor(samples.length / ratio);
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, target, true);
  view.setUint32(28, target * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0, c = 0;
    for (let j = start; j < end; j++) { sum += samples[j]; c++; }
    const v = Math.max(-1, Math.min(1, c ? sum / c : 0));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return Array.from(new Uint8Array(buf));
}

window.analyse = async (url) => {
  const buf = await (await fetch(url)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const decoded = await ctx.decodeAudioData(buf);
  const data = decoded.getChannelData(0);
  const rate = decoded.sampleRate;
  const f0 = medianF0(data, rate);
  const pace = pacing(data, rate);
  return {
    seconds: +(decoded.duration).toFixed(1),
    sampleRate: rate,
    pitchHz: f0 ? Math.round(f0.median) : null,
    pitchRange: f0 ? Math.round(f0.p10) + '-' + Math.round(f0.p90) : null,
    voicedPercent: Math.round(pace.voicedShare * 100),
    phrases: pace.phrases,
    wav: toWav(data, rate)
  };
};
</script></body>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));

  for (const file of files) {
    const url = 'file:///' + path.resolve(file).replace(/\\/g, '/');
    try {
      const r = await win.webContents.executeJavaScript(`window.analyse(${JSON.stringify(url)})`);
      const out = path.join('voice-samples', 'jarvis', 'clip-' + path.basename(file).slice(12, 20) + '.wav');
      require('fs').writeFileSync(out, Buffer.from(r.wav));
      delete r.wav;
      console.log('CLIP ' + JSON.stringify({ file: path.basename(file).slice(0, 24), ...r, wav: out }));
    } catch (err) {
      console.log('CLIP FAILED ' + path.basename(file).slice(0, 28) + ': ' + err.message);
    }
  }
  app.exit(0);
});
