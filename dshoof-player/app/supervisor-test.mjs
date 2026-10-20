import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await pause(40);}throw Error('Supervisor fixture timed out');}
async function running(pid){
 try{const text=await readFile('/proc/'+pid+'/stat','utf8'),state=text.slice(text.lastIndexOf(')')+2).split(' ')[0];return !['Z','X'].includes(state);}catch{return false;}
}
async function close(child){
 if(!child||child.exitCode!==null||child.signalCode!==null)return;
 const done=once(child,'exit'),timer=setTimeout(()=>child.kill('SIGKILL'),9000);timer.unref();child.kill('SIGTERM');
 try{await done;}finally{clearTimeout(timer);}
}
const linuxOnly=process.platform!=='linux';

test('server crashes cannot orphan encoders; bounded supervisor stop cleans only its own tree',{skip:linuxOnly,timeout:25000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dshoof-supervisor-'));let supervisor,unrelated;const records=[];
 try{
  await copyFile(new URL('./supervisor.mjs',import.meta.url),path.join(directory,'supervisor.mjs'));
  await writeFile(path.join(directory,'descendant.mjs'),`import {appendFileSync,writeFileSync} from 'node:fs';
const file=process.argv[2];process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});
writeFileSync(file,'ready');process.send?.('ready');process.disconnect?.();setInterval(()=>appendFileSync(file,'x'),40);
`);
  await writeFile(path.join(directory,'server.mjs'),`import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';import path from 'node:path';
const directory=process.env.FIXTURE_DIR,counter=path.join(directory,'counter');let run=1;try{run=Number(readFileSync(counter,'utf8'))+1;}catch{}writeFileSync(counter,String(run));
function running(pid){try{const t=readFileSync('/proc/'+pid+'/stat','utf8');return !['Z','X'].includes(t.slice(t.lastIndexOf(')')+2).split(' ')[0]);}catch{return false;}}
let previous;try{previous=JSON.parse(readFileSync(path.join(directory,'previous.json'),'utf8'));}catch{}
const child=spawn(process.execPath,[path.join(directory,'descendant.mjs'),path.join(directory,'heartbeat-'+run)],{stdio:['ignore','ignore','ignore','ipc']});
child.once('message',()=>{const record={run,server:process.pid,descendant:child.pid,previousRunning:previous?running(previous.descendant):false};appendFileSync(path.join(directory,'events.jsonl'),JSON.stringify(record)+'\\n');writeFileSync(path.join(directory,'previous.json'),JSON.stringify(record));if(run===1)setTimeout(()=>process.exit(23),150);});
process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000);
`);
  unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  supervisor=spawn(process.execPath,['supervisor.mjs'],{cwd:directory,env:{...process.env,FIXTURE_DIR:directory},stdio:'ignore'});
  await until(async()=>{
   assert.equal(supervisor.exitCode,null,'supervisor exited unexpectedly');
   try{const list=(await readFile(path.join(directory,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);records.splice(0,records.length,...list);return list.length>=2;}catch{return false;}
  });
  assert.equal(records.length,2,'one replacement server must start after the crash');
  assert.equal(records[1].previousRunning,false,'the replacement must not overlap its crashed predecessor’s encoder');
  assert.equal(await running(records[0].descendant),false,'orphaned encoder must be terminated even if it ignores SIGTERM');
  assert.equal(await running(records[1].server),true);assert.equal(await running(records[1].descendant),true);
  assert.equal(await running(unrelated.pid),true,'unrelated processes must not be signalled');
  const heartbeat=path.join(directory,'heartbeat-1'),previous=await readFile(heartbeat,'utf8');await pause(120);assert.equal(await readFile(heartbeat,'utf8'),previous,'crashed encoder must stop doing work');
  const started=Date.now();await close(supervisor);
  assert.ok(Date.now()-started<8000,'parent shutdown must remain within its eight-second deadline');
  await until(async()=>!await running(records[1].server)&&!await running(records[1].descendant),1500);
  assert.equal(await running(unrelated.pid),true,'shutdown must target only its own exact server group');
  await pause(2200);assert.equal(Number(await readFile(path.join(directory,'counter'),'utf8')),2,'stopping must never schedule a new server');
 }finally{
  await close(supervisor);
  for(const record of records)try{process.kill(-record.server,'SIGKILL');}catch{}
  await close(unrelated);await rm(directory,{recursive:true,force:true});
 }
});

test('stopping during crash backoff cancels the pending restart promptly',{skip:linuxOnly,timeout:7000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dshoof-supervisor-backoff-'));let supervisor;
 try{
  await copyFile(new URL('./supervisor.mjs',import.meta.url),path.join(directory,'supervisor.mjs'));
  await writeFile(path.join(directory,'server.mjs'),`import {appendFileSync} from 'node:fs';appendFileSync('starts.txt','x');setTimeout(()=>process.exit(1),30);`);
  supervisor=spawn(process.execPath,['supervisor.mjs'],{cwd:directory,stdio:'ignore'});
  await until(async()=>{try{return (await readFile(path.join(directory,'starts.txt'),'utf8'))==='x';}catch{return false;}},2000);
  await pause(200);const started=Date.now();await close(supervisor);assert.ok(Date.now()-started<1000,'idle backoff must not delay shutdown');
  await pause(2200);assert.equal(await readFile(path.join(directory,'starts.txt'),'utf8'),'x');
 }finally{await close(supervisor);await rm(directory,{recursive:true,force:true});}
});
