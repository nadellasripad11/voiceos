'use strict';
/**
 * Replaces the box outline with a cursor trail, and fixes the coordinate space.
 *
 * Two problems with what was there:
 *
 * 1. The native bridge reports physical pixels (2736x1824 here) while Electron
 *    windows are laid out in device-independent pixels (1368x912 at 200%
 *    scaling). The overlay was positioning physical coordinates in a logical
 *    space, so the outline was drawn at twice the intended offset.
 *
 * 2. A box around the whole element is the wrong shape. What is wanted is a
 *    line that follows the pointer, drawn only while it is moving, marking the
 *    area the user swept over.
 */
const fs = require('fs');

// --- renderer -------------------------------------------------------------
fs.writeFileSync('src/renderer/highlight/highlight.js', `'use strict';
/**
 * Cursor trail.
 *
 * Draws an ink line following the pointer while Agent Mode listens, so the user
 * can sweep over or circle what they are asking about and see exactly what was
 * marked. The trail fades from the tail so it reads as motion rather than as a
 * permanent scribble, and nothing is drawn while the pointer is still.
 */

const canvas = document.getElementById('trail');
const ctx = canvas.getContext('2d');

/** Points are {x, y, t}; t drives the fade. */
let points = [];
let active = false;
let raf = null;

const LIFETIME_MS = 1400;   // how long a point stays visible
const MIN_STEP = 2;         // ignore sub-pixel jitter so a still pointer draws nothing

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

window.voiceos.onPoint((payload) => {
  if (!payload) {
    // Session over: let the trail fade out rather than cutting it.
    active = false;
    return;
  }
  active = true;

  const last = points[points.length - 1];
  if (last) {
    const dx = payload.x - last.x;
    const dy = payload.y - last.y;
    // Only extend the trail when the pointer actually moved.
    if (Math.hypot(dx, dy) < MIN_STEP) return;
  }
  points.push({ x: payload.x, y: payload.y, t: performance.now() });
  if (!raf) raf = requestAnimationFrame(draw);
});

function draw(now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Drop points that have fully faded.
  points = points.filter((p) => now - p.t < LIFETIME_MS);

  if (points.length > 1) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const age = (now - b.t) / LIFETIME_MS;
      const life = Math.max(0, 1 - age);

      // Thickness and opacity both fall off toward the tail, which is what
      // makes it read as a stroke being drawn rather than a static line.
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = \`rgba(10, 132, 255, \${(life * 0.9).toFixed(3)})\`;
      ctx.lineWidth = 2 + life * 4;
      ctx.stroke();

      // A soft halo under the brightest part of the stroke.
      if (life > 0.55) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = \`rgba(90, 180, 255, \${((life - 0.55) * 0.5).toFixed(3)})\`;
        ctx.lineWidth = 10 + life * 8;
        ctx.stroke();
      }
    }

    // A dot at the head, so the live end of the stroke is obvious.
    const head = points[points.length - 1];
    if (now - head.t < 160) {
      ctx.beginPath();
      ctx.arc(head.x, head.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(10, 132, 255, 0.95)';
      ctx.fill();
    }
  }

  if (points.length || active) {
    raf = requestAnimationFrame(draw);
  } else {
    raf = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}
`);

fs.writeFileSync('src/renderer/highlight/index.html', `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'self'; style-src 'self';" />
  <title>VoiceOS trail</title>
  <link rel="stylesheet" href="highlight.css" />
</head>
<body>
  <!--
    The cursor trail. Covers the display, never takes a click, and draws only
    while the pointer is moving during an Agent Mode session.
  -->
  <canvas id="trail"></canvas>
  <script src="highlight.js"></script>
</body>
</html>
`);

fs.writeFileSync('src/renderer/highlight/highlight.css', `/**
 * The cursor trail overlay.
 *
 * Nothing here may be opaque or interactive: the window covers the whole
 * display, so a background or a pointer target would make the desktop
 * unusable.
 */
* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  width: 100%;
  height: 100%;
  background: transparent;
  overflow: hidden;
  pointer-events: none;
  -webkit-user-select: none;
  user-select: none;
}

#trail {
  display: block;
  width: 100%;
  height: 100%;
}
`);

// --- preload --------------------------------------------------------------
fs.writeFileSync('src/preload/highlight.js', `'use strict';
/** Preload bridge for the cursor trail. Receive-only: it never acts. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceos', {
  onPoint: (fn) => {
    const wrapped = (_e, payload) => fn(payload);
    ipcRenderer.on('trail-point', wrapped);
    return () => ipcRenderer.removeListener('trail-point', wrapped);
  }
});
`);

// --- main -----------------------------------------------------------------
const mp = 'src/main/main.js';
let m = fs.readFileSync(mp, 'utf8');

m = m.replace(
  /\/\*\* Polls what is under the cursor and feeds the overlay\. \*\/[\s\S]*?function stopTargeting\(\{ keepWindow = false \} = \{\} \) \{[\s\S]*?\n\}/,
  `/**
 * Follows the pointer and feeds the trail.
 *
 * Only the cursor position is read, at a rate fast enough to draw a smooth
 * stroke. The previous version asked UI Automation what was under the pointer
 * on every tick, which cost a few hundred milliseconds a call and reported a
 * whole element when what is wanted is the path the user swept.
 */
let trailTimer = null;
let lastPoint = null;

function startTargeting() {
  if (!config.get('agent.cursorContext', true)) return;
  if (config.get('privacy.privateMode')) return;

  const win = createHighlight();
  const display = screen.getPrimaryDisplay();
  win.setBounds(display.bounds);
  win.showInactive();

  stopTargeting({ keepWindow: true });
  lastPoint = null;

  trailTimer = setInterval(async () => {
    try {
      const pos = await services.bridge.cursorPos();

      // The bridge reports physical pixels; the overlay is laid out in
      // device-independent pixels. Without this the trail lands at a multiple
      // of the right place on any scaled display.
      const scale = display.scaleFactor || 1;
      const x = pos.x / scale - display.bounds.x;
      const y = pos.y / scale - display.bounds.y;

      // Nothing is sent while the pointer is still, so a stationary cursor
      // draws nothing at all.
      if (lastPoint && Math.abs(x - lastPoint.x) < 1 && Math.abs(y - lastPoint.y) < 1) return;
      lastPoint = { x, y };

      if (windows.highlight && !windows.highlight.isDestroyed()) {
        windows.highlight.webContents.send('trail-point', { x, y });
      }
    } catch {
      // Reading the cursor can fail transiently; a dropped frame is harmless.
    }
  }, 40);
}

function stopTargeting({ keepWindow = false } = {}) {
  if (trailTimer) { clearInterval(trailTimer); trailTimer = null; }
  lastPoint = null;
  if (windows.highlight && !windows.highlight.isDestroyed()) {
    // Tell it to stop extending; the stroke fades on its own.
    windows.highlight.webContents.send('trail-point', null);
    if (!keepWindow) setTimeout(() => {
      if (windows.highlight && !windows.highlight.isDestroyed()) windows.highlight.hide();
    }, 1500);
  }
}`
);

fs.writeFileSync(mp, m);

console.log('trail renderer written');
console.log('main uses cursorPos only:', m.includes("services.bridge.cursorPos()") && !m.includes('elementAt(x, y);\n      if (!element'));
console.log('scale correction:', m.includes('display.scaleFactor'));
