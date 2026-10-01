'use strict';
/**
 * Connected account storage.
 *
 * Several accounts may be connected per provider — two Gmail addresses, a
 * personal and a school Google account — so accounts are keyed by
 * `provider:accountId` rather than by provider alone. Each app that uses a
 * provider records which account is its default, which is what lets one Google
 * consent serve Gmail, Calendar, Drive and Classroom at once.
 *
 * Tokens live in their own file, never in config.json, so exporting or sharing
 * settings cannot leak them. They are never sent to a renderer: the UI is told
 * only that an account exists, who it belongs to, and when it expires.
 */
const fs = require('fs');
const path = require('path');
const { paths } = require('../paths');

const STORE_VERSION = 1;

function emptyStore() {
  return { version: STORE_VERSION, accounts: {}, defaults: {} };
}

class AccountStore {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.file = path.join(paths.userData, 'accounts.json');
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed.accounts) return emptyStore();
      return { ...emptyStore(), ...parsed };
    } catch {
      return emptyStore();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    // Best effort on Windows, where POSIX modes are advisory.
    try { fs.chmodSync(this.file, 0o600); } catch {}
    return this.data;
  }

  key(provider, accountId) { return `${provider}:${accountId}`; }

  /**
   * Records a connected account.
   * @param {object} account
   * @param {string} account.provider  'google' | 'microsoft' | 'slack' | …
   * @param {string} account.accountId stable id from the provider
   * @param {string} account.label     what to show the user, usually an email
   * @param {object} account.tokens    { accessToken, refreshToken, expiresAt, scopes }
   */
  upsert({ provider, accountId, label, tokens, meta = {} }) {
    const key = this.key(provider, accountId);
    const existing = this.data.accounts[key];

    this.data.accounts[key] = {
      provider,
      accountId,
      label,
      meta: { ...(existing ? existing.meta : {}), ...meta },
      tokens: {
        ...(existing ? existing.tokens : {}),
        ...tokens,
        // A refresh token is only issued on first consent; later grants omit
        // it, and overwriting with undefined would silently break refreshing.
        refreshToken: tokens.refreshToken || (existing && existing.tokens.refreshToken) || null
      },
      connectedAt: existing ? existing.connectedAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // First account for a provider becomes its default.
    if (!this.data.defaults[provider]) this.data.defaults[provider] = key;
    this.save();
    return this.data.accounts[key];
  }

  get(provider, accountId) {
    return this.data.accounts[this.key(provider, accountId)] || null;
  }

  /** The account an app should use, honouring a per-app override. */
  forApp(appId, provider) {
    const appKey = this.data.defaults[`app:${appId}`];
    if (appKey && this.data.accounts[appKey]) return this.data.accounts[appKey];
    const providerKey = this.data.defaults[provider];
    if (providerKey && this.data.accounts[providerKey]) return this.data.accounts[providerKey];
    return this.list(provider)[0] || null;
  }

  setAppAccount(appId, key) {
    if (key && !this.data.accounts[key]) throw new Error(`No connected account ${key}`);
    if (key) this.data.defaults[`app:${appId}`] = key;
    else delete this.data.defaults[`app:${appId}`];
    return this.save();
  }

  setProviderDefault(provider, key) {
    if (!this.data.accounts[key]) throw new Error(`No connected account ${key}`);
    this.data.defaults[provider] = key;
    return this.save();
  }

  list(provider) {
    return Object.values(this.data.accounts)
      .filter((a) => !provider || a.provider === provider)
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  remove(provider, accountId) {
    const key = this.key(provider, accountId);
    delete this.data.accounts[key];
    for (const [k, v] of Object.entries(this.data.defaults)) {
      if (v === key) delete this.data.defaults[k];
    }
    // Promote another account of the same provider rather than leaving apps
    // pointing at nothing.
    const remaining = this.list(provider);
    if (remaining.length && !this.data.defaults[provider]) {
      this.data.defaults[provider] = this.key(provider, remaining[0].accountId);
    }
    return this.save();
  }

  /**
   * Safe view for the renderer: enough to show and choose accounts, and nothing
   * that could be replayed.
   */
  publicList() {
    return this.list().map((a) => ({
      key: this.key(a.provider, a.accountId),
      provider: a.provider,
      accountId: a.accountId,
      label: a.label,
      meta: a.meta,
      connectedAt: a.connectedAt,
      expiresAt: a.tokens && a.tokens.expiresAt ? a.tokens.expiresAt : null,
      expired: Boolean(a.tokens && a.tokens.expiresAt && Date.now() > a.tokens.expiresAt),
      scopes: (a.tokens && a.tokens.scopes) || [],
      isProviderDefault: this.data.defaults[a.provider] === this.key(a.provider, a.accountId)
    }));
  }

  /** Which app uses which account, for the UI. */
  appDefaults() {
    const out = {};
    for (const [k, v] of Object.entries(this.data.defaults)) {
      if (k.startsWith('app:')) out[k.slice(4)] = v;
    }
    return out;
  }
}

module.exports = { AccountStore };
