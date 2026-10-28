'use strict';
/**
 * The website, run locally the way Cloudflare runs it: web/ as static files,
 * /api/* through web/_worker.js.
 *
 *   node scripts/web-dev.js [port]
 *
 * Keys come from the desktop app's credentials file, and the password from
 * JARVIS_PASSWORD (default "jarvis-dev"), so nothing secret is in the repo.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', 'web');
const PORT = Number(process.argv[2] || 4325);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webm': 'video/webm', '.mp4': 'video/mp4', '.md': 'text/plain' };

(async () => {
  const worker = (await import(pathToFileURL(path.join(ROOT, '_worker.js')).href)).default;
  let creds = {};
  try { creds = require(path.join(process.env.APPDATA || '', 'VoiceOS', 'credentials.json')); } catch { /* none */ }
  const assets = {
    fetch: async (req) => {
      const u = new URL(req.url);
      let file = path.join(ROOT, decodeURIComponent(u.pathname));
      if (!file.startsWith(ROOT) || path.basename(file).startsWith('_')) return new Response('Not found', { status: 404 });
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(file), { headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' } });
    }
  };
  const env = { GROQ_API_KEY: creds.groq || '', GEMINI_API_KEY: creds.gemini || '', JARVIS_PASSWORD: process.env.JARVIS_PASSWORD || 'jarvis-dev', ASSETS: assets };

  http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const response = await worker.fetch(request, env);
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  }).listen(PORT, () => console.log(`Jarvis web on http://localhost:${PORT} (password: ${env.JARVIS_PASSWORD === 'jarvis-dev' ? 'jarvis-dev' : 'from JARVIS_PASSWORD'})`));
})();
