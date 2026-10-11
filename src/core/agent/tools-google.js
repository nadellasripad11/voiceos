'use strict';
/**
 * Google tools: Gmail, Calendar, Drive and Classroom.
 *
 * All four read their credential through the connection manager, which hands
 * back a refreshed access token, so none of them know anything about OAuth.
 *
 * Anything that sends, creates or changes is marked `mutating` and therefore
 * goes through the confirmation gate before it runs.
 */

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

/** Calls a Google API with the account connected for this app. */
async function api(ctx, appId, url, { method = 'GET', body, headers = {} } = {}) {
  const cred = await ctx.connections.tokenFor(appId);
  if (!cred || !cred.token) {
    const err = new Error('Google is not connected. Open Apps and connect it.');
    err.notConnected = true;
    throw err;
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cred.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const message = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    throw new Error(`Google said: ${message}`);
  }
  return data;
}

/** Pulls a readable body out of Gmail's nested MIME structure. */
function extractBody(payload) {
  if (!payload) return '';
  const decode = (d) => Buffer.from(String(d).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

  if (payload.body && payload.body.data) return decode(payload.body.data);

  for (const part of payload.parts || []) {
    if (part.mimeType === 'text/plain' && part.body && part.body.data) return decode(part.body.data);
  }
  // Fall back to HTML only if there is no plain alternative.
  for (const part of payload.parts || []) {
    if (part.mimeType === 'text/html' && part.body && part.body.data) {
      return decode(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (part.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return '';
}

/** "Jonah from VoiceOS <jonah@x.com>" -> "Jonah from VoiceOS". */
function senderName(from) {
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(String(from || ''));
  return (m ? m[1] : String(from || '')).trim() || 'someone';
}

const header = (message, name) => {
  const h = ((message.payload && message.payload.headers) || [])
    .find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
};

/** RFC 2822 message, base64url encoded, which is what Gmail's send expects. */
function buildRawEmail({ to, subject, body, cc, replyTo, inReplyTo, references }) {
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${subject || ''}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    body || ''
  ].filter((l) => l !== null);

  return Buffer.from(lines.join('\r\n'), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const googleTools = (ctx) => [
  // --- Gmail --------------------------------------------------------------
  {
    name: 'my_day',
    appId: 'system',
    description: 'What the user has on today (calendar, what is due, new mail) or tomorrow (calendar and what is due). Use for "what do I have today", "brief me", "plan tomorrow".',
    parameters: obj({ day: str('"today" (default) or "tomorrow"') }),
    run: async ({ day = 'today' } = {}) => {
      const tomorrow = day === 'tomorrow';
      // The three sections are independent, so they go at once: in sequence
      // this would cost the sum of them and together it costs the slowest.
      const tools = googleTools(ctx);
      const byName = new Map(tools.map((t) => [t.name, t]));
      const safely = async (name, args) => {
        const tool = byName.get(name);
        if (!tool) return null;
        try { return await tool.run(args || {}); } catch (err) {
          ctx.logger.debug?.(`[my_day] ${name}: ${err.message}`);
          return null;
        }
      };

      // Tomorrow's plan has no use for today's unread mail.
      const [events, work, mail] = await Promise.all([
        safely('list_events', { day: tomorrow ? 'tomorrow' : 'today', limit: 10 }),
        safely('list_coursework', { limit: 6 }),
        tomorrow ? null : safely('list_email', { query: 'is:unread in:inbox', limit: 6 })
      ]);

      const sections = [];
      const cards = [];
      const counts = [];
      let headline = null;

      if (events && events.ok) {
        const list = events.found || [];
        sections.push(`CALENDAR\n${events.summary}`);
        cards.push(...list);
        if (list.length) {
          counts.push(`${list.length} on your calendar`);
          // The first thing is said separately: it is the one piece of detail
          // worth hearing rather than reading.
          headline = `First, ${list[0].title}${list[0].subtitle ? ` at ${String(list[0].subtitle).split(' · ')[0]}` : ''}.`;
        } else {
          counts.push('nothing on your calendar');
        }
      }

      if (work && work.ok) {
        const outstanding = work.found || [];
        sections.push(`DUE\n${work.summary}`);
        cards.push(...outstanding);
        counts.push(outstanding.length ? `${outstanding.length} due` : 'nothing due');
      }

      if (mail && mail.ok) {
        const unread = mail.found || [];
        if (unread.length) {
          sections.push(`UNREAD\n${mail.summary}`);
          cards.push(...unread.slice(0, 3));
          counts.push(`${unread.length} unread`);
        } else {
          counts.push('no unread email');
        }
      }

      if (!sections.length) {
        return {
          ok: true,
          summary: 'I could not reach your calendar, classwork or mail. Open Apps to connect an account.',
          spoken: 'I could not reach any of your accounts.'
        };
      }

      // One sentence of counts, then the single detail worth hearing.
      const list = counts.length > 1
        ? `${counts.slice(0, -1).join(', ')} and ${counts[counts.length - 1]}`
        : counts[0] || '';
      const spoken = [
        list ? `${tomorrow ? 'Tomorrow: ' : ''}${list}.` : tomorrow ? 'Tomorrow looks clear.' : 'Your day looks clear.',
        headline
      ].filter(Boolean).join(' ');

      return { ok: true, summary: sections.join('\n\n'), spoken, found: cards.slice(0, 8) };
    }
  },
  {
    name: 'list_email',
    appId: 'gmail',
    description: 'List recent emails. Use for "what\'s in my inbox", "any new email", "unread mail".',
    parameters: obj({
      query: str('Gmail search, e.g. "is:unread" or "from:david"'),
      limit: num('How many, default 8')
    }),
    run: async ({ query = 'in:inbox', limit = 8 } = {}) => {
      const list = await api(ctx, 'gmail',
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.min(20, limit)}&q=${encodeURIComponent(query)}`);
      const ids = (list.messages || []).map((m) => m.id);
      if (!ids.length) return { ok: true, summary: 'No matching email.' };

      const messages = await Promise.all(ids.map((id) =>
        api(ctx, 'gmail',
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));

      // What is spoken is deliberately not what is shown: reading eight
      // senders and subjects aloud is slow to synthesize and tedious to hear.
      const newest = messages[0];
      const spoken = messages.length === 1
        ? `One message, from ${senderName(header(newest, 'From'))}.`
        : `${messages.length} messages, latest from ${senderName(header(newest, 'From'))}.`;

      return {
        ok: true,
        spoken,
        summary: messages.map((m, i) =>
          `${i + 1}. ${header(m, 'From')} — ${header(m, 'Subject') || '(no subject)'}`).join('\n'),
        found: messages.map((m) => ({
          icon: 'gmail.webp',
          title: header(m, 'Subject') || '(no subject)',
          subtitle: `${header(m, 'From')} · ${m.snippet ? m.snippet.slice(0, 70) : ''}`
        }))
      };
    }
  },
  {
    name: 'read_email',
    appId: 'gmail',
    description: 'Read the full text of an email matching a search.',
    parameters: obj({ query: str('Who or what to find, e.g. "from David about the roadmap"') }, ['query']),
    run: async ({ query }) => {
      const list = await api(ctx, 'gmail',
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=${encodeURIComponent(query)}`);
      if (!list.messages || !list.messages.length) {
        return { ok: true, summary: `No email matching "${query}".` };
      }
      const m = await api(ctx, 'gmail',
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${list.messages[0].id}?format=full`);
      const body = extractBody(m.payload).slice(0, 4000);
      return {
        ok: true,
        summary: `From ${header(m, 'From')}\nSubject: ${header(m, 'Subject')}\n\n${body}`,
        found: [{ icon: 'gmail.webp', title: header(m, 'Subject') || '(no subject)', subtitle: header(m, 'From') }]
      };
    }
  },
  {
    name: 'send_email',
    appId: 'gmail',
    description: 'Send an email.',
    parameters: obj({
      to: str('Recipient address'),
      subject: str('Subject line'),
      body: str('The message')
    }, ['to', 'body']),
    mutating: true,
    confirm: (args) => ({
      app: 'Gmail',
      icon: 'gmail.webp',
      title: 'Send this message?',
      verb: 'Send',
      editable: true,
      rows: {
        'To:': args.to,
        'Subject:': args.subject || '(no subject)',
        'Message:': String(args.body || '').slice(0, 220)
      }
    }),
    run: async ({ to, subject, body }) => {
      const raw = buildRawEmail({ to, subject, body });
      const sent = await api(ctx, 'gmail',
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        { method: 'POST', body: { raw } });
      return {
        ok: true,
        summary: `Sent to ${to}.`,
        found: [{ icon: 'gmail.webp', title: subject || '(no subject)', subtitle: `Sent to ${to}` }],
        id: sent.id
      };
    }
  },

  // --- Calendar -----------------------------------------------------------
  {
    name: 'list_events',
    appId: 'google-calendar',
    description: 'See what is on the calendar. Use for "what\'s on today", "am I free tomorrow", "next meeting".',
    parameters: obj({
      day: str('"today" or "tomorrow", for one calendar day'),
      days: num('Otherwise, how many days ahead, default 1'),
      limit: num('Max events, default 10')
    }),
    run: async ({ day = null, days = 1, limit = 10 } = {}) => {
      // A named day is that calendar day. "Today" used to mean the next 24
      // hours, so tonight's question about today listed tomorrow morning.
      const now = new Date();
      const midnight = (offset) => { const d = new Date(now); d.setHours(24 * offset, 0, 0, 0); return d; };
      const start = day === 'tomorrow' ? midnight(1) : now;
      const end = day === 'tomorrow' ? midnight(2) : day === 'today' ? midnight(1)
        : new Date(now.getTime() + Math.max(1, days) * 86400000);
      const data = await api(ctx, 'google-calendar',
        'https://www.googleapis.com/calendar/v3/calendars/primary/events' +
        `?timeMin=${start.toISOString()}&timeMax=${end.toISOString()}` +
        `&singleEvents=true&orderBy=startTime&maxResults=${Math.min(25, limit)}`);

      const events = data.items || [];
      if (!events.length) {
        const empty = day === 'tomorrow' ? 'Nothing on your calendar tomorrow.'
          : day === 'today' || days <= 1 ? 'Nothing on your calendar today.' : `Nothing in the next ${days} days.`;
        return { ok: true, summary: empty, spoken: empty };
      }

      const when = (e) => {
        const start = e.start.dateTime || e.start.date;
        if (e.start.date) return 'All day';
        return new Date(start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      };

      const spoken = events.length === 1
        ? `${events[0].summary || 'One event'} at ${when(events[0])}.`
        : `${events.length} events. First, ${events[0].summary || 'untitled'} at ${when(events[0])}.`;

      return {
        ok: true,
        spoken,
        summary: events.map((e) => `${when(e)} — ${e.summary || '(no title)'}`).join('\n'),
        found: events.map((e) => ({
          icon: 'google-calendar.png',
          title: e.summary || '(no title)',
          subtitle: [when(e), e.location].filter(Boolean).join(' · ')
        }))
      };
    }
  },
  {
    name: 'create_event',
    appId: 'google-calendar',
    description: 'Put something on the calendar.',
    parameters: obj({
      title: str('What it is'),
      start: str('ISO start time'),
      durationMinutes: num('How long, default 30'),
      location: str('Optional location')
    }, ['title', 'start']),
    mutating: true,
    confirm: (args) => ({
      app: 'Google Calendar',
      icon: 'google-calendar.png',
      title: 'Add this to your calendar?',
      verb: 'Add',
      rows: {
        'Event:': args.title,
        'When:': new Date(args.start).toLocaleString(),
        'For:': `${args.durationMinutes || 30} minutes`
      }
    }),
    run: async ({ title, start, durationMinutes = 30, location }) => {
      const from = new Date(start);
      const to = new Date(from.getTime() + durationMinutes * 60000);
      const created = await api(ctx, 'google-calendar',
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {
          method: 'POST',
          body: {
            summary: title,
            location,
            start: { dateTime: from.toISOString() },
            end: { dateTime: to.toISOString() }
          }
        });
      return {
        ok: true,
        summary: `Added "${title}" on ${from.toLocaleString()}.`,
        found: [{ icon: 'google-calendar.png', title, subtitle: from.toLocaleString() }],
        link: created.htmlLink
      };
    }
  },

  // --- Drive --------------------------------------------------------------
  {
    name: 'search_drive',
    appId: 'google-drive',
    description: 'Find a file in Google Drive.',
    parameters: obj({ query: str('What to look for'), limit: num('Max results, default 8') }, ['query']),
    run: async ({ query, limit = 8 }) => {
      const q = `name contains '${String(query).replace(/'/g, "\\'")}' and trashed = false`;
      const data = await api(ctx, 'google-drive',
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}` +
        `&pageSize=${Math.min(20, limit)}&fields=files(id,name,mimeType,modifiedTime,webViewLink)`);
      const files = data.files || [];
      if (!files.length) return { ok: true, summary: `Nothing in Drive matching "${query}".` };
      return {
        ok: true,
        summary: `Found ${files.length} file${files.length === 1 ? '' : 's'}: ` + files.map((f) => f.name).join(', '),
        found: files.map((f) => ({
          icon: 'google-drive.webp',
          title: f.name,
          subtitle: new Date(f.modifiedTime).toLocaleDateString()
        }))
      };
    }
  },

  // --- Classroom ----------------------------------------------------------
  {
    name: 'list_grades',
    appId: 'google-classroom',
    description: 'The user\'s own grades, marks or GPA for their classes.',
    parameters: obj({ limit: num('Max assignments to list, default 8') }),
    run: async ({ limit = 8 } = {}) => {
      const courses = await api(ctx, 'google-classroom',
        'https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&pageSize=20');
      const active = courses.courses || [];
      if (!active.length) return { ok: true, summary: 'No active classes.', spoken: 'You have no active classes.' };

      const lines = [];
      const cards = [];
      let totalGot = 0;
      let totalPossible = 0;
      let gradedCount = 0;

      for (const course of active) {
        const work = await api(ctx, 'google-classroom',
          `https://classroom.googleapis.com/v1/courses/${course.id}/courseWork?pageSize=100`).catch(() => ({}));
        const items = work.courseWork || [];
        if (!items.length) continue;

        const maxBy = new Map(items.map((w) => [w.id, w.maxPoints]));
        const titleBy = new Map(items.map((w) => [w.id, w.title]));

        const subs = await api(ctx, 'google-classroom',
          `https://classroom.googleapis.com/v1/courses/${course.id}/courseWork/-/studentSubmissions?pageSize=200`)
          .catch(() => ({}));

        let got = 0;
        let possible = 0;
        let graded = 0;
        const perItem = [];

        for (const s of subs.studentSubmissions || []) {
          const max = maxBy.get(s.courseWorkId);
          if (s.assignedGrade == null || max == null) continue;
          graded++;
          got += s.assignedGrade;
          possible += max;
          perItem.push({ title: titleBy.get(s.courseWorkId) || 'Assignment', grade: s.assignedGrade, max });
        }

        if (!graded) {
          lines.push(`${course.name}: nothing graded yet.`);
          continue;
        }

        totalGot += got;
        totalPossible += possible;
        gradedCount += graded;

        const pct = Math.round((got / possible) * 1000) / 10;
        lines.push(`${course.name}: ${pct}% (${got} of ${possible} across ${graded} assignment${graded === 1 ? '' : 's'})`);
        cards.push({ glyph: '\u{1F393}', title: `${course.name} — ${pct}%`, subtitle: `${got}/${possible} over ${graded} graded` });

        // The ones that lost marks are the interesting ones.
        for (const it of perItem.filter((x) => x.grade < x.max).slice(0, limit)) {
          lines.push(`   ${it.title}: ${it.grade}/${it.max}`);
        }
      }

      if (!gradedCount) {
        return {
          ok: true,
          summary: `Nothing is graded yet in ${active.map((c) => c.name).join(', ')}.`,
          spoken: 'Nothing has been graded yet.'
        };
      }

      const overall = Math.round((totalGot / totalPossible) * 1000) / 10;
      return {
        ok: true,
        // Named, because the user may well have meant a different system.
        summary: 'Google Classroom\n' + lines.join('\n'),
        spoken: active.length === 1
          ? `You're on ${overall} percent.`
          : `Overall ${overall} percent across ${active.length} classes.`,
        found: cards
      };
    }
  },
  {
    name: 'list_coursework',
    appId: 'google-classroom',
    description: 'What is due for school. Use for "what homework do I have", "what\'s due this week".',
    parameters: obj({ limit: num('Max items, default 10') }),
    run: async ({ limit = 10 } = {}) => {
      const courses = await api(ctx, 'google-classroom',
        'https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&pageSize=20');
      const active = courses.courses || [];
      if (!active.length) return { ok: true, summary: 'No active classes.', spoken: 'You have no active classes.' };

      const now = new Date();
      const outstanding = [];
      let total = 0;
      let doneCount = 0;

      for (const course of active) {
        const work = await api(ctx, 'google-classroom',
          `https://classroom.googleapis.com/v1/courses/${course.id}/courseWork?pageSize=100`)
          .catch(() => ({}));
        const items = work.courseWork || [];
        if (!items.length) continue;

        // What has actually been handed in. Without this, work already turned
        // in was reported as still due, which is worse than useless.
        // courseWork/- means "every assignment in this course" in one call.
        const subs = await api(ctx, 'google-classroom',
          `https://classroom.googleapis.com/v1/courses/${course.id}/courseWork/-/studentSubmissions?pageSize=200`)
          .catch(() => ({}));
        const stateOf = new Map((subs.studentSubmissions || []).map((s) => [s.courseWorkId, s.state]));

        for (const item of items) {
          total++;
          const state = stateOf.get(item.id);
          if (state === 'TURNED_IN' || state === 'RETURNED') { doneCount++; continue; }

          // A due date is optional in Classroom, and in practice most work has
          // none. Skipping undated work meant an assignment that was genuinely
          // outstanding could never appear at all.
          const d = item.dueDate;
          const t = item.dueTime || {};
          const when = d
            ? new Date(Date.UTC(d.year, d.month - 1, d.day, t.hours == null ? 23 : t.hours, t.minutes == null ? 59 : t.minutes))
            : null;

          outstanding.push({
            course: course.name,
            title: item.title,
            link: item.alternateLink,
            when,
            // Overdue and unsubmitted is exactly what a student wants to hear
            // about, so it is reported rather than filtered out as "past".
            overdue: Boolean(when && when < now)
          });
        }
      }

      if (!outstanding.length) {
        // Saying only "nothing due" left the user unable to tell whether it had
        // looked, so what it did find is reported too.
        // Named here too: "nothing due" is exactly the answer someone would
        // act on, and acting on the wrong system's nothing is how a missed
        // deadline happens.
        const detail = 'Google Classroom\n' + (total
          ? `Nothing outstanding. All ${total} assignment${total === 1 ? '' : 's'} ` +
            `in ${active.map((c) => c.name).join(', ')} ${total === 1 ? 'is' : 'are'} turned in.`
          : `No assignments in ${active.map((c) => c.name).join(', ')}.`);
        return {
          ok: true,
          summary: detail,
          spoken: total ? `Nothing due. All ${total} turned in.` : 'No assignments posted.'
        };
      }

      // Soonest first; undated last, since there is nothing to sort them by.
      outstanding.sort((a, b) => {
        if (a.when && b.when) return a.when - b.when;
        if (a.when) return -1;
        if (b.when) return 1;
        return 0;
      });

      const overdue = outstanding.filter((o) => o.overdue);
      const dated = outstanding.filter((o) => o.when && !o.overdue);
      const undated = outstanding.filter((o) => !o.when);

      const parts = [];
      if (overdue.length) parts.push(`${overdue.length} overdue`);
      if (dated.length) parts.push(`${dated.length} coming up`);
      if (undated.length) parts.push(`${undated.length} with no due date`);
      const soonest = dated[0] || overdue[0] || undated[0];
      const spoken = `${parts.join(', ')}. ` +
        (soonest.when
          ? `${soonest.overdue ? 'Overdue' : 'Next'}: ${soonest.title}, ` +
            `${soonest.when.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}.`
          : `Starting with ${soonest.title}.`);

      const describe = (o) =>
        o.when
          ? `${o.overdue ? 'OVERDUE' : 'Due'} ${o.when.toLocaleString()}`
          : 'No due date';

      return {
        ok: true,
        spoken,
        // Named, because the user may well have meant Canvas or another
        // system, and an unlabelled list of someone else's assignments is how
        // a wrong answer comes to look like a right one.
        summary: 'Google Classroom\n' + outstanding.slice(0, limit).map((o) =>
          `${o.title} (${o.course}) — ${describe(o)}`).join('\n'),
        found: outstanding.slice(0, limit).map((o) => ({
          glyph: '\u{1F393}',
          title: `${o.title} — ${o.course}`,
          subtitle: describe(o),
          url: o.link
        }))
      };
    }
  }
];

module.exports = { googleTools, buildRawEmail, extractBody };
