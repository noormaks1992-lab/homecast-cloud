import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {transportMetrics,createWeakStream} from './weak-stream.mjs';

test('transport metrics count MPEG-TS bytes and media duration, without following foreign paths',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-transport-'));
 try{
  const manifest=path.join(dir,'dshoof.m3u8');
  await writeFile(path.join(dir,'segment_1.ts'),Buffer.alloc(50000));
  await writeFile(path.join(dir,'segment_2.ts'),Buffer.alloc(75000));
  await writeFile(manifest,'#EXTM3U\n#EXTINF:4,\nsegment_1.ts\n#EXTINF:6,\nsegment_2.ts\n#EXTINF:2,\n../outside.ts\n#EXTINF:3,\nsegment_3.ts\n');
  assert.deepEqual(await transportMetrics(manifest),{transportKbps:100,bufferedSeconds:10,segmentCount:2});
  assert.deepEqual(await transportMetrics(manifest,{maxSegments:2}),{transportKbps:100,bufferedSeconds:10,segmentCount:2});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('an unavailable primary ingest is a clean retry, without child spawn or unhandled rejection',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-no-ingest-'));let spawns=0;
 const weak=createWeakStream({directory:path.join(dir,'weak'),input:path.join(dir,'missing.m3u8'),executable:'fixture',env:{},spawnProcess(){spawns++;throw Error('must not spawn');}});
 try{await weak.reset('economy360');await Promise.all([weak.touch(),weak.touch()]);assert.equal(spawns,0);assert.equal(await weak.ready(),false);assert.equal(weak.info().running,false);}finally{await weak.close();await rm(dir,{recursive:true,force:true});}
});

test('a source bitrate decrease lowers the shared encoder budget instead of inflating the source',async()=>{
 const {EventEmitter}=await import('node:events');
 const {utimes}=await import('node:fs/promises');
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-source-drop-')),input=path.join(dir,'primary.m3u8');let now=Date.now(),tick;const children=[];
 const writeSource=async size=>{for(const id of [1,2])await writeFile(path.join(dir,`segment_${id}.ts`),Buffer.alloc(size));await writeFile(input,'#EXTM3U\n#EXTINF:4,\nsegment_1.ts\n#EXTINF:4,\nsegment_2.ts\n');await utimes(input,new Date(now),new Date(now));};
 await writeSource(1500000);
 const weak=createWeakStream({directory:path.join(dir,'weak'),input,executable:'fixture',env:{},now:()=>now,setTimer:fn=>{tick=fn;return {unref(){}};},clearTimer(){},spawnProcess:(_cmd,args)=>{const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.kill=()=>{queueMicrotask(()=>p.emit('close',0));return true;};p.args=args;children.push(p);return p;}});
 try{
  await weak.reset('economy720');await weak.touch();const before=weak.info().requiredKbps;assert.equal(weak.profile(),'economy720');
  now+=25000;await writeSource(100000);await weak.touch();await tick();
  assert.equal(children.length,2);assert.equal(weak.profile(),'economy360');assert.ok(weak.info().requiredKbps<before*.5);assert.equal(weak.info().sourceKbps,200);
 }finally{await weak.close();await rm(dir,{recursive:true,force:true});}
});
