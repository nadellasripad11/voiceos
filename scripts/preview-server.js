'use strict';
/**
 * Static file server for previewing the renderer and the marketing site without
 * launching Electron. Development only; the shipped app loads these files
 * directly from disk.
 *
 *   node scripts/preview-server.js [--port 4321] [--root src/renderer]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const PORT = Number(opt('port', 4321));
const ROOT = path.resolve(__dirname, '..', opt('root', 'src/renderer'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(ROOT, url === '/' ? 'index.html' : url);

  // Never serve outside the root, even if the request walks up with "..".
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: ${url}`);
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`preview server: http://127.0.0.1:${PORT}  (root: ${path.relative(process.cwd(), ROOT)})`);
});
