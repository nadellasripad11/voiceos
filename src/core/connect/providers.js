'use strict';
/**
 * Connection providers.
 *
 * Four kinds, because the services differ in what they will actually give a
 * desktop app for free:
 *
 *   oauth    a real OAuth 2.0 consent in the user's browser. One Google grant
 *            covers Gmail, Calendar, Drive and Classroom, which is why those
 *            four apps share a provider rather than each holding their own.
 *   token    a personal access token the user pastes once. Cheaper than OAuth
 *            for providers whose tokens do not expire.
 *   browser  no usable free API left, so a signed-in browser session is driven
 *            instead.
 *   local    a folder or executable already on this machine.
 *
 * `apps` lists which App Store entries a provider serves. Connecting the
 * provider connects all of them at once.
 */

const PROVIDERS = {
  // --- OAuth --------------------------------------------------------------
  google: {
    id: 'google',
    kind: 'oauth',
    name: 'Google',
    apps: ['gmail', 'google-calendar', 'google-drive', 'google-classroom'],
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // Requested together so one consent screen serves every Google app. Asking
    // per app would mean four consent screens and four stored grants.
    scopes: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/classroom.courses.readonly',
      'https://www.googleapis.com/auth/classroom.coursework.me',
      'https://www.googleapis.com/auth/classroom.announcements.readonly'
    ],
    extraAuthParams: {
      // offline + consent is the only way Google issues a refresh token, and
      // without one the connection silently dies after an hour.
      access_type: 'offline',
      prompt: 'consent select_account'
    },
    // Several accounts are expected here: personal and school Google accounts
    // are the common case.
    multiAccount: true,
    setup: {
      title: 'Create a free Google OAuth client',
      why: 'Google requires every desktop app to use its own client ID. There is no shared one, and it costs nothing.',
      steps: [
        'Open console.cloud.google.com and create a project (any name).',
        'APIs & Services -> OAuth consent screen -> External -> fill in the app name and your email -> Save.',
        'Under Audience, add your own Google address as a Test user.',
        'APIs & Services -> Library: enable Gmail API, Google Calendar API, Google Drive API and Google Classroom API.',
        'APIs & Services -> Credentials -> Create credentials -> OAuth client ID -> Desktop app.',
        'Copy the Client ID and Client secret and paste them below.'
      ],
      docsUrl: 'https://console.cloud.google.com/apis/credentials',
      needs: ['clientId', 'clientSecret']
    },
    /** Identifies the account the grant belongs to. */
    async identify(accessToken) {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!res.ok) throw new Error(`Google rejected the token (HTTP ${res.status})`);
      const me = await res.json();
      return { accountId: me.sub, label: me.email || me.name, meta: { name: me.name, picture: me.picture } };
    }
  },

  microsoft: {
    id: 'microsoft',
    kind: 'oauth',
    name: 'Microsoft',
    apps: ['outlook', 'onenote'],
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'offline_access',
      'openid',
      'email',
      'profile',
      'Mail.ReadWrite',
      'Mail.Send',
      'Calendars.ReadWrite',
      'Contacts.Read',
      'Notes.ReadWrite'
    ],
    multiAccount: true,
    setup: {
      title: 'Register a free Microsoft app',
      why: 'Microsoft Graph needs an app registration. Free, and a personal Microsoft account works.',
      steps: [
        'Open portal.azure.com -> Microsoft Entra ID -> App registrations -> New registration.',
        'Supported account types: personal Microsoft accounts and organizational directories.',
        'Redirect URI: choose "Public client/native" and enter http://localhost',
        'Copy the Application (client) ID and paste it below. No secret is needed.'
      ],
      docsUrl: 'https://portal.azure.com',
      needs: ['clientId']
    },
    async identify(accessToken) {
      const res = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!res.ok) throw new Error(`Microsoft rejected the token (HTTP ${res.status})`);
      const me = await res.json();
      return {
        accountId: me.id,
        label: me.userPrincipalName || me.mail || me.displayName,
        meta: { name: me.displayName }
      };
    }
  },

  // --- Pasted tokens ------------------------------------------------------
  slack: {
    id: 'slack',
    kind: 'token',
    name: 'Slack',
    apps: ['slack'],
    multiAccount: true,
    setup: {
      title: 'Create a Slack user token',
      why: 'A free Slack app with a user token. Nothing to pay for.',
      steps: [
        'Open api.slack.com/apps -> Create New App -> From scratch, pick your workspace.',
        'OAuth & Permissions -> User Token Scopes: add channels:read, channels:history, chat:write, search:read, users:read, im:read, im:history.',
        'Install to Workspace, then copy the User OAuth Token (starts with xoxp-).'
      ],
      docsUrl: 'https://api.slack.com/apps',
      needs: ['token']
    },
    async identify(token) {
      const res = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const me = await res.json();
      if (!me.ok) throw new Error(me.error || 'Slack rejected that token');
      return { accountId: me.user_id, label: `${me.user} · ${me.team}`, meta: { team: me.team, url: me.url } };
    }
  },

  notion: {
    id: 'notion',
    kind: 'token',
    name: 'Notion',
    apps: ['notion'],
    setup: {
      title: 'Create a Notion integration',
      why: 'A free internal integration token.',
      steps: [
        'Open notion.so/my-integrations -> New integration -> give it a name.',
        'Copy the Internal Integration Secret (starts with ntn_ or secret_).',
        'In Notion, open the pages you want reachable -> ... -> Connections -> add your integration.'
      ],
      docsUrl: 'https://www.notion.so/my-integrations',
      needs: ['token']
    },
    async identify(token) {
      const res = await fetch('https://api.notion.com/v1/users/me', {
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
      });
      if (!res.ok) throw new Error(`Notion rejected that token (HTTP ${res.status})`);
      const me = await res.json();
      return {
        accountId: me.id,
        label: (me.bot && me.bot.workspace_name) || me.name || 'Notion workspace',
        meta: {}
      };
    }
  },

  linear: {
    id: 'linear',
    kind: 'token',
    name: 'Linear',
    apps: ['linear'],
    setup: {
      title: 'Create a Linear API key',
      why: 'A free personal API key.',
      steps: [
        'Open linear.app -> Settings -> Security & access -> Personal API keys -> New key.',
        'Copy the key (starts with lin_api_).'
      ],
      docsUrl: 'https://linear.app/settings/api',
      needs: ['token']
    },
    async identify(token) {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ viewer { id name email } }' })
      });
      const body = await res.json();
      if (!res.ok || body.errors) throw new Error('Linear rejected that key');
      const me = body.data.viewer;
      return { accountId: me.id, label: me.email || me.name, meta: { name: me.name } };
    }
  },

  github: {
    id: 'github',
    kind: 'token',
    name: 'GitHub',
    apps: ['github'],
    setup: {
      title: 'Create a GitHub token',
      why: 'A free fine-grained personal access token.',
      steps: [
        'Open github.com/settings/tokens -> Fine-grained tokens -> Generate new token.',
        'Give it repo access and read/write on Issues, Pull requests and Contents.',
        'Copy the token (starts with github_pat_).'
      ],
      docsUrl: 'https://github.com/settings/tokens',
      needs: ['token']
    },
    async identify(token) {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
      });
      if (!res.ok) throw new Error(`GitHub rejected that token (HTTP ${res.status})`);
      const me = await res.json();
      return { accountId: String(me.id), label: me.login, meta: { name: me.name } };
    }
  },

  canvas: {
    id: 'canvas',
    kind: 'token',
    name: 'Canvas',
    apps: ['canvas'],
    // The host differs per school, so it is collected alongside the token.
    extraFields: [
      { key: 'host', label: 'Canvas address', placeholder: 'yourschool.instructure.com' }
    ],
    setup: {
      title: 'Create a Canvas access token',
      why: 'Free, from your own Canvas account.',
      steps: [
        'Open Canvas -> Account -> Settings.',
        'Under Approved Integrations, click + New Access Token.',
        'Give it a purpose, generate, and copy the token.',
        'Enter your Canvas address too, for example yourschool.instructure.com'
      ],
      needs: ['token', 'host']
    },
    async identify(token, fields = {}) {
      const host = String(fields.host || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (!host) throw new Error('Enter your Canvas address, e.g. yourschool.instructure.com');
      const res = await fetch(`https://${host}/api/v1/users/self`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`Canvas rejected that token (HTTP ${res.status})`);
      const me = await res.json();
      return { accountId: String(me.id), label: `${me.name} · ${host}`, meta: { host, name: me.name } };
    }
  },

  jira: {
    id: 'jira',
    kind: 'token',
    name: 'Jira',
    apps: ['jira'],
    extraFields: [
      { key: 'host', label: 'Jira site', placeholder: 'yourteam.atlassian.net' },
      { key: 'email', label: 'Atlassian email', placeholder: 'you@example.com' }
    ],
    setup: {
      title: 'Create an Atlassian API token',
      why: 'Free. Jira Cloud is free for up to 10 users.',
      steps: [
        'Open id.atlassian.com/manage-profile/security/api-tokens -> Create API token.',
        'Copy the token, and enter your Jira site address and the email you sign in with.'
      ],
      docsUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      needs: ['token', 'host', 'email']
    },
    async identify(token, fields = {}) {
      const host = String(fields.host || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
      const email = fields.email;
      if (!host || !email) throw new Error('Enter your Jira site and the email you sign in with');
      const auth = Buffer.from(`${email}:${token}`).toString('base64');
      const res = await fetch(`https://${host}/rest/api/3/myself`, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }
      });
      if (!res.ok) throw new Error(`Jira rejected that token (HTTP ${res.status})`);
      const me = await res.json();
      return {
        accountId: me.accountId,
        label: `${me.displayName} · ${host}`,
        meta: { host, email, name: me.displayName }
      };
    }
  },

  discord: {
    id: 'discord',
    kind: 'token',
    name: 'Discord',
    apps: ['discord'],
    setup: {
      title: 'Create a Discord bot token',
      why: 'Free, from the Discord developer portal.',
      steps: [
        'Open discord.com/developers/applications -> New Application.',
        'Bot -> Reset Token -> copy it.',
        'Enable the Message Content intent.',
        'OAuth2 -> URL Generator -> scope bot, permissions Read Messages and Send Messages -> open the URL to add it to your server.'
      ],
      docsUrl: 'https://discord.com/developers/applications',
      needs: ['token']
    },
    async identify(token) {
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` }
      });
      if (!res.ok) throw new Error(`Discord rejected that token (HTTP ${res.status})`);
      const me = await res.json();
      return { accountId: me.id, label: me.username, meta: {} };
    }
  },

  // --- Browser sessions ---------------------------------------------------
  whatsapp: {
    id: 'whatsapp',
    kind: 'browser',
    name: 'WhatsApp',
    apps: ['whatsapp'],
    url: 'https://web.whatsapp.com',
    // Present once the page is past the QR screen.
    signedInSelector: '#pane-side',
    setup: {
      title: 'Sign in to WhatsApp Web',
      why: 'WhatsApp has no free API, so VoiceOS drives the web app in its own browser profile.',
      steps: ['A browser window opens at web.whatsapp.com.', 'Scan the QR code with your phone.', 'Leave it signed in; VoiceOS reuses that session.']
    }
  },

  x: {
    id: 'x',
    kind: 'browser',
    name: 'X',
    apps: ['x-twitter'],
    url: 'https://x.com/home',
    signedInSelector: '[data-testid="SideNav_AccountSwitcher_Button"]',
    setup: {
      title: 'Sign in to X',
      why: 'The X API is no longer free, so VoiceOS drives the web app in its own browser profile.',
      steps: ['A browser window opens at x.com.', 'Sign in as normal.', 'Leave it signed in; VoiceOS reuses that session.']
    }
  },

  // --- Local --------------------------------------------------------------
  obsidian: {
    id: 'obsidian',
    kind: 'local',
    name: 'Obsidian',
    apps: ['obsidian'],
    pick: 'folder',
    setup: {
      title: 'Choose your vault',
      why: 'Obsidian notes are plain Markdown files, so VoiceOS just reads the folder.',
      steps: ['Pick the folder your vault lives in.']
    }
  },

  files: {
    id: 'files',
    kind: 'local',
    name: 'File Explorer',
    apps: ['files'],
    pick: 'folders',
    setup: {
      title: 'Choose which folders VoiceOS may search',
      why: 'Nothing outside the folders you choose is ever read.',
      steps: ['Pick one or more folders. Documents and Downloads are typical.']
    }
  }
};

/** The provider that serves a given App Store entry, or null. */
function providerForApp(appId) {
  return Object.values(PROVIDERS).find((p) => p.apps.includes(appId)) || null;
}

/** Apps that need no connection at all. */
const ALWAYS_READY = new Set([
  'system', 'web-search', 'spotify', 'google-maps', 'notes', 'todo',
  'windows-calendar', 'youtube', 'claude-code', 'codex', 'windows-mail'
]);

function needsConnection(appId) {
  return !ALWAYS_READY.has(appId) && Boolean(providerForApp(appId));
}

module.exports = { PROVIDERS, providerForApp, needsConnection, ALWAYS_READY };
