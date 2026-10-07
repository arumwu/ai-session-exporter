'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { createService, failure } = require('./index');
const STATIC = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function bodyOf(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw failure('input', 415);
  if (Number(req.headers['content-length']) > 256 * 1024) throw failure('limit', 413);
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 256 * 1024) throw failure('limit', 413); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('input'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw failure('input');
  return value;
}
async function createServer(options = {}) {
  const host = options.host || '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw failure('input');
  const service = options.service || await createService(options);
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, '..', 'public'));
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = server.address()?.port;
      const authorities = new Set(['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port]);
      if (!LOCAL.has(req.socket.remoteAddress) || !authorities.has(req.headers.host) || req.headers.origin && req.headers.origin !== 'http://' + req.headers.host || req.headers['sec-fetch-site'] === 'cross-site') throw failure('input', 403);
      const url = new URL(req.url, 'http://' + req.headers.host);
      if (url.origin !== 'http://' + req.headers.host) throw failure('input', 403);
      if (req.method === 'GET') {
        if (url.pathname === '/api/session-links') return json(res, 200, await service.links.inventory());
        if (url.pathname === '/api/session-links/history') return json(res, 200, await service.links.history(url.searchParams.get('id')));
        if (url.pathname === '/api/session-links/status') return json(res, 200, service.runner.status(url.searchParams.get('id')));
        if (STATIC.has(url.pathname)) {
          const [name, type] = STATIC.get(url.pathname), file = path.join(publicDir, name);
          if (!fs.existsSync(file)) return json(res, 404, { error: 'Not found.', code: 'missing' });
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || fs.realpathSync(path.dirname(file)) !== fs.realpathSync(publicDir)) throw failure('input', 404);
          res.writeHead(200, { 'Content-Type': type }); return res.end(fs.readFileSync(file));
        }
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/session-links/')) {
        if (req.headers['x-hub'] !== '1') throw failure('input', 403);
        const body = await bodyOf(req), action = url.pathname.slice('/api/session-links/'.length);
        if (action === 'export') {
          const content = await service.exportSelected(body.selected, body.format), extension = body.format === 'json' ? 'json' : 'md';
          res.writeHead(200, { 'Content-Type': body.format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
            'Content-Disposition': 'attachment; filename="selected-ai-sessions.' + extension + '"' });
          return res.end(content);
        }
        const handlers = { preview: () => service.links.preview(body.selected), apply: () => service.links.apply(body), remove: () => service.links.remove(body),
          send: () => service.runner.send(body), answer: () => service.runner.answer(body), stop: () => service.runner.stop(body.id) };
        if (Object.hasOwn(handlers, action)) return json(res, 200, await handlers[action]());
      }
      return json(res, 404, { error: 'Not found.', code: 'missing' });
    } catch (error) {
      const status = [400, 403, 404, 409, 413, 415].includes(error.status) ? error.status : 400;
      const code = ['selection', 'missing', 'stale', 'limit', 'format', 'guard', 'input', 'busy', 'confirm', 'unsafe', 'unsupported', 'unknown', 'source', 'mismatch', 'protocol', 'stopped', 'unverified', 'cli', 'provider'].includes(error.code) ? error.code : 'format';
      const native = ['source', 'mismatch', 'protocol', 'stopped', 'unverified', 'cli', 'provider', 'unsupported', 'unknown'].includes(code);
      const value = native ? error.message : code === 'input' ? failure(code).message : service.links.error ? service.links.error(error).error : failure(code).message;
      return json(res, status, { code, error: service.message ? service.message(code, value) : value });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  return { server, service, listen: (port = 4747) => new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) return reject(failure('input'));
    server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); });
  }) };
}
module.exports = { createServer };
