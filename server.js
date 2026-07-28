// Minimal static file server. No dependencies — nothing to install, nothing to break.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.ttf':  'font/ttf',
  '.woff': 'font/woff',
  '.woff2':'font/woff2'
};

http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400); return res.end('Bad request');
  }

  if (pathname.endsWith('/')) pathname += 'index.html';

  // resolve inside ROOT only — blocks ../ traversal
  const filePath = path.join(ROOT, path.normalize(pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404</h1><p><a href="/">Back to Empire Sounds</a></p>');
    }
    const ext = path.extname(filePath).toLowerCase();
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=31536000';
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log('Empire Sounds listening on ' + PORT);
});
