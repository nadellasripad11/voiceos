'use strict';
/**
 * Stops guessing at the coordinate space.
 *
 * The native bridge and Electron can disagree about pixels: whether the bridge
 * reports physical or device-independent pixels depends on the DPI awareness of
 * the PowerShell host, which is not something to hard-code. Assuming a factor
 * of 2 put clicks off the edge of the screen; assuming 1 would misplace the
 * trail on a scaled display.
 *
 * So it is measured once at startup — the bridge's idea of the screen size
 * against Electron's — and every conversion uses that ratio.
 */
const fs = require('fs');

// --- bridge: report the screen it sees ------------------------------------
const psPath = 'src/core/native/bridge.ps1';
let ps = fs.readFileSync(psPath, 'utf8');
if (!ps.includes("'screenInfo'")) {
  ps = ps.replace(
    "    'getCursorPos' {",
    `    'screenInfo' {
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      return @{
        ok = $true
        x = $vs.Left; y = $vs.Top; width = $vs.Width; height = $vs.Height
      }
    }

    'getCursorPos' {`
  );
  fs.writeFileSync(psPath, ps);
}

const jsPath = 'src/core/native/bridge.js';
let js = fs.readFileSync(jsPath, 'utf8');
if (!js.includes('screenInfo')) {
  js = js.replace(
    '  async cursorPos() {',
    `  /** The screen rectangle as this bridge sees it, for scale detection. */
  screenInfo() { return this.call('screenInfo'); }

  async cursorPos() {`
  );
  fs.writeFileSync(jsPath, js);
}

// --- main: measure once, use everywhere -----------------------------------
const mp = 'src/main/main.js';
let m = fs.readFileSync(mp, 'utf8');

if (!m.includes('bridgeScale')) {
  m = m.replace(
    'function createNotch() {',
    `/**
 * How many bridge pixels there are per Electron pixel.
 *
 * 1 when the bridge reports device-independent pixels, 2 on a 200% display
 * when it reports physical ones. Measured rather than assumed, because it
 * depends on the host's DPI awareness.
 */
let bridgeScale = 1;

async function measureBridgeScale() {
  try {
    const info = await services.bridge.screenInfo();
    const primary = screen.getPrimaryDisplay();
    const ratio = info.width / primary.bounds.width;
    // Snap to a sensible factor; anything else means the displays changed
    // mid-measurement and 1 is the safer reading.
    bridgeScale = [1, 1.25, 1.5, 1.75, 2, 2.5, 3].reduce(
      (best, candidate) => Math.abs(candidate - ratio) < Math.abs(best - ratio) ? candidate : best, 1);
    logger.info(\`[scale] bridge reports \${info.width}x\${info.height}, Electron \${primary.bounds.width}x\${primary.bounds.height} -> scale \${bridgeScale}\`);
  } catch (err) {
    bridgeScale = 1;
    logger.warn(\`[scale] could not measure, assuming 1: \${err.message}\`);
  }
}

/** Bridge coordinates to Electron ones. */
const toElectron = (v) => v / bridgeScale;

function createNotch() {`
  );

  // Measure after the bridge is up.
  m = m.replace(
    "  services.bridge.start()\n    .then(() => logger.info('native bridge ready'))",
    "  services.bridge.start()\n    .then(() => measureBridgeScale())\n    .then(() => logger.info('native bridge ready'))"
  );

  // Keep the measurement honest when displays change.
  m = m.replace(
    '    buildTray();',
    `    screen.on('display-metrics-changed', () => measureBridgeScale());
    screen.on('display-added', () => measureBridgeScale());
    screen.on('display-removed', () => measureBridgeScale());

    buildTray();`
  );
}

// Hover hit testing uses the measured ratio.
m = m.replace(
  `      const bounds = win.getBounds();
      const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
      const scale = display.scaleFactor || 1;

      // The bridge reports physical pixels; window bounds and the reported
      // rectangles are both in device-independent ones.
      const x = pos.x / scale - bounds.x;
      const y = pos.y / scale - bounds.y;`,
  `      const bounds = win.getBounds();

      // Converted with the measured ratio rather than an assumed one.
      const x = toElectron(pos.x) - bounds.x;
      const y = toElectron(pos.y) - bounds.y;`
);

// So does the trail.
m = m.replace(
  `      // The bridge reports physical pixels while the overlay is laid out in
      // device-independent ones. Without this correction the trail lands at a
      // multiple of the right place on any scaled display.
      const scale = display.scaleFactor || 1;
      const x = pos.x / scale - display.bounds.x;
      const y = pos.y / scale - display.bounds.y;`,
  `      // Converted with the measured ratio: assuming one put the trail at a
      // multiple of the right place.
      const x = toElectron(pos.x) - display.bounds.x;
      const y = toElectron(pos.y) - display.bounds.y;`
);

fs.writeFileSync(mp, m);

const checks = {
  'bridge screenInfo': ps.includes("'screenInfo'") && js.includes('screenInfo()'),
  'scale measured': m.includes('async function measureBridgeScale'),
  'hover uses it': m.includes('const x = toElectron(pos.x) - bounds.x'),
  'trail uses it': m.includes('const x = toElectron(pos.x) - display.bounds.x'),
  'remeasure on change': m.includes("display-metrics-changed")
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'ok  ' : 'MISS'} ${k}`);
