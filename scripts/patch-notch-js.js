'use strict';
/**
 * Applies the notch renderer changes: typing, replay, and a Found list that
 * labels where an answer came from.
 *
 * Written as a file rather than a shell heredoc because every backslash in a
 * regex or string literal gets eaten on the way through the shell.
 */
const fs = require('fs');

const p = 'src/renderer/notch/notch.js';
let s = fs.readFileSync(p, 'utf8');

// --- element refs ---------------------------------------------------------
s = s.replace(
  "  appBadge: document.getElementById('appBadge'),",
  [
    "  appBadge: document.getElementById('appBadge'),",
    "  compose: document.getElementById('compose'),",
    "  composeInput: document.getElementById('composeInput'),",
    "  send: document.getElementById('send'),",
    "  replay: document.getElementById('replay'),",
    "  foundWrap: document.getElementById('foundWrap'),",
    "  foundLabel: document.getElementById('foundLabel'),"
  ].join('\n')
);

// --- found list -----------------------------------------------------------
// It lives in a wrapper now, with a label naming where the answer came from.
s = s.replace(
  "  el.foundList.innerHTML = '';\n  if (!items.length) { el.foundList.hidden = true; return; }",
  "  el.foundList.innerHTML = '';\n  if (!items.length) { el.foundWrap.hidden = true; return; }"
);
s = s.replace(
  '  el.foundList.hidden = false;\n}',
  '  el.foundWrap.hidden = false;\n}'
);
s = s.replace(
  "  el.foundList.innerHTML = '';\n  el.foundList.hidden = true;",
  "  el.foundList.innerHTML = '';\n  el.foundWrap.hidden = true;"
);

// --- typing ---------------------------------------------------------------
s = s.replace(
  '// --- Pointer passthrough',
  [
    '// --- Typing ---------------------------------------------------------------',
    '// The window is deliberately not focusable, so dictated text lands in the',
    "// user's own field rather than here. Typing needs focus, so it is asked for",
    '// on demand and handed straight back, and the two input paths never fight.',
    '',
    'let composeFocused = false;',
    '',
    'el.composeInput.addEventListener("mousedown", () => {',
    '  bridge.setFocusable(true);',
    '});',
    '',
    'el.composeInput.addEventListener("focus", () => {',
    '  composeFocused = true;',
    '  cancelCollapse();',
    '});',
    '',
    'el.composeInput.addEventListener("blur", () => {',
    '  composeFocused = false;',
    '  bridge.setFocusable(false);',
    '  if (el.stage.dataset.state === "answer") scheduleCollapse();',
    '});',
    '',
    'el.composeInput.addEventListener("input", () => {',
    '  el.send.classList.toggle("is-ready", el.composeInput.value.trim().length > 0);',
    '});',
    '',
    'el.compose.addEventListener("submit", (e) => {',
    '  e.preventDefault();',
    '  const text = el.composeInput.value.trim();',
    '  if (!text) return;',
    '  el.composeInput.value = "";',
    '  el.send.classList.remove("is-ready");',
    '  el.composeInput.blur();',
    '  cancelCollapse();',
    '  clearBody();',
    '  showAsked(text);',
    '  setState("thinking", { hint: "Thinking\\u2026" });',
    '  bridge.ask(text);',
    '});',
    '',
    '// --- Replay ---------------------------------------------------------------',
    '',
    'el.replay.addEventListener("click", async () => {',
    '  if (!currentResult) return;',
    '  const text = currentResult.answer || currentResult.text || "";',
    '  if (!text) return;',
    '  el.replay.classList.add("is-busy");',
    '  cancelCollapse();',
    '  try { await bridge.speak(text); } finally {',
    '    setTimeout(() => el.replay.classList.remove("is-busy"), 1200);',
    '  }',
    '});',
    '',
    '// --- Pointer passthrough'
  ].join('\n')
);

// Escape must give focus back before anything else, or the window keeps it.
s = s.replace(
  "window.addEventListener('keydown', (e) => {\n  if (e.key !== 'Escape') return;",
  [
    "window.addEventListener('keydown', (e) => {",
    "  if (e.key !== 'Escape') return;",
    '  if (composeFocused) {',
    '    el.composeInput.value = "";',
    '    el.composeInput.blur();',
    '    return;',
    '  }'
  ].join('\n')
);

// Typing keeps the window interactive even when the pointer wanders off.
s = s.replace(
  '  setInteractive(overCard || overSheet);',
  '  setInteractive(overCard || overSheet || composeFocused);'
);

// --- speech playback ------------------------------------------------------
// Report failures instead of swallowing them: silent audio is impossible to
// diagnose from the outside.
s = s.replace(
  /bridge\.onSpeak\(\(\{ data \}\) => \{[\s\S]*?\n\}\);/,
  [
    'bridge.onSpeak(({ data }) => {',
    '  if (!data) return;',
    '  if (speaking) { try { speaking.pause(); } catch {} }',
    '  speaking = new Audio("data:audio/wav;base64," + data);',
    '  speaking.play()',
    '    .then(() => bridge.speechStatus({ ok: true }))',
    '    .catch((err) => {',
    '      console.error("[tts] playback blocked: " + err.message);',
    '      bridge.speechStatus({ ok: false, error: err.message });',
    '    });',
    '});'
  ].join('\n')
);

fs.writeFileSync(p, s);

const checks = {
  'compose refs': s.includes("composeInput: document.getElementById('composeInput')"),
  'submit handler': s.includes('bridge.ask(text)'),
  'focus dance': s.includes('bridge.setFocusable(true)'),
  'replay': s.includes('bridge.speak(text)'),
  'found wrapper': s.includes('el.foundWrap.hidden = false'),
  'speech status': s.includes('bridge.speechStatus')
};
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'ok  ' : 'MISS'} ${name}`);
