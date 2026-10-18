// Signaling is scoped to authenticated room connections. A room mute survives
// leave/rejoin and signaling bursts have a separate allowance from API polling.
export function createVoice({now=Date.now}={}){
 const peers=new Map(),mutedInvites=new Map(),rates=new Map();let sequence=0,signals=[];
 const key=a=>a.connection||a.id;
 function remove(k){peers.delete(k);rates.delete(k);signals=signals.filter(s=>s.from!==k&&s.to!==k);}
 function clean(){const at=now();for(const[k,v]of peers)if(at-v.at>15000)remove(k);signals=signals.filter(s=>at-s.at<20000).slice(-300);}
 function join(a){clean();const k=key(a);if(!peers.has(k)&&peers.size>=4)throw Error('الغرفة الصوتية محدودة بأربعة أجهزة لحماية اتصال المشاهدين');const previous=peers.get(k);peers.set(k,{id:k,name:a.name,invite:a.id,at:now(),muted:!!(a.muted||mutedInvites.get(a.id)||previous?.muted)});return {id:k,iceServers:[{urls:'stun:stun.l.google.com:19302'}]};}
 function poll(a,since){clean();const k=key(a),p=peers.get(k);if(!p)throw Error('الجلسة الصوتية غير متصلة');p.at=now();return {id:k,muted:p.muted,peers:[...peers.values()].map(({id,name,muted})=>({id,name,muted})),signals:signals.filter(s=>s.to===k&&s.seq>Number(since||0)),sequence};}
 function signal(a,b){
  clean();const from=key(a),peer=peers.get(from);if(!peer||!peers.has(b.to)||from===b.to)throw Error('المشارك غادر الغرفة');
  if((peer.muted||a.muted)&&b.type==='offer')throw Error('أوقف المضيف مشاركتك الصوتية');
  if(!['offer','answer','candidate'].includes(b.type))throw Error('إشارة غير صالحة');
  if(!b.data||typeof b.data!=='object'||Array.isArray(b.data))throw Error('بيانات الإشارة غير صالحة');
  const text=JSON.stringify(b.data);if(text.length>18000)throw Error('إشارة كبيرة');
  const at=now(),record=rates.get(from);if(record&&at-record.at<10000){if(record.count>=80)throw Error('إشارات كثيرة؛ انتظر قليلًا');record.count++;}else rates.set(from,{at,count:1});
  signals.push({seq:++sequence,from,to:b.to,type:b.type,data:JSON.parse(text),at});signals=signals.slice(-300);return {ok:true};
 }
 function leave(a){remove(key(a));}
 function mute(a,b){if(!a.owner)throw Error('للمالك فقط');const p=peers.get(b.id);if(p){if(b.muted){if(mutedInvites.size>=100&&!mutedInvites.has(p.invite))throw Error('عدد إجراءات الكتم كبير');mutedInvites.set(p.invite,true);}else mutedInvites.delete(p.invite);for(const peer of peers.values())if(peer.invite===p.invite)peer.muted=!!b.muted;if(b.muted)signals=signals.filter(s=>s.from!==p.id);}}
 function revoke(invite){for(const[k,p]of peers)if(!invite||p.invite===invite)remove(k);if(invite)mutedInvites.delete(invite);else mutedInvites.clear();}
 return {join,poll,signal,leave,mute,revoke};
}
