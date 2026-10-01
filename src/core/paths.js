'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// Resolved without importing electron so that core/ stays usable from plain
// node scripts (setup, doctor, tests).
const APP_DIR = path.resolve(__dirname, '..', '..');

function userDataDir() {
  if (process.env.VOICEOS_USERDATA) return process.env.VOICEOS_USERDATA;
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'VoiceOS');
}

const paths = {
  app: APP_DIR,
  vendor: path.join(APP_DIR, 'vendor'),
  models: path.join(APP_DIR, 'models'),
  userData: userDataDir(),
  get config() { return path.join(paths.userData, 'config.json'); },
  get transcripts() { return path.join(paths.userData, 'transcripts'); },
  get audio() { return path.join(paths.userData, 'audio'); },
  get logs() { return path.join(paths.userData, 'logs'); },
  get reminders() { return path.join(paths.userData, 'reminders.json'); },
  get credentials() { return path.join(paths.userData, 'credentials.json'); },
  get tmp() { return path.join(paths.userData, 'tmp'); }
};

function ensureDirs() {
  for (const d of [paths.userData, paths.transcripts, paths.audio, paths.logs, paths.tmp, paths.vendor, paths.models]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

module.exports = { paths, ensureDirs };
