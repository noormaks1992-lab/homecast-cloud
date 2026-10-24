import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createQuality} from './quality.mjs';
const url='https://example.test/live.m3u8';
const media=n=>`#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:${n}\n#EXTINF:4,\nseg${n}.ts\n`;
test('single-quality live playlists advance without resetting ingest or viewer identity',async()=>{
 let now=0,sequence=1,calls=0;
 const q=createQuality({now:()=>now,open:async u=>{calls++;return {url:u,response:Readable.from([Buffer.from(media(sequence))])};}});
 await q.configure({url,format:'hls'});
 assert.match(await q.playlist(undefined,'https://dshoof.test','viewer-a'),/MEDIA-SEQUENCE:1/);
 sequence=2;now=2000;
 const replies=await Promise.all(['viewer-a','viewer-b'].map(k=>q.playlist(undefined,'https://dshoof.test',k)));
 assert.equal(calls,2);
 for(let i=0;i<replies.length;i++){assert.match(replies[i],/MEDIA-SEQUENCE:2/);assert.match(replies[i],new RegExp('key=viewer-'+(i?'b':'a')));assert.doesNotMatch(replies[i],/example.test/);}
});
test('an old playlist response cannot replace a newly selected channel source',async()=>{
 let release,now=0;
 const q=createQuality({now:()=>now,open:async u=>{if(now)await new Promise(r=>release=r);return {url:u,response:Readable.from([Buffer.from(media(1))])};}});
 await q.configure({url,format:'hls'});now=2000;const old=q.playlist(undefined,'https://dshoof.test','viewer');await Promise.resolve();q.reset(null);release();await assert.rejects(old,/تغير مصدر/);
});

test('relay reconnection and renewed credentials keep existing viewer URLs readable',async()=>{
 let now=0,calls=0,seen=[];
 const q=createQuality({now:()=>now,open:async(u,h)=>{calls++;seen.push(h?.Authorization);return {url:u,response:Object.assign(Readable.from([Buffer.from(u===url?media(1):'#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nchild.ts\n')]),{headers:{},statusCode:200})};}});
 await q.configure({url,format:'hls',headers:{Authorization:'old'}});
 const before=await q.playlist(undefined,'https://dshoof.test','viewer');
 const segment=before.split('\n').find(x=>x.startsWith('https:')),id=new URL(segment).pathname.split('/').at(-1);
 await q.configure({url,format:'hls',headers:{Authorization:'new'}});
 const response={once(){},setHeader(){},end(text){this.text=text;}};
 await q.serve({headers:{}},response,id,'https://dshoof.test','viewer');
 assert.match(response.text,/#EXTM3U/);assert.equal(seen.at(-1),'new');assert.equal(calls,2);
 assert.equal((await q.playlist(undefined,'https://dshoof.test','viewer')).split('\n').find(x=>x.startsWith('https:')),segment);
 q.reset(null);await assert.rejects(q.serve({headers:{}},response,id,'https://dshoof.test','viewer'),/تغير المصدر/);
});
