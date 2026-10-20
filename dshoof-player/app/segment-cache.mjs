// Only immutable, authenticated local TS segments are eligible. Never cache manifests.
export function createSegmentCache({maxBytes=64*1024*1024,maxItemBytes=8*1024*1024,maxPending=4,ttl=30000,now=Date.now}={}){
 const entries=new Map(),pending=new Map();let bytes=0;
 function remove(key){const x=entries.get(key);if(x){bytes-=x.data.length;entries.delete(key);}}
 async function get(key,size,load){
  const t=now();for(const [k,x]of entries)if(t-x.at>=ttl)remove(k);
  const hit=entries.get(key);if(hit){entries.delete(key);entries.set(key,hit);return hit.data;}
  if(pending.has(key))return pending.get(key);
  if(size>maxItemBytes||size>maxBytes||pending.size>=maxPending)return null;
  const task=Promise.resolve().then(load).then(data=>{if(data.length<=maxItemBytes&&data.length<=maxBytes){while(bytes+data.length>maxBytes&&entries.size)remove(entries.keys().next().value);entries.set(key,{data,at:now()});bytes+=data.length;}return data;});pending.set(key,task);
  try{return await task;}finally{pending.delete(key);}
 }
 return {get,stats:()=>({bytes,entries:entries.size,pending:pending.size,maxBytes})};
}
