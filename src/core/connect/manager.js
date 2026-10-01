'use strict';
/**
 * Connection manager.
 *
 * The one place that knows how to connect a provider, hand a valid token to a
 * tool, and keep tokens fresh. Tools ask for `tokenFor(appId)` and never touch
 * the account store, so the refresh logic lives in exactly one place.
 */
const { AccountStore } = require('./accounts');
const { PROVIDERS, providerForApp, needsConnection } = require('./providers');
const { authorize, refresh } = require('./oauth');

/** Refresh this long before actual expiry, so a call never races the clock. */
const REFRESH_MARGIN_MS = 120000;

class ConnectionManager {
  constructor({ config, bridge, browser, logger = console, credentials }) {
    this.config = config;
    this.bridge = bridge;
    this.browser = browser;
    this.logger = logger;
    // Client IDs and secrets live with the other secrets, not in config.json.
    this.credentials = credentials;
    this.accounts = new AccountStore({ logger });
    this.refreshing = new Map();
  }

  // --- App-facing ---------------------------------------------------------

  /**
   * Returns a ready-to-use credential for an app, refreshing if needed.
   * @returns {Promise<{token, provider, account, fields}|null>}
   */
  async tokenFor(appId) {
    const provider = providerForApp(appId);
    if (!provider) return null;

    const account = this.accounts.forApp(appId, provider.id);
    if (!account) return null;

    if (provider.kind === 'token') {
      return {
        token: account.tokens.accessToken,
        provider: provider.id,
        account,
        fields: account.meta || {}
      };
    }

    if (provider.kind !== 'oauth') {
      return { token: null, provider: provider.id, account, fields: account.meta || {} };
    }

    const fresh = await this.ensureFresh(provider, account);
    return {
      token: fresh.tokens.accessToken,
      provider: provider.id,
      account: fresh,
      fields: fresh.meta || {}
    };
  }

  /**
   * Refreshes an access token when it is close to expiring.
   *
   * Concurrent callers share one in-flight refresh: two tools asking at the
   * same moment would otherwise each spend the refresh token, and some
   * providers invalidate the previous one on use.
   */
  async ensureFresh(provider, account) {
    const expiresAt = account.tokens.expiresAt;
    if (!expiresAt || Date.now() < expiresAt - REFRESH_MARGIN_MS) return account;

    const key = `${provider.id}:${account.accountId}`;
    if (this.refreshing.has(key)) return this.refreshing.get(key);

    const task = (async () => {
      const app = this.clientFor(provider.id);
      if (!account.tokens.refreshToken) {
        throw new Error(`${provider.name} needs to be connected again — no refresh token was issued.`);
      }
      this.logger.info?.(`[connect] refreshing ${provider.name} for ${account.label}`);
      const next = await refresh({
        tokenUrl: provider.tokenUrl,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        refreshToken: account.tokens.refreshToken,
        scopes: provider.scopes
      });
      return this.accounts.upsert({
        provider: provider.id,
        accountId: account.accountId,
        label: account.label,
        tokens: next
      });
    })();

    this.refreshing.set(key, task);
    try { return await task; }
    finally { this.refreshing.delete(key); }
  }

  // --- Connecting ---------------------------------------------------------

  /** The OAuth client the user registered for a provider. */
  clientFor(providerId) {
    const all = this.credentials.read();
    const entry = all[`oauth:${providerId}`] || {};
    return { clientId: entry.clientId || '', clientSecret: entry.clientSecret || '' };
  }

  setClient(providerId, { clientId, clientSecret }) {
    const all = this.credentials.read();
    all[`oauth:${providerId}`] = { clientId, clientSecret: clientSecret || '' };
    this.credentials.write(all);
    return { ok: true };
  }

  /**
   * Connects a provider.
   * @param {string} providerId
   * @param {object} input  token / fields for non-OAuth providers
   */
  async connect(providerId, input = {}) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider '${providerId}'`);

    switch (provider.kind) {
      case 'oauth': return this.connectOauth(provider);
      case 'token': return this.connectToken(provider, input);
      case 'browser': return this.connectBrowser(provider);
      case 'local': return this.connectLocal(provider, input);
      default: throw new Error(`Cannot connect a '${provider.kind}' provider`);
    }
  }

  async connectOauth(provider) {
    const app = this.clientFor(provider.id);
    if (!app.clientId) {
      const err = new Error(`${provider.name} needs a client ID first.`);
      err.needsSetup = provider.setup;
      err.providerId = provider.id;
      throw err;
    }

    const tokens = await authorize({
      authUrl: provider.authUrl,
      tokenUrl: provider.tokenUrl,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      scopes: provider.scopes,
      extraAuthParams: provider.extraAuthParams,
      openUrl: (url) => this.bridge.openUrl(url),
      logger: this.logger
    });

    const who = await provider.identify(tokens.accessToken);
    const account = this.accounts.upsert({
      provider: provider.id,
      accountId: who.accountId,
      label: who.label,
      tokens,
      meta: who.meta
    });

    this.logger.info?.(`[connect] ${provider.name} connected as ${account.label}`);
    return { ok: true, provider: provider.id, label: account.label, apps: provider.apps };
  }

  async connectToken(provider, input) {
    const token = String(input.token || '').trim();
    if (!token) throw new Error(`Paste your ${provider.name} token first.`);

    // Verifying before storing means a typo is reported immediately rather
    // than surfacing later as a confusing tool failure.
    const who = await provider.identify(token, input);
    const account = this.accounts.upsert({
      provider: provider.id,
      accountId: who.accountId,
      label: who.label,
      tokens: { accessToken: token, expiresAt: null },
      meta: { ...who.meta, ...stripToken(input) }
    });

    this.logger.info?.(`[connect] ${provider.name} connected as ${account.label}`);
    return { ok: true, provider: provider.id, label: account.label, apps: provider.apps };
  }

  /**
   * Opens the service in the VoiceOS browser profile and waits for a sign-in.
   * Nothing is stored but the fact of the session; the cookies live in the
   * browser profile, which is the point.
   */
  async connectBrowser(provider) {
    const { page } = await this.browser.openOrReuse(provider.url, new URL(provider.url).hostname);
    const deadline = Date.now() + 180000;

    while (Date.now() < deadline) {
      try {
        const signedIn = await page.evaluate(
          `!!document.querySelector(${JSON.stringify(provider.signedInSelector)})`
        );
        if (signedIn) {
          const account = this.accounts.upsert({
            provider: provider.id,
            accountId: 'browser',
            label: `${provider.name} (browser session)`,
            tokens: { accessToken: null, expiresAt: null },
            meta: { url: provider.url }
          });
          this.logger.info?.(`[connect] ${provider.name} session detected`);
          return { ok: true, provider: provider.id, label: account.label, apps: provider.apps };
        }
      } catch { /* page still navigating */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`Timed out waiting for you to sign in to ${provider.name}.`);
  }

  async connectLocal(provider, input) {
    const paths = [].concat(input.paths || input.path || []);
    if (!paths.length) throw new Error('Pick a folder first.');

    const account = this.accounts.upsert({
      provider: provider.id,
      accountId: 'local',
      label: paths.length === 1 ? paths[0] : `${paths.length} folders`,
      tokens: { accessToken: null, expiresAt: null },
      meta: { paths }
    });

    // Folder choices also drive the file tools' allow-list.
    if (provider.id === 'files') this.config.set('apps.files.config.roots', paths);
    if (provider.id === 'obsidian') this.config.set('apps.obsidian.config.vault', paths[0]);

    return { ok: true, provider: provider.id, label: account.label, apps: provider.apps };
  }

  disconnect(providerId, accountId) {
    this.accounts.remove(providerId, accountId);
    this.logger.info?.(`[connect] disconnected ${providerId}:${accountId}`);
    return { ok: true };
  }

  // --- Status -------------------------------------------------------------

  /** Everything the UI needs to render connection state, with no secrets. */
  status() {
    const accounts = this.accounts.publicList();
    const appDefaults = this.accounts.appDefaults();
    const byProvider = {};

    for (const provider of Object.values(PROVIDERS)) {
      const mine = accounts.filter((a) => a.provider === provider.id);
      byProvider[provider.id] = {
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        apps: provider.apps,
        multiAccount: Boolean(provider.multiAccount),
        extraFields: provider.extraFields || [],
        setup: provider.setup || null,
        hasClient: provider.kind === 'oauth' ? Boolean(this.clientFor(provider.id).clientId) : true,
        accounts: mine,
        connected: mine.length > 0
      };
    }

    return { providers: byProvider, accounts, appDefaults };
  }

  /** Connection state for one app, used by the App Store cards. */
  appStatus(appId) {
    const provider = providerForApp(appId);
    if (!provider) return { needsConnection: false, connected: true };

    const account = this.accounts.forApp(appId, provider.id);
    return {
      needsConnection: needsConnection(appId),
      provider: provider.id,
      providerName: provider.name,
      kind: provider.kind,
      connected: Boolean(account),
      account: account ? { label: account.label, accountId: account.accountId } : null,
      sharedWith: provider.apps.filter((a) => a !== appId)
    };
  }
}

/** Keeps the raw token out of the metadata blob. */
function stripToken(input) {
  const { token, ...rest } = input || {};
  return rest;
}

module.exports = { ConnectionManager };
