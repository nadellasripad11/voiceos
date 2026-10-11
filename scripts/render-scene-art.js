'use strict';
/**
 * Renders the console's smoke and orb texture to image files.
 *
 *   npx electron scripts/render-scene-art.js            writes the app's images
 *   npx electron scripts/render-scene-art.js --preview  also writes a composite
 *                                                       to look at while tuning
 *
 * The drawing itself is scripts/scene-art/generate.js; this only runs it in a
 * hidden window and saves what comes back.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'src', 'renderer', 'console', 'art');
const previewArg = process.argv.find((a) => a.startsWith('--preview'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1672,
    height: 941,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(__dirname, 'scene-art', 'index.html'));

  const art = await win.webContents.executeJavaScript('window.renderArt()');
  fs.mkdirSync(OUT, { recursive: true });
  const save = (name, dataUrl) => {
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, name), buf);
    return Math.round(buf.length / 1024);
  };
  console.log(`smoke ${art.size.w}x${art.size.h}: ${save('smoke.webp', art.smoke)}KB in ${art.ms.smoke}ms`);
  console.log(`core: ${save('core.webp', art.core)}KB in ${art.ms.core}ms`);

  if (previewArg) {
    // The composite at design size, as a PNG something else can open.
    const target = previewArg.includes('=') ? previewArg.split('=')[1] : path.join(require('os').tmpdir(), 'voiceos-art-preview.png');
    const png = await win.webContents.executeJavaScript(`(async () => {
      const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
      const [s, c] = await Promise.all([load(${JSON.stringify(art.smoke)}), load(${JSON.stringify(art.core)})]);
      const cv = document.createElement('canvas'); cv.width = 1672; cv.height = 941;
      const x = cv.getContext('2d');
      x.fillStyle = '#e9eef4'; x.fillRect(0, 0, 1672, 941);
      x.drawImage(s, -${art.size.margin.x}, -${art.size.margin.y});
      x.save(); x.beginPath(); x.arc(836, 425, 162, 0, Math.PI * 2); x.clip();
      x.drawImage(c, 836 - 162, 425 - 162, 324, 324); x.restore();
      return cv.toDataURL('image/png');
    })()`);
    fs.writeFileSync(target, Buffer.from(png.split(',')[1], 'base64'));
    console.log(`preview: ${target}`);
  }
  app.exit(0);
});
