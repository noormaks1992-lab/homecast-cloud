'use strict';
// Inspect media declarations, not browser credentials or protected session tokens.
module.exports=async function discover(page,probe){
  const seen=new Set(),candidates=new Set();let pages=0;
  function absolute(s,base){try{const u=new URL(s.replace(/&amp;/g,'&').replace(/\\\//g,'/'),base);return /^https?:$/.test(u.protocol)?u.href:null;}catch{return null;}}
  async function walk(url,depth){
    if(seen.has(url)||depth>2||pages++>=5)return null;seen.add(url);
    let response,text;
    try{response=await fetch(url,{signal:AbortSignal.timeout(12000)});if(!response.ok)return null;const reader=response.body.getReader();let chunks=[],size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024){await reader.cancel();return null;}chunks.push(Buffer.from(value));}text=Buffer.concat(chunks).toString();}catch{return null;}
    const direct=[];
    for(const m of text.matchAll(/<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi))direct.push(m[1]);
    for(const m of text.matchAll(/["']((?:https?:)?(?:\\?\/){2}[^"'<>\s]+?\.(?:m3u8|mpd|mp4|webm)(?:\?[^"'<>\s]*)?)["']/gi))direct.push(m[1]);
    for(const v of direct.slice(0,8)){const input=absolute(v,response.url);if(!input||candidates.has(input))continue;candidates.add(input);try{const info=await probe(input);return {input,...info};}catch{}}
    for(const m of [...text.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].slice(0,5)){
      const child=absolute(m[1],response.url);if(!child||/doubleclick|googleads|recaptcha|adservice/i.test(child))continue;
      const result=await walk(child,depth+1);if(result)return result;
    }
    return null;
  }
  return walk(page,0);
};
