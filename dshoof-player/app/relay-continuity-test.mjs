import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRelayTimeline} from './relay-continuity.mjs';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {ownerLogin} from './test-helpers.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const stop=async p=>{if(p&&p.exitCode===null&&p.signalCode===null){const done=new Promise(r=>p.once('close',r));p.kill();await done;}};
test('discontinuity numbers remain stable when markers leave the sliding window',()=>{
 const t=createRelayTimeline();
 const list=(first,body)=>`#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${first}\n${body}`;
 assert.match(t.normalize(list(1,'#EXT-X-DISCONTINUITY\nsegment_1.ts\nsegment_2.ts\n')),/SEQUENCE:0/);
 assert.match(t.normalize(list(2,'segment_2.ts\n#EXT-X-DISCONTINUITY\nsegment_3.ts\n')),/DISCONTINUITY-SEQUENCE:1/);
 assert.match(t.normalize(list(3,'#EXT-X-DISCONTINUITY\nsegment_3.ts\nsegment_4.ts\n')),/DISCONTINUITY-SEQUENCE:1/);
 assert.match(t.normalize(list(4,'segment_4.ts\nsegment_5.ts\n')),/DISCONTINUITY-SEQUENCE:2/);
});
test('live HLS continues across two forced local relay crashes without expiring direct URLs',{timeout:210000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-continuity-'));let child,generator,fixture,logs='';
 try{
  generator=spawn('ffmpeg',['-v','error','-re','-f','lavfi','-i','color=c=blue:s=160x90:r=25','-c:v','libx264','-threads','1','-preset','ultrafast','-g','25','-f','hls','-hls_time','1','-hls_list_size','12','-hls_flags','temp_file','-hls_segment_filename',path.join(dir,'part%d.ts'),path.join(dir,'source.m3u8')],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await readFile(path.join(dir,'source.m3u8'),'utf8')).includes('part2.ts'))break;}catch{}await delay(100);}
  fixture=http.createServer(async(req,res)=>{try{res.end(await readFile(path.join(dir,path.basename(req.url))));}catch{res.writeHead(404).end();}});
  await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const fp=fixture.address().port;
  const preload=path.join(dir,'fixture.mjs');await writeFile(preload,`import dns from 'node:dns/promises';import https from 'node:https';import http from 'node:http';import {syncBuiltinESMExports}from'node:module';const lookup=dns.lookup,request=https.request;dns.lookup=async(h,o)=>h==='live.example'?[{address:'93.184.216.34',family:4}]:lookup(h,o);https.request=(u,o,cb)=>u.hostname==='live.example'?http.request('http://127.0.0.1:${fp}'+u.pathname,{...o,lookup:undefined},cb):request(u,o,cb);syncBuiltinESMExports();`);
  // Record only the PID of this test's output worker, never production processes.
  const wrapper=path.join(dir,'ffmpeg-wrapper');await writeFile(wrapper,`#!/bin/sh\ncase "$*" in *"${dir}/data/media/dshoof.m3u8"*) echo $$ >> "${dir}/relay-pids";; esac\nexec ffmpeg "$@"\n`);await chmod(wrapper,0o700);
  const origin='http://127.0.0.1:34898';child=spawn(process.execPath,['--import',preload,'server.mjs'],{env:{...process.env,DATA_DIR:path.join(dir,'data'),SERVER_PORT:'34898',FFMPEG_PATH:wrapper},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  for(let i=0;i<100;i++){try{if((await fetch(origin+'/healthz')).ok)break;}catch{}await delay(100);}
  const initial=JSON.parse(await readFile(path.join(dir,'data/state.json'),'utf8')),cookie=await ownerLogin(origin,initial.owner),headers={cookie,origin,'content-type':'application/json'};
  const response=await fetch(origin+'/api/select',{method:'POST',headers,body:JSON.stringify({kind:'url',url:'https://live.example/source.m3u8'})});assert.equal(response.status,200,await response.text());
  const started=Date.now(),duration=Number(process.env.CONTINUITY_SECONDS||165)*1000,killed=new Set(),relayNumbers=new Map();let previous=0,lastAdvance=Date.now(),maxGap=0,firstDirect=null,directAdvances=0,lastDirect=0,checks=0;
  while(Date.now()-started<duration){
   const elapsed=Date.now()-started;
   for(const at of [15000,45000])if(elapsed>=at&&!killed.has(at)){
    const pid=Number((await readFile(path.join(dir,'relay-pids'),'utf8')).trim().split('\n').at(-1));assert.ok(Number.isSafeInteger(pid)&&pid>1);process.kill(pid,'SIGKILL');killed.add(at);
   }
   const direct=await fetch(origin+'/quality/auto.m3u8',{headers});assert.equal(direct.status,200);const text=await direct.text(),n=Number(text.match(/MEDIA-SEQUENCE:(\d+)/)?.[1]);
   if(n>lastDirect){directAdvances++;lastDirect=n;}
   firstDirect??=text.split('\n').find(l=>l.startsWith('http'));
   // The URL issued before either crash must remain valid afterward.
   assert.equal((await fetch(firstDirect,{headers})).status,200);
   const relay=await fetch(origin+'/live/dshoof.m3u8',{headers});
   if(relay.ok){const m=await relay.text(),seq=Number(m.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1]),links=m.split('\n').filter(l=>l.startsWith('http'));assert.ok(links.length);let cc=Number(m.match(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/)?.[1]);assert.ok(Number.isFinite(cc));let index=0;
    for(const line of m.split('\n')){if(line==='#EXT-X-DISCONTINUITY')cc++;if(line.startsWith('http')){const value={sequence:seq+index++,cc};if(relayNumbers.has(line))assert.deepEqual(value,relayNumbers.get(line),'existing segment changed sequence or discontinuity');relayNumbers.set(line,value);}}
    const last=seq+links.length-1;if(last>previous){if(previous)assert.equal(last-previous<=4,true,'relay sequence jumped on recovery');previous=last;maxGap=Math.max(maxGap,Date.now()-lastAdvance);lastAdvance=Date.now();checks++;}
    assert.equal((await fetch(links.at(-1),{headers})).status,200);
   }
   assert.ok(Date.now()-lastAdvance<15000,'relay stopped advancing for 15 seconds');
   await delay(500);
  }
  assert.equal(killed.size,2);assert.ok(directAdvances>60);assert.ok(checks>35);assert.ok(relayNumbers.size>48,'must exercise sliding out discontinuity markers');
  const pids=(await readFile(path.join(dir,'relay-pids'),'utf8')).trim().split('\n');assert.equal(pids.length,3,'only the two forced failures may restart the relay');
  console.log(JSON.stringify({seconds:Math.round((Date.now()-started)/1000),forcedCrashes:2,directAdvances,relayAdvances:checks,maxRelayUpdateGapMs:maxGap,segments:relayNumbers.size}));
 }catch(error){error.message+='\n'+logs;throw error;}
 finally{await stop(child);await stop(generator);if(fixture){fixture.closeAllConnections();await new Promise(r=>fixture.close(r));}await rm(dir,{recursive:true,force:true});}
});
