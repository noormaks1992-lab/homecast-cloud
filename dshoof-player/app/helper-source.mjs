import {lookup} from 'node:dns/promises';
import {createHash} from 'node:crypto';
import {attributes,htmlText,pageCandidates} from './page-extractor.mjs';
import {inputURL,publicIPv4,openPublic,readLimited} from './sources.mjs';

export function helperInput(value){
 const text=String(value||'').trim().replace(/\\(?=[:<>/])/g,'');
 if(!text||text.length>6000)throw Error('ألصق رابط المشغّل أو كود iframe صالحًا');
 const frame=text.match(/^<iframe\b[^>]*>/i);let url=text;
 if(frame){const attrs=attributes(frame[0]);if(attrs.has('srcdoc'))throw Error('استخدم رابط iframe؛ أكواد الصفحات الداخلية غير مدعومة');url=attrs.get('src')||'';}
 else if(/[<>]/.test(text))throw Error('اقبل رابطًا أو iframe فقط؛ لا تلصق سكربتات');
 const parsed=inputURL(htmlText(url));
 if(parsed.protocol!=='https:')throw Error('البث المساعد يحتاج رابط HTTPS');
 return {url:parsed.href,iframe:!!frame};
}
async function validatePublic(value,resolve){
 const u=inputURL(value);if(u.protocol!=='https:')throw Error('البث المساعد يحتاج رابط HTTPS');
 const records=await resolve(u.hostname,{family:4,all:true});
 if(!records.length||records.some(record=>!publicIPv4(record.address)))throw Error('روابط الشبكات المحلية غير مدعومة');
 return u.href;
}
export async function resolveHelper(value,{resolve=lookup,open=openPublic}={}){
 const parsed=helperInput(value);let target=await validatePublic(parsed.url,resolve);
 // A supplied iframe already identifies the intended player. Never execute its markup.
 if(!parsed.iframe){
  const visited=new Set();
  for(let depth=0;depth<3&&!visited.has(target);depth++){
   visited.add(target);let response;
   try{
    const result=await open(target,{},0,{signal:AbortSignal.timeout(6000)});response=result.response;
    const final=await validatePublic(result.url,resolve);target=final;
    const html=(await readLimited(response,524288)).toString('utf8');
    if(!/<(?:html|iframe|body)\b/i.test(html))break;
    // Ignore iframe strings in scripts, including a player's own "copy embed" widget.
    const markup=html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'');
    const frames=pageCandidates(markup,target).frames.filter(url=>!/(?:doubleclick|googlesyndication|adservice|analytics|facebook|recaptcha)/i.test(url));
    const next=frames.find(url=>/\/(?:player|embed|ch|stream|live)[^/]*(?:\/|\.|\?)/i.test(new URL(url).pathname+'?'))||frames[0];
    if(!next||visited.has(next))break;
    target=await validatePublic(next,resolve);
   }catch{response?.destroy();break;}
  }
 }
 return {kind:'helper',url:parsed.url,embedUrl:target,title:'البث المساعد'};
}

const style='html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}iframe{display:block;width:100%;height:100%;border:0}';
const styleHash=createHash('sha256').update(style).digest('base64');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function helperDocument(value){
 const {url}=helperInput(value),origin=new URL(url).origin;
 return {csp:`default-src 'none'; style-src 'sha256-${styleHash}'; frame-src ${origin}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`,html:`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>البث المساعد · دشوف</title><style>${style}</style></head><body><iframe src="${escape(url)}" title="المشغّل المساعد" sandbox="allow-scripts allow-same-origin allow-forms allow-presentation" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>`};
}
