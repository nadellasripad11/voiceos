'use strict';
/**
 * Offering the model only the tools the question could need.
 *
 *   node scripts/test-relevant.js
 *
 * Every request used to carry all 34 tool schemas — about 2,266 tokens before
 * the question itself. Groq's free tier allows 8,000 a minute, so the fourth
 * question in a minute got an HTTP 429, fell back to a local model slower than
 * the 90-second watchdog, and the assistant heard you and never answered.
 *
 * The risk of trimming is the opposite failure: dropping the one tool that was
 * needed, so the model cannot do the thing and says it cannot. That is what
 * most of this file checks — for each kind of question, the tool that must
 * survive.
 */
const { relevantTools, ALWAYS } = require('../src/core/agent/relevant');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

/** Stand-ins shaped like the real registry, so this needs no config. */
const TOOLS = [
  ['browse', 'Use a real web browser like a person: open sites, click, type and read.'],
  ['news', 'Current news headlines, optionally on a topic.'],
  ['weather', 'The weather or forecast, here or in a named place. Temperature, rain or sun.'],
  ['canvas_grades', 'Your grades on Canvas for each course.'],
  ['canvas_assignments', 'Assignments, quizzes and tests due on Canvas.'],
  ['list_events', 'Events on your calendar.'],
  ['create_event', 'Add an event to your calendar.'],
  ['my_day', 'A summary of your day: calendar, coursework and reminders.'],
  ['send_email', 'Write and send an email to someone.'],
  ['list_email', 'Recent messages in your inbox.'],
  ['read_email', 'Read one message in full.'],
  ['play_search', 'Play a named artist, song or album.'],
  ['control_playback', 'Pause, resume, skip or go back a track.'],
  ['now_playing', 'What music is playing right now.'],
  ['set_volume', 'Turn the volume up or down.'],
  ['open_app', 'Open an application on this computer.'],
  ['open_url', 'Open a web page in the browser.'],
  ['list_windows', 'The windows currently open.'],
  ['read_screen', 'Read what is on the screen.'],
  ['search_files', 'Find files on this computer by name.'],
  ['open_file', 'Open a file.'],
  ['take_note', 'Save a note.'],
  ['create_reminder', 'Set a reminder for later.'],
  ['list_reminders', 'Reminders you have set.'],
  ['search_drive', 'Search your Drive documents.'],
  ['list_grades', 'Grades in Google Classroom.'],
  ['list_coursework', 'Coursework due in Google Classroom.'],
  ['show_image', 'Find a picture of something.'],
  ['fetch_page', 'Read a web page at a URL.'],
  ['point_and_ask', 'Look at whatever is under the cursor.'],
  ['search_web', 'Search the web.'],
  ['answer_from_web', 'Answer a general question using the web.'],
  ['do_task', 'Do a piece of written work: an essay, answers, a summary.'],
  ['personal_data', 'Details the user has told you about themselves.'],
  ['canvas_announcements', 'Announcements posted on Canvas.'],
  ['set_timer', 'Start a timer.']
].map(([name, description]) => ({ name, description, parameters: { type: 'object', properties: {} } }));

const names = (list) => list.map((t) => t.name);

(async () => {
  console.log('\nThe tool the question needs always survives:');
  for (const [question, needed] of [
    ['check my grades on canvas', 'canvas_grades'],
    ['what quizzes do I have this week on canvas', 'canvas_assignments'],
    ['what is the weather in georgia tomorrow', 'weather'],
    ['play some drake', 'play_search'],
    ['skip this track', 'control_playback'],
    ['turn the volume up', 'set_volume'],
    ['send an email to maya about the deck', 'send_email'],
    ['what is on my calendar', 'list_events'],
    ['remind me to call mum', 'create_reminder'],
    ['open spotify', 'open_app'],
    ['find the file called taxes', 'search_files'],
    ['what is on my screen', 'read_screen']
  ]) {
    const got = names(relevantTools(question, TOOLS));
    check(`"${question.slice(0, 40)}" keeps ${needed}`, got.includes(needed), got.join(', '));
  }

  console.log('\nThe way out is never removed:');
  {
    for (const question of ['what is the square root of five', 'write me an essay on cancer', 'zzzz qqqq']) {
      const got = names(relevantTools(question, TOOLS));
      const missing = [...ALWAYS].filter((a) => !got.includes(a));
      check(`"${question.slice(0, 32)}" keeps the general-purpose tools`,
        missing.length === 0, `missing ${missing.join(', ')}`);
    }
  }

  console.log('\nIt actually cuts the list:');
  {
    const sizes = [
      'check my grades on canvas',
      'play some drake',
      'what is the weather',
      'write me an essay'
    ].map((q) => relevantTools(q, TOOLS).length);
    check('every question gets far fewer than all of them',
      sizes.every((n) => n < TOOLS.length / 2), JSON.stringify(sizes));
    check('and never an empty list', sizes.every((n) => n >= ALWAYS.size), JSON.stringify(sizes));
  }

  console.log('\nA short list is left alone:');
  {
    const few = TOOLS.slice(0, 8);
    check('nothing to gain below the cap, so nothing is risked',
      relevantTools('anything at all', few).length === few.length);
  }

  console.log('\nThe cap is honoured:');
  {
    // Every word matches something, so this is the worst case for size.
    const got = relevantTools('weather calendar email music file screen grades note reminder', TOOLS, { max: 6 });
    check('at most the cap, plus the ways out',
      got.length <= 6 + ALWAYS.size, `${got.length} tools`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
