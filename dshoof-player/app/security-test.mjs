import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createPublicOpener,inputURL,rewriteInput} from './sources.mjs';
import {createRoom,cookies} from './room.mjs';
import {createPro} from './pro.mjs';

const request=cookie=>({headers:{cookie:'dshoof_owner='+cookie},socket:{remoteAddress:'127.0.0.1'}});
test('owner browser sessions do not expose bootstrap keys, expire, revoke and fail across restarts',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const state={owner:'permanent-owner-key',viewer:'permanent-viewer-key'},room=createRoom(state,async()=>{});
 const first=room.ownerSession(),second=room.ownerSession();
 assert.ok(!first.includes(state.owner));assert.notEqual(first,second);assert.equal(room.owner(request(first)),true);
 assert.equal(room.owner(request(state.owner)),false);assert.equal(room.owner(request(first.slice(0,-1)+'x')),false);
 room.logout(request(first));assert.equal(room.owner(request(first)),false);assert.equal(room.owner(request(second)),true);
 assert.equal(createRoom(state,async()=>{}).owner(request(second)),false);
 t.mock.timers.tick(12*3600000+1);assert.equal(room.owner(request(second)),false);
 assert.equal(state.owner,'permanent-owner-key');assert.equal(state.viewer,'permanent-viewer-key');
});
test('cookie parsing preserves equals and uses one unambiguous value',()=>{
 const parsed=cookies({headers:{cookie:'a=first==; a=second; __proto__=value; invalid'}});
 assert.equal(parsed.a,'first==');assert.equal(parsed.__proto__,'value');assert.equal(Object.getPrototypeOf(parsed),null);
});
function transport(routes,calls){return (url,options,callback)=>{
 const req=new EventEmitter();req.setTimeout=()=>req;req.destroy=error=>queueMicrotask(()=>req.emit('error',error));
 req.end=()=>queueMicrotask(()=>{calls.push({url:url.href,options});const data=routes[url.href];if(!data){req.emit('error',Error('Unknown fixture URL'));return;}const response=Readable.from([Buffer.from(data.body||'')]);response.statusCode=data.status||200;response.headers=data.headers||{};callback(response);});return req;
};}
test('source redirects are public-only, pinned and do not forward provider authorization across origins',async()=>{
 const calls=[],routes={'https://source.example/start':{status:302,headers:{location:'https://other.example/final'}},'https://other.example/final':{body:'video'}};
 const send=transport(routes,calls),open=createPublicOpener({resolve:async()=>[{address:'93.184.216.34',family:4}],httpsRequest:send,httpRequest:send});
 const result=await open('https://source.example/start',{'X-Player-Authorization':'temporary-secret',Host:'169.254.169.254','User-Agent':'safe\r\ninjected'});result.response.destroy();
 assert.equal(calls[0].options.headers['X-Player-Authorization'],'temporary-secret');assert.equal(calls[1].options.headers['X-Player-Authorization'],undefined);assert.equal(calls[0].options.headers.Host,undefined);assert.equal(calls[0].options.headers['User-Agent'],'DshoofPlayer/3.0');
 calls[0].options.lookup('ignored',{all:true},(error,addresses)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'93.184.216.34',family:4}]);});
 routes['https://source.example/start'].headers.location='http://169.254.169.254/latest/meta-data';await assert.rejects(open('https://source.example/start'),/المحلية/);
 const mixed=createPublicOpener({resolve:async()=>[{address:'93.184.216.34'},{address:'127.0.0.1'}],httpsRequest:send});await assert.rejects(mixed('https://source.example/start'),/إنترنت عام/);
});
test('source URL aliases and nested HLS escape routes are refused',()=>{
 for(const value of ['http://2130706433','http://0177.0.0.1','http://0x7f000001','http://[::ffff:127.0.0.1]','https://name:password@example.com','file:///etc/passwd'])assert.throws(()=>inputURL(value));
 assert.throws(()=>rewriteInput('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="file:///etc/passwd"','https://example.com/',x=>x));
 assert.throws(()=>rewriteInput('#EXTM3U\n#EXT-X-DEFINE:NAME="url",VALUE="http://127.0.0.1/"','https://example.com/',x=>x));
});
test('backup and schedules preserve long numeric codes and pair reads are scoped to a device',async()=>{
 const pro=createPro({},async()=>{}),code='12345678901234567890123456789012';await pro.backup({code});assert.equal(pro.state.backup.code,code);
 await pro.schedule({code,start:new Date(Date.now()+1000).toISOString(),end:new Date(Date.now()+10000).toISOString()});assert.equal(pro.state.schedules[0].source.code,code);
 await assert.rejects(pro.backup({code:'abcdef12'}),/الرقمي/);
 const a={id:'invite',connection:'one'},b={id:'invite',connection:'two'},pair=pro.pair(a);pro.remote({id:'remote'},{code:pair.code,action:'pause'});assert.throws(()=>pro.remote(b,{code:pair.code,action:'read'}));assert.equal(pro.remote(a,{code:pair.code,action:'read'}).action,'pause');
});

test('viewer playback telemetry updates owner metrics without resending social history',async()=>{
 const state={owner:'owner',viewer:'viewer'},room=createRoom(state,async()=>{}),invite=await room.invite({name:'مشاهد'},'https://example.com');
 const key=new URL(invite.url).pathname.split('/').at(-1),viewer=room.access({headers:{cookie:'dshoof_viewer='+key+'; dshoof_device=device'},socket:{remoteAddress:'127.0.0.1'}},new URL('https://example.com/watch'));
 room.chat(viewer,{text:'رسالة تبقى ضمن النسخة الاجتماعية'});const before=room.snapshot(viewer,0);
 room.report(viewer,{state:'playing',buffer:18,height:360,startupMs:1200,stalls:2});
 const delta=room.snapshot(viewer,before.version);assert.equal(delta.version,before.version);assert.equal(Object.hasOwn(delta,'messages'),false);assert.equal(Object.hasOwn(delta,'poll'),false);
 const connection=room.admin('https://example.com')[0].connections[0];assert.equal(connection.report.state,'playing');assert.equal(connection.report.buffer,18);assert.equal(connection.report.height,360);assert.equal(connection.report.stalls,2);
});
