import {htmlText,attributes as htmlAttributes,pageCandidates} from './page-extractor.mjs';
import http from 'node:http';
import {createHash,createDecipheriv} from 'node:crypto';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

export function youtubeId(value){let u;try{u=new URL(value)}catch{return null}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;const host=u.hostname.toLowerCase();let id=null;if(host==='youtu.be')id=u.pathname.split('/')[1];else if(['youtube.com','www.youtube.com','m.youtube.com','www.youtube-nocookie.com'].includes(host)){if(u.pathname==='/watch')id=u.searchParams.get('v');else if(/^\/(shorts|live|embed)\//.test(u.pathname))id=u.pathname.split('/')[2];}return /^[\w-]{11}$/.test(id||'')?id:null;}
export function publicIPv4(ip){if(isIP(ip)!==4)return false;const [a,b,c]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===88&&c===99))||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));}
export function inputURL(value){const u=new URL(value);if(u.href.length>16384||!['http:','https:'].includes(u.protocol)||u.username||u.password||(u.port&&!['80','443'].includes(u.port)))throw Error('استخدم رابط فيديو HTTP أو HTTPS عامًا على منفذ عادي');if(u.hostname==='localhost'||u.hostname.endsWith('.localhost')||u.hostname.endsWith('.local')||u.hostname.includes(':')||isIP(u.hostname)&&!publicIPv4(u.hostname))throw Error('روابط الشبكات المحلية غير مدعومة');return u;}
const sourceHeaders=headers=>Object.fromEntries(Object.entries(headers||{}).filter(([k,v])=>/^(?:User-Agent|Referer|Origin|Accept|Accept-Language|Range|X-Player-Authorization)$/i.test(k)&&typeof v==='string'&&v.length<=8192&&!/[\r\n]/.test(v)));
// Pin every HTTP hop to a validated public IPv4 address; also revalidate redirects.
// A cross-origin redirect must never receive the provider's temporary authorization.
export function createPublicOpener({resolve=lookup,httpRequest=http.request,httpsRequest=https.request}={}){
 return async function open(value,headers={},redirects=0,options={}){
  const u=inputURL(value),records=await resolve(u.hostname,{family:4,all:true});
  if(!records.length||records.some(x=>!publicIPv4(x.address)))throw Error('العنوان لا يشير إلى خادم إنترنت عام');
  const address=records[0].address,selected=sourceHeaders(headers);
  const response=await new Promise((resolve,reject)=>{
   const request=(u.protocol==='https:'?httpsRequest:httpRequest)(u,{method:'GET',headers:{'User-Agent':'DshoofPlayer/3.0','Accept-Encoding':'identity',...selected},signal:options.signal,lookup:(_h,opts,cb)=>opts?.all?cb(null,[{address,family:4}]):cb(null,address,4)},response=>{response.on('error',()=>{});clearTimeout(timer);resolve(response);});
   const timer=setTimeout(()=>request.destroy(Error('انتهت مهلة استجابة مصدر الفيديو')),15000);timer.unref?.();
   request.setTimeout(15000,()=>request.destroy(Error('انتهت مهلة مصدر الفيديو')));
   request.on('error',error=>{clearTimeout(timer);reject(error);});request.end();
  });
  if([301,302,303,307,308].includes(response.statusCode)){
   response.destroy();if(redirects>=4||!response.headers.location)throw Error('إعادة توجيه غير صالحة');
   const next=inputURL(new URL(response.headers.location,u).href);
   if(next.origin!==u.origin)for(const key of Object.keys(selected))if(/authorization|cookie|token|api-key|secret/i.test(key))delete selected[key];
   return open(next.href,selected,redirects+1,options);
  }
  if(response.statusCode<200||response.statusCode>=300){
   const error=Error('تعذر الوصول إلى مصدر الفيديو ('+response.statusCode+')');error.statusCode=response.statusCode;
   const after=response.headers['retry-after'];error.retryAfterMs=Math.min(300000,/^\d+$/.test(after||'')?Number(after)*1000:Math.max(0,Date.parse(after||'')-Date.now())||0);response.destroy();throw error;
  }
  if(response.headers['content-encoding']&&!/^identity$/i.test(response.headers['content-encoding'])){response.destroy();throw Error('مصدر الفيديو أرسل ضغط نقل غير مدعوم');}
  return {response,url:u.href};
 };
}
export const openPublic=createPublicOpener();
export async function readLimited(response,max=2097152){let size=0,parts=[];for await(const chunk of response){size+=chunk.length;if(size>max){response.destroy();throw Error('قائمة المصدر كبيرة جدًا');}parts.push(chunk);}return Buffer.concat(parts);}
export async function inspectDirect(value,headers={},{audio=false}={}){const u=inputURL(value);const {response,url}=await openPublic(u.href,headers);const type=String(response.headers['content-type']||'').toLowerCase();let bytes=Buffer.alloc(0);for await(const chunk of response){bytes=Buffer.concat([bytes,chunk.subarray(0,1024-bytes.length)]);if(bytes.length>=1024)break;}response.destroy();const text=bytes.toString('utf8').trimStart();if(text.startsWith('#EXTM3U'))return {url,format:'hls'};if(type.includes('text/html')||/^<!doctype|^<html/i.test(text))throw Error('هذا رابط صفحة؛ أدخل رابط الفيديو المباشر أو رابط يوتيوب');if(text.startsWith('<')||/dash\+xml|(?:application|text)\/xml/.test(type))throw Error('قوائم XML وDASH غير مدعومة؛ استخدم رابط HLS أو MP4 مباشرًا');if(audio&&type.startsWith('audio/')||type.startsWith('video/')||bytes.subarray(4,8).toString()==='ftyp'||bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))||bytes[0]===0x47)return {url,format:'auto'};throw Error('لم يُكتشف فيديو مباشر؛ جرّب رابط MP4 أو M3U8 صالحًا');}
export function rewriteInput(text,base,map){if(/#EXT-X-(?:DEFINE|CONTENT-STEERING)\s*:/i.test(text))throw Error('قائمة HLS تستخدم امتداد روابط غير مدعوم');return text.split('\n').map(line=>!line.trim()?line:line.startsWith('#')?line.replace(/URI="([^"]+)"/g,(_,s)=>'URI="'+map(inputURL(new URL(s,base).href).href)+'"'):map(inputURL(new URL(line.trim(),base).href).href)).join('\n');}

// Provider pages are resolved only through their public watch-card endpoint.
// Follow the published embedded-player flow; keep temporary authorization in memory.
export function watchCardURL(value){
 const u=inputURL(value);
 if(!['live.xn----zmcaegc7cl3msazv.com','majed-koora.live'].includes(u.hostname))return null;
 const key=u.searchParams.get('mk');
 if(!key)return null;
 if(!/^[A-Za-z0-9_-]{20,160}$/.test(key))throw Error('مفتاح صفحة المباراة غير صالح');
 return 'https://majed-koora.live/api/public/watch-card?key='+encodeURIComponent(key);
}
async function majedWatch(value,open){
 const api=watchCardURL(value);if(!api)throw Error('أدخل رابط صفحة مباراة ماجد الذي يحتوي mk');
 const {response}=await open(api,{Accept:'application/json'});
 let data;try{data=JSON.parse((await readLimited(response,262144)).toString('utf8'))}catch{throw Error('تعذر قراءة بيانات صفحة المباراة');}
 const watch=data?.watch;
 if(!data?.success||!watch)throw Error('رابط المباراة غير صالح أو انتهت صلاحيته');
 if(!watch.available)throw Error('البث غير متاح الآن: '+String(watch.availability?.message||'لم يفتح أو انتهى').slice(0,160));
 const servers=(Array.isArray(watch.servers)?watch.servers:[]).filter(s=>s?.enabled!==false&&typeof s?.url==='string').slice(0,16).map((s,i)=>({...s,id:typeof s.id==='string'&&s.id.length>0&&s.id.length<=128?s.id:'server-'+createHash('sha256').update(s.url).digest('hex').slice(0,16),name:String(s.name||'مشغّل '+(i+1)).slice(0,100),quality:String(s.quality||'').slice(0,120)}));
 if(!servers.length)throw Error('صفحة المباراة لا توفر مصدر بث حاليًا');
 return {watch,servers,title:[watch.match?.home_team?.name,watch.match?.away_team?.name].filter(Boolean).join(' × ')||'دشوف مباشر'};
}
export async function discoverMajedServers(value,{open=openPublic}={}){
 const {servers,title}=await majedWatch(value,open);
 return {provider:'majed',title,servers:servers.map(s=>({id:s.id,name:s.name,quality:s.quality,isDefault:s.is_default===true}))};
}
function majedFailure(error){
 const message=String(error?.message||''),code=String(error?.code||'');
 const status=message.match(/\b(401|403|404|429|5\d\d)\b/)?.[1];
 if(status==='403')return 'المزوّد رفض الاتصال (403)';
 if(status)return 'تعذر الوصول إلى المصدر ('+status+')';
 if(/EAI_AGAIN|ENOTFOUND/.test(code+' '+message))return 'تعذر حل عنوان خادم المصدر (DNS)';
 if(/مهلة|timeout|ETIMEDOUT/i.test(message+' '+code))return 'انتهت مهلة الاتصال بالمصدر';
 if(/لم يصدر المزوّد تصريحًا/.test(message))return 'لم يصدر المزوّد تصريحًا للمشغّل';
 if(/DRM/.test(message))return 'المصدر محمي بـ DRM غير مدعوم';
 if(/authenticate|تصريح المشغّل|بيانات المشغّل|JSON/i.test(message))return 'تعذر قراءة بيانات أو تصريح المشغّل؛ يلزم فحص توافق التكامل';
 if(/تغيّر عنوان المشغّل/.test(message))return 'تغيّر عنوان المشغّل؛ يلزم تحديث التكامل';
 if(/صيغة قناة|لم يرجع مصدر HLS/.test(message))return 'المشغّل لم يقدم مصدر HLS متوافقًا';
 if(/رابط صفحة|لم يُكتشف فيديو/.test(message))return 'المصدر لم يرجع فيديو مباشرًا';
 return 'تعذر تجهيز المصدر؛ يلزم فحص سجل الاستضافة';
}
export async function inspectSource(value,{open=openPublic,inspect=inspectDirect,player=resolveMajedPlayer,serverId=''}={}){
 if(serverId===undefined||serverId===null)serverId='';
 if(typeof serverId!=='string'||serverId.length>128)throw Error('اختيار مشغّل ماجد غير صالح');
 const pageURL=inputURL(value).href;if(arenaMatch(pageURL))return inspectArena(pageURL,{open,inspect});const api=watchCardURL(pageURL);
 const playerHost=new URL(pageURL).hostname==='player.majed-koora.live';
 if(!api){try{return await inspect(pageURL)}catch(e){if(playerHost)throw Error('مشغّل ماجد ليس رابط فيديو مباشرًا وقد يرفض الوصول الخارجي (403). أدخل رابط صفحة المباراة الأصلي أو كود المزوّد أو رابط M3U8 متاحًا للاستضافة.');if(/رابط صفحة|text\/html/i.test(e.message))return extractPageSource(pageURL,{open,inspect});throw e;}}
 const card=await majedWatch(pageURL,open),servers=serverId?card.servers.filter(s=>s.id===serverId):card.servers.slice(0,3);
 if(!servers.length)throw Error('المشغّل المختار لم يعد متاحًا في صفحة ماجد؛ حدّث قائمة المشغّلات واختر مجددًا');
 const failures=[];
 for(const server of servers){
  try{const target=inputURL(server.url).href;const direct=new URL(target).hostname==='player.majed-koora.live'?await player(target,pageURL,{open,inspect}):await inspect(target);return {...direct,sourcePage:pageURL,title:card.title,serverId:serverId||undefined,serverName:[server.name,server.quality].filter(Boolean).join(' · ')};}catch(e){failures.push(majedFailure(e));}
 }
 if(serverId)throw Error('تعذر تشغيل المشغّل المختار «'+servers[0].name+'»: '+failures[0]+'. لم يتم التبديل إلى مشغّل آخر.');
 throw Error('تمت قراءة صفحة المباراة، لكن تعذر تجهيز البث: '+failures.map((reason,i)=>'المشغّل '+(i+1)+': '+reason).join('؛ ')+'.');
}

export function decodePlayerStream(envelope,authorization){
 if(envelope?.v!==1||envelope?.alg!=='A256GCM'||![envelope.iv,envelope.tag,envelope.data].every(x=>typeof x==='string'&&/^[A-Za-z0-9_+\/=-]+$/.test(x)))throw Error('بيانات المشغّل غير متوافقة');
 const iv=Buffer.from(envelope.iv,'base64url'),tag=Buffer.from(envelope.tag,'base64url');
 if(iv.length!==12||tag.length!==16)throw Error('تصريح المشغّل غير صالح');
 const key=createHash('sha256').update('majed-player-stream-v1|'+authorization).digest();
 const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from('majed-player-stream-v1'));decipher.setAuthTag(tag);
 return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64url')),decipher.final()]).toString('utf8'));
}
// Read the provider's static metadata without executing page scripts. Attribute
// spacing, order and quoting are HTML syntax, not changes to the authorization flow.
function playerAuthorization(html){
 const markup=html.replace(/<!--[\s\S]*?(?:-->|$)/g,'').replace(/<(script|style|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
 for(const tag of markup.matchAll(/<meta\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)){
  const attrs=new Map();
  for(const a of tag[1].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)){
   const name=a[1].toLowerCase();if(!attrs.has(name))attrs.set(name,a[2]??a[3]??a[4]??'');
  }
  if(attrs.get('name')==='majed-player-authorization')return attrs.get('content');
 }
 return null;
}
export async function resolveMajedPlayer(value,pageURL,{open=openPublic,inspect=inspectDirect}={}){
 const u=inputURL(value);if(u.protocol!=='https:'||u.hostname!=='player.majed-koora.live')throw Error('مشغّل غير مدعوم');
 if(!watchCardURL(pageURL))throw Error('أدخل صفحة المباراة الأصلية لتجهيز المشغّل');
 if(u.pathname==='/v2/embed.php')return resolveMajedV2(u.href,pageURL,{open,inspect});
 const channel=u.searchParams.get('channel')||u.searchParams.get('id');
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(channel||''))throw Error('قناة المشغّل غير صالحة');
 const ua='DshoofPlayer/3.0';
 const page=await open(u.href,{'User-Agent':ua,Referer:inputURL(pageURL).href});
 if(new URL(page.url||u.href).origin!==u.origin){page.response.destroy();throw Error('تغيّر عنوان المشغّل؛ يلزم تحديث التكامل');}
 const html=(await readLimited(page.response,524288)).toString('utf8');
 const authorization=playerAuthorization(html);
 if(!authorization||authorization.length>8192||/[\r\n]/.test(authorization))throw Error('لم يصدر المزوّد تصريحًا للمشغّل');
 const api=new URL('/api/stream.php',u);api.searchParams.set('id',channel);
 const result=await open(api.href,{'User-Agent':ua,Referer:u.href,Accept:'application/json','X-Player-Authorization':authorization});
 const config=decodePlayerStream(JSON.parse((await readLimited(result.response,262144)).toString('utf8')),authorization);
 if(config.drm?.enabled||['widevine','playready','fairplay'].some(k=>config.drm?.[k]?.licenseUrl)||config.drm?.clearKeys?.length)throw Error('هذا المصدر يستخدم DRM غير مدعوم');
 if(config.format&&config.format!=='hls')throw Error('صيغة قناة المشغّل غير مدعومة؛ يلزم HLS');
 const headers={'User-Agent':ua,Referer:u.href,Origin:u.origin};
 const direct=await inspect(inputURL(config.url).href,headers);
 if(direct.format!=='hls')throw Error('المشغّل لم يرجع مصدر HLS');
 const expiresAt=config.expiresAt?Date.parse(config.expiresAt):null;
 return {...direct,headers,...(Number.isFinite(expiresAt)?{expiresAt}:{})};
}

export function arenaMatch(value){
 const u=inputURL(value);if(u.protocol!=='https:'||u.hostname!=='www.arena8x.live'||u.pathname!=='/')return null;
 const id=u.searchParams.get('arena_match'),date=u.searchParams.get('arena_date');
 if(!/^\d{1,12}$/.test(id||'')||!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('رابط مباراة أرينا غير مكتمل');
 return {id,date};
}
export async function inspectArena(pageURL,{open=openPublic,inspect=inspectDirect}={}){
 const match=arenaMatch(pageURL);if(!match)throw Error('رابط أرينا غير صالح');
 // Published public match endpoint used by Arena's own page. No browser sessions or headers copied.
 const endpoint=new URL('https://arenaaliive22.site/api/v1/matches');endpoint.searchParams.set('date',match.date);endpoint.searchParams.set('scope','all');
 const {response}=await open(endpoint.href,{Accept:'application/json'});
 const data=JSON.parse((await readLimited(response,2097152)).toString('utf8'));
 const selected=(Array.isArray(data.matches)?data.matches:[]).find(x=>String(x.id)===match.id);
 if(!selected)throw Error('المباراة غير موجودة في بيانات أرينا الحالية');
 const servers=(Array.isArray(selected.servers)?selected.servers:[]).filter(x=>x.enabled!==false&&typeof x.url==='string').slice(0,3);
 if(!servers.length)throw Error('لم تنشر أرينا مصدر فيديو لهذه المباراة');
 let error;
 for(const server of servers){try{const direct=await inspect(inputURL(server.url).href);return {...direct,sourcePage:pageURL,title:[selected.home_team?.name,selected.away_team?.name].filter(Boolean).join(' × ')||'أرينا · دشوف'};}catch(e){error=e;if(/\(403\)|\(401\)/.test(e.message))break;}}
 throw Error('تعذر استقبال فيديو أرينا على الاستضافة: '+String(error?.message||'المصدر ليس فيديو مباشرًا')+'. لم يتم استبدال البث بصفحة ويب.');
}


export async function resolveMajedV2(value,pageURL,{open=openPublic,inspect=inspectDirect}={}){
 const u=inputURL(value);if(u.origin!=='https://player.majed-koora.live'||u.pathname!=='/v2/embed.php')throw Error('مشغّل ماجد الجديد غير صالح');
 const headers={'User-Agent':'Mozilla/5.0',Referer:inputURL(pageURL).href};const page=await open(u.href,headers);
 if(new URL(page.url||u.href).origin!==u.origin){page.response.destroy();throw Error('تغيّر عنوان مشغّل ماجد الجديد');}
 const html=(await readLimited(page.response,524288)).toString('utf8');let boot;
 for(const m of html.replace(/<!--[\s\S]*?(?:-->|$)/g,'').matchAll(/<body\b[^>]*>/gi)){const value=htmlAttributes(m[0]).get('data-majed-boot');if(value){try{boot=JSON.parse(value);}catch{}break;}}
 if(!boot||!/^[-\w]{1,64}$/.test(boot.channel||'')||typeof boot.token!=='string'||boot.token.length>8192||boot.base!=='/v2')throw Error('تعذر قراءة تصريح مشغّل ماجد الجديد');
 const api=new URL('/v2/api.php',u);api.searchParams.set('route','play/'+boot.channel);api.searchParams.set('t',boot.token);
 const result=await open(api.href,{...headers,Referer:u.href,Accept:'application/json'});const config=JSON.parse((await readLimited(result.response,524288)).toString('utf8'));
 const servers=Array.isArray(config.servers)?config.servers.slice(0,4):[];let last;
 for(const server of servers){try{if(server.drm?.enabled||server.drm&&Object.keys(server.drm).some(k=>server.drm[k])||server.clearKeys||server.licenseUrl)throw Error('هذا المصدر يستخدم DRM غير مدعوم');const target=inputURL(server.url).href;const requestHeaders={'User-Agent':'Mozilla/5.0',Referer:u.href,Origin:u.origin};const direct=await inspect(target,requestHeaders);return {...direct,headers:requestHeaders,title:String(config.title||boot.title||'دشوف مباشر').slice(0,120)};}catch(e){last=e;}}
 if(last?.statusCode){const e=Error('رفض مصدر المشغّل الجديد الاتصال ('+last.statusCode+')');e.statusCode=last.statusCode;throw e;}
 throw Error(last?.message?.includes('DRM')?'المصدر محمي بـ DRM غير مدعوم':'لم يوفر المشغّل الجديد فيديو متاحًا يمكن استقباله');
}
export async function extractPageSource(value,{open=openPublic,inspect=inspectDirect,maxDepth=3}={}){
 const original=inputURL(value).href,seen=new Set();let requests=0;
 async function visit(url,parent,depth){if(depth>maxDepth||requests>=10||seen.has(url))throw Error('لم يمكن استخراج فيديو متاح من الصفحة');seen.add(url);requests++;
  const headers={'User-Agent':'Mozilla/5.0',...(parent?{Referer:parent,Origin:new URL(parent).origin}:{})};const page=await open(inputURL(url).href,headers);const final=inputURL(page.url||url).href;const bytes=await readLimited(page.response,1048576);const text=bytes.toString('utf8');
  if(text.trimStart().startsWith('#EXTM3U'))return {url:final,format:'hls',headers};
  if(!/<(?:html|video|iframe|source|script|meta)\b/i.test(text))throw Error('الصفحة لم توفر مشغّلًا قابلًا للاستخراج');
  const candidates=pageCandidates(text,final);
  // Read at most two published configuration scripts as text, within the shared request budget.
  for(const script of candidates.scripts){if(requests>=8)break;try{requests++;const resource=await open(inputURL(script).href,{'User-Agent':'Mozilla/5.0',Referer:final,Origin:new URL(final).origin});const config=(await readLimited(resource.response,524288)).toString('utf8');const extra=pageCandidates(config,final);candidates.direct.push(...extra.direct);candidates.frames.push(...extra.frames);}catch{}}
  candidates.direct=[...new Set(candidates.direct)].slice(0,8);candidates.frames=[...new Set(candidates.frames)].slice(0,4);
  for(const target of candidates.direct){if(requests>=10)break;try{requests++;const direct=await inspect(inputURL(target).href,{'User-Agent':'Mozilla/5.0',Referer:final,Origin:new URL(final).origin});return {...direct,headers:{'User-Agent':'Mozilla/5.0',Referer:final,Origin:new URL(final).origin}};}catch{}}
  for(const frame of candidates.frames){try{if(new URL(frame).hostname==='player.majed-koora.live'&&new URL(frame).pathname==='/v2/embed.php')return await resolveMajedV2(frame,final,{open,inspect});return await visit(frame,final,depth+1);}catch{}}
  throw Error('لم يمكن استخراج فيديو متاح؛ قد تتطلب الصفحة تسجيل دخول أو DRM أو تشغيل JavaScript داخل متصفح');
 }
 return {...await visit(original,null,0),sourcePage:original};
}
