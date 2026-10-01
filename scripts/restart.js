'use strict';
/**
 * Stops any running VoiceOS and starts a fresh one.
 *
 * Electron's single-instance lock means launching again just exits, so after a
 * code change the previous copy keeps owning the global shortcuts and the new
 * code never runs. That looks exactly like "the shortcuts stopped working", so
 * restarting is a first-class command rather than something to remember.
 */
const { execFile, spawn } = require('child_process');
const path = require('path');

const dev = process.argv.includes('--dev');
const root = path.resolve(__dirname, '..');
const electron = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

function killExisting() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(0);
    execFile('taskkill', ['/F', '/IM', 'electron.exe'], (err, stdout) => {
      const killed = (String(stdout).match(/SUCCESS/g) || []).length;
      resolve(killed);
    });
  });
}

(async () => {
  const killed = await killExisting();
  if (killed) console.log(`Stopped ${killed} running VoiceOS process${killed === 1 ? '' : 'es'}.`);
  // Give Windows a moment to release the single-instance lock.
  await new Promise((r) => setTimeout(r, 700));

  console.log('Starting VoiceOS…');
  const child = spawn(electron, dev ? ['.', '--dev'] : ['.'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  child.on('exit', (code) => process.exit(code ?? 0));
})();
