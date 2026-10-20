import {ownerLogin} from './test-helpers.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
for(const inputKind of ['code','url'])test(inputKind+' starts HLS without a separate probe and produces authenticated stable HLS',async t=>{
 if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0){t.skip('FFmpeg unavailable');return;}
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-code-'));let child,fixture;let logs='';
 try{
  assert.equal(spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x90:r=25','-t','16','-c:v','libx264','-preset','ultrafast','-g','25','-f','hls','-hls_time','2','-hls_list_size','0','-hls_segment_filename',path.join(dir,'part%d.js'),path.join(dir,'video.css')],{stdio:'ignore'}).status,0);
  fixture=http.createServer(async(req,res)=>{try{if(req.url==='/master.css'){res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90\nvideo.css\n');return;}const payload=await readFile(path.join(dir,path.basename(req.url)));res.end(req.url.endsWith('.css')?payload.toString().replace('#EXT-X-ENDLIST',''):payload);}catch{res.writeHead(404);res.end();}});
  await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const fp=fixture.address().port;
  const preload=path.join(dir,'fixture.mjs');await writeFile(preload,`import dns from 'node:dns/promises';import https from 'node:https';import http from 'node:http';import {syncBuiltinESMExports}from'node:module';const lookup=dns.lookup,request=https.request,originalFetch=globalThis.fetch;dns.lookup=async(h,o)=>h==='smarter.majedcss.site'?[{address:'93.184.216.34',family:4}]:lookup(h,o);https.request=(u,o,cb)=>u.hostname==='smarter.majedcss.site'?http.request('http://127.0.0.1:${fp}'+u.pathname,{...o,lookup:undefined},cb):request(u,o,cb);globalThis.fetch=(u,o)=>String(u).startsWith('https://majed-koora.live/link/api/shortlink/')?Promise.resolve(Response.json({success:true,data:{name:'Code test',config:{url:'https://smarter.majedcss.site/master.css'}}})):String(u).startsWith('https://smarter.majedcss.site/')?originalFetch('http://127.0.0.1:${fp}'+new URL(u).pathname,o):originalFetch(u,o);syncBuiltinESMExports();`);
  const port=34682,origin='http://127.0.0.1:'+port;
  child=spawn(process.execPath,['--import',preload,'server.mjs'],{env:{...process.env,DATA_DIR:path.join(dir,'data'),SERVER_PORT:String(port),FFMPEG_PATH:'ffmpeg'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  for(let i=0;i<50;i++){try{if((await fetch(origin+'/healthz')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const state=JSON.parse(await readFile(path.join(dir,'data/state.json'),'utf8')),cookie=await ownerLogin(origin,state.owner);
  const response=await fetch(origin+'/api/select',{method:'POST',headers:{cookie,origin,'Content-Type':'application/json'},body:JSON.stringify(inputKind==='code'?{kind:'code',code:'617106'}:{kind:'url',url:'https://smarter.majedcss.site/master.css'})});assert.equal(response.status,200,await response.text());
  let ready=false;for(let i=0;i<60;i++){if((await(await fetch(origin+'/healthz')).json()).streamReady){ready=true;break;}await new Promise(r=>setTimeout(r,200));}
  assert.ok(ready,logs);assert.match(logs,/HLS direct start/);assert.doesNotMatch(logs,/\[video-probe\]/);
  const manifest=await(await fetch(origin+'/live/dshoof.m3u8',{headers:{cookie}})).text();assert.match(manifest,/#EXTM3U/);const segment=manifest.split('\n').find(x=>x.startsWith('http'));assert.ok(segment);const data=new Uint8Array(await(await fetch(segment)).arrayBuffer());assert.equal(data[0],0x47);
  assert.equal((await fetch(origin+'/live/dshoof.m3u8')).status,403);
  const stopped=await fetch(origin+'/api/stop',{method:'POST',headers:{cookie,origin,'Content-Type':'application/json'},body:'{}'});assert.equal(stopped.status,200);assert.equal((await fetch(origin+'/live/dshoof.m3u8',{headers:{cookie}})).status,410);
 }finally{if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}if(fixture)await new Promise(r=>fixture.close(r));await rm(dir,{recursive:true,force:true});}
});
