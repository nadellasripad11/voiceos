'use strict';
/**
 * Canvas through the browser you are already logged into.
 *
 * Asking for an access token was the wrong answer to "check my grades". The
 * session already exists in the browser; Canvas's own API accepts it, because
 * a request made from a Canvas page carries the Canvas cookie. So instead of
 * scraping a page or asking for credentials, the page is opened and asked to
 * fetch its own API — which gives structured data, in one request, with
 * nothing to configure.
 *
 * The school's address is worked out rather than asked for: an open tab if
 * there is one, otherwise the Chrome history, scanned as bytes for that one
 * domain pattern and nothing else.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** Hosts seen in the browser's own history. Read-only, one pattern only. */
function hostsFromHistory() {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  const counts = new Map();
  let profiles = [];
  try { profiles = fs.readdirSync(base).filter((d) => /^(Default|Profile \d+)$/.test(d)); } catch { return []; }

  for (const profile of profiles) {
    const file = path.join(base, profile, 'History');
    if (!fs.existsSync(file)) continue;
    let buf;
    // Locked while Chrome is running on some systems; that is not an error.
    try { buf = fs.readFileSync(file); } catch { continue; }
    // Scanned as text for one pattern. Nothing else is taken from the file.
    for (const m of buf.toString('latin1').matchAll(/https?:\/\/([a-z0-9-]+\.instructure\.com)/gi)) {
      const host = m[1].toLowerCase();
      counts.set(host, (counts.get(host) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([host]) => host);
}

/**
 * The school's Canvas address.
 *
 * Settings first, so a wrong guess can always be overridden; then anything
 * open; then what the browser has been to most often.
 */
async function findHost(ctx) {
  const configured = ctx.config.get('canvas.host', null);
  if (configured) return String(configured).replace(/^https?:\/\//, '').replace(/\/+$/, '');

  if (ctx.browser) {
    try {
      const targets = await ctx.browser.targets();
      const open = targets.map((t) => /https?:\/\/([a-z0-9-]+\.instructure\.com)/i.exec(t.url || ''))
        .filter(Boolean)[0];
      if (open) return open[1].toLowerCase();
    } catch { /* the browser may not be up yet */ }
  }

  const seen = hostsFromHistory();
  if (seen.length) {
    // Remembered, so the history is read once rather than on every question.
    ctx.config.set('canvas.host', seen[0]);
    ctx.logger.info?.(`[canvas] using ${seen[0]} (from the browser's history)`);
    return seen[0];
  }
  return null;
}

/**
 * Canvas's own API, fetched from a Canvas page so the session cookie applies.
 *
 * Returns { ok, status, data } rather than throwing, because "you are logged
 * out" is an answer the caller needs to act on rather than an error.
 */
const FETCH_API = (pathAndQuery) => `(async () => {
  try {
    const res = await fetch(${JSON.stringify(pathAndQuery)}, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    const text = await res.text();
    // Canvas prefixes its JSON to make it unusable as a script.
    const clean = text.replace(/^while\\(1\\);/, '');
    return JSON.stringify({ ok: res.ok, status: res.status, body: clean.slice(0, 200000) });
  } catch (e) {
    return JSON.stringify({ ok: false, status: 0, error: String(e.message) });
  }
})()`;

function parse(raw) {
  try { return JSON.parse(typeof raw === 'string' ? raw : (raw && raw.value) || '{}'); }
  catch { return {}; }
}

/** Opens Canvas and confirms the session is live. */
async function openCanvas(ctx, host) {
  await ctx.browser.launch();
  const { page } = await ctx.browser.openOrReuse(`https://${host}/`, 'instructure.com');

  const url = await page.url().catch(() => '');
  if (!String(url).includes(host)) await page.navigate(`https://${host}/`);

  const where = String(await page.url().catch(() => ''));

  // The only reliable test is whether we actually ended up on Canvas. Schools
  // put their sign-in behind their own domain — this one lands on
  // fultonschoolsorg.finalsite.com/.../canvas-login — so matching URL patterns
  // like "/login" misses them: that page says "canvas-login", with a hyphen,
  // and a request to /api/v1/... on the school's website is a 404, not a
  // rejection. If the origin is not the Canvas host, there is no session.
  let origin = '';
  try { origin = String(where ? new URL(where).host : ''); } catch { origin = ''; }
  if (!origin || origin.toLowerCase() !== host.toLowerCase()) {
    return { page, loggedIn: false, url: where, landedOn: origin };
  }
  return { page, loggedIn: true, url: where };
}

/** Grades for every active course, from the enrollments endpoint. */
async function readGrades(ctx) {
  const host = await findHost(ctx);
  if (!host) {
    return {
      ok: true,
      summary: 'I could not work out your school\'s Canvas address. Open Canvas once in the browser and ask again, or set canvas.host in settings.',
      spoken: 'I do not know your school\'s Canvas address yet.'
    };
  }
  if (!ctx.browser) return { ok: false, summary: 'No browser available.' };

  const { page, loggedIn } = await openCanvas(ctx, host);
  if (!loggedIn) {
    return {
      ok: true,
      needsLogin: true,
      summary: `Log into Canvas once in the browser I opened (${host}). After that I can read your grades whenever you ask.`,
      spoken: 'Log into Canvas once in the browser I opened, then ask me again.'
    };
  }

  const [enrollRaw, courseRaw] = await Promise.all([
    page.evaluate(FETCH_API('/api/v1/users/self/enrollments?state[]=active&per_page=100')),
    page.evaluate(FETCH_API('/api/v1/courses?enrollment_state=active&per_page=100'))
  ]);

  const enroll = parse(enrollRaw);
  const courses = parse(courseRaw);
  if (!enroll.ok) {
    return { ok: false, summary: `Canvas returned HTTP ${enroll.status} for your enrolments.` };
  }

  let enrollments = [];
  let courseList = [];
  try { enrollments = JSON.parse(enroll.body || '[]'); } catch { /* not JSON */ }
  try { courseList = JSON.parse(courses.body || '[]'); } catch { /* not JSON */ }

  const nameOf = new Map((courseList || []).map((c) => [c.id, c.name]));
  const graded = (enrollments || [])
    .filter((e) => e.type === 'StudentEnrollment' && e.grades)
    .map((e) => ({
      course: nameOf.get(e.course_id) || `Course ${e.course_id}`,
      score: e.grades.current_score,
      letter: e.grades.current_grade
    }))
    .filter((g) => g.score != null);

  if (!graded.length) {
    return {
      ok: true,
      summary: `Canvas (${host}): nothing graded yet in your active courses.`,
      spoken: 'Nothing is graded yet in Canvas.'
    };
  }

  graded.sort((a, b) => a.score - b.score);
  const average = Math.round((graded.reduce((n, g) => n + g.score, 0) / graded.length) * 10) / 10;
  const lowest = graded[0];

  return {
    ok: true,
    // Named, so it can never be mistaken for another system's marks.
    summary: 'Canvas\n' + graded
      .map((g) => `${g.course}: ${g.score}%${g.letter ? ` (${g.letter})` : ''}`)
      .join('\n'),
    spoken: graded.length === 1
      ? `${Math.round(lowest.score)} percent in ${lowest.course}.`
      : `Averaging ${average} percent. Lowest is ${lowest.course} at ${Math.round(lowest.score)}.`,
    found: graded.map((g) => ({
      icon: 'canvas.webp',
      title: `${g.course} — ${g.score}%${g.letter ? ` (${g.letter})` : ''}`,
      subtitle: 'Canvas'
    }))
  };
}

/** What is still to hand in, from the student's own todo list. */
async function readAssignments(ctx, { limit = 10 } = {}) {
  const host = await findHost(ctx);
  if (!host) {
    return {
      ok: true,
      summary: 'I do not know your school\'s Canvas address. Open Canvas once in the browser and ask again.',
      spoken: 'I do not know your Canvas address yet.'
    };
  }
  if (!ctx.browser) return { ok: false, summary: 'No browser available.' };

  const { page, loggedIn } = await openCanvas(ctx, host);
  if (!loggedIn) {
    return {
      ok: true,
      needsLogin: true,
      summary: `Log into Canvas once in the browser I opened (${host}).`,
      spoken: 'Log into Canvas once in the browser I opened, then ask me again.'
    };
  }

  const raw = parse(await page.evaluate(FETCH_API('/api/v1/users/self/todo?per_page=50')));
  let todo = [];
  try { todo = JSON.parse(raw.body || '[]'); } catch { /* not JSON */ }

  const items = (Array.isArray(todo) ? todo : [])
    .filter((t) => t.assignment)
    .map((t) => ({
      title: t.assignment.name,
      course: t.context_name || '',
      due: t.assignment.due_at ? new Date(t.assignment.due_at) : null,
      url: t.html_url
    }));

  if (!items.length) {
    return { ok: true, summary: 'Canvas: nothing outstanding.', spoken: 'Nothing due in Canvas.' };
  }

  items.sort((a, b) => (a.due && b.due ? a.due - b.due : a.due ? -1 : 1));
  const now = new Date();
  const describe = (i) => (i.due ? `${i.due < now ? 'OVERDUE' : 'Due'} ${i.due.toLocaleString()}` : 'No due date');
  const next = items[0];

  return {
    ok: true,
    summary: 'Canvas\n' + items.slice(0, limit)
      .map((i) => `${i.title}${i.course ? ` (${i.course})` : ''} — ${describe(i)}`).join('\n'),
    spoken: `${items.length} due in Canvas. Next, ${next.title}` +
      (next.due ? ` ${next.due.toLocaleDateString(undefined, { weekday: 'long' })}.` : '.'),
    found: items.slice(0, limit).map((i) => ({
      icon: 'canvas.webp',
      title: i.title,
      subtitle: [i.course, describe(i)].filter(Boolean).join(' · '),
      url: i.url
    }))
  };
}

module.exports = { readGrades, readAssignments, findHost, hostsFromHistory };
