import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRoom} from './room.mjs';
const origin='https://dshoof.example',url=new URL(origin+'/watch'),owner={id:'owner',owner:true,name:'المضيف'};
const req=(cookie='')=>({headers:{cookie},socket:{remoteAddress:'203.0.113.1'}});
const cookie=joined=>'dshoof_member='+joined.sessionCookie;
async function fixture(persist=async()=>{}){const state={owner:'private-owner',viewer:'private-viewer'},room=createRoom(state,persist),joined=await room.join({username:'viewer_one',name:'مشاهد أول',role:'moderator'},req());return {state,room,joined,id:joined.member.id};}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('only the owner manages members, signup/profile cannot grant privileges, owner role is never valid',async()=>{
 const {state,room,joined,id}=await fixture();assert.equal(state.members[0].role,'viewer');
 for(const actor of [null,{id:'viewer'},{id:'moderator',role:'moderator'},{id:'stream',role:'stream'},{id:'owner',owner:'true'}])await assert.rejects(room.manageMember(actor,{action:'update',id,role:'moderator'}),/للمالك/);
 const a=room.access(req(cookie(joined)),url);await room.profile(a,{name:'اسم جديد',role:'moderator',owner:true});assert.equal(room.access(req(cookie(joined)),url).role,'viewer');await assert.rejects(room.manageMember(owner,{action:'update',id,role:'owner'}),/صلاحية/);
 state.members[0].role='owner';assert.equal(room.access(req(cookie(joined)),url).role,'viewer');assert.equal(room.access(req(cookie(joined)),url).owner,undefined);state.members[0].role='observer';assert.equal(room.access(req(cookie(joined)),url).role,'observer');assert.equal(room.snapshot(room.access(req(cookie(joined)),url),0).canManageChat,false);
});

test('owner updates normalized identity and delegated roles durably without changing credentials or permanent links',async()=>{
 const {state,room,joined,id}=await fixture(),record=state.members[0],before={tokenHash:record.tokenHash,expires:record.expires,createdAt:record.createdAt,owner:state.owner,viewer:state.viewer,alias:state.playlistAlias},events=[];room.subscribe(event=>events.push(event));room.access(req(cookie(joined)),url,{lease:true});
 const updated=await room.manageMember(owner,{action:'update',id,username:'ＦＯＯ_12',displayName:'علي\u202e الجديد',avatar:'gold',role:'stream',tokenHash:'ignored',owner:true});assert.equal(updated.member.username,'foo_12');assert.equal(updated.member.name,'علي الجديد');assert.equal(updated.member.role,'stream');assert.equal(updated.member.revoked,false);assert.equal(events.at(-1).type,'room');
 const active=room.admin(origin)[0];assert.equal(active.username,'foo_12');assert.equal(active.connections[0].name,'علي الجديد');assert.equal(active.role,'stream');assert.equal(room.access(req(cookie(joined)),url).role,'stream');
 const restored=createRoom(JSON.parse(JSON.stringify(state)),async()=>{});assert.equal(restored.access(req(cookie(joined)),url).role,'stream');assert.equal(record.tokenHash,before.tokenHash);assert.equal(record.expires,before.expires);assert.equal(record.createdAt,before.createdAt);assert.equal(state.owner,before.owner);assert.equal(state.viewer,before.viewer);assert.equal(state.playlistAlias,before.alias);assert.ok(!JSON.stringify(updated).includes(record.tokenHash));assert.ok(!JSON.stringify(updated).includes(joined.sessionCookie));
 await room.manageMember(owner,{action:'update',id,role:'moderator'});assert.equal(room.access(req(cookie(joined)),url).role,'moderator');assert.equal(room.snapshot(room.access(req(cookie(joined)),url),0).canManageChat,false);await room.manageMember(owner,{action:'update',id,role:'viewer'});assert.equal(room.access(req(cookie(joined)),url).role,'viewer');
});

test('member updates reject duplicates, reserved identities, bad avatars, roles and unsupported actions',async()=>{
 const {state,room,id}=await fixture();await room.join({username:'another_user',name:'اسم ثان'},req());state.ownerProfile={name:'صاحب القناة'};
 for(const changes of [{username:'ＡＮＯＴＨＥＲ_USER'},{username:'admin'},{name:'ad\u200bmin'},{name:'صاحب\u2066 القناة'},{name:'x'},{avatar:'javascript:alert(1)'},{role:'observer'},{role:'OWNER'}])await assert.rejects(room.manageMember(owner,{action:'update',id,...changes}));
 await assert.rejects(room.manageMember(owner,{action:'delete',id}),/غير صالح/);await assert.rejects(room.manageMember(owner,{action:'update',id:'missing'}),/غير موجود/);assert.equal(state.members.length,2);assert.equal(state.members[0].username,'viewer_one');
});

test('restore re-enables the same revoked browser identity and mute supports explicit state',async()=>{
 const {state,room,joined,id}=await fixture(),tokenHash=state.members[0].tokenHash;room.access(req(cookie(joined)),url,{lease:true});await room.manageMember(owner,{action:'mute',id,muted:true});assert.equal(room.access(req(cookie(joined)),url).muted,true);await room.manageMember(owner,{action:'mute',id,muted:true});assert.equal(room.access(req(cookie(joined)),url).muted,true);
 await room.moderate({action:'revoke',id});assert.equal(room.access(req(cookie(joined)),url),null);const result=await room.manageMember(owner,{action:'restore',id});assert.equal(result.member.revoked,false);assert.equal(result.member.muted,true);assert.equal(room.access(req(cookie(joined)),url).id,id);assert.equal(state.members[0].tokenHash,tokenHash);await room.manageMember(owner,{action:'mute',id,muted:false});assert.equal(room.access(req(cookie(joined)),url).muted,false);await room.manageMember(owner,{action:'mute',id});assert.equal(room.access(req(cookie(joined)),url).muted,true);await assert.rejects(room.manageMember(owner,{action:'mute',id,muted:'false'}));
});

test('failed owner updates roll back identity and privileges, then a subsequent update succeeds',async()=>{
 let writes=0;const {state,room,joined,id}=await fixture(async()=>{if(++writes===2)throw Error('transient member write');}),before=JSON.parse(JSON.stringify(state.members[0]));await assert.rejects(room.manageMember(owner,{action:'update',id,username:'new_username',name:'اسم آخر',avatar:'blue',role:'moderator'}),/transient/);assert.deepEqual(state.members[0],before);assert.equal(room.access(req(cookie(joined)),url).role,'viewer');await room.manageMember(owner,{action:'update',id,role:'stream'});assert.equal(room.access(req(cookie(joined)),url).role,'stream');
});

test('owner rename transactions share the registration queue and prevent duplicate names after a failed save',async()=>{
 let writes=0;const blocked=deferred(),entered=deferred(),{state,room,id}=await fixture(async()=>{if(++writes===2){entered.resolve();await blocked.promise;}});const change=room.manageMember(owner,{action:'update',id,username:'new_username',role:'stream'}).catch(error=>error);await entered.promise;
 const registration=room.join({username:'viewer_one',name:'عضو آخر'},req()),rejected=assert.rejects(registration,/مستخدم/);blocked.reject(Error('transient queued member write'));assert.match((await change).message,/transient/);await rejected;assert.equal(state.members.length,1);assert.equal(state.members[0].username,'viewer_one');assert.equal(state.members[0].role,'viewer');
});

test('pending role promotion stays ineffective until persistence commits and a failed promotion never authorizes',async()=>{
 const gate=deferred(),entered=deferred();let writes=0;const {state,room,joined,id}=await fixture(async()=>{if(++writes===2){entered.resolve();await gate.promise;}}),promotion=room.manageMember(owner,{action:'update',id,role:'stream'});await entered.promise;assert.equal(state.members[0].role,'stream');assert.equal(room.access(req(cookie(joined)),url).role,'viewer');assert.equal(room.admin(origin)[0].role,'viewer');gate.resolve();await promotion;assert.equal(room.access(req(cookie(joined)),url).role,'stream');
 const blocked=deferred(),reached=deferred();let failedWrites=0;const failed=await fixture(async()=>{if(++failedWrites===2){reached.resolve();await blocked.promise;}}),attempt=failed.room.manageMember(owner,{action:'update',id:failed.id,role:'moderator'}).catch(error=>error);await reached.promise;assert.equal(failed.room.access(req(cookie(failed.joined)),url).role,'viewer');blocked.reject(Error('promotion write failed'));assert.match((await attempt).message,/failed/);assert.equal(failed.room.access(req(cookie(failed.joined)),url).role,'viewer');assert.equal(failed.state.members[0].role,'viewer');
});

test('pending restore cannot authenticate before commit or after a failed save',async()=>{
 const gate=deferred(),entered=deferred();let writes=0;const {state,room,joined,id}=await fixture(async()=>{if(++writes===3){entered.resolve();await gate.promise;}});await room.moderate({action:'revoke',id});const restore=room.manageMember(owner,{action:'restore',id}).catch(error=>error);await entered.promise;assert.equal(state.members[0].revoked,false);assert.equal(room.access(req(cookie(joined)),url),null);gate.reject(Error('restore write failed'));assert.match((await restore).message,/failed/);assert.equal(room.access(req(cookie(joined)),url),null);assert.equal(state.members[0].revoked,true);await room.manageMember(owner,{action:'restore',id});assert.equal(room.access(req(cookie(joined)),url).id,id);
});

test('mute authorization and concurrent update/revoke follow durable queue order',async()=>{
 const first=deferred(),second=deferred(),enteredFirst=deferred(),enteredSecond=deferred();let writes=0;const {state,room,joined,id}=await fixture(async()=>{if(++writes===2){enteredFirst.resolve();await first.promise;}else if(writes===3){enteredSecond.resolve();await second.promise;}});
 const update=room.manageMember(owner,{action:'update',id,role:'stream'});await enteredFirst.promise;const revoke=room.moderate({action:'revoke',id});assert.equal(room.access(req(cookie(joined)),url).role,'viewer');first.resolve();await update;await enteredSecond.promise;assert.equal(room.access(req(cookie(joined)),url).role,'stream');second.resolve();await revoke;assert.equal(room.access(req(cookie(joined)),url),null);assert.equal(state.members[0].role,'stream');assert.equal(state.members[0].revoked,true);assert.equal(createRoom(JSON.parse(JSON.stringify(state)),async()=>{}).access(req(cookie(joined)),url),null);
 let pending=null,entered=null;const mutable=await fixture(async()=>{if(pending){const current=pending;pending=null;entered.resolve();await current.promise;}});const memberReq=req(cookie(mutable.joined));pending=deferred();const muteGate=pending;entered=deferred();const muted=mutable.room.manageMember(owner,{action:'mute',id:mutable.id,muted:true});await entered.promise;assert.equal(mutable.room.access(memberReq,url).muted,false);muteGate.resolve();await muted;assert.equal(mutable.room.access(memberReq,url).muted,true);
 pending=deferred();const unmuteGate=pending;entered=deferred();const unmuted=mutable.room.manageMember(owner,{action:'mute',id:mutable.id,muted:false});await entered.promise;assert.equal(mutable.room.access(memberReq,url).muted,true);unmuteGate.resolve();await unmuted;assert.equal(mutable.room.access(memberReq,url).muted,false);
});
