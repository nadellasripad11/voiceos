'use strict';
/**
 * MCP end to end: a server's tools become the assistant's tools.
 *
 *   node scripts/test-mcp.js
 *
 * Runs against a fixture server in this repo, so it needs no network and no
 * account — which is also the point of MCP itself.
 *
 * The safety checks matter more than the plumbing. An MCP server is somebody
 * else's code running against the user's accounts, so a tool is treated as
 * changing something unless its server explicitly says otherwise.
 */
const path = require('path');
const { McpClient } = require('../src/core/mcp/client');
const { McpManager } = require('../src/core/mcp/manager');
const { buildTools } = require('../src/core/agent/tools');
const { config } = require('../src/core/config');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');

/** A config whose MCP servers are ours, leaving the user's settings alone. */
function withServers(servers) {
  return {
    get: (k, d) => {
      if (k === 'mcp.servers') return servers;
      if (k === 'mcp.enabled') return true;
      if (k === 'apps') return {};
      return config.get(k, d);
    },
    set: () => {},
    all: () => config.all()
  };
}

(async () => {
  console.log('\nTalking to a server:');
  {
    const client = new McpClient({ name: 'echo', command: process.execPath, args: [FIXTURE], logger: quiet });
    const t0 = Date.now();
    await client.start();
    check('the handshake completes', Boolean(client.serverInfo), 'no serverInfo');
    check('it identifies itself', client.serverInfo.name === 'echo-fixture', JSON.stringify(client.serverInfo));
    console.log(`        handshake in ${Date.now() - t0}ms`);

    const tools = await client.listTools();
    check('it lists its tools', tools.length === 4, `${tools.length} tools`);

    const echo = await client.callTool('echo', { text: 'hello' });
    check('a call returns its text', echo.ok && echo.text === 'hello', JSON.stringify(echo));

    const sum = await client.callTool('add', { a: 2, b: 40 });
    check('arguments reach the server', sum.text === '42', JSON.stringify(sum));

    // MCP reports a tool's own failure inside the result, not as an error.
    const broken = await client.callTool('always_fails', {});
    check("a tool's own failure is not mistaken for success", broken.ok === false, JSON.stringify(broken));
    check('and its message survives', /broken/.test(broken.text), broken.text);

    let threw = false;
    try { await client.callTool('nope', {}); } catch { threw = true; }
    check('an unknown tool is an error', threw);

    client.stop();
    check('it stops', !client.running);
  }

  console.log('\nA server that will not start costs only its own tools:');
  {
    const manager = new McpManager({
      config: withServers([
        { name: 'good', command: process.execPath, args: [FIXTURE] },
        { name: 'broken', command: 'definitely-not-a-real-command-xyz', args: [] }
      ]),
      logger: quiet
    });
    const r = await manager.start();
    check('both are accounted for', r.servers === 2, JSON.stringify(r));

    const status = manager.status();
    const good = status.find((s) => s.name === 'good');
    const broken = status.find((s) => s.name === 'broken');
    check('the good one is running', good && good.running, JSON.stringify(good));
    check('the broken one reports why', broken && !broken.running && Boolean(broken.error), JSON.stringify(broken));
    check('the good one still offers its tools', manager.toolDefinitions().length === 4,
      String(manager.toolDefinitions().length));
    manager.stop();
  }

  console.log('\nIts tools become the assistant\'s tools:');
  {
    const manager = new McpManager({
      config: withServers([{ name: 'echo', command: process.execPath, args: [FIXTURE] }]),
      logger: quiet
    });
    await manager.start();

    const tools = buildTools({
      config: withServers([]), bridge: {}, browser: null, provider: null,
      connections: null, mcp: manager, logger: quiet
    });

    const echo = tools.find((t) => t.name === 'echo_echo');
    check('they are registered under the server name', Boolean(echo),
      JSON.stringify(tools.filter((t) => t.name.startsWith('echo')).map((t) => t.name)));
    check('the description says where it came from', echo && /via echo/.test(echo.description), echo && echo.description);
    check('the schema passes through', echo && echo.parameters.properties.text, JSON.stringify(echo && echo.parameters));

    const result = await echo.run({ text: 'through the agent' });
    check('calling it works', result.ok && result.summary === 'through the agent', JSON.stringify(result));

    console.log('\n  Safety:');
    const readOnly = tools.find((t) => t.name === 'echo_echo');
    const writes = tools.find((t) => t.name === 'echo_write_thing');
    check('a read-only tool runs without asking', readOnly && !readOnly.mutating, String(readOnly && readOnly.mutating));
    check('a tool that says nothing is treated as changing something',
      writes && writes.mutating === true, String(writes && writes.mutating));
    check('and it has something to show before running', writes && typeof writes.confirm === 'function');
    check('the confirmation names the server and the arguments',
      writes && /write_thing/.test(writes.confirm({ what: 'x' }).title), JSON.stringify(writes && writes.confirm({ what: 'x' })));

    const failing = tools.find((t) => t.name === 'echo_always_fails');
    const bad = await failing.run({});
    check('a failing tool reports failure rather than Done', bad.ok === false, JSON.stringify(bad));

    manager.stop();
    const afterStop = await echo.run({ text: 'x' });
    check('a stopped server says so instead of hanging', afterStop.ok === false, JSON.stringify(afterStop));
  }

  console.log('\nConfiguration:');
  {
    const manager = new McpManager({ config: withServers([]), logger: quiet });
    check('no servers configured is not an error', (await manager.start()).servers === 0);

    const messy = new McpManager({
      config: withServers([
        { name: 'ok', command: process.execPath, args: [FIXTURE] },
        { name: 'no-command' },
        { command: 'nameless' },
        { name: 'off', command: process.execPath, args: [FIXTURE], enabled: false }
      ]),
      logger: quiet
    });
    const r = await messy.start();
    check('malformed and disabled entries are skipped', r.servers === 1, JSON.stringify(r));
    messy.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
