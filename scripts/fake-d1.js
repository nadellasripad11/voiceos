'use strict';
/** Just enough of Cloudflare D1 for the website's server, on node:sqlite. Same tables as the real one. */
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (fact TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, task TEXT NOT NULL, status TEXT NOT NULL, title TEXT, detail TEXT, answer TEXT, result TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS frame (k INTEGER PRIMARY KEY, data TEXT, url TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS link (k INTEGER PRIMARY KEY, hash TEXT, seen INTEGER);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER, at INTEGER);
CREATE TABLE IF NOT EXISTS file_parts (id TEXT, n INTEGER, data TEXT, PRIMARY KEY (id, n));
CREATE TABLE IF NOT EXISTS convo (rowid INTEGER PRIMARY KEY, question TEXT, answer TEXT, source TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY, title TEXT, body TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS push_tokens (token TEXT PRIMARY KEY, at INTEGER);
CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY, what TEXT, kind TEXT, time TEXT, repeat TEXT, tz TEXT, next_at INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS cron_key (k INTEGER PRIMARY KEY, hash TEXT, key TEXT);`;

function fakeD1(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) || null,
    run: async () => db.prepare(sql).run(...args),
    all: async () => ({ results: db.prepare(sql).all(...args) })
  });
  return { raw: db, prepare: (sql) => stmt(sql), batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; } };
}

module.exports = { fakeD1 };
