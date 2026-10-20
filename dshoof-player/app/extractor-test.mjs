import {test} from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';import {extractPageSource,resolveMajedV2} from './sources.mjs';import {pageCandidates} from './page-extractor.mjs';
const response=text=>Readable.from([Buffer.from(text)]);
test('generic extraction finds HTML5, JSON-LD and nested iframe media without running scripts',async()=>{
 for(const html of ['<video><source src="/v/master.m3u8?x=1&amp;y=2"></video>','<script type="application/ld+json">{"contentUrl":"/v/master.m3u8?x=1&y=2"}</script>','<script>player.loadSource("/v/master.m3u8?x=1&y=2");</script>']){
 const r=await extractPageSource('https://pages.example/watch',{open:async u=>({url:u,response:response(html)}),inspect:async(u,h)=>{assert.equal(u,'https://pages.example/v/master.m3u8?x=1&y=2');assert.equal(h.Referer,'https://pages.example/watch');return {url:u,format:'hls'};}});assert.equal(r.sourcePage,'https://pages.example/watch');}
 const r=await extractPageSource('https://pages.example/watch',{open:async u=>({url:u,response:response(u.endsWith('watch')?'<iframe src="/embed"></iframe>':'<video src="/v.mp4"></video>')}),inspect:async(u,h)=>({url:u,format:'auto',headers:h})});assert.equal(r.url,'https://pages.example/v.mp4');
 assert.equal(pageCandidates('<source src="//cdn.example/a.m3u8">','https://pages.example').direct[0],'https://cdn.example/a.m3u8');
});
test('generic extraction bounds cycles and rejects local media before requesting it',async()=>{
 let requests=0,inspections=0;await assert.rejects(extractPageSource('https://pages.example/watch',{open:async u=>{requests++;return {url:u,response:response('<iframe src="/watch"></iframe><source src="http://127.0.0.1/private">')};},inspect:async()=>{inspections++;}}),/لم يمكن استخراج/);assert.equal(requests,1);assert.equal(inspections,0);
});
test('new Majed v2 follows published boot API and keeps temporary token off media requests',async()=>{
 const page='https://player.majed-koora.live/v2/embed.php?id=ch2';let calls=0;
 const open=async(u,h)=>{calls++;if(u===page){assert.equal(h.Referer,'https://match.example/');return {url:u,response:response('<body data-majed-boot="{&quot;channel&quot;:&quot;ch2&quot;,&quot;token&quot;:&quot;private-fixture-token&quot;,&quot;base&quot;:&quot;/v2&quot;}"></body>')};}const api=new URL(u);assert.equal(api.pathname,'/v2/api.php');assert.equal(api.searchParams.get('route'),'play/ch2');assert.equal(api.searchParams.get('t'),'private-fixture-token');return {url:u,response:response(JSON.stringify({servers:[{url:'https://cdn.example/master.m3u8',type:'auto'}]}))};};
 const r=await resolveMajedV2(page,'https://match.example/',{open,inspect:async(u,h)=>{assert.equal(JSON.stringify(h).includes('private-fixture-token'),false);assert.equal(h.Referer,page);return {url:u,format:'hls'};}});assert.equal(r.format,'hls');assert.equal(calls,2);assert.equal(JSON.stringify(r).includes('private-fixture-token'),false);
});
test('new Majed v2 refuses DRM instead of pretending to convert it',async()=>{
 const open=async u=>({url:u,response:response(u.includes('embed.php')?`<body data-majed-boot='{"channel":"ch2","token":"fixture","base":"/v2"}'>`:JSON.stringify({servers:[{url:'https://cdn.example/a.m3u8',drm:{widevine:{licenseUrl:'https://license.example'}}}]}))});let called=false;await assert.rejects(resolveMajedV2('https://player.majed-koora.live/v2/embed.php?id=ch2','https://match.example/',{open,inspect:async()=>{called=true;}}),/DRM/);assert.equal(called,false);
});
