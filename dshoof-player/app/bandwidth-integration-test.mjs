import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn, execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, rm, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {streamProfile} from './stream-profile.mjs';

const run = promisify(execFile), root = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, {timeout = 60000, label = 'condition', interval = 400} = {}) {
 const end = Date.now() + timeout;
 while (Date.now() < end) {const value = await check(); if (value) return value; await pause(interval);}
 throw Error(`Timed out waiting for ${label}`);
}
async function unusedPort() {
 const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function closeChild(child) {
 if (!child || child.exitCode !== null || child.signalCode !== null) return;
 const done = once(child, 'close'); child.kill('SIGTERM');
 const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
 try {await done;} finally {clearTimeout(timer);}
}
function entries(manifest, base) {
 const result = []; let seconds;
 for (const line of manifest.split(/\r?\n/)) {
  if (line.startsWith('#EXTINF:')) seconds = Number.parseFloat(line.slice(8));
  else if (line && !line.startsWith('#')) {assert.ok(seconds > 0, 'every segment needs a media duration'); result.push({url: new URL(line, base), seconds}); seconds = undefined;}
 }
 return result;
}
async function probe(buffer) {
 const child = spawn(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', 'pipe:0'], {stdio: ['pipe', 'pipe', 'pipe']});
 let output = '', error = ''; child.stdout.on('data', part => {output += part;}); child.stderr.on('data', part => {error += part;});
 const result = once(child, 'close'); child.stdin.on('error', () => {}); child.stdin.end(buffer);
 const [code] = await result; assert.equal(code, 0, error); return JSON.parse(output).streams;
}
async function decode(buffer) {
 const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', 'pipe:0', '-map', '0:v:0', '-frames:v', '5', '-f', 'null', '-'], {stdio: ['pipe', 'ignore', 'pipe']});
 let error = ''; child.stderr.on('data', part => {error += part;}); const result = once(child, 'close');
 child.stdin.on('error', () => {}); child.stdin.end(buffer); const [code] = await result; assert.equal(code, 0, error);
}

// Requires real FFmpeg/FFprobe, exercises the authenticated HTTP bytes a player receives.
// Primary ingest is a local HLS producer so this never needs external sites or secrets.
test('real delivered weak/emergency bandwidth is lower, independent, fresh and stoppable', {timeout: 150000}, async t => {
 await Promise.all([run(ffmpeg, ['-version']), run(ffprobe, ['-version'])]);
 const directory = await mkdtemp(path.join(tmpdir(), 'dshoof-bandwidth-'));
 const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
 let server, producer, serverLog = '', producerLog = '', secrets = [];
 const request = (url, options = {}) => fetch(new URL(url, origin), {signal: AbortSignal.timeout(8000), redirect: 'manual', ...options});
 const redact = text => secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), String(text));
 try {
  await mkdir(path.join(directory, 'media'));
  server = spawn(process.execPath, ['server.mjs'], {cwd: root, env: {...process.env, DATA_DIR: directory, SERVER_PORT: String(port), PORT: String(port), PUBLIC_URL: origin, FFMPEG_PATH: ffmpeg}, stdio: ['ignore', 'pipe', 'pipe']});
  for (const output of [server.stdout, server.stderr]) output.on('data', part => {serverLog = (serverLog + part).slice(-12000);});
  await until(async () => {assert.equal(server.exitCode, null, 'application exited before startup'); try {return (await request('/healthz')).ok;} catch {return false;}}, {label: 'server startup', timeout: 15000});
  const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8')); secrets = [state.owner, state.viewer, state.playlistAlias].filter(Boolean);
  const login = await request('/api/login', {method: 'POST', headers: {origin, 'Content-Type': 'application/json'}, body: JSON.stringify({key: state.owner})});
  assert.equal(login.status, 200);
  const headers = {cookie: login.headers.get('set-cookie').split(';')[0], origin, 'Content-Type': 'application/json'};
  secrets.push(headers.cookie);
  const post = (route, value, authentication = headers) => request(route, {method: 'POST', headers: authentication, body: JSON.stringify(value)});
  const status = async () => {const response = await request('/api/status', {headers}); assert.equal(response.status, 200); return response.json();};
  const before = await status();
  await t.test('anonymous media and control requests cannot use the stream', async () => {
   for (const route of ['/live/dshoof.m3u8', '/weak/dshoof.m3u8', '/emergency/dshoof.m3u8', '/dshoof.m3u', '/api/export']) assert.equal((await request(route)).status, 403, route);
   for (const route of ['/api/stop', '/api/select', '/api/stream-profile']) assert.equal((await post(route, {}, {origin, 'Content-Type': 'application/json'})).status, 403, route);
   assert.equal((await post('/api/stream-profile', {profile: 'economy720'}, {...headers, origin: 'https://untrusted.invalid'})).status, 403);
   assert.equal((await post('/api/stream-profile', {profile: 'economy720'})).status, 200);
  });
  producer = spawn(ffmpeg, [
   '-hide_banner', '-loglevel', 'error', '-filter_threads', '1', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
   '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '110',
   '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
   '-b:v', '4000k', '-minrate', '4000k', '-maxrate', '4000k', '-bufsize', '8000k', '-x264-params', 'nal-hrd=cbr:force-cfr=1',
   '-g', '120', '-keyint_min', '120', '-sc_threshold', '0', '-bf', '0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
   '-f', 'hls', '-hls_time', '4', '-hls_list_size', '24', '-hls_flags', 'temp_file+omit_endlist',
   '-hls_segment_filename', path.join(directory, 'media', 'segment_%d.ts'), path.join(directory, 'media', 'dshoof.m3u8')
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  producer.stderr.on('data', part => {producerLog = (producerLog + part).slice(-4000);});
  await until(async () => {assert.equal(producer.exitCode, null, producerLog); return (await request('/live/dshoof.m3u8', {headers})).ok;}, {label: 'primary source'});
  const collect = async (route, targetSeconds = 16) => {
   const seen = new Map(); let lastManifest = '', attempts = 0;
   await until(async () => {
    const response = await request(route, {headers}); attempts++;
    assert.ok([200, 503].includes(response.status), `unexpected ${route} status ${response.status}`);
    assert.equal(response.headers.get('location'), null, 'compressed streams must not redirect to the primary');
    const text = await response.text();
    if (response.status === 503) {assert.doesNotMatch(text, /#EXTM3U|\/live\/segment_/); return false;}
    assert.match(text, /^#EXTM3U/); lastManifest = text;
    for (const item of entries(text, origin + route)) {
     assert.equal(item.url.origin, origin);
     const expectedPrefix = route.slice(0, route.lastIndexOf('/') + 1);
     assert.ok(item.url.pathname.startsWith(expectedPrefix), 'compressed manifest contained a primary or different encoder URL');
     if (seen.has(item.url.href)) continue;
     const segment = await request(item.url); assert.equal(segment.status, 200, `${expectedPrefix} segment download`);
     assert.match(segment.headers.get('content-type'), /video\/mp2t/);
     const bytes = Buffer.from(await segment.arrayBuffer()); assert.ok(bytes.length >= 188); assert.equal(bytes[0], 0x47); assert.equal(bytes.length % 188, 0);
     seen.set(item.url.href, {...item, bytes});
     if ([...seen.values()].reduce((sum, part) => sum + part.seconds, 0) >= targetSeconds) return true;
    }
    return false;
   }, {label: `${route} encoded media`, timeout: 70000, interval: 600});
   const samples = [...seen.values()], seconds = samples.reduce((sum, part) => sum + part.seconds, 0), bytes = samples.reduce((sum, part) => sum + part.bytes.length, 0);
   return {samples, seconds, bytes, kbps: bytes * 8 / seconds / 1000, manifest: lastManifest, attempts};
  };
  let primary, weak, emergency;
  await t.test('multiple real transport segments meet the bandwidth budgets and decode', async () => {
   [primary, weak, emergency] = await Promise.all([collect('/live/dshoof.m3u8'), collect('/weak/dshoof.m3u8'), collect('/emergency/dshoof.m3u8')]);
   const expected = [['primary', primary, 1080], ['weak', weak, 720], ['emergency', emergency, 144]];
   for (const [name, output, height] of expected) {
    assert.ok(output.seconds >= 16, 'sample at least 16 media seconds, including TS overhead');
    const streams = await probe(output.samples.at(-1).bytes), video = streams.find(stream => stream.codec_type === 'video'), audio = streams.find(stream => stream.codec_type === 'audio');
    assert.equal(video?.codec_name, 'h264', name); assert.equal(video.height, height, name); assert.equal(audio?.codec_name, 'aac', name);
    await decode(output.samples.at(-1).bytes);
    // Segment responses contain all MPEG-TS, PAT/PMT and audio bytes, not just elementary video bitrate.
    t.diagnostic(JSON.stringify({path: name, segments: output.samples.length, mediaSeconds: Number(output.seconds.toFixed(2)), transportKbps: Math.round(output.kbps), size: `${video.width}x${video.height}`}));
   }
   assert.ok(primary.kbps > 3000, `source fixture is too small: ${Math.round(primary.kbps)} kbps`);
   for (const [name, output, id] of [['weak', weak, 'economy720'], ['emergency', emergency, 'emergency144']]) {
    const profile = streamProfile(id);
    // Allow 30% for TS/audio framing and short-window VBV; low-rate emergency allows 45% for its proportionally larger transport headers.
    const tolerance = name === 'emergency' ? 1.45 : 1.3;
    assert.ok(output.kbps <= (profile.maxKbps + profile.audioKbps) * tolerance, `${name} delivered ${Math.round(output.kbps)} kbps exceeds its transport budget`);
   }
   assert.ok(weak.kbps < primary.kbps * 0.45, 'weak mode must deliver substantially fewer bytes than primary');
   assert.ok(emergency.kbps < weak.kbps * 0.2, 'emergency mode must deliver substantially fewer bytes than weak');
   for (const sample of primary.samples) assert.deepEqual(sample.bytes, await readFile(path.join(directory, 'media', path.basename(sample.url.pathname))), 'primary bytes must never be recompressed');
  });
  await t.test('polling advances each encoder and leaves source selection and stable links intact', async () => {
   const latest = new Map([['/weak/dshoof.m3u8', weak.samples.at(-1).url.href], ['/emergency/dshoof.m3u8', emergency.samples.at(-1).url.href]]);
   await Promise.all([...latest].map(async ([route, previous]) => {
    await until(async () => {
     const response = await request(route, {headers}); assert.equal(response.status, 200);
     const list = entries(await response.text(), origin + route); return list.at(-1)?.url.href !== previous && list.some(item => item.url.href === previous);
    }, {label: `${route} progression`, timeout: 25000, interval: 700});
   }));
   const after = await status(); assert.equal(after.playlist, before.playlist); assert.deepEqual(after.selection, before.selection); assert.equal(after.weakReady, true); assert.equal(after.emergencyReady, true);
   const mainList = await request(before.playlist); assert.equal(mainList.status, 200); const playlist = await mainList.text(); assert.match(playlist, /\/live\/dshoof\.m3u8/); assert.doesNotMatch(playlist, /\/(?:weak|emergency)\//);
   for (const output of [weak, emergency]) {const url = new URL(output.samples.at(-1).url); url.search = ''; assert.equal((await request(url)).status, 403);}
  });
  await t.test('profile reset and stop invalidate old output without returning primary bytes', async () => {
   assert.equal((await post('/api/stream-profile', {profile: 'economy480'})).status, 200);
   const resetStatus = await status(); assert.equal(resetStatus.weakReady, false); assert.equal(resetStatus.emergencyReady, true);
   const warming = await request('/weak/dshoof.m3u8', {headers}); assert.equal(warming.status, 503); assert.equal(warming.headers.get('location'), null); assert.doesNotMatch(await warming.text(), /#EXTM3U/);
   assert.equal((await request('/live/dshoof.m3u8', {headers})).status, 200);
   assert.equal((await post('/api/stop', {})).status, 200);
   for (const output of [primary, weak, emergency]) assert.equal((await request(output.samples.at(-1).url)).status, 410, 'old media URLs must stop serving immediately');
   for (const route of ['/live/dshoof.m3u8', '/weak/dshoof.m3u8', '/emergency/dshoof.m3u8']) assert.equal((await request(route, {headers})).status, 410);
   await pause(1200); const stopped = await status(); assert.equal(stopped.stopped, true); assert.equal(stopped.weakReady, false); assert.equal(stopped.emergencyReady, false);
  });
 } catch (error) {error.message = redact(`${error.message}\n${serverLog}\n${producerLog}`); throw error;}
 finally {await closeChild(producer); await closeChild(server); await rm(directory, {recursive: true, force: true});}
});

test('failed compressed encoder returns retryable errors while primary remains usable', {timeout: 20000}, async () => {
 const directory = await mkdtemp(path.join(tmpdir(), 'dshoof-encoder-failure-'));
 const port = await unusedPort(), origin = `http://127.0.0.1:${port}`; let server;
 try {
  await mkdir(path.join(directory, 'media'));
  server = spawn(process.execPath, ['server.mjs'], {cwd: root, env: {...process.env, DATA_DIR: directory, SERVER_PORT: String(port), PORT: String(port), PUBLIC_URL: origin, FFMPEG_PATH: path.join(directory, 'missing-ffmpeg')}, stdio: 'ignore'});
  await until(async () => {try {return (await fetch(origin + '/healthz')).ok;} catch {return false;}}, {timeout: 10000, label: 'failure fixture server'});
  const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  const login = await fetch(origin + '/api/login', {method: 'POST', headers: {origin, 'Content-Type': 'application/json'}, body: JSON.stringify({key: state.owner})});
  assert.equal(login.status, 200);
  const headers = {cookie: login.headers.get('set-cookie').split(';')[0]};
  const source = path.join(directory, 'media', 'dshoof.m3u8');
  const {writeFile} = await import('node:fs/promises');
  await writeFile(source, '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment_1.ts\n');
  await writeFile(path.join(directory, 'media', 'segment_1.ts'), Buffer.alloc(188, 0x47));
  const now = new Date(); await utimes(source, now, now);
  assert.equal((await fetch(origin + '/live/dshoof.m3u8', {headers})).status, 200);
  for (let attempt = 0; attempt < 3; attempt++) {
   for (const route of ['/weak/dshoof.m3u8', '/emergency/dshoof.m3u8']) {
    const response = await fetch(origin + route, {headers, redirect: 'manual'});
    assert.equal(response.status, 503); assert.equal(response.headers.get('location'), null); assert.doesNotMatch(await response.text(), /#EXTM3U|\/live\/segment_/);
   }
   await pause(100);
  }
  assert.equal((await fetch(origin + '/live/dshoof.m3u8', {headers})).status, 200);
 } finally {await closeChild(server); await rm(directory, {recursive: true, force: true});}
});

test('weak compression also saves bandwidth when the original source is already economical', {timeout: 85000}, async t => {
 await Promise.all([run(ffmpeg, ['-version']), run(ffprobe, ['-version'])]);
 const directory = await mkdtemp(path.join(tmpdir(), 'dshoof-economical-'));
 const port = await unusedPort(), origin = `http://127.0.0.1:${port}`; let server, producer, logs = '', secrets = [];
 const request = (route, options = {}) => fetch(new URL(route, origin), {signal: AbortSignal.timeout(8000), redirect: 'manual', ...options});
 try {
  await mkdir(path.join(directory, 'media'));
  server = spawn(process.execPath, ['server.mjs'], {cwd: root, env: {...process.env, DATA_DIR: directory, SERVER_PORT: String(port), PORT: String(port), PUBLIC_URL: origin, FFMPEG_PATH: ffmpeg}, stdio: ['ignore', 'pipe', 'pipe']});
  for (const output of [server.stdout, server.stderr]) output.on('data', part => {logs = (logs + part).slice(-6000);});
  await until(async () => {assert.equal(server.exitCode, null); try {return (await request('/healthz')).ok;} catch {return false;}}, {timeout: 15000, label: 'economical fixture startup'});
  const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8')); secrets = [state.owner, state.viewer, state.playlistAlias].filter(Boolean);
  const login = await request('/api/login', {method: 'POST', headers: {origin, 'Content-Type': 'application/json'}, body: JSON.stringify({key: state.owner})});
  assert.equal(login.status, 200); const headers = {cookie: login.headers.get('set-cookie').split(';')[0], origin, 'Content-Type': 'application/json'}; secrets.push(headers.cookie);
  const setting = await request('/api/stream-profile', {method: 'POST', headers, body: JSON.stringify({profile: 'economy720'})}); assert.equal(setting.status, 200);
  producer = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-filter_threads', '1', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '65', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-b:v', '200k', '-minrate', '200k', '-maxrate', '200k', '-bufsize', '400k', '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-g', '100', '-keyint_min', '100', '-sc_threshold', '0', '-bf', '0', '-c:a', 'aac', '-b:a', '32k', '-ac', '1', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '16', '-hls_flags', 'temp_file+omit_endlist', '-hls_segment_filename', path.join(directory, 'media', 'segment_%d.ts'), path.join(directory, 'media', 'dshoof.m3u8')], {stdio: ['ignore', 'ignore', 'pipe']});
  producer.stderr.on('data', part => {logs = (logs + part).slice(-6000);});
  const sample = async route => {
   const segments = new Map();
   await until(async () => {
    assert.equal(producer.exitCode, null, 'economical producer exited early');
    const response = await request(route, {headers}); assert.ok([200, 503].includes(response.status)); assert.equal(response.headers.get('location'), null);
    if (!response.ok) {await response.text(); return false;}
    const manifest = await response.text();
    for (const item of entries(manifest, origin + route)) {
     assert.ok(item.url.pathname.startsWith(route.slice(0, route.lastIndexOf('/') + 1)));
     if (segments.has(item.url.href)) continue;
     const response = await request(item.url); assert.equal(response.status, 200);
     segments.set(item.url.href, {...item, bytes: Buffer.from(await response.arrayBuffer())});
     if ([...segments.values()].reduce((sum, item) => sum + item.seconds, 0) >= 16) return true;
    }
    return false;
   }, {timeout: 65000, label: `${route} economical bytes`, interval: 600});
   const items = [...segments.values()], seconds = items.reduce((sum, item) => sum + item.seconds, 0);
   return {items, kbps: items.reduce((sum, item) => sum + item.bytes.length, 0) * 8 / seconds / 1000, seconds};
  };
  const [primary, compressed] = await Promise.all([sample('/live/dshoof.m3u8'), sample('/weak/dshoof.m3u8')]);
  assert.ok(primary.kbps < 400, 'fixture must represent an already economical input');
  assert.ok(compressed.kbps < primary.kbps * 0.85, `weak output ${Math.round(compressed.kbps)} kbps inflated original ${Math.round(primary.kbps)} kbps`);
  const streams = await probe(compressed.items.at(-1).bytes), video = streams.find(item => item.codec_type === 'video');
  assert.equal(video.codec_name, 'h264'); assert.ok(video.width <= 640 && video.height <= 360, 'weak mode must not upscale an economical source');
  await decode(compressed.items.at(-1).bytes);
  const status = await (await request('/api/status', {headers})).json();
  assert.equal(status.weakStatus.profile, 'economy360'); assert.equal(status.weakProfile, 'economy720', 'keep the requested profile separate from the effective economical rendition');
  assert.equal(status.selection, null);
  t.diagnostic(JSON.stringify({inputTransportKbps: Math.round(primary.kbps), weakTransportKbps: Math.round(compressed.kbps), mediaSeconds: compressed.seconds, requested: status.weakProfile, effective: status.weakStatus.profile}));
 } catch (error) {error.message = secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), `${error.message}\n${logs}`); throw error;}
 finally {await closeChild(producer); await closeChild(server); await rm(directory, {recursive: true, force: true});}
});

test('cached live history produces the first weak segment without a realtime or large-buffer wait', {timeout: 30000}, async t => {
 const directory = await mkdtemp(path.join(tmpdir(), 'dshoof-cached-start-'));
 const port = await unusedPort(), origin = `http://127.0.0.1:${port}`; let server;
 const request = (route, options = {}) => fetch(new URL(route, origin), {signal: AbortSignal.timeout(6000), redirect: 'manual', ...options});
 try {
  await mkdir(path.join(directory, 'media'));
  server = spawn(process.execPath, ['server.mjs'], {cwd: root, env: {...process.env, DATA_DIR: directory, SERVER_PORT: String(port), PORT: String(port), PUBLIC_URL: origin, FFMPEG_PATH: ffmpeg}, stdio: 'ignore'});
  await until(async () => {try {return (await request('/healthz')).ok;} catch {return false;}}, {timeout: 10000, label: 'cached fixture startup'});
  const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  const login = await request('/api/login', {method: 'POST', headers: {origin, 'Content-Type': 'application/json'}, body: JSON.stringify({key: state.owner})}); assert.equal(login.status, 200);
  const headers = {cookie: login.headers.get('set-cookie').split(';')[0]};
  // Twenty seconds are already available when the viewer joins. Encoding them
  // should use available CPU immediately, while delivering a low media bitrate.
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-filter_threads', '1', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-b:v', '500k', '-g', '100', '-keyint_min', '100', '-sc_threshold', '0', '-bf', '0', '-c:a', 'aac', '-b:a', '48k', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '24', '-hls_flags', 'temp_file+omit_endlist', '-hls_segment_filename', path.join(directory, 'media', 'segment_%d.ts'), path.join(directory, 'media', 'dshoof.m3u8')], {timeout: 15000});
  const started = performance.now();
  const playlist = await until(async () => {
   const response = await request('/weak/dshoof.m3u8', {headers}); assert.ok([200, 503].includes(response.status));
   const text = await response.text(); return response.ok ? text : false;
  }, {timeout: 10000, interval: 100, label: 'first cached weak segment'});
  const elapsed = performance.now() - started, parts = entries(playlist, origin + '/weak/dshoof.m3u8');
  assert.ok(parts[0]?.seconds >= 4, 'first ordinary weak segment contains four media seconds');
  assert.ok(elapsed < 4000, `cached weak startup waited ${Math.round(elapsed)} ms; do not pace old segments at realtime or wait for a large window`);
  const segment = await request(parts[0].url); assert.equal(segment.status, 200); await decode(Buffer.from(await segment.arrayBuffer()));
  t.diagnostic(JSON.stringify({cachedMediaSeconds: 20, firstWeakSegmentSeconds: parts[0].seconds, startupMilliseconds: Math.round(elapsed)}));
 } finally {await closeChild(server); await rm(directory, {recursive: true, force: true});}
});
