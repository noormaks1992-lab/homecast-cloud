import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {helperInput,resolveHelper,helperDocument} from './helper-source.mjs';
const resolve=async()=>[{address:'93.184.216.34',family:4}];
const response=(url,body)=>({url,response:Object.assign(Readable.from([Buffer.from(body)]),{headers:{},statusCode:200})});
test('helper accepts escaped iframe paste but never executes supplied HTML',()=>{
 const value='\\<iframe src="https\\://player.example/watch?a=1&amp;b=2" onload="alert(1)" allowfullscreen>\\</iframe>';
 assert.deepEqual(helperInput(value),{url:'https://player.example/watch?a=1&b=2',iframe:true});
 const doc=helperDocument(helperInput(value).url);assert.match(doc.html,/a=1&amp;b=2/);assert.doesNotMatch(doc.html,/onload|alert\(1\)|allow-popups|allow-top-navigation/);assert.match(doc.html,/sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"/);assert.match(doc.csp,/frame-src https:\/\/player.example; frame-ancestors 'self'/);
});
test('helper rejects script, private-network, credentials and insecure URLs',()=>{
 for(const value of ['javascript:alert(1)','data:text/html,hi','http://example.com','https://user:secret@example.com','https://127.1/','https://localhost/','https://192.168.1.1/','<iframe srcdoc="hello" src="https://example.com"></iframe>','<script>alert(1)</script>'])assert.throws(()=>helperInput(value));
});
test('pasted iframe keeps its exact player and public DNS validation is mandatory',async()=>{
 const r=await resolveHelper('<iframe src="https://player.example/watch?match=12&key=demo"></iframe>',{resolve,open:()=>{throw Error('must not fetch iframe embed code');}});assert.equal(r.embedUrl,'https://player.example/watch?match=12&key=demo');
 await assert.rejects(resolveHelper('https://rebound.example/',{resolve:async()=>[{address:'10.1.2.3',family:4}],open:()=>{throw Error('must not fetch private address');}}));
});
test('public pages follow bounded actual iframe chains and ignore embed-code strings in scripts',async()=>{
 const calls=[];const pages={'https://site.example/sport-2/':'<html><script>const code="<iframe src=\"https://wrong.example/\">";</script><iframe src="/ch/2-1.php"></iframe></html>','https://site.example/ch/2-1.php':'<html><iframe src="https://player.example/playerv5.php?match=12&amp;key=demo"></iframe></html>','https://player.example/playerv5.php?match=12&key=demo':'<html><script>function embed(){return "<iframe src=\"+url+\">"}</script><video></video></html>'};
 const r=await resolveHelper('https://site.example/sport-2/',{resolve,open:async url=>{calls.push(url);return response(url,pages[url]);}});assert.equal(r.embedUrl,'https://player.example/playerv5.php?match=12&key=demo');assert.equal(calls.length,3);
});
test('a server-side fetch refusal still permits the original validated browser player',async()=>{
 const r=await resolveHelper('https://player.example/watch',{resolve,open:async()=>{throw Error('403');}});assert.equal(r.embedUrl,'https://player.example/watch');
});
test('helper preview and channel playback enforce authorization and preserve persistent links',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dshoof-helper-')),socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const preload=path.join(directory,'dns.mjs');await writeFile(preload,"import dns from 'node:dns/promises';import{syncBuiltinESMExports}from'node:module';const previous=dns.lookup;dns.lookup=(h,o)=>h==='helper.example.test'?Promise.resolve([{address:'93.184.216.34',family:4}]):previous(h,o);syncBuiltinESMExports();");
 const origin='http://127.0.0.1:'+port,child=spawn(process.execPath,['--import',preload,'server.mjs'],{env:{...process.env,DATA_DIR:directory,SERVER_PORT:String(port),PUBLIC_URL:origin,FFMPEG_PATH:'ffmpeg'},stdio:['ignore','ignore','ignore']});
 try{
  let ready=false;for(let n=0;n<100;n++){try{if((await fetch(origin+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
  const before=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));
  const post=(route,body,cookie='')=>fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
  const login=await post('/api/login',{key:before.owner}),ownerCookie=login.headers.get('set-cookie').split(';')[0];
  const snippet='<iframe src="https://helper.example.test/playerv5.php?match=12&key=demo" onload="alert(1)"></iframe>',preview='/helper-preview?source='+encodeURIComponent(snippet);
  assert.equal((await fetch(origin+preview)).status,403);
  const seen=await fetch(origin+preview,{headers:{Cookie:ownerCookie}});assert.equal(seen.status,200);assert.equal(seen.headers.get('x-frame-options'),'SAMEORIGIN');assert.match(seen.headers.get('content-security-policy'),/frame-src https:\/\/helper.example.test;/);assert.doesNotMatch(await seen.text(),/onload|alert\(1\)/);
  assert.equal((await fetch(origin+'/helper-preview?source=https%3A%2F%2F127.0.0.1',{headers:{Cookie:ownerCookie}})).status,400);
  assert.equal((await post('/api/select',{kind:'helper',url:snippet,title:'Helper channel',channel:'2'},ownerCookie)).status,200);
  const status=await(await fetch(origin+'/api/status?channel=2',{headers:{Cookie:ownerCookie}})).json();assert.equal(status.selection.kind,'helper');assert.equal(status.ready,true);assert.equal(status.channels[0].ready,false);
  const wrapper=await fetch(origin+'/channels/2/helper-frame',{headers:{Cookie:ownerCookie}});assert.equal(wrapper.status,200);assert.match(await wrapper.text(),/playerv5\.php\?match=12&amp;key=demo/);
  const m3u=await fetch(origin+'/channels/2/live/dshoof.m3u8',{headers:{Cookie:ownerCookie}});assert.equal(m3u.status,409);
  const root=await fetch(origin+'/');assert.equal(root.headers.get('x-frame-options'),'DENY');assert.match(root.headers.get('content-security-policy'),/frame-src 'self' https:\/\/www.youtube-nocookie.com/);
  const after=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));for(const name of ['owner','viewer','playlistAlias'])assert.equal(after[name],before[name]);assert.equal(after.selection,null);
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}await rm(directory,{recursive:true,force:true});}
});
