import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {discoverMajedServers,inspectSource} from './sources.mjs';

const page='https://live.xn----zmcaegc7cl3msazv.com/post?mk=abcdefghijklmnopqrstuv';
const servers=[{id:'one',name:'سيرفر 1',quality:'تود رسمي',url:'https://example.com/one.css',is_default:true},{id:'two',name:'سيرفر 2',quality:'4k حقيقي',url:'https://example.com/two.css'},{id:'off',url:'https://example.com/off',enabled:false}];
const card=(list=servers)=>async()=>({response:Readable.from([Buffer.from(JSON.stringify({success:true,watch:{available:true,servers:list,match:{home_team:{name:'A'},away_team:{name:'B'}}}}))])});
test('discovery exposes labels and stable IDs but not signed media URLs',async()=>{
 const result=await discoverMajedServers(page,{open:card()});
 assert.equal(result.servers.length,2);assert.equal(result.servers[1].quality,'4k حقيقي');assert.equal(result.servers[0].isDefault,true);
 assert.ok(result.servers.every(x=>!Object.hasOwn(x,'url')));assert.equal(result.title,'A × B');
});
test('choosing the second server resolves only that source and preserves the choice',async()=>{
 const seen=[];const result=await inspectSource(page,{open:card(),serverId:'two',inspect:async url=>{seen.push(url);return {url,format:'hls'};}});
 assert.deepEqual(seen,['https://example.com/two.css']);assert.equal(result.serverId,'two');assert.equal(result.sourcePage,page);assert.equal(result.serverName,'سيرفر 2 · 4k حقيقي');
});
test('a selected server cannot silently fall back, disappear or be disabled',async()=>{
 const seen=[];await assert.rejects(inspectSource(page,{open:card(),serverId:'two',inspect:async url=>{seen.push(url);throw Error('403');}}),/لم يتم التبديل/);
 assert.deepEqual(seen,['https://example.com/two.css']);
 for(const id of ['missing','off'])await assert.rejects(inspectSource(page,{open:card(),serverId:id,inspect:()=>assert.fail()}),/لم يعد متاحًا/);
});
test('automatic selection keeps the previous fallback behavior',async()=>{
 const result=await inspectSource(page,{open:card(),inspect:async url=>{if(url.endsWith('/one.css'))throw Error('unavailable');return {url,format:'hls'};}});
 assert.equal(result.url,'https://example.com/two.css');assert.equal(result.serverId,undefined);
});
test('server IDs without provider IDs remain stable after reordering',async()=>{
 const first=await discoverMajedServers(page,{open:card([{name:'A',url:'https://example.com/a'},{name:'B',url:'https://example.com/b'}])});
 const reverse=await discoverMajedServers(page,{open:card([{name:'B',url:'https://example.com/b'},{name:'A',url:'https://example.com/a'}])});
 assert.equal(first.servers[0].id,reverse.servers[1].id);
});
test('automatic source failure preserves each cause without exposing provider URLs or tokens',async()=>{
 await assert.rejects(inspectSource(page,{open:card(),inspect:async url=>{
  if(url.endsWith('/one.css'))throw Error('لم يصدر المزوّد تصريحًا للمشغّل https://provider.example/?token=SECRET');
  throw Object.assign(Error('getaddrinfo EAI_AGAIN private-host'),{code:'EAI_AGAIN'});
 }}),error=>{
  assert.match(error.message,/المشغّل 1: لم يصدر المزوّد تصريحًا/);
  assert.match(error.message,/المشغّل 2:.*DNS/);
  assert.doesNotMatch(error.message,/SECRET|provider.example|private-host|قد تكون صفحات/);
  return true;
 });
});
test('unknown player failure is not misreported as HTML and does not leak secrets',async()=>{
 await assert.rejects(inspectSource(page,{open:card(),serverId:'one',inspect:async()=>{throw Error('secret authorization payload');}}),error=>{
  assert.match(error.message,/يلزم فحص سجل الاستضافة/);assert.match(error.message,/لم يتم التبديل/);
  assert.doesNotMatch(error.message,/secret|authorization|صفحات/);return true;
 });
});
