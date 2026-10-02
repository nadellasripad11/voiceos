'use strict';
/**
 * Makes the island reachable by the mouse.
 *
 * It was relying on Electron forwarding mouse-move events to a click-through
 * window so the renderer could ask for input when the pointer was over the
 * card. That forwarding does not arrive for a window that is both
 * click-through and non-focusable, so the island never became interactive:
 * hovering, clicking to dictate, dragging and typing were all dead.
 *
 * The main process already polls the cursor for the trail, so it decides
 * instead. It knows the window's position, the renderer tells it the card's
 * rectangle, and it toggles click-through as the pointer crosses the boundary.
 * No forwarded events required.
 */
const fs = require('fs');

// --- renderer: report the card rectangle ---------------------------------
const np = 'src/renderer/notch/notch.js';
let n = fs.readFileSync(np, 'utf8');

// The old passthrough handler cannot work; replace it with a reporter.
n = n.replace(
  /function within\(node, x, y\) \{[\s\S]*?\n\}\n\nwindow\.addEventListener\('mousemove'[\s\S]*?\n\}\);\n\nwindow\.addEventListener\('mouseleave', \(\) => setInteractive\(false\)\);/,
  `/**
 * Reports the interactive rectangle to the main process.
 *
 * The main process owns hit testing, because mouse events are not delivered to
 * this window while it is click-through. It needs to know where the card
 * actually is, which changes with every state.
 */
function reportHitRect() {
  const rects = [];
  const card = el.card.getBoundingClientRect();
  if (card.width > 0) rects.push({ x: card.left, y: card.top, width: card.width, height: card.height });
  if (el.confirm && !el.confirm.hidden) {
    const sheet = el.confirm.getBoundingClientRect();
    if (sheet.width > 0) rects.push({ x: sheet.left, y: sheet.top, width: sheet.width, height: sheet.height });
  }
  bridge.setHitRects(rects);
}

// Report whenever the shape changes, which is whenever the state does.
const hitObserver = new ResizeObserver(() => reportHitRect());
hitObserver.observe(el.card);
new MutationObserver(() => reportHitRect())
  .observe(el.stage, { attributes: true, attributeFilter: ['data-state'] });
setTimeout(reportHitRect, 60);`
);

// The main process now tells the renderer when the pointer is over it.
n = n.replace(
  "bridge.onDocked((docked) => { document.documentElement.dataset.docked = docked || 'top'; });",
  `bridge.onDocked((docked) => { document.documentElement.dataset.docked = docked || 'top'; });

// Hover is reported by the main process, since this window never receives the
// move events itself.
bridge.onHover((over) => {
  document.documentElement.dataset.hover = over ? 'true' : 'false';
  if (!over) return;
  if (el.stage.dataset.state === 'idle') restoreAnswer();
  else cancelCollapse();
});`
);

// setInteractive is gone; strip the last references.
n = n.replace(/let interactive = false;\nfunction setInteractive\(next\) \{[\s\S]*?\n\}\n/, '');
n = n.replace(/\s*setInteractive\(overCard \|\| overSheet \|\| composeFocused\);/, '');
n = n.replace("  bridge.setFocusable(true);\n", "  bridge.setFocusable(true);\n");

fs.writeFileSync(np, n);

// --- preload --------------------------------------------------------------
const pp = 'src/preload/notch.js';
let p = fs.readFileSync(pp, 'utf8');
if (!p.includes('setHitRects')) {
  p = p.replace(
    "  setFocusable: (v) => ipcRenderer.send('voiceos:set-focusable', v),",
    [
      "  setFocusable: (v) => ipcRenderer.send('voiceos:set-focusable', v),",
      "  setHitRects: (rects) => ipcRenderer.send('voiceos:hit-rects', rects),",
      "  onHover: (fn) => on('notch-hover', fn),"
    ].join('\n')
  );
  fs.writeFileSync(pp, p);
}

// --- main: own the hit testing -------------------------------------------
const mp = 'src/main/main.js';
let m = fs.readFileSync(mp, 'utf8');

if (!m.includes('hitRects')) {
  m = m.replace(
    'function createNotch() {',
    `/**
 * Where the island is actually clickable, in window-relative CSS pixels.
 * Reported by the renderer, because only it knows the current layout.
 */
let hitRects = [];
let pointerOverNotch = false;
let hoverTimer = null;

/**
 * Polls the pointer and toggles click-through as it crosses the island.
 *
 * Electron does not deliver mouse moves to a window that is click-through and
 * non-focusable, so the renderer cannot do this itself. Polling here is the
 * only thing that makes the island reachable at all.
 */
function startHoverWatch() {
  if (hoverTimer) return;
  hoverTimer = setInterval(async () => {
    const win = windows.notch;
    if (!win || win.isDestroyed() || !win.isVisible() || !hitRects.length) return;

    try {
      const pos = await services.bridge.cursorPos();
      const bounds = win.getBounds();
      const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
      const scale = display.scaleFactor || 1;

      // The bridge reports physical pixels; window bounds and the reported
      // rectangles are both in device-independent ones.
      const x = pos.x / scale - bounds.x;
      const y = pos.y / scale - bounds.y;

      const inside = hitRects.some((r) =>
        x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);

      if (inside === pointerOverNotch) return;
      pointerOverNotch = inside;

      // Only claim the mouse while the pointer is genuinely over the card, so
      // the rest of the strip stays click-through.
      win.setIgnoreMouseEvents(!inside, { forward: false });
      win.webContents.send('notch-hover', inside);
    } catch {
      // A dropped poll is harmless; the next one corrects it.
    }
  }, 90);
}

function stopHoverWatch() {
  if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = null; }
  pointerOverNotch = false;
}

function createNotch() {`
  );

  m = m.replace(
    "  ipcMain.on('voiceos:request-idle', () => idleNotch());",
    `  ipcMain.on('voiceos:request-idle', () => idleNotch());

  ipcMain.on('voiceos:hit-rects', (_e, rects) => {
    hitRects = Array.isArray(rects) ? rects : [];
  });`
  );

  // Watch while the island is on screen.
  m = m.replace(
    '  positionNotch();\n  // showInactive, never show()',
    '  positionNotch();\n  startHoverWatch();\n  // showInactive, never show()'
  );
  m = m.replace(
    "    globalShortcut.unregisterAll();\n    if (holdToTalk) holdToTalk.shutdown();",
    "    globalShortcut.unregisterAll();\n    stopHoverWatch();\n    if (holdToTalk) holdToTalk.shutdown();"
  );
}

fs.writeFileSync(mp, m);

const checks = {
  'renderer reports rects': n.includes('bridge.setHitRects'),
  'renderer hover handler': n.includes('bridge.onHover'),
  'setInteractive gone': !n.includes('function setInteractive'),
  'preload channels': p.includes('setHitRects') && p.includes('onHover'),
  'main hit testing': m.includes('function startHoverWatch'),
  'main ipc': m.includes("voiceos:hit-rects")
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'ok  ' : 'MISS'} ${k}`);
