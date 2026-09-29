'use strict';
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {createGateway} = require('./gateway');
const {readSecrets} = require('./cloud-config');
const token = 'test-control-'.padEnd(64, 'c'), key = 'test-stream-'.padEnd(48, 's');
let admin, media, gateway, base, cookie, csrf, clock = Date.now();
const listen = async server => {server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;};
before(async () => {
  admin = http.createServer(async (req, res) => {
    if (req.headers['x-homecast-token'] !== token) {res.writeHead(403); return res.end('{}');}
    const chunks = []; for await (const c of req) chunks.push(c);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ok: true, path: req.url, data: Buffer.concat(chunks).toString()}));
  });
  media = http.createServer((req, res) => {res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXTINF:2,\nsample.ts\n');});
  const adminPort = await listen(admin), mediaPort = await listen(media);
  gateway = createGateway({origin: 'https://homecast.example', token, streamKey: key, adminPort, mediaPort, now: () => clock});
  base = `http://127.0.0.1:${await listen(gateway)}`;
});
after(async () => {for (const server of [gateway, admin, media]) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}});
test('public HTML has no control token or stream key; APIs and downloads require authentication', async () => {
  const r = await fetch(base); assert.equal(r.status, 200); const html = await r.text();
  assert.ok(html.includes('HomeCast')); assert.ok(!html.includes(token)); assert.ok(!html.includes(key));
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const path of ['/api/status', '/api/links', '/download.m3u', '/download-ts.m3u', '/wrong/live/channel/index.m3u8']) assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});
test('cross-origin login and APIs are refused even with a correct token', async () => {
  for (const path of ['/api/login', '/api/status']) {
    const r = await fetch(base + path, {method: 'POST', headers: {Origin: 'https://attacker.invalid', 'X-HomeCast-Token': token}, body: JSON.stringify({token})});
    assert.equal(r.status, 403);
  }
});
test('login creates a protected cookie, and authenticated browser can read state', async () => {
  assert.equal((await fetch(base + '/api/login', {method: 'POST', body: JSON.stringify({token: 'wrong'})})).status, 401);
  const r = await fetch(base + '/api/login', {method: 'POST', body: JSON.stringify({token})});
  assert.equal(r.status, 200);
  const header = r.headers.get('set-cookie');
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(header.includes(attribute));
  cookie = header.split(';')[0]; csrf = (await r.json()).csrf;
  assert.ok(cookie.startsWith('__Host-homecast='));
  assert.equal((await fetch(base + '/api/status', {headers: {Cookie: cookie}})).status, 200);
});
test('CSRF is required for browser changes; internal shutdown and local files are not exposed', async () => {
  const headers = {Cookie: cookie};
  assert.equal((await fetch(base + '/api/stop', {method: 'POST', headers, body: '{}'})).status, 403);
  headers['X-CSRF-Token'] = csrf;
  assert.equal((await fetch(base + '/api/stop', {method: 'POST', headers, body: '{}'})).status, 200);
  assert.equal((await fetch(base + '/api/shutdown', {method: 'POST', headers, body: '{}'})).status, 404);
  assert.equal((await fetch(base + '/api/source', {method: 'POST', headers, body: JSON.stringify({mode: 'file', value: '/etc/passwd'})})).status, 400);
  assert.equal((await fetch(base + '/api/source', {method: 'POST', headers, body: JSON.stringify({mode: 'url', value: 'file:///etc/passwd'})})).status, 400);
});
test('local publisher token and keyed media paths remain compatible', async () => {
  const headers = {'X-HomeCast-Token': token};
  const links = await (await fetch(base + '/api/links', {headers})).json();
  assert.equal(links.hls, `https://homecast.example/${key}/live/channel/index.m3u8`);
  assert.equal((await fetch(base + '/api/settings', {method: 'POST', headers, body: '{}'})).status, 200);
  const mediaResponse = await fetch(`${base}/${key}/live/channel/index.m3u8`);
  assert.equal(mediaResponse.status, 200); assert.match(await mediaResponse.text(), /#EXTM3U/);
});
test('logout immediately invalidates the session', async () => {
  const r = await fetch(base + '/api/logout', {method: 'POST', headers: {Cookie: cookie, 'X-CSRF-Token': csrf}, body: '{}'});
  assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(base + '/api/status', {headers: {Cookie: cookie}})).status, 401);
});
test('login throttling recovers only after the cooldown', async () => {
  for (let i = 0; i < 8; i++) assert.equal((await fetch(base + '/api/login', {method: 'POST', body: JSON.stringify({token: 'wrong'})})).status, 401);
  assert.equal((await fetch(base + '/api/login', {method: 'POST', body: JSON.stringify({token})})).status, 429);
  clock += 900001;
  const r = await fetch(base + '/api/login', {method: 'POST', body: JSON.stringify({token})});
  assert.equal(r.status, 200); cookie = r.headers.get('set-cookie').split(';')[0];
});
test('sessions expire after twelve hours and malformed routes fail closed', async () => {
  clock += 12 * 3600000 + 1;
  assert.equal((await fetch(base + '/api/status', {headers: {Cookie: cookie}})).status, 401);
  assert.equal((await fetch(base + '/api/status?token=' + token)).status, 404);
  assert.equal((await fetch(base + '/%2e%2e%2fconfig.json')).status, 404);
});
test('Render base64 secrets produce a stable URL-safe stream key', () => {
  const env = {HOMECAST_CONTROL_TOKEN: 'valid-base64-control-'.padEnd(44, '=') , HOMECAST_STREAM_KEY: 'valid-base64-stream-'.padEnd(44, '=')};
  const result = readSecrets(env);
  assert.equal(result.token, env.HOMECAST_CONTROL_TOKEN);
  assert.match(result.streamKey, /^[a-f0-9]{64}$/);
  assert.equal(readSecrets(env).streamKey, result.streamKey);
  assert.equal(readSecrets({HOMECAST_CONTROL_TOKEN: token, HOMECAST_STREAM_KEY: key}).streamKey, key);
});
test('weak secrets and example placeholders cannot start a public server', () => {
  assert.throws(() => readSecrets({HOMECAST_CONTROL_TOKEN: 'short', HOMECAST_STREAM_KEY: key}));
  assert.throws(() => readSecrets({HOMECAST_CONTROL_TOKEN: token, HOMECAST_STREAM_KEY: 'short'}));
  assert.throws(() => readSecrets({HOMECAST_CONTROL_TOKEN: 'REPLACE_WITH_RANDOM_64_HEX_CHARACTERS', HOMECAST_STREAM_KEY: key}));
});
