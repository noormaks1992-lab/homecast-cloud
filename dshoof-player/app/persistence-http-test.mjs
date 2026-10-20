import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('state persistence recovers after one failed atomic rename without changing permanent keys',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dshoof-persist-')),preload=path.join(directory,'fail-once.mjs'),trigger=path.join(directory,'fail-next-rename');
 await writeFile(preload,`import promises from 'node:fs/promises';import {existsSync,unlinkSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=promises.rename;promises.rename=async(from,to)=>{if(String(to).endsWith('/state.json')&&existsSync(process.env.DSHOOF_TEST_RENAME_TRIGGER)){unlinkSync(process.env.DSHOOF_TEST_RENAME_TRIGGER);throw Object.assign(Error('fixture transient state rename failure'),{code:'EIO'});}return rename(from,to);};syncBuiltinESMExports();`);
 const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const origin='http://127.0.0.1:'+port,child=spawn(process.execPath,['--import',preload,'server.mjs'],{env:{...process.env,DATA_DIR:directory,SERVER_PORT:String(port),PUBLIC_URL:origin,FFMPEG_PATH:'ffmpeg',DSHOOF_TEST_RENAME_TRIGGER:trigger},stdio:'ignore'});
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(origin+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,'HTTP server started');
  const stateFile=path.join(directory,'state.json'),initial=JSON.parse(await readFile(stateFile,'utf8'));
  const post=(route,value,cookie='')=>fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(value)});
  const login=await post('/api/login',{key:initial.owner});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  await writeFile(trigger,'fail once');const failed=await post('/api/settings',{name:'محاولة أولى'},cookie);assert.equal(failed.status,400);assert.match((await failed.json()).error,/transient state rename failure/);
  const unchanged=JSON.parse(await readFile(stateFile,'utf8'));assert.equal(unchanged.owner,initial.owner);assert.equal(unchanged.viewer,initial.viewer);assert.equal(unchanged.playlistAlias,initial.playlistAlias);
  const retry=await post('/api/settings',{name:'إعدادات محفوظة بعد التعافي'},cookie);assert.equal(retry.status,200,await retry.text());
  const saved=JSON.parse(await readFile(stateFile,'utf8'));assert.equal(saved.settings.name,'إعدادات محفوظة بعد التعافي');assert.equal(saved.owner,initial.owner);assert.equal(saved.viewer,initial.viewer);assert.equal(saved.playlistAlias,initial.playlistAlias);
  const status=await(await fetch(origin+'/api/status',{headers:{Cookie:cookie}})).json();assert.equal(status.canControl,true);assert.equal(status.room.settings.name,saved.settings.name);
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}await rm(directory,{recursive:true,force:true});}
});
