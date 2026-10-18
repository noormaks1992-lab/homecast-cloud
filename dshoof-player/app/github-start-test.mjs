import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {validateSnapshot,runtimeEnv,prepareRelease,selectRelease,startRelease,stopChild} from './github-start.mjs';

const pkg=JSON.stringify({name:'dshoof-player',type:'module',version:'3.0.0'});
const snapshot=(version='test-new',server='export const ok=true;')=>({version,files:{'package.json':pkg,'supervisor.mjs':"import './server.mjs';",'server.mjs':server,'public/index.html':'<html>new</html>'}});
async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'dshoof-updater-'));await mkdir(path.join(root,'public'));await mkdir(path.join(root,'node_modules'));await mkdir(path.join(root,'data'));await writeFile(path.join(root,'public/hls.min.js'),'// existing vendor');await writeFile(path.join(root,'package.json'),pkg);await writeFile(path.join(root,'data/state.json'),'private-state');await writeFile(path.join(root,'.env'),'PRIVATE_SETTING=keep');return root;}
test('snapshot validation blocks traversal, runtime data, duplicates and incomplete releases',()=>{
 for(const name of ['../server.mjs','/server.mjs','data/state.json','.env','public/../../data/state.json','node_modules/a.js','public\\bad.js']){const s=snapshot();s.files[name]='bad';assert.throws(()=>validateSnapshot(s));}
 const s=snapshot();s.base64Files={'server.mjs':'YQ=='};assert.throws(()=>validateSnapshot(s));
 assert.throws(()=>validateSnapshot({files:{},version:'x'}));assert.equal(validateSnapshot(snapshot()).size,4);
});
test('release staging preserves private data, retains HLS asset and excludes the token from installers',async()=>{
 const root=await fixture();try{
  const env={DSHOOF_GITHUB_TOKEN:'secret-read-token',DATA_DIR:'data',APP_SETTING:'keep'};
  let installs=0;
  const options={env,fetcher:async(url,opts)=>{assert.match(url,/api.github.com\/repos\/noormaks1992-lab\/homecast-cloud/);assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Bearer secret-read-token');return new Response(JSON.stringify(snapshot()));},install:async(_dir,_root,childEnv)=>{installs++;assert.equal(childEnv.DSHOOF_GITHUB_TOKEN,undefined);assert.equal(childEnv.DATA_DIR,path.join(root,'data'));}};
  const first=await prepareRelease(root,options),second=await prepareRelease(root,options);
  assert.equal(first.id,second.id);assert.equal(installs,1);
  assert.equal(await readFile(path.join(first.dir,'public/hls.min.js'),'utf8'),'// existing vendor');
  assert.equal(await readFile(path.join(root,'data/state.json'),'utf8'),'private-state');
  assert.equal(await readFile(path.join(root,'.env'),'utf8'),'PRIVATE_SETTING=keep');
  assert.equal(runtimeEnv(env,root).APP_SETTING,'keep');assert.equal(env.DSHOOF_GITHUB_TOKEN,'secret-read-token');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('GitHub rejection and a syntax error keep the installed application',async()=>{
 const root=await fixture();try{
  for(const fetcher of [async()=>new Response('',{status:403}),async()=>new Response(JSON.stringify(snapshot('invalid','export const = ;'))) ]){
   const result=await selectRelease(root,{env:{DSHOOF_GITHUB_TOKEN:'fixture'},fetcher,install:()=>assert.fail()});assert.equal(result.candidate.dir,root);assert.ok(result.error);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
test('restart applies release, unavailable GitHub retains it, and broken startup rolls back',async()=>{
 const root=await fixture();let child;
 const port=34721,url='http://127.0.0.1:'+port;
 const server=version=>`import http from 'node:http';import {writeFileSync} from 'node:fs';import path from 'node:path';writeFileSync(path.join(process.env.DATA_DIR,'runtime.json'),JSON.stringify({tokenPresent:!!process.env.DSHOOF_GITHUB_TOKEN,version:${JSON.stringify(version)}}));http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'ok',brand:'دشوف',version:${JSON.stringify(version)},release:process.env.DSHOOF_RELEASE,bootId:process.env.DSHOOF_BOOT_ID}));}).listen(Number(process.env.SERVER_PORT),'127.0.0.1');`;
 const stop=async()=>{if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}};
 try{
  await writeFile(path.join(root,'server.mjs'),server('old'));await writeFile(path.join(root,'supervisor.mjs'),"import './server.mjs';");
  const moduleURL=pathToFileURL(path.resolve('github-start.mjs')).href;
  await writeFile(path.join(root,'boot.mjs'),`import {readFile} from 'node:fs/promises';import {main} from ${JSON.stringify(moduleURL)};const original=globalThis.fetch;globalThis.fetch=async(url,opts)=>String(url).startsWith('https://api.github.com/')?new Response(await readFile(${JSON.stringify(path.join(root,'response.json'))},'utf8'),{status:Number(process.env.TEST_STATUS||200)}):original(url,opts);await main(${JSON.stringify(root)},{startupTimeout:1500});`);
  let logs='';
  const start=async(status='200')=>{logs='';child=spawn(process.execPath,[path.join(root,'boot.mjs')],{env:{...process.env,SERVER_PORT:String(port),DATA_DIR:path.join(root,'data'),DSHOOF_GITHUB_TOKEN:'test-private-token',TEST_STATUS:status},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);for(let i=0;i<120;i++){if(logs.includes('[github-update] active release'))return;await new Promise(r=>setTimeout(r,100));}throw Error(logs);};
  await writeFile(path.join(root,'response.json'),JSON.stringify(snapshot('new',server('new'))));await start();assert.equal((await(await fetch(url+'/healthz')).json()).version,'new');
  assert.equal(JSON.parse(await readFile(path.join(root,'data/runtime.json'),'utf8')).tokenPresent,false);
  assert.equal(await readFile(path.join(root,'data/state.json'),'utf8'),'private-state');const current=await readFile(path.join(root,'.dshoof-current.json'),'utf8');await stop();
  await start('403');assert.equal((await(await fetch(url+'/healthz')).json()).version,'new');await stop();
  await writeFile(path.join(root,'response.json'),JSON.stringify(snapshot('broken','throw Error("startup fixture failure");')));await start();assert.match(logs,/reverting/);assert.equal((await(await fetch(url+'/healthz')).json()).version,'new');assert.equal(await readFile(path.join(root,'.dshoof-current.json'),'utf8'),current);assert.doesNotMatch(logs,/test-private-token/);
 }finally{await stop();await rm(root,{recursive:true,force:true});}
});

test('release health requires this boot identity and exact release, including legacy listeners',{timeout:10000},async()=>{
 const root=await fixture();let listener,child,mode='wrong-boot',responses=[];
 try{
  // This child stays alive but cannot serve the occupied application port.
  await writeFile(path.join(root,'supervisor.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync('boot.json',JSON.stringify({bootId:process.env.DSHOOF_BOOT_ID,release:process.env.DSHOOF_RELEASE}));setInterval(()=>{},1000);`);
  listener=http.createServer(async(_req,res)=>{let boot={};try{boot=JSON.parse(await readFile(path.join(root,'boot.json'),'utf8'));}catch{}const health={status:'ok',brand:'دشوف',release:mode==='wrong-release'?'older-release':'candidate',...(mode==='legacy'?{}:{bootId:mode==='wrong-release'?boot.bootId:'old-boot'})};responses.push(health);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(health));});
  listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;
  for(mode of ['wrong-boot','legacy','wrong-release']){
   responses=[];
   await assert.rejects(startRelease({dir:root,version:'candidate'},{...process.env,SERVER_PORT:String(port)},port,value=>{child=value;},{timeout:900}),/did not become healthy/);
   assert.ok(child.exitCode!==null||child.signalCode!==null,'failed child must exit before startRelease rejects');
   assert.ok(responses.length>=2,'check health after the candidate has had time to start');
   if(mode==='wrong-release')assert.ok(responses.some(value=>/^[a-f0-9]{32}$/.test(value.bootId)),'correct boot ID still requires the correct release');
   assert.equal((await fetch('http://127.0.0.1:'+port+'/healthz')).status,200,'unrelated old listener must remain running');
  }
 }finally{await stopChild(child);if(listener){listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));}await rm(root,{recursive:true,force:true});}
});

test('old healthy port cannot cause a failed candidate or fallback to publish the current release',{timeout:10000},async()=>{
 const root=await fixture();let listener,child,logs='';
 try{
  const previous=JSON.stringify({id:null,version:'previous-installed'});await writeFile(path.join(root,'.dshoof-current.json'),previous);
  await writeFile(path.join(root,'server.mjs'),'setInterval(()=>{},1000);');await writeFile(path.join(root,'supervisor.mjs'),"import './server.mjs';");
  await writeFile(path.join(root,'response.json'),JSON.stringify(snapshot('candidate','setInterval(()=>{},1000);')));
  listener=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'ok',brand:'دشوف',release:'candidate'}));});listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const port=listener.address().port,moduleURL=pathToFileURL(path.resolve('github-start.mjs')).href;
  await writeFile(path.join(root,'boot.mjs'),`import {readFile} from 'node:fs/promises';import {main} from ${JSON.stringify(moduleURL)};const original=globalThis.fetch;globalThis.fetch=async(url,opts)=>String(url).startsWith('https://api.github.com/')?new Response(await readFile(${JSON.stringify(path.join(root,'response.json'))},'utf8')):original(url,opts);main(${JSON.stringify(root)},{startupTimeout:700}).catch(()=>{process.exitCode=1;});`);
  child=spawn(process.execPath,[path.join(root,'boot.mjs')],{env:{...process.env,SERVER_PORT:String(port),DSHOOF_GITHUB_TOKEN:'synthetic-read-token'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',value=>{logs+=value;});child.stderr.on('data',value=>{logs+=value;});
  const [code]=await once(child,'exit');assert.equal(code,1);assert.doesNotMatch(logs,/active release/);assert.match(logs,/reverting/);
  assert.equal(await readFile(path.join(root,'.dshoof-current.json'),'utf8'),previous,'never publish an unverified release pointer');
  assert.equal((await fetch('http://127.0.0.1:'+port+'/healthz')).status,200,'old listener is unrelated and must survive');
 }finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}if(listener){listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));}await rm(root,{recursive:true,force:true});}
});

test('matching releases use fresh boot IDs and stop waits for same-group descendants',{skip:process.platform!=='linux',timeout:10000},async()=>{
 const root=await fixture();let child,descendant;const boots=[];
 async function running(pid){try{const text=await readFile('/proc/'+pid+'/stat','utf8'),state=text.slice(text.lastIndexOf(')')+2).split(' ')[0];return !['Z','X'].includes(state);}catch{return false;}}
 try{
  const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  await writeFile(path.join(root,'supervisor.mjs'),`import http from 'node:http';import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const p=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"],{stdio:'ignore'});writeFileSync('descendant.json',JSON.stringify({pid:p.pid}));http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'ok',brand:'دشوف',release:process.env.DSHOOF_RELEASE,bootId:process.env.DSHOOF_BOOT_ID}));}).listen(Number(process.env.SERVER_PORT),'127.0.0.1');`);
  for(let attempt=0;attempt<2;attempt++){
   child=await startRelease({dir:root,version:'verified'},{...process.env,SERVER_PORT:String(port),DSHOOF_BOOT_ID:'must-be-overridden'},port,value=>{child=value;},{timeout:2000});
   const health=await(await fetch('http://127.0.0.1:'+port+'/healthz')).json();assert.match(health.bootId,/^[a-f0-9]{32}$/);assert.equal(health.release,'verified');boots.push(health.bootId);
   descendant=JSON.parse(await readFile(path.join(root,'descendant.json'),'utf8')).pid;
   await stopChild(child);assert.ok(child.exitCode!==null||child.signalCode!==null,'stop must wait for supervisor exit');assert.equal(await running(descendant),false,'stop must also terminate its same-group orphan');
  }
  assert.notEqual(boots[0],boots[1],'each candidate or fallback spawn has a fresh identity');
 }finally{await stopChild(child);if(descendant&&await running(descendant))try{process.kill(descendant,'SIGKILL');}catch{}await rm(root,{recursive:true,force:true});}
});
