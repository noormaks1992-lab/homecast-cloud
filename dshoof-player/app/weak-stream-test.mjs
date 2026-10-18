import {ownerLogin} from './test-helpers.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await delay(250);}throw Error('test timed out');}
async function close(p){if(p&&p.exitCode===null&&p.signalCode===null){p.kill('SIGTERM');await new Promise(r=>p.once('close',r));}}
test('weak path encodes independently; primary bytes, stable link and auth stay intact',{timeout:65000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-weak-'));let server,producer,logs='';const origin='http://127.0.0.1:34782';
 try{
 await mkdir(path.join(dir,'media'));
 server=spawn(process.execPath,['server.mjs'],{env:{...process.env,DATA_DIR:dir,SERVER_PORT:'34782',FFMPEG_PATH:'ffmpeg'},stdio:['ignore','pipe','pipe']});server.stderr.on('data',b=>logs+=b);
 await until(async()=>{try{return (await fetch(origin+'/healthz')).ok;}catch{return false;}});
 const state=JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')),headers={cookie:await ownerLogin(origin,state.owner),origin,'Content-Type':'application/json'};
 const post=(url,body,auth=headers)=>fetch(origin+url,{method:'POST',headers:auth,body:JSON.stringify(body)});
 const before=await(await fetch(origin+'/api/status',{headers})).json();
 assert.equal((await post('/api/stream-profile',{profile:'economy720'}, {origin,'Content-Type':'application/json'})).status,403);
 assert.equal((await post('/api/stream-profile',{})).status,400);
 assert.equal((await post('/api/stream-profile',{profile:'source'})).status,400);
 assert.equal((await post('/api/stream-profile',{profile:'economy720'})).status,200);
 producer=spawn('ffmpeg',['-hide_banner','-loglevel','error','-filter_threads','1','-re','-f','lavfi','-i','testsrc2=size=1920x1080:rate=25','-f','lavfi','-i','sine=sample_rate=48000','-t','50','-c:v','libx264','-threads','2','-preset','ultrafast','-b:v','3500k','-g','100','-sc_threshold','0','-c:a','aac','-f','hls','-hls_time','4','-hls_list_size','24','-hls_flags','temp_file+omit_endlist','-hls_segment_filename',path.join(dir,'media','segment_%d.ts'),path.join(dir,'media','dshoof.m3u8')],{stdio:'ignore'});
 await until(async()=>{try{return (await fetch(origin+'/live/dshoof.m3u8',{headers})).ok;}catch{return false;}});
 assert.equal((await fetch(origin+'/weak/dshoof.m3u8')).status,403);
 const weak=await until(async()=>{const r=await fetch(origin+'/weak/dshoof.m3u8',{headers});return r.ok?await r.text():false;});
 const weakURL=weak.split('\n').find(x=>x.startsWith('http'));
 const encoded=Buffer.from(await(await fetch(weakURL)).arrayBuffer());
 const info=spawnSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=height','-of','json','pipe:0'],{input:encoded});assert.equal(JSON.parse(info.stdout).streams[0].height,720);
 const primary=await(await fetch(origin+'/live/dshoof.m3u8',{headers})).text(),primaryURL=primary.split('\n').find(x=>x.startsWith('http'));
 const primaryBytes=Buffer.from(await(await fetch(primaryURL)).arrayBuffer());
 assert.deepEqual(primaryBytes,await readFile(path.join(dir,'media',path.basename(new URL(primaryURL).pathname))));
 const original=spawnSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=height','-of','json','pipe:0'],{input:primaryBytes});assert.equal(JSON.parse(original.stdout).streams[0].height,1080);
 assert.equal((await fetch(origin+'/emergency/dshoof.m3u8')).status,403);
 const emergency=await until(async()=>{const r=await fetch(origin+'/emergency/dshoof.m3u8',{headers});return r.ok?await r.text():false;});
 const emergencyURL=emergency.split('\n').find(x=>x.startsWith('http'));assert.match(emergencyURL,/\/emergency\//);
 const emergencyBytes=Buffer.from(await(await fetch(emergencyURL)).arrayBuffer());
 const emergencyProbe=spawnSync('ffprobe',['-v','error','-show_streams','-of','json','pipe:0'],{input:emergencyBytes});const emergencyStreams=JSON.parse(emergencyProbe.stdout).streams;
 assert.equal(emergencyStreams.find(x=>x.codec_type==='video').height,144);assert.equal(emergencyStreams.find(x=>x.codec_type==='audio').channels,1);
 const duration=Number(emergency.match(/#EXTINF:([0-9.]+)/)[1]);const bitrate=emergencyBytes.length*8/duration/1000;assert.ok(bitrate<85,`emergency transport ${bitrate} kbps`);console.log(JSON.stringify({emergencyTransportKbps:bitrate}));
 const emergencyPlaylist=await(await fetch(before.playlist.replace('.m3u','/emergency.m3u'))).text();assert.match(emergencyPlaylist,/\/emergency\/dshoof.m3u8/);
 const after=await(await fetch(origin+'/api/status',{headers})).json();assert.equal(after.playlist,before.playlist);assert.equal(after.weakReady,true);assert.equal(after.selection,before.selection);
 const m3u=await(await fetch(before.playlist)).text();assert.match(m3u,/\/live\/dshoof.m3u8/);assert.doesNotMatch(m3u,/\/weak\//);
 assert.equal((await post('/api/stream-profile',{profile:'economy480'})).status,200);
 assert.equal((await fetch(origin+'/live/dshoof.m3u8',{headers})).status,200);
 assert.equal((await(await fetch(origin+'/api/status',{headers})).json()).weakReady,false);
 assert.equal((await fetch(new URL(weakURL).origin+new URL(weakURL).pathname)).status,403);
 await post('/api/stop',{});assert.equal((await fetch(emergencyURL)).status,410);assert.equal((await fetch(weakURL)).status,410);
 console.log('Decoded independent 720p weak and unchanged 1080p primary; auth, stop, profile switch and stable M3U passed.');
 }catch(e){e.message+=' '+logs;throw e;}finally{await close(producer);await close(server);await rm(dir,{recursive:true,force:true});}
});
