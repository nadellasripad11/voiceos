'use strict';
/**
 * What the page looks like to an agent.
 *
 * A screenshot is the obvious way to let a model act on a web page and the
 * wrong one here: it costs a vision model, a round trip per step, and the
 * model then has to guess pixel coordinates that change when the window does.
 * The DOM already knows exactly where everything is and what it is called.
 *
 * So the page becomes a short numbered list of the things that can actually be
 * acted on, and the agent answers with a number. Nothing has to be located, and
 * an index refers to one element rather than a point in space that may have
 * moved by the time the click lands.
 *
 * Kept deliberately small. A page has hundreds of nodes and a model given all
 * of them reads none of them: only what is visible, only what is interactive,
 * labelled the way a person would name it, in document order.
 */

/**
 * Runs in the page. Returns the interactive elements and the readable text.
 *
 * Written as one string because it is evaluated in the page, where none of
 * this file's scope exists.
 */
const MAP_PAGE = `(() => {
  const MAX = 80;

  // Offscreen, hidden and zero-sized elements are not actionable, and a model
  // that is offered them will pick one.
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.top > (window.innerHeight || 0) * 3) return false;
    const s = window.getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false;
    return true;
  }

  // What a person would call it, in the order a person would read it from.
  function label(el) {
    const pick = [
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('title'),
      el.getAttribute('alt'),
      el.tagName === 'INPUT' && el.value && el.type !== 'password' ? el.value : '',
      el.innerText,
      el.getAttribute('name')
    ];
    for (const p of pick) {
      const t = (p || '').replace(/\\s+/g, ' ').trim();
      if (t) return t.slice(0, 90);
    }
    return '';
  }

  function kind(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'submit' || t === 'button') return 'button';
      return 'input';
    }
    if (el.isContentEditable) return 'textarea';
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role) return role;
    return 'clickable';
  }

  const selector = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="tab"]',
    '[role="menuitem"]', '[contenteditable="true"]', '[onclick]'
  ].join(',');

  const seen = new Set();
  const items = [];
  for (const el of document.querySelectorAll(selector)) {
    if (items.length >= MAX) break;
    if (!visible(el)) continue;
    if (el.disabled) continue;
    const text = label(el);
    const k = kind(el);
    // An unlabelled control cannot be chosen meaningfully, and a password
    // field is never something to act on.
    if (!text && k !== 'input' && k !== 'textarea') continue;
    if (el.type === 'password') continue;

    const key = k + '|' + text + '|' + Math.round(el.getBoundingClientRect().top);
    if (seen.has(key)) continue;
    seen.add(key);

    el.setAttribute('data-voiceos-ref', String(items.length));
    items.push({
      n: items.length,
      kind: k,
      text,
      value: (el.value && el.type !== 'password') ? String(el.value).slice(0, 40) : undefined,
      checked: (el.type === 'checkbox' || el.type === 'radio') ? Boolean(el.checked) : undefined
    });
  }

  const main = document.querySelector('main, article, [role="main"]') || document.body;
  const text = (main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 2500);

  return JSON.stringify({
    url: location.href,
    title: document.title,
    text,
    items,
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.round(document.body.scrollHeight)
  });
})()`;

/** Clicks the element a number refers to, in the page rather than by position. */
const CLICK_REF = (n) => `(() => {
  const el = document.querySelector('[data-voiceos-ref="${n}"]');
  if (!el) return JSON.stringify({ ok: false, reason: 'that element is no longer on the page' });
  el.scrollIntoView({ block: 'center' });
  el.click();
  return JSON.stringify({ ok: true, clicked: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60) });
})()`;

/**
 * Types into a field.
 *
 * The native setter plus an input event, because a React-controlled field
 * ignores a plain assignment to .value — the same thing that made Spotify's
 * search box look unresponsive.
 */
const TYPE_REF = (n, text) => `(() => {
  const el = document.querySelector('[data-voiceos-ref="${n}"]');
  if (!el) return JSON.stringify({ ok: false, reason: 'that field is no longer on the page' });
  if (el.type === 'password') return JSON.stringify({ ok: false, reason: 'refusing to type into a password field' });
  el.focus();
  const value = ${JSON.stringify(text)};
  if (el.isContentEditable) {
    el.textContent = value;
  } else {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ ok: true });
})()`;

function parse(raw) {
  try { return JSON.parse(typeof raw === 'string' ? raw : (raw && raw.value) || '{}'); }
  catch { return {}; }
}

/** Reads the page as a numbered list of what can be done on it. */
async function mapPage(page) {
  return parse(await page.evaluate(MAP_PAGE));
}

/** The compact form the model sees. Short on purpose: it is paid for per token. */
function describe(map, { maxItems = 40, maxText = 1200 } = {}) {
  const lines = [`URL: ${map.url}`, `TITLE: ${map.title}`];
  if (map.text) lines.push('', 'TEXT:', map.text.slice(0, maxText));
  lines.push('', 'THINGS YOU CAN DO:');
  for (const it of (map.items || []).slice(0, maxItems)) {
    const extra = [
      it.value ? `currently "${it.value}"` : '',
      it.checked === true ? 'checked' : it.checked === false ? 'unchecked' : ''
    ].filter(Boolean).join(', ');
    lines.push(`  [${it.n}] ${it.kind}: ${it.text || '(no label)'}${extra ? ` (${extra})` : ''}`);
  }
  if ((map.items || []).length > maxItems) lines.push(`  …and ${map.items.length - maxItems} more`);
  return lines.join('\n');
}

module.exports = { mapPage, describe, MAP_PAGE, CLICK_REF, TYPE_REF, parse };
