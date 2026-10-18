import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRoom,hash} from './room.mjs';
const origin='https://dshoof.example',url=new URL(origin+'/watch');
const request=(cookie='',ip='203.0.113.1')=>({headers:{cookie},socket:{remoteAddress:ip}});
const cookie=joined=>'dshoof_member='+joined.sessionCookie;
const create=(persist=async()=>{},extra={})=>{const state={owner:'private-owner',viewer:'private-viewer',...extra};return {state,room:createRoom(state,persist)};};
const register=(room,username='viewer_one',name='مشاهد أول',req=request())=>room.join({username,name},req);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('public registration uses a durable hashed secret, never a public name, ID or supplied role',async()=>{
 const {state,room}=create(),joined=await room.join({username:'Viewer_One',displayName:'مشاهد أول',role:'moderator',owner:true,id:'owner',avatar:'gold'},request());
 assert.match(joined.sessionCookie,/^[A-Za-z0-9_-]{43}$/);assert.equal(state.members[0].tokenHash,hash(joined.sessionCookie));assert.ok(!JSON.stringify(state).includes(joined.sessionCookie));assert.equal(joined.member.role,'viewer');assert.equal(joined.member.avatar,'gold');
 const a=room.access(request(cookie(joined)),url);assert.equal(a.member,true);assert.equal(a.username,'viewer_one');assert.equal(a.role,'viewer');assert.equal(a.owner,undefined);assert.equal(a.key,undefined);assert.equal(room.active.size,0);
 for(const value of [a.id,a.username,state.members[0].tokenHash])assert.equal(room.access(request('dshoof_member='+value),url),null);
 assert.equal(room.access(request(),new URL(origin+'/?key='+joined.sessionCookie)),null);
 const restored=createRoom(JSON.parse(JSON.stringify(state)),async()=>{});assert.equal(restored.access(request(cookie(joined)),url).id,a.id);
 const returning=await restored.join({username:'ignored',name:'الاسم لا يغيّر الهوية'},request(cookie(joined)));assert.equal(returning.member.id,a.id);assert.equal(returning.sessionCookie,joined.sessionCookie);
});

test('registration normalizes usernames and rejects reserved or invisible management names',async()=>{
 const {room}=create(async()=>{},{ownerProfile:{name:'صاحب القناة'}}),joined=await room.join({username:'ＦＯＯ_12',name:'عا\u202eلي\u200b'},request());assert.equal(joined.member.username,'foo_12');assert.equal(joined.member.name,'عالي');
 await assert.rejects(room.join({username:'fOo_12',name:'اسم ثان'},request()),/مستخدم/);
 for(const username of ['ab','أحمد','user-name','a'.repeat(25),'ＡＤＭＩＮ'])await assert.rejects(room.join({username,name:'اسم صحيح'},request()));
 for(const name of ['ad\u200bmin','ＡＤＭＩＮ','المُضيف','صاحب\u2066 القناة','x','x'.repeat(33)])await assert.rejects(room.join({username:'unique_name',name},request()));
});

test('duplicate registrations are serialized and a failed registration does not reserve its username',async()=>{
 const {state,room}=create();const results=await Promise.allSettled([register(room,'same_name'),register(room,'SAME_NAME')]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(state.members.length,1);
 let calls=0;const failure=create(async()=>{if(++calls===1)throw Error('transient registration write');});await assert.rejects(register(failure.room,'retry_name'),/transient/);assert.equal(failure.state.members.length,0);const retried=await register(failure.room,'retry_name');assert.equal(failure.state.members.length,1);assert.ok(failure.room.access(request(cookie(retried)),url));
});

test('failed profile rename cannot race a new registration into duplicate usernames',async()=>{
 let writes=0;const blocked=deferred(),entered=deferred(),{state,room}=create(async()=>{if(++writes===2){entered.resolve();await blocked.promise;}}),joined=await register(room,'alice'),a=room.access(request(cookie(joined)),url);
 const profile=room.profile(a,{username:'bravo',name:'اسم جديد'}).catch(error=>error);await entered.promise;
 const registration=room.join({username:'alice',name:'اسم آخر'},request('','203.0.113.2'));const rejected=assert.rejects(registration,/مستخدم/);blocked.reject(Error('transient profile write'));assert.match((await profile).message,/transient/);await rejected;assert.deepEqual(state.members.map(member=>member.username),['alice']);assert.equal(state.members[0].name,'مشاهد أول');
});

test('registration and metadata do not consume capacity; media leases honor configured limits and expire',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});const {room}=create(async()=>{},{settings:{maxViewers:1,slowSeconds:3}}),one=await register(room,'viewer_one'),two=await register(room,'viewer_two','مشاهد ثان',request('','203.0.113.2'));
 const r1=request(cookie(one)),r2=request(cookie(two));assert.equal(room.active.size,0);assert.equal(room.access(r1,url).member,true);assert.equal(room.active.size,0);
 assert.equal(room.access(r1,url,{lease:true}).member,true);assert.equal(room.active.size,1);assert.equal(room.access(r2,url,{lease:true}).limited,true);assert.equal(room.access(r2,url).member,true);
 t.mock.timers.tick(30001);assert.equal(room.access(r2,url,{lease:true}).member,true);assert.equal(room.active.size,1);assert.equal(room.access(r1,url,{lease:true}).limited,true);
});

test('registration limits records and join bursts, preserving existing slow mode settings',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});const {state,room}=create();assert.equal(state.settings.slowSeconds,1);for(let n=0;n<12;n++)await register(room,'viewer_'+n);await assert.rejects(register(room,'viewer_12'),/طلبات تسجيل/);t.mock.timers.tick(600001);await register(room,'viewer_12');
 const seeded=Array.from({length:1000},(_,n)=>({id:'m_'+n,username:'existing_'+n,tokenHash:hash('existing_'+n),expires:Date.now()+100000})),full=create(async()=>{},{members:seeded,settings:{slowSeconds:3}});await assert.rejects(register(full.room,'new_viewer'),/سجل المشاهدين/);assert.equal(full.state.members.length,1000);assert.equal(full.state.settings.slowSeconds,3);
});

test('member profiles, moderation and private owner roster never disclose session secrets',async()=>{
 const {state,room}=create(),joined=await register(room),req=request(cookie(joined));let a=room.access(req,url,{lease:true});room.react(a,{type:'heart'});await room.profile(a,{username:'updated_user',name:'الاسم الجديد',avatar:'blue'});a=room.access(req,url);assert.equal(a.username,'updated_user');assert.equal(a.name,'الاسم الجديد');
 const viewer=room.snapshot(a,0);assert.equal(viewer.username,'updated_user');assert.equal(viewer.canManageChat,false);assert.equal(viewer.online,null);assert.deepEqual(viewer.roster,[]);assert.deepEqual(viewer.reactionNames.heart,['الاسم الجديد']);
 const owner=room.snapshot({owner:true,id:'owner'},0);assert.equal(owner.online,1);assert.equal(owner.canManageChat,true);assert.equal(owner.roster[0].username,'updated_user');
 const admin=room.admin(origin)[0];assert.equal(admin.kind,'member');assert.equal(admin.online,true);assert.equal(admin.joinedAt,state.members[0].createdAt);assert.equal(admin.expiresAt,state.members[0].expires);assert.ok(!JSON.stringify(admin).includes(joined.sessionCookie));assert.ok(!JSON.stringify(admin).includes(state.members[0].tokenHash));
 await room.moderate({id:a.id,action:'mute'});assert.equal(room.access(req,url).muted,true);assert.throws(()=>room.chat(room.access(req,url),{text:'رسالة ممنوعة'}),/المضيف/);await room.moderate({id:a.id,action:'revoke'});assert.equal(room.access(req,url),null);assert.equal(room.active.size,0);assert.equal(room.admin(origin)[0].online,false);
});

test('public members retain legacy invitations and permanent owner/private receiver links',async()=>{
 const {state,room}=create(),joined=await register(room),invite=await room.invite({name:'دعوة قديمة'},origin),key=new URL(invite.url).pathname.split('/').at(-1);
 assert.equal(room.access(request('dshoof_viewer='+key),url).id,invite.id);assert.equal(room.access(request(),new URL(origin+'/?key='+state.viewer)).personal,true);assert.equal(room.access(request(),new URL(origin+'/?key='+state.playlistAlias)).personal,true);
 const signed=room.ownerSession();assert.equal(room.access(request(cookie(joined)+'; dshoof_owner='+signed),url).owner,true);assert.equal(room.access(request(cookie(joined)),new URL(origin+'/?key='+key)).member,true);assert.equal(room.access(request(cookie(joined)),new URL(origin+'/?key='+state.playlistAlias),{legacy:true}).personal,true);assert.equal(room.access(request(cookie(joined)),new URL(origin+'/?key='+key),{legacy:true}).id,invite.id);assert.equal(room.access(request(cookie(joined)),new URL(origin+'/?key=invalid'),{legacy:true}).member,true);assert.equal(room.access(request(cookie(joined)+'; dshoof_viewer='+state.playlistAlias),url,{legacy:true}).member,true);
});

test('room subscriptions isolate listeners and expire typing without resending social history',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});const {room}=create(),events=[],unsubscribe=room.subscribe(event=>events.push(event));room.subscribe(()=>{throw Error('isolated subscriber');});room.subscribe(()=>Promise.reject(Error('isolated async subscriber')));
 const joined=await register(room),a=room.access(request(cookie(joined)),url);assert.equal(events.at(-1).type,'room');const version=room.snapshot(a,0).version;room.type(a);assert.equal(events.at(-1).type,'typing');const receiver={id:'other'};assert.deepEqual(room.snapshot(receiver,version).typing,['مشاهد أول']);assert.equal(Object.hasOwn(room.snapshot(receiver,version),'messages'),false);
 t.mock.timers.tick(5001);assert.deepEqual(room.snapshot(receiver,version).typing,[]);assert.equal(events.at(-1).type,'typing');assert.equal(room.snapshot(a,0).version,version);
 unsubscribe();unsubscribe();const count=events.length;room.bump();assert.equal(events.length,count);
 const cap=create().room,unsubscribers=[];for(let n=0;n<128;n++)unsubscribers.push(cap.subscribe(()=>{}));assert.throws(()=>cap.subscribe(()=>{}),/اتصالات/);unsubscribers[0]();cap.subscribe(()=>{});
});

test('viewer diagnostics remain owner-only, consented, bounded and ephemeral',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});const {state,room}=create(),joined=await register(room),req=request(cookie(joined)),a=room.access(req,url,{lease:true}),before=room.snapshot(a,0).version;
 const details={clientInfo:{shared:true,device:'هاتف',browser:'متصفح',os:'نظام',screen:{width:99999,height:1080,pixelRatio:2},battery:{level:900,charging:true},network:{type:'wifi',effectiveType:'4g',downlink:10,rtt:25,saveData:true,secret:'excluded'},timezone:'Asia/Baghdad',locale:'ar-IQ',subscription:'fiber',location:{latitude:33.3,longitude:44.4,accuracy:20},arbitrary:{secret:'excluded'}},ip:'198.51.100.4',ipSource:'trusted-proxy'};
 room.report(a,{state:'playing',buffer:15,height:360},details);const admin=room.admin(origin)[0];assert.equal(admin.info.ip,details.ip);assert.equal(admin.info.screen.width,16384);assert.equal(admin.info.battery.level,100);assert.equal(admin.info.subscription,'fiber');assert.equal(admin.info.location.latitude,33.3);assert.equal(admin.info.arbitrary,undefined);assert.equal(admin.info.network.secret,undefined);assert.equal(room.snapshot(a,0).version,before);
 const publicText=JSON.stringify(room.snapshot(a,0)),saved=JSON.stringify(state);assert.ok(!publicText.includes(details.ip));assert.ok(!publicText.includes('33.3'));assert.ok(!saved.includes(details.ip));assert.ok(!saved.includes('33.3'));assert.ok(!saved.includes('clientInfo'));
 t.mock.timers.tick(5001);room.report(a,{state:'playing'},{clientInfo:{shared:false,device:'should disappear'},ip:details.ip,ipSource:'untrusted-body'});const optedOut=room.admin(origin)[0].info;assert.equal(optedOut.device,undefined);assert.equal(optedOut.location,undefined);assert.equal(optedOut.ipSource,'socket');
 t.mock.timers.tick(45001);const departed=room.admin(origin)[0];assert.equal(departed.online,false);assert.equal(departed.info,null);assert.equal(departed.connections.length,0);
});

test('joined waiting visitors are visible only to the owner without consuming a video lease',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});const {state,room}=create(async()=>{},{settings:{maxViewers:1}}),joined=await register(room),req=request(cookie(joined)),visitor=room.access(req,url);assert.equal(room.active.size,0);assert.equal(room.presence.size,1);
 room.report(visitor,{state:'paused'},{clientInfo:{shared:true,device:'Waiting phone',subscription:'mobile'},ip:'198.51.100.8',ipSource:'socket'});const owner=room.snapshot({owner:true,id:'owner'},0),admin=room.admin(origin)[0];assert.equal(owner.online,1);assert.equal(owner.roster[0].username,visitor.username);assert.equal(admin.online,true);assert.equal(admin.info.device,'Waiting phone');assert.equal(admin.connections[0].watching,false);assert.equal(room.snapshot(visitor,0).online,null);assert.deepEqual(room.snapshot(visitor,0).roster,[]);assert.ok(!JSON.stringify(state).includes('198.51.100.8'));assert.ok(!JSON.stringify(state).includes('Waiting phone'));
 const second=await register(room,'another_viewer','مشاهد ثان',request('','203.0.113.2'));assert.equal(room.access(request(cookie(second)),url,{lease:true}).member,true);assert.equal(room.active.size,1);assert.equal(room.access(req,url,{lease:true}).limited,true);assert.equal(room.access(req,url).member,true);
 t.mock.timers.tick(20000);room.access(req,url);assert.equal(room.active.get(visitor.connection),undefined);assert.equal(room.active.size,1);t.mock.timers.tick(30001);room.access(req,url);assert.equal(room.active.size,0);assert.equal(room.admin(origin).find(item=>item.id===visitor.id).online,true);assert.equal(room.admin(origin).find(item=>item.id===second.member.id).online,false);
 t.mock.timers.tick(45001);const gone=room.admin(origin).find(item=>item.id===visitor.id);assert.equal(gone.online,false);assert.equal(gone.info,null);assert.equal(room.presence.size,0);
});

test('privacy opt-out clears immediately despite report limits and blocks stale diagnostic reports',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});const {state,room}=create(),joined=await register(room),a=room.access(request(cookie(joined)),url),old={clientInfo:{shared:true,device:'Private phone',location:{latitude:33.3,longitude:44.4,accuracy:5},subscription:'mobile'},ip:'198.51.100.9',ipSource:'trusted-proxy'};
 room.report(a,{state:'paused'},old);assert.ok(room.admin(origin)[0].info.location);room.privacy(a,{location:false});assert.equal(room.admin(origin)[0].info.location,undefined);assert.equal(room.admin(origin)[0].info.device,'Private phone');assert.throws(()=>room.report(a,{state:'paused'},old),/انتظر/);
 t.mock.timers.tick(5001);room.report(a,{state:'paused'},old);assert.equal(room.admin(origin)[0].info.location,undefined);room.privacy(a,{device:false});let info=room.admin(origin)[0].info;assert.equal(info.device,undefined);assert.equal(info.ip,old.ip);assert.equal(info.shared,false);
 t.mock.timers.tick(5001);room.report(a,{state:'paused'},old);assert.equal(room.admin(origin)[0].info.device,undefined);room.privacy(a,{device:true});t.mock.timers.tick(5001);room.report(a,{state:'paused'},old);info=room.admin(origin)[0].info;assert.equal(info.device,'Private phone');assert.equal(info.location,undefined);
 room.privacy(a,{location:true});t.mock.timers.tick(5001);room.report(a,{state:'paused'},old);assert.equal(room.admin(origin)[0].info.location.latitude,33.3);assert.ok(!JSON.stringify(room.admin(origin)).includes('privacyPolicy'));assert.ok(!JSON.stringify(state).includes('privacyPolicy'));assert.equal(room.active.size,0);
});

test('room snapshots expose a nonsecret instance ID that changes across process instances',()=>{
 const {state,room}=create(),first=room.snapshot({id:'one'},0),again=room.snapshot({id:'two'},0),restarted=createRoom(state,async()=>{}).snapshot({id:'one'},0);assert.match(first.instanceId,/^[a-f0-9]{24}$/);assert.equal(first.instanceId,again.instanceId);assert.notEqual(first.instanceId,restarted.instanceId);assert.ok(!first.instanceId.includes(state.owner));
});

test('owner roster groups a thousand waiting visitors and active leases without duplicating connections',()=>{
 const secrets=Array.from({length:1000},(_,n)=>'token_'+String(n).padStart(37,'0')),members=secrets.map((secret,n)=>({id:'m_'+n,username:'viewer_'+n,name:'مشاهد '+n,avatar:'purple',tokenHash:hash(secret),createdAt:Date.now(),expires:Date.now()+100000})),{room}=create(async()=>{},{members,settings:{maxViewers:30}});
 for(let n=0;n<members.length;n++){const a=room.access(request('dshoof_member='+secrets[n]),url,{lease:n<5});room.report(a,{state:n<5?'playing':'paused'},{clientInfo:{shared:true,device:'Device '+n,subscription:'wifi'}});}
 assert.equal(room.presence.size,1000);assert.equal(room.active.size,5);const rows=room.admin(origin);assert.equal(rows.length,1000);for(let n=0;n<rows.length;n++){const row=rows[n];assert.equal(row.id,'m_'+n);assert.equal(row.username,'viewer_'+n);assert.equal(row.online,true);assert.equal(row.connections.length,1);assert.equal(row.connections[0].watching,n<5);assert.equal(row.info.device,'Device '+n);assert.equal(row.report.state,n<5?'playing':'paused');assert.equal(Object.hasOwn(row,'tokenHash'),false);assert.equal(Object.hasOwn(row.connections[0],'privacyPolicy'),false);}
});
