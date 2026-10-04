'use strict';
/**
 * A minimal MCP server, for testing the client without a network.
 *
 * Speaks just enough of the protocol to be real: the initialize handshake,
 * tools/list, and tools/call — including a tool that fails, because a client
 * that only handles success is not finished.
 *
 * Not part of the app. Run by the test suite.
 */
const readline = require('readline');

const TOOLS = [
  {
    name: 'echo',
    description: 'Returns whatever it is given.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'What to echo' } },
      required: ['text']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'add',
    description: 'Adds two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'write_thing',
    description: 'Pretends to change something, so the client has a tool that is not read-only.',
    inputSchema: { type: 'object', properties: { what: { type: 'string' } } }
  },
  {
    name: 'always_fails',
    description: 'Reports a tool-level failure, which MCP returns as a result rather than an error.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  }
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim();
  if (!text) return;

  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  const { id, method, params = {} } = msg;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'echo-fixture', version: '1.0.0' }
    });
  }

  // Notifications carry no id and expect no answer.
  if (id === undefined || id === null) return;

  if (method === 'tools/list') return reply(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;
    if (name === 'echo') {
      return reply(id, { content: [{ type: 'text', text: String(args.text ?? '') }] });
    }
    if (name === 'add') {
      return reply(id, { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] });
    }
    if (name === 'write_thing') {
      return reply(id, { content: [{ type: 'text', text: `changed ${args.what || 'something'}` }] });
    }
    if (name === 'always_fails') {
      return reply(id, { content: [{ type: 'text', text: 'this tool is broken' }], isError: true });
    }
    return fail(id, -32602, `no such tool: ${name}`);
  }

  return fail(id, -32601, `method not found: ${method}`);
});
