import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRoom} from './room.mjs';
import {createPro} from './pro.mjs';
import {createVoice} from './voice.mjs';
import {capMaster,parseVideoInfo,epgXML} from './cap.mjs';
const owner={id:'owner',name:'المضيف',owner:true};
test('unique named reactions, visible voters, renamed profiles and restart persistence',async()=>{
 const state={owner:'secret',viewer:'private'},room=createRoom(state,async()=>{});
 const invite=await room.invite({name:'علي'},'https://example.test');const a={id:invite.id,name:'علي'};
 assert.equal(room.react(a,{type:'like'}),true);assert.equal(room.react(a,{type:'like'}),false);
 room.polling(owner,{action:'create',question:'من سيفوز؟',options:['الأول','الثاني','تعادل']});
 room.polling(a,{choice:0});room.polling(a,{choice:2});
 let snap=room.snapshot(a,0);assert.equal(snap.reactions.like,1);assert.deepEqual(snap.reactionNames.like,['علي']);assert.deepEqual(snap.poll.counts,[0,0,1]);assert.deepEqual(snap.poll.voters,[[],[],['علي']]);
 await room.profile(a,{name:'علي العراقي',avatar:'gold'});
 snap=room.snapshot(a,0);assert.deepEqual(snap.reactionNames.like,['علي العراقي']);assert.deepEqual(snap.poll.voters[2],['علي العراقي']);assert.doesNotMatch(JSON.stringify(snap),new RegExp(invite.id));
 const restored=createRoom(JSON.parse(JSON.stringify(state)),async()=>{});assert.equal(restored.react(a,{type:'like'}),false);assert.equal(restored.snapshot(a,0).reactions.like,1);assert.deepEqual(restored.snapshot(a,0).poll.voters[2],['علي العراقي']);
 room.chat(a,{text:'أهلًا'});room.pin(owner,{id:room.snapshot(a,0).messages[0].id});room.clear({});assert.equal(room.snapshot(a,0).pinned,null);
});
test('1080 cap, real input metadata selection, and escaped one-channel EPG',()=>{
 const master='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10000000,RESOLUTION=3840x2160\n4k.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\nhd.m3u8\n';assert.doesNotMatch(capMaster(master,'https://example.test/'),/4k|2160/);assert.match(capMaster(master,'https://example.test/'),/1080/);assert.throws(()=>capMaster(master.split('#EXT-X-STREAM-INF:BANDWIDTH=3000000')[0],'https://example.test/'));
 assert.equal(parseVideoInfo('Stream #0:0: Video: h264, yuv420p, 3840x2160, 50 fps\nStream #0:2: Video: h264, yuv420p, 1920x1080, 25 fps\nOutput #0:').index,2);
 assert.equal(parseVideoInfo('Stream #0:0: Video: h264, yuv420p, 3840x2160, 50 fps'),null);
 const xml=epgXML([{start:Date.now(),end:Date.now()+60000,title:'A < B & C'}]);assert.match(xml,/A &lt; B &amp; C/);assert.equal((xml.match(/<channel /g)||[]).length,1);
});
test('scheduling overlap guard, role boundaries, retired predictions and remote isolation',async()=>{
 const pro=createPro({},async()=>{}),a={id:'a',name:'علي'},b={id:'b',name:'حسن'};
 const start=new Date(Date.now()+60000).toISOString(),end=new Date(Date.now()+120000).toISOString();await pro.schedule({start,end,url:'https://example.test/live.m3u8'});await assert.rejects(pro.schedule({start,end,url:'https://example.test/a.m3u8'}));await assert.rejects(pro.schedule({start,end}));
 await assert.rejects(pro.marker(a,{label:'bad'}));await assert.rejects(pro.sync(a,{enabled:true}));await assert.rejects(pro.drawing(a,{clear:true}));
 assert.equal(pro.predict,undefined);assert.equal(pro.settle,undefined);assert.equal(pro.publicState(a).predictions,undefined);
 const pair=pro.pair(a);pro.remote(b,{code:pair.code,action:'pause'});assert.equal(pro.remote(a,{code:pair.code,action:'read'}).action,'pause');assert.throws(()=>pro.remote(b,{code:pair.code,action:'read'}));assert.throws(()=>pro.remote(a,{code:pair.code,action:'stop-server'}));assert.equal(pro.publicState(a).ai,undefined);
});
test('voice signaling is private to recipients, bounded and revocable',()=>{
 const voice=createVoice(),a={id:'a',connection:'a1',name:'علي'},b={id:'b',connection:'b1',name:'حسن'};voice.join(a);voice.join(b);voice.signal(a,{to:'b1',type:'offer',data:{sdp:'test'}});assert.equal(voice.poll(a,0).signals.length,0);assert.equal(voice.poll(b,0).signals.length,1);assert.throws(()=>voice.mute(a,{id:'b1',muted:true}));voice.mute(owner,{id:'b1',muted:true});assert.equal(voice.poll(b,0).muted,true);voice.revoke('b');assert.throws(()=>voice.poll(b,0));assert.throws(()=>voice.signal(a,{to:'b1',type:'offer',data:{}}));
});

test('ingest chooses one highest rendition below the cap',()=>{const m='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160\n4k.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\nhd.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nlow.m3u8\n';const out=capMaster(m,'https://example.test/',1080,true);assert.match(out,/hd.m3u8/);assert.doesNotMatch(out,/4k.m3u8|low.m3u8/);});
