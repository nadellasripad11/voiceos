'use strict';
/**
 * Sets up texting Jarvis through Sendblue: asks for the keys and numbers,
 * stores them as Cloudflare secrets on the website (never in this folder),
 * and prints the webhook address to paste into Sendblue's dashboard.
 *
 *   node scripts/setup-texting.js
 *
 * Run it again any time to change a value; press Enter to keep the old one.
 */
const readline = require('readline');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const path = require('path');

const PROJECT = 'myjarvis';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

function put(name, value) {
  const wrangler = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  const run = spawnSync(require('fs').existsSync(wrangler) ? wrangler : 'npx', [...(require('fs').existsSync(wrangler) ? [] : ['wrangler']), 'pages', 'secret', 'put', name, '--project-name', PROJECT], {
    input: value, encoding: 'utf8', shell: process.platform === 'win32'
  });
  const ok = run.status === 0;
  console.log(ok ? `  saved ${name}` : `  could not save ${name}: ${(run.stderr || run.stdout || '').trim().split('\n').pop()}`);
  return ok;
}

const e164 = (n) => {
  const d = String(n).replace(/\D/g, '');
  return d.length === 10 ? `+1${d}` : d ? `+${d}` : '';
};

(async () => {
  console.log('Texting Jarvis through Sendblue. Find the keys at dashboard.sendblue.com → API Keys.\n');
  const keyId = await ask('Sendblue API Key ID: ');
  const secret = await ask('Sendblue API Secret: ');
  const line = e164(await ask("Jarvis's Sendblue phone number (the one Sendblue gave you): "));
  const mine = e164(await ask('Your own phone number (the only one Jarvis will answer): '));
  const tz = await ask('Your time zone [America/New_York]: ');
  rl.close();
  if (!keyId || !secret || !line || !mine) { console.log('\nAll four of the first answers are needed. Nothing was changed.'); process.exit(1); }

  const hook = crypto.randomBytes(18).toString('base64url');
  console.log('\nSaving to Cloudflare…');
  const ok = [
    put('SENDBLUE_KEY_ID', keyId),
    put('SENDBLUE_SECRET', secret),
    put('SENDBLUE_FROM', line),
    put('OWNER_PHONE', mine),
    put('SENDBLUE_HOOK', hook),
    put('OWNER_TZ', tz || 'America/New_York')
  ].every(Boolean);
  if (!ok) { console.log('\nSomething was not saved; see above. Run "npx wrangler login" first if it says you are not signed in.'); process.exit(1); }

  // Secrets reach the site on its next deploy.
  console.log('\nPutting the website live again so it picks them up…');
  spawnSync('npx', ['wrangler', 'pages', 'deploy', 'web', '--project-name', PROJECT, '--branch', 'main', '--commit-dirty=true'], { cwd: path.join(__dirname, '..'), stdio: 'inherit', shell: process.platform === 'win32' });

  console.log(`
Done. Two last steps in Sendblue's dashboard:

  1. Webhooks → Receive (inbound messages) → paste this address:

       https://myjarvis.pages.dev/api/sendblue/${hook}

     Keep it private: it is how Sendblue proves a text is real.

  2. On the free plan, add your number (${mine}) as a contact, then text
     ${line} once from your phone so Sendblue lets the messages through.

Then text Jarvis "what's the weather" and he'll text you back.`);
})();
