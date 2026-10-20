import {test} from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {mkdtemp,writeFile,rm,utimes} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createWeakStream} from './weak-stream.mjs';
test('one weak encoder, independent overload fallback, bounded retries and idle shutdown',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-watchdog-')),input=path.join(dir,'source.m3u8');let now=Date.now(),tick;const children=[];
 await writeFile(input,'#EXTM3U');
 const weak=createWeakStream({directory:path.join(dir,'weak'),input,executable:'fixture',env:{},now:()=>now,setTimer:fn=>{tick=fn;return {unref(){}};},clearTimer(){},spawnProcess:(_cmd,args)=>{const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.args=args;p.kill=()=>{queueMicrotask(()=>p.emit('close',0));return true;};children.push(p);return p;}});
 try{
 await weak.reset('economy720');await Promise.all(Array.from({length:40},()=>weak.touch()));assert.equal(children.length,1);assert.equal(weak.info().running,true);
 assert.equal(children[0].args[children[0].args.indexOf('-live_start_index')+1],'-20');
 assert.equal(children[0].args.includes('-readrate'),false);assert.equal(children[0].args.includes('-re'),false);
 for(const [next,idx]of [['economy480',0],['economy360',1]]){children[idx].stdout.emit('data',Buffer.from('out_time_us=15000000\n'));now+=31000;await utimes(input,new Date(now),new Date(now));await weak.touch();await tick();assert.equal(children.length,idx+1);children[idx].stdout.emit('data',Buffer.from('out_time_us=30000000\n'));now+=31000;await utimes(input,new Date(now),new Date(now));await weak.touch();await tick();assert.equal(weak.profile(),next);assert.equal(children.length,idx+2);}
 children[2].stdout.emit('data',Buffer.from('out_time_us=15000000\n'));now+=31000;await utimes(input,new Date(now),new Date(now));await weak.touch();await tick();assert.equal(weak.info().running,true);children[2].stdout.emit('data',Buffer.from('out_time_us=30000000\n'));now+=31000;await utimes(input,new Date(now),new Date(now));await weak.touch();await tick();assert.equal(weak.info().running,false);assert.ok(weak.info().retryAt>now);await weak.touch();assert.equal(children.length,3);
 now+=61000;await utimes(input,new Date(now),new Date(now));await weak.touch();assert.equal(children.length,4);
 now+=121000;await tick();assert.equal(weak.info().running,false);assert.equal(await (await import('node:fs/promises')).readFile(input,'utf8'),'#EXTM3U');
 }finally{await weak.close();await rm(dir,{recursive:true,force:true});}
});
