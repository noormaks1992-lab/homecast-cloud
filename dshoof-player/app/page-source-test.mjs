import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {inspectSource,watchCardURL} from './sources.mjs';
const page='https://live.xn----zmcaegc7cl3msazv.com/2026/08/blog-post_526.html?mk=abcdefghijklmnopqrstuv';
const card=watch=>async()=>({response:Readable.from([Buffer.from(JSON.stringify({success:true,watch}))])});
test('recognize only trusted watch-card hosts and reject local inputs',()=>{
 assert.match(watchCardURL(page),/^https:\/\/majed-koora.live\/api\/public\/watch-card/);
 assert.equal(watchCardURL(page.replace('.com/','.com.evil.test/')),null);
 assert.throws(()=>watchCardURL('http://127.0.0.1/?mk=abcdefghijklmnopqrstuv'));
});
test('page resolves fallback media and retains original page for later refresh',async()=>{
 const seen=[];
 const result=await inspectSource(page,{open:card({available:true,match:{home_team:{name:'A'},away_team:{name:'B'}},servers:[{url:'https://example.com/no'},{url:'https://example.com/live.m3u8'}]}),inspect:async url=>{seen.push(url);if(url.endsWith('/no'))throw Error('403');return {url,format:'hls'};}});
 assert.equal(result.sourcePage,page);assert.equal(result.title,'A × B');assert.equal(seen.length,2);assert.equal(result.format,'hls');
});
test('closed and denied sources report failure, never fake successful playback',async()=>{
 await assert.rejects(inspectSource(page,{open:card({available:false}),inspect:()=>assert.fail()}),/غير متاح/);
 await assert.rejects(inspectSource(page,{open:card({available:true,servers:[{url:'https://example.com/video'}]}),inspect:async()=>{throw Error('403')}}),/المزوّد رفض الاتصال \(403\)/);
});
