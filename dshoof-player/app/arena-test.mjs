import {ownerLogin} from './test-helpers.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const page='https://www.arena8x.live/?arena_match=5795472&arena_date=2026-10-11';
test('legacy embedded page selections are migrated to stopped direct-source mode without fake readiness',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-arena-'));let child,logs='';const port=34597,origin='http://127.0.0.1:'+port;
 async function start(){child=spawn(process.execPath,['server.mjs'],{env:{...process.env,DATA_DIR:dir,SERVER_PORT:String(port),FFMPEG_PATH:'/nonexistent-ffmpeg'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);for(let i=0;i<50;i++){try{if((await fetch(origin+'/healthz')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Server unavailable');}
 async function stop(){const c=child;child=null;if(c){await new Promise(r=>{c.once('exit',r);c.kill();});}}
 try{
 await writeFile(path.join(dir,'state.json'),JSON.stringify({owner:'fixture-owner',viewer:'fixture-viewer',selection:{kind:'arena',url:page,embedUrl:page,title:'old page'},stopped:false}));
 await start();const headers={cookie:await ownerLogin(origin,'fixture-owner'),origin,'Content-Type':'application/json'};
 const status=await(await fetch(origin+'/api/status',{headers})).json();
 assert.equal(status.selection.kind,'url');assert.equal(status.selection.url,page);assert.equal(status.selection.embedUrl,undefined);
 assert.equal(status.ready,false);assert.equal(status.stopped,true);
 assert.equal((await fetch(origin+'/live/dshoof.m3u8',{headers})).status,410);
 assert.equal((await(await fetch(origin+'/api/status')).json()).selection,null);
 const csp=(await fetch(origin)).headers.get('content-security-policy');assert.match(csp,/frame-src 'self' https:\/\/www.youtube-nocookie.com;/);
 const saved=JSON.parse(await readFile(path.join(dir,'state.json'),'utf8'));assert.equal(saved.stopped,true);assert.equal(saved.selection.kind,'url');
 await stop();await start();assert.equal((await(await fetch(origin+'/healthz')).json()).streamReady,false);
 assert.doesNotMatch(logs,/\[ingest\]/);
 }finally{await stop();await rm(dir,{recursive:true,force:true});}
});

