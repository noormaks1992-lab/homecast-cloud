import {test} from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';
import {createQuality,filterMaster} from './quality.mjs';
const root='https://source.example/master.m3u8',master='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n1080.m3u8\n';
const media='#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:8,\nsegment.ts\n';
const response=(text,url)=>({url,response:Object.assign(Readable.from([Buffer.from(text)]),{headers:{},statusCode:200})});
const id=text=>new URL(text.split('\n').find(l=>l.startsWith('http'))).pathname.split('/').at(-1);
function res(){return {headers:{},once(){},setHeader(k,v){this.headers[k]=v;},end(t){this.text=t;}};}
test('many viewers share one poll, half TARGETDURATION cache, credentials rewritten per viewer',async()=>{
 let now=0,calls=0;const q=createQuality({now:()=>now,open:async url=>{calls++;await new Promise(r=>setTimeout(r,5));return response(url===root?master:media,url);}});
 await q.configure({url:root,format:'hls',headers:{}});const entry=id(q.masterPlaylist(720,'https://dshoof.test','one'));
 const replies=await Promise.all(Array.from({length:40},async(_,n)=>{const r=res();await q.serve({headers:{}},r,entry,'https://dshoof.test','viewer'+n);return r.text;}));
 assert.equal(calls,2);for(let n=0;n<40;n++){assert.match(replies[n],new RegExp('key=viewer'+n+'(?:\\n|$)'));assert.doesNotMatch(replies[n],/source.example/);}
 now=3999;await q.serve({headers:{}},res(),entry,'https://dshoof.test','x');assert.equal(calls,2);
 now=4000;await q.serve({headers:{}},res(),entry,'https://dshoof.test','x');assert.equal(calls,3);
});
test('429 waits for Retry-After and does not fan out retries across viewers',async()=>{
 let now=0,calls=0,fail=true;const q=createQuality({now:()=>now,open:async url=>{calls++;if(url!==root&&fail)throw Object.assign(Error('rate limited'),{statusCode:429,retryAfterMs:9000});return response(url===root?master:media,url);}});
 await q.configure({url:root,format:'hls',headers:{}});const entry=id(q.masterPlaylist(720,'https://dshoof.test','x'));
 await assert.rejects(q.serve({headers:{}},res(),entry,'https://dshoof.test','x'));assert.equal(calls,2);fail=false;
 now=8999;await assert.rejects(q.serve({headers:{}},res(),entry,'https://dshoof.test','x'));assert.equal(calls,2);
 now=9000;await q.serve({headers:{}},res(),entry,'https://dshoof.test','x');assert.equal(calls,3);
});
test('fixed quality remains fixed through nested masters and duplicate upstream URI labels',async()=>{
 const duplicate=master.replace('1080.m3u8','720.m3u8'),filtered=filterMaster(duplicate,root,720);assert.equal((filtered.match(/#EXT-X-STREAM-INF:/g)||[]).length,1);assert.doesNotMatch(filtered,/1920x1080/);
 const q=createQuality({open:async url=>response(url===root?master:master.replace('720.m3u8','leaf720.m3u8').replace('1080.m3u8','leaf1080.m3u8'),url)});
 await q.configure({url:root,format:'hls',headers:{}});const r=res();await q.serve({headers:{}},r,id(q.masterPlaylist(720,'https://dshoof.test','x')),'https://dshoof.test','x');assert.equal((r.text.match(/#EXT-X-STREAM-INF:/g)||[]).length,1);assert.doesNotMatch(r.text,/1920x1080/);
 q.reset(null);await assert.rejects(q.serve({headers:{}},res(),id(r.text),'https://dshoof.test','x'));
});
