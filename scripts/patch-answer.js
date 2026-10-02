'use strict';
/**
 * Fixes answer formatting and spoken replies.
 *
 * Two problems, one root cause: the answer text was treated as prose.
 *
 * The renderer split only on blank lines, so a list whose items are separated
 * by single newlines collapsed into one run-on paragraph.
 *
 * And speech read that same text out in full, so asking about eight emails
 * meant waiting several seconds for synthesis and then hearing every sender
 * and subject. Tools can now supply a short spoken line separately from what
 * is shown, which is both faster and what a person actually wants to hear.
 */
const fs = require('fs');

// --- renderer: render lines as lines --------------------------------------
const np = 'src/renderer/notch/notch.js';
let n = fs.readFileSync(np, 'utf8');

n = n.replace(
  /function showAnswer\(text\) \{[\s\S]*?\n\}/,
  `function showAnswer(text) {
  // Everything is inserted as text nodes: rendering model or tool output as
  // HTML would be an injection path straight into the overlay.
  el.answerText.innerHTML = '';
  const raw = String(text || '').trim();
  if (!raw) return;

  // Blank lines separate paragraphs; single newlines are still line breaks.
  // Treating the whole thing as prose turned any list into one run-on block.
  for (const block of raw.split(/\\n{2,}/)) {
    const lines = block.split('\\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    // A run of numbered or bulleted lines is a list, so render it as one.
    const numbered = lines.length > 1 && lines.every((l) => /^(\\d+[.)]|[-*\\u2022])\\s/.test(l));
    if (numbered) {
      const list = document.createElement('ol');
      list.className = 'answer-list';
      for (const line of lines) {
        const li = document.createElement('li');
        li.textContent = line.replace(/^(\\d+[.)]|[-*\\u2022])\\s*/, '');
        list.appendChild(li);
      }
      el.answerText.appendChild(list);
      continue;
    }

    const p = document.createElement('p');
    lines.forEach((line, i) => {
      if (i) p.appendChild(document.createElement('br'));
      p.appendChild(document.createTextNode(line));
    });
    el.answerText.appendChild(p);
  }
}`
);

fs.writeFileSync(np, n);

// --- styling for the list -------------------------------------------------
const cp = 'src/renderer/notch/notch.css';
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes('.answer-list')) {
  c = c.replace(
    '.answer p + p { margin-top: 10px; }',
    `.answer p + p { margin-top: 10px; }

/* A list reads as a list: one item per line, numbers aligned, so eight emails
   are scannable instead of being one wall of text. */
.answer-list {
  list-style: decimal;
  margin: 2px 0 0 20px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.answer-list li { padding-left: 2px; }
.answer-list li::marker { color: var(--island-faint); font-size: 13px; }`
  );
  fs.writeFileSync(cp, c);
}

// --- tools: a short spoken line ------------------------------------------
const gp = 'src/core/agent/tools-google.js';
let g = fs.readFileSync(gp, 'utf8');

g = g.replace(
  `      return {
        ok: true,
        summary: messages.map((m, i) =>
          \`\${i + 1}. \${header(m, 'From')} — \${header(m, 'Subject') || '(no subject)'}\`).join('\\n'),`,
  `      // What is spoken is deliberately not what is shown: reading eight
      // senders and subjects aloud is slow to synthesize and tedious to hear.
      const newest = messages[0];
      const spoken = messages.length === 1
        ? \`One message, from \${senderName(header(newest, 'From'))}.\`
        : \`You have \${messages.length} messages. The latest is from \${senderName(header(newest, 'From'))}.\`;

      return {
        ok: true,
        spoken,
        summary: messages.map((m, i) =>
          \`\${i + 1}. \${header(m, 'From')} — \${header(m, 'Subject') || '(no subject)'}\`).join('\\n'),`
);

g = g.replace(
  `      return {
        ok: true,
        summary: events.map((e) => \`\${when(e)} — \${e.summary || '(no title)'}\`).join('\\n'),`,
  `      const spoken = events.length === 1
        ? \`One event: \${events[0].summary || 'untitled'} at \${when(events[0])}.\`
        : \`\${events.length} events. First is \${events[0].summary || 'untitled'} at \${when(events[0])}.\`;

      return {
        ok: true,
        spoken,
        summary: events.map((e) => \`\${when(e)} — \${e.summary || '(no title)'}\`).join('\\n'),`
);

g = g.replace(
  `      return {
        ok: true,
        summary: due.slice(0, limit).map((d) =>
          \`\${d.title} (\${d.course}) — due \${d.when.toLocaleString()}\`).join('\\n'),`,
  `      const soonest = due[0];
      const spoken = \`\${due.length} \${due.length === 1 ? 'thing' : 'things'} due. \` +
        \`Soonest is \${soonest.title}, \${soonest.when.toLocaleDateString(undefined, { weekday: 'long' })}.\`;

      return {
        ok: true,
        spoken,
        summary: due.slice(0, limit).map((d) =>
          \`\${d.title} (\${d.course}) — due \${d.when.toLocaleString()}\`).join('\\n'),`
);

// Helper: a sender's name rather than their raw address.
g = g.replace(
  "const header = (message, name) => {",
  `/** "Jonah from VoiceOS <jonah@x.com>" -> "Jonah from VoiceOS". */
function senderName(from) {
  const m = /^\\s*"?([^"<]+?)"?\\s*</.exec(String(from || ''));
  return (m ? m[1] : String(from || '')).trim() || 'someone';
}

const header = (message, name) => {`
);

fs.writeFileSync(gp, g);

// --- agent: carry the spoken line through --------------------------------
const ap = 'src/core/agent/agent.js';
let a = fs.readFileSync(ap, 'utf8');

a = a.replace(
  `  finish({ question, result, started, model, usedRouter }) {
    const answer = result.summary || (result.ok ? 'Done.' : 'That did not work.');`,
  `  finish({ question, result, started, model, usedRouter }) {
    const answer = result.summary || (result.ok ? 'Done.' : 'That did not work.');
    // A tool may offer a shorter line to read aloud than the one it displays.
    const spoken = result.spoken || null;`
);

a = a.replace(
  `    return {
      question,
      answer,
      found: result.found || [],`,
  `    return {
      question,
      answer,
      spoken,
      found: result.found || [],`
);

fs.writeFileSync(ap, a);

// --- main: prefer the spoken line -----------------------------------------
const mp = 'src/main/main.js';
let m = fs.readFileSync(mp, 'utf8');

m = m.replace(
  'broadcast(\'agent-result\', result);\n        speak(result.answer);',
  "broadcast('agent-result', result);\n        speak(result.spoken || result.answer);"
);
m = m.replace(
  "      broadcast('agent-result', result);\n      speak(result.answer);",
  "      broadcast('agent-result', result);\n      speak(result.spoken || result.answer);"
);

fs.writeFileSync(mp, m);

const checks = {
  'renderer lists': n.includes('answer-list'),
  'list styling': c.includes('.answer-list'),
  'email spoken': g.includes('const spoken = messages.length === 1'),
  'calendar spoken': g.includes('const spoken = events.length === 1'),
  'coursework spoken': g.includes('things\' } due'.replace("'", '')) || g.includes('due. `'),
  'senderName': g.includes('function senderName'),
  'agent carries spoken': a.includes('spoken,'),
  'main prefers spoken': m.includes('result.spoken || result.answer')
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'ok  ' : 'MISS'} ${k}`);
