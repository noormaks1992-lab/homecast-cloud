import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash,createCipheriv,randomBytes} from 'node:crypto';import {Readable} from 'node:stream';import {decodePlayerStream,resolveMajedPlayer} from './sources.mjs';
const page='https://live.xn----zmcaegc7cl3msazv.com/post?mk=abcdefghijklmnopqrstuv',player='https://player.majed-koora.live/?player=hls&channel=ch1',auth='test-authorization';
function envelope(config){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',createHash('sha256').update('majed-player-stream-v1|'+auth).digest(),iv);c.setAAD(Buffer.from('majed-player-stream-v1'));const data=Buffer.concat([c.update(JSON.stringify(config)),c.final()]);return {v:1,alg:'A256GCM',iv:iv.toString('base64url'),tag:c.getAuthTag().toString('base64url'),data:data.toString('base64url')};}
const response=s=>Readable.from([Buffer.from(s)]);
test('published player envelope requires matching authorization and integrity',()=>{const x=envelope({url:'https://example.com/live.m3u8'});assert.equal(decodePlayerStream(x,auth).url,'https://example.com/live.m3u8');assert.throws(()=>decodePlayerStream(x,'wrong'));assert.throws(()=>decodePlayerStream({...x,tag:'AAAA'},auth));});
test('embedded player uses page context and keeps player authorization off media requests',async()=>{let calls=0;const s=await resolveMajedPlayer(player,page,{open:async(url,headers)=>{calls++;if(calls===1){assert.equal(headers.Referer,page);return {url:player,response:response('<meta name="majed-player-authorization" content="'+auth+'">')}}assert.equal(headers['X-Player-Authorization'],auth);assert.equal(new URL(url).searchParams.get('id'),'ch1');return {response:response(JSON.stringify(envelope({url:'https://example.com/live.m3u8',format:'hls',drm:{enabled:false}})))}} ,inspect:async(url,headers)=>{assert.equal(headers['X-Player-Authorization'],undefined);assert.equal(headers.Referer,player);return {url,format:'hls'}}});assert.equal(calls,2);assert.equal(s.headers['User-Agent'],'DshoofPlayer/3.0');});
test('DRM streams are rejected before media request',async()=>{let calls=0;await assert.rejects(resolveMajedPlayer(player,page,{open:async()=>({response:response(++calls===1?'<meta name="majed-player-authorization" content="'+auth+'">':JSON.stringify(envelope({url:'https://example.com/live.m3u8',drm:{enabled:true}})))}),inspect:()=>assert.fail()}),/DRM/)});
test('valid metadata whitespace, attribute order and unquoted attributes do not break extraction',async()=>{
 for(const html of [
  `<meta content = '${auth}' name = 'majed-player-authorization'>`,
  `<META\n NAME = "majed-player-authorization"\n CONTENT = "${auth}">`,
  `<meta name=majed-player-authorization content=${auth}>`,
  `<!-- <meta name="majed-player-authorization" content="wrong"> --><script>const sample='<meta name="majed-player-authorization" content="wrong">';</script><meta name="majed-player-authorization" content="${auth}">`,
  `<meta data-name="majed-player-authorization" content="wrong"><meta name="majed-player-authorization" content="${auth}">`
 ]){let calls=0;const result=await resolveMajedPlayer(player,page,{open:async(url,headers)=>{
   if(++calls===1)return {url:player,response:response(html)};
   assert.equal(headers['X-Player-Authorization'],auth);
   return {response:response(JSON.stringify(envelope({url:'https://example.com/live.m3u8',format:'hls'})))};
  },inspect:async url=>({url,format:'hls'})});assert.equal(result.format,'hls');
 }
});
test('missing or invalid metadata does not proceed to the stream API',async()=>{
 for(const html of [
  '<meta data-name="majed-player-authorization" content="wrong">',
  '<meta name="majed-player-authorization" content="bad\r\nheader">',
  '<meta name="majed-player-authorization" content="'+'a'.repeat(8193)+'">'
 ]){let calls=0;await assert.rejects(resolveMajedPlayer(player,page,{open:async()=>{calls++;return {response:response(html)};},inspect:()=>assert.fail()}),/تصريحًا/);assert.equal(calls,1);}
});
