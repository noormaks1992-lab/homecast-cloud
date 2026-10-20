// Inspect published HTML/JSON metadata only. Never execute remote scripts or use browser sessions.
export function htmlText(value){return String(value).replace(/&(?:amp|quot|apos|lt|gt|#39|#x27|#34);/gi,x=>({'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&#39;':"'",'&#x27;':"'",'&#34;':'"'}[x.toLowerCase()]||x)).replace(/&#(\d+);/g,(_,n)=>Number(n)<=0x10ffff?String.fromCodePoint(Number(n)):'');}
export function attributes(tag){const attrs=new Map();for(const m of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g))attrs.set(m[1].toLowerCase(),htmlText(m[2]??m[3]??m[4]));return attrs;}
export function pageCandidates(html,base){
 const clean=html.replace(/<!--[\s\S]*?(?:-->|$)/g,''),direct=[],frames=[];const push=(list,v)=>{try{const u=new URL(htmlText(v).replace(/\\\//g,'/'),base);if(['http:','https:'].includes(u.protocol)&&!list.includes(u.href))list.push(u.href);}catch{}};
 for(const m of clean.matchAll(/<(video|source|iframe|meta)\b[^>]*>/gi)){const a=attributes(m[0]),tag=m[1].toLowerCase();if(tag==='iframe'){if(a.has('src'))push(frames,a.get('src'));}else if(tag==='meta'){if(/^(?:og:video(?::(?:url|secure_url))?|twitter:player:stream)$/i.test(a.get('property')||a.get('name')||''))push(direct,a.get('content'));}else for(const key of ['src','data-src'])if(a.has(key))push(direct,a.get(key));}
 for(const m of clean.matchAll(/(?:["'](?:file|src|contentUrl|hls|hlsUrl|streamUrl|playbackUrl)["']\s*:|\b(?:file|hls|hlsUrl|streamUrl)\s*[:=]|\.loadSource\s*\()\s*(["'])(.*?)\1/gi))push(direct,m[2]);
 for(const m of clean.matchAll(/["']((?:https?:)?(?:\\\/|\/){2}[^"'<>\s]+?\.(?:m3u8|mp4|webm|m4v)(?:\?[^"'<>\s]*)?)["']/gi))push(direct,m[1]);
 return {direct:direct.slice(0,8),frames:frames.slice(0,4)};
}
