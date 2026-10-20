import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter,once} from 'node:events';
import {createChatEvents} from './chat-events.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const timeout=async(promise,ms=1000)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('event timeout')),ms);})]);}finally{clearTimeout(timer);}};
async function fixture(options={}){
 const emitter=new EventEmitter(),transport=createChatEvents({heartbeatMs:40,coalesceMs:5,...options});
 let version=1,messages=[{id:'first',name:'أحمد',text:'أهلًا',at:1}],typing=[],chatEnabled=true;
 const users=new Map([['alice',{id:'alice',name:'أحمد'}],['bob',{id:'bob',name:'سارة'}]]),calls=[];
 const snapshot=(a,since)=>{calls.push({id:a.id,since});return {version,settings:{chatEnabled,name:'room',ownerToken:'secret-in-settings'},messages,poll:{id:'vote',question:'مَن؟',options:['a','b'],myVote:a.id==='alice'?0:1},myReactions:a.id==='alice'?['like']:['heart'],typing,roster:[{name:'صديق',avatar:'purple',key:'forbidden-roster-key'}],ownerKey:'forbidden-owner-key',mediaURL:'https://private.invalid/stream?key=forbidden-media-key'};};
 const server=http.createServer(async(req,res)=>{await transport.handle(req,res,{access:()=>users.get(req.headers.cookie),snapshot,subscribe:callback=>{emitter.on('room',callback);return()=>emitter.off('room',callback);}});});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const clients=[];
 async function connect(id){
  const abort=new AbortController(),response=await fetch(base,{headers:{cookie:id},signal:abort.signal});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const reader=response.body.getReader(),decoder=new TextDecoder(),events=[],waiters=[];let buffer='',ended=false;
  const pump=(async()=>{try{while(true){const result=await reader.read();if(result.done)break;buffer+=decoder.decode(result.value,{stream:true});let at;while((at=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,at);buffer=buffer.slice(at+2);if(!frame.includes('event: room\n'))continue;const data=JSON.parse(frame.split('\n').find(line=>line.startsWith('data: ')).slice(6));events.push(data);if(waiters.length)waiters.shift()(events.shift());}}}catch{}finally{ended=true;for(const resolve of waiters.splice(0))resolve(null);}})();
  const client={response,events,next:()=>events.length?Promise.resolve(events.shift()):ended?Promise.resolve(null):timeout(new Promise(resolve=>waiters.push(resolve))),async close(){abort.abort();await pump;},ended:()=>ended};clients.push(client);return client;
 }
 return {base,transport,users,calls,emitter,connect,update(change={},bump=true){if(change.messages)messages=change.messages;if(change.typing)typing=change.typing;if(change.chatEnabled!==undefined)chatEnabled=change.chatEnabled;if(bump)version++;emitter.emit('room');},async close(){for(const client of clients)await client.close();transport.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}

test('HTTP event stream is private per user and projects only room data',async()=>{
 const f=await fixture();try{
  assert.equal((await fetch(f.base)).status,403);f.users.set('limited',{id:'limited',limited:true});assert.equal((await fetch(f.base,{headers:{cookie:'limited'}})).status,403);
  assert.equal((await fetch(f.base,{method:'POST',headers:{cookie:'alice'}})).status,405);
  const a=await f.connect('alice'),b=await f.connect('bob'),one=await a.next(),two=await b.next();
  assert.equal(one.room.poll.myVote,0);assert.equal(two.room.poll.myVote,1);assert.deepEqual(one.room.myReactions,['like']);assert.deepEqual(two.room.myReactions,['heart']);
  assert.equal(one.room.messages.length,1);assert.equal(two.room.messages.length,1);assert.equal(f.transport.stats().connections,2);
  for(const value of [one,two])assert.doesNotMatch(JSON.stringify(value),/forbidden|secret-in-settings|private\.invalid/);
  f.update({chatEnabled:false});const updateA=await a.next(),updateB=await b.next();assert.equal(updateA.room.poll.myVote,0);assert.equal(updateB.room.poll.myVote,1);
  assert.match(a.response.headers.get('cache-control'),/no-store/);assert.equal(a.response.headers.get('x-accel-buffering'),'no');
 }finally{await f.close();}assert.deepEqual(f.transport.stats(),{connections:0,identities:0});assert.equal(f.emitter.listenerCount('room'),0);
});

test('messages arrive as small deltas; unchanged versions carry typing without resending history',async()=>{
 const f=await fixture();try{
  const client=await f.connect('alice');await client.next();
  f.update({messages:[{id:'first',name:'أحمد',text:'أهلًا',at:1},{id:'second',name:'سارة',text:'وصلت',at:2}]});
  const next=await client.next();assert.equal(next.room.messages,undefined);assert.deepEqual(next.room.messagesDelta.removed,[]);assert.equal(next.room.messagesDelta.added[0].id,'second');assert.ok(Buffer.byteLength(JSON.stringify(next))<2048);
  f.update({typing:['سارة']},false);const typing=await client.next();assert.deepEqual(typing.room.typing,['سارة']);assert.equal(typing.room.messages,undefined);assert.equal(typing.room.messagesDelta,undefined);assert.equal(typing.room.poll,undefined);assert.equal(f.calls.at(-1).since,2);
  f.update({messages:[]});const removed=await client.next();assert.deepEqual(removed.room.messagesDelta.removed,['first','second']);assert.deepEqual(removed.room.messagesDelta.added,[]);
  f.update({chatEnabled:false});const disabled=await client.next();assert.equal(disabled.room.settings.chatEnabled,false);assert.equal(disabled.room.messages,undefined);
 }finally{await f.close();}
});

test('coalesced bursts keep latest history, and edits or reorder fall back to a full snapshot',async()=>{
 const f=await fixture();try{
  const client=await f.connect('alice');await client.next();
  for(let i=0;i<10;i++)f.update({messages:[{id:'first',name:'أحمد',text:'أهلًا',at:1},...Array.from({length:i+1},(_,n)=>({id:'m'+n,text:'message '+n}))]});
  const burst=await client.next();assert.equal(burst.room.messagesDelta.added.length,10);assert.equal(burst.room.version,11);
  f.update({messages:[{id:'m0',text:'edited'},{id:'first',text:'reordered'}]});const edited=await client.next();assert.equal(edited.room.messages.length,2);assert.equal(edited.room.messagesDelta,undefined);
 }finally{await f.close();}
});

test('revocation closes an existing stream on the next event or heartbeat',async()=>{
 const f=await fixture();try{
  const a=await f.connect('alice');await a.next();f.users.delete('alice');f.update();assert.equal(await a.next(),null);
  const b=await f.connect('bob');await b.next();f.users.delete('bob');assert.equal(await b.next(),null);
  assert.equal(f.transport.stats().connections,0);assert.equal(f.emitter.listenerCount('room'),0);
 }finally{await f.close();}
});

test('connection caps reject excess streams and release slots on disconnect',async()=>{
 const f=await fixture({maxConnections:2,maxPerIdentity:1});try{
  const a=await f.connect('alice');await a.next();assert.equal((await fetch(f.base,{headers:{cookie:'alice'}})).status,429);
  const b=await f.connect('bob');await b.next();f.users.set('carol',{id:'carol'});assert.equal((await fetch(f.base,{headers:{cookie:'carol'}})).status,429);
  await a.close();await delay(10);const replacement=await f.connect('carol');assert.ok((await replacement.next()).room);f.transport.close();assert.equal(await b.next(),null);assert.equal(await replacement.next(),null);
  assert.equal((await fetch(f.base,{headers:{cookie:'bob'}})).status,503);
 }finally{await f.close();}
});

test('backpressure holds only one accepted frame and coalesces to the latest delta after drain',async()=>{
 const req=new EventEmitter();req.method='GET';const res=new EventEmitter();res.destroyed=false;res.writableEnded=false;res.frames=[];res.writeHead=()=>{};res.flushHeaders=()=>{};res.end=()=>{res.writableEnded=true;};let block=true;res.write=frame=>{res.frames.push(frame);return !block;};
 const emitter=new EventEmitter(),transport=createChatEvents({heartbeatMs:1000,coalesceMs:1});let version=1,messages=[{id:'one',text:'one'}];
 try{
  await transport.handle(req,res,{access:()=>({id:'alice'}),snapshot:()=>({version,messages}),subscribe:fn=>{emitter.on('room',fn);return()=>emitter.off('room',fn);}});
  assert.equal(res.frames.length,1);
  for(let i=0;i<100;i++){version++;messages=[{id:'one',text:'one'},{id:'latest'+i,text:'final'}];emitter.emit('room');}await delay(10);assert.equal(res.frames.length,1);
  block=false;res.emit('drain');await delay(10);assert.equal(res.frames.length,2);const data=JSON.parse(res.frames[1].split('\n').find(line=>line.startsWith('data: ')).slice(6));assert.equal(data.room.messagesDelta.added[0].id,'latest99');assert.equal(data.room.version,101);
 }finally{transport.close();}assert.equal(emitter.listenerCount('room'),0);assert.equal(res.listenerCount('drain'),0);
});

test('a slow snapshot cannot send private data after access is revoked while it was pending',async()=>{
 const req=new EventEmitter();req.method='GET';const res=new EventEmitter();res.frames=[];res.destroyed=false;res.writableEnded=false;res.writeHead=()=>{};res.flushHeaders=()=>{};res.end=()=>{res.writableEnded=true;};res.write=frame=>{res.frames.push(frame);return true;};
 const transport=createChatEvents();let allowed=true,release;const snapshot=new Promise(resolve=>{release=resolve;});
 const pending=transport.handle(req,res,{access:()=>allowed?{id:'alice'}:null,snapshot:()=>snapshot,subscribe:()=>()=>{}});
 await delay(5);allowed=false;release({version:1,messages:[{id:'private',text:'do not send'}]});await pending;
 assert.equal(res.frames.length,0);assert.equal(res.writableEnded,true);assert.equal(transport.stats().connections,0);transport.close();
});

test('a stalled reader is closed after the bounded backpressure deadline',async()=>{
 const req=new EventEmitter();req.method='GET';const res=new EventEmitter();res.destroyed=false;res.writableEnded=false;res.writeHead=()=>{};res.flushHeaders=()=>{};res.end=()=>{res.writableEnded=true;};let frames=0;res.write=()=>{frames++;return false;};
 const emitter=new EventEmitter(),transport=createChatEvents({heartbeatMs:10,backpressureMs:25});
 try{await transport.handle(req,res,{access:()=>({id:'alice'}),snapshot:()=>({version:1,messages:[]}),subscribe:fn=>{emitter.on('room',fn);return()=>emitter.off('room',fn);}});await delay(60);assert.equal(res.writableEnded,true);assert.equal(frames,1);assert.equal(transport.stats().connections,0);assert.equal(emitter.listenerCount('room'),0);}finally{transport.close();}
});
