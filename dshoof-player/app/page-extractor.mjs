// Read published player configuration as data; never execute scripts from a source page.
export function htmlText(value){return String(value).replace(/&(?:amp|quot|apos|lt|gt|#39|#x27|#34);/gi,x=>({'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&#39;':"'",'&#x27;':"'",'&#34;':'"'}[x.toLowerCase()]||x)).replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return v<=0x10ffff?String.fromCodePoint(v):'';});}
export function attributes(tag){const attrs=new Map();for(const m of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g))attrs.set(m[1].toLowerCase(),htmlText(m[2]??m[3]??m[4]));return attrs;}
const decode=value=>htmlText(value).replace(/\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi,(_,u,x)=>String.fromCharCode(parseInt(u||x,16))).replace(/\\\//g,'/');
export function pageCandidates(html,base){
 const clean=String(html).slice(0,1048576).replace(/<!--[\s\S]*?(?:-->|$)/g,''),direct=[],frames=[],scripts=[];
 const push=(list,v)=>{if(typeof v!=='string'||v.length>8192||list.length>=12)return;try{const u=new URL(decode(v),base);if(['http:','https:'].includes(u.protocol)&&!list.includes(u.href))list.push(u.href);}catch{}};
 for(const m of clean.matchAll(/<(video|source|iframe|meta|script)\b[^>]*>/gi)){
  const a=attributes(m[0]),tag=m[1].toLowerCase();
  if(tag==='iframe'){for(const k of ['src','data-src','data-lazy-src'])if(a.has(k))push(frames,a.get(k));}
  else if(tag==='script'){const src=a.get('src');if(src&&/(?:player|embed|video|stream|config)/i.test(src)&&!/(?:analytics|advert|tracking)/i.test(src))push(scripts,src);}
  else if(tag==='meta'){if(/^(?:og:video(?::(?:url|secure_url))?|twitter:player:stream)$/i.test(a.get('property')||a.get('name')||''))push(direct,a.get('content'));else if(/^twitter:player$/i.test(a.get('name')||''))push(frames,a.get('content'));}
  else for(const key of ['src','data-src','data-hls','data-url','data-video-url'])if(a.has(key))push(direct,a.get(key));
 }
 const scan=text=>{
  for(const m of text.matchAll(/(?:["'](?:file|src|contentUrl|hls|hlsUrl|streamUrl|playbackUrl|videoUrl|manifestUrl)["']\s*:|\b(?:file|hls|hlsUrl|streamUrl|videoUrl|manifestUrl)\s*[:=]|\.loadSource\s*\()\s*(["'])(.*?)\1/gi))push(direct,m[2]);
  for(const m of text.matchAll(/["']((?:https?:)?\/\/[^"'<>\s]+?\.(?:m3u8|mp4|webm|m4v)(?:\?[^"'<>\s]*)?)["']/gi))push(direct,m[1]);
  for(const m of text.matchAll(/["']embedUrl["']\s*:\s*(["'])(.*?)\1/gi))push(frames,m[2]);
 };
 scan(decode(clean));let decoded=0;
 for(const m of clean.matchAll(/\batob\s*\(\s*['"]([A-Za-z0-9+/=]{8,16384})['"]\s*\)/g)){if(decoded++>=4)break;const value=Buffer.from(m[1],'base64').toString('utf8');if(/^(?:https?:)?\/\//.test(value.trim()))push(direct,value.trim());else scan(decode(value));}
 return {direct:direct.slice(0,8),frames:frames.slice(0,4),scripts:scripts.slice(0,2)};
}
