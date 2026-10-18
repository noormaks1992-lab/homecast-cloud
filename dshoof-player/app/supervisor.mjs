import {spawn} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';

let current=null,restartTimer=null,stopping=false,failures=0;
const grouped=process.platform!=='win32',pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Each server owns a separate process group. Its FFmpeg children inherit that
// group, so a crashed server cannot leave encoders running across a restart.
// Never signal a group other than the exact PID returned by our own spawn.
function signal(record,name){
 if(!record?.pid||record.gone)return false;
 try{if(grouped)process.kill(-record.pid,name);else record.child.kill(name);return true;}
 catch(error){if(error.code==='ESRCH')record.gone=true;return false;}
}
function exists(record){
 if(!record?.pid||record.gone)return false;
 if(!grouped)return record.child.exitCode===null&&record.child.signalCode===null;
 try{process.kill(-record.pid,0);return true;}
 catch(error){if(error.code==='ESRCH')record.gone=true;return false;}
}
async function liveLinuxGroup(record){
 // Orphaned zombies can remain until the container's PID 1 reaps them. They
 // cannot encode or serve traffic and must not prevent the replacement server.
 try{
  const pids=(await readdir('/proc')).filter(name=>/^\d+$/.test(name));
  const states=await Promise.all(pids.map(async pid=>{try{const text=await readFile('/proc/'+pid+'/stat','utf8'),fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);return Number(fields[2])===record.pid&&!['Z','X'].includes(fields[0]);}catch{return false;}}));
  return states.some(Boolean);
 }catch{return exists(record);}
}
async function windowsTree(record){
 // Windows has no negative-PID process groups. taskkill is a bounded fallback
 // for the exact live child tree; never use image names or global termination.
 if(record.exitedAt||!record.pid)return;
 await new Promise(resolve=>{
  const task=spawn('taskkill',['/PID',String(record.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve();};
  const timer=setTimeout(()=>{task.kill();finish();},1000);timer.unref();task.once('error',finish);task.once('close',finish);
 });
}
function clean(record,grace=1000){
 if(record.cleaning)return record.cleaning;
 record.cleaning=(async()=>{
  signal(record,'SIGTERM');const end=Date.now()+grace;
  while(exists(record)&&Date.now()<Math.min(end,record.exitedAt?record.exitedAt+1000:end))await pause(50);
  if(!exists(record))return true;
  if(!grouped)await windowsTree(record);
  signal(record,'SIGKILL');
  const deadline=Date.now()+700;
  while(exists(record)&&Date.now()<deadline){
   if(process.platform==='linux'&&!await liveLinuxGroup(record)){record.gone=true;return true;}
   await pause(50);
  }
  return !exists(record);
 })();return record.cleaning;
}
function start(){
 if(stopping||current)return;
 restartTimer=null;const started=Date.now();
 const child=spawn(process.execPath,['server.mjs'],{stdio:'inherit',env:process.env,detached:grouped});
 const record={child,pid:child.pid,started,exitedAt:0,finished:false,gone:false,cleaning:null};current=record;
 const ended=async()=>{
  if(record.finished)return;record.finished=true;record.exitedAt=Date.now();
  const cleaned=await clean(record);
  if(current===record)current=null;
  if(stopping)return;
  if(!cleaned){console.error('[supervisor] Server processes did not stop; refusing to start another encoder tree.');process.exitCode=1;return;}
  failures=Date.now()-started>60000?0:failures+1;
  restartTimer=setTimeout(start,Math.min(30000,1000*2**Math.min(failures,5)));
 };
 child.once('error',ended);child.once('exit',ended);
}
async function stop(){
 if(stopping)return;stopping=true;clearTimeout(restartTimer);restartTimer=null;
 const record=current;
 // The launcher grants 8.5 seconds. Reserve time to force-stop this exact group
 // if an encoder or the server ignores graceful shutdown.
 const deadline=setTimeout(()=>{signal(record,'SIGKILL');process.exit(0);},8000);deadline.unref();
 if(record)await clean(record,6500);
 clearTimeout(deadline);process.exit(0);
}
for(const name of ['SIGTERM','SIGINT'])process.on(name,stop);
start();
