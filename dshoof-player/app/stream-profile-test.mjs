import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {encodingArgs,streamProfile,budgetProfile} from './stream-profile.mjs';
test('source copy and explicit encoding profiles reject unsupported values',()=>{
 assert.deepEqual(encodingArgs('source'),['-c','copy']);
 for(const id of ['__proto__','unknown','720p'])assert.throws(()=>streamProfile(id));
});
for(const [id,size,expected]of [['emergency144','1920x1080',[256,144]],['economy720','1920x1080',[1280,720]],['economy480','1920x1080',[854,480]],['economy360','1920x1080',[640,360]],['economy720','640x360',[640,360]]]){
 test(`${id} actually produces bounded H264/AAC video from ${size}`,async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-encode-'));
 try{
 const output=path.join(dir,'video.ts');
 const run=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-filter_threads','1','-f','lavfi','-i',`testsrc2=size=${size}:rate=50`,'-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','12',...encodingArgs(id),...(id==='emergency144'?['-pat_period','1']:[]),'-f','mpegts',output],{timeout:60000,encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 const probe=spawnSync('ffprobe',['-v','error','-show_streams','-of','json',output],{encoding:'utf8'});
 const streams=JSON.parse(probe.stdout).streams,v=streams.find(s=>s.codec_type==='video'),a=streams.find(s=>s.codec_type==='audio');
 assert.deepEqual([v.width,v.height],expected);assert.equal(v.codec_name,'h264');assert.equal(v.avg_frame_rate,streamProfile(id).fps+'/1');assert.equal(a.codec_name,'aac');
 const kbps=(await stat(output)).size*8/12/1000,p=streamProfile(id);
 assert.ok(kbps<(p.maxKbps+p.audioKbps)*1.3,`transport bitrate ${kbps}`);
 console.log(JSON.stringify({id,input:size,output:`${v.width}x${v.height}`,transportKbps:Math.round(kbps)}));
 }finally{await rm(dir,{recursive:true,force:true});}
 });
}

test('weak transport budgets shrink for an already small source, without changing source copy',()=>{
 for(const rate of [120,240,480,1200,3500]){
  const p=budgetProfile('economy720',rate);
  assert.ok(p.requiredKbps<=Math.ceil(rate*.7),`source=${rate} output=${p.requiredKbps}`);
  assert.ok(p.maxKbps<=streamProfile(p.id).maxKbps);
  assert.ok(p.videoKbps>0);
  assert.ok(p.audioKbps>=8);
 }
 assert.equal(budgetProfile('economy720',240).id,'economy360');
 assert.equal(budgetProfile('economy720',0),streamProfile('economy720'));
 assert.deepEqual(encodingArgs('source'),['-c','copy']);
 assert.equal(Object.isFrozen(streamProfile('economy720')),true);
});

test('a low-rate source gets fewer transmitted bytes after the weak encode',{timeout:30000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-small-source-'));
 try{
  const input=path.join(dir,'source.ts'),output=path.join(dir,'weak.ts'),duration=16;
  const generated=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-filter_threads','1','-f','lavfi','-i','testsrc2=size=640x360:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',String(duration),'-c:v','libx264','-threads','2','-preset','veryfast','-b:v','160k','-maxrate','176k','-bufsize','352k','-c:a','aac','-b:a','32k','-f','mpegts',input],{timeout:20000,encoding:'utf8'});
  assert.equal(generated.status,0,generated.stderr);
  const sourceKbps=(await stat(input)).size*8/duration/1000,resolved=budgetProfile('economy720',sourceKbps);
  const encoded=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-filter_threads','1','-i',input,'-t',String(duration),...encodingArgs(resolved.id,{resolved}),'-f','mpegts',output],{timeout:20000,encoding:'utf8'});
  assert.equal(encoded.status,0,encoded.stderr);
  const weakKbps=(await stat(output)).size*8/duration/1000;
  assert.ok(weakKbps<sourceKbps*.85,`source=${sourceKbps}, weak=${weakKbps}`);
  assert.ok(weakKbps<=resolved.requiredKbps,`weak=${weakKbps}, requirement=${resolved.requiredKbps}`);
  console.log(JSON.stringify({lowRateSourceKbps:Math.round(sourceKbps),weakTransportKbps:Math.round(weakKbps),effectiveProfile:resolved.id}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
