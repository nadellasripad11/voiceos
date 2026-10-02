'use strict';
/**
 * Adds a real mouse click to the native bridge.
 *
 * The only click available until now went through UI Automation's Invoke,
 * which resolves the element under a point. That cannot reach a click-through
 * overlay: the point resolves to whatever sits beneath it. A synthesized
 * mouse event goes to whatever is actually on top, which is what both the
 * agent and the tests need.
 */
const fs = require('fs');

// --- bridge.ps1 -----------------------------------------------------------
const psPath = 'src/core/native/bridge.ps1';
let ps = fs.readFileSync(psPath, 'utf8');

if (!ps.includes('MouseClick')) {
  // C#: absolute mouse move plus button down/up, in SendInput's 0..65535 space.
  ps = ps.replace(
    '    // Unicode synthesis, one UTF-16 code unit at a time.',
    `    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const int INPUT_MOUSE = 0;

    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);

    static INPUT MouseInput(int dx, int dy, uint flags) {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dx = dx;
        i.u.mi.dy = dy;
        i.u.mi.mouseData = 0;
        i.u.mi.dwFlags = flags;
        i.u.mi.time = 0;
        i.u.mi.dwExtraInfo = IntPtr.Zero;
        return i;
    }

    // A real click at a screen point. SendInput's absolute coordinates are a
    // 0..65535 range across the virtual desktop, not pixels.
    public static uint MouseClick(int x, int y, bool rightButton) {
        int sw = GetSystemMetrics(0);
        int sh = GetSystemMetrics(1);
        int ax = (int)((x * 65535.0) / Math.Max(1, sw - 1));
        int ay = (int)((y * 65535.0) / Math.Max(1, sh - 1));

        uint down = rightButton ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
        uint up = rightButton ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;

        INPUT[] inputs = new INPUT[3];
        inputs[0] = MouseInput(ax, ay, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE);
        inputs[1] = MouseInput(ax, ay, down | MOUSEEVENTF_ABSOLUTE);
        inputs[2] = MouseInput(ax, ay, up | MOUSEEVENTF_ABSOLUTE);
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    // Unicode synthesis, one UTF-16 code unit at a time.`
  );

  // Dispatcher entry.
  ps = ps.replace(
    "    'keyDown' {",
    `    'mouseClick' {
      [void][VOSNative]::MouseClick([int]$req.x, [int]$req.y, [bool]$req.right)
      return @{ ok = $true }
    }

    'keyDown' {`
  );
  fs.writeFileSync(psPath, ps);
}

// --- bridge.js ------------------------------------------------------------
const jsPath = 'src/core/native/bridge.js';
let js = fs.readFileSync(jsPath, 'utf8');
if (!js.includes('mouseClick')) {
  js = js.replace(
    '  keyDown(combo) { return this.call(\'keyDown\', { combo }); }',
    [
      "  /** A real mouse click at a screen point, as opposed to a UIA invoke. */",
      "  mouseClick(x, y, { right = false } = {}) { return this.call('mouseClick', { x, y, right }); }",
      "  keyDown(combo) { return this.call('keyDown', { combo }); }"
    ].join('\n')
  );
  fs.writeFileSync(jsPath, js);
}

console.log('ps MouseClick:', ps.includes('public static uint MouseClick'));
console.log('ps dispatcher:', ps.includes("'mouseClick'"));
console.log('js wrapper:', js.includes('mouseClick(x, y'));
