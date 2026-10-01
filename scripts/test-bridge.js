'use strict';
/**
 * Smoke test for the native bridge. Run with: node scripts/test-bridge.js
 *
 * Read-only by default. Pass --inject to also test text insertion, which types
 * into whatever window has focus 3 seconds from now (open Notepad first).
 */
const path = require('path');
const fs = require('fs');
const { getBridge } = require('../src/core/native/bridge');
const { paths, ensureDirs } = require('../src/core/paths');

const wantInject = process.argv.includes('--inject');
let pass = 0;
let fail = 0;

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - t0;
    console.log(`  PASS  ${name}  (${ms}ms)`);
    if (result !== undefined) {
      const s = typeof result === 'string' ? result : JSON.stringify(result);
      console.log(`        ${s.length > 300 ? s.slice(0, 300) + '…' : s}`);
    }
    pass++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    fail++;
  }
}

(async () => {
  ensureDirs();
  const b = getBridge();

  console.log('\nStarting native bridge…');
  const t0 = Date.now();
  await b.start();
  console.log(`Bridge ready in ${Date.now() - t0}ms\n`);

  console.log('Core:');
  await check('ping', async () => (await b.ping()).pong);
  await check('cursor position', () => b.cursorPos());
  await check('foreground window', async () => {
    const w = await b.foregroundWindow();
    return { title: w.title, process: w.process, class: w.class };
  });
  await check('window under cursor', async () => {
    const { x, y } = await b.cursorPos();
    const w = await b.windowAt(x, y);
    return { at: `${x},${y}`, title: w && w.title, process: w && w.process };
  });
  await check('list open windows', async () => {
    const wins = await b.listWindows();
    return `${wins.length} windows: ` + wins.slice(0, 5).map((w) => w.process).join(', ');
  });

  console.log('\nUI Automation:');
  await check('focused element', async () => {
    const el = await b.focusedElement();
    return el ? { name: el.name, controlType: el.controlType } : 'none';
  });
  await check('element under cursor', async () => {
    const { x, y } = await b.cursorPos();
    const el = await b.elementAt(x, y);
    return el ? { name: (el.name || '').slice(0, 80), controlType: el.controlType } : 'none';
  });
  await check('ui tree of foreground window', async () => {
    const { tree } = await b.uiTree({ maxDepth: 2, maxChildren: 5 });
    return { root: tree.name, children: (tree.children || []).length };
  });

  console.log('\nClipboard:');
  await check('round-trip clipboard', async () => {
    const saved = await b.readClipboard();
    const probe = 'voiceos-bridge-probe-' + Date.now();
    await b.writeClipboard(probe);
    const got = await b.readClipboard();
    await b.writeClipboard(saved); // leave the user's clipboard as we found it
    if (got !== probe) throw new Error(`expected ${probe}, got ${JSON.stringify(got)}`);
    return 'clipboard preserved and restored';
  });

  console.log('\nScreen context:');
  const shotPath = path.join(paths.tmp, 'bridge-test.png');
  await check('screenshot full screen', async () => {
    const r = await b.screenshot(shotPath);
    const size = fs.statSync(r.path).size;
    return { bounds: r.bounds, kb: Math.round(size / 1024) };
  });
  await check('OCR that screenshot (Windows.Media.Ocr)', async () => {
    const r = await b.ocr(shotPath);
    const words = (r.text || '').trim().split(/\s+/).filter(Boolean);
    return `${r.lines.length} lines, ${words.length} words. First: ` +
      JSON.stringify((r.lines || []).slice(0, 3));
  });

  console.log('\nMedia (GlobalSystemMediaTransportControlsSessionManager):');
  await check('media status', async () => {
    const r = await b.mediaStatus();
    if (!r.current) return 'nothing playing (expected if no player is open)';
    return { app: r.current.app, title: r.current.title, status: r.current.status };
  });

  console.log('\nApp launching:');
  await check('list installed apps', async () => {
    const r = await b.listApps('', 2000);
    return `${r.apps.length} apps found, e.g. ` + r.apps.slice(0, 4).map((a) => a.name).join(' | ');
  });

  if (wantInject) {
    console.log('\nText injection — focus a text field now, inserting in 3s…');
    await new Promise((r) => setTimeout(r, 3000));
    await check('insert via paste', async () => {
      const saved = await b.readClipboard();
      const r = await b.insertText('VoiceOS paste test. ');
      await b.writeClipboard(saved);
      return r.via;
    });
    await check('insert via unicode typing (incl. emoji)', async () => {
      const r = await b.typeText('Typed directly — café über 🎙️ ');
      return r.ok;
    });
    await check('read back the selection (Ctrl+A then read)', async () => {
      await b.keys('ctrl+a');
      const sel = await b.selection();
      await b.keys('right');
      return { via: sel.via, chars: sel.text.length, text: sel.text.slice(0, 120) };
    });
  } else {
    console.log('\nText injection: skipped (re-run with --inject to test)');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  b.stop();
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
