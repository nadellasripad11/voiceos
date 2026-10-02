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

      return {
        ok: true,
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
      days: num('How many days ahead, default 1'),
      limit: num('Max events, default 10')
    }),
    run: async ({ days = 1, limit = 10 } = {}) => {
      const now = new Date();
      const end = new Date(now.getTime() + Math.max(1, days) * 86400000);
      const data = await api(ctx, 'google-calendar',
        'https://www.googleapis.com/calendar/v3/calendars/primary/events' +
        `?timeMin=${now.toISOString()}&timeMax=${end.toISOString()}` +
        `&singleEvents=true&orderBy=startTime&maxResults=${Math.min(25, limit)}`);

      const events = data.items || [];
      if (!events.length) {
        return { ok: true, summary: days <= 1 ? 'Nothing on your calendar today.' : `Nothing in the next ${days} days.` };
      }

      const when = (e) => {
        const start = e.start.dateTime || e.start.date;
        if (e.start.date) return 'All day';
        return new Date(start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      };

      return {
        ok: true,
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
    name: 'list_coursework',
    appId: 'google-classroom',
    description: 'What is due for school. Use for "what homework do I have", "what\'s due this week".',
    parameters: obj({ limit: num('Max items, default 10') }),
    run: async ({ limit = 10 } = {}) => {
      const courses = await api(ctx, 'google-classroom',
        'https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&pageSize=10');
      const active = courses.courses || [];
      if (!active.length) return { ok: true, summary: 'No active classes.' };

      const due = [];
      for (const course of active) {
        const work = await api(ctx, 'google-classroom',
          `https://classroom.googleapis.com/v1/courses/${course.id}/courseWork?pageSize=${limit}`)
          .catch(() => ({}));
        for (const item of work.courseWork || []) {
          if (!item.dueDate) continue;
          const d = item.dueDate;
          const t = item.dueTime || {};
          const when = new Date(Date.UTC(d.year, d.month - 1, d.day, t.hours || 23, t.minutes || 59));
          // Only what is still ahead; past work is noise when you ask what is due.
          if (when < new Date()) continue;
          due.push({ course: course.name, title: item.title, when });
        }
      }

      if (!due.length) return { ok: true, summary: 'Nothing due that I can see.' };
      due.sort((a, b) => a.when - b.when);

      return {
        ok: true,
        summary: due.slice(0, limit).map((d) =>
          `${d.title} (${d.course}) — due ${d.when.toLocaleString()}`).join('\n'),
        found: due.slice(0, limit).map((d) => ({
          icon: 'canvas.webp',
          title: `${d.title} — ${d.course}`,
          subtitle: `Due ${d.when.toLocaleString()}`
        }))
      };
    }
  }
];

module.exports = { googleTools, buildRawEmail, extractBody };
