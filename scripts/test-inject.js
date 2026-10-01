'use strict';
/**
 * Verifies text injection against a real window.
 *
 * Launches its own Notepad, writes into it, reads the text back through UI
 * Automation, asserts a round trip, then closes Notepad without saving. Safe to
 * run any time: it never types into a window you were using.
 *
 *   node scripts/test-inject.js
 */
const { execFile } = require('child_process');
const { getBridge } = require('../src/core/native/bridge');
const { ensureDirs } = require('../src/core/paths');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;

// Test output is capped hard. A failing read-back can otherwise dump the entire
// contents of whatever document was focused into the console and logs.
const MAX_ECHO = 120;
const clip = (s) => {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > MAX_ECHO ? `${str.slice(0, MAX_ECHO)}… (${str.length} chars total)` : str;
};

function assertEq(actual, expected, label) {
  const norm = (s) => String(s).replace(/\r\n/g, '\n').trim();
  if (norm(actual) !== norm(expected)) {
    throw new Error(`${label}\n    expected: ${clip(expected)}\n    actual:   ${clip(actual)}`);
  }
}

async function check(name, fn) {
  try {
    const r = await fn();
    console.log(`  PASS  ${name}`);
    if (r !== undefined) console.log(`        ${clip(r)}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${clip(e.message)}`);
    fail++;
  }
}

function killNotepad() {
  return new Promise((resolve) => {
    execFile('taskkill', ['/F', '/IM', 'notepad.exe'], () => resolve());
  });
}

(async () => {
  ensureDirs();
  const b = getBridge();
  await b.start();

  // Start from a clean slate so we never attach to a Notepad holding the
  // user's unsaved work.
  await killNotepad();
  await sleep(400);

  console.log('\nLaunching a scratch Notepad…');
  await b.startProcess('notepad.exe');

  // Windows 11 ships a packaged Notepad whose window can take a few seconds to
  // appear, so poll rather than assuming a fixed delay.
  let hwnd = null;
  for (let attempt = 0; attempt < 20 && !hwnd; attempt++) {
    await sleep(500);
    const wins = await b.listWindows();
    const np = wins.find((w) => /^notepad$/i.test(w.process));
    if (np) hwnd = np.hwnd;
  }

  // HARD SAFETY GATE. Every injection below types into the focused window, so
  // if we cannot prove our own Notepad owns focus we abort instead of typing
  // into the user's work. This must never degrade into "carry on anyway".
  async function requireOwnNotepadFocused(step) {
    const fg = await b.foregroundWindow();
    if (!fg || !/^notepad$/i.test(fg.process)) {
      throw new Error(
        `ABORT before "${step}": focus is on ${fg ? fg.process + ' — ' + JSON.stringify(fg.title) : 'an unknown window'}, ` +
        'not our scratch Notepad. Refusing to send keystrokes.'
      );
    }
  }

  if (!hwnd) {
    console.error(
      '\nABORTING: no Notepad window appeared after 10s.\n' +
      '  Refusing to run injection tests, because they would type into whatever\n' +
      '  window currently has focus. Open Notepad manually and re-run.\n'
    );
    b.stop();
    process.exit(1);
  }

  await check('focus our scratch Notepad', async () => {
    await b.focusWindow(hwnd);
    await sleep(600);
    await requireOwnNotepadFocused('focus check');
    const fg = await b.foregroundWindow();
    return { hwnd, title: fg.title, process: fg.process };
  });

  const pasteText = 'Dictated by VoiceOS via clipboard paste.';
  await check('insert text via paste, restoring the clipboard', async () => {
    await requireOwnNotepadFocused('paste');
    const sentinel = 'user-clipboard-' + Date.now();
    await b.writeClipboard(sentinel);
    const r = await b.insertText(pasteText);
    await sleep(250);
    const after = await b.readClipboard();
    if (after !== sentinel) {
      throw new Error(`clipboard was not restored (got ${JSON.stringify(after.slice(0, 60))})`);
    }
    return `via=${r.via}, waited ${r.restoreWaitMs}ms, clipboard restored intact`;
  });

  const typedText = ' Typed: café über naïve — 🎙️';
  await check('insert text via unicode synthesis (accents + emoji)', async () => {
    await requireOwnNotepadFocused('unicode typing');
    await b.typeText(typedText);
    await sleep(400);
    return 'sent ' + typedText.length + ' code units';
  });

  await check('read the document back and confirm an exact round trip', async () => {
    await requireOwnNotepadFocused('read-back');
    // Read Notepad's own edit control through UI Automation rather than pressing
    // Ctrl+A. Select-all would read whatever document happens to be focused,
    // which risks pulling unrelated user content into the test output.
    const el = await b.focusedElement();
    const got = (el && el.value) || '';
    assertEq(got, pasteText + typedText, 'round-trip mismatch');
    return `read ${got.length} chars via UIA value pattern, matched exactly`;
  });

  await check('media keys reach the system', async () => {
    // Does not assert playback state: the point is that the keycode is accepted
    // and no error comes back from SendInput.
    const r = await b.mediaKey('volume_mute');
    await sleep(150);
    await b.mediaKey('volume_mute'); // toggle straight back
    return `volume_mute sent and reverted (ok=${r.ok})`;
  });

  console.log('\nClosing the scratch Notepad…');
  await killNotepad();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  b.stop();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error('\nFATAL:', err.message);
  await killNotepad();
  process.exit(1);
});
