import {spawn} from 'node:child_process';
import {mkdtemp,readFile,readdir,stat,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {encodingArgs} from './stream-profile.mjs';
const duration=Number(process.env.SOAK_SECONDS||900),window=Number(process.env.SOAK_WINDOW||24),dir=await mkdtemp(path.join(tmpdir(),'dshoof-soak-'));
const started=Date.now(),samples=[];let stderr='',done=false,failed=false;
const proc=spawn('ffmpeg',['-hide_banner','-loglevel','error','-filter_threads','1','-re','-f','lavfi','-i','testsrc2=size=1920x1080:rate=25','-re','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',String(duration),...encodingArgs('economy720'),'-f','hls','-hls_time','4','-hls_list_size',String(window),'-hls_delete_threshold',window>24?'8':'2','-hls_flags','delete_segments+temp_file+program_date_time','-hls_segment_filename',path.join(dir,'segment_%d.ts'),path.join(dir,'live.m3u8')],{stdio:['ignore','ignore','pipe']});
proc.stderr.on('data',b=>stderr=(stderr+b).slice(-4000));
proc.on('error',e=>{stderr+=e.message;failed=true;});
const timer=setInterval(async()=>{try{
 const manifest=await readFile(path.join(dir,'live.m3u8'),'utf8'),mtime=(await stat(path.join(dir,'live.m3u8'))).mtimeMs;
 const age=Date.now()-mtime;if(age>12000)failed=true;
 const files=(await readdir(dir)).filter(n=>n.endsWith('.ts'));let bytes=0;for(const f of files){try{bytes+=(await stat(path.join(dir,f))).size;}catch{}}
 let rssKB=null;try{rssKB=Number((await readFile('/proc/'+proc.pid+'/status','utf8')).match(/VmRSS:\s+(\d+)/)?.[1]);}catch{}
 const sample={seconds:Math.round((Date.now()-started)/1000),manifestAgeMs:age,segments:files.length,diskBytes:bytes,rssKB};samples.push(sample);console.log(JSON.stringify(sample));
 if(bytes>40*1024*1024||files.length>window+10)failed=true;
 }catch(e){if(Date.now()-started>20000){failed=true;console.error(e.message);}}},30000);
const exit=await new Promise(r=>proc.on('close',(code,signal)=>r({code,signal})));done=true;clearInterval(timer);
const report={duration,window,elapsedSeconds:Math.round((Date.now()-started)/1000),environment:'local test container; not Botkeep',profile:'economy720',exit,failed:failed||exit.code!==0,samples,stderr};
await writeFile(process.env.SOAK_REPORT||'soak-results.json',JSON.stringify(report,null,2));await rm(dir,{recursive:true,force:true});console.log(JSON.stringify({complete:true,...exit,failed:report.failed,elapsedSeconds:report.elapsedSeconds}));process.exitCode=report.failed?1:0;
