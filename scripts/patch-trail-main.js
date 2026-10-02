'use strict';
/**
 * Replaces the element-polling targeting block with cursor-trail tracking,
 * by line range: the original text has shifted enough that matching it with a
 * regex is fragile.
 */
const fs = require('fs');

const p = 'src/main/main.js';
const raw = fs.readFileSync(p, 'utf8');
const nl = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);

const start = lines.findIndex((l) => l.includes('Polls what is under the cursor'));
const end = lines.findIndex((l) => l.startsWith('const RAIL_WIDTH'));

if (start === -1 || end === -1 || end <= start) {
  console.error('Could not find the targeting block; nothing changed.');
  process.exit(1);
}

const block = `/**
 * Follows the pointer and feeds the trail.
 *
 * Only the cursor position is read, fast enough to draw a smooth stroke. The
 * previous version asked UI Automation what sat under the pointer on every
 * tick, which cost a few hundred milliseconds a call and reported a whole
 * element when what is wanted is the path the user swept over.
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

      // The bridge reports physical pixels while the overlay is laid out in
      // device-independent ones. Without this correction the trail lands at a
      // multiple of the right place on any scaled display.
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
    // Stop extending the stroke; it fades on its own rather than vanishing.
    windows.highlight.webContents.send('trail-point', null);
    if (!keepWindow) {
      setTimeout(() => {
        if (windows.highlight && !windows.highlight.isDestroyed()) windows.highlight.hide();
      }, 1500);
    }
  }
}

`;

const next = [...lines.slice(0, start), ...block.split('\n'), ...lines.slice(end)];
fs.writeFileSync(p, next.join(nl));

const after = fs.readFileSync(p, 'utf8');
console.log('cursorPos only:', after.includes('services.bridge.cursorPos()'));
console.log('no element polling:', !after.includes('lastTargetKey'));
console.log('scale correction:', after.includes('display.scaleFactor'));
console.log('trail-point channel:', after.includes("'trail-point'"));
