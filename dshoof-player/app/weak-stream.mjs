import {spawn} from 'node:child_process';
import {mkdir,stat,readdir,unlink,readFile} from 'node:fs/promises';
import path from 'node:path';
import {encodingArgs,streamProfile,budgetProfile} from './stream-profile.mjs';

// Measure bytes actually sent in complete MPEG-TS segments, including mux
// overhead. A filename is never accepted outside the local generated directory.
export async function transportMetrics(manifest,{maxSegments=6}={}){
 const text=await readFile(manifest,'utf8'),segments=[];let seconds=0;
 for(const row of text.split(/\r?\n/)){
  if(row.startsWith('#EXTINF:'))seconds=Number.parseFloat(row.slice(8));
  else if(/^segment_\d+\.ts$/.test(row)&&seconds>0&&seconds<120){segments.push({name:row,seconds});seconds=0;}
 }
 const available=await Promise.all(segments.map(async item=>{try{return {...item,bytes:(await stat(path.join(path.dirname(manifest),item.name))).size};}catch{return null;}}));
 const items=available.filter(Boolean),sample=items.slice(-maxSegments),duration=sample.reduce((n,item)=>n+item.seconds,0),bytes=sample.reduce((n,item)=>n+item.bytes,0);
 return {transportKbps:duration?Math.round(bytes*8/duration/1000):0,bufferedSeconds:Math.round(items.reduce((n,item)=>n+item.seconds,0)*10)/10,segmentCount:items.length};
}

// Read the shared local ingest: no second upstream connection or per-viewer
// encoder. Bootstrap the last cached primary window immediately; the player
// bounds forward downloads so the CPU catch-up does not become client prefetch.
export function createWeakStream({directory,input,executable,env,now=Date.now,spawnProcess=spawn,setTimer=setInterval,clearTimer=clearInterval}){
 let child=null,profile='economy720',resolved=streamProfile(profile),lastUse=0,started=0,retryAt=0,generation=0,starting=null,stopped=false,lastError='',failures=0,progress='',outSeconds=0,sampleSeconds=0,sampleAt=0,slowSamples=0,restarts=-1,encodeSpeed=0,sourceKbps=0,metrics={transportKbps:0,bufferedSeconds:0,segmentCount:0},measuredAt=0,measuring=null;
 async function stop(){
  generation++;const p=child;child=null;if(!p)return;
  await new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(deadline);resolve();};const timer=setTimeout(()=>{try{p.kill('SIGKILL');}catch{}},4000);const deadline=setTimeout(finish,6000);timer.unref();deadline.unref();p.once('close',finish);try{p.kill('SIGTERM');}catch{finish();}});
 }
 async function reset(id=profile){
  streamProfile(id);if(id==='source')throw Error('اختر ضغطًا لمسار النت الضعيف');
  stopped=true;lastUse=0;await stop();profile=id;resolved=streamProfile(id);retryAt=0;failures=0;lastError='';encodeSpeed=0;metrics={transportKbps:0,bufferedSeconds:0,segmentCount:0};measuredAt=0;
  await unlink(path.join(directory,'dshoof.m3u8')).catch(e=>{if(e.code!=='ENOENT')throw e;});stopped=false;
 }
 async function start(){
  if(child||stopped||now()<retryAt)return;
  const op=generation;await mkdir(directory,{recursive:true});
  if(op!==generation||stopped||child)return;
  let s;try{s=await stat(input);}catch{return;}
  if(op!==generation||stopped||child||now()-s.mtimeMs>45000)return;
  try{sourceKbps=(await transportMetrics(input)).transportKbps;}catch{sourceKbps=0;}
  if(op!==generation||stopped||child)return;
  resolved=budgetProfile(profile,sourceKbps);profile=resolved.id;
  started=now();lastError='';progress='';outSeconds=0;sampleSeconds=0;sampleAt=started;slowSamples=0;encodeSpeed=0;restarts++;
  const segmentSeconds=resolved.segmentSeconds||4;
  const p=spawnProcess(executable,['-hide_banner','-loglevel','error','-nostdin','-progress','pipe:1','-stats_period','2','-threads','2','-filter_threads','1','-protocol_whitelist','file,crypto','-live_start_index','-20','-i',input,'-map','0:v:0','-map','0:a:0?',...encodingArgs(profile,{resolved}),'-f','hls','-hls_time',String(segmentSeconds),'-hls_list_size',profile==='emergency144'?'16':'24','-hls_segment_options',`pat_period=${profile==='emergency144'?'1':'0.5'}:sdt_period=5:pcr_period=100`,'-hls_delete_threshold','4','-hls_start_number_source','epoch_us','-hls_flags','delete_segments+independent_segments+discont_start+omit_endlist+temp_file+program_date_time','-hls_segment_filename',path.join(directory,'segment_%d.ts'),path.join(directory,'dshoof.m3u8')],{env,stdio:['ignore','pipe','pipe']});
  child=p;
  p.stdout.on('data',b=>{progress=(progress+b).slice(-4096);const rows=progress.split('\n');progress=rows.pop().slice(-256);for(const row of rows){if(row.startsWith('out_time_us=')){const value=Number(row.slice(12));if(Number.isFinite(value))outSeconds=value/1000000;}else if(row.startsWith('speed='))encodeSpeed=Number.parseFloat(row.slice(6))||0;}});
  p.stderr.on('data',b=>{lastError=String(b).replace(/https?:\/\/[^\s]+/g,'[source]').slice(-500);});p.on('error',()=>{lastError='تعذر تشغيل ضغط الفيديو';});
  p.on('close',()=>{if(child!==p)return;child=null;failures=now()-started>60000?1:failures+1;retryAt=now()+Math.min(30000,1000*2**Math.min(failures,5));});
 }
 async function touchWithoutUse(){if(!starting)starting=start().finally(()=>{starting=null;});await starting;}
 async function touch(){lastUse=now();await touchWithoutUse();}
 async function updateMetrics(){
  if(now()-measuredAt<1000)return;
  if(!measuring){const op=generation;measuring=transportMetrics(path.join(directory,'dshoof.m3u8')).then(value=>{if(op===generation){metrics=value;measuredAt=now();}}).catch(()=>{}).finally(()=>{measuring=null;});}await measuring;
 }
 async function ready(){if(!child)return false;try{const s=await stat(path.join(directory,'dshoof.m3u8'));const fresh=s.mtimeMs+1>=started&&now()-s.mtimeMs<Math.max(20000,(resolved.segmentSeconds||4)*3500);if(fresh)await updateMetrics();return fresh;}catch{return false;}}
 let checking=false;const timer=setTimer(async()=>{if(checking)return;checking=true;try{
  if(child&&now()-started>=20000){
   try{
    const current=await transportMetrics(input);sourceKbps=current.transportKbps;
    const next=budgetProfile(profile,sourceKbps);
    // A source can switch down after startup. Do not leave an old high output
    // budget running indefinitely against the newly smaller primary stream.
    if(current.segmentCount>=2&&next.requiredKbps<resolved.requiredKbps*.75){
     const used=lastUse;await stop();profile=next.id;retryAt=0;metrics={transportKbps:0,bufferedSeconds:0,segmentCount:0};measuredAt=0;lastUse=used;await touchWithoutUse();
    }
   }catch{}
  }
  if(child&&now()-sampleAt>=30000){
   const speed=(outSeconds-sampleSeconds)/((now()-sampleAt)/1000);sampleAt=now();sampleSeconds=outSeconds;
   let sourceFresh=false;try{sourceFresh=now()-(await stat(input)).mtimeMs<15000;}catch{}
   slowSamples=sourceFresh&&speed>=0&&speed<0.85?slowSamples+1:0;
   if(slowSamples>=2){const next={economy720:'economy480',economy480:'economy360'}[profile];if(next){const used=lastUse;await reset(next);lastUse=used;await touchWithoutUse();}else{await stop();lastError='التحويل أبطأ من البث';retryAt=now()+60000;}}
  }
  if(child&&(now()-lastUse>120000||now()-started>45000&&!await ready())){await stop();retryAt=now()+5000;}
  if(!stopped&&now()-lastUse<120000&&!child&&lastUse)await touchWithoutUse();
  // Retain enough older media for clients within the playlist window, without
  // accumulating files after source/profile changes or crashed encoders.
  const keep=new Set((await readFile(path.join(directory,'dshoof.m3u8'),'utf8').catch(()=>'' )).split(/\r?\n/).filter(row=>/^segment_\d+\.ts$/.test(row)));
  for(const f of await readdir(directory)){if(!/^segment_\d+\.ts(?:\.tmp)?$/.test(f)||keep.has(f))continue;const file=path.join(directory,f);try{if(now()-(await stat(file)).mtimeMs>180000)await unlink(file);}catch{}}
 }catch{}finally{checking=false;}},15000);timer.unref();
 return {touch,ready,reset,stop,profile:()=>profile,info:()=>({profile,running:!!child,retryAt,error:lastError?'تعذر ضغط البث أو تأخر؛ المسار الأساسي مستمر':'',generation,videoKbps:resolved.videoKbps,audioKbps:resolved.audioKbps,requiredKbps:resolved.requiredKbps,sourceKbps,encodeSpeed,...metrics,restarts:Math.max(0,restarts),warning:sourceKbps>0&&metrics.transportKbps>=sourceKbps?'المصدر اقتصادي أصلًا؛ قارن مسار المصدر قبل اختيار الضغط':''}),async close(){stopped=true;clearTimer(timer);await stop();}};
}
