'use strict';
/**
 * A Model Context Protocol client.
 *
 * MCP is the open standard for giving an assistant access to someone else's
 * tools — Slack, Notion, GitHub, a database, a filesystem — without a hosted
 * middleman holding the credentials. A server is an ordinary process speaking
 * JSON-RPC over its own stdin and stdout, so adding one costs a line of
 * configuration and nothing else: no account, no cap, no vendor.
 *
 * That is the whole reason to prefer it to a service like Composio. The tokens
 * stay on this machine, the servers run on this machine, and anything anyone
 * publishes works here the day they publish it.
 *
 * Implemented directly rather than with the SDK, because this project has no
 * dependencies and the protocol over stdio is one JSON object per line.
 */
const readline = require('readline');
const { spawn } = require('child_process');

/** The version of the protocol this speaks. */
const PROTOCOL_VERSION = '2024-11-05';

class McpClient {
  /**
   * @param {object} opts
   * @param {string} opts.name what to call this server in tool names
   * @param {string} opts.command the executable
   * @param {string[]} [opts.args]
   * @param {object} [opts.env] added to the inherited environment
   */
  constructor({ name, command, args = [], env = {}, cwd = null, logger = console, timeoutMs = 20000 } = {}) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.logger = logger;
    this.timeoutMs = timeoutMs;

    this.proc = null;
    this.starting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.serverInfo = null;
    this.tools = [];
    /** Set when the process dies, so a dead server reports why rather than hanging. */
    this.failure = null;
  }

  get running() { return Boolean(this.proc); }

  async start() {
    if (this.proc) return this;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      this.failure = null;
      // A bare name like "npx" or "uvx" needs the shell on Windows, because
      // those are .cmd files that cannot be executed directly. A real path
      // must not go through the shell: "C:\Program Files\nodejs\node.exe"
      // then splits at the space and the server never starts.
      const bareName = !/[\\/]/.test(this.command) && !/\.exe$/i.test(this.command);
      const useShell = process.platform === 'win32' && bareName;

      this.proc = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.env },
        cwd: this.cwd || undefined,
        windowsHide: true,
        shell: useShell
      });

      // One JSON-RPC message per line, which is what the stdio transport is.
      readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.handleLine(line));

      this.proc.stderr.on('data', (d) => {
        const text = String(d).trim();
        // Servers log their startup banner to stderr; it is not an error.
        if (text) this.logger.debug?.(`[mcp:${this.name}] ${text.slice(0, 200)}`);
      });

      this.proc.on('error', (err) => this.die(`could not start: ${err.message}`));
      this.proc.on('exit', (code) => {
        if (code !== 0 && code !== null) this.die(`exited with code ${code}`);
        else this.die('exited');
      });

      const init = await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'voiceos', version: '0.1.0' }
      });
      this.serverInfo = init.serverInfo || null;

      // The spec requires this before any other request is honoured.
      this.notify('notifications/initialized');

      this.logger.info?.(
        `[mcp] ${this.name} ready` +
        (this.serverInfo ? ` (${this.serverInfo.name} ${this.serverInfo.version || ''})`.trimEnd() : '')
      );
      return this;
    })();

    try {
      return await this.starting;
    } catch (err) {
      this.stop();
      throw err;
    } finally {
      this.starting = null;
    }
  }

  /** Marks the server dead and fails anything waiting, rather than hanging. */
  die(reason) {
    this.proc = null;
    this.failure = reason;
    for (const [, p] of this.pending) p.reject(new Error(`${this.name}: ${reason}`));
    this.pending.clear();
  }

  handleLine(line) {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    // A notification from the server; nothing is waiting on it.
    if (msg.id === undefined || msg.id === null) return;

    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);

    if (msg.error) entry.reject(new Error(msg.error.message || 'the server returned an error'));
    else entry.resolve(msg.result);
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.proc) return Promise.reject(new Error(`${this.name}: not running${this.failure ? ` (${this.failure})` : ''}`));
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: ${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  notify(method, params = {}) {
    if (!this.proc) return;
    try { this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); } catch { /* dead */ }
  }

  /** What this server can do. */
  async listTools() {
    const result = await this.request('tools/list');
    this.tools = (result && result.tools) || [];
    return this.tools;
  }

  /**
   * Runs one of them.
   *
   * MCP returns content as a list of parts, and reports a tool's own failure
   * in the result rather than as a protocol error — so isError is checked
   * rather than assuming a reply means success.
   */
  async callTool(name, args = {}, { timeoutMs } = {}) {
    const result = await this.request('tools/call', { name, arguments: args }, { timeoutMs });
    const parts = (result && result.content) || [];
    const text = parts
      .map((p) => (p.type === 'text' ? p.text : p.type === 'resource' ? (p.resource && p.resource.text) || '' : ''))
      .filter(Boolean)
      .join('\n')
      .trim();

    return {
      ok: !(result && result.isError),
      text,
      raw: result
    };
  }

  stop() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    try { proc.stdin.end(); } catch { /* already gone */ }
    setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 300);
  }
}

module.exports = { McpClient, PROTOCOL_VERSION };
