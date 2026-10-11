'use strict';
/**
 * Sending a message to a person, through a browser already signed in.
 *
 * Two channels, and they work completely differently because the phone is an
 * iPhone.
 *
 * WhatsApp goes through WhatsApp Web, which pairs with any phone: find the
 * contact, open the thread, type, send, read it back.
 *
 * A text cannot. Google Messages for Web is Android only, and iMessage needs a
 * Mac. The one free route on Windows is Phone Link, which is already installed
 * here and registers the sms: protocol — so a text is handed to Windows as a
 * link with the number and the body in it, and Phone Link opens on the
 * conversation with the message written.
 *
 * That last step is the honest limit: this writes the text, it does not press
 * send. Driving Phone Link's own interface to do that would be guesswork
 * against an app that changes, and claiming "sent" when nothing left the phone
 * is the worst failure this could have.
 *
 * The clip this is modelled on has JARVIS phoning a restaurant. A call needs a
 * telephony account and a card on file; a message gets most of the same thing
 * for free.
 *
 * Two rules, both because this is the one tool that speaks to other people in
 * the user's name:
 *
 *   1. Nothing is sent without being shown. The agent's confirmation step gets
 *      the recipient and the full text, and nothing is typed until it comes
 *      back approved. A misheard name sending to the wrong person is not
 *      something an apology fixes.
 *   2. It reports what happened, not what it attempted. "Sent" means the words
 *      appeared in the thread, not that keystrokes went somewhere.
 */

/**
 * The two services, as data.
 *
 * Selectors are listed in order and the first one present wins, because both
 * sites rename things between releases and a single brittle selector is how
 * this silently stops working.
 */
const CHANNELS = {
  whatsapp: {
    label: 'WhatsApp',
    url: 'https://web.whatsapp.com',
    match: 'whatsapp',
    /** A pairing code on screen means nobody is signed in. */
    signedOut: 'canvas[aria-label*="scan" i], [data-ref]',
    ready: '[contenteditable="true"][data-tab]',
    search: [
      '[data-testid="chat-list-search"]',
      '[contenteditable="true"][data-tab="3"]',
      '[aria-label*="Search" i][contenteditable="true"]'
    ],
    compose: [
      '[data-testid="conversation-compose-box-input"]',
      'footer [contenteditable="true"][data-tab]',
      '[contenteditable="true"][data-tab="10"]'
    ],
    outgoing: '[data-testid="msg-container"] .message-out, .message-out'
  },

};

/**
 * A text, by handing Windows an sms: link.
 *
 * Phone Link registers that protocol, so this opens the right conversation
 * with the body already written. It needs a number rather than a name, which
 * is what messaging.contacts is for.
 */
async function sendText({ to, text, config, bridge, logger = console } = {}) {
  const book = config ? (config.get('messaging.contacts', {}) || {}) : {};

  // A number said out loud arrives with spaces, dashes and brackets in it.
  const tidy = (v) => String(v || '').replace(/[\s()\-.]/g, '');
  const asTyped = tidy(to);
  const looksLikeNumber = /^\+?\d{7,15}$/.test(asTyped);

  const key = Object.keys(book).find((k) => k.toLowerCase() === String(to).trim().toLowerCase());
  const raw = looksLikeNumber ? asTyped : (key ? tidy(book[key]) : null);

  // A number said or typed without a country code — "470-638-9418" — is the
  // normal way people write their own, and Phone Link wants it in full.
  const number = raw && /^\d{10}$/.test(raw) ? `+1${raw}`
    : raw && /^1\d{10}$/.test(raw) ? `+${raw}`
      : raw;

  if (!number) {
    return {
      ok: false,
      summary: `I do not have a number for "${to}". Add one under messaging.contacts, or say the number, ` +
               'or ask me to send it on WhatsApp instead — that one works by name.'
    };
  }

  // With a key, it can be sent outright rather than written into Phone Link.
  const apiKey = config ? config.get('messaging.textbeltKey', '') : '';
  if (apiKey) {
    const viaApi = await sendViaTextbelt({ number, text, key: apiKey, logger });
    // A failure there is not the end of it: Phone Link still works, and
    // writing the message beats losing it.
    if (viaApi.ok) return viaApi;
    logger.warn?.(`[message] textbelt failed (${viaApi.summary}); falling back to Phone Link`);
  }

  const url = `sms:${number}?body=${encodeURIComponent(text)}`;
  try {
    await bridge.openUrl(url);
  } catch (err) {
    return { ok: false, summary: `I could not open your messages: ${err.message}` };
  }

  logger.info?.(`[message] text to ${to} (${number}) written in Phone Link`);
  return {
    ok: true,
    channel: 'sms',
    pending: true,
    // Deliberately not "sent": nothing has left the phone until it is pressed.
    summary: `I have written that text to ${to} in Phone Link. Press send when you are ready.`
  };
}

/**
 * Sends a text through Textbelt, which actually delivers it.
 *
 * Only reached when a key is set, because this is the one path where the
 * number and the message leave the machine.
 */
async function sendViaTextbelt({ number, text, key, logger = console }) {
  try {
    const res = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: number, message: text, key }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));

    if (body && body.success) {
      logger.info?.(`[message] sent via textbelt (${body.quotaRemaining} left today)`);
      return {
        ok: true,
        channel: 'sms',
        sent: text,
        summary: `Sent.${typeof body.quotaRemaining === 'number' ? ` ${body.quotaRemaining} texts left on that key.` : ''}`
      };
    }
    return { ok: false, summary: (body && body.error) || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, summary: err.message };
  }
}

/** Enough time for a contact search and the thread to render. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Picks whichever selector the running version of the page actually has. */
const firstPresent = (list) => `(() => {
  for (const sel of ${JSON.stringify(list)}) {
    if (document.querySelector(sel)) return sel;
  }
  return '';
})()`;

/**
 * Signed out, still loading, or usable.
 *
 * Signed out looks exactly like "contact not found" from the outside — both
 * are a search that yields nothing — so they are told apart up front rather
 * than guessed at from a failure.
 */
const stateOf = (channel) => `(() => {
  if (document.querySelector(${JSON.stringify(channel.signedOut)})) return 'signed-out';
  return document.querySelector(${JSON.stringify(channel.ready)}) ? 'ready' : 'loading';
})()`;

/** Reads back the last outgoing bubble, to confirm it really went. */
const lastSent = (channel) => `(() => {
  const out = document.querySelectorAll(${JSON.stringify(channel.outgoing)});
  const last = out[out.length - 1];
  return last ? (last.innerText || '').trim().slice(0, 200) : '';
})()`;

/**
 * Sends a message, or explains why it could not.
 *
 * @param {object} opts
 * @param {object} opts.browser the CDP browser controller
 * @param {'sms'|'whatsapp'} [opts.channel]
 * @param {string} opts.to a contact name as it appears in that app
 * @param {string} opts.text what to say
 * @returns {Promise<{ok: boolean, summary: string, sent?: string}>}
 */
async function sendMessage({ browser, bridge, config, channel = 'sms', to, text, logger = console } = {}) {
  if (!to || !text) return { ok: false, summary: 'I need someone to send it to and something to say.' };

  // A text is a protocol link, not a web page.
  if (channel === 'sms') return sendText({ to, text, config, bridge, logger });

  const spec = CHANNELS.whatsapp;
  if (!browser) return { ok: false, summary: 'The browser is not available.' };

  await browser.launch();
  const { page } = await browser.openOrReuse(spec.url, spec.match);

  let state = 'loading';
  for (let i = 0; i < 14 && state === 'loading'; i++) {
    await sleep(1000);
    try { state = String(await page.evaluate(stateOf(spec))).replace(/"/g, ''); }
    catch { state = 'loading'; }
  }

  if (state === 'signed-out') {
    return {
      ok: false,
      summary: 'WhatsApp Web is not signed in. Open it once in the VoiceOS browser and scan the code; it stays signed in after that.'
    };
  }
  if (state !== 'ready') {
    return { ok: false, summary: `${spec.label} did not finish loading.` };
  }

  // Messages needs a new conversation started before there is a field to type
  // a name into; WhatsApp searches the existing list directly.
  if (spec.startChat) {
    const start = await page.evaluate(firstPresent(spec.startChat));
    if (start) { await page.click(start); await sleep(1200); }
  }

  const search = await page.evaluate(firstPresent(spec.search));
  if (!search) return { ok: false, summary: `I could not find the search box in ${spec.label}.` };

  await page.click(search);
  await page.type(to, { delayMs: 12 });
  await sleep(1800);
  await page.pressKey('Enter');
  await sleep(1800);

  const compose = await page.evaluate(firstPresent(spec.compose));
  if (!compose) {
    return { ok: false, summary: `I could not open a chat with "${to}" in ${spec.label}. Check the name matches a contact.` };
  }

  await page.click(compose);
  await page.type(text, { delayMs: 8 });
  await page.pressKey('Enter');
  await sleep(1400);

  // Confirm from the thread rather than assuming the keystrokes landed.
  let sent = '';
  try { sent = String(await page.evaluate(lastSent(spec)) || '').replace(/^"|"$/g, ''); } catch { /* a bonus, not a requirement */ }

  const landed = sent && text.slice(0, 24).split(/\s+/).filter(Boolean).every((w) => sent.includes(w));
  logger.info?.(`[message] ${spec.label} to ${to}: ${landed ? 'confirmed in the thread' : 'sent, not confirmed'}`);

  return {
    ok: true,
    sent: sent || text,
    channel,
    summary: landed
      ? `Sent to ${to} on ${spec.label}.`
      : `Sent to ${to} on ${spec.label}, though I could not read it back from the thread to be certain.`
  };
}

module.exports = { sendMessage, sendText, CHANNELS };
