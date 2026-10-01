'use strict';
/**
 * Maps a running process to an icon, so the pill can show where dictated text
 * will land. Falls back to a glyph rather than guessing, because a wrong icon
 * is worse than none.
 */
const BY_PROCESS = {
  chrome: { icon: null, glyph: '🌐', name: 'Chrome' },
  msedge: { icon: null, glyph: '🌐', name: 'Edge' },
  firefox: { icon: null, glyph: '🌐', name: 'Firefox' },
  slack: { icon: 'slack.webp', name: 'Slack' },
  notion: { icon: 'notion.webp', name: 'Notion' },
  obsidian: { icon: 'obsidian.webp', name: 'Obsidian' },
  spotify: { icon: 'spotify.webp', name: 'Spotify' },
  discord: { icon: null, glyph: '🎮', name: 'Discord' },
  code: { icon: null, glyph: '⌨️', name: 'VS Code' },
  devenv: { icon: null, glyph: '⌨️', name: 'Visual Studio' },
  notepad: { icon: null, glyph: '📝', name: 'Notepad' },
  winword: { icon: null, glyph: '📄', name: 'Word' },
  excel: { icon: null, glyph: '📊', name: 'Excel' },
  outlook: { icon: 'outlook.webp', name: 'Outlook' },
  onenote: { icon: null, glyph: '📓', name: 'OneNote' },
  explorer: { icon: null, glyph: '📁', name: 'Explorer' },
  claude: { icon: null, glyph: '◈', name: 'Claude' },
  terminal: { icon: null, glyph: '▸', name: 'Terminal' },
  windowsterminal: { icon: null, glyph: '▸', name: 'Terminal' },
  powershell: { icon: null, glyph: '▸', name: 'PowerShell' },
  roblox: { icon: null, glyph: '🎮', name: 'Roblox' },
  robloxstudio: { icon: null, glyph: '🎮', name: 'Roblox Studio' }
};

function iconForProcess(process, title) {
  if (!process) return null;
  const key = String(process).toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9]/g, '');
  const hit = BY_PROCESS[key];
  if (hit) return { ...hit, process };

  // Unknown app: show its name rather than a misleading icon.
  const name = String(title || process).split(/[-—|]/)[0].trim().slice(0, 28);
  return { icon: null, glyph: '◻', name: name || process, process };
}

module.exports = { iconForProcess, BY_PROCESS };
