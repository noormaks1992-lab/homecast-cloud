import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('HTTP owner sessions, logout revocation, CSRF and private backups',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dshoof-security-')),socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const origin='http://127.0.0.1:'+port,child=spawn(process.execPath,['server.mjs'],{env:{...process.env,DATA_DIR:directory,SERVER_PORT:String(port),PUBLIC_URL:origin,FFMPEG_PATH:'ffmpeg'},stdio:['ignore','ignore','ignore']});
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(origin+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,'HTTP server started');
  const state=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));
  const post=(route,data,cookie='',from=origin)=>fetch(origin+route,{method:'POST',headers:{Origin:from,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(data)});
  const anonymous=await(await fetch(origin+'/api/status')).text();assert.ok(!anonymous.includes(state.owner));assert.ok(!anonymous.includes(state.viewer));
  assert.equal((await fetch(origin+'/api/export')).status,403);assert.equal((await fetch(origin+'/_input?url=http://169.254.169.254/latest/meta-data')).status,403);
  assert.equal((await post('/api/login',{key:state.owner},'','https://attacker.invalid')).status,403);
  const login=await post('/api/login',{key:state.owner});assert.equal(login.status,200);const header=login.headers.get('set-cookie'),cookie=header.split(';')[0];assert.ok(header.includes('HttpOnly'));assert.ok(header.includes('SameSite=Strict'));assert.ok(header.includes('Max-Age=43200'));assert.ok(!cookie.includes(state.owner));
  assert.equal((await fetch(origin+'/api/export',{headers:{Cookie:cookie}})).status,200);
  assert.equal((await fetch(origin+'/api/export',{headers:{Cookie:'dshoof_owner='+state.owner}})).status,403);
  assert.equal((await post('/api/settings',{name:'forged'},cookie,'https://attacker.invalid')).status,403);
  assert.equal((await post('/api/logout',{},cookie)).status,200);
  assert.equal((await fetch(origin+'/api/export',{headers:{Cookie:cookie}})).status,403);
  assert.equal((await(await fetch(origin+'/api/status',{headers:{Cookie:cookie}})).json()).canControl,false);
  const saved=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));assert.equal(saved.owner,state.owner);assert.equal(saved.viewer,state.viewer);assert.equal(saved.playlistAlias,state.playlistAlias);
 }finally{
  if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
  await rm(directory,{recursive:true,force:true});
 }
});
