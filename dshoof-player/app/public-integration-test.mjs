import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const digest=value=>createHash('sha256').update(value).digest('hex');
async function unusedPort(){const server=http.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function bounded(promise,ms=20000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out waiting for a room event')),ms);})]);}finally{clearTimeout(timer);}}
function eventReader(response){
 const reader=response.body.getReader(),decode=new TextDecoder();let pending='';
 return {reader,async next(){
  for(;;){const end=pending.indexOf('\n\n');if(end>=0){const frame=pending.slice(0,end);pending=pending.slice(end+2);const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(data)return JSON.parse(data);continue;}
   const chunk=await bounded(reader.read());if(chunk.done)return null;pending+=decode.decode(chunk.value,{stream:true}).replace(/\r\n/g,'\n');assert.ok(pending.length<250000,'SSE output must remain bounded');
  }
 }};
}

test('public registration preserves owner authority, private sources, cookie media and live room revocation',{timeout:45000},async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dshoof-public-http-')),port=await unusedPort(),origin='http://127.0.0.1:'+port;
 const ownerKey='fixture-owner-'+ 'a'.repeat(48),viewerKey='fixture-viewer-'+ 'b'.repeat(48),alias='FixtureM3u12',moderatorKey='FixtureMod12',observerKey='FixtureObs12';
 const privateSource='http://127.0.0.1/private-source?token=fixture-source-secret',privateBackup='http://127.0.0.1/private-backup?token=fixture-backup-secret';
 const privateValues=[ownerKey,viewerKey,alias,privateSource,privateBackup,'fixture-audit-secret'];
 const initial={owner:ownerKey,viewer:viewerKey,playlistAlias:alias,selection:{kind:'url',url:privateSource,title:'مباراة الاختبار',updatedAt:Date.now()},history:[{kind:'code',code:'12345678901234567890'}],invites:[{id:'fixture-moderator',slug:moderatorKey,hash:digest(moderatorKey),name:'مشرف الاختبار',role:'moderator',devices:3,expires:Date.now()+3600000},{id:'fixture-observer',slug:observerKey,hash:digest(observerKey),name:'مراقب الاختبار',role:'observer',devices:1,expires:Date.now()+3600000}],pro:{backup:{kind:'url',url:privateBackup},audit:[{id:'private-audit',actor:'fixture-audit-secret',at:Date.now()}],schedules:[{id:'future',title:'موعد خاص',start:Date.now()+3600000,end:Date.now()+7200000,source:{kind:'url',url:privateSource}}]}};
 let child,logs='',events,streamController;
 const request=(route,options={})=>fetch(new URL(route,origin),{redirect:'manual',signal:AbortSignal.timeout(5000),...options});
 const post=(route,value,cookie='')=>request(route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(value)});
 const status=async(cookie='')=>{const response=await request('/api/status',{headers:{Cookie:cookie}});assert.equal(response.status,200);return response.json();};
 const assertPrivate=value=>{const text=JSON.stringify(value);for(const secret of privateValues)assert.ok(!text.includes(secret),'public response included a private installation value');};
 try{
  await mkdir(path.join(directory,'media'));await writeFile(path.join(directory,'state.json'),JSON.stringify(initial));
  child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,DATA_DIR:directory,SERVER_PORT:String(port),PORT:String(port),PUBLIC_URL:origin,FFMPEG_PATH:'ffmpeg',TRUST_PROXY_HOPS:'0'},stdio:['ignore','pipe','pipe']});
  for(const output of [child.stdout,child.stderr])output.on('data',part=>{logs=(logs+part).slice(-16000);});
  let ready=false;for(let attempt=0;attempt<100;attempt++){assert.equal(child.exitCode,null,'fixture server exited');try{if((await request('/healthz')).ok){ready=true;break;}}catch{}await pause(50);}assert.ok(ready,'fixture server started');
  let memberCookie='',memberId='',ownerCookie='';
  await t.test('one public URL requires first registration and exposes no installation credentials',async()=>{
   const response=await request('/');assert.equal(response.status,200);assert.match(response.headers.get('permissions-policy'),/geolocation=\(self\)/);assert.match(response.headers.get('permissions-policy'),/microphone=\(\)/);assert.doesNotMatch(await response.text(),/<script\b[^>]*src=["'][^"']*voice\.js/);
   const anonymous=await status();assert.equal(anonymous.authorized,false);assert.equal(anonymous.authenticated,false);assert.equal(anonymous.registrationRequired,true);assert.equal(new URL(anonymous.publicRoomURL,origin).href,origin+'/');assertPrivate(anonymous);assert.equal(Object.hasOwn(anonymous,'analytics'),false);
   for(const route of ['/live/dshoof.m3u8','/quality/auto.m3u8','/api/pro','/api/export','/api/events'])assert.equal((await request(route)).status,403,route);
   const crossSite=await request('/api/join',{method:'POST',headers:{Origin:'https://untrusted.invalid','Content-Type':'application/json'},body:JSON.stringify({username:'forged_join',name:'طلب خارجي'})});assert.equal(crossSite.status,403);
   assert.equal((await post('/api/privacy',{device:false,location:false})).status,403);
  });
  await t.test('public membership ignores privilege fields and protects username recovery',async()=>{
   const joined=await post('/api/join',{username:'viewer_two',name:'المشاهد الثاني',avatar:'blue',owner:true,role:'owner',id:'owner',key:viewerKey});assert.equal(joined.status,200);
   const header=joined.headers.get('set-cookie');assert.ok(header?.includes('dshoof_member='));assert.ok(/HttpOnly/i.test(header));assert.ok(/SameSite=(?:Lax|Strict)/i.test(header));memberCookie=header.split(';')[0];
   const payload=await joined.json();assert.equal(payload.ok,true);assertPrivate(payload);assert.ok(!JSON.stringify(payload).includes(memberCookie.split('=')[1]),'membership secret belongs only in HttpOnly cookie');
   const s=await status(memberCookie);assert.equal(s.authorized,true);assert.equal(s.authenticated,true);assert.equal(s.registrationRequired,false);assert.equal(s.canControl,false);assert.equal(s.profile.username,'viewer_two');assertPrivate(s);assert.deepEqual(s.room.roster,[]);assert.equal(s.room.online,null);assert.equal(Object.hasOwn(s,'analytics'),false);
   const saved=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));const record=saved.members.find(item=>item.username==='viewer_two');assert.ok(record);memberId=record.id;assert.notEqual(record.id,'owner');assert.notEqual(record.role,'owner');
   assert.ok(!JSON.stringify(record).includes(memberCookie.split('=')[1]),'persistent member record must not store the raw cookie credential');
   for(const route of ['/api/settings','/api/select','/api/stop','/api/invites','/api/revoke','/api/stream-profile'])assert.equal((await post(route,{chatEnabled:false,role:'owner',profile:'economy360'},memberCookie)).status,403,route);
   const forged=await status('dshoof_owner='+ownerKey+'; dshoof_member='+viewerKey);assert.equal(forged.canControl,false);assert.equal(forged.authorized,false);
   await pause(1100);const stolen=await post('/api/join',{username:'viewer_two',name:'اسم بديل'});assert.ok([400,403,409].includes(stolen.status),'username alone must not recover another member credential');assert.equal(stolen.headers.get('set-cookie'),null);
   assert.equal((await status(memberCookie)).profile.name,'المشاهد الثاني');
  });
  await t.test('member media uses only its HttpOnly cookie; original receiver links remain valid',async()=>{
   await writeFile(path.join(directory,'media','segment_1000.ts'),Buffer.alloc(188,0x47));await writeFile(path.join(directory,'media','dshoof.m3u8'),'#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:1000\n#EXTINF:4,\nsegment_1000.ts\n');
   const response=await request('/live/dshoof.m3u8',{headers:{Cookie:memberCookie}});assert.equal(response.status,200);const manifest=await response.text();assertPrivate(manifest);const line=manifest.split('\n').find(item=>item.startsWith('http'));assert.ok(line);assert.equal(new URL(line).searchParams.has('key'),false,'public HLS must not disclose a permanent or member bearer credential');
   assert.equal((await request(line)).status,403);assert.equal((await request(line,{headers:{Cookie:memberCookie}})).status,200);
   assert.equal((await request('/dshoof.m3u',{headers:{Cookie:memberCookie}})).status,403,'public members must not export the permanent receiver identity');
   const receiver=await request('/p/'+alias+'.m3u');assert.equal(receiver.status,200);assert.match(await receiver.text(),/\/live\/dshoof\.m3u8/);
   assert.equal((await request('/p/'+alias+'.m3u',{headers:{Cookie:memberCookie}})).status,200,'a public browser cookie must not invalidate an explicit legacy receiver link');
   const legacy=await request('/dshoof.m3u?key='+viewerKey);assert.equal(legacy.status,200);
  });
  await t.test('public pro data stays private and voice endpoints have been removed',async()=>{
   const response=await request('/api/pro',{headers:{Cookie:memberCookie}});assert.equal(response.status,200);const data=await response.json();assertPrivate(data);for(const key of ['audit','backup','schedules','metrics','analytics'])assert.equal(Object.hasOwn(data,key),false,key);
   const observerResponse=await request('/api/pro',{headers:{Cookie:'dshoof_viewer='+observerKey+'; dshoof_device=fixture-observer-device'}});assert.equal(observerResponse.status,200);const observer=await observerResponse.json();assert.equal(Object.hasOwn(observer,'metrics'),false,'legacy observer must not expose owner-only presence or device reports');assertPrivate(observer);
   assert.equal((await request('/voice.js')).status,404);assert.equal((await post('/api/pro/voice-join',{},memberCookie)).status,404);
   const retired=await(await post('/api/pro/voice-poll',{},memberCookie)).json();assert.equal(retired.muted,true);assert.deepEqual(retired.peers,[]);assert.deepEqual(retired.signals,[]);
  });
  await t.test('owner alone toggles chat; personalized SSE and acknowledgements agree',async()=>{
   const login=await post('/api/login',{key:ownerKey});assert.equal(login.status,200);ownerCookie=login.headers.get('set-cookie').split(';')[0];
   streamController=new AbortController();const response=await request('/api/events',{headers:{Cookie:memberCookie},signal:streamController.signal});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);events=eventReader(response);
   const first=await events.next();assert.ok(first?.room);assert.equal(first.room.name,'المشاهد الثاني');assertPrivate(first);assert.doesNotMatch(JSON.stringify(first),/"(?:analytics|watchSeconds|currentSeconds|totalSeconds|sessions)"/);
   const settings=await post('/api/settings',{chatEnabled:false},ownerCookie);assert.equal(settings.status,200);assert.equal((await settings.json()).room.settings.chatEnabled,false);
   const moderator='dshoof_viewer='+moderatorKey+'; dshoof_device=fixture-moderator-device';assert.equal((await post('/api/settings',{chatEnabled:true},moderator)).status,403);
   assert.notEqual((await post('/api/chat',{text:'رسالة أثناء الإغلاق'},memberCookie)).status,200);
   let update;for(let attempt=0;attempt<8;attempt++){update=await events.next();if(update?.room?.settings?.chatEnabled===false)break;}assert.equal(update.room.settings.chatEnabled,false);assertPrivate(update);
   const reopen=await post('/api/settings',{chatEnabled:true},ownerCookie);assert.equal(reopen.status,200);
   const chat=await post('/api/chat',{text:'رسالة عامة محفوظة',role:'owner',owner:true},memberCookie);assert.equal(chat.status,200);const acknowledgement=await chat.json();assert.ok(acknowledgement.room);const message=acknowledgement.room.messages.find(item=>item.text==='رسالة عامة محفوظة');assert.ok(message);assert.equal(message.owner,false);assert.equal(message.name,'المشاهد الثاني');assertPrivate(acknowledgement);
  });
  await t.test('device sharing reaches only the owner, ignores forged IP and stays out of persistent state',async()=>{
   assert.equal((await request('/live/dshoof.m3u8',{headers:{Cookie:memberCookie}})).status,200);
   const clientInfo={shared:true,ip:'203.0.113.42',screen:{width:1920,height:1080,pixelRatio:2},battery:{level:67.5,charging:true},network:{effectiveType:'4g',downlink:4.2,rtt:160,saveData:false,type:'wifi'},timezone:'Asia/Baghdad',locale:'ar-IQ',subscription:'fiber',location:{latitude:12.345678,longitude:67.891234,accuracy:15}};
   const response=await request('/api/report',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:memberCookie,'X-Forwarded-For':'198.51.100.7'},body:JSON.stringify({state:'playing',buffer:12,ip:'203.0.113.99',clientInfo})});assert.equal(response.status,200);
   const ownerStatus=await status(ownerCookie),card=(ownerStatus.members||ownerStatus.invites).find(item=>item.id===memberId);assert.ok(card);const detail=card.connections.find(item=>item.info)?.info||card.info;assert.ok(detail,'owner receives the active connection details');assert.equal(detail.ipSource,'socket');assert.ok(detail.ip.includes('127.0.0.1'));assert.notEqual(detail.ip,clientInfo.ip);assert.equal(detail.battery.level,67.5);assert.equal(detail.network.downlink,4.2);assert.equal(detail.subscription,'fiber');assert.ok(Math.abs(detail.location.latitude-12.346)<0.002);assert.ok(Math.abs(detail.location.longitude-67.891)<0.002);
   assert.ok(ownerStatus.analytics,'viewing statistics belong to the owner response');for(const period of ['current','day','total']){assert.ok(Number.isSafeInteger(ownerStatus.analytics[period].unique));assert.ok(Number.isSafeInteger(ownerStatus.analytics[period].watchSeconds));}assert.equal(ownerStatus.analytics.day.timeZone,'Asia/Baghdad');assert.equal(ownerStatus.analytics.total.unique,1,'only the registered member reporting playing contributes');assert.ok(card.analytics);assert.ok(Array.isArray(card.analytics.sessions));assert.ok(card.analytics.sessions.length<=20);
   const publicStatus=await status(memberCookie);assert.deepEqual(publicStatus.room.roster,[]);assert.equal(publicStatus.room.online,null);assert.equal(Object.hasOwn(publicStatus,'members'),false);assert.equal(Object.hasOwn(publicStatus,'invites'),false);assert.doesNotMatch(JSON.stringify(publicStatus),/"(?:clientInfo|ipSource|battery|location|subscription|analytics|watchSeconds|totalSeconds|sessions)"/);
   const publicPro=await(await request('/api/pro',{headers:{Cookie:memberCookie}})).json();assert.doesNotMatch(JSON.stringify(publicPro),/"(?:clientInfo|ipSource|battery|location|subscription|metrics|analytics|watchSeconds|totalSeconds|sessions)"/);
   const observer=await(await request('/api/status',{headers:{Cookie:'dshoof_viewer='+observerKey+'; dshoof_device=fixture-observer-device'}})).json();assert.deepEqual(observer.room.roster,[]);assert.equal(observer.room.online,null);assert.doesNotMatch(JSON.stringify(observer),/"(?:clientInfo|ipSource|battery|location|subscription|analytics|watchSeconds|totalSeconds|sessions)"/);
   // A chat event after sharing must not accidentally broadcast an owner snapshot.
   const update=await post('/api/settings',{announcement:'اختبار الخصوصية'},ownerCookie);assert.equal(update.status,200);let event;for(let attempt=0;attempt<8;attempt++){event=await events.next();assert.ok(event);assert.doesNotMatch(JSON.stringify(event),/"(?:clientInfo|ipSource|battery|location|subscription|analytics|watchSeconds|totalSeconds|sessions)"/);assert.deepEqual(event.room.roster,[]);if(event.room.settings.announcement==='اختبار الخصوصية')break;}assert.equal(event.room.settings.announcement,'اختبار الخصوصية');
   const saved=await readFile(path.join(directory,'state.json'),'utf8');assert.doesNotMatch(saved,/"(?:clientInfo|ipSource)"/,'device and location details must not enter state.json');
   // Privacy removal must bypass the normal five-second reporting allowance.
   assert.equal((await post('/api/privacy',{location:false},memberCookie)).status,200);let cleared=await status(ownerCookie),after=(cleared.members||cleared.invites).find(item=>item.id===memberId);assert.equal(Object.hasOwn(after.info,'location'),false);assert.ok(after.info.battery,'location-only removal preserves the other shared device details');
   assert.equal((await post('/api/privacy',{device:false},memberCookie)).status,200);cleared=await status(ownerCookie);after=(cleared.members||cleared.invites).find(item=>item.id===memberId);assert.equal(after.info.shared,false);for(const key of ['battery','location','network','subscription','screen','timezone','locale'])assert.equal(Object.hasOwn(after.info,key),false,'opting out immediately clears optional '+key);
   // Simulate an older report arriving after removal and after rate limiting ends.
   await pause(5100);assert.equal((await post('/api/report',{state:'playing',clientInfo},memberCookie)).status,200);cleared=await status(ownerCookie);after=(cleared.members||cleared.invites).find(item=>item.id===memberId);assert.equal(after.info.shared,false);for(const key of ['battery','location','network','subscription','screen','timezone','locale'])assert.equal(Object.hasOwn(after.info,key),false,'a delayed report must not restore removed '+key);assert.ok(after.analytics.totalSeconds>=5,'existing server-timed interval contributes approximate viewing duration');assert.ok(cleared.analytics.total.watchSeconds>=5);assert.equal(cleared.analytics.current.unique,1);assert.equal(cleared.analytics.day.unique,1);assert.equal(cleared.analytics.total.unique,1);assert.ok(after.analytics.sessions.some(session=>session.broadcastTitle==='مباراة الاختبار'&&session.seconds>=5));
  });
  await t.test('revoking membership ends its event stream and media access without rotating legacy tokens',async()=>{
   assert.equal((await post('/api/revoke',{id:memberId},ownerCookie)).status,200);assert.equal((await status(memberCookie)).authorized,false);assert.equal((await request('/live/dshoof.m3u8',{headers:{Cookie:memberCookie}})).status,403);
   let ended=false;for(let attempt=0;attempt<12;attempt++){if(await events.next()===null){ended=true;break;}}assert.equal(ended,true,'revoked member SSE must close promptly');
   assert.equal((await request('/p/'+alias+'.m3u')).status,200);const saved=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));assert.equal(saved.owner,ownerKey);assert.equal(saved.viewer,viewerKey);assert.equal(saved.playlistAlias,alias);
  });
  await t.test('only the owner can edit or restore accounts while delegated helpers retain restricted permissions',async()=>{
   const update={action:'update',id:memberId,username:'updated_viewer',name:'عضو معدل',avatar:'green',role:'stream'};
   assert.equal((await post('/api/members',update)).status,403);
   assert.equal((await post('/api/members',update,ownerCookie)).status,200);
   assert.equal((await post('/api/members',{action:'restore',id:memberId},ownerCookie)).status,200);
   const restored=await status(memberCookie);assert.equal(restored.authorized,true);assert.equal(restored.profile.username,'updated_viewer');assert.equal(restored.room.role,'stream');assert.equal(restored.canControl,false);assert.equal(Object.hasOwn(restored,'members'),false);assert.equal(Object.hasOwn(restored,'analytics'),false);
   assert.equal((await post('/api/members',{action:'update',id:memberId,role:'viewer'},memberCookie)).status,403);
   assert.equal((await post('/api/settings',{chatEnabled:false},memberCookie)).status,403);
   assert.equal((await post('/api/members',{action:'update',id:memberId,role:'owner'},ownerCookie)).status,400);
   assert.equal((await post('/api/stop',{},memberCookie)).status,200);
   const saved=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));assert.equal(saved.owner,ownerKey);assert.equal(saved.viewer,viewerKey);assert.equal(saved.playlistAlias,alias);
  });
 }catch(error){for(const value of privateValues)logs=logs.split(value).join('[private-fixture]');error.message+='\n'+logs;throw error;}
 finally{
  streamController?.abort();await events?.reader.cancel().catch(()=>{});
  if(child&&child.exitCode===null){const closed=once(child,'close');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);timer.unref();try{await closed;}finally{clearTimeout(timer);}}
  await rm(directory,{recursive:true,force:true});
 }
});

