import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, writeFile, readFile, rm, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWeakStream} from './weak-stream.mjs';

async function fixture() {
 const directory = await mkdtemp(path.join(tmpdir(), 'dshoof-weak-lifecycle-'));
 const input = path.join(directory, 'source.m3u8'), output = path.join(directory, 'weak');
 const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment_1.ts\n';
 await mkdir(output); await writeFile(input, manifest); await writeFile(path.join(directory, 'segment_1.ts'), Buffer.alloc(188000));
 let now = Date.now(), tick; const children = [];
 const stream = createWeakStream({directory: output, input, executable: 'test-fixture', env: {}, now: () => now,
  setTimer: callback => {tick = callback; return {unref() {}};}, clearTimer() {},
  spawnProcess: (_executable, args) => {
   const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.args = args; child.kills = [];
   child.kill = signal => {child.kills.push(signal); queueMicrotask(() => child.emit('close', 0, signal)); return true;};
   children.push(child); return child;
  }
 });
 return {directory, output, input, manifest, stream, children, tick: () => tick(), async publish() {const file = path.join(output, 'dshoof.m3u8'); await writeFile(file, manifest); await utimes(file, new Date(now + 1), new Date(now + 1));}, async advance(milliseconds) {now += milliseconds; await utimes(input, new Date(now), new Date(now));}, async clean() {await stream.close(); await rm(directory, {recursive: true, force: true});}};
}

test('closing while startup is pending cannot create an orphan encoder', async () => {
 const f = await fixture();
 try {
  const starting = f.stream.touch(); await f.stream.close(); await starting; await f.tick();
  assert.equal(f.children.length, 0); assert.equal(f.stream.info().running, false); assert.equal(await f.stream.ready(), false);
  assert.equal(await readFile(f.input, 'utf8'), f.manifest);
 } finally {await f.clean();}
});

test('profile reset clears readiness and stale exits cannot stop the replacement encoder', async () => {
 const f = await fixture();
 try {
  await f.stream.touch(); assert.equal(f.children.length, 1);
  await f.publish();
  assert.equal(await f.stream.ready(), true);
  const old = f.children[0]; await f.stream.reset('economy480');
  assert.equal(await f.stream.ready(), false);
  await f.tick(); assert.equal(f.children.length, 1, 'reset must wait for a viewer before starting another encoder');
  await Promise.all(Array.from({length: 20}, () => f.stream.touch())); assert.equal(f.children.length, 2, 'simultaneous viewers share one encoder');
  old.emit('close', 1); assert.equal(f.stream.info().running, true, 'late old-process events cannot invalidate the new generation');
  assert.equal(f.stream.profile(), 'economy480'); assert.equal(await readFile(f.input, 'utf8'), f.manifest);
  await f.stream.close(); await f.advance(16000); await f.tick();
  assert.equal(f.children.length, 2, 'closed stream must not restart on a queued watchdog tick'); assert.equal(f.stream.info().running, false);
 } finally {await f.clean();}
});

test('encoder launch failure backs off instead of spawning on every playlist poll', async () => {
 const f = await fixture();
 try {
  await f.stream.touch(); const failed = f.children[0]; failed.emit('error', Error('fixture executable unavailable')); failed.emit('close', 1);
  assert.equal(f.stream.info().running, false); assert.equal(await f.stream.ready(), false);
  const retryAt = f.stream.info().retryAt; assert.ok(retryAt > Date.now());
  await Promise.all(Array.from({length: 25}, () => f.stream.touch())); await f.tick(); assert.equal(f.children.length, 1);
  await f.advance(2500); await f.stream.touch(); assert.equal(f.children.length, 2); assert.equal(f.stream.info().running, true);
  assert.equal(await readFile(f.input, 'utf8'), f.manifest);
 } finally {await f.clean();}
});
