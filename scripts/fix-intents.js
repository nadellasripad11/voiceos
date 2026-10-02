'use strict';
/**
 * Repairs the mail/calendar/school intents.
 *
 * They were written through a shell heredoc that collapsed every `\b` escape
 * into a literal backspace byte (0x08), so the word boundaries became a
 * character that never appears in speech and nothing matched. This rewrites
 * that block from source held here, where no shell can touch it.
 *
 * Safe to re-run: it replaces the block between its two markers.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'src', 'core', 'agent', 'intents.js');
const START = '  // --- Mail, calendar and school';
const END = '  // --- Media';

const BLOCK = [
  '  // --- Mail, calendar and school -------------------------------------------',
  '  {',
  "    re: /\\b(?:check|read|any|new|got|show|what'?s? in)\\b.*\\b(?:e?mails?|inbox)\\b/i,",
  "    tool: 'list_email',",
  "    args: (_m, text) => ({ query: /unread|new/i.test(text) ? 'is:unread' : 'in:inbox' })",
  '  },',
  '  {',
  "    re: /\\bread\\b.*\\be?mail\\b.*\\bfrom\\b\\s+(.+)/i,",
  "    tool: 'read_email',",
  '    args: (m) => ({ query: `from:${m[1].trim()}` })',
  '  },',
  '  {',
  "    re: /\\b(?:on (?:my |the )?calendar|scheduled|my meetings?|my agenda)\\b/i,",
  "    tool: 'list_events',",
  '    args: (_m, text) => ({ days: /week/i.test(text) ? 7 : /tomorrow/i.test(text) ? 2 : 1 })',
  '  },',
  '  {',
  "    re: /\\b(?:am i free|do i have anything|what'?s? (?:on )?today)\\b/i,",
  "    tool: 'list_events',",
  '    args: (_m, text) => ({ days: /tomorrow/i.test(text) ? 2 : 1 })',
  '  },',
  '  {',
  "    re: /\\b(?:due|homework|assignments?|coursework)\\b/i,",
  "    tool: 'list_coursework'",
  '  },',
  '  {',
  "    re: /\\b(?:find|search)\\b.*\\b(?:drive|google drive)\\b|\\bin my drive\\b/i,",
  "    tool: 'search_drive',",
  '    args: (_m, text) => ({',
  "      query: text.replace(/.*\\b(?:find|search)\\b\\s*(?:for\\s*)?/i, '')",
  "        .replace(/\\b(?:in )?(?:my )?(?:google )?drive\\b/i, '').trim()",
  '    })',
  '  },',
  ''
].join('\n');

const raw = fs.readFileSync(FILE, 'utf8');
const start = raw.indexOf(START);
const end = raw.indexOf(END);

if (start === -1 || end === -1) {
  console.error('Could not find the block markers; nothing changed.');
  process.exit(1);
}

const next = raw.slice(0, start) + BLOCK + raw.slice(end);
fs.writeFileSync(FILE, next, 'utf8');

// Prove the repair rather than assuming it.
delete require.cache[require.resolve(FILE)];
const { INTENTS, matchIntent } = require(FILE);

const stray = INTENTS.filter((i) => i.re.source.includes(String.fromCharCode(8)));
console.log(`intents: ${INTENTS.length}, with stray backspace: ${stray.length}`);

const tools = [
  'list_email', 'read_email', 'list_events', 'list_coursework', 'search_drive',
  'now_playing', 'point_and_ask', 'answer_from_web', 'search_web', 'open_app'
].map((name) => ({ name }));

const cases = [
  'check my email',
  'any new email',
  'what is on my calendar today',
  'am I free tomorrow',
  'what homework do I have',
  'what is due this week',
  'find the budget in my drive',
  'what song is this',
  'who is that',
  'who is Ada Lovelace?'
];

for (const c of cases) {
  const hit = matchIntent(c, tools);
  console.log(`  ${(hit ? hit.tool.name : '(model)').padEnd(16)} <- ${c}`);
}
