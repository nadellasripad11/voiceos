'use strict';
/**
 * Canvas: the grades the user actually meant.
 *
 * Asking for "my grades on Canvas" was being answered from Google Classroom —
 * a different system, a different course, a different number — and the result
 * was shown with a Canvas logo beside it, which made a wrong answer look like
 * a right one. The rule this file exists to enforce: an answer says where it
 * came from, and a question that names a service is answered by that service
 * or not at all.
 *
 * Canvas exposes a personal access token straight from the user's own account
 * settings, so there is no app to register and nothing to pay for. The host
 * differs per school and is stored with the token.
 */

const { readGrades, readAssignments } = require('./canvas-browser');

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const num = (description) => ({ type: 'number', description });

/** Canvas rejects a page size above 100, and silently truncates without one. */
const PER_PAGE = 100;

async function api(ctx, pathAndQuery, { timeoutMs = 12000 } = {}) {
  const cred = await ctx.connections.tokenFor('canvas');
  if (!cred || !cred.token) {
    const err = new Error('Canvas is not connected.');
    err.notConnected = true;
    throw err;
  }
  const host = String((cred.fields && cred.fields.host) || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!host) {
    const err = new Error('Canvas is connected but its address is missing.');
    err.notConnected = true;
    throw err;
  }

  const url = `https://${host}/api/v1${pathAndQuery}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cred.token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error('Canvas refused that token — it may have expired.');
    err.notConnected = true;
    throw err;
  }
  if (!res.ok) throw new Error(`Canvas returned HTTP ${res.status}`);
  return res.json();
}

/** Whether a Canvas account is connected at all, without making a request. */
async function isConnected(ctx) {
  try {
    const cred = await ctx.connections.tokenFor('canvas');
    return Boolean(cred && cred.token && cred.fields && cred.fields.host);
  } catch {
    return false;
  }
}

/**
 * What to say when Canvas is not connected.
 *
 * Returned rather than thrown: an error becomes "That did not work", which
 * tells the user nothing they can act on. The whole point of this file is
 * that a question about Canvas is answered by Canvas or explained, never
 * quietly answered from somewhere else.
 */
function notConnectedAnswer(what) {
  return {
    ok: true,
    summary:
      `Canvas is not connected, so I cannot see your ${what}. ` +
      'Open Apps, choose Canvas, and paste an access token from ' +
      'Canvas → Account → Settings → New Access Token, along with your school\'s Canvas address.',
    spoken: `Canvas is not connected, so I cannot check your ${what}.`
  };
}

const canvasTools = (ctx) => [
  {
    name: 'canvas_grades',
    appId: 'canvas',
    description: "The user's grades in Canvas. Use when they say Canvas, or for grades when Canvas is connected.",
    parameters: obj({}),
    run: async () => {
      // The browser is already logged in, and Canvas's own API accepts that
      // session — so there is nothing to connect and nothing to paste. A
      // pasted token is still honoured if one exists, but it is no longer
      // the price of asking.
      if (!(await isConnected(ctx)) && ctx.browser) return readGrades(ctx);
      if (!(await isConnected(ctx))) return notConnectedAnswer('grades');

      // Enrollments carry the score per course, so this is one request rather
      // than one per course.
      const [courses, enrollments] = await Promise.all([
        api(ctx, `/courses?enrollment_state=active&per_page=${PER_PAGE}`),
        api(ctx, `/users/self/enrollments?state[]=active&per_page=${PER_PAGE}`)
      ]);

      const nameOf = new Map((courses || []).map((c) => [c.id, c.name]));
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
          summary: 'Canvas: nothing graded yet in your active courses.',
          spoken: 'Nothing is graded yet in Canvas.'
        };
      }

      graded.sort((a, b) => a.score - b.score);
      const average = Math.round((graded.reduce((n, g) => n + g.score, 0) / graded.length) * 10) / 10;
      const lowest = graded[0];

      return {
        ok: true,
        // Named, so it can never again be mistaken for another system's marks.
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
  },

  {
    name: 'canvas_assignments',
    appId: 'canvas',
    description: 'Assignments, quizzes and tests due in Canvas.',
    parameters: obj({ limit: num('Max items, default 10') }),
    run: async ({ limit = 10 } = {}) => {
      if (!(await isConnected(ctx)) && ctx.browser) return readAssignments(ctx, { limit });
      if (!(await isConnected(ctx))) return notConnectedAnswer('assignments');

      // The todo list is what Canvas itself shows the student as outstanding,
      // which is a better answer than every assignment on every course.
      const todo = await api(ctx, '/users/self/todo').catch(() => []);
      const items = (Array.isArray(todo) ? todo : [])
        .filter((t) => t.assignment)
        .map((t) => ({
          title: t.assignment.name,
          course: t.context_name || '',
          due: t.assignment.due_at ? new Date(t.assignment.due_at) : null,
          url: t.html_url
        }));

      if (!items.length) {
        return {
          ok: true,
          summary: 'Canvas: nothing outstanding.',
          spoken: 'Nothing due in Canvas.'
        };
      }

      items.sort((a, b) => {
        if (a.due && b.due) return a.due - b.due;
        return a.due ? -1 : 1;
      });

      const now = new Date();
      const describe = (i) => (i.due
        ? `${i.due < now ? 'OVERDUE' : 'Due'} ${i.due.toLocaleString()}`
        : 'No due date');
      const next = items[0];

      return {
        ok: true,
        summary: 'Canvas\n' + items.slice(0, limit)
          .map((i) => `${i.title}${i.course ? ` (${i.course})` : ''} — ${describe(i)}`)
          .join('\n'),
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
  }
];

module.exports = { canvasTools, isConnected };
