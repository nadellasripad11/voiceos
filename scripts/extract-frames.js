'use strict';
/**
 * Pulls still frames out of a video.
 *
 *   npx electron scripts/extract-frames.js <file.mp4> <outDir> [count]
 *
 * There is no ffmpeg here, but Electron ships a browser, and a browser can
 * decode video and draw it to a canvas. Frames come out as PNGs that can
 * actually be looked at, which is the only way to see how someone else's
 * interface behaves rather than guessing from a description.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [file, outDir = 'frames', count = '10'] = process.argv.slice(2);

const PAGE = `
<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">
<video id="v" style="display:block"></video>
<script>
const v = document.getElementById('v');

window.load = (url) => new Promise((resolve, reject) => {
  v.src = url;
  v.addEventListener('loadedmetadata', () => resolve({
    duration: v.duration, width: v.videoWidth, height: v.videoHeight
  }), { once: true });
  v.addEventListener('error', () => reject(new Error('could not load the video')), { once: true });
});

/** Seeks, waits for the frame to actually be painted, and returns a PNG. */
window.grab = (t, maxWidth) => new Promise((resolve, reject) => {
  const done = () => {
    try {
      const scale = Math.min(1, maxWidth / v.videoWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/png').split(',')[1]);
    } catch (e) { reject(e); }
  };
  v.addEventListener('seeked', () => {
    // One more frame of grace: 'seeked' can fire before the picture updates.
    requestAnimationFrame(() => requestAnimationFrame(done));
  }, { once: true });
  v.currentTime = t;
});
</script></body>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: { contextIsolation: true, webSecurity: false }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));

  const url = 'file:///' + path.resolve(file).replace(/\\/g, '/');
  const meta = await win.webContents.executeJavaScript(`window.load(${JSON.stringify(url)})`);
  console.log(`VIDEO ${JSON.stringify({ ...meta, file: path.basename(file).slice(0, 24) })}`);

  fs.mkdirSync(outDir, { recursive: true });
  const n = Number(count);
  for (let i = 0; i < n; i++) {
    // Spread across the clip, skipping the very start and end where videos
    // tend to be titles and credits rather than the thing itself.
    const t = meta.duration * (0.04 + (0.92 * i) / Math.max(1, n - 1));
    try {
      const b64 = await win.webContents.executeJavaScript(`window.grab(${t}, 1100)`);
      const out = path.join(outDir, `f${String(i).padStart(2, '0')}-${t.toFixed(1)}s.png`);
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
      console.log(`FRAME ${out}`);
    } catch (err) {
      console.log(`FRAME FAILED at ${t.toFixed(1)}s: ${err.message}`);
    }
  }
  app.exit(0);
});
