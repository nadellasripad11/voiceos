'use strict';
/**
 * Connection UI.
 *
 * Renders the connect flow for an app: a setup walkthrough when a provider
 * needs a client ID, a token form, a folder picker, or a straight OAuth hand-off
 * to the browser. Also lets an app be pointed at a specific account when more
 * than one is connected.
 *
 * Attaches to window.voiceosConnect so settings.js can call it without a
 * module system in the renderer.
 */

(function () {
  let state = null;   // last connections() result
  let onChange = null;

  // --- Modal ---------------------------------------------------------------

  function modal(contentHtml, { onMount } = {}) {
    close();
    const host = document.createElement('div');
    host.className = 'modal-host';
    host.innerHTML = `<div class="modal-back"></div><div class="modal">${contentHtml}</div>`;
    document.body.appendChild(host);

    host.querySelector('.modal-back').addEventListener('click', close);
    host.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) close();
    });
    document.addEventListener('keydown', escClose);
    if (onMount) onMount(host.querySelector('.modal'));
    return host;
  }

  function escClose(e) { if (e.key === 'Escape') close(); }

  function close() {
    const existing = document.querySelector('.modal-host');
    if (existing) existing.remove();
    document.removeEventListener('keydown', escClose);
  }

  function busy(node, message) {
    node.innerHTML = `<div class="modal-busy"><span class="spinner"></span><p>${esc(message)}</p></div>`;
  }

  // --- Flows ---------------------------------------------------------------

  async function start(appId) {
    state = await window.voiceos.connections();
    const app = findApp(appId);
    if (!app || !app.connection || !app.connection.provider) return;

    const provider = state.providers[app.connection.provider];
    if (!provider) return;

    // An OAuth provider with no client registered has a setup step first.
    if (provider.kind === 'oauth' && !provider.hasClient) return showSetup(provider);
    if (provider.kind === 'oauth') return runOauth(provider);
    if (provider.kind === 'token') return showTokenForm(provider);
    if (provider.kind === 'browser') return runBrowser(provider);
    if (provider.kind === 'local') return runLocal(provider);
  }

  /** The one-time client-ID walkthrough. */
  function showSetup(provider) {
    const setup = provider.setup || {};
    const fields = (setup.needs || []).filter((n) => n === 'clientId' || n === 'clientSecret');

    modal(`
      <header class="modal-head">
        <h2>${esc(setup.title || `Set up ${provider.name}`)}</h2>
        <button class="modal-x" data-close aria-label="Close">&times;</button>
      </header>
      <p class="modal-why">${esc(setup.why || '')}</p>
      <ol class="modal-steps">
        ${(setup.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}
      </ol>
      ${setup.docsUrl ? `<button class="btn-quiet" data-open-docs="${esc(setup.docsUrl)}">Open the console</button>` : ''}
      <div class="modal-fields">
        ${fields.map((f) => `
          <label class="row">
            <span class="row-label">${f === 'clientId' ? 'Client ID' : 'Client secret'}</span>
            <input type="${f === 'clientSecret' ? 'password' : 'text'}" data-field="${f}"
                   placeholder="${f === 'clientId' ? '…apps.googleusercontent.com' : 'GOCSPX-…'}"
                   autocomplete="off" />
          </label>`).join('')}
      </div>
      <p class="modal-error" data-error hidden></p>
      <footer class="modal-foot">
        <button class="btn-quiet" data-close>Cancel</button>
        <button class="btn-go" data-save>Save and connect</button>
      </footer>
    `, {
      onMount(node) {
        const docs = node.querySelector('[data-open-docs]');
        if (docs) docs.addEventListener('click', () => window.voiceos.openExternal(docs.dataset.openDocs));

        node.querySelector('[data-save]').addEventListener('click', async () => {
          const values = {};
          for (const input of node.querySelectorAll('[data-field]')) {
            values[input.dataset.field] = input.value.trim();
          }
          if (!values.clientId) return showError(node, 'Paste the client ID first.');

          await window.voiceos.setOauthClient(provider.id, values.clientId, values.clientSecret);
          busy(node, `Opening ${provider.name} in your browser…`);
          const result = await window.voiceos.connect(provider.id);
          finish(result, provider);
        });
      }
    });
  }

  async function runOauth(provider) {
    modal(`<div class="modal-busy"><span class="spinner"></span>
      <p>Finishing in your browser…</p>
      <p class="modal-sub">Approve the request, then come back here.</p></div>`);
    const result = await window.voiceos.connect(provider.id);
    if (result.needsSetup) return showSetup({ ...provider, setup: result.needsSetup, hasClient: false });
    finish(result, provider);
  }

  function showTokenForm(provider) {
    const setup = provider.setup || {};
    const extra = provider.extraFields || [];

    modal(`
      <header class="modal-head">
        <h2>${esc(setup.title || `Connect ${provider.name}`)}</h2>
        <button class="modal-x" data-close aria-label="Close">&times;</button>
      </header>
      <p class="modal-why">${esc(setup.why || '')}</p>
      <ol class="modal-steps">${(setup.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${setup.docsUrl ? `<button class="btn-quiet" data-open-docs="${esc(setup.docsUrl)}">Open ${esc(provider.name)}</button>` : ''}
      <div class="modal-fields">
        ${extra.map((f) => `
          <label class="row">
            <span class="row-label">${esc(f.label)}</span>
            <input type="text" data-field="${esc(f.key)}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" />
          </label>`).join('')}
        <label class="row">
          <span class="row-label">Token</span>
          <input type="password" data-field="token" placeholder="Paste the token" autocomplete="off" />
        </label>
      </div>
      <p class="modal-error" data-error hidden></p>
      <footer class="modal-foot">
        <button class="btn-quiet" data-close>Cancel</button>
        <button class="btn-go" data-save>Connect</button>
      </footer>
    `, {
      onMount(node) {
        const docs = node.querySelector('[data-open-docs]');
        if (docs) docs.addEventListener('click', () => window.voiceos.openExternal(docs.dataset.openDocs));

        node.querySelector('[data-save]').addEventListener('click', async () => {
          const input = {};
          for (const field of node.querySelectorAll('[data-field]')) {
            input[field.dataset.field] = field.value.trim();
          }
          if (!input.token) return showError(node, 'Paste your token first.');

          busy(node, `Checking the token with ${provider.name}…`);
          const result = await window.voiceos.connect(provider.id, input);
          if (!result.ok) {
            // Re-render the form rather than stranding them on a spinner.
            showTokenForm(provider);
            setTimeout(() => showError(document.querySelector('.modal'), result.error), 30);
            return;
          }
          finish(result, provider);
        });
      }
    });
  }

  async function runBrowser(provider) {
    const setup = provider.setup || {};
    modal(`<div class="modal-busy"><span class="spinner"></span>
      <p>Waiting for you to sign in to ${esc(provider.name)}…</p>
      <p class="modal-sub">${esc((setup.steps || [])[1] || 'A browser window has opened.')}</p></div>`);
    const result = await window.voiceos.connect(provider.id);
    finish(result, provider);
  }

  async function runLocal(provider) {
    const picked = await window.voiceos.pickFolder(provider.id === 'files');
    if (picked.cancelled || !picked.paths.length) return;
    const result = await window.voiceos.connect(provider.id, { paths: picked.paths });
    finish(result, provider);
  }

  function finish(result, provider) {
    if (!result || !result.ok) {
      const node = document.querySelector('.modal');
      if (node) {
        node.innerHTML = `
          <header class="modal-head"><h2>Could not connect</h2>
            <button class="modal-x" data-close aria-label="Close">&times;</button></header>
          <p class="modal-why">${esc((result && result.error) || 'Something went wrong.')}</p>
          <footer class="modal-foot"><button class="btn-go" data-close>Close</button></footer>`;
      }
      return;
    }

    const shared = (provider.apps || []).length > 1;
    const node = document.querySelector('.modal');
    if (node) {
      node.innerHTML = `
        <div class="modal-done">
          <span class="done-dot"></span>
          <h2>Connected</h2>
          <p class="modal-why">${esc(result.label || provider.name)}</p>
          ${shared ? `<p class="modal-sub">This also connects ${esc(provider.apps.join(', '))}.</p>` : ''}
          <footer class="modal-foot"><button class="btn-go" data-close>Done</button></footer>
        </div>`;
    }
    if (onChange) onChange();
  }

  function showError(node, message) {
    if (!node) return;
    const slot = node.querySelector('[data-error]');
    if (!slot) return;
    slot.textContent = message;
    slot.hidden = false;
  }

  // --- Account switching ---------------------------------------------------

  /** Lets an app use a specific connected account when several exist. */
  async function chooseAccount(appId) {
    state = await window.voiceos.connections();
    const app = findApp(appId);
    const provider = state.providers[app.connection.provider];
    const accounts = provider.accounts || [];
    const current = state.appDefaults[appId];

    modal(`
      <header class="modal-head">
        <h2>Which account should ${esc(app.name)} use?</h2>
        <button class="modal-x" data-close aria-label="Close">&times;</button>
      </header>
      <div class="account-list">
        ${accounts.map((a) => `
          <label class="account-row ${(current || '') === a.key || (!current && a.isProviderDefault) ? 'is-on' : ''}">
            <input type="radio" name="acct" value="${esc(a.key)}"
              ${(current || '') === a.key || (!current && a.isProviderDefault) ? 'checked' : ''} />
            <span class="account-main">
              <strong>${esc(a.label)}</strong>
              <span>${a.expired ? 'Needs reconnecting' : 'Connected'}</span>
            </span>
          </label>`).join('')}
      </div>
      <button class="btn-quiet" data-add>Add another account</button>
      <footer class="modal-foot">
        <button class="btn-quiet" data-close>Cancel</button>
        <button class="btn-go" data-save>Use this account</button>
      </footer>
    `, {
      onMount(node) {
        node.querySelector('[data-add]').addEventListener('click', () => start(appId));
        node.querySelector('[data-save]').addEventListener('click', async () => {
          const picked = node.querySelector('input[name="acct"]:checked');
          if (picked) await window.voiceos.setAppAccount(appId, picked.value);
          close();
          if (onChange) onChange();
        });
      }
    });
  }

  async function disconnect(providerId, accountId) {
    await window.voiceos.disconnect(providerId, accountId);
    if (onChange) onChange();
  }

  // --- Helpers -------------------------------------------------------------

  let appsRef = [];
  const findApp = (id) => appsRef.find((a) => a.id === id);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.voiceosConnect = {
    start,
    chooseAccount,
    disconnect,
    close,
    setApps: (apps) => { appsRef = apps; },
    onChange: (fn) => { onChange = fn; }
  };
})();
