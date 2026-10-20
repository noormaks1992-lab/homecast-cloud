import {ownerLogin} from './test-helpers.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('owner choice reaches real HLS, survives restart and preserves the fixed M3U',async t=>{
 if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0){t.skip('FFmpeg unavailable');return;}
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-majed-choice-'));let child,fixture,logs='';const requests=[];
 const page='https://live.xn----zmcaegc7cl3msazv.com/post?mk=abcdefghijklmnopqrstuv';
 try{
  assert.equal(spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=purple:s=160x90:r=25','-t','16','-c:v','libx264','-preset','ultrafast','-g','25','-f','hls','-hls_time','2','-hls_list_size','0','-hls_segment_filename',path.join(dir,'part%d.js'),path.join(dir,'video.css')],{stdio:'ignore'}).status,0);
  fixture=http.createServer(async(req,res)=>{try{requests.push(req.url);if(req.url.startsWith('/api/public/watch-card')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,watch:{available:true,servers:[{id:'one',name:'سيرفر 1',url:'https://smarter.majedcss.site/one/master.css'},{id:'two',name:'سيرفر 2',url:'https://smarter.majedcss.site/two/master.css'}]}}));return;}if(req.url.endsWith('/master.css')){res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90\nvideo.css\n');return;}if(req.url==='/one/video.css')await new Promise(r=>setTimeout(r,1800));const payload=await readFile(path.join(dir,path.basename(req.url)));res.end(req.url.endsWith('.css')?payload.toString().replace('#EXT-X-ENDLIST',''):payload);}catch{res.writeHead(404);res.end();}});
  await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const fp=fixture.address().port;
  const preload=path.join(dir,'fixture.mjs');await writeFile(preload,`import dns from 'node:dns/promises';import https from 'node:https';import http from 'node:http';import {syncBuiltinESMExports}from'node:module';const lookup=dns.lookup,request=https.request;const hosts=['majed-koora.live','smarter.majedcss.site'];dns.lookup=async(h,o)=>hosts.includes(h)?[{address:'93.184.216.34',family:4}]:lookup(h,o);https.request=(u,o,cb)=>hosts.includes(u.hostname)?http.request('http://127.0.0.1:${fp}'+u.pathname+u.search,{...o,lookup:undefined},cb):request(u,o,cb);syncBuiltinESMExports();`);
  const port=34683,origin='http://127.0.0.1:'+port;
  const start=async()=>{child=spawn(process.execPath,['--import',preload,'server.mjs'],{env:{...process.env,DATA_DIR:path.join(dir,'data'),SERVER_PORT:String(port),FFMPEG_PATH:'ffmpeg'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);for(let i=0;i<50;i++){try{if((await fetch(origin+'/healthz')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Server failed: '+logs);};
  const stop=async()=>{if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}};
  await start();const initial=JSON.parse(await readFile(path.join(dir,'data/state.json'),'utf8'));let cookie=await ownerLogin(origin,initial.owner);
  const post=(url,body,authorized=true)=>fetch(origin+url,{method:'POST',headers:{...(authorized?{cookie}:{}),origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('/api/source-options',{url:page},false)).status,403);
  const discovery=await post('/api/source-options',{url:page});assert.equal(discovery.status,200);const options=await discovery.json();assert.equal(options.servers.length,2);assert.ok(options.servers.every(x=>!x.url));
  const before=await(await fetch(origin+'/api/status',{headers:{cookie}})).json();assert.equal(before.selection,null);
  const selected=await post('/api/select',{kind:'url',url:page,serverId:'two'});assert.equal(selected.status,200,await selected.text());
  for(let i=0;i<60;i++){if((await(await fetch(origin+'/healthz')).json()).streamReady)break;await new Promise(r=>setTimeout(r,200));}
  assert.equal((await(await fetch(origin+'/healthz')).json()).streamReady,true,logs);
  const manifest=await(await fetch(origin+'/live/dshoof.m3u8',{headers:{cookie}})).text();const segment=manifest.split('\n').find(x=>x.startsWith('http'));assert.ok(segment);assert.equal(new Uint8Array(await(await fetch(segment)).arrayBuffer())[0],0x47);
  const persisted=JSON.parse(await readFile(path.join(dir,'data/state.json'),'utf8'));assert.equal(persisted.selection.serverId,'two');assert.equal(persisted.selection.url,page);assert.equal(persisted.selection.serverName,'سيرفر 2');
  assert.ok(requests.some(x=>x.startsWith('/two/')));assert.ok(!requests.some(x=>x.startsWith('/one/')));
  await stop();const oldRequests=requests.length;await start();cookie=await ownerLogin(origin,initial.owner);for(let i=0;i<50&&!requests.slice(oldRequests).some(x=>x.startsWith('/two/'));i++)await new Promise(r=>setTimeout(r,100));
  assert.ok(requests.slice(oldRequests).some(x=>x.startsWith('/two/')),'restart must re-resolve the chosen server');assert.ok(!requests.some(x=>x.startsWith('/one/')));
  const resumed=await(await fetch(origin+'/api/status',{headers:{cookie}})).json();assert.equal(resumed.selection.serverId,'two');assert.equal(resumed.playlist,before.playlist);
  const invalid=await post('/api/select',{kind:'url',url:page,serverId:'missing'});assert.equal(invalid.status,400);assert.equal(JSON.parse(await readFile(path.join(dir,'data/state.json'),'utf8')).selection.serverId,'two');
  const oldManifest=await(await fetch(origin+'/live/dshoof.m3u8',{headers:{cookie}})).text();
  assert.equal((await post('/api/select',{kind:'url',url:page,serverId:'one'})).status,200);
  const switchingStatus=await(await fetch(origin+'/api/status',{headers:{cookie}})).json();assert.equal(switchingStatus.ready,false,'old buffered video must not mark a new source ready');
  for(let i=0;i<60;i++){if((await(await fetch(origin+'/healthz')).json()).streamReady)break;await new Promise(r=>setTimeout(r,200));}
  assert.equal((await(await fetch(origin+'/healthz')).json()).streamReady,true,logs);
  const freshManifest=await(await fetch(origin+'/live/dshoof.m3u8',{headers:{cookie}})).text();
  const oldSegments=oldManifest.split('\n').filter(x=>x.startsWith('http'));assert.ok(oldSegments.every(x=>!freshManifest.includes(x)),'new source must not append segments from the old source');

 }finally{if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}if(fixture)await new Promise(r=>fixture.close(r));await rm(dir,{recursive:true,force:true});}
});
