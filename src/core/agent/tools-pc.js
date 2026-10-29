'use strict';
/**
 * The rest of the PC: brightness, battery and Wi-Fi, closing apps, tidying
 * Downloads, the screen to the website, files to the phone, and driving any
 * app with the keyboard and mouse.
 *
 * Everything that changes something is left without autoConfirm, so the
 * agent asks first; reading the state of the machine does not ask.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One PowerShell command, its output as text. */
function ps(command, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20 }, (err, out, errOut) => {
      if (err) reject(new Error(String(errOut || err.message).trim().split('\n')[0]));
      else resolve(String(out).trim());
    });
  });
}
const psString = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function screenshot(ctx) {
  const file = path.join(os.tmpdir(), `jarvis-screen-${Date.now()}.png`);
  const shot = await ctx.bridge.screenshot(file);
  const data = fs.readFileSync(shot.path || file).toString('base64');
  try { fs.unlinkSync(shot.path || file); } catch { /* temp */ }
  return { data, bounds: shot.bounds || (await ctx.bridge.screenInfo()) };
}

const pcTools = (ctx) => [
  {
    name: 'set_brightness',
    appId: 'system',
    description: 'Set the screen brightness to a percentage (laptop screens).',
    parameters: obj({ percent: num('0 to 100') }, ['percent']),
    autoConfirm: true,
    run: async ({ percent }) => {
      const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
      await ps(`(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${p})`);
      return { ok: true, summary: `Brightness set to ${p}%.` };
    }
  },
  {
    name: 'system_status',
    appId: 'system',
    description: 'How the laptop is doing: battery, Wi-Fi network, free memory and disk, and the apps using the most memory.',
    parameters: obj({}),
    autoConfirm: true,
    run: async () => {
      const out = await ps(`
$b = Get-CimInstance Win32_Battery | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$d = Get-PSDrive C
$wifi = (netsh wlan show interfaces) -match '^\\s+SSID\\s+:' | Select-Object -First 1
$top = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 | ForEach-Object { "$($_.ProcessName) $([math]::Round($_.WorkingSet64/1MB))MB" }
"battery: " + $(if ($b) { "$($b.EstimatedChargeRemaining)% " + $(if ($b.BatteryStatus -eq 2) { 'charging' } else { 'on battery' }) } else { 'none' })
"wifi: " + $(if ($wifi) { ($wifi -split ':',2)[1].Trim() } else { 'not connected' })
"memory free: $([math]::Round($os.FreePhysicalMemory/1MB,1)) GB of $([math]::Round($os.TotalVisibleMemorySize/1MB,1)) GB"
"disk C free: $([math]::Round($d.Free/1GB)) GB"
"top apps: " + ($top -join ', ')`);
      return { ok: true, summary: out };
    }
  },
  {
    name: 'close_app',
    appId: 'system',
    description: 'Close (end) an app that is open or frozen, by its name, e.g. "chrome", "spotify".',
    parameters: obj({ name: str('The app or process name') }, ['name']),
    run: async ({ name }) => {
      const n = String(name || '').replace(/\.exe$/i, '').trim();
      if (!n || /^(explorer|winlogon|csrss|lsass|svchost|system|electron|voiceos)$/i.test(n)) return { ok: false, summary: `I won't close ${n || 'that'}.` };
      const out = await ps(`$p = Get-Process -Name ${psString(n)} -ErrorAction SilentlyContinue; if ($p) { $p | Stop-Process -Force; "$($p.Count)" } else { '0' }`);
      return Number(out) > 0 ? { ok: true, summary: `Closed ${n}.` } : { ok: false, summary: `${n} is not running.` };
    }
  },
  {
    name: 'tidy_downloads',
    appId: 'system',
    description: 'Tidy the Downloads folder: sort loose files into folders by type (Documents, Images, Videos, Installers, Archives, Other). Nothing is deleted.',
    parameters: obj({}),
    run: async () => {
      const dir = path.join(os.homedir(), 'Downloads');
      const kinds = { Documents: /\.(pdf|docx?|pptx?|xlsx?|txt|csv|md|odt)$/i, Images: /\.(png|jpe?g|gif|webp|heic|svg)$/i, Videos: /\.(mp4|mov|mkv|webm|avi)$/i, Audio: /\.(mp3|wav|m4a|flac)$/i, Installers: /\.(exe|msi|msix)$/i, Archives: /\.(zip|rar|7z|tar|gz)$/i };
      let moved = 0;
      for (const f of fs.readdirSync(dir)) {
        const from = path.join(dir, f);
        if (!fs.statSync(from).isFile() || /\.(crdownload|part|tmp)$/i.test(f)) continue;
        const kind = Object.keys(kinds).find((k) => kinds[k].test(f)) || 'Other';
        fs.mkdirSync(path.join(dir, kind), { recursive: true });
        let to = path.join(dir, kind, f);
        if (fs.existsSync(to)) to = path.join(dir, kind, `${path.parse(f).name} (${Date.now()})${path.extname(f)}`);
        fs.renameSync(from, to);
        moved++;
      }
      return { ok: true, summary: moved ? `Sorted ${moved} files in Downloads into folders.` : 'Downloads is already tidy.' };
    }
  },
  {
    name: 'show_screen',
    appId: 'system',
    description: 'Send a picture of the laptop screen to the user\'s website or phone, when they ask to see their screen.',
    parameters: obj({}),
    autoConfirm: true,
    run: async () => {
      if (!ctx.webLink) return { ok: false, summary: 'Only works when you asked from the website or the phone.' };
      const { data } = await screenshot(ctx);
      const r = await ctx.webLink.sendFile({ name: `screen-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`, type: 'image/png', data });
      return { ok: true, summary: `Here is your screen: ${r.url}`, found: [{ title: 'Your screen', url: r.url }] };
    }
  },
  {
    name: 'send_file',
    appId: 'system',
    description: 'Send a file from this laptop to the user\'s website or phone so they can open or download it there. Give the full path, or find it first with search_files.',
    parameters: obj({ path: str('Full path of the file') }, ['path']),
    run: async ({ path: file }) => {
      if (!ctx.webLink) return { ok: false, summary: 'Sending files needs the website link.' };
      const full = path.resolve(String(file || ''));
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return { ok: false, summary: `No file at ${full}.` };
      if (/\\(AppData|\.ssh|\.aws)\\|credentials|\.env$|password/i.test(full)) return { ok: false, summary: 'I won\'t send that file: it may hold keys or passwords.' };
      const size = fs.statSync(full).size;
      if (size > 25 << 20) return { ok: false, summary: 'That file is over 25MB, too big to send.' };
      const r = await ctx.webLink.sendFile({ name: path.basename(full), type: '', data: fs.readFileSync(full).toString('base64') });
      return { ok: true, summary: `Sent ${path.basename(full)}: ${r.url}`, found: [{ title: path.basename(full), url: r.url }] };
    }
  },
  {
    name: 'save_from_website',
    appId: 'system',
    description: 'Save a file the user uploaded on the website or phone (it has a file id) onto this laptop, in Downloads unless a folder is given.',
    parameters: obj({ id: str('The uploaded file id'), folder: str('Optional folder path') }, ['id']),
    autoConfirm: true,
    run: async ({ id, folder }) => {
      if (!ctx.webLink) return { ok: false, summary: 'Needs the website link.' };
      const { name, data } = await ctx.webLink.fetchFile(String(id));
      const dir = folder ? path.resolve(String(folder)) : path.join(os.homedir(), 'Downloads');
      fs.mkdirSync(dir, { recursive: true });
      let to = path.join(dir, path.basename(name));
      if (fs.existsSync(to)) to = path.join(dir, `${path.parse(name).name} (${Date.now()})${path.extname(name)}`);
      fs.writeFileSync(to, data);
      return { ok: true, summary: `Saved ${path.basename(to)} to ${dir}.` };
    }
  },
  {
    name: 'use_computer',
    appId: 'system',
    description: 'Operate any app on the laptop with the mouse and keyboard, looking at the screen, for things no other tool does (e.g. "in Word, make the title bold", "change a setting in Discord"). Slower; prefer specific tools when they exist.',
    parameters: obj({ goal: str('What to get done, in plain words') }, ['goal']),
    run: async ({ goal }, { signal } = {}) => {
      if (!ctx.see) return { ok: false, summary: 'Seeing the screen needs a Gemini key.' };
      const done = [];
      for (let step = 0; step < 15; step++) {
        if (signal && signal.aborted) break;
        const { data, bounds } = await screenshot(ctx);
        ctx.browserFrame({ data, url: 'Your screen' });
        const reply = await ctx.see({
          image: data,
          mime: 'image/png',
          prompt: `GOAL: ${goal}\nSTEPS SO FAR: ${done.join(' | ') || '(none)'}\n\nYou are operating this Windows screen. Reply with ONLY one JSON object, the single next step:\n{"do":"click","x":0-1000,"y":0-1000,"why":"..."} (x,y as fractions of width/height times 1000)\n{"do":"double_click","x":..,"y":..}\n{"do":"type","text":"..."}\n{"do":"keys","combo":"ctrl+s"}  (e.g. enter, tab, esc, ctrl+a, alt+f4, win)\n{"do":"wait"}\n{"do":"done","summary":"what was achieved"}\n{"do":"stuck","summary":"why"}\nNever type passwords or payment details; reply stuck if they are needed.`
        });
        let act;
        try { act = JSON.parse(String(reply).replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { act = { do: 'stuck', summary: 'I could not work out the next step.' }; }
        if (act.do === 'done' || act.do === 'stuck') { ctx.browserFrame({ done: true }); return { ok: act.do === 'done', summary: act.summary || (act.do === 'done' ? 'Done.' : 'I got stuck.') }; }
        const at = (v, size, off) => Math.round(off + (Math.max(0, Math.min(1000, Number(v))) / 1000) * size);
        if (act.do === 'click' || act.do === 'double_click') {
          const x = at(act.x, bounds.width, bounds.x || 0), y = at(act.y, bounds.height, bounds.y || 0);
          await ctx.bridge.mouseClick(x, y);
          if (act.do === 'double_click') { await sleep(80); await ctx.bridge.mouseClick(x, y); }
        } else if (act.do === 'type') await ctx.bridge.typeText(String(act.text || ''));
        else if (act.do === 'keys') await ctx.bridge.keys(String(act.combo || ''));
        done.push(`${act.do}${act.text ? ` "${String(act.text).slice(0, 40)}"` : ''}${act.combo ? ` ${act.combo}` : ''}${act.why ? ` (${act.why})` : ''}`);
        await sleep(act.do === 'wait' ? 1500 : 700);
      }
      ctx.browserFrame({ done: true });
      return { ok: false, summary: `I took 15 steps and stopped: ${done.slice(-3).join(' | ')}` };
    }
  }
];

module.exports = { pcTools, ps };
