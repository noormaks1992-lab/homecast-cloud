// Install once beside the existing app. Only this launcher receives the read-only
// GitHub token. Releases live separately from the persistent application data.
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,rm,readdir,stat,copyFile,symlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repository='noormaks1992-lab/homecast-cloud';
const branch='noor-player-m3u';
const snapshotPath='dshoof-player/source.snapshot.json';
const digest=x=>createHash('sha256').update(x).digest('hex');
const exists=async p=>!!await stat(p).catch(()=>null);
const json=async p=>JSON.parse(await readFile(p,'utf8'));
async function atomicJSON(file,value){const temp=file+'.tmp';await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,file);}
export function runtimeEnv(env,root){const result={...env,DATA_DIR:path.resolve(root,env.DATA_DIR||'data')};delete result.DSHOOF_GITHUB_TOKEN;return result;}

export function validateSnapshot(value){
 if(!value||typeof value.version!=='string'||!value.files||typeof value.files!=='object'||Array.isArray(value.files))throw Error('invalid snapshot');
 const entries=new Map();let total=0;
 for(const [files,binary] of [[value.files,false],[value.base64Files||{},true]]){
  if(typeof files!=='object'||Array.isArray(files))throw Error('invalid files');
  for(const [name,content] of Object.entries(files)){
   const parts=name.split('/');
   if(!/^[A-Za-z0-9_/-]+(?:\.[A-Za-z0-9_-]+)*$/.test(name)||parts.some(p=>!p||p.startsWith('.'))||['data','node_modules'].includes(parts[0])||entries.has(name)||typeof content!=='string')throw Error('unsafe snapshot path');
   if(binary&&!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))throw Error('invalid binary file');
   const bytes=Buffer.from(content,binary?'base64':'utf8');total+=bytes.length;
   if(total>16*1024*1024||entries.size>=500)throw Error('snapshot too large');entries.set(name,bytes);
  }
 }
 for(const file of ['server.mjs','supervisor.mjs','package.json','public/index.html'])if(!entries.has(file))throw Error('incomplete snapshot');
 const pkg=JSON.parse(entries.get('package.json').toString());if(pkg.name!=='dshoof-player'||pkg.type!=='module')throw Error('wrong application');
 return entries;
}

async function run(command,args,cwd,env){await new Promise((resolve,reject)=>{
 const child=spawn(command,args,{cwd,env,stdio:'inherit'});let expired=false;
 const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},180000);
 child.once('error',()=>{clearTimeout(timer);reject(Error('build command failed'));});
 child.once('exit',code=>{clearTimeout(timer);code===0&&!expired?resolve():reject(Error('build command failed'));});
});}

async function installDependencies(dir,root,env){
 const fingerprint=digest(await readFile(path.join(dir,'package.json'))+await readFile(path.join(dir,'package-lock.json')).catch(()=>''));
 const baseFingerprint=await (async()=>digest(await readFile(path.join(root,'package.json'))+await readFile(path.join(root,'package-lock.json')).catch(()=>'')))().catch(()=>null);
 if(fingerprint===baseFingerprint&&await exists(path.join(root,'node_modules'))){await symlink(path.join(root,'node_modules'),path.join(dir,'node_modules'),'dir');return;}
 const deps=path.join(root,'.dshoof-dependencies',fingerprint);await mkdir(deps,{recursive:true});
 if(!await exists(path.join(deps,'ready.json'))){
  await copyFile(path.join(dir,'package.json'),path.join(deps,'package.json'));
  if(await exists(path.join(dir,'package-lock.json')))await copyFile(path.join(dir,'package-lock.json'),path.join(deps,'package-lock.json'));
  await run(process.platform==='win32'?'npm.cmd':'npm',[await exists(path.join(deps,'package-lock.json'))?'ci':'install','--omit=dev','--no-audit','--no-fund'],deps,env);
  await atomicJSON(path.join(deps,'ready.json'),{ready:true});
 }
 await symlink(path.join(deps,'node_modules'),path.join(dir,'node_modules'),'dir');
}

export async function prepareRelease(root,{env=process.env,fetcher=fetch,install=installDependencies}={}){
 const token=env.DSHOOF_GITHUB_TOKEN;if(!token)throw Error('GitHub read token is not configured');
 const endpoint=`https://api.github.com/repos/${repository}/contents/${snapshotPath}?ref=${encodeURIComponent(branch)}`;
 const response=await fetcher(endpoint,{redirect:'error',signal:AbortSignal.timeout(20000),headers:{Accept:'application/vnd.github.raw+json',Authorization:'Bearer '+token,'User-Agent':'Dshoof-Updater','X-GitHub-Api-Version':'2022-11-28'}});
 if(!response.ok)throw Error('GitHub HTTP '+response.status);
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>20*1024*1024)throw Error('snapshot download too large');chunks.push(Buffer.from(chunk));}
 const bytes=Buffer.concat(chunks),id=digest(bytes),snapshot=JSON.parse(bytes.toString()),entries=validateSnapshot(snapshot);
 const releases=path.join(root,'.dshoof-releases'),dir=path.join(releases,id);await mkdir(releases,{recursive:true});
 if(await exists(path.join(dir,'ready.json')))return {id,dir,version:snapshot.version};
 const stage=path.join(releases,'stage-'+randomBytes(8).toString('hex'));await mkdir(stage);
 try{
  for(const [name,content] of entries){const target=path.join(stage,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,content);}
  // The historical snapshot omitted this vendor asset; retain the installed copy.
  if(!entries.has('public/hls.min.js'))await copyFile(path.join(root,'public/hls.min.js'),path.join(stage,'public/hls.min.js'));
  const childEnv=runtimeEnv(env,root);
  for(const name of entries.keys())if(name.endsWith('.mjs')||name.endsWith('.js'))await run(process.execPath,['--check',path.join(stage,name)],stage,childEnv);
  await install(stage,root,childEnv);
  await atomicJSON(path.join(stage,'ready.json'),{id,version:snapshot.version});
  await rename(stage,dir);return {id,dir,version:snapshot.version};
 }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
}

export async function previousRelease(root){
 const state=await json(path.join(root,'.dshoof-current.json')).catch(()=>null);
 if(state&&/^[a-f0-9]{64}$/.test(state.id)){
  const dir=path.join(root,'.dshoof-releases',state.id);
  if(await exists(path.join(dir,'ready.json')))return {...state,dir};
 }
 return {id:null,dir:root,version:'installed'};
}

export async function selectRelease(root,options={}){
 const fallback=await previousRelease(root);
 try{return {candidate:await prepareRelease(root,options),fallback};}
 catch(error){return {candidate:fallback,fallback,error:error.message};}
}

const releaseProcesses=new WeakMap(),stops=new WeakMap();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function startRelease(release,env,port,onChild,{timeout=45000}={}){
 // Public boot identity is fresh for every attempt, including fallback. A
 // healthy old listener on this port must never validate a failed new child.
 const bootId=randomBytes(16).toString('hex');
 const child=spawn(process.execPath,['supervisor.mjs'],{cwd:release.dir,env:{...env,DSHOOF_RELEASE:release.version,DSHOOF_BOOT_ID:bootId},stdio:'inherit',detached:process.platform!=='win32'});
 releaseProcesses.set(child,{pid:child.pid,gone:false});onChild(child);
 let exited=false;child.once('exit',()=>{exited=true;});child.once('error',()=>{exited=true;});
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline&&!exited){
  try{const response=await fetch('http://127.0.0.1:'+port+'/healthz',{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(Math.max(1,Math.min(1000,deadline-Date.now())))});const health=await response.json();if(!exited&&child.exitCode===null&&child.signalCode===null&&response.ok&&health.status==='ok'&&health.brand==='دشوف'&&health.bootId===bootId&&health.release===release.version)return child;}catch{}
  await pause(Math.max(0,Math.min(500,deadline-Date.now())));
 }
 await stopChild(child);throw Error('application did not become healthy');
}
export function stopChild(child){
 if(!child)return Promise.resolve();
 if(stops.has(child))return stops.get(child);
 const record=releaseProcesses.get(child)||{pid:child.pid,gone:false},grouped=process.platform!=='win32';
 const exited=()=>child.exitCode!==null||child.signalCode!==null||!record.pid;
 const send=signal=>{if(!record.pid||record.gone)return;try{grouped?process.kill(-record.pid,signal):child.kill(signal);}catch(error){if(error.code==='ESRCH')record.gone=true;}};
 async function groupAlive(){
  if(!record.pid||record.gone)return false;
  if(!grouped)return !exited();
  try{process.kill(-record.pid,0);}catch(error){if(error.code==='ESRCH')record.gone=true;return false;}
  if(process.platform!=='linux'||!exited())return true;
  // Container PID 1 may retain orphaned zombies. They cannot execute, so only
  // live members of this exact spawned group block the next release.
  try{
   const members=await Promise.all((await readdir('/proc')).filter(p=>/^\d+$/.test(p)).map(async pid=>{try{const text=await readFile('/proc/'+pid+'/stat','utf8'),fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);return Number(fields[2])===record.pid&&!['Z','X'].includes(fields[0]);}catch{return false;}}));
   if(!members.some(Boolean)){record.gone=true;return false;}
  }catch{}
  return true;
 }
 const stopped=(async()=>{
  send('SIGTERM');const deadline=Date.now()+8500;let exitedAt=exited()?Date.now():null;
  while(Date.now()<deadline){
   if(exited()&&exitedAt===null)exitedAt=Date.now();
   if(exited()&&!await groupAlive())return;
   if(exitedAt!==null&&Date.now()-exitedAt>=500)break;
   await pause(50);
  }
  send('SIGKILL');const forced=Date.now()+1000;
  while(Date.now()<forced){if(exited()&&!await groupAlive())return;await pause(25);}
  // Do not start fallback while a previous process group can still execute.
  const error=Error('application process group did not stop');error.code='DSHOOF_STOP_INCOMPLETE';throw error;
 })();stops.set(child,stopped);return stopped;
}

async function prune(root,keep){
 const dir=path.join(root,'.dshoof-releases');
 for(const name of await readdir(dir).catch(()=>[]))if((/^[a-f0-9]{64}$/.test(name)||/^stage-[a-f0-9]+$/.test(name))&&!keep.includes(name))await rm(path.join(dir,name),{recursive:true,force:true});
 const used=new Set(await Promise.all([root,...keep.filter(Boolean).map(id=>path.join(dir,id))].map(p=>realpath(path.join(p,'node_modules')).catch(()=>null))));
 const deps=path.join(root,'.dshoof-dependencies');
 for(const name of await readdir(deps).catch(()=>[]))if(/^[a-f0-9]{64}$/.test(name)&&!used.has(path.join(deps,name,'node_modules')))await rm(path.join(deps,name),{recursive:true,force:true});
}

export async function main(root=path.dirname(fileURLToPath(import.meta.url)),{startupTimeout=45000}={}){
 const env=runtimeEnv(process.env,root),port=Number(env.SERVER_PORT||env.PORT||3000);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('invalid application port');
 let active,stopping=false;
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;stopChild(active).finally(()=>process.exit(0));});
 console.log('[github-update] checking configured branch');
 const {candidate,fallback,error}=await selectRelease(root);
 if(error)console.log('[github-update] update unavailable; keeping installed release');
 if(stopping)return;
 let chosen=candidate;
 try{active=await startRelease(candidate,env,port,child=>{active=child;},{timeout:startupTimeout});}
 catch(failure){
  if(stopping)return;
  if(failure.code==='DSHOOF_STOP_INCOMPLETE')throw failure;
  if(candidate.dir===fallback.dir)throw failure;
  console.log('[github-update] new release failed startup; reverting');
  active=await startRelease(fallback,env,port,child=>{active=child;},{timeout:startupTimeout});chosen=fallback;
 }
 if(stopping){await stopChild(active);return;}
 if(chosen.id){
  await atomicJSON(path.join(root,'.dshoof-current.json'),{id:chosen.id,version:chosen.version});
  await prune(root,[chosen.id,fallback.id]).catch(()=>{});
 }
 console.log('[github-update] active release '+JSON.stringify(chosen.version));
 active.once('exit',code=>{if(!stopping)process.exit(code||1);});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('[github-update] startup failed; check application logs');process.exitCode=1;});
