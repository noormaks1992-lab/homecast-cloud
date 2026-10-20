import {ownerLogin} from './test-helpers.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('a stale recovery failure cannot overwrite the newly selected working source',async t=>{
 if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0){t.skip('FFmpeg unavailable');return;}
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-majed-choice-'));let child,fixture,logs='';const requests=[];
 const page='https://live.xn----zmcaegc7cl3msazv.com/post?mk=abcdefghijklmnopqrstuv';
 try{
  assert.equal(spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=purple:s=160x90:r=25','-t','16','-c:v','libx264','-preset','ultrafast','-g','25','-f','hls','-hls_time','2','-hls_list_size','0','-hls_segment_filename',path.join(dir,'part%d.js'),path.join(dir,'video.css')],{stdio:'ignore'}).status,0);
  fixture=http.createServer(async(req,res)=>{try{requests.push(req.url);if(req.url==='/stale.m3u8'){await new Promise(r=>setTimeout(r,2500));res.writeHead(403);res.end('expired old source');return;}if(req.url.startsWith('/api/public/watch-card')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,watch:{available:true,servers:[{id:'one',name:'سيرفر 1',url:'https://smarter.majedcss.site/one/master.css'},{id:'two',name:'سيرفر 2',url:'https://smarter.majedcss.site/two/master.css'}]}}));return;}if(req.url.endsWith('/master.css')){res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90\nvideo.css\n');return;}if(req.url==='/one/video.css')await new Promise(r=>setTimeout(r,1800));const payload=await readFile(path.join(dir,path.basename(req.url)));res.end(req.url.endsWith('.css')?payload.toString().replace('#EXT-X-ENDLIST',''):payload);}catch{res.writeHead(404);res.end();}});
  await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const fp=fixture.address().port;
  const preload=path.join(dir,'fixture.mjs');await writeFile(preload,`import dns from 'node:dns/promises';import https from 'node:https';import http from 'node:http';import {syncBuiltinESMExports}from'node:module';const lookup=dns.lookup,request=https.request;const hosts=['majed-koora.live','smarter.majedcss.site'];dns.lookup=async(h,o)=>hosts.includes(h)?[{address:'93.184.216.34',family:4}]:lookup(h,o);https.request=(u,o,cb)=>hosts.includes(u.hostname)?http.request('http://127.0.0.1:${fp}'+u.pathname+u.search,{...o,lookup:undefined},cb):request(u,o,cb);syncBuiltinESMExports();`);
  const port=34684,origin='http://127.0.0.1:'+port;
  const start=async()=>{child=spawn(process.execPath,['--import',preload,'server.mjs'],{env:{...process.env,DATA_DIR:path.join(dir,'data'),SERVER_PORT:String(port),FFMPEG_PATH:'ffmpeg'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);for(let i=0;i<50;i++){try{if((await fetch(origin+'/healthz')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Server failed: '+logs);};
  const stop=async()=>{if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}};
  await mkdir(path.join(dir,'data'),{recursive:true});
  await writeFile(path.join(dir,'data/state.json'),JSON.stringify({owner:'test-owner',viewer:'test-viewer',history:[],invites:[],selection:{kind:'url',url:'https://smarter.majedcss.site/stale.m3u8',title:'old'}}));
  await start();const cookie=await ownerLogin(origin,'test-owner');
  for(let i=0;i<30&&!requests.includes('/stale.m3u8');i++)await new Promise(r=>setTimeout(r,50));
  assert.ok(requests.includes('/stale.m3u8'));
  const response=await fetch(origin+'/api/select',{method:'POST',headers:{cookie,origin,'Content-Type':'application/json'},body:JSON.stringify({kind:'url',url:page,serverId:'two'})});
  assert.equal(response.status,200,await response.text());
  await new Promise(r=>setTimeout(r,3000));
  const status=await(await fetch(origin+'/api/status',{headers:{cookie}})).json();
  assert.equal(status.selection.serverId,'two');assert.equal(status.ready,true,logs);
  assert.doesNotMatch(status.status,/403|expired|تعذر/,'a rejected old attempt must not replace the active source status');
  assert.equal((logs.match(/\[ingest\] HLS direct start/g)||[]).length,1,'only one ingest process may start for the new source');
  const stopped=await fetch(origin+'/api/stop',{method:'POST',headers:{cookie,origin,'Content-Type':'application/json'},body:'{}'});
  assert.equal(stopped.status,200);assert.equal((await(await fetch(origin+'/healthz')).json()).streamReady,false);
 }finally{if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}if(fixture)await new Promise(r=>fixture.close(r));await rm(dir,{recursive:true,force:true});}
});
