import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {openPublic,readLimited,rewriteInput} from './sources.mjs';
export function attributes(line){return Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(x=>[x[1],x[2].replace(/^"|"$/g,'' )]));}
export function variants(text,base){const lines=text.split(/\r?\n/),out=[];for(let i=0;i<lines.length;i++){if(!lines[i].startsWith('#EXT-X-STREAM-INF:'))continue;const a=attributes(lines[i]),size=(a.RESOLUTION||'').match(/^(\d+)x(\d+)$/);let n=i+1;while(n<lines.length&&!lines[n].trim())n++;if(!lines[n]||lines[n].startsWith('#'))continue;out.push({line:i,uriLine:n,url:new URL(lines[n].trim(),base).href,height:size?Number(size[2]):0,width:size?Number(size[1]):0,bandwidth:Number(a.BANDWIDTH)||0,codecs:a.CODECS||'',audio:a.AUDIO});}return out;}
export function qualityList(items){const heights=[...new Set(items.map(x=>x.height).filter(Boolean))].sort((a,b)=>b-a);return heights.map(height=>({id:height+'p',height,label:height+'p'}));}
export function bestVariant(items,height){return items.filter(x=>height===undefined||x.height===height).sort((a,b)=>b.height-a.height||b.bandwidth-a.bandwidth)[0];}
export function channelList(title,entries){const clean=String(title||'دشوف بلاير').replace(/[\r\n\u0000-\u001f]/g,' ').slice(0,120);return '#EXTM3U\n'+entries.map(e=>'#EXTINF:-1 group-title="دشوف",'+clean+' — '+e.label+'\n'+e.url+'\n').join('');}
export function filterMaster(text,base,height){
 const all=variants(text,base);if(!all.length)return text;
 const eligible=all.filter(v=>v.height>0&&v.height<=1080),target=height===undefined?null:bestVariant(eligible,height);
 if(height!==undefined&&!target)throw Error('هذه الدقة غير متاحة في المصدر الحالي');
 if(!eligible.length)throw Error('لم يتوفر مسار بدقة معلومة حتى 1080p');
 const removed=new Set(all.filter(v=>!eligible.includes(v)||(target&&v.line!==target.line)).flatMap(v=>[v.line,v.uriLine]));
 // Keep alternate audio/subtitle declarations; media URLs remain authenticated.
 return text.split(/\r?\n/).filter((_,i)=>!removed.has(i)).join('\n');
}
export function createQuality({open=openPublic,now=Date.now}={}){
 let source=null,master=null,items=[],epoch=0;
 const registry=new Map(),pending=new Map(),cache=new Map();let cooldownUntil=0,rateFailures=0;
 function reset(value){epoch++;source=value;master=null;items=[];registry.clear();cache.clear();pending.clear();cooldownUntil=0;rateFailures=0;}
 async function manifest(url){
  const key=epoch+':'+url,old=cache.get(key);if(old&&now()<old.expires)return old.data;
  if(pending.has(key))return pending.get(key);
  if(pending.size>=8)throw Error('طلبات قوائم كثيرة؛ حاول بعد لحظات');
  if(now()<cooldownUntil)throw Error('المصدر طلب الانتظار قبل تحديث القائمة');
  const generation=epoch,headers=source?.headers||{};
  const promise=(async()=>{
   try{
    const opened=await open(url,headers),text=(await readLimited(opened.response)).toString('utf8');
    if(!text.trimStart().startsWith('#EXTM3U'))throw Error('لم يرجع المصدر قائمة HLS');
    const data={text,url:opened.url},duration=Number(text.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1]);
    // HLS polling floor: one shared request per half target duration.
    const ttl=Number.isFinite(duration)&&duration>0?Math.max(250,Math.min(30000,duration*500)):1000;
    if(generation===epoch){rateFailures=0;if(cache.size>=40)cache.delete(cache.keys().next().value);cache.set(key,{expires:now()+ttl,data});}
    return data;
   }catch(e){if(generation===epoch&&e.statusCode===429){rateFailures++;cooldownUntil=now()+Math.max(1000,e.retryAfterMs||Math.min(30000,1000*2**Math.min(rateFailures,5)));}throw e;}
  })();pending.set(key,promise);
  try{return await promise;}finally{pending.delete(key);}
 }
 async function configure(value){
  // Restarting the relay is not a source change. Keep viewer segment IDs valid,
  // including while the provider renews authorization for the same source URL.
  const same=source&&value&&source.url===value.url&&source.format===value.format;
  if(!same)reset(value);
  else {const changed=JSON.stringify(source.headers||{})!==JSON.stringify(value.headers||{});source=value;if(changed)cache.clear();}
  if(value?.format!=='hls'||same&&master)return;
  const generation=epoch,m=await manifest(value.url);if(generation!==epoch)return;master=m;items=variants(m.text,m.url).filter(v=>v.height>0&&v.height<=1080);
 }
 function map(url,base,key,playlist=false,height){
  const id=createHash('sha256').update(epoch+':'+url+':'+String(height??'auto')+':'+playlist).digest('hex').slice(0,24);
  if(!registry.has(id)){if(registry.size>=20000)registry.delete(registry.keys().next().value);registry.set(id,{url,playlist,height});}
  return base+'/quality/media/'+id+(key?'?key='+encodeURIComponent(key):'');
 }
 function rewrite(text,url,base,key,height){
  const filtered=filterMaster(text,url,height),lists=new Set(variants(filtered,url).map(v=>v.url));
  for(const line of filtered.split(/\r?\n/))if(line.startsWith('#EXT-X-MEDIA:')){const a=attributes(line);if(a.URI)lists.add(new URL(a.URI,url).href);}
  return rewriteInput(filtered,url,u=>map(u,base,key,lists.has(u),height));
 }
 function masterPlaylist(height,base,key){if(!master)throw Error('جاري فحص دقات المصدر');return rewrite(master.text,master.url,base,key,height);}
 async function playlist(height,base,key){const generation=epoch;if(!source||!master)throw Error('جاري فحص دقات المصدر');const m=await manifest(source.url);if(generation!==epoch)throw Error('تغير مصدر البث');master=m;items=variants(m.text,m.url).filter(v=>v.height>0&&v.height<=1080);return rewrite(m.text,m.url,base,key,height);}
 async function serve(req,res,id,base,key){
  const entry=registry.get(id);if(!entry)throw Error('تغير المصدر؛ أعد فتح البث');const abort=new AbortController();res.once('close',()=>abort.abort());
  const {url,playlist,height}=entry,generation=epoch;
  if(playlist&&!req.headers.range){const m=await manifest(url);if(generation!==epoch)throw Error('تغير مصدر البث');res.setHeader('Content-Type','application/vnd.apple.mpegurl');return res.end(rewrite(m.text,m.url,base,key,height));}
  const headers={...source?.headers};if(req.headers.range&&/^bytes=\d+-\d*$/.test(req.headers.range))headers.Range=req.headers.range;
  const opened=await open(url,headers,0,{signal:abort.signal});if(generation!==epoch||res.destroyed){opened.response.destroy();throw Error('تغير مصدر البث');}
  const response=opened.response;res.once('close',()=>response.destroy());if(req.method==='HEAD'){res.statusCode=response.statusCode;for(const name of ['content-type','content-length','content-range','accept-ranges'])if(response.headers[name])res.setHeader(name,response.headers[name]);response.destroy();return res.end();}const iterator=response[Symbol.asyncIterator]();let first=await iterator.next(),head=first.done?Buffer.alloc(0):first.value;
  while(head.length<16&&!first.done){first=await iterator.next();if(!first.done)head=Buffer.concat([head,first.value]);}
  if(head.toString('utf8').trimStart().startsWith('#EXTM3U')){
   const parts=[head];let size=head.length;if(size>2097152){response.destroy();throw Error('القائمة كبيرة جدًا');}for await(const chunk of iterator){size+=chunk.length;if(size>2097152){response.destroy();throw Error('القائمة كبيرة جدًا');}parts.push(chunk);}
   if(generation!==epoch)throw Error('تغير مصدر البث');
   res.setHeader('Content-Type','application/vnd.apple.mpegurl');return res.end(rewrite(Buffer.concat(parts).toString('utf8'),opened.url,base,key,height));
  }
  if(head.toString('utf8').trimStart().startsWith('<')||/dash\+xml|(?:application|text)\/xml/i.test(response.headers['content-type']||'')){response.destroy();throw Error('المصدر أعاد قائمة XML أو صفحة غير مدعومة');}
  res.statusCode=response.statusCode;for(const name of ['content-type','content-length','content-range','accept-ranges'])if(response.headers[name])res.setHeader(name,response.headers[name]);
  res.on('close',()=>response.destroy());const output=Readable.from((async function*(){yield head;for await(const chunk of iterator)yield chunk;})());output.on('error',()=>res.destroy());response.on('error',()=>res.destroy());output.pipe(res);
 }
 return {configure,reset,masterPlaylist,playlist,serve,list:()=>qualityList(items),available:()=>!!master&&(items.length>0||/^#EXTINF:/m.test(master.text))};
}
