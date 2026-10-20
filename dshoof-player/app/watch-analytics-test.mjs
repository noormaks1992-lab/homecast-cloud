import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWatchAnalytics} from './watch-analytics.mjs';
const initial=()=>({members:[{id:'member_a'},{id:'member_b'},{id:'revoked',revoked:true},{id:'expired',expires:1}],invites:[{id:'invite_a',expires:Date.parse('2030-01-01')}]});
function fixture({time=Date.parse('2026-10-18T12:00:00Z'),state=initial(),persist,flushMs=3600000}={}){
 let clock=time,writes=0,saved;const analytics=createWatchAnalytics(state,async()=>{writes++;saved=JSON.parse(JSON.stringify(state));if(persist)await persist(state);},{now:()=>clock,flushMs});
 return {state,analytics,get writes(){return writes;},get saved(){return saved;},advance(ms){clock+=ms;},set(value){clock=value;},begin(id='match1',title='مباراة اختبار'){analytics.beginBroadcast({id,title,startedAt:clock});},report(id='member_a',status='playing',extra={}){return analytics.report({id,member:true},{state:status,...extra});}};
}

test('only authenticated registered viewers count; owners, public strangers and revoked IDs do not',async()=>{
 const f=fixture();try{f.begin();for(const access of [null,{}, {id:'owner',owner:true},{id:'member_a',owner:true},{id:'member_a',limited:true},{id:'receiver',personal:true},{id:'unknown',member:true},{id:'revoked',member:true},{id:'expired',member:true}])assert.equal(f.analytics.report(access,{state:'playing'}),false);
  assert.deepEqual(f.analytics.summary().total,{unique:0,watchSeconds:0});assert.equal(f.report('member_a'),true);assert.equal(f.analytics.report({id:'invite_a'},{state:'playing'}),true);assert.equal(f.analytics.summary().total.unique,2);
 }finally{await f.analytics.close();}
});

test('server report intervals count playing only, cap credit30s and do not accept client durations',async()=>{
 const f=fixture();try{
  f.begin();f.report();f.advance(10000);f.report('member_a','playing',{duration:99999999,at:999999999999999,seconds:50000,timeZone:'Pacific/Honolulu'});assert.equal(f.analytics.perMember('member_a').totalSeconds,10);
  f.advance(40000);f.report('member_a','paused');assert.equal(f.analytics.perMember('member_a').totalSeconds,40);
  f.advance(20000);f.report('member_a','buffering');assert.equal(f.analytics.perMember('member_a').totalSeconds,40);
  f.advance(10000);f.report();f.advance(46000);f.report();assert.equal(f.analytics.perMember('member_a').totalSeconds,40,'gaps>45s must not add time');
  f.advance(5000);f.report('member_a','error');assert.equal(f.analytics.perMember('member_a').totalSeconds,45);
  const member=f.analytics.perMember('member_a');assert.equal(member.sessions.length,3);assert.equal(member.todaySeconds,45);assert.equal(member.currentSeconds,45);assert.equal(f.analytics.summary().current.watchSeconds,45);
 }finally{await f.analytics.close();}
});

test('Baghdad calendar splits a playing interval at21:00UTC and ignores client timezone',async()=>{
 const f=fixture({time:Date.parse('2026-10-18T20:59:50Z')});try{
  f.begin();f.report();f.advance(20000);f.report('member_a','playing',{timeZone:'UTC'});
  assert.deepEqual(f.analytics.summary().day,{date:'2026-10-19',timeZone:'Asia/Baghdad',unique:1,watchSeconds:10});assert.equal(f.analytics.perMember('member_a').todaySeconds,10);assert.equal(f.state.watchAnalytics.days['2026-10-18'].watchMs,10000);assert.equal(f.analytics.summary().total.watchSeconds,20);
 }finally{await f.analytics.close();}
});

test('same broadcast ID survives restart without reset or counting offline gaps',async()=>{
 const f=fixture();f.begin('saved_match');f.report();f.advance(12000);f.report('member_a','paused');await f.analytics.flush();const saved=f.saved;await f.analytics.close();
 const restarted=fixture({state:saved,time:Date.parse('2026-10-19T10:00:00Z')});try{
  assert.equal(restarted.analytics.beginBroadcast({id:'saved_match',title:'same',startedAt:0}),false);assert.equal(restarted.analytics.summary().current.watchSeconds,12);assert.equal(restarted.analytics.perMember('member_a').totalSeconds,12);
  restarted.report();assert.equal(restarted.analytics.perMember('member_a').totalSeconds,12);restarted.advance(8000);restarted.report('member_a','paused');assert.equal(restarted.analytics.perMember('member_a').totalSeconds,20);assert.equal(restarted.analytics.summary().current.unique,1);
 }finally{await restarted.analytics.close();}
});

test('source changes and stop preserve totals and sessions while resetting only current broadcast',async()=>{
 const f=fixture();try{
  f.begin('one','الأولى');f.report();f.advance(10000);f.report('member_a','paused');f.begin('two','الثانية');assert.equal(f.analytics.perMember('member_a').currentSeconds,0);assert.equal(f.analytics.summary().current.unique,0);
  f.report();f.advance(7000);f.report('member_a','paused');const member=f.analytics.perMember('member_a');assert.equal(member.totalSeconds,17);assert.equal(member.currentSeconds,7);assert.deepEqual(member.sessions.map(value=>value.broadcastTitle),['الأولى','الثانية']);
  f.analytics.endBroadcast();f.advance(10000);assert.equal(f.report(),false);assert.equal(f.analytics.summary().current.watchSeconds,7);assert.equal(f.analytics.beginBroadcast({id:'two'}),false);f.report();f.advance(3000);f.report('member_a','paused');assert.equal(f.analytics.summary().current.watchSeconds,10);
 }finally{await f.analytics.close();}
});

test('analytics retain only counters and sanitized titles, never report or credential/device fields',async()=>{
 const f=fixture();try{
  f.begin('safe','عنوان https://private.invalid/video?token=SECRET');f.analytics.report({id:'member_a',token:'TOKEN',ip:'1.2.3.4',location:{latitude:12}},{state:'playing',ip:'8.8.8.8',clientInfo:{device:'PRIVATE'},location:{latitude:22},duration:1e12});f.advance(1000);f.report('member_a','paused');await f.analytics.flush();
  const serialized=JSON.stringify(f.state.watchAnalytics);assert.doesNotMatch(serialized,/SECRET|TOKEN|private\.invalid|1\.2\.3\.4|8\.8\.8\.8|latitude|clientInfo|PRIVATE|duration/);assert.equal(f.analytics.perMember('member_a').sessions[0].broadcastTitle,'عنوان');
  assert.throws(()=>f.analytics.beginBroadcast({id:'https://secret.invalid/key'}));
 }finally{await f.analytics.close();}
});

test('day retention31, sessions20, members1000 and active30 stay bounded',async()=>{
 const state=initial();state.members=Array.from({length:1001},(_,index)=>({id:'m_'+index}));const f=fixture({state});try{
  f.begin();for(let index=0;index<1001;index++)f.report('m_'+index);assert.deepEqual(f.analytics.stats(),{members:1000,days:1,active:30,persistenceError:false});assert.equal(f.analytics.summary().total.unique,1000);
  for(let index=0;index<40;index++){f.advance(86400000);f.report('m_0');f.advance(2000);f.report('m_0','paused');}
  assert.equal(f.analytics.stats().days,31);assert.equal(Object.keys(f.state.watchAnalytics.members.m_0.days).length,31);assert.equal(f.analytics.perMember('m_0').sessions.length,20);assert.equal(f.analytics.perMember('m_0').totalSeconds,80);assert.equal(f.analytics.summary().total.unique,1000);
 }finally{await f.analytics.close();}
});

test('persistence is batched, explicit flush is durable, and a failed save can retry',async()=>{
 let fail=true;const f=fixture({persist:async()=>{if(fail)throw Error('disk unavailable');},flushMs:20});try{
  f.begin();for(let index=0;index<10;index++){f.report();f.advance(1000);}assert.equal(f.writes,0);await assert.rejects(f.analytics.flush(),/disk/);assert.equal(f.analytics.stats().persistenceError,true);
  fail=false;await f.analytics.flush();assert.equal(f.analytics.stats().persistenceError,false);const savedCount=f.writes;await f.analytics.flush();assert.equal(f.writes,savedCount);
  f.advance(1000);f.report('member_a','paused');await new Promise(resolve=>setTimeout(resolve,40));assert.ok(f.writes>savedCount);assert.equal(f.saved.watchAnalytics.members.member_a.totalMs,11000);
 }finally{await f.analytics.close();}assert.equal(f.report(),false);
});
