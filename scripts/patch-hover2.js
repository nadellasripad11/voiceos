'use strict';
/**
 * Replaces the dead mousemove passthrough block (lines reported by the earlier
 * patch) with the hit-rectangle reporter the main process needs.
 *
 * Done by line range because the block has been edited enough that matching it
 * with a regex is unreliable.
 */
const fs = require('fs');

const p = 'src/renderer/notch/notch.js';
const raw = fs.readFileSync(p, 'utf8');
const nl = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);

const start = lines.findIndex((l) => l.includes('--- Pointer passthrough'));
const end = lines.findIndex((l) => l.includes("window.addEventListener('mouseleave', () => setInteractive(false));"));

if (start === -1 || end === -1 || end < start) {
  console.error('Could not find the passthrough block; nothing changed.');
  process.exit(1);
}

const block = `// --- Hit testing ----------------------------------------------------------
// Electron does not deliver mouse moves to a window that is both click-through
// and non-focusable, so this window cannot tell when the pointer is over it.
// The main process polls the cursor instead; all it needs from here is where
// the island currently is.

/** Reports the interactive rectangles in window-relative CSS pixels. */
function reportHitRect() {
  const rects = [];
  const card = el.card.getBoundingClientRect();
  if (card.width > 0) {
    rects.push({ x: card.left, y: card.top, width: card.width, height: card.height });
  }
  if (el.confirm && !el.confirm.hidden) {
    const sheet = el.confirm.getBoundingClientRect();
    if (sheet.width > 0) {
      rects.push({ x: sheet.left, y: sheet.top, width: sheet.width, height: sheet.height });
    }
  }
  bridge.setHitRects(rects);
}

// The island changes shape with every state, so the rectangle is re-reported
// whenever it resizes or the state attribute changes.
new ResizeObserver(() => reportHitRect()).observe(el.card);
new MutationObserver(() => reportHitRect())
  .observe(el.stage, { attributes: true, attributeFilter: ['data-state'] });
setTimeout(reportHitRect, 60);
`;

const next = [...lines.slice(0, start), ...block.split('\n'), ...lines.slice(end + 1)];
fs.writeFileSync(p, next.join(nl));

const after = fs.readFileSync(p, 'utf8');
console.log('reporter added:', after.includes('bridge.setHitRects'));
console.log('setInteractive gone:', !after.includes('setInteractive'));
console.log('observers:', after.includes('ResizeObserver') && after.includes('MutationObserver'));
