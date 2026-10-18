// Private, bounded room updates. Media URLs and application/owner credentials
// never belong on this transport. Each connection gets its own room snapshot.
const pick=(value,names)=>Object.fromEntries(names.filter(name=>value&&Object.hasOwn(value,name)).map(name=>[name,value[name]]));
const messageFields=['id','reply','name','owner','text','spoiler','stand','videoAt','at'];
function roomView(value){
 if(!value||!Number.isSafeInteger(value.version)||value.version<0)throw Error('Invalid room snapshot');
 const room=pick(value,['version','instanceId','online','name','username','canManageChat','muted','role','avatar','myReactions']);
 if(value.settings)room.settings=pick(value.settings,['name','chatEnabled','reactionsEnabled','slowSeconds','maxViewers','announcement']);
 if(Array.isArray(value.roster))room.roster=value.roster.slice(0,64).map(item=>pick(item,['name','avatar']));
 if(Array.isArray(value.typing))room.typing=value.typing.slice(0,64);
 if(Object.hasOwn(value,'pinned'))room.pinned=value.pinned?pick(value.pinned,['name','text','id','videoAt','stand','at']):null;
 if(Array.isArray(value.messages))room.messages=value.messages.slice(-100).map(item=>({...pick(item,messageFields),...(item.reply?{reply:pick(item.reply,['name','text'])}:{})}));
 if(value.reactions)room.reactions=pick(value.reactions,['like','love','heart']);
 if(value.reactionNames)room.reactionNames=pick(value.reactionNames,['like','love','heart']);
 if(Array.isArray(value.events))room.events=value.events.slice(-12).map(item=>pick(item,['id','type','at']));
 if(Object.hasOwn(value,'poll'))room.poll=value.poll?pick(value.poll,['id','question','options','closed','counts','voters','myVote']):null;
 return room;
}
function lightRoom(room){const result={...room};for(const field of ['messages','messagesDelta','reactions','reactionNames','myReactions','events','poll'])delete result[field];return result;}
function historyDelta(previous,next){
 if(!previous)return null;
 const before=new Map(previous.map(item=>[item.id,item])),after=new Map(next.map(item=>[item.id,item]));
 if(before.size!==previous.length||after.size!==next.length||next.some(item=>typeof item.id!=='string'||!item.id))return null;
 const retained=previous.filter(item=>after.has(item.id));
 if(retained.some((item,index)=>next[index]?.id!==item.id||JSON.stringify(item)!==JSON.stringify(next[index])))return null;
 return {added:next.slice(retained.length),removed:previous.filter(item=>!after.has(item.id)).map(item=>item.id)};
}
const identity=a=>!a||a.limited||typeof (a.connection||a.id)!=='string'||!(a.connection||a.id)||String(a.connection||a.id).length>256?null:(a.owner?'owner:':'viewer:')+(a.connection||a.id);
function reject(res,status,error){if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...(status===429?{'Retry-After':'15'}:{})});res.end(JSON.stringify({error}));}

export function createChatEvents({maxConnections=64,maxPerIdentity=2,heartbeatMs=15000,coalesceMs=50,maxEventBytes=256*1024,backpressureMs=30000}={}){
 for(const value of [maxConnections,maxPerIdentity,heartbeatMs,maxEventBytes,backpressureMs])if(!Number.isFinite(value)||value<=0)throw Error('Invalid chat event limit');
 if(!Number.isFinite(coalesceMs)||coalesceMs<0)throw Error('Invalid coalescing delay');
 const clients=new Set(),identities=new Map();let closing=false;
 async function handle(req,res,{access,snapshot,subscribe}){
  if(closing)return reject(res,503,'يجري إعادة تشغيل الخادم');
  if(req.method!=='GET')return reject(res,405,'الطريقة غير مسموحة');
  let initial;try{initial=await access();}catch{return reject(res,403,'انتهت صلاحية المشاهدة');}
  if(req.aborted||res.destroyed)return;
  const id=identity(initial);if(!id)return reject(res,403,'سجّل اسمك للانضمام إلى دشوف');
  if(closing)return reject(res,503,'يجري إعادة تشغيل الخادم');
  if(clients.size>=maxConnections||(identities.get(id)||0)>=maxPerIdentity)return reject(res,429,'اتصالات الدردشة كثيرة؛ أغلق نافذة أخرى وحاول مجددًا');
  const client={close};clients.add(client);identities.set(id,(identities.get(id)||0)+1);
  let ended=false,unsubscribe=()=>{},timer,scheduled,busy=false,dirty=false,blocked=false,blockedAt=0,version=null,history=null,lastLight='';
  function close(){
   if(ended)return;ended=true;clearInterval(timer);clearTimeout(scheduled);scheduled=null;
   try{unsubscribe();}catch{}clients.delete(client);const count=(identities.get(id)||1)-1;if(count)identities.set(id,count);else identities.delete(id);
   req.off('aborted',close);res.off('close',close);res.off('error',close);res.off('drain',drain);if(!res.destroyed&&!res.writableEnded){if(blocked&&typeof res.destroy==='function')res.destroy();else res.end();}
  }
  function schedule(){dirty=true;if(ended||busy||blocked||scheduled)return;scheduled=setTimeout(()=>{scheduled=null;void flush(false);},coalesceMs);scheduled.unref?.();}
  function drain(){if(ended)return;blocked=false;blockedAt=0;if(dirty)schedule();}
  async function flush(heartbeat){
   if(ended)return;
   if(blocked){dirty=true;if(Date.now()-blockedAt>=backpressureMs)close();return;}
   if(busy){dirty=true;return;}
   busy=true;dirty=false;
   try{
    const a=await access();if(ended)return;if(identity(a)!==id)return close();
    const room=roomView(await snapshot(a,version));if(ended)return;if(res.destroyed||identity(await access())!==id)return close();
    const light=JSON.stringify(lightRoom(room)),sameVersion=version===room.version;
    let nextHistory=history;
    if(sameVersion){for(const field of ['messages','reactions','reactionNames','myReactions','events','poll'])delete room[field];}
    else if(Object.hasOwn(room,'messages')){
     nextHistory=room.messages;const delta=historyDelta(history,nextHistory);
     if(delta){delete room.messages;if(delta.added.length||delta.removed.length)room.messagesDelta=delta;}
    }
    const changed=!sameVersion||light!==lastLight;
    if(!changed&&!heartbeat)return;
    const frame=changed?`id: ${room.version}\nevent: room\ndata: ${JSON.stringify({room})}\n\n`:': keep-alive\n\n';
    if(Buffer.byteLength(frame)>maxEventBytes||(res.writableLength||0)>maxEventBytes)return close();
    const accepted=res.write(frame); // false still means accepted into Node's bounded buffer.
    if(changed){version=room.version;history=nextHistory;lastLight=light;}
    if(!accepted){blocked=true;blockedAt=Date.now();}
   }catch{close();}finally{busy=false;if(dirty&&!blocked&&!ended)schedule();}
  }
  req.once('aborted',close);res.once('close',close);res.once('error',close);res.on('drain',drain);
  try{
   unsubscribe=subscribe(schedule)||(()=>{});
   if(ended){try{unsubscribe();}catch{}return;}
   res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'private, no-store, no-cache, max-age=0','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
   res.flushHeaders?.();timer=setInterval(()=>void flush(true),heartbeatMs);timer.unref?.();
   await flush(false);
  }catch{close();}
 }
 return {handle,stats:()=>({connections:clients.size,identities:identities.size}),close(){closing=true;for(const client of [...clients])client.close();}};
}
