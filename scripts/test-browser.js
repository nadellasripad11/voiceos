'use strict';
/**
 * Verifies browser automation end to end: launch, open tabs, navigate, read,
 * type into a real field, and screenshot.
 *
 *   node scripts/test-browser.js
 *
 * Uses the dedicated VoiceOS browser profile, so the user's own Chrome windows,
 * tabs and logins are never touched.
 */
const path = require('path');
const fs = require('fs');
const { getBrowser } = require('../src/core/browser/cdp');
const { paths, ensureDirs } = require('../src/core/paths');

let pass = 0;
let fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`  PASS  ${name}  (${Date.now() - t0}ms)`);
    if (r !== undefined) {
      const s = typeof r === 'string' ? r : JSON.stringify(r);
      console.log(`        ${s.length > 200 ? s.slice(0, 200) + '…' : s}`);
    }
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message}`);
    fail++;
  }
}

(async () => {
  ensureDirs();
  const browser = getBrowser();

  const status = browser.status();
  console.log(`\nBrowser: ${status.exe || 'NONE FOUND'}`);
  console.log(`Profile: ${status.profileDir}\n`);
  if (!status.ready) { console.error('No Chrome or Edge found.'); process.exit(1); }

  console.log('Launch:');
  await check('launch with a debugging port', async () => {
    const t0 = Date.now();
    await browser.launch();
    return `up in ${Date.now() - t0}ms on port ${browser.port}`;
  });

  let page;
  console.log('\nTabs and navigation:');
  await check('open a new tab', async () => {
    page = await browser.newTab('about:blank');
    return `target ${page.id.slice(0, 12)}…`;
  });

  await check('navigate to a real site and read the title', async () => {
    await page.navigate('https://example.com');
    const title = await page.title();
    if (!/example/i.test(title)) throw new Error(`unexpected title: ${title}`);
    return { title, url: await page.url() };
  });

  await check('extract page text', async () => {
    const text = await page.text({ max: 200 });
    if (!text || text.length < 20) throw new Error('page text looked empty');
    return text.replace(/\s+/g, ' ').trim();
  });

  await check('extract links', async () => {
    const links = await page.links({ max: 5 });
    return `${links.length} link(s): ` + links.map((l) => l.text).join(', ');
  });

  await check('list open tabs', async () => {
    const list = await browser.targets();
    return `${list.length} tab(s): ` + list.map((t) => new URL(t.url).hostname || t.url).join(', ');
  });

  console.log('\nTyping into a real form:');
  await check('type character by character into a search field', async () => {
    // DuckDuckGo's HTML endpoint is a plain form: no API key, no JS framework.
    await page.navigate('https://html.duckduckgo.com/html/');
    await page.waitForSelector('input[name="q"]');
    await page.focus('input[name="q"]');
    await page.type('voiceos local whisper', { delayMs: 12 });
    await sleep(250);
    const value = await page.evaluate('document.querySelector(\'input[name="q"]\').value');
    if (value !== 'voiceos local whisper') throw new Error(`field holds ${JSON.stringify(value)}`);
    return `field contains "${value}"`;
  });

  await check('submit and read results', async () => {
    await page.pressKey('Enter');
    await sleep(2500);
    const text = await page.text({ max: 300 });
    return text.replace(/\s+/g, ' ').trim().slice(0, 160);
  });

  await check('fast insertText path', async () => {
    await page.navigate('https://html.duckduckgo.com/html/');
    await page.waitForSelector('input[name="q"]');
    await page.focus('input[name="q"]');
    await page.insertText('pasted all at once');
    await sleep(200);
    return await page.evaluate('document.querySelector(\'input[name="q"]\').value');
  });

  console.log('\nScreenshot:');
  await check('capture the tab', async () => {
    const p = path.join(paths.tmp, 'browser-test.png');
    await page.screenshot(p);
    return `${Math.round(fs.statSync(p).size / 1024)} KB at ${p}`;
  });

  console.log('\nCleanup:');
  await check('close the tab', async () => { await page.close(); return 'closed'; });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  browser.stop();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
