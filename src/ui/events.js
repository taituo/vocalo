// Local web server for Vocalo's UI(s):
//   GET  /                 the web UI (web/index.html)
//   GET  /vendor/shaders/* @paper-design/shaders (ESM, served straight from node_modules)
//   GET  /events           Server-Sent Events: every show event (subtitle, scene, level, plan, …)
//   GET  /state            snapshot so a late-opening window (or a second screen) catches up
//   POST /command          {"type":"text"|"command"|"interrupt"|"ptt"|"mute"|"mode"|"permission"|"open_url", …}
// Binds to 127.0.0.1 by default. Set ui.host "0.0.0.0" to show the stage on an iPad/TV on your LAN.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.map': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

// Persisted into /state for late joiners (high-rate or one-shot types are not).
const STICKY = new Set(['state', 'agent', 'scene', 'plan', 'subtitle', 'user', 'code', 'diff', 'permission', 'profile', 'tool', 'metrics', 'config', 'connection']);

function shadersDir() {
  try {
    const req = createRequire(join(ROOT, 'package.json'));
    return dirname(req.resolve('@paper-design/shaders'));
  } catch { return null; }
}

async function serveFile(res, base, rel) {
  const path = normalize(join(base, rel));
  if (!path.startsWith(base)) return res.writeHead(403).end();
  try {
    const st = await stat(path);
    if (!st.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
}

export function startEventServer({ port = 8766, host = '127.0.0.1', onCommand, webDir = join(ROOT, 'web') } = {}) {
  const clients = new Set();
  const snapshot = {};
  const vendor = shadersDir();
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': vocalo\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(snapshot));
    }
    if (req.method === 'POST' && url.pathname === '/command') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try { onCommand?.(JSON.parse(body)); res.writeHead(204).end(); } catch { res.writeHead(400).end(); }
      });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/shaders/') && vendor) {
      return serveFile(res, vendor, url.pathname.slice('/vendor/shaders/'.length));
    }
    if (req.method === 'GET') return serveFile(res, webDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    res.writeHead(405).end();
  });
  server.on('error', (e) => resolveReady({ ok: false, error: e.message })); // port busy -> run without it
  server.listen(port, host, () => resolveReady({ ok: true, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}` }));

  return {
    ready,
    snapshot,
    publish(type, payload = {}) {
      const ev = { type, t: Date.now(), ...payload };
      if (STICKY.has(type)) snapshot[type] = ev;
      if (type === 'scene' && payload.kind === 'clear') { delete snapshot.code; delete snapshot.diff; }
      if (!clients.size) return;
      const line = `data: ${JSON.stringify(ev)}\n\n`;
      for (const c of clients) c.write(line);
    },
    get clientCount() { return clients.size; },
    close() { for (const c of clients) c.end(); server.close(); },
  };
}
