'use strict';
/**
 * Every configured MCP server, as ordinary tools the agent can use.
 *
 * This is what makes MCP worth having rather than a hosted connector service:
 * a server is a line of configuration, it runs here, it holds its own
 * credentials, and anything anyone publishes works the day they publish it.
 *
 * Three rules this enforces on the way in, because an MCP server is somebody
 * else's code running against the user's accounts:
 *
 *   A server that will not start, or is slow, or crashes, costs its own tools
 *   and nothing else. One bad entry must not stop the assistant.
 *
 *   A tool is treated as changing something unless it says otherwise. MCP has
 *   readOnlyHint for this; absent it, the safe reading is that calling it does
 *   something, so it goes through the same confirmation as sending mail.
 *
 *   Names are prefixed with the server, because two servers may both offer
 *   "search" and the agent has to be able to say which it means.
 */
const { McpClient } = require('./client');

/** Tool names have to be stable identifiers for the model to call them. */
const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

class McpManager {
  constructor({ config, logger = console } = {}) {
    this.config = config;
    this.logger = logger;
    /** name -> { client, tools, error } */
    this.servers = new Map();
    this.startedAt = null;
  }

  /** What is configured, ignoring entries that are switched off or malformed. */
  entries() {
    if (!this.config.get('mcp.enabled', true)) return [];
    const list = this.config.get('mcp.servers', []) || [];
    return list
      .filter((s) => s && s.command && s.name && s.enabled !== false)
      .map((s) => ({
        name: clean(s.name),
        command: s.command,
        args: Array.isArray(s.args) ? s.args : [],
        env: s.env && typeof s.env === 'object' ? s.env : {},
        cwd: s.cwd || null,
        timeoutMs: Number(s.timeoutMs) || 20000
      }));
  }

  /**
   * Starts every configured server and asks what it can do.
   *
   * Concurrently, and each failure contained: a server that takes ten seconds
   * must not delay the others, and one that never starts must not stop them.
   */
  async start() {
    const entries = this.entries();
    if (!entries.length) return { servers: 0, tools: 0 };

    this.startedAt = Date.now();
    await Promise.all(entries.map(async (entry) => {
      const client = new McpClient({ ...entry, logger: this.logger });
      try {
        await client.start();
        const tools = await client.listTools();
        this.servers.set(entry.name, { client, tools, error: null });
        this.logger.info?.(`[mcp] ${entry.name}: ${tools.length} tool${tools.length === 1 ? '' : 's'}`);
      } catch (err) {
        client.stop();
        this.servers.set(entry.name, { client: null, tools: [], error: err.message });
        this.logger.warn?.(`[mcp] ${entry.name} unavailable: ${err.message}`);
      }
    }));

    const tools = [...this.servers.values()].reduce((n, s) => n + s.tools.length, 0);
    this.logger.info?.(
      `[mcp] ${this.servers.size} server(s), ${tools} tool(s) in ${Date.now() - this.startedAt}ms`
    );
    return { servers: this.servers.size, tools };
  }

  /**
   * The tools, in the shape the agent's registry expects.
   *
   * MCP's inputSchema is already JSON Schema, which is what the model is given
   * for function calling, so it passes through unchanged.
   */
  toolDefinitions() {
    const out = [];

    for (const [serverName, entry] of this.servers) {
      if (!entry.client) continue;

      for (const tool of entry.tools) {
        const readOnly = Boolean(tool.annotations && tool.annotations.readOnlyHint);

        // The server's own word is not enough to skip the user's approval.
        // readOnlyHint is a claim made by someone else's code about itself, so
        // a server that wanted to delete things unasked need only mark the
        // tool read-only to be waved through. It is good enough to decide how
        // a tool is described; it is not good enough to decide that nobody
        // needs to be asked. Only the user, naming a server in
        // mcp.trustedServers, can grant that.
        const trusted = (this.config.get('mcp.trustedServers', []) || []).includes(serverName);
        const skipConfirm = readOnly && trusted;

        out.push({
          name: `${serverName}_${clean(tool.name)}`,
          appId: `mcp:${serverName}`,
          description: `${tool.description || tool.name} (via ${serverName})`,
          parameters: tool.inputSchema && tool.inputSchema.type
            ? tool.inputSchema
            : { type: 'object', properties: {} },

          // Unless the server says it only reads, assume calling it does
          // something. It is someone else's code against the user's accounts.
          mutating: !readOnly,
          autoConfirm: skipConfirm,
          confirm: skipConfirm ? undefined : (args) => ({
            app: serverName,
            title: `Run ${tool.name} on ${serverName}?`,
            detail: JSON.stringify(args, null, 1).slice(0, 400)
          }),

          run: async (args = {}) => {
            const live = this.servers.get(serverName);
            if (!live || !live.client) {
              return { ok: false, summary: `${serverName} is not running.` };
            }
            try {
              const r = await live.client.callTool(tool.name, args, { timeoutMs: 30000 });
              if (!r.ok) return { ok: false, summary: r.text || `${tool.name} failed.` };
              const text = r.text || 'Done.';
              return {
                ok: true,
                summary: text,
                // Long output is for reading, not for listening to.
                spoken: text.length > 220 ? `${tool.name} finished.` : text,
                found: [{ glyph: '\u{1F50C}', title: tool.name, subtitle: serverName }]
              };
            } catch (err) {
              return { ok: false, summary: `${serverName}: ${err.message}` };
            }
          }
        });
      }
    }

    return out;
  }

  /** For Settings and for the verifier. */
  status() {
    return [...this.servers.entries()].map(([name, s]) => ({
      name,
      running: Boolean(s.client && s.client.running),
      tools: s.tools.map((t) => t.name),
      error: s.error
    }));
  }

  stop() {
    for (const [, s] of this.servers) if (s.client) s.client.stop();
    this.servers.clear();
  }
}

module.exports = { McpManager, clean };
