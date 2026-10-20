import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ffmpegRuntime,hlsInputArgsFromHelp} from './ffmpeg-runtime.mjs';

test('isolation is confined to bundled Linux FFmpeg and leaves caller settings intact',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-runtime-'));
 try{
  const env={PATH:process.env.PATH,GCONV_PATH:'/host/gconv',MARKER:'preserved'};
  const r=await ffmpegRuntime(dir,{env,platform:'linux',bundledPath:()=>'/bundled/ffmpeg'});
  assert.equal(r.isolated,true);assert.equal(r.env.MARKER,'preserved');
  assert.equal(env.GCONV_PATH,'/host/gconv');assert.notEqual(r.env.GCONV_PATH,env.GCONV_PATH);
  assert.deepEqual(await readdir(r.env.GCONV_PATH),[]);
  for(const platform of ['win32','darwin']){
   const other=await ffmpegRuntime(dir,{env,platform,bundledPath:()=>'/bundled/ffmpeg'});
   assert.equal(other.isolated,false);assert.equal(other.env.GCONV_PATH,env.GCONV_PATH);
  }
  const custom=await ffmpegRuntime(dir,{env:{...env,FFMPEG_PATH:'/custom/ffmpeg'},platform:'linux',bundledPath:()=>{throw Error('must not resolve');}});
  assert.equal(custom.executable,'/custom/ffmpeg');assert.equal(custom.isolated,false);
  const system=await ffmpegRuntime(dir,{env,platform:'linux',bundledPath:()=>{throw Error('not installed');}});
  assert.equal(system.executable,'ffmpeg');assert.equal(system.isolated,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('isolated FFmpeg preserves real MPEG-TS video and audio through remux',async t=>{
 if(spawnSync('ffmpeg',['-version']).status!==0){t.skip('FFmpeg unavailable');return;}
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-ts-'));
 try{
  const input=path.join(dir,'input.ts'),output=path.join(dir,'output.ts');
  const generated=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=s=64x64:r=10:d=1','-f','lavfi','-i','sine=duration=1','-c:v','mpeg2video','-c:a','mp2','-metadata','service_name=DSHOOF','-f','mpegts',input],{timeout:10000});
  assert.equal(generated.status,0,String(generated.stderr));
  const runtime=await ffmpegRuntime(dir,{platform:'linux',bundledPath:()=> 'ffmpeg'});
  const remux=spawnSync(runtime.executable,['-hide_banner','-loglevel','error','-i',input,'-map','0:v:0','-map','0:a:0','-c','copy',output],{env:runtime.env,timeout:10000});
  assert.equal(remux.signal,null);assert.equal(remux.status,0,String(remux.stderr));
  const inspected=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_type','-of','json',output],{encoding:'utf8'});
  assert.equal(inspected.status,0,inspected.stderr);
  const kinds=JSON.parse(inspected.stdout).streams.map(x=>x.codec_type);
  assert.ok(kinds.includes('video'));assert.ok(kinds.includes('audio'));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('HLS extension compatibility only enables flags supported by the selected FFmpeg',()=>{
 assert.deepEqual(hlsInputArgsFromHelp('  -allowed_extensions <string>'),['-allowed_extensions','ALL']);
 assert.deepEqual(hlsInputArgsFromHelp('  -allowed_segment_extensions <string>\n -extension_picky <boolean>'),['-allowed_extensions','ALL','-allowed_segment_extensions','ALL','-extension_picky','0']);
});

test('current FFmpeg can read real HLS TS segments published with .js and .css suffixes',async t=>{
 if(spawnSync('ffmpeg',['-version']).status!==0){t.skip('FFmpeg unavailable');return;}
 const dir=await mkdtemp(path.join(tmpdir(),'dshoof-hls-extension-'));
 try{
  const manifest=path.join(dir,'video.css');
  const generated=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=purple:s=160x90:r=25','-t','4','-c:v','libx264','-threads','1','-preset','ultrafast','-g','25','-f','hls','-hls_time','1','-hls_list_size','0','-hls_segment_filename',path.join(dir,'part%d.js'),manifest],{encoding:'utf8',timeout:10000});
  assert.equal(generated.status,0,generated.stderr);
  const runtime=await ffmpegRuntime(dir,{env:{...process.env,FFMPEG_PATH:'ffmpeg'}});
  const inspected=spawnSync(runtime.executable,['-hide_banner','-loglevel','error','-protocol_whitelist','file,crypto','-f','hls',...runtime.hlsInputArgs,'-i',manifest,'-map','0:v:0','-c','copy','-t','1','-f','null','-'],{env:runtime.env,encoding:'utf8',timeout:10000});
  assert.equal(inspected.status,0,inspected.stderr);assert.equal(runtime.hlsInputArgs.includes('-protocol_whitelist'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
