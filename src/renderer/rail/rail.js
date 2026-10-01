'use strict';
/**
 * History rail renderer.
 *
 * The window spans the full height of the screen and is wide enough for the
 * open panel, but it is click-through by default. This script watches forwarded
 * mouse movement and tells the main process when the pointer is over something
 * interactive, so the rail can be used without ever blocking clicks meant for
 * the app underneath.
 */

const el = {
  rail: document.getElementById('rail'),
  strip: document.getElementById('strip'),
  panel: document.getElementById('panel'),
  list: document.getElementById('list'),
  stats: document.getElementById('stats'),
  search: document.getElementById('search'),
  pin: document.getElementById('pin'),
  openApp: document.getElementById('openApp'),
  subtitle: document.getElementById('subtitle')
};

let open = false;
let pinned = false;
let items = [];
let closeTimer = null;

function setOpen(next) {
  if (open === next) return;
  open = next;
  el.rail.dataset.open = String(next);
  // Only claim mouse input while something is actually on screen to click.
  window.voiceos.setInteractive(next);
  if (next) loadHistory();
}

function scheduleClose(delay = 260) {
  clearTimeout(closeTimer);
  if (pinned) return;
  closeTimer = setTimeout(() => setOpen(false), delay);
}

function cancelClose() { clearTimeout(closeTimer); }

// --- Hover handling -------------------------------------------------------
// Mouse events still arrive while the window is click-through (forward: true),
// which is what lets the strip react before we take input.

window.addEventListener('mousemove', (e) => {
  const overStrip = e.clientX <= 14;
  const overPanel = open && e.clientX <= el.panel.offsetWidth;

  if (!open && overStrip) {
    cancelClose();
    setOpen(true);
    return;
  }
  if (open && !overPanel) scheduleClose();
  else cancelClose();
});

el.panel.addEventListener('mouseenter', cancelClose);
el.panel.addEventListener('mouseleave', () => scheduleClose());

window.addEventListener('mouseleave', () => scheduleClose(120));

el.pin.addEventListener('click', () => {
  pinned = !pinned;
  el.pin.dataset.pinned = String(pinned);
  el.pin.textContent = pinned ? 'Pinned' : 'Pin';
  if (!pinned) scheduleClose(800);
});

el.openApp.addEventListener('click', () => window.voiceos.openSettings());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { pinned = false; el.pin.dataset.pinned = 'false'; el.pin.textContent = 'Pin'; setOpen(false); }
});

// --- Data -----------------------------------------------------------------

async function loadHistory(query) {
  const [list, stats] = await Promise.all([
    query
      ? window.voiceos.transcripts({ action: 'search', query, limit: 80 })
      : window.voiceos.transcripts({ action: 'list', limit: 80 }),
    window.voiceos.transcripts({ action: 'stats' })
  ]);
  items = list || [];
  renderStats(stats);
  renderList();
}

function renderStats(s) {
  if (!s) return;
  el.stats.innerHTML = `
    <div class="stat"><span class="stat-value">${s.sessions}</span><span class="stat-label">Sessions</span></div>
    <div class="stat"><span class="stat-value">${(s.words || 0).toLocaleString()}</span><span class="stat-label">Words</span></div>
    <div class="stat"><span class="stat-value">${s.estimatedMinutesSaved || 0}m</span><span class="stat-label">Saved</span></div>`;
}

function renderList() {
  if (!items.length) {
    el.list.innerHTML = `<p class="empty">
      Nothing yet. Press your dictation shortcut in any text field and it will show up here.
    </p>`;
    return;
  }
  el.list.innerHTML = items.map((r, i) => `
    <div class="item" data-i="${i}" title="Click to copy">
      <div class="item-meta">
        <span>${timeAgo(r.at)}</span>
        ${r.target && r.target.process ? `<span>${escapeHtml(r.target.process)}</span>` : ''}
      </div>
      <div class="item-text">${escapeHtml(r.text || '')}</div>
    </div>`).join('');
}

// Clicking an entry puts it back on the clipboard: the most common reason to
// open history is wanting something you already said.
el.list.addEventListener('click', async (e) => {
  const node = e.target.closest('.item');
  if (!node) return;
  const record = items[Number(node.dataset.i)];
  if (!record) return;
  await window.voiceos.copyText(record.text || '');
  const meta = node.querySelector('.item-meta');
  const original = meta.innerHTML;
  meta.innerHTML = '<span class="item-copied">Copied to clipboard</span>';
  setTimeout(() => { meta.innerHTML = original; }, 1400);
});

let searchTimer = null;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = el.search.value.trim();
  searchTimer = setTimeout(() => loadHistory(q || undefined), 170);
});

// Refresh the moment a new dictation lands, so the rail is never stale.
window.voiceos.onHistoryChanged(() => { if (open) loadHistory(el.search.value.trim() || undefined); });

// --- Helpers --------------------------------------------------------------

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!then) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

el.rail.dataset.open = 'false';
window.voiceos.setInteractive(false);
