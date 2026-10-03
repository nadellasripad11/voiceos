'use strict';
/**
 * Actually playing a named artist, by driving Spotify's web player.
 *
 * The desktop app cannot be made to do this. Its window exposes nothing to UI
 * Automation — Chromium with accessibility off, so the tree is anonymous panes
 * with no Play button to find — and four different key sequences were tried
 * against the real media session and none of them started anything. The
 * Spotify Web API can do it, but its playback endpoints require Premium.
 *
 * The web player is the one route that works on a free account, because the
 * play button is a real element in a page we can reach. Spotify marks its
 * controls with data-testid attributes, which are stable and meant for exactly
 * this kind of addressing:
 *
 *   [data-testid="top-result-card"]        the best match for the search
 *   [data-testid="play-button"]            its play button, aria-label "Play"
 *   [data-testid="control-button-playpause"]  the player bar, "Play" or "Pause"
 *   [data-testid="tracklist-row"]          individual tracks
 *
 * Success is judged by the player bar turning to "Pause", not by the click
 * having been dispatched. A click that lands on nothing is otherwise
 * indistinguishable from one that worked.
 */

const SEARCH_URL = 'https://open.spotify.com/search/';

const SELECTORS = {
  topCard: '[data-testid="top-result-card"]',
  playButton: '[data-testid="play-button"]',
  playPause: '[data-testid="control-button-playpause"]',
  trackRow: '[data-testid="tracklist-row"]'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The player tab, held between requests.
 *
 * Opening one costs 5.7 seconds and loading the player another 2.7, and both
 * are per-tab rather than per-request, so the tab is kept and reused.
 */
let heldPage = null;

/** Reads the player bar: is something playing, and what? */
const NOW_PLAYING_JS = `(() => {
  const bar = document.querySelector('[data-testid="control-button-playpause"]');
  const label = bar ? (bar.getAttribute('aria-label') || '') : '';
  const widget = document.querySelector('[data-testid="now-playing-widget"]');
  const text = widget ? widget.innerText.replace(/\\n+/g, ' — ').trim() : '';
  return JSON.stringify({ playing: /pause/i.test(label), label, text });
})()`;

/** Whether the page is showing a login wall rather than results. */
const LOGGED_OUT_JS = `(() => {
  const t = document.body ? document.body.innerText.slice(0, 1500) : '';
  const hasResults = Boolean(document.querySelector('[data-testid="tracklist-row"], [data-testid="top-result-card"]'));
  return JSON.stringify({ hasResults, wall: /log in to spotify|sign up free/i.test(t) && !hasResults });
})()`;

/**
 * Types into Spotify's own search box.
 *
 * The input is React-controlled: assigning to .value does not tell React
 * anything, so the native setter is called and an input event dispatched,
 * which is what React is listening for. Searching this way stays inside the
 * loaded application instead of reloading it.
 */
const SEARCH_IN_PAGE_JS = (term) => `(() => {
  const input = document.querySelector('[data-testid="search-input"]');
  if (!input) return JSON.stringify({ ok: false });
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(term)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return JSON.stringify({ ok: true });
})()`;

/** What the top result currently is, so a stale one is not clicked. */
const TOP_RESULT_JS = `(() => {
  const card = document.querySelector('[data-testid="top-result-card"]');
  const row = document.querySelector('[data-testid="tracklist-row"]');
  const el = card || row;
  return JSON.stringify({ text: el ? el.innerText.replace(/\\n+/g, ' ').slice(0, 80) : '' });
})()`;

function parse(raw) {
  try { return JSON.parse(typeof raw === 'string' ? raw : (raw && raw.value) || '{}'); }
  catch { return {}; }
}

/**
 * Searches and plays, returning what started.
 *
 * @param {object} opts
 * @param {import('../browser/cdp').BrowserController} opts.browser
 * @param {string} opts.query artist, song or album
 */
async function playOnWeb({ browser, query, logger = console, timeoutMs = 25000 } = {}) {
  const term = String(query || '').trim();
  if (!term) return { ok: false, reason: 'nothing to play' };

  await browser.launch();

  // The held tab if it is still alive, otherwise one tab, opened once.
  let page = heldPage;
  let onSpotify = false;
  if (page) {
    try {
      const where = await page.url();
      onSpotify = typeof where === 'string' && where.includes('open.spotify.com');
    } catch {
      page = null;
      heldPage = null;
    }
  }
  if (!page) {
    const opened = await browser.openOrReuse(SEARCH_URL + encodeURIComponent(term), 'open.spotify.com');
    page = opened.page;
    heldPage = page;
    onSpotify = false;
  }

  const before = parse(await page.evaluate(TOP_RESULT_JS).catch(() => '{}')).text || '';

  if (onSpotify) {
    // Already loaded: search without leaving the page, which skips the
    // reload that was most of the wait.
    const typed = parse(await page.evaluate(SEARCH_IN_PAGE_JS(term)).catch(() => '{}'));
    if (!typed.ok) {
      await page.navigate(SEARCH_URL + encodeURIComponent(term));
      onSpotify = false;
    }
  } else {
    await page.navigate(SEARCH_URL + encodeURIComponent(term));
  }

  // Results are rendered after the fact, so wait for one rather than sleeping.
  try {
    await page.waitForSelector(`${SELECTORS.topCard}, ${SELECTORS.trackRow}`, { timeoutMs: 15000 });
  } catch {
    return { ok: false, reason: 'the search results did not load' };
  }

  // Typing in the page leaves the previous results on screen for a moment, so
  // wait until they are actually for what was asked rather than clicking the
  // last search's top result.
  if (onSpotify && before) {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const now = parse(await page.evaluate(TOP_RESULT_JS).catch(() => '{}')).text || '';
      if (now && now !== before) break;
      await sleep(150);
    }
  }

  const state = parse(await page.evaluate(LOGGED_OUT_JS));
  if (state.wall) {
    return {
      ok: false,
      needsLogin: true,
      reason: 'Spotify needs you to log in once in this browser. After that it plays on its own.'
    };
  }

  // The top result first, falling back to the first track. Both are real
  // buttons; clicking by selector beats clicking by coordinate, which would
  // depend on the window being a particular size.
  const targets = [
    `${SELECTORS.topCard} ${SELECTORS.playButton}`,
    `${SELECTORS.trackRow} ${SELECTORS.playButton}`,
    SELECTORS.playButton
  ];

  let clicked = false;
  for (const selector of targets) {
    try {
      await page.click(selector);
      clicked = true;
      logger.info?.(`[spotify] clicked ${selector}`);
      break;
    } catch (err) {
      logger.debug?.(`[spotify] ${selector}: ${err.message}`);
    }
  }
  if (!clicked) return { ok: false, reason: 'could not find a play button on the page' };

  // Judged by the player, not by the click: a click that lands on nothing
  // looks exactly like one that worked.
  const deadline = Date.now() + Math.min(timeoutMs, 15000);
  let last = {};
  while (Date.now() < deadline) {
    await sleep(400);
    last = parse(await page.evaluate(NOW_PLAYING_JS));
    if (last.playing) {
      return { ok: true, playing: true, track: last.text || term, via: 'web player' };
    }
  }

  return {
    ok: false,
    reason: last.label
      ? `the player did not start (it still says "${last.label}")`
      : 'the player did not start'
  };
}

module.exports = { playOnWeb, SELECTORS };
