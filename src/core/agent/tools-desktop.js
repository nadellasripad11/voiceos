'use strict';
/**
 * Desktop powers borrowed in spirit from Atticus for Windows (MIT, FindlayHi):
 * arranging windows across screens, pressing buttons inside apps by name,
 * searching inside files, the clipboard, watching for something to happen,
 * taught phrases, Recycle-Bin deletes, and services the user adds in Settings.
 *
 * Moving windows, reading and copying ask nothing. Anything that deletes, or
 * presses a button named like "Send" or "Delete", or calls a service in a way
 * that changes something, asks first.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ps } = require('./tools-pc');

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const psString = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Button names that commit something; pressing one of these asks first. */
const RISKY_BUTTON = /\b(send|delete|remove|erase|buy|pay|purchase|order|checkout|check out|post|publish|submit|confirm|uninstall|format|empty|unsubscribe|transfer|sign out|log out)\b/i;

// --- windows ------------------------------------------------------------------

/*
 * A process of its own rather than the shared bridge, because this one has to
 * be DPI aware: on a 200% screen an unaware process sees half-size
 * coordinates and puts a "left half" window in the top-left quarter. The
 * visible frame is matched with DWM, since Windows 10/11 windows carry an
 * invisible 7px border that otherwise leaves gaps between them.
 */
const ARRANGE_PS = (query, position, screen) => `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class VOSWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
}
"@
[void][VOSWin]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
$q = ${psString(query)}
$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and ($_.ProcessName -like "*$q*" -or $_.MainWindowTitle -like "*$q*") } | Sort-Object { if ($_.ProcessName -like "*$q*") { 0 } else { 1 } } | Select-Object -First 1
if (-not $p) { '{"ok":false,"missing":true}'; exit }
$h = $p.MainWindowHandle
$all = @([System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.Bounds.X })
$want = ${psString(screen)}
$s = switch -regex ($want) {
  '^big|large|main|external|monitor' { $all | Sort-Object { $_.Bounds.Width * $_.Bounds.Height } -Descending | Select-Object -First 1 }
  '^laptop|small|built' { if ($all.Count -gt 1) { $all | Sort-Object { $_.Bounds.Width * $_.Bounds.Height } | Select-Object -First 1 } else { $all[0] } }
  '^\\d+$' { $all[[math]::Min([int]$want, $all.Count) - 1] }
  'left' { $all[0] }
  'right' { $all[-1] }
  'other|next' { $cur = [System.Windows.Forms.Screen]::FromHandle($h); ($all | Where-Object { $_.DeviceName -ne $cur.DeviceName } | Select-Object -First 1) }
  default { [System.Windows.Forms.Screen]::FromHandle($h) }
}
if (-not $s) { $s = [System.Windows.Forms.Screen]::FromHandle($h) }
$a = $s.WorkingArea
$x = $a.X; $y = $a.Y; $w = $a.Width; $hh = $a.Height
switch (${psString(position)}) {
  'left'         { $w = [int]($a.Width / 2) }
  'right'        { $x = $a.X + [int]($a.Width / 2); $w = $a.Width - [int]($a.Width / 2) }
  'top'          { $hh = [int]($a.Height / 2) }
  'bottom'       { $y = $a.Y + [int]($a.Height / 2); $hh = $a.Height - [int]($a.Height / 2) }
  'top-left'     { $w = [int]($a.Width / 2); $hh = [int]($a.Height / 2) }
  'top-right'    { $x = $a.X + [int]($a.Width / 2); $w = $a.Width - [int]($a.Width / 2); $hh = [int]($a.Height / 2) }
  'bottom-left'  { $y = $a.Y + [int]($a.Height / 2); $w = [int]($a.Width / 2); $hh = $a.Height - [int]($a.Height / 2) }
  'bottom-right' { $x = $a.X + [int]($a.Width / 2); $y = $a.Y + [int]($a.Height / 2); $w = $a.Width - [int]($a.Width / 2); $hh = $a.Height - [int]($a.Height / 2) }
  'center'       { $w = [int]($a.Width * 0.62); $hh = [int]($a.Height * 0.72); $x = $a.X + [int](($a.Width - $w) / 2); $y = $a.Y + [int](($a.Height - $hh) / 2) }
}
[void][VOSWin]::ShowWindow($h, 9)
if (${psString(position)} -eq 'full') {
  [void][VOSWin]::SetWindowPos($h, [IntPtr]::Zero, $a.X, $a.Y, $a.Width, $a.Height, 0x0044)
  [void][VOSWin]::ShowWindow($h, 3)
} else {
  [void][VOSWin]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $w, $hh, 0x0044)
  $outer = New-Object VOSWin+RECT; $vis = New-Object VOSWin+RECT
  [void][VOSWin]::GetWindowRect($h, [ref]$outer)
  if ([VOSWin]::DwmGetWindowAttribute($h, 9, [ref]$vis, 16) -eq 0) {
    $dl = $vis.L - $outer.L; $dt = $vis.T - $outer.T; $dr = $outer.R - $vis.R; $db = $outer.B - $vis.B
    [void][VOSWin]::SetWindowPos($h, [IntPtr]::Zero, $x - $dl, $y - $dt, $w + $dl + $dr, $hh + $dt + $db, 0x0044)
  }
}
[void][VOSWin]::SetForegroundWindow($h)
$i = [array]::IndexOf($all, $s) + 1
'{"ok":true,"app":"' + $p.ProcessName + '","screen":' + $i + ',"screens":' + $all.Count + '}'
`;

const POSITIONS = ['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'full', 'center', 'keep'];

// --- buttons --------------------------------------------------------------------

const PRESSABLE = /^(Button|CheckBox|RadioButton|MenuItem|TabItem|ListItem|Hyperlink|SplitButton|TreeItem|ComboBox)$/;

/** Every named control in a UI tree, flattened. */
function controls(node, out = []) {
  if (!node) return out;
  if (node.name && PRESSABLE.test(node.controlType || '')) out.push({ name: String(node.name), type: node.controlType });
  for (const c of node.children || []) controls(c, out);
  return out;
}

/** The best control for what was said: exact, then starts with, then contains, then most words in common. */
function pickControl(list, wanted) {
  // "the send button" means the button named Send: what kind of control it
  // is, and the article, are not part of its name.
  const w = String(wanted || '').toLowerCase().replace(/\b(the|a|an|my|button|tab|menu|item|checkbox|option|toggle|icon|link)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!w) return null;
  const words = w.split(/\s+/).filter((x) => x.length > 1);
  const scored = list.map((c) => {
    const n = c.name.toLowerCase();
    let score = n === w ? 100 : n.startsWith(w) ? 80 : n.includes(w) ? 60 : 0;
    if (!score) score = words.filter((x) => n.includes(x)).length * (40 / Math.max(1, words.length));
    return { ...c, score };
  }).filter((c) => c.score >= 20).sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

async function findWindow(ctx, app) {
  const wins = await ctx.bridge.listWindows().catch(() => []);
  const own = (w) => /electron|voiceos/i.test(w.process);
  if (!app) return null;
  const needle = String(app).toLowerCase();
  return wins.find((w) => !own(w) && String(w.process).toLowerCase() === needle)
    || wins.find((w) => !own(w) && String(w.process).toLowerCase().includes(needle))
    || wins.find((w) => !own(w) && String(w.title).toLowerCase().includes(needle))
    || null;
}

// --- files ------------------------------------------------------------------------

/** Windows Search, by what is inside the files as well as their names. */
async function searchContents(query, max = 8) {
  const q = String(query).replace(/'/g, "''").replace(/"/g, '');
  const out = await ps(`
$c = New-Object -ComObject ADODB.Connection
$c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
$rs = New-Object -ComObject ADODB.Recordset
$sql = "SELECT TOP 40 System.ItemPathDisplay, System.DateModified FROM SystemIndex WHERE FREETEXT('${q}') AND System.ItemType <> 'Directory' ORDER BY System.Search.Rank DESC"
$rs.Open($sql, $c)
$n = 0
while (-not $rs.EOF -and $n -lt ${max}) {
  $p = [string]$rs.Fields.Item('System.ItemPathDisplay').Value
  if ($p -and $p -notmatch '\\\\AppData\\\\|\\\\node_modules\\\\|\\\\\\.git\\\\' -and (Test-Path -LiteralPath $p -PathType Leaf)) { $p; $n++ }
  $rs.MoveNext()
}
$rs.Close(); $c.Close()`, 25000);
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** Only files under the user's own folders, or a non-system drive, may be deleted. */
function deletable(full) {
  const home = os.homedir().toLowerCase();
  const p = full.toLowerCase();
  if (/\\(appdata|windows|program files|programdata|\.ssh|\.git)(\\|$)/i.test(full)) return false;
  return p.startsWith(home + path.sep) || (/^[d-z]:\\/i.test(full) && !/^[d-z]:\\$/i.test(full));
}

// --- the tools ---------------------------------------------------------------------

const desktopTools = (ctx) => [
  {
    name: 'arrange_window',
    appId: 'system',
    description: 'Move or resize an app\'s window: left or right half, top or bottom, a quarter, full screen or centred, on a chosen screen ("Notepad on the left", "Chrome full screen on my big monitor", "Spotify on the laptop screen"). Opens the app first if it is not open. Call once per app.',
    parameters: obj({
      app: str('The app, e.g. "chrome", "spotify", "code"'),
      position: { type: 'string', enum: POSITIONS, description: 'Where on the screen; keep to only change screens' },
      screen: str('Optional: "big", "laptop", "left", "right", "other", or a number counting from the left')
    }, ['app', 'position']),
    autoConfirm: true,
    run: async ({ app, position = 'keep', screen = '' }) => {
      const where = POSITIONS.includes(position) ? position : 'keep';
      let r = JSON.parse(await ps(ARRANGE_PS(String(app || ''), where, String(screen || ''))) || '{}');
      if (r.missing && ctx.bridge.openApp) {
        await ctx.bridge.openApp(String(app)).catch(() => null);
        for (let i = 0; i < 8 && r.missing; i++) {
          await sleep(700);
          r = JSON.parse(await ps(ARRANGE_PS(String(app || ''), where, String(screen || ''))) || '{}');
        }
      }
      if (!r.ok) return { ok: false, summary: `I couldn't find a ${app} window.` };
      const place = where === 'keep' ? '' : where === 'full' ? ' full screen' : where === 'center' ? ' in the middle' : ` on the ${where.replace('-', ' ')}`;
      const on = r.screens > 1 ? ` of screen ${r.screen}` : '';
      return { ok: true, summary: `${r.app} is${place}${on}.` };
    }
  },
  {
    name: 'press_button',
    appId: 'system',
    description: 'Press a button, tab, menu item or checkbox inside an app by its name, without moving the mouse ("in Spotify, turn on shuffle", "press Save in Word", "open the Settings tab in Discord"). Faster than use_computer; use it first for anything that is a named button.',
    parameters: obj({ name: str('The button\'s label, e.g. "Shuffle", "Save"'), app: str('The app it is in') }, ['name', 'app']),
    autoConfirm: true,
    run: async ({ name, app }) => {
      const win = await findWindow(ctx, app);
      if (!win) return { ok: false, summary: `${app} isn't open.` };
      const tree = await ctx.bridge.uiTree({ hwnd: win.hwnd, maxDepth: 12, maxChildren: 80 }).catch(() => null);
      const list = controls(tree && tree.tree);
      const hit = pickControl(list, name);
      if (!hit) {
        const some = [...new Set(list.map((c) => c.name))].slice(0, 12).join(', ');
        return { ok: false, summary: some ? `I couldn't find "${name}" in ${win.process}. I can see: ${some}.` : `${win.process} doesn't show its buttons to Windows; try use_computer instead.` };
      }
      if (RISKY_BUTTON.test(hit.name) && ctx.confirm) {
        const yes = await ctx.confirm({ title: `Press "${hit.name}" in ${win.process}?`, detail: 'That button sends, deletes or commits something.' });
        if (!yes) return { ok: false, cancelled: true, summary: 'Cancelled, nothing was pressed.' };
      }
      await ctx.bridge.clickElement({ hwnd: win.hwnd, name: hit.name });
      return { ok: true, summary: `Pressed ${hit.name} in ${win.process}.` };
    }
  },
  {
    name: 'search_file_contents',
    appId: 'system',
    description: 'Find files on this PC by what is written inside them, not just their names ("find my notes about the Tokyo trip", "the essay where I wrote about photosynthesis"). Uses Windows Search. Can open the best match.',
    parameters: obj({ query: str('Words that would be in the file'), open: { type: 'boolean', description: 'Open the best match' } }, ['query']),
    autoConfirm: true,
    run: async ({ query, open = false }) => {
      let files;
      try { files = await searchContents(query); } catch (err) { return { ok: false, summary: `Windows Search isn't answering: ${err.message}` }; }
      if (!files.length) return { ok: false, miss: true, summary: `No files mention "${query}".` };
      if (open) await ctx.bridge.openPath(files[0]).catch(() => null);
      return {
        ok: true,
        summary: `${open ? `Opened ${path.basename(files[0])}. ` : ''}Found ${files.length}: ${files.map((f) => path.basename(f)).join(', ')}.`,
        found: files.map((f) => ({ glyph: '📄', title: path.basename(f), subtitle: path.dirname(f), path: f }))
      };
    }
  },
  {
    name: 'read_clipboard',
    appId: 'system',
    description: 'What is on the clipboard right now ("what did I copy", "summarise what\'s on my clipboard").',
    parameters: obj({}),
    autoConfirm: true,
    run: async () => {
      const r = await ctx.bridge.call('getClipboard');
      const text = String((r && r.text) || '').trim();
      return text ? { ok: true, summary: text.slice(0, 4000) } : { ok: true, summary: 'The clipboard is empty, or holds something that is not text.' };
    }
  },
  {
    name: 'copy_to_clipboard',
    appId: 'system',
    description: 'Put text on the clipboard. With no text, copies your last answer ("copy that").',
    parameters: obj({ text: str('What to copy; leave out to copy the last answer') }),
    autoConfirm: true,
    run: async ({ text }) => {
      const value = String(text || (ctx.lastAnswer && ctx.lastAnswer()) || '').trim();
      if (!value) return { ok: false, summary: 'There is nothing to copy yet.' };
      await ctx.bridge.call('setClipboard', { text: value });
      return { ok: true, summary: 'Copied.', spoken: 'Copied.' };
    }
  },
  {
    name: 'watch_for',
    appId: 'system',
    description: 'Keep an eye on something and tell the user when it happens: a download finishing, or words appearing (or disappearing) in a window ("tell me when the download is done", "watch this page until it says shipped", "let me know when Codex says done"). Checks every 5 seconds for up to 3 hours. Optionally does something after.',
    parameters: obj({
      what: { type: 'string', enum: ['download', 'text'], description: 'download for files downloading, text for words on screen' },
      text: str('For text: the words to look for'),
      window: str('For text: the app or window to watch; leave out for the whole screen'),
      until: { type: 'string', enum: ['appears', 'disappears'] },
      then: str('Optional: something to do when it happens, in the user\'s words')
    }, ['what']),
    autoConfirm: true,
    run: async (args) => (ctx.watcher ? ctx.watcher.add(args) : { ok: false, summary: 'Watching is not available here.' })
  },
  {
    name: 'stop_watching',
    appId: 'system',
    description: 'Stop watching for things ("stop watching"), or list what is being watched.',
    parameters: obj({ list_only: { type: 'boolean', description: 'Only say what is being watched' } }),
    autoConfirm: true,
    run: async ({ list_only = false }) => {
      if (!ctx.watcher) return { ok: false, summary: 'Watching is not available here.' };
      const now = ctx.watcher.list();
      if (list_only) return { ok: true, summary: now.length ? `Watching ${now.map((w) => ctx.watcher.describe(w)).join('; ')}.` : 'Not watching anything.' };
      const n = ctx.watcher.stop();
      return { ok: true, summary: n ? `Stopped watching ${n === 1 ? 'it' : `all ${n}`}.` : 'I was not watching anything.' };
    }
  },
  {
    name: 'teach_shortcut',
    appId: 'system',
    description: 'Teach a phrase that stands for several actions: "when I say focus mode, close Discord and open my to-do list". Afterwards saying the phrase does all of them. Each step is a short instruction in plain words.',
    parameters: obj({
      phrase: str('What the user will say, e.g. "focus mode"'),
      steps: { type: 'array', items: { type: 'string' }, description: 'Each action in plain words, in order, e.g. ["close Discord", "open Notion"]' }
    }, ['phrase', 'steps']),
    autoConfirm: true,
    run: async ({ phrase, steps }) => {
      if (!ctx.shortcuts) return { ok: false, summary: 'Shortcuts are not available here.' };
      const e = ctx.shortcuts.teach(phrase, steps);
      return e ? { ok: true, summary: `Got it. Saying "${e.said}" will now do: ${e.sentences.join(', then ')}.` } : { ok: false, summary: 'I need a phrase and at least one thing to do.' };
    }
  },
  {
    name: 'forget_shortcut',
    appId: 'system',
    description: 'Forget a taught phrase or a learned shortcut, or list them ("what shortcuts do you know").',
    parameters: obj({ phrase: str('The phrase to forget; leave out to list them') }),
    autoConfirm: true,
    run: async ({ phrase }) => {
      if (!ctx.shortcuts) return { ok: false, summary: 'Shortcuts are not available here.' };
      if (!phrase) {
        const all = ctx.shortcuts.list();
        return { ok: true, summary: all.length ? `I know ${all.length}: ${all.map((s) => `"${s.said}"`).join(', ')}.` : 'No shortcuts yet. Teach me one, or ask for something twice.' };
      }
      const n = ctx.shortcuts.forget(phrase);
      return { ok: true, summary: n ? `Forgot ${n === 1 ? `"${phrase}"` : `${n} shortcuts`}.` : `I don't have a shortcut for "${phrase}".` };
    }
  },
  {
    name: 'delete_file',
    appId: 'system',
    description: 'Delete a file by moving it to the Recycle Bin, so it can be restored. Only the user\'s own folders. Give the full path; find it first with search_files.',
    parameters: obj({ path: str('Full path of the file') }, ['path']),
    mutating: true,
    confirm: ({ path: file } = {}) => ({ title: `Move ${path.basename(String(file || ''))} to the Recycle Bin?`, detail: String(file || '') }),
    run: async ({ path: file }) => {
      const full = path.resolve(String(file || ''));
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return { ok: false, summary: `No file at ${full}.` };
      if (!deletable(full)) return { ok: false, summary: 'I only delete files in your own folders.' };
      await ps(`Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(${psString(full)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`);
      return { ok: true, summary: `Moved ${path.basename(full)} to the Recycle Bin.` };
    }
  },
  ...serviceTools(ctx)
];

// --- services the user added in Settings -----------------------------------------

/**
 * A web API the user added in Settings → Plug-ins: its address, what it is,
 * and a key kept with the other credentials. Reading (GET) runs freely;
 * anything else asks first, with the exact request shown.
 */
function serviceTools(ctx) {
  const services = (ctx.config.get('services', []) || []).filter((s) => s && s.name && s.url && s.enabled !== false);
  if (!services.length) return [];
  return [{
    name: 'call_service',
    appId: 'system',
    description: `Call one of the user's own services by its web API. Services: ${services.map((s) => `${s.name} (${s.url}${s.about ? `: ${s.about}` : ''})`).join('; ')}. Use the API you know for that app. GET reads; other methods change things and are confirmed.`,
    parameters: obj({
      service: { type: 'string', enum: services.map((s) => s.name) },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: str('Path after the address, e.g. /api/states'),
      body: str('Optional JSON body')
    }, ['service', 'method', 'path']),
    autoConfirm: true,
    run: async ({ service, method = 'GET', path: p = '/', body = '' }) => {
      const s = services.find((x) => x.name === service);
      if (!s) return { ok: false, summary: `No service called ${service}.` };
      const verb = String(method).toUpperCase();
      const url = new URL(String(p || '/'), s.url.endsWith('/') ? s.url : `${s.url}/`).href;
      if (!url.startsWith(new URL(s.url).origin)) return { ok: false, summary: 'That address is not part of the service.' };
      if (verb !== 'GET' && ctx.confirm) {
        const yes = await ctx.confirm({ title: `${verb} to ${s.name}?`, detail: `${url}${body ? `\n${String(body).slice(0, 400)}` : ''}` });
        if (!yes) return { ok: false, cancelled: true, summary: 'Cancelled, nothing was sent.' };
      }
      const key = ctx.secret ? ctx.secret(`service:${s.name}`) : '';
      const headers = { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) };
      if (key) headers[s.keyHeader || 'Authorization'] = (s.keyHeader && s.keyHeader !== 'Authorization') ? key : `Bearer ${key}`;
      const res = await fetch(url, { method: verb, headers, body: verb === 'GET' ? undefined : (body || undefined), signal: AbortSignal.timeout(15000) });
      const text = (await res.text()).slice(0, 3500);
      return { ok: res.ok, summary: `${res.status}${text ? `: ${text}` : ''}` };
    }
  }];
}

module.exports = { desktopTools, pickControl, controls, deletable, RISKY_BUTTON };
