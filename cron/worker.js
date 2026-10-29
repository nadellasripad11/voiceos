/**
 * Jarvis's clock: once a minute, tells the website it is time to run
 * whatever reminders and routines are due. Cloudflare Pages cannot run on
 * a timer itself, so this tiny Worker does the knocking.
 *
 * Its key lives in the shared D1 database (the site keeps only the hash
 * there to check against), so no secret has to be set anywhere.
 *
 *   cd cron && npx wrangler deploy
 */
const SITE = 'https://myjarvis.pages.dev';

const sha256 = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function key(env) {
  const row = await env.DB.prepare('SELECT key FROM cron_key WHERE k = 1').first();
  if (row && row.key) return row.key;
  const fresh = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare('INSERT OR REPLACE INTO cron_key (k, hash, key) VALUES (1, ?, ?)').bind(await sha256(fresh), fresh).run();
  return fresh;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const res = await fetch(`${SITE}/api/cron/tick`, { method: 'POST', headers: { Authorization: `Bearer ${await key(env)}`, 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) console.log('tick failed', res.status, await res.text());
    })());
  },
  async fetch() { return new Response('Jarvis clock. Nothing to see.', { status: 404 }); }
};
