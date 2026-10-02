'use strict';
/**
 * Guard for tests that synthesize keyboard or mouse input.
 *
 * Synthetic input goes wherever focus happens to be. Twice now a test aimed at
 * a guessed coordinate, missed, and typed into the user's own window. Guessing
 * is the problem, so these helpers refuse to act unless the target has been
 * positively identified as ours first.
 *
 * Rule: never synthesize input without calling one of these.
 */

/**
 * Resolves the on-screen rectangle of an element inside a VoiceOS window.
 *
 * Returns null rather than a guess when the element cannot be found, so the
 * caller must handle "not there" instead of clicking into the void.
 *
 * @param {object} bridge native bridge
 * @param {string} name   accessible name or control type to look for
 */
async function findOurElement(bridge, { name, controlType } = {}) {
  const windows = await bridge.listWindows();
  const ours = windows.filter((w) => /electron/i.test(w.process));
  if (!ours.length) return null;

  for (const win of ours) {
    try {
      const result = await bridge.call('clickElement', { hwnd: win.hwnd, name, controlType, probeOnly: true });
      if (result && result.element && result.element.bounds) return { window: win, element: result.element };
    } catch { /* not in this window */ }
  }
  return null;
}

/**
 * Confirms the point is inside one of our own windows before anything is sent.
 * @returns {Promise<{ok: boolean, reason?: string, window?: object}>}
 */
async function assertOurWindowAt(bridge, x, y) {
  const win = await bridge.windowAt(x, y);
  if (!win) return { ok: false, reason: `nothing resolvable at ${x},${y}` };
  if (!/electron/i.test(win.process)) {
    return { ok: false, reason: `${x},${y} is over ${win.process} ("${win.title}"), not VoiceOS`, window: win };
  }
  return { ok: true, window: win };
}

/**
 * Confirms keyboard focus is inside one of our windows.
 *
 * Use before typing: a click that silently missed leaves focus wherever it was,
 * and the keystrokes follow focus, not the pointer.
 */
async function assertOurFocus(bridge) {
  const fg = await bridge.foregroundWindow();
  if (!fg) return { ok: false, reason: 'no foreground window (an elevated window may be blocking)' };
  if (!/electron/i.test(fg.process)) {
    return { ok: false, reason: `focus is on ${fg.process} ("${fg.title}"), not VoiceOS`, window: fg };
  }
  return { ok: true, window: fg };
}

/** Types only after confirming focus is ours. Throws rather than typing blind. */
async function safeType(bridge, text) {
  const check = await assertOurFocus(bridge);
  if (!check.ok) throw new Error(`REFUSING to type: ${check.reason}`);
  return bridge.typeText(text);
}

/** Presses keys only after confirming focus is ours. */
async function safeKeys(bridge, combo) {
  const check = await assertOurFocus(bridge);
  if (!check.ok) throw new Error(`REFUSING to press ${combo}: ${check.reason}`);
  return bridge.keys(combo);
}

/** Clicks only after confirming the point is inside one of our windows. */
async function safeClick(bridge, x, y) {
  const check = await assertOurWindowAt(bridge, x, y);
  if (!check.ok) throw new Error(`REFUSING to click: ${check.reason}`);
  await bridge.call('setCursorPos', { x, y });
  return bridge.clickElement({ x, y });
}

module.exports = { findOurElement, assertOurWindowAt, assertOurFocus, safeType, safeKeys, safeClick };
