'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const files = {'/': ['cloud.html', 'text/html; charset=utf-8'], '/cloud.js': ['cloud.js', 'text/javascript; charset=utf-8'], '/cloud.css': ['cloud.css', 'text/css; charset=utf-8']};
const api = new Map([
  ['/api/status', 'GET'], ['/api/source', 'POST'], ['/api/settings', 'POST'],
  ['/api/stop', 'POST'], ['/api/upload', 'POST'], ['/api/ingest', 'POST'],
  ['/download.m3u', 'GET'], ['/download-ts.m3u', 'GET']
]);

module.exports.createGateway = function ({origin, token, streamKey, adminPort, mediaPort, secure = true, now = Date.now}) {
  const sessions = new Map(), failures = new Map();
  const cookieName = secure ? '__Host-homecast' : 'homecast-dev';
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  function reply(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, {'Content-Type': type});
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }
  async function body(req) {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 16384) throw Error('الطلب أكبر من الحد المسموح');
      chunks.push(chunk);
    }
    try {return JSON.parse(Buffer.concat(chunks).toString());} catch {throw Error('طلب غير صالح');}
  }
  function prune() {
    for (const [key, session] of sessions) if (session.expires <= now()) sessions.delete(key);
    for (const [key, record] of failures) if (record.until <= now()) failures.delete(key);
  }
  function proxy(req, res, port, admin = false) {
    // Forward only media/request headers needed by our own two internal services.
    const headers = {};
    for (const name of ['content-type', 'content-length', 'range']) if (req.headers[name]) headers[name] = req.headers[name];
    if (admin) headers['X-HomeCast-Token'] = token;
    const upstream = http.request({host: '127.0.0.1', port, path: req.url, method: req.method, headers}, incoming => {
      const selected = {};
      for (const name of ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges']) if (incoming.headers[name]) selected[name] = incoming.headers[name];
      res.writeHead(incoming.statusCode, selected);
      incoming.on('error', () => res.destroy());
      incoming.pipe(res);
    });
    // Active ingest/TS streams can last indefinitely; inactive sockets are bounded.
    upstream.setTimeout(req.url === '/api/ingest' ? 300000 : 120000, () => upstream.destroy());
    upstream.on('error', () => {if (!res.headersSent) reply(res, 502, {error: 'خدمة البث لا تستجيب، أعد المحاولة'}); else res.destroy();});
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      // Reject non-canonical paths, including absolute proxy requests.
      if (!req.url.startsWith('/') || req.url.startsWith('//')) return reply(res, 400, {error: 'Invalid path'});
      const url = new URL(req.url, origin);
      if (url.search || /%|\\/.test(req.url) || url.pathname !== req.url) return reply(res, 404, {error: 'Not found'});
      const route = url.pathname;
      if (req.headers.origin && req.headers.origin !== origin) return reply(res, 403, {error: 'مصدر الطلب غير مسموح'});
      if (route === '/healthz' && req.method === 'GET') {
        try {
          const result = await fetch(`http://127.0.0.1:${adminPort}/api/status`, {headers: {'X-HomeCast-Token': token}, signal: AbortSignal.timeout(2500)});
          return reply(res, result.ok ? 200 : 503, {ok: result.ok});
        } catch {return reply(res, 503, {ok: false});}
      }
      if (Object.hasOwn(files, route) && req.method === 'GET') {
        const [name, type] = files[route]; return reply(res, 200, fs.readFileSync(path.join(__dirname, name), 'utf8'), type);
      }
      if (route.startsWith(`/${streamKey}/`) && ['GET', 'HEAD'].includes(req.method)) return proxy(req, res, mediaPort);
      prune();
      const raw = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='));
      const sessionId = raw?.slice(cookieName.length + 1);
      const session = sessions.get(sessionId);
      const client = req.socket.remoteAddress || 'unknown';
      if (route === '/api/login' && req.method === 'POST') {
        // Also limits attempts when a platform puts many clients behind one proxy.
        if ((failures.get(client)?.count || 0) >= 8) return reply(res, 429, {error: 'محاولات كثيرة. انتظر 15 دقيقة ثم حاول مجددًا.'});
        const submitted = await body(req);
        if (!equal(submitted.token, token)) {
          const record = failures.get(client) || {count: 0, until: now() + 900000};
          record.count++; failures.set(client, record); return reply(res, 401, {error: 'مفتاح التحكم غير صحيح'});
        }
        failures.delete(client);
        if (sessionId) sessions.delete(sessionId);
        const id = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
        while (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        sessions.set(id, {csrf, expires: now() + 12 * 3600000});
        res.setHeader('Set-Cookie', cookie(id, 12 * 3600));
        return reply(res, 200, {ok: true, csrf});
      }
      const tokenAuth = equal(req.headers['x-homecast-token'], token);
      if (!session && !tokenAuth) return reply(res, 401, {error: 'سجّل الدخول أولًا'});
      if (req.method !== 'GET' && req.method !== 'HEAD' && !tokenAuth && !equal(req.headers['x-csrf-token'], session.csrf)) return reply(res, 403, {error: 'انتهت صلاحية الطلب. أعد فتح الصفحة.'});
      if (route === '/api/session' && req.method === 'GET') return reply(res, 200, {ok: true, csrf: session?.csrf || '', base: origin});
      if (route === '/api/logout' && req.method === 'POST') {
        sessions.delete(sessionId); res.setHeader('Set-Cookie', cookie('', 0)); return reply(res, 200, {ok: true});
      }
      if (route === '/api/links' && req.method === 'GET') {
        const base = `${origin}/${streamKey}`;
        return reply(res, 200, {playlist: `${base}/playlist.m3u`, hls: `${base}/live/channel/index.m3u8`, ts: `${base}/live/channel/stream.ts`, streamKey});
      }
      if (!api.has(route)) return reply(res, 404, {error: 'Not found'});
      if (api.get(route) !== req.method) return reply(res, 405, {error: 'Method not allowed'});
      if (route === '/api/source') {
        const data = await body(req);
        if (!['url', 'test'].includes(data.mode) || data.mode === 'url' && (typeof data.value !== 'string' || !/^https?:\/\//i.test(data.value))) return reply(res, 400, {error: 'استخدم رابط http/https أو ارفع ملف فيديو من زر الرفع'});
        const result = await fetch(`http://127.0.0.1:${adminPort}/api/source`, {method: 'POST', headers: {'X-HomeCast-Token': token, 'Content-Type': 'application/json'}, body: JSON.stringify(data), signal: AbortSignal.timeout(115000)});
        return reply(res, result.status, await result.text());
      }
      return proxy(req, res, adminPort, true);
    } catch {if (!res.headersSent) reply(res, 400, {error: 'تعذّر إكمال الطلب. تحقق من الرابط وحاول مجددًا.'}); else res.destroy();}
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  return server;
};
