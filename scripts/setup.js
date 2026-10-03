'use strict';
/**
 * Fetches every local engine VoiceOS needs. Nothing here costs money and
 * nothing requires an account.
 *
 *   node scripts/setup.js                  # whisper.cpp + base.en model + piper voice
 *   node scripts/setup.js --model small.en # pick a different Whisper model
 *   node scripts/setup.js --skip-tts
 *   node scripts/setup.js --list
 *
 * Downloads land in vendor/ and models/, both gitignored.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { paths, ensureDirs } = require('../src/core/paths');

// --- Catalogues -----------------------------------------------------------

// Whisper GGML weights. Size vs accuracy; tiny/base are the realistic picks for
// a CPU-only laptop, small.en is the sweet spot if you have cores to spare.
const WHISPER_MODELS = {
  'tiny.en':   { file: 'ggml-tiny.en.bin',   mb: 75,   note: 'fastest, roughest' },
  'tiny':      { file: 'ggml-tiny.bin',      mb: 75,   note: 'fastest, multilingual' },
  'base.en':   { file: 'ggml-base.en.bin',   mb: 142,  note: 'default: good balance on CPU' },
  'base':      { file: 'ggml-base.bin',      mb: 142,  note: 'balanced, multilingual (100 languages)' },
  'small.en':  { file: 'ggml-small.en.bin',  mb: 466,  note: 'noticeably better, ~2x slower' },
  'small':     { file: 'ggml-small.bin',     mb: 466,  note: 'better, multilingual' },
  'medium.en': { file: 'ggml-medium.en.bin', mb: 1500, note: 'strong, needs a fast CPU or GPU' },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo.bin', mb: 1620, note: 'best quality/speed if you have a GPU' }
};
const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

// Prebuilt whisper.cpp binaries, so no C++ toolchain is required.
// Upstream publishes these on rolling build tags (b5130, b5127, …) rather than
// on the semver releases, so the asset is resolved through the API instead of
// being pinned to a URL that silently 404s later.
const WHISPER_BIN = {
  win32: {
    repo: 'ggml-org/whisper.cpp',
    // Ordered by preference. BLAS is markedly faster for CPU-only inference,
    // which is exactly the case on a laptop with no usable GPU.
    assetPreference: ['whisper-blas-bin-x64.zip', 'whisper-bin-x64.zip'],
    dir: 'whisper',
    exe: 'whisper-cli.exe',
    legacyExe: 'main.exe'
  }
};

async function resolveReleaseAsset(repo, preferences) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=15`, {
    headers: { 'User-Agent': 'voiceos-setup', Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status} while listing ${repo} releases`);
  const releases = await res.json();
  for (const name of preferences) {
    for (const rel of releases) {
      const asset = (rel.assets || []).find((a) => a.name === name);
      if (asset) {
        return { url: asset.browser_download_url, name: asset.name, tag: rel.tag_name, size: asset.size };
      }
    }
  }
  throw new Error(`None of [${preferences.join(', ')}] found in the latest ${repo} releases`);
}

// Piper: local neural TTS, fast enough on CPU for conversational replies.
const PIPER_BIN = {
  win32: {
    url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
    dir: 'piper',
    exe: 'piper.exe'
  }
};
const PIPER_VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const PIPER_VOICES = {
  // The most natural-sounding English voices Piper has. "high" is a larger
  // model, not a label, and libritts_r/hfc_female are trained on cleaner data
  // than the older medium voices, which is what makes them sound less synthetic.
  'en_US-hfc_female-medium':  { p: 'en/en_US/hfc_female/medium/en_US-hfc_female-medium',   mb: 63 },
  'en_US-libritts_r-medium':  { p: 'en/en_US/libritts_r/medium/en_US-libritts_r-medium',   mb: 75 },
  'en_GB-jenny_dioco-medium': { p: 'en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium', mb: 63 },
  'en_US-kristin-medium':     { p: 'en/en_US/kristin/medium/en_US-kristin-medium',         mb: 63 },
  'en_US-lessac-high':  { p: 'en/en_US/lessac/high/en_US-lessac-high',   mb: 114 },
  'en_US-amy-medium':   { p: 'en/en_US/amy/medium/en_US-amy-medium',     mb: 63 },
  'en_US-ryan-high':    { p: 'en/en_US/ryan/high/en_US-ryan-high',       mb: 114 },
  'en_GB-jenny_dioco-medium': { p: 'en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium', mb: 63 },
  'en_GB-alba-medium':  { p: 'en/en_GB/alba/medium/en_GB-alba-medium',   mb: 63 },
  'en_GB-alan-medium':  { p: 'en/en_GB/alan/medium/en_GB-alan-medium',   mb: 63 }
};

// --- Helpers --------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function human(bytes) {
  if (bytes > 1024 * 1024 * 1024) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes > 1024 * 1024) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

async function download(url, dest, label) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  have   ${label} (${human(fs.statSync(dest).size)})`);
    return dest;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';

  console.log(`  get    ${label}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${res.statusText} for ${url}`);

  const total = Number(res.headers.get('content-length') || 0);
  let seen = 0;
  let lastPrint = 0;
  const out = fs.createWriteStream(tmp);

  for await (const chunk of res.body) {
    out.write(chunk);
    seen += chunk.length;
    const now = Date.now();
    if (now - lastPrint > 400) {
      lastPrint = now;
      const pct = total ? ` ${Math.round((seen / total) * 100)}%` : '';
      process.stdout.write(`\r         ${human(seen)}${total ? ' / ' + human(total) : ''}${pct}   `);
    }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  process.stdout.write('\r' + ' '.repeat(50) + '\r');

  fs.renameSync(tmp, dest);
  console.log(`  done   ${label} (${human(fs.statSync(dest).size)})`);
  return dest;
}

function unzip(zipPath, destDir) {
  // Expand-Archive ships with Windows, so unzipping needs no npm dependency.
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
      (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(destDir))
    );
  });
}

/** Finds a named executable anywhere under a directory (zip layouts vary by release). */
function findExe(root, exeName) {
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase() === exeName.toLowerCase()) return full;
    }
  }
  return null;
}

// --- Steps ----------------------------------------------------------------

async function setupWhisperBinary() {
  const spec = WHISPER_BIN[process.platform];
  if (!spec) {
    console.log(`\nwhisper.cpp: no prebuilt binary configured for ${process.platform}.`);
    console.log('  Build from source: https://github.com/ggml-org/whisper.cpp');
    return null;
  }
  console.log('\nwhisper.cpp (speech recognition engine):');
  const dir = path.join(paths.vendor, spec.dir);
  let exe = findExe(dir, spec.exe) || findExe(dir, spec.legacyExe);
  if (exe) {
    console.log(`  have   ${path.relative(paths.app, exe)}`);
    return exe;
  }
  const asset = await resolveReleaseAsset(spec.repo, spec.assetPreference);
  console.log(`  using  ${asset.name} from ${spec.repo}@${asset.tag}`);
  const zip = path.join(paths.vendor, 'whisper-bin.zip');
  await download(asset.url, zip, `whisper.cpp binaries (${asset.name})`);
  console.log('  unzip  …');
  await unzip(zip, dir);
  fs.unlinkSync(zip);
  exe = findExe(dir, spec.exe) || findExe(dir, spec.legacyExe);
  if (!exe) throw new Error(`Could not find ${spec.exe} inside the extracted archive at ${dir}`);
  console.log(`  ready  ${path.relative(paths.app, exe)}`);
  return exe;
}

async function setupWhisperModel(key) {
  const spec = WHISPER_MODELS[key];
  if (!spec) {
    throw new Error(`Unknown model '${key}'. Known: ${Object.keys(WHISPER_MODELS).join(', ')}`);
  }
  console.log(`\nWhisper model '${key}' (~${spec.mb} MB, ${spec.note}):`);
  const dest = path.join(paths.models, spec.file);
  await download(MODEL_BASE + spec.file, dest, spec.file);
  return dest;
}

async function setupPiper(voiceKey) {
  const spec = PIPER_BIN[process.platform];
  if (!spec) {
    console.log(`\nPiper: no prebuilt binary for ${process.platform}; spoken replies will fall back to the system voice.`);
    return null;
  }
  console.log('\nPiper (local neural text-to-speech):');
  const dir = path.join(paths.vendor, spec.dir);
  let exe = findExe(dir, spec.exe);
  if (!exe) {
    const zip = path.join(paths.vendor, 'piper.zip');
    await download(spec.url, zip, 'piper binaries');
    console.log('  unzip  …');
    await unzip(zip, dir);
    fs.unlinkSync(zip);
    exe = findExe(dir, spec.exe);
    if (!exe) throw new Error('Could not find piper.exe inside the extracted archive');
  }
  console.log(`  ready  ${path.relative(paths.app, exe)}`);

  const voice = PIPER_VOICES[voiceKey];
  if (!voice) throw new Error(`Unknown voice '${voiceKey}'. Known: ${Object.keys(PIPER_VOICES).join(', ')}`);
  console.log(`\nPiper voice '${voiceKey}' (~${voice.mb} MB):`);
  const voiceDir = path.join(paths.models, 'piper');
  await download(`${PIPER_VOICE_BASE}${voice.p}.onnx`, path.join(voiceDir, `${voiceKey}.onnx`), `${voiceKey}.onnx`);
  await download(`${PIPER_VOICE_BASE}${voice.p}.onnx.json`, path.join(voiceDir, `${voiceKey}.onnx.json`), `${voiceKey}.onnx.json`);
  return exe;
}

async function checkOllama(baseUrl) {
  console.log('\nOllama (the reasoning engine):');
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { models = [] } = await res.json();
    console.log(`  running at ${baseUrl} with ${models.length} model(s):`);
    for (const m of models.slice(0, 12)) {
      console.log(`    - ${m.name}  (${human(m.size || 0)})`);
    }
    if (!models.length) {
      console.log('  No models pulled yet. For this machine start with:');
      console.log('      ollama pull qwen2.5:3b-instruct');
    }
    return true;
  } catch {
    console.log('  not reachable.');
    console.log('  Install it (free) from https://ollama.com/download, then:');
    console.log('      ollama pull qwen2.5:3b-instruct     # light, for dictation polish');
    console.log('      ollama pull qwen2.5:7b-instruct     # better tool-calling for Agent Mode');
    console.log('  Or skip local models and use a free cloud key (Groq / Google AI Studio)');
    console.log('  from Settings → Brain. Both have permanently free tiers.');
    return false;
  }
}

function printCatalogue() {
  console.log('\nWhisper models:');
  for (const [k, v] of Object.entries(WHISPER_MODELS)) {
    console.log(`  ${k.padEnd(16)} ~${String(v.mb).padStart(5)} MB   ${v.note}`);
  }
  console.log('\nPiper voices:');
  for (const [k, v] of Object.entries(PIPER_VOICES)) {
    console.log(`  ${k.padEnd(22)} ~${v.mb} MB`);
  }
}

(async () => {
  if (flag('list')) return printCatalogue();

  ensureDirs();
  const model = opt('model', 'base.en');
  const voice = opt('voice', 'en_US-amy-medium');

  console.log('VoiceOS setup — everything below is free and runs on your machine.');
  console.log(`Machine: ${os.cpus().length} cores, ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB RAM, ${process.platform}`);

  const summary = {};
  try {
    summary.whisperExe = await setupWhisperBinary();
    summary.whisperModel = await setupWhisperModel(model);
    if (!flag('skip-tts')) summary.piperExe = await setupPiper(voice);
    summary.ollama = await checkOllama('http://127.0.0.1:11434');
  } catch (err) {
    console.error(`\nSetup failed: ${err.message}`);
    process.exit(1);
  }

  console.log('\nSummary');
  console.log(`  whisper binary : ${summary.whisperExe ? 'ready' : 'missing'}`);
  console.log(`  whisper model  : ${summary.whisperModel ? path.basename(summary.whisperModel) : 'missing'}`);
  console.log(`  piper          : ${summary.piperExe ? 'ready' : 'skipped/unavailable'}`);
  console.log(`  ollama         : ${summary.ollama ? 'running' : 'not running (see above)'}`);
  console.log('\nNext: npm start');
})();
