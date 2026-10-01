'use strict';
/**
 * The App Store catalogue.
 *
 * This mirrors the real VoiceOS App Store one-to-one: the same 21 integrations,
 * in the same order, with the same names, descriptions, categories, voice-action
 * counts, platform labels and BETA flags, using the same icon artwork.
 *
 * Platform labels are kept honest. The Apple integrations are genuinely macOS
 * only in the real product too, so on Windows they appear in the store exactly
 * as they do there — listed, with a macOS badge — and `windowsEquivalent` points
 * at the entry that does the same job here. Those equivalents are listed after
 * the official 21 under "Also on Windows".
 *
 * `auth` describes what the user must provide:
 *   none    — works immediately, nothing to configure
 *   local   — a folder or executable path on this machine
 *   token   — a free personal access token or API key
 *   oauth   — a free OAuth app the user creates once
 *   browser — drives a browser session the user is already signed into
 *
 * `mutating: true` marks anything that sends, creates, changes or deletes. Agent
 * Mode must show a confirmation before running any of those.
 */

const read = (name, description) => ({ name, description, mutating: false });
const write = (name, description) => ({ name, description, mutating: true });

/** The official 21, in the order the real store lists them. */
const OFFICIAL = [
  {
    id: 'imessage',
    name: 'iMessage',
    icon: 'imessage.webp',
    category: 'Messaging',
    description: 'Read and send iMessages',
    platforms: ['darwin'],
    auth: 'local',
    authNote: 'Reads the local Messages database and sends via AppleScript.',
    windowsEquivalent: 'whatsapp',
    actions: [
      read('list_chats', 'List recent conversations'),
      read('read_messages', 'Read the latest messages in a chat'),
      read('search_messages', 'Search your message history'),
      write('send_message', 'Send an iMessage'),
      write('reply_to_chat', 'Reply in a conversation')
    ]
  },
  {
    id: 'apple-mail',
    name: 'Apple Mail',
    icon: 'apple-mail.webp',
    category: 'Email',
    description: 'Read, search, send, and reply to email',
    platforms: ['darwin'],
    auth: 'local',
    authNote: 'Drives Mail.app through AppleScript.',
    windowsEquivalent: 'outlook',
    actions: [
      read('list_messages', 'List recent email'),
      read('read_message', 'Read an email'),
      read('search_messages', 'Search your mail'),
      read('list_unread', 'Show unread mail'),
      write('send_email', 'Send an email'),
      write('reply_email', 'Reply to a thread'),
      write('move_message', 'File or archive a message')
    ]
  },
  {
    id: 'reminders',
    name: 'Reminders',
    icon: 'reminders.webp',
    category: 'Productivity',
    description: 'Read, create, and complete reminders',
    platforms: ['darwin'],
    auth: 'local',
    authNote: 'Drives Reminders.app through AppleScript.',
    windowsEquivalent: 'todo',
    actions: [
      read('list_reminders', 'List your reminders'),
      read('list_due', 'Show what is due'),
      write('create_reminder', 'Set a reminder'),
      write('complete_reminder', 'Mark one done'),
      write('delete_reminder', 'Delete a reminder')
    ]
  },
  {
    id: 'finder',
    name: 'Finder',
    icon: 'finder.png',
    category: 'Productivity',
    description: 'Search, read, and organize files on your Mac',
    platforms: ['darwin'],
    auth: 'local',
    authNote: 'Uses Spotlight and the folders you allow.',
    windowsEquivalent: 'files',
    actions: [
      read('search_files', 'Find a file by name'),
      read('search_content', 'Search inside files'),
      read('read_file', 'Read a text file'),
      read('list_directory', 'List a folder'),
      read('recent_files', 'Show recently changed files'),
      read('file_info', 'Check size and dates'),
      read('find_by_type', 'Find all PDFs, images and so on'),
      read('find_largest', 'Find what is using disk space'),
      write('open_file', 'Open a file in its default app'),
      write('reveal_in_finder', 'Show a file in Finder'),
      write('move_file', 'Move or rename a file'),
      write('create_folder', 'Create a folder')
    ]
  },
  {
    id: 'apple-notes',
    name: 'Notes',
    icon: 'apple-notes.webp',
    category: 'Note Taking',
    description: 'Read, create, and append notes',
    platforms: ['darwin'],
    auth: 'local',
    authNote: 'Drives Notes.app through AppleScript.',
    windowsEquivalent: 'notes',
    actions: [
      read('list_notes', 'List your notes'),
      read('read_note', 'Read a note'),
      read('search_notes', 'Search your notes'),
      write('create_note', 'Take a note'),
      write('append_note', 'Add to a note'),
      write('delete_note', 'Delete a note')
    ]
  },
  {
    id: 'spotify',
    name: 'Spotify',
    icon: 'spotify.webp',
    category: 'Media',
    description: 'Control playback, volume, and tracks in the desktop app',
    platforms: ['darwin', 'win32'],
    beta: true,
    auth: 'none',
    authNote: 'Controlled through the system media session, so it works on a free Spotify account with no API token.',
    actions: [
      read('now_playing', 'Ask what is playing'),
      write('play', 'Resume playback'),
      write('pause', 'Pause playback'),
      write('next_track', 'Skip to the next track'),
      write('previous_track', 'Go back a track'),
      write('set_volume', 'Change the volume'),
      write('mute', 'Mute or unmute'),
      write('toggle_shuffle', 'Toggle shuffle'),
      write('seek', 'Jump to a position')
    ]
  },
  {
    id: 'slack',
    name: 'Slack',
    icon: 'slack.webp',
    category: 'Messaging',
    description: 'Read and send messages',
    platforms: ['darwin', 'win32'],
    auth: 'token',
    authNote: 'Free Slack app with a user token, created at api.slack.com/apps.',
    actions: [
      read('list_channels', 'List channels you are in'),
      read('read_channel', 'Read recent messages in a channel'),
      read('read_dms', 'Read direct messages'),
      read('search_messages', 'Search across your workspace'),
      read('list_mentions', 'Show where you were mentioned'),
      read('get_user', 'Look up a colleague'),
      write('send_message', 'Post a message to a channel'),
      write('send_dm', 'Send a direct message'),
      write('reply_thread', 'Reply in a thread')
    ]
  },
  {
    id: 'gmail',
    name: 'Gmail',
    icon: 'gmail.webp',
    category: 'Email',
    description: 'Send, read, and manage emails',
    platforms: ['darwin', 'win32'],
    auth: 'oauth',
    authNote: 'Free Google Cloud OAuth client. The Gmail API costs nothing at personal volume.',
    actions: [
      read('list_messages', 'List recent email'),
      read('read_message', 'Read a specific email'),
      read('search_messages', 'Search your mail'),
      read('list_unread', 'Show unread mail'),
      write('send_email', 'Send an email'),
      write('reply_email', 'Reply to a thread'),
      write('modify_labels', 'Archive, star or label mail')
    ]
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    icon: 'google-calendar.png',
    category: 'Calendar',
    description: 'View and create calendar events',
    platforms: ['darwin', 'win32'],
    auth: 'oauth',
    authNote: 'Same free Google OAuth client as Gmail.',
    actions: [
      read('list_events', 'See what is on your calendar'),
      read('get_event', 'Read one event in detail'),
      read('find_free_time', 'Find a free slot'),
      read('search_events', 'Search your calendar'),
      write('create_event', 'Create an event'),
      write('update_event', 'Move or edit an event'),
      write('delete_event', 'Cancel an event')
    ]
  },
  {
    id: 'apple-calendar',
    name: 'Apple Calendar',
    icon: 'apple-calendar.svg',
    category: 'Calendar',
    description: 'View and create events on your Mac',
    platforms: ['darwin'],
    auth: 'local',
    authNote: 'Drives Calendar.app through AppleScript.',
    windowsEquivalent: 'windows-calendar',
    actions: [
      read('list_events', 'See what is on your calendar'),
      read('get_event', 'Read one event'),
      read('find_free_time', 'Find a free slot'),
      read('today_agenda', 'Read today\'s agenda'),
      write('create_event', 'Create an event'),
      write('update_event', 'Move or edit an event'),
      write('delete_event', 'Cancel an event')
    ]
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    icon: 'google-maps.png',
    category: 'Productivity',
    description: 'Search places, get directions, and things nearby',
    platforms: ['darwin', 'win32'],
    auth: 'none',
    authNote: 'Opens Maps search and direction URLs, which need no API key or billing account.',
    actions: [
      write('open_maps', 'Search a place, get directions, or find what is nearby')
    ]
  },
  {
    id: 'outlook',
    name: 'Outlook',
    icon: 'outlook.webp',
    category: 'Email',
    description: 'Email, calendar, and contacts in Microsoft 365',
    platforms: ['darwin', 'win32'],
    auth: 'oauth',
    authNote: 'Free Microsoft Graph app registration. Works with a personal Microsoft account.',
    actions: [
      read('list_messages', 'List recent email'),
      read('read_message', 'Read an email'),
      read('search_messages', 'Search your mailbox'),
      read('list_events', 'See calendar events'),
      read('find_contact', 'Look up a contact'),
      read('free_busy', 'Check availability'),
      write('send_email', 'Send an email'),
      write('reply_email', 'Reply to a thread'),
      write('create_event', 'Create a calendar event'),
      write('respond_event', 'Accept or decline an invitation'),
      write('move_message', 'Move or archive a message')
    ]
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    icon: 'google-drive.webp',
    category: 'Productivity',
    description: 'Manage Files, Sheets, and Docs',
    platforms: ['darwin', 'win32'],
    auth: 'oauth',
    authNote: 'Same free Google OAuth client. 15GB of free storage included.',
    actions: [
      read('search_files', 'Find a file'),
      read('list_files', 'List files in a folder'),
      read('read_doc', 'Read a Google Doc'),
      read('read_sheet', 'Read a spreadsheet range'),
      read('get_file_metadata', 'Check file details'),
      read('list_shared', 'See files shared with you'),
      read('download_file', 'Download a file'),
      write('create_doc', 'Create a document'),
      write('append_doc', 'Append to a document'),
      write('create_sheet', 'Create a spreadsheet'),
      write('update_sheet', 'Write cells in a spreadsheet'),
      write('create_folder', 'Create a folder'),
      write('upload_file', 'Upload a file'),
      write('move_file', 'Move a file'),
      write('rename_file', 'Rename a file'),
      write('share_file', 'Share a file'),
      write('delete_file', 'Move a file to trash')
    ]
  },
  {
    id: 'linear',
    name: 'Linear',
    icon: 'linear.webp',
    category: 'Productivity',
    description: 'Create, manage, and track issues',
    platforms: ['darwin', 'win32'],
    auth: 'token',
    authNote: 'Free personal API key from Linear settings.',
    actions: [
      read('list_issues', 'List issues'),
      read('get_issue', 'Read an issue'),
      read('search_issues', 'Search issues'),
      read('list_my_issues', 'Show issues assigned to you'),
      read('list_teams', 'List teams and projects'),
      write('create_issue', 'File an issue'),
      write('update_issue', 'Change status, assignee or priority'),
      write('comment_issue', 'Comment on an issue'),
      write('assign_issue', 'Assign an issue'),
      write('close_issue', 'Close an issue')
    ]
  },
  {
    id: 'jira',
    name: 'Jira',
    icon: 'jira.svg',
    category: 'Productivity',
    description: 'Create, update, search, and manage Jira issues and projects',
    platforms: ['darwin', 'win32'],
    auth: 'token',
    authNote: 'Free Atlassian API token. Jira Cloud is free for up to 10 users.',
    actions: [
      read('search_issues', 'Search with JQL'),
      read('get_issue', 'Read an issue'),
      read('list_projects', 'List projects'),
      read('list_my_issues', 'Show your issues'),
      read('list_sprints', 'See sprints'),
      read('get_transitions', 'See available status changes'),
      write('create_issue', 'Create an issue'),
      write('update_issue', 'Update fields'),
      write('transition_issue', 'Move an issue through a workflow'),
      write('comment_issue', 'Add a comment'),
      write('assign_issue', 'Assign an issue')
    ]
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: 'claude-code.webp',
    category: 'Productivity',
    description: 'Run coding tasks with the Claude Code CLI on your computer',
    platforms: ['darwin', 'win32'],
    beta: true,
    auth: 'local',
    authNote: 'Uses the Claude Code CLI already installed on this machine.',
    actions: [
      read('list_sessions', 'List recent sessions'),
      read('read_output', 'Read what it produced'),
      read('project_status', 'Check the working tree'),
      write('run_task', 'Give it a coding task'),
      write('continue_session', 'Continue a session'),
      write('run_command', 'Run a project command'),
      write('commit', 'Commit the current changes'),
      write('stop_task', 'Stop a running task')
    ]
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: 'codex.webp',
    category: 'Productivity',
    description: 'Run coding tasks with the Codex app or CLI on your computer',
    platforms: ['darwin', 'win32'],
    beta: true,
    auth: 'local',
    authNote: 'Uses the Codex CLI already installed on this machine.',
    actions: [
      read('list_sessions', 'List recent sessions'),
      read('read_output', 'Read what it produced'),
      read('project_status', 'Check the working tree'),
      write('run_task', 'Give it a coding task'),
      write('continue_session', 'Continue a session'),
      write('run_command', 'Run a project command'),
      write('commit', 'Commit the current changes'),
      write('stop_task', 'Stop a running task')
    ]
  },
  {
    id: 'notion',
    name: 'Notion',
    icon: 'notion.webp',
    category: 'Note Taking',
    description: 'Manage pages and databases',
    platforms: ['darwin', 'win32'],
    auth: 'token',
    authNote: 'Free internal integration token from notion.so/my-integrations.',
    actions: [
      read('search', 'Search your workspace'),
      read('read_page', 'Read a page'),
      read('query_database', 'Query a database'),
      read('list_databases', 'List databases'),
      write('create_page', 'Create a page'),
      write('append_block', 'Add content to a page'),
      write('update_page', 'Update page properties'),
      write('create_database_item', 'Add a database row'),
      write('add_daily_note', 'Append to today\'s note')
    ]
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    icon: 'obsidian.webp',
    category: 'Note Taking',
    description: 'Read, create, and append vault notes',
    platforms: ['darwin', 'win32'],
    beta: true,
    auth: 'local',
    authNote: 'Point VoiceOS at your vault folder. Notes are plain Markdown files.',
    actions: [
      read('search_notes', 'Search your vault'),
      read('read_note', 'Read a note'),
      write('create_note', 'Create a note'),
      write('append_note', 'Append to a note')
    ]
  },
  {
    id: 'canvas',
    name: 'Canvas',
    icon: 'canvas.webp',
    category: 'Productivity',
    description: 'View courses and assignments',
    platforms: ['darwin', 'win32'],
    auth: 'token',
    authNote: 'Free access token from your Canvas account settings.',
    actions: [
      read('list_courses', 'List your courses'),
      read('list_assignments', 'List assignments'),
      read('upcoming_due', 'See what is due soon'),
      read('read_assignment', 'Read an assignment'),
      read('list_grades', 'Check your grades'),
      read('list_announcements', 'Read announcements'),
      read('read_syllabus', 'Read a syllabus'),
      read('list_modules', 'List course modules'),
      read('list_submissions', 'Check your submissions'),
      read('course_files', 'Find course files'),
      read('list_quizzes', 'List quizzes'),
      read('calendar_events', 'See course calendar events'),
      write('submit_text_entry', 'Submit a text assignment')
    ]
  },
  {
    id: 'x-twitter',
    name: 'X (Twitter)',
    icon: 'x.webp',
    category: 'Social',
    description: 'Post, search, and engage on X',
    platforms: ['darwin', 'win32'],
    beta: true,
    auth: 'browser',
    authNote: 'The X API is no longer free, so this drives the web app in a browser session you are already signed into.',
    actions: [
      read('read_timeline', 'Read your timeline'),
      read('search_posts', 'Search posts'),
      read('read_notifications', 'Check notifications'),
      read('read_profile', 'Look at a profile'),
      write('post', 'Post to X'),
      write('reply', 'Reply to a post'),
      write('repost', 'Repost'),
      write('like', 'Like a post'),
      write('send_dm', 'Send a direct message')
    ]
  }
];

/**
 * Windows counterparts for the Apple-only entries above, plus the built-ins the
 * real product handles outside the store (system control, web search). Shown in
 * a separate "Also on Windows" section so the official 21 stay exact.
 */
const WINDOWS_EXTRAS = [
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    icon: null,
    glyph: '💬',
    category: 'Messaging',
    description: 'Read and send WhatsApp messages',
    platforms: ['win32', 'darwin'],
    beta: true,
    extra: true,
    replaces: 'iMessage',
    auth: 'browser',
    authNote: 'Drives WhatsApp Web in a browser session you are already signed into.',
    actions: [
      read('list_chats', 'List recent conversations'),
      read('read_messages', 'Read the latest messages in a chat'),
      read('search_messages', 'Search your message history'),
      write('send_message', 'Send a message'),
      write('reply_to_chat', 'Reply in a conversation')
    ]
  },
  {
    id: 'files',
    name: 'File Explorer',
    icon: null,
    glyph: '📁',
    category: 'Productivity',
    description: 'Search, read, and organize files on your PC',
    platforms: ['win32'],
    extra: true,
    replaces: 'Finder',
    auth: 'local',
    authNote: 'Choose which folders VoiceOS may look in. Nothing outside them is touched.',
    actions: [
      read('search_files', 'Find a file by name'),
      read('search_content', 'Search inside files'),
      read('read_file', 'Read a text file'),
      read('list_directory', 'List a folder'),
      read('recent_files', 'Show recently changed files'),
      read('file_info', 'Check size and dates'),
      read('find_by_type', 'Find all PDFs, images and so on'),
      read('find_largest', 'Find what is using disk space'),
      write('open_file', 'Open a file in its default app'),
      write('reveal_in_explorer', 'Show a file in Explorer'),
      write('move_file', 'Move or rename a file'),
      write('create_folder', 'Create a folder')
    ]
  },
  {
    id: 'notes',
    name: 'Notes',
    icon: null,
    glyph: '📝',
    category: 'Note Taking',
    description: 'Read, create, and append local notes',
    platforms: ['win32'],
    extra: true,
    replaces: 'Apple Notes',
    auth: 'none',
    authNote: 'Plain Markdown files kept in your VoiceOS data folder.',
    actions: [
      read('list_notes', 'List your notes'),
      read('read_note', 'Read a note'),
      read('search_notes', 'Search your notes'),
      write('create_note', 'Take a note'),
      write('append_note', 'Add to a note'),
      write('delete_note', 'Delete a note')
    ]
  },
  {
    id: 'todo',
    name: 'Reminders',
    icon: null,
    glyph: '✅',
    category: 'Productivity',
    description: 'Read, create, and complete reminders',
    platforms: ['win32'],
    extra: true,
    replaces: 'Apple Reminders',
    auth: 'none',
    authNote: 'Stored on this device and surfaced through Windows notifications.',
    actions: [
      read('list_reminders', 'List your reminders'),
      read('list_due', 'Show what is due'),
      write('create_reminder', 'Set a reminder'),
      write('complete_reminder', 'Mark one done'),
      write('delete_reminder', 'Delete a reminder')
    ]
  },
  {
    id: 'windows-calendar',
    name: 'Calendar',
    icon: null,
    glyph: '🗓️',
    category: 'Calendar',
    description: 'Local calendar events on this PC',
    platforms: ['win32'],
    extra: true,
    replaces: 'Apple Calendar',
    auth: 'none',
    authNote: 'Stored locally with Windows notifications.',
    actions: [
      read('list_events', 'List upcoming events'),
      read('today_agenda', 'Read today\'s agenda'),
      read('find_free_time', 'Find a free slot'),
      write('create_event', 'Create an event'),
      write('update_event', 'Move or edit an event'),
      write('delete_event', 'Cancel an event')
    ]
  },
  {
    id: 'web-search',
    name: 'Web Search',
    icon: null,
    glyph: '🔍',
    category: 'Productivity',
    description: 'Search the web with sources',
    platforms: ['win32', 'darwin'],
    extra: true,
    auth: 'none',
    authNote: 'Uses DuckDuckGo and Wikipedia, which need no API key.',
    actions: [
      read('search_web', 'Search the web'),
      read('fetch_page', 'Read a page and summarise it'),
      read('search_wikipedia', 'Look something up on Wikipedia'),
      read('answer_question', 'Answer with cited sources')
    ]
  },
  {
    id: 'google-classroom',
    name: 'Google Classroom',
    icon: null,
    glyph: '🎒',
    category: 'Productivity',
    description: 'Coursework, due dates, and announcements',
    platforms: ['win32', 'darwin'],
    extra: true,
    auth: 'oauth',
    authNote: 'Same free Google OAuth client as Gmail. The Classroom API is free.',
    actions: [
      read('list_courses', 'List your classes'),
      read('list_coursework', 'List assignments'),
      read('upcoming_due', 'See what is due soon'),
      read('read_assignment', 'Read an assignment'),
      read('list_announcements', 'Read announcements'),
      read('list_materials', 'Find class materials'),
      read('check_submissions', 'Check what you have turned in')
    ]
  },
  {
    id: 'discord',
    name: 'Discord',
    icon: null,
    glyph: '🎮',
    category: 'Messaging',
    description: 'Read and send Discord messages',
    platforms: ['win32', 'darwin'],
    extra: true,
    auth: 'token',
    authNote: 'Free bot token from the Discord developer portal.',
    actions: [
      read('list_channels', 'List channels'),
      read('read_channel', 'Read recent messages'),
      read('search_messages', 'Search a server'),
      write('send_message', 'Send a message'),
      write('reply_message', 'Reply to a message')
    ]
  },
  {
    id: 'youtube',
    name: 'YouTube',
    icon: null,
    glyph: '▶️',
    category: 'Media',
    description: 'Search videos and control playback',
    platforms: ['win32', 'darwin'],
    extra: true,
    auth: 'none',
    authNote: 'Search opens in your browser; playback uses the system media session. No API key needed.',
    actions: [
      read('search_videos', 'Search for a video'),
      read('now_playing', 'Ask what is playing'),
      write('open_video', 'Play a video'),
      write('play_pause', 'Play or pause'),
      write('next_video', 'Skip to the next video')
    ]
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: null,
    glyph: '🐙',
    category: 'Productivity',
    description: 'Issues, pull requests, and repositories',
    platforms: ['win32', 'darwin'],
    extra: true,
    auth: 'token',
    authNote: 'Free personal access token, or the gh CLI if you already use it.',
    actions: [
      read('list_repos', 'List your repositories'),
      read('list_issues', 'List issues'),
      read('list_prs', 'List pull requests'),
      read('read_issue', 'Read an issue or PR'),
      read('check_ci', 'Check CI status'),
      write('create_issue', 'File an issue'),
      write('comment', 'Comment on an issue or PR'),
      write('create_pr', 'Open a pull request')
    ]
  },
  {
    id: 'system',
    name: 'This PC',
    icon: null,
    glyph: '🖥️',
    category: 'Productivity',
    description: 'Launch apps, control windows, and read the screen',
    platforms: ['win32', 'darwin'],
    extra: true,
    auth: 'none',
    authNote: 'Built in. Uses the same OS automation as Dictation Mode.',
    actions: [
      read('list_apps', 'See what is installed'),
      read('list_windows', 'See what is open'),
      read('read_screen', 'Read what is on screen'),
      read('read_selection', 'Read the selected text'),
      read('what_is_this', 'Describe whatever is under the cursor'),
      write('open_app', 'Open an application'),
      write('open_url', 'Open a web page'),
      write('focus_window', 'Switch to a window'),
      write('type_text', 'Type text somewhere'),
      write('press_keys', 'Press a keyboard shortcut'),
      write('set_volume', 'Change system volume')
    ]
  }
];

const APPS = [...OFFICIAL, ...WINDOWS_EXTRAS];

/** The category order the real store uses in its filter row. */
const CATEGORIES = ['Messaging', 'Email', 'Calendar', 'Productivity', 'Note Taking', 'Media', 'Social'];

// --- Derived views --------------------------------------------------------

/** Everything in the store, including entries this OS cannot run. */
function all() { return APPS; }

/** The official 21, exactly as the real store lists them. */
function official() { return OFFICIAL; }

/** Entries that actually run on this platform. */
function runnableOn(platform = process.platform) {
  return APPS.filter((a) => a.platforms.includes(platform));
}

function getApp(id) { return APPS.find((a) => a.id === id) || null; }

function actionCount(app) { return app.actions.length; }

/** Flat list of every runnable action, used to build the agent's tool schema. */
function allActions(platform = process.platform) {
  const out = [];
  for (const app of runnableOn(platform)) {
    for (const action of app.actions) {
      out.push({ ...action, appId: app.id, appName: app.name, tool: `${app.id}__${action.name}` });
    }
  }
  return out;
}

function summary(platform = process.platform) {
  const runnable = runnableOn(platform);
  return {
    listed: APPS.length,
    official: OFFICIAL.length,
    runnable: runnable.length,
    otherPlatformOnly: APPS.length - runnable.length,
    actions: runnable.reduce((n, a) => n + a.actions.length, 0),
    mutating: runnable.reduce((n, a) => n + a.actions.filter((x) => x.mutating).length, 0),
    categories: CATEGORIES,
    needingNoSetup: runnable.filter((a) => a.auth === 'none').length
  };
}

module.exports = {
  APPS, OFFICIAL, WINDOWS_EXTRAS, CATEGORIES,
  all, official, runnableOn, getApp, actionCount, allActions, summary
};
