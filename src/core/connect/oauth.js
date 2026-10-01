'use strict';
/**
 * OAuth 2.0 for a desktop app.
 *
 * Authorization Code with PKCE, redirecting to a loopback address this process
 * listens on. That is the flow Google and Microsoft document for native apps:
 * it needs no hosted callback, no server and no money, and PKCE means a client
 * secret is not required to be secret (desktop clients cannot keep one anyway).
 *
 * The consent screen opens in the user's own browser rather than inside the
 * app, which is both what the providers require and what lets the user see the
 * real address bar before typing a password.
 */
const http = require('http');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

const base64url = (buf) => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Minimal styled page shown in the browser once the redirect lands. */
function resultPage(title, message, ok = true) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#0f1115;
       font-family:-apple-system,"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;color:#f2f2f4}
  .card{max-width:420px;padding:36px 40px;background:#1f1f22;border:1px solid rgba(255,255,255,.08);
        border-radius:18px;text-align:center}
  .dot{width:12px;height:12px;border-radius:50%;background:${ok ? '#30d158' : '#ff453a'};
       margin:0 auto 18px;box-shadow:0 0 0 7px ${ok ? 'rgba(48,209,88,.15)' : 'rgba(255,69,58,.15)'}}
  h1{font-size:19px;font-weight:620;letter-spacing:-.02em;margin-bottom:8px}
  p{font-size:14px;line-height:1.55;color:rgba(242,242,244,.6)}
</style></head><body><div class="card"><div class="dot"></div>
<h1>${title}</h1><p>${message}</p></div></body></html>`;
}

/**
 * Runs one authorization.
 *
 * @param {object} opts
 * @param {string} opts.authUrl      provider's authorization endpoint
 * @param {string} opts.tokenUrl     provider's token endpoint
 * @param {string} opts.clientId
 * @param {string} [opts.clientSecret] some providers still require it
 * @param {string[]} opts.scopes
 * @param {object} [opts.extraAuthParams]
 * @param {(url: string) => Promise<any>} opts.openUrl how to open the browser
 * @returns {Promise<{accessToken, refreshToken, expiresAt, scopes, raw}>}
 */
async function authorize({
  authUrl,
  tokenUrl,
  clientId,
  clientSecret,
  scopes = [],
  extraAuthParams = {},
  openUrl,
  timeoutMs = 300000,
  logger = console
}) {
  if (!clientId) throw new Error('No client ID configured for this provider.');

  const { verifier, challenge } = pkcePair();
  const state = base64url(crypto.randomBytes(16));

  const { server, port, waitForCode } = await startLoopbackServer({ state, timeoutMs, logger });
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extraAuthParams
  });

  const consentUrl = `${authUrl}?${params.toString()}`;
  logger.info?.('[oauth] opening the consent screen in your browser');
  await openUrl(consentUrl);

  let code;
  try {
    code = await waitForCode;
  } finally {
    // Always release the port, including when the user cancels.
    try { server.close(); } catch {}
  }

  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  let data;
  try { data = JSON.parse(text); }
  catch { data = Object.fromEntries(new URLSearchParams(text)); } // some providers reply form-encoded

  if (data.error) throw new Error(`${data.error}: ${data.error_description || ''}`);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null,
    scopes: data.scope ? String(data.scope).split(/[\s,]+/) : scopes,
    raw: data
  };
}

/** Listens on an ephemeral loopback port for the provider's redirect. */
function startLoopbackServer({ state, timeoutMs, logger }) {
  return new Promise((resolve, reject) => {
    let settle;
    const waitForCode = new Promise((res, rej) => { settle = { res, rej }; });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      const reply = (status, page) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page);
      };

      if (error) {
        reply(200, resultPage('Not connected',
          error === 'access_denied'
            ? 'You declined the request. Nothing was changed.'
            : `The provider reported: ${error}`, false));
        settle.rej(new Error(error === 'access_denied' ? 'You declined the request.' : error));
        return;
      }

      // A mismatched state means this redirect did not originate from the
      // request we made, so the code must not be exchanged.
      if (returnedState !== state) {
        reply(400, resultPage('Could not verify that request',
          'The response did not match the request VoiceOS made, so it was ignored.', false));
        settle.rej(new Error('OAuth state mismatch; the redirect was ignored'));
        return;
      }

      if (!code) {
        reply(400, resultPage('No authorization code', 'The provider did not return a code.', false));
        settle.rej(new Error('No authorization code in the redirect'));
        return;
      }

      reply(200, resultPage('Connected', 'You can close this tab and go back to VoiceOS.'));
      settle.res(code);
    });

    server.on('error', reject);

    // Port 0 lets the OS pick a free port; the redirect URI is built from it.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      logger.debug?.(`[oauth] listening on 127.0.0.1:${port}`);

      const timer = setTimeout(() => {
        try { server.close(); } catch {}
        settle.rej(new Error('Timed out waiting for you to finish in the browser.'));
      }, timeoutMs);
      waitForCode.finally(() => clearTimeout(timer)).catch(() => {});

      resolve({ server, port, waitForCode });
    });
  });
}

/**
 * Exchanges a refresh token for a fresh access token.
 * Returns null when the provider issued no refresh token, which is the signal
 * to ask the user to connect again rather than failing silently.
 */
async function refresh({ tokenUrl, clientId, clientSecret, refreshToken, scopes = [] }) {
  if (!refreshToken) return null;

  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Refresh failed (HTTP ${res.status}): ${text.slice(0, 200)}`);

  const data = JSON.parse(text);
  if (data.error) throw new Error(`${data.error}: ${data.error_description || ''}`);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null,
    scopes: data.scope ? String(data.scope).split(/[\s,]+/) : scopes
  };
}

module.exports = { authorize, refresh, pkcePair };
