// Approximate viewing time from authenticated, server-timed playback reports.
// This state contains IDs and counters only: never cookies, IPs or device data.
const TIME_ZONE='Asia/Baghdad',MAX_MEMBERS=1000,MAX_DAYS=31,MAX_ACTIVE=30,MAX_SESSIONS=20;
const calendar=new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
const dayKey=at=>{const parts=Object.fromEntries(calendar.formatToParts(at).map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
const number=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const idText=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value)?value:null;
const broadcastId=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?String(value):typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,80}$/.test(value)?value:null;
const titleText=value=>(typeof value==='string'?value.replace(/https?:\/\/\S+/gi,'').replace(/[\p{Cc}\p{Cf}]/gu,'').trim().slice(0,120):'')||'بث مباشر';
const seconds=value=>Math.floor(number(value)/1000);
const add=(left,right)=>Math.min(Number.MAX_SAFE_INTEGER,number(left)+number(right));
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
function copyDays(value){const days=Object.create(null);for(const [date,total]of Object.entries(value||{}).filter(([date])=>datePattern.test(date)).sort(([a],[b])=>b.localeCompare(a)).slice(0,MAX_DAYS))days[date]=number(total);return days;}
function cleanStored(value){
 const data={schema:1,timeZone:TIME_ZONE,members:Object.create(null),days:Object.create(null),current:null};
 if(value?.schema!==1)return data;
 for(const [id,record]of Object.entries(value.members||{}).slice(0,MAX_MEMBERS))if(idText(id)&&record&&typeof record==='object'){
  data.members[id]={totalMs:number(record.totalMs),days:copyDays(record.days),currentId:broadcastId(record.currentId),currentMs:number(record.currentMs),sessions:(Array.isArray(record.sessions)?record.sessions:[]).slice(-MAX_SESSIONS).map(session=>({start:number(session.start),end:number(session.end),ms:number(session.ms),broadcastTitle:titleText(session.broadcastTitle),broadcastId:broadcastId(session.broadcastId)}))};
 }
 for(const [date,day]of Object.entries(value.days||{}).filter(([date])=>datePattern.test(date)).sort(([a],[b])=>b.localeCompare(a)).slice(0,MAX_DAYS))data.days[date]={watchMs:number(day.watchMs),ids:[...new Set((Array.isArray(day.ids)?day.ids:[]).filter(id=>Object.hasOwn(data.members,id)))].slice(0,MAX_MEMBERS)};
 const current=value.current;if(current&&broadcastId(current.id))data.current={id:broadcastId(current.id),title:titleText(current.title),startedAt:number(current.startedAt),active:current.active!==false,watchMs:number(current.watchMs),ids:[...new Set((Array.isArray(current.ids)?current.ids:[]).filter(id=>Object.hasOwn(data.members,id)))].slice(0,MAX_MEMBERS)};
 return data;
}
export function createWatchAnalytics(state,persist,{now=Date.now,flushMs=30000}={}){
 if(!state||typeof state!=='object'||typeof persist!=='function'||typeof now!=='function'||!Number.isFinite(flushMs)||flushMs<=0)throw Error('Invalid watch analytics configuration');
 const data=cleanStored(state.watchAnalytics);state.watchAnalytics=data;const active=new Map();let dirty=true,revision=1,pending=null,closed=false,persistenceError=false,lastPrunedDate=null,lastPruneAt=null,cachedSecond=null,cachedDate=null;
 const changed=()=>{dirty=true;revision++;};
 const at=()=>{const value=now();if(!Number.isSafeInteger(value)||value<0||value>8640000000000000)throw Error('Invalid analytics clock');return value;};
 function dateAt(time){const second=Math.floor(time/1000);if(second!==cachedSecond){cachedSecond=second;cachedDate=dayKey(time);}return cachedDate;}
 function prune(time){
  const today=dateAt(time),dateChanged=today!==lastPrunedDate;let removed=false;
  if(dateChanged){
   const cutoffDate=new Date(time);cutoffDate.setUTCDate(cutoffDate.getUTCDate()-(MAX_DAYS-1));const cutoff=dayKey(cutoffDate.getTime());
   for(const date of Object.keys(data.days))if(date<cutoff||date>today){delete data.days[date];removed=true;}
   for(const member of Object.values(data.members))for(const date of Object.keys(member.days))if(date<cutoff||date>today){delete member.days[date];removed=true;}lastPrunedDate=today;
  }
  if(dateChanged||lastPruneAt===null||time<lastPruneAt||time-lastPruneAt>=1000){for(const [id,last]of active)if(time-last.at>45000||time<last.at)active.delete(id);lastPruneAt=time;}
  if(removed)changed();
 }
 function day(date){return data.days[date]||= {watchMs:0,ids:[]};}
 function unique(date,id){const bucket=day(date);if(!bucket.ids.includes(id))bucket.ids.push(id);if(!data.current.ids.includes(id))data.current.ids.push(id);}
 function credit(id,member,previous,time){
  const gap=time-previous.at;if(gap<0||gap>45000||previous.broadcastId!==data.current?.id)return 0;
  const duration=Math.min(gap,30000);let start=previous.at,end=start+duration;
  while(start<end){
   const date=dayKey(start);let until=end;
   if(dayKey(end-1)!==date){let low=start+1,high=end;while(low<high){const middle=Math.floor((low+high)/2);if(dayKey(middle)===date)low=middle+1;else high=middle;}until=low;}
   const elapsed=until-start,bucket=day(date);bucket.watchMs=add(bucket.watchMs,elapsed);member.days[date]=add(member.days[date],elapsed);unique(date,id);start=until;
  }
  member.totalMs=add(member.totalMs,duration);member.currentMs=add(member.currentMs,duration);data.current.watchMs=add(data.current.watchMs,duration);
  const session=member.sessions.at(-1);if(session&&session.broadcastId===previous.broadcastId){session.end=time;session.ms=add(session.ms,duration);}
  return duration;
 }
 function binding(a,time){
  if(!a||a.owner||a.limited||!idText(a.id))return null;
  const record=(Array.isArray(state.members)?state.members:[]).find(item=>item.id===a.id)||(Array.isArray(state.invites)?state.invites:[]).find(item=>item.id===a.id);
  return record&&!record.revoked&&(!Number.isFinite(record.expires)||record.expires>time)?record:null;
 }
 function beginBroadcast(value={}){
  if(closed)return false;const id=broadcastId(value.id);if(!id)throw Error('Invalid broadcast analytics ID');const time=at();prune(time);
  if(data.current?.id===id){if(!data.current.active){data.current.active=true;changed();}return false;}
  active.clear();data.current={id,title:titleText(value.title),startedAt:Math.min(time,number(value.startedAt)||time),active:true,watchMs:0,ids:[]};
  for(const member of Object.values(data.members)){member.currentId=id;member.currentMs=0;}changed();return true;
 }
 function report(a,b={}){
  if(closed)return false;const time=at();prune(time);if(!binding(a,time)||!data.current?.active)return false;
  const id=a.id,last=active.get(id),previous=last&&time>=last.at&&time-last.at<=45000&&last.broadcastId===data.current.id?last:null,playing=b?.state==='playing';let member=data.members[id];if(last&&!previous)active.delete(id);
  if(!member){if(!playing||Object.keys(data.members).length>=MAX_MEMBERS)return false;member=data.members[id]={totalMs:0,days:Object.create(null),currentId:data.current.id,currentMs:0,sessions:[]};}
  if(member.currentId!==data.current.id){member.currentId=data.current.id;member.currentMs=0;}
  if(previous)credit(id,member,previous,time);
  if(playing){
   unique(dateAt(time),id);
   if(!previous){member.sessions.push({start:time,end:time,ms:0,broadcastId:data.current.id,broadcastTitle:data.current.title});member.sessions=member.sessions.slice(-MAX_SESSIONS);}
   active.delete(id);if(active.size>=MAX_ACTIVE)active.delete(active.keys().next().value);active.set(id,{at:time,broadcastId:data.current.id});
  }else active.delete(id);
  changed();return true;
 }
 function endBroadcast(){if(closed)return;active.clear();if(data.current?.active){data.current.active=false;changed();}}
 function summary(){
  const time=at();prune(time);const date=dateAt(time),today=data.days[date];
  return {current:{broadcastId:data.current?.id||null,title:data.current?.title||'',startedAt:data.current?.startedAt||null,active:data.current?.active||false,unique:data.current?.ids.length||0,watchSeconds:seconds(data.current?.watchMs||0)},day:{date,timeZone:TIME_ZONE,unique:today?.ids.length||0,watchSeconds:seconds(today?.watchMs||0)},total:{unique:Object.keys(data.members).length,watchSeconds:seconds(Object.values(data.members).reduce((sum,member)=>add(sum,member.totalMs),0))}};
 }
 function perMember(id){
  const time=at();prune(time);const member=idText(id)?data.members[id]:null;
  return {todaySeconds:seconds(member?.days[dateAt(time)]||0),currentSeconds:seconds(member?.currentId===data.current?.id?member?.currentMs||0:0),totalSeconds:seconds(member?.totalMs||0),sessions:(member?.sessions||[]).slice(-MAX_SESSIONS).map(session=>({start:session.start,end:session.end,seconds:seconds(session.ms),broadcastTitle:session.broadcastTitle}))};
 }
 function flush(){
  if(pending)return pending;if(!dirty)return Promise.resolve();const savedRevision=revision;dirty=false;
  pending=Promise.resolve().then(()=>persist()).then(()=>{persistenceError=false;if(revision!==savedRevision)dirty=true;}).catch(error=>{dirty=true;persistenceError=true;throw error;}).finally(()=>{pending=null;});return pending;
 }
 const timer=setInterval(()=>{try{prune(at());}catch{}void flush().catch(()=>{});},flushMs);timer.unref?.();
 return {beginBroadcast,endBroadcast,report,summary,perMember,flush,stats:()=>({members:Object.keys(data.members).length,days:Object.keys(data.days).length,active:active.size,persistenceError}),async close(){closed=true;clearInterval(timer);active.clear();while(dirty||pending)await flush();}};
}
