'use strict';
/**
 * Settings → Skills: shortcuts Jarvis learned or was taught, plug-ins (web
 * APIs and MCP servers), and the activity log.
 *
 * Plug-ins are plain settings (services, mcp.servers); a service's key goes
 * to the credentials file as service:<name> and is never read back here.
 */
(function () {
  const vo = window.voiceos;
  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function row(title, sub, action, onClick) {
    const li = el('li');
    const body = el('div');
    body.append(el('strong', null, title), el('span', null, sub));
    li.append(body);
    if (action) {
      const b = el('button', 'btn-quiet', action);
      b.addEventListener('click', onClick);
      li.append(b);
    }
    return li;
  }

  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };

  // --- shortcuts ---
  async function renderShortcuts() {
    const list = await vo.shortcuts();
    const ul = $('shortcutList');
    ul.textContent = '';
    for (const s of list.slice().reverse()) {
      const what = s.kind === 'taught'
        ? `Taught: ${s.sentences.join(', then ')}`
        : `Learned: ${s.steps.map((x) => x.tool.replace(/_/g, ' ')).join(', ')}`;
      const used = s.uses ? ` · used ${s.uses}×${s.last ? `, ${ago(s.last)}` : ''}` : '';
      ul.append(row(`"${s.said}"`, what + used, 'Forget', async () => { await vo.shortcuts(s.key); renderShortcuts(); }));
    }
    $('shortcutEmpty').hidden = list.length > 0;
  }

  // --- plug-ins ---
  function splitCommand(line) {
    const parts = String(line).match(/"[^"]*"|\S+/g) || [];
    return parts.map((p) => p.replace(/^"|"$/g, ''));
  }

  async function renderPlugins() {
    const cfg = await vo.getConfig();
    const status = await vo.pluginStatus().catch(() => []);
    const ul = $('serviceList');
    ul.textContent = '';
    for (const s of cfg.services || []) {
      ul.append(row(s.name, `Web API · ${s.url}${s.about ? ` · ${s.about}` : ''}`, 'Remove', async () => {
        const next = (cfg.services || []).filter((x) => x.name !== s.name);
        await vo.setValue('services', next);
        await vo.credentials({ action: 'clear', provider: `service:${s.name}` });
        renderPlugins();
      }));
    }
    for (const m of (cfg.mcp && cfg.mcp.servers) || []) {
      const st = status.find((x) => x.name === m.name);
      const how = st ? (st.error ? `not running: ${st.error}` : `${st.tools.length} tools`) : 'starting…';
      ul.append(row(m.name, `MCP · ${[m.command, ...(m.args || [])].join(' ')} · ${how}`, 'Remove', async () => {
        await vo.setValue('mcp.servers', cfg.mcp.servers.filter((x) => x.name !== m.name));
        await vo.reloadPlugins();
        renderPlugins();
      }));
    }
  }

  $('serviceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('svcName').value.trim();
    const url = $('svcUrl').value.trim().replace(/\/+$/, '');
    if (!name || !/^https?:\/\//i.test(url)) { $('pluginNote').textContent = 'A name and an address starting with http:// or https:// are needed.'; return; }
    const cfg = await vo.getConfig();
    const entry = { name, url, about: $('svcAbout').value.trim(), keyHeader: $('svcHeader').value.trim() || 'Authorization' };
    await vo.setValue('services', (cfg.services || []).filter((x) => x.name !== name).concat(entry));
    const key = $('svcKey').value.trim();
    if (key) await vo.credentials({ action: 'set', provider: `service:${name}`, key });
    e.target.reset();
    $('pluginNote').textContent = `Added ${name}. Try asking Jarvis about it.`;
    renderPlugins();
  });

  $('mcpForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('mcpName').value.trim();
    const [command, ...args] = splitCommand($('mcpCommand').value.trim());
    if (!name || !command) return;
    const cfg = await vo.getConfig();
    const servers = ((cfg.mcp && cfg.mcp.servers) || []).filter((x) => x.name !== name).concat({ name, command, args });
    await vo.setValue('mcp.servers', servers);
    $('pluginNote').textContent = `Starting ${name}…`;
    const r = await vo.reloadPlugins();
    const st = (r.status || []).find((x) => x.name === name);
    $('pluginNote').textContent = st && !st.error ? `${name} is running with ${st.tools.length} tools.` : `${name} didn't start${st && st.error ? `: ${st.error}` : ''}.`;
    e.target.reset();
    renderPlugins();
  });

  // --- activity ---
  async function renderActivity() {
    const items = await vo.activity(80);
    const ul = $('activityList');
    ul.textContent = '';
    for (const a of items) {
      const li = el('li', a.ok ? '' : 'is-failed');
      const when = new Date(a.at);
      li.append(
        el('time', null, when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
        el('strong', null, a.tool.replace(/_/g, ' ')),
        el('span', null, `${a.approved === true ? 'approved · ' : a.approved === false ? 'declined · ' : ''}${a.result || ''}`)
      );
      li.title = JSON.stringify(a.args);
      ul.append(li);
    }
    $('activityEmpty').hidden = items.length > 0;
  }
  $('openActivity').addEventListener('click', () => vo.openActivity());
  $('refreshActivity').addEventListener('click', renderActivity);

  // Fresh each time the page is opened.
  document.querySelector('.nav-item[data-panel="skills"]').addEventListener('click', () => {
    renderShortcuts(); renderPlugins(); renderActivity();
  });
})();
