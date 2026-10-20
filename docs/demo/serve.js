#!/usr/bin/env node
/**
 * A tiny static server for the demo folder. No dependencies, loopback only.
 *
 *   node docs/demo/serve.js
 *   PORT=9000 node docs/demo/serve.js
 *
 * Exists so the demo can be viewed over http:// rather than file://, which is
 * closer to how an intranet zone behaves in the legacy engine.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((request, response) => {
  try {
    const urlPath = decodeURIComponent(String(request.url || '/').split('?')[0].split('#')[0]);
    const relative = urlPath === '/' ? 'legacy-page.html' : urlPath.replace(/^\/+/, '');
    const file = path.resolve(root, relative);
    const inside = file === root || file.startsWith(root + path.sep);

    if (!inside) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Forbidden\n');
      return;
    }

    fs.readFile(file, (error, data) => {
      if (error) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found\n');
        return;
      }
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(data);
    });
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Server error\n');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`iebox demo: http://127.0.0.1:${port}/\n`);
  process.stdout.write('Loopback only. Press Ctrl+C to stop.\n');
});

server.on('error', (error) => {
  process.stderr.write(`iebox demo server: ${error.message}\n`);
  process.exitCode = 1;
});
