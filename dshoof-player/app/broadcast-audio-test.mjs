import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {audioSettings,audioOutputArgs} from './broadcast-audio.mjs';
import {ownerLogin} from './test-helpers.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(fn,message)=>{for(let i=0;i<150;i++){try{const v=await fn();if(v)return v;}catch{}await delay(100);}throw Error(message);};
const stop=async p=>{if(p&&p.exitCode===null&&p.signalCode===null){const done=new Promise(r=>p.once('close',r));p.kill('SIGTERM');await done;}};
test('audio settings reject private URLs and invalid levels, copy video separately',()=>{
 assert.throws(()=>audioSettings({mode:'external',url:'http://127.0.0.1/audio'}));
 assert.throws(()=>audioSettings({gain:'nan'}));assert.throws(()=>audioSettings({delay:31}));
 assert.deepEqual(audioOutputArgs({mode:'mute'}),['-an']);
 assert.deepEqual(audioOutputArgs(),['-map','0:a:0?','-c:a','copy']);
 assert.ok(audioOutputArgs({mode:'external',url:'https://audio.example/x',gain:80,delay:1}).includes('1:a:0'));
});
test('real live video: global mute, independent audio, validation, isolation and persistence',{timeout:120000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-audio-'));let child,generator,fixture,logs='';
 try{
  const exec=(args)=>{const r=spawnSync('ffmpeg',['-v','error',...args]);assert.equal(r.status,0,r.stderr.toString());};
  exec(['-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-t','35','-c:a','libmp3lame',path.join(dir,'audio.mp3')]);
  exec(['-f','lavfi','-i','color=c=red:s=160x90:r=25','-t','1','-c:v','libx264','-threads','1','-an',path.join(dir,'silent.mp4')]);
  generator=spawn('ffmpeg',['-v','error','-re','-f','lavfi','-i','color=c=blue:s=160x90:r=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-c:v','libx264','-threads','1','-preset','ultrafast','-g','25','-c:a','aac','-f','hls','-hls_time','1','-hls_list_size','12','-hls_flags','temp_file','-hls_segment_filename',path.join(dir,'part%d.ts'),path.join(dir,'live.m3u8')],{stdio:'ignore'});
  await wait(async()=>/part2.ts/.test(await readFile(path.join(dir,'live.m3u8'),'utf8')),'fixture did not start');
  const requests=[];
  fixture=http.createServer(async(req,res)=>{try{requests.push(req.url);const file=path.basename(new URL(req.url,'http://local').pathname);if(file==='silent.mp4')await delay(300);res.setHeader('Content-Type',file.endsWith('.mp3')?'audio/mpeg':file.endsWith('.mp4')?'video/mp4':'application/octet-stream');res.end(await readFile(path.join(dir,file)));}catch{res.writeHead(404).end();}});
  await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const port=fixture.address().port;
  const preload=path.join(dir,'fixture.mjs');
  await writeFile(preload,`import dns from 'node:dns/promises';import https from 'node:https';import http from 'node:http';import {syncBuiltinESMExports}from'node:module';const lookup=dns.lookup,request=https.request;dns.lookup=async(h,o)=>['video.example','audio.example'].includes(h)?[{address:'93.184.216.34',family:4}]:lookup(h,o);https.request=(u,o,cb)=>['video.example','audio.example'].includes(u.hostname)?http.request('http://127.0.0.1:${port}'+u.pathname,{...o,lookup:undefined},cb):request(u,o,cb);syncBuiltinESMExports();`);
  const origin='http://127.0.0.1:34897';
  child=spawn(process.execPath,['--import',preload,'server.mjs'],{env:{...process.env,DATA_DIR:path.join(dir,'data'),SERVER_PORT:'34897',FFMPEG_PATH:'ffmpeg'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  await wait(async()=>(await fetch(origin+'/healthz')).ok,'server startup failed');
  const initial=JSON.parse(await readFile(path.join(dir,'data/state.json'),'utf8')),cookie=await ownerLogin(origin,initial.owner),headers={cookie,origin,'content-type':'application/json'};
  const post=(route,body)=>fetch(origin+route,{method:'POST',headers,body:JSON.stringify(body)});
  const status=(id='1')=>fetch(origin+'/api/status?channel='+id,{headers}).then(r=>r.json());
  const audio=async body=>{const r=await post('/api/audio',{channel:'1',...body});assert.equal(r.status,200,await r.text());};
  assert.equal((await fetch(origin+'/api/audio',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"mode":"mute"}'})).status,403);
  const selected=await post('/api/select',{channel:'1',kind:'url',url:'https://video.example/live.m3u8'});assert.equal(selected.status,200,await selected.text());
  await wait(async()=>(await status()).relayReady,'relay did not start: '+logs);
  const original=await status();assert.equal(original.requiresRelay,false);
  // Warm direct segment identifiers; mute must block them as well as new direct requests.
  const direct=await(await fetch(origin+'/quality/auto.m3u8',{headers})).text();const oldSegment=direct.split('\n').find(x=>x.startsWith('http'));
  await audio({mode:'mute'});
  await wait(async()=>(await status()).relayReady,'muted relay did not start: '+logs);
  assert.equal((await fetch(oldSegment,{headers})).status,410);
  assert.equal((await status()).requiresRelay,true);assert.equal((await status('2')).requiresRelay,false);
  const readOutput=async()=>{
   const manifest=await(await fetch(origin+'/live/dshoof.m3u8',{headers})).text();const segment=manifest.split('\n').filter(x=>x.startsWith('http')).at(-1);assert.ok(segment,manifest);
   const bytes=Buffer.from(await(await fetch(segment,{headers})).arrayBuffer());
   const probe=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_name,codec_type,width,height','-of','json','pipe:0'],{input:bytes});assert.equal(probe.status,0,probe.stderr.toString());return {bytes,streams:JSON.parse(probe.stdout).streams};
  };
  const muted=await readOutput();assert.equal(muted.streams.filter(s=>s.codec_type==='audio').length,0);assert.equal(muted.streams[0].codec_name,'h264');assert.equal(muted.streams[0].height,90);
  const auto=await fetch(origin+'/quality/auto.m3u8',{headers,redirect:'manual'});assert.equal(auto.status,307);assert.match(auto.headers.get('location'),/\/live\/dshoof.m3u8/);
  const beforeBad=(await status()).audioRevision;
  const badRequest=post('/api/audio',{mode:'external',url:'https://video.example/silent.mp4'});await delay(100);assert.equal((await fetch(origin+'/live/dshoof.m3u8',{headers})).status,200,'validation must not block current viewers');const bad=await badRequest;assert.equal(bad.status,400);assert.equal((await status()).audioRevision,beforeBad);assert.equal((await status()).audio.mode,'mute');assert.equal((await status()).relayReady,true);
  await audio({mode:'external',url:'https://audio.example/audio.mp3',gain:80,delay:0});
  await wait(async()=>(await status()).relayReady,'independent audio relay did not start: '+logs);
  const mixed=await readOutput();assert.equal(mixed.streams[0].height,90);assert.equal(mixed.streams.find(s=>s.codec_type==='audio')?.codec_name,'aac');
  const pcm=spawnSync('ffmpeg',['-v','error','-i','pipe:0','-map','0:a:0','-t','1','-ar','8000','-ac','1','-f','s16le','pipe:1'],{input:mixed.bytes});assert.equal(pcm.status,0,pcm.stderr.toString());
  let crossings=0;for(let i=2;i<pcm.stdout.length;i+=2)if(pcm.stdout.readInt16LE(i-2)<=0&&pcm.stdout.readInt16LE(i)>0)crossings++;
  const frequency=crossings/(pcm.stdout.length/2/8000);assert.ok(frequency>850&&frequency<910,'must contain external 880Hz, not original 440Hz: '+frequency);
  await audio({mode:'source'});await wait(async()=>(await status()).relayReady,'original audio did not resume: '+logs);
  assert.equal((await status()).requiresRelay,false);assert.equal((await fetch(origin+'/quality/auto.m3u8',{headers})).status,200);
  const saved=JSON.parse(await readFile(path.join(dir,'data/state.json'),'utf8'));assert.equal(saved.owner,initial.owner);assert.equal(saved.viewer,initial.viewer);assert.equal(saved.playlistAlias,initial.playlistAlias);assert.equal(saved.audio.mode,'source');assert.equal(saved.secondChannel.audio.mode,'source');assert.ok(requests.includes('/audio.mp3'));
  console.log('Decoded H.264 video unchanged; mute removed audio; replacement AAC measured '+Math.round(frequency)+'Hz; invalid source preserved working stream.');
 }catch(error){error.message+='\n'+logs;throw error;}
 finally{await stop(child);await stop(generator);if(fixture){fixture.closeAllConnections();await new Promise(r=>fixture.close(r));}await rm(dir,{recursive:true,force:true});}
});
