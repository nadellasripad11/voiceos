'use strict';
/**
 * Removes control characters a shell heredoc left behind, repo-wide.
 *
 * Writing JavaScript through a heredoc strips backslashes, so `\b` in a regex
 * becomes a literal 0x08 byte. It is invisible in an editor and in grep, and
 * the regex then requires an actual backspace character in the input, so it
 * simply never matches. This is the third time it has cost real debugging
 * time, so this checks everything rather than the one file.
 *
 * Only the known-bad patterns are repaired automatically; anything else is
 * reported for a human to look at, because guessing what a stray byte was
 * meant to be is how you introduce a subtler bug than the one you fixed.
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['src', 'scripts'];
const BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** 0x08 inside a regex literal was a word boundary. */
function repair(text) {
  // \b is the only one that appears in practice, because it is the only
  // regex escape whose letter maps to a control character.
  return text.replace(/\u0008/g, '\\b');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full, out); }
    else if (/\.(js|mjs|json|css|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

let scanned = 0;
let repaired = 0;
const problems = [];

for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    scanned++;
    const text = fs.readFileSync(file, 'utf8');
    const found = text.match(BAD);
    if (!found) continue;

    const others = found.filter((c) => c !== '\u0008');
    const fixed = repair(text);

    if (others.length) {
      problems.push(`${file}: ${others.length} control character(s) that are not 0x08`);
    }
    if (fixed !== text) {
      fs.writeFileSync(file, fixed);
      repaired++;
      const lines = text.split('\n')
        .map((l, i) => (/\u0008/.test(l) ? i + 1 : null))
        .filter(Boolean);
      console.log(`repaired ${file} (lines ${lines.join(', ')})`);
    }
  }
}

console.log(`\nscanned ${scanned} files, repaired ${repaired}`);
if (problems.length) {
  console.log('\nneeds a look:');
  for (const p of problems) console.log('  ' + p);
}
