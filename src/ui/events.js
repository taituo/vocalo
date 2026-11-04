// Local event stream (Server-Sent Events) so a future native/web UI can render
// the same show: GET http://127.0.0.1:8766/events  ->  data: {"type":"subtitle",...}
// POST /command {"type":"text","text":"..."} | {"type":"interrupt"} feeds back in.
import { createServer } from 'node:http';

export function startEventServer({ port = 8766, onCommand } = {}) {
  const clients = new Set();
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      res.write(': vocalo\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && req.url === '/command') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => { try { onCommand?.(JSON.parse(body)); res.writeHead(204).end(); } catch { res.writeHead(400).end(); } });
      return;
    }
    res.writeHead(404).end();
  });
  server.on('error', () => {}); // port busy -> run without it
  server.listen(port, '127.0.0.1');
  return {
    publish(type, payload) {
      const line = `data: ${JSON.stringify({ type, t: Date.now(), ...payload })}\n\n`;
      for (const c of clients) c.write(line);
    },
    close() { for (const c of clients) c.end(); server.close(); },
  };
}
