// Manual resource/endurance check using the actual shared weak encoder. All
// sources are synthetic and temporary; this never contacts the deployed site.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,stat,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWeakStream} from './weak-stream.mjs';
const duration=Number(process.env.STREAM_ENDURANCE_SECONDS||90);
if(!Number.isInteger(duration)||duration<30||duration>600)throw Error('STREAM_ENDURANCE_SECONDS must be 30..600');
const dir=await mkdtemp(path.join(tmpdir(),'dshoof-stream-endurance-')),primary=path.join(dir,'primary'),children=[];
await mkdir(primary);const input=path.join(primary,'dshoof.m3u8'),executable=process.env.FFMPEG_PATH||'ffmpeg';
const ticksPerSecond=Number(spawnSync('getconf',['CLK_TCK'],{encoding:'utf8'}).stdout)||100;
const samples=[],previous=new Map(),started=Date.now();let producer,weak,emergency,producerError='',failures=[],restartAt=0,firstReadySeconds=null,afterRestartReadySeconds=null;
function spawnTracked(command,args,options){const child=spawn(command,args,options);children.push(child);return child;}
async function stopProcess(p){if(!p||p.exitCode!==null||p.signalCode!==null)return;await new Promise(resolve=>{const timer=setTimeout(()=>p.kill('SIGKILL'),4000);timer.unref();p.once('close',()=>{clearTimeout(timer);resolve();});p.kill();});}
async function resources(p){
 if(!p?.pid||p.exitCode!==null)return null;
 try{
  const status=await readFile('/proc/'+p.pid+'/status','utf8'),parts=(await readFile('/proc/'+p.pid+'/stat','utf8')).slice((await readFile('/proc/'+p.pid+'/stat','utf8')).lastIndexOf(')')+2).trim().split(/\s+/),ticks=Number(parts[11])+Number(parts[12]),at=Date.now(),last=previous.get(p.pid);
  previous.set(p.pid,{ticks,at});return {pid:p.pid,rssMiB:Math.round(Number(status.match(/VmRSS:\s+(\d+)/)?.[1]||0)/1024*10)/10,cpuPercent:last?Math.round((ticks-last.ticks)/ticksPerSecond/((at-last.at)/1000)*1000)/10:null};
 }catch{return {pid:p.pid,rssMiB:null,cpuPercent:null};}
}
try{
 // Materialize an old live window quickly, as required for instant delayed
 // bootstrap. The continuing producer below updates that same original ingest.
 const generated=spawnSync(executable,['-hide_banner','-loglevel','error','-filter_threads','1','-f','lavfi','-i','testsrc2=size=1920x1080:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','112','-c:v','libx264','-threads','2','-preset','ultrafast','-b:v','3500k','-g','100','-sc_threshold','0','-c:a','aac','-b:a','128k','-f','hls','-hls_time','4','-hls_list_size','24','-hls_flags','temp_file+omit_endlist+program_date_time','-hls_segment_filename',path.join(primary,'segment_%d.ts'),input],{encoding:'utf8',timeout:60000});
 if(generated.status!==0)throw Error('Synthetic primary generation failed: '+generated.stderr);
 const originalFile=path.join(primary,'segment_0.ts'),original=await readFile(originalFile);
 producer=spawn(executable,['-hide_banner','-loglevel','error','-filter_threads','1','-re','-f','lavfi','-i','testsrc2=size=1920x1080:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',String(duration+20),'-c:v','libx264','-threads','2','-preset','ultrafast','-b:v','3500k','-g','100','-sc_threshold','0','-c:a','aac','-b:a','128k','-f','hls','-hls_time','4','-hls_list_size','24','-hls_delete_threshold','4','-hls_flags','append_list+delete_segments+temp_file+omit_endlist+program_date_time','-hls_segment_filename',path.join(primary,'segment_%d.ts'),input],{stdio:['ignore','ignore','pipe']});producer.stderr.on('data',b=>producerError=(producerError+b).slice(-2000));
 weak=createWeakStream({directory:path.join(dir,'weak'),input,executable,env:process.env,spawnProcess:spawnTracked});
 emergency=createWeakStream({directory:path.join(dir,'emergency'),input,executable,env:process.env,spawnProcess:spawnTracked});
 await weak.reset('economy720');await emergency.reset('emergency144');
 const runStarted=Date.now();await Promise.all([weak.touch(),emergency.touch()]);
 while(Date.now()-runStarted<duration*1000){
  await new Promise(resolve=>setTimeout(resolve,5000));await Promise.all([weak.touch(),emergency.touch()]);
  const ready=await weak.ready(),emergencyReady=await emergency.ready(),elapsed=(Date.now()-runStarted)/1000;
  if(ready&&firstReadySeconds===null)firstReadySeconds=Math.round(elapsed*10)/10;
  if(restartAt&&ready&&afterRestartReadySeconds===null)afterRestartReadySeconds=Math.round((Date.now()-restartAt)/100)/10;
  const active=children.filter(p=>p.exitCode===null&&p.signalCode===null),processes=await Promise.all(active.map(resources)),sourceStat=await stat(input);
  let diskBytes=0;for(const folder of ['weak','emergency'])for(const name of await readdir(path.join(dir,folder)))diskBytes+=(await stat(path.join(dir,folder,name))).size;
  const sample={seconds:Math.round(elapsed),ready,emergencyReady,weak:weak.info(),emergency:emergency.info(),encoders:processes,producer:await resources(producer),nodeRssMiB:Math.round(process.memoryUsage().rss/1024/1024*10)/10,diskBytes,primaryAgeMs:Date.now()-sourceStat.mtimeMs};
  samples.push(sample);console.log(JSON.stringify(sample));
  if(elapsed>20&&!ready&&(!restartAt||Date.now()-restartAt>15000))failures.push('Weak playlist unavailable at '+sample.seconds+' seconds');
  if(elapsed>20&&!emergencyReady)failures.push('Emergency playlist unavailable at '+sample.seconds+' seconds');
  if(active.length>2)failures.push('More than one encoder per path');
  if(diskBytes>32*1024*1024)failures.push('Compressed disk budget exceeded32MiB');
  if(!restartAt&&elapsed>=duration/2){await weak.stop();restartAt=Date.now();await weak.touch();}
 }
 if(!(await readFile(originalFile)).equals(original))failures.push('Original primary segment changed');
 if(firstReadySeconds===null||afterRestartReadySeconds===null)failures.push('Missing initial or restarted readiness');
 if(producerError)failures.push('Primary producer stderr: '+producerError);
} catch(error){failures.push(error.message);}
finally{
 await weak?.close();await emergency?.close();await stopProcess(producer);for(const p of children)await stopProcess(p);
 const report={environment:'local synthetic container; not Botkeep',duration,elapsedSeconds:Math.round((Date.now()-started)/1000),firstReadySeconds,afterRestartReadySeconds,passed:failures.length===0,failures,samples};
 const reportFile=process.env.STREAM_ENDURANCE_REPORT||path.join(tmpdir(),'dshoof-stream-endurance.json');await writeFile(reportFile,JSON.stringify(report,null,2));await rm(dir,{recursive:true,force:true});
 console.log(JSON.stringify({complete:true,reportFile,passed:report.passed,failures,firstReadySeconds,afterRestartReadySeconds,sampleCount:samples.length}));process.exitCode=report.passed?0:1;
}
