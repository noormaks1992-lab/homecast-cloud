import {randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {publicClientIP,canonicalIP} from './ip-policy.mjs';
export const shortKey=()=>randomBytes(9).toString('base64url');
export const hash=x=>createHash('sha256').update(x).digest('hex');
export function equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function cookies(req){const result=Object.create(null);for(const part of String(req.headers.cookie||'').split(';')){const at=part.indexOf('=');if(at<1)continue;const name=part.slice(0,at).trim(),value=part.slice(at+1).trim();if(name&&value.length<=4096&&!Object.hasOwn(result,name))result[name]=value;}return result;}
export function createRoom(state,persist){
 const instanceId=randomBytes(12).toString('hex');
 state.playlistAlias||=shortKey();state.stopped??=false;state.settings={name:'لمّة دشوف',chatEnabled:true,reactionsEnabled:true,slowSeconds:1,maxViewers:3,announcement:'',...state.settings};state.invites||=[];state.members??=[];if(!Array.isArray(state.members))throw Error('بيانات المشاهدين غير صالحة');
 let version=1,messages=state.roomHistory?.messages||[],reactions=state.roomHistory?.reactions||{like:0,love:0,heart:0},events=[],poll=state.roomHistory?.poll||null;const reactionPeople=new Map(state.roomHistory?.reactionPeople||[]),voteNames=new Map(state.roomHistory?.voteNames||[]);const votes=new Map(state.roomHistory?.votes||[]),active=new Map(),presence=new Map(),rates=new Map(),typing=new Map();
 let typingTimer=null;const listeners=new Set(),pendingMemberAuth=new Map(),memberTokens=new Map(state.members.filter(m=>typeof m.tokenHash==='string').map(m=>[m.tokenHash,m])),joinRates=new Map();let joinQueue=Promise.resolve(),joinWindow={at:Date.now(),count:0};
 state.ipBans=Array.isArray(state.ipBans)?state.ipBans.filter(x=>canonicalIP(x.ip)&&typeof x.memberId==='string').slice(-1000):[];let committedBans=state.ipBans;
 function isBanned(req){const address=publicClientIP(req);return !!address&&committedBans.some(x=>canonicalIP(x.ip)===address.ip);}
 function rememberIP(member,req){const address=publicClientIP(req);if(address)member.lastNetwork=address;}
 const memberAge=365*24*3600000;
 const normalizedUsername=value=>{if(typeof value!=='string')throw Error('أدخل اسم مستخدم');const name=value.normalize('NFKC').trim().toLowerCase();if(!/^[a-z0-9_]{3,24}$/.test(name))throw Error('اسم المستخدم من 3 إلى 24 حرفًا لاتينيًا أو رقمًا أو شرطة سفلية');if(['admin','administrator','owner','host','moderator','support','system','root','dshoof'].includes(name))throw Error('اسم المستخدم محجوز للإدارة');return name;};
 const cleanName=value=>{if(typeof value!=='string')throw Error('أدخل الاسم الظاهر');const name=value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu,'').trim();if([...name].length<2||[...name].length>32)throw Error('اختر اسمًا ظاهرًا من حرفين إلى 32 حرفًا');return name;};
 const roleName=value=>String(value||'').normalize('NFKC').replace(/[\p{M}\p{Cc}\p{Cf}\s\u0640]/gu,'').toLowerCase();
 function checkName(name,isOwner=false){if(!isOwner&&['المضيف','المالك','إدارة دشوف','مدير دشوف','admin','administrator','owner','host','moderator','support','system','dshoof',state.ownerProfile?.name].filter(Boolean).some(value=>roleName(value)===roleName(name)))throw Error('اختر اسمك الشخصي بعيدًا عن ألقاب الإدارة');return name;}
 const memberAuth=member=>pendingMemberAuth.get(member.id)||member;
 function memberSession(req){const value=cookies(req).dshoof_member;if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))return null;const record=memberTokens.get(hash(value));return record&&!memberAuth(record).revoked&&record.expires>Date.now()?{record,token:value}:null;}
 const publicMember=m=>({id:m.id,username:m.username,name:m.name,avatar:m.avatar||'purple',role:['viewer','stream','moderator','observer'].includes(memberAuth(m).role)?memberAuth(m).role:'viewer'});
 function joinRate(req){const now=Date.now(),key=req?.socket?.remoteAddress||'local';if(now-joinWindow.at>=600000)joinWindow={at:now,count:0};let record=joinRates.get(key);if(!record||now-record.at>=600000){if(joinRates.size>=2000){for(const[k,v]of joinRates)if(now-v.at>=600000)joinRates.delete(k);if(joinRates.size>=2000)throw Error('طلبات تسجيل كثيرة؛ حاول لاحقًا');}record={at:now,count:0};joinRates.set(key,record);}if(record.count>=12||joinWindow.count>=60)throw Error('طلبات تسجيل كثيرة؛ انتظر قليلًا ثم حاول');record.count++;joinWindow.count++;}
 async function join(b,req={headers:{},socket:{}}){
  if(isBanned(req))throw Object.assign(Error('حظر المضيف عنوان اتصالك'),{httpStatus:403});const existing=memberSession(req);if(existing)return {sessionCookie:existing.token,member:publicMember(existing.record)};
  const username=normalizedUsername(b.username),name=checkName(cleanName(b.name??b.displayName));joinRate(req);
  const operation=joinQueue.catch(()=>{}).then(async()=>{
   if(isBanned(req))throw Object.assign(Error('حظر المضيف عنوان اتصالك'),{httpStatus:403});if(state.members.length>=1000)throw Error('اكتمل سجل المشاهدين؛ تواصل مع المضيف');if(state.members.some(m=>m.username===username))throw Error('اسم المستخدم مستخدم؛ اختر اسمًا آخر. لا يمكن استعادة حساب بالاسم وحده');
   const secret=randomBytes(32).toString('base64url'),record={id:'m_'+randomBytes(12).toString('base64url'),username,name,avatar:['purple','gold','blue','green'].includes(b.avatar)?b.avatar:'purple',tokenHash:hash(secret),createdAt:Date.now(),expires:Date.now()+memberAge,revoked:false,muted:false,role:'viewer'};rememberIP(record,req);state.members.push(record);memberTokens.set(record.tokenHash,record);
   try{await persist();}catch(error){state.members=state.members.filter(m=>m!==record);memberTokens.delete(record.tokenHash);await persist().catch(()=>{});throw error;}
   bump();return {sessionCookie:secret,member:publicMember(record)};
  });joinQueue=operation.then(()=>{},()=>{});return operation;
 }
 function notify(type='room'){for(const listener of [...listeners]){try{const result=listener({version,type});result?.catch?.(()=>{});}catch{}}}
 function subscribe(listener){if(typeof listener!=='function')throw Error('مستمع غير صالح');if(listeners.size>=128)throw Error('اتصالات المحادثة كثيرة');listeners.add(listener);let closed=false;return ()=>{if(!closed){closed=true;listeners.delete(listener);}};}
 if(!state.roomHistory?.reactionPeople){state.legacyReactions={...reactions};reactions={like:0,love:0,heart:0};}
 // The permanent owner link is a bootstrap credential, never a browser cookie.
 // An ephemeral signing salt also invalidates all browser sessions after restart.
 let sessionSalt=randomBytes(32);const revokedSessions=new Map(),sessionAge=12*3600000;
 const signature=payload=>createHmac('sha256',sessionSalt).update(String(state.owner||'')).update('\0').update(payload).digest('base64url');
 function readOwnerSession(req){const value=cookies(req).dshoof_owner;if(typeof value!=='string'||value.length>256)return null;const parts=value.split('.');if(parts.length!==5||parts[0]!=='v1'||!parts.slice(1,3).every(v=>/^[a-z0-9]+$/.test(v))||!parts[3].match(/^[a-f0-9]{32}$/))return null;const issued=parseInt(parts[1],36),expires=parseInt(parts[2],36),now=Date.now(),payload=parts.slice(0,4).join('.');if(!Number.isSafeInteger(issued)||!Number.isSafeInteger(expires)||issued>now||expires<=now||expires-issued!==sessionAge||revokedSessions.has(parts[3])||!equal(parts[4],signature(payload)))return null;return {nonce:parts[3],expires};}
 const owner=req=>!!readOwnerSession(req);
 function ownerSession(){const now=Date.now(),payload=['v1',now.toString(36),(now+sessionAge).toString(36),randomBytes(16).toString('hex')].join('.');return payload+'.'+signature(payload);}
 function logout(req){const session=readOwnerSession(req),now=Date.now();for(const[k,v]of revokedSessions)if(v<=now)revokedSessions.delete(k);if(session)revokedSessions.set(session.nonce,session.expires);if(revokedSessions.size>2048){sessionSalt=randomBytes(32);revokedSessions.clear();}}

 function clean(){const cutoff=Date.now()-(state.pro?.config?.retentionHours||24)*3600000;messages=messages.filter(x=>x.at>=cutoff);if(state.roomHistory?.pinned?.at<cutoff)state.roomHistory.pinned=null;for(const [k,v]of active)if(Date.now()-v.at>30000)active.delete(k);for(const[k,v]of presence)if(Date.now()-v.at>45000)presence.delete(k);if(rates.size>2000)for(const[k,v]of rates)if(Date.now()-v>60000)rates.delete(k);}
 function touchPresence(connection,details){const previous=presence.get(connection)||{};if(!presence.has(connection)&&presence.size>=1000)presence.delete(presence.keys().next().value);presence.delete(connection);presence.set(connection,{...previous,...details,at:Date.now(),joined:previous.joined||Date.now()});}
 function access(req,url,{lease=false,legacy=false}={}){
  if(owner(req))return {owner:true,key:state.viewer,id:'owner',username:'owner',name:state.ownerProfile?.name||'المضيف'};
  if(isBanned(req))return null;
  if(legacy&&url.searchParams.has('key')){const explicit=legacyAccess(req,url);if(explicit)return explicit;}
  const session=memberSession(req);
  if(session){
   const member=session.record,connection=hash('member:'+member.id+':'+member.tokenHash);clean();touchPresence(connection,{member:member.id,name:member.name,username:member.username,avatar:member.avatar||'purple'});
   if(lease){if(!active.has(connection)&&active.size>=state.settings.maxViewers)return {limited:true,reason:'اكتمل عدد المشاهدين في الغرفة؛ حاول بعد خروج أحدهم.'};const previous=active.get(connection)||{};active.set(connection,{...previous,at:Date.now(),member:member.id,name:member.name,username:member.username,avatar:member.avatar||'purple',joined:previous.joined||Date.now()});}
   member.lastSeen=Date.now();rememberIP(member,req);return {...publicMember(member),member:true,connection,muted:!!memberAuth(member).muted};
  }
  return legacyAccess(req,url);
 }
 function legacyAccess(req,url){
  const c=cookies(req),k=url.searchParams.get('key')||c.dshoof_viewer||'';if(equal(k,state.viewer)||equal(k,state.playlistAlias))return {personal:true,key:k,id:'receiver',name:'المشاهد الخاص'};
  const invite=state.invites.find(x=>!x.revoked&&x.hash===hash(k)&&x.expires>Date.now());if(!invite)return null;clean();
  const device=req.viewerDevice||c.dshoof_device||hash((req.headers['x-forwarded-for']?.split(',')[0]||req.socket.remoteAddress)+(req.headers['user-agent']||'')),id=hash(invite.id+device),devices=[...active.values()].filter(x=>x.invite===invite.id);touchPresence(id,{invite:invite.id,name:invite.profileName||invite.name,avatar:invite.avatar||'purple'});
  if(!active.has(id)&&devices.length>=(invite.devices||1))return {limited:true,reason:'هذا الرابط مستخدم على جهاز آخر. اطلب من المضيف رابطًا خاصًا بك.'};if(!active.has(id)&&active.size>=state.settings.maxViewers)return {limited:true,reason:'اكتمل عدد المشاهدين في الغرفة؛ حاول بعد خروج أحدهم.'};
  const previous=active.get(id)||{};active.set(id,{...previous,at:Date.now(),invite:invite.id,name:invite.profileName||invite.name,avatar:invite.avatar||'purple',joined:previous.joined||Date.now()});return {key:k,id:invite.id,connection:id,name:invite.profileName||invite.name,avatar:invite.avatar||'purple',muted:!!invite.muted,role:invite.role||'viewer'};
 }
 function limit(id,action,ms){const k=id+':'+action,now=Date.now();if(now-(rates.get(k)||0)<ms)throw Error('انتظر قليلًا قبل المحاولة التالية');if(!rates.has(k)&&rates.size>=4096){for(const[key,at]of rates)if(now-at>60000)rates.delete(key);if(rates.size>=4096)throw Error('طلبات كثيرة؛ حاول بعد قليل');}rates.set(k,now);}
 function bump(){version++;state.roomHistory={messages,reactions,poll,votes:[...votes],voteNames:[...voteNames],reactionPeople:[...reactionPeople],pinned:state.roomHistory?.pinned||null};notify();}
 function displayName(id,fallback){return id==='owner'?(state.ownerProfile?.name||fallback||'المضيف'):(state.members.find(x=>x.id===id)?.name||state.invites.find(x=>x.id===id)?.profileName||state.invites.find(x=>x.id===id)?.name||fallback||'مشاهد');}
 function social(){const participants={like:[],love:[],heart:[]};for(const [id,v]of reactionPeople)for(const type of Object.keys(participants))if(v.types.includes(type))participants[type].push(displayName(id,v.name));return participants;}
 function snapshot(a,since){clean();return {instanceId,version,settings:state.settings,online:a?.owner?presence.size:null,roster:a?.owner?[...new Map([...presence.values()].map(x=>[x.member||x.invite,{name:x.name,username:x.username||'',avatar:x.avatar||'purple'}])).values()]:[],typing:[...typing.values()].filter(x=>Date.now()-x.at<5000&&x.id!==a?.id).map(x=>x.name),name:a?.name,username:a?.username||'',canManageChat:!!a?.owner,muted:a?.muted||false,role:a?.role||'viewer',avatar:a?.avatar||'purple',pinned:state.roomHistory?.pinned||null,...(Number(since)!==version?{messages,reactions,reactionNames:social(),myReactions:reactionPeople.get(a?.id)?.types||[],events,poll:poll?{id:poll.id,question:poll.question,options:poll.options,closed:poll.closed,counts:poll.options.map((_,i)=>[...votes.values()].filter(v=>v===i).length),voters:poll.options.map((_,i)=>[...votes].filter(([id,v])=>v===i).map(([id])=>displayName(id,voteNames.get(id)))),myVote:votes.get(a?.id)??null}:null}:{})};}
 function admin(origin){
  clean();const groups=new Map();
  // Merge each live connection once, then index by identity. The owner roster
  // remains linear even when many registered members are waiting for a stream.
  for(const connection of new Set([...presence.keys(),...active.keys()])){
   const lease=active.get(connection),visitor=presence.get(connection),value={...lease,...visitor};
   const {name,username,joined,at,report,info}=value,row={name,username,joined,at,report,info,watching:!!lease,watchAt:lease?.at};
   for(const kind of ['invite','member'])if(value[kind]!==undefined){const key=kind+':'+value[kind];let group=groups.get(key);if(!group){group={connections:[],info:null,report:null};groups.set(key,group);}group.connections.push(row);if(info&&(!group.info||(info.at||0)>(group.info.at||0)))group.info=info;if(report&&(!group.report||(report.at||0)>(group.report.at||0)))group.report=report;}
  }
  const status=(kind,id)=>{const group=groups.get(kind+':'+id),record=(kind==='member'?state.members:state.invites).find(x=>x.id===id);return {online:!!group?.connections.length,info:group?.info||record?.diagnostics?.info||null,report:group?.report||record?.diagnostics?.report||null,connections:group?.connections||[],lastSeen:record?.lastSeen||null,deletedAt:record?.deletedAt||null,network:record?.lastNetwork||null,ipBlocked:committedBans.some(x=>x.memberId===id),ipBanAvailable:!!record?.lastNetwork?.ip};};
  return [...state.invites.map(x=>({id:x.id,kind:'invite',name:x.name,displayName:x.profileName||x.name,avatar:x.avatar||'purple',expires:x.expires,expiresAt:x.expires,revoked:!!x.revoked,muted:!!x.muted,devices:x.devices||1,role:x.role||'viewer',url:x.slug?origin+'/w/'+x.slug:null,...status('invite',x.id)})),...state.members.map(m=>({...publicMember(m),kind:'member',displayName:m.name,createdAt:m.createdAt,joinedAt:m.createdAt,expires:m.expires,expiresAt:m.expires,revoked:!!m.revoked,muted:!!m.muted,url:null,...status('member',m.id)}))];
 }
 async function invite(b,origin){state.invites=state.invites.filter(x=>!x.revoked&&x.expires>Date.now()).slice(-49);const key=shortKey();const record={id:shortKey(),slug:key,hash:hash(key),name:String(b.name||'صديق').trim().slice(0,40)||'صديق',expires:Date.now()+Math.min(720,Math.max(1,Number(b.hours)||24))*3600000,role:['viewer','stream','moderator','observer'].includes(b.role)?b.role:'viewer',devices:Math.min(3,Math.max(1,Math.floor(Number(b.devices)||1)))};state.invites.push(record);await persist();bump();return {url:origin+'/w/'+key,id:record.id,expires:record.expires};}
 async function moderateNow(b){
  const records=b.action==='all'?[...state.invites,...state.members]:[state.members.find(x=>x.id===b.id)||state.invites.find(x=>x.id===b.id)];if(records.some(value=>!value))throw Error('المشاهد غير موجود');
  const field=b.action==='mute'?'muted':'revoked',previous=records.map(record=>({record,had:Object.hasOwn(record,field),value:record[field]})),memberRecords=new Set(state.members),members=records.filter(record=>memberRecords.has(record));
  for(const member of members)pendingMemberAuth.set(member.id,{role:member.role,revoked:!!member.revoked,muted:!!member.muted});
  for(const record of records)record[field]=field==='muted'?!record.muted:true;
  try{await persist();}catch(error){for(const old of previous)if(old.had)old.record[field]=old.value;else delete old.record[field];for(const member of members)pendingMemberAuth.delete(member.id);await persist().catch(()=>{});throw error;}
  for(const member of members)pendingMemberAuth.delete(member.id);
  if(b.action==='all'){active.clear();presence.clear();typing.clear();}else if(b.action!=='mute'){typing.delete(b.id);for(const[k,v]of active)if(v.invite===b.id||v.member===b.id)active.delete(k);for(const[k,v]of presence)if(v.invite===b.id||v.member===b.id)presence.delete(k);}
  bump();
 }
 async function moderate(b){if(b.action==='all'||state.members.some(member=>member.id===b.id)){const operation=joinQueue.catch(()=>{}).then(()=>moderateNow(b));joinQueue=operation.then(()=>{},()=>{});return operation;}return moderateNow(b);}
 async function manageMember(a,b){
  if(a?.owner!==true)throw Error('إدارة الحسابات للمالك فقط');
  if(!b||!['update','restore','mute','delete','ban-ip','unban-ip'].includes(b.action)||typeof b.id!=='string')throw Error('إجراء الحساب غير صالح');
  const operation=joinQueue.catch(()=>{}).then(async()=>{
   const member=state.members.find(value=>value.id===b.id);if(!member)throw Error('حساب المشاهد غير موجود');
   const changes={},previousBans=state.ipBans;
   if(b.action==='update'){
    changes.username=b.username===undefined?member.username:normalizedUsername(b.username);changes.name=checkName(cleanName(b.name??b.displayName??member.name));
    if(state.members.some(value=>value.id!==member.id&&value.username===changes.username))throw Error('اسم المستخدم مستخدم؛ اختر اسمًا آخر');
    if(b.avatar!==undefined&&!['purple','gold','blue','green'].includes(b.avatar))throw Error('اختر صورة رمزية صالحة');changes.avatar=b.avatar??member.avatar??'purple';
    if(b.role!==undefined&&!['viewer','stream','moderator'].includes(b.role))throw Error('صلاحية الحساب غير صالحة');changes.role=b.role??publicMember(member).role;
   }else if(b.action==='restore'){changes.revoked=false;changes.deletedAt=null;}
   else if(b.action==='delete'){changes.revoked=true;changes.deletedAt=Date.now();}
   else if(b.action==='ban-ip'){const ip=canonicalIP(member.lastNetwork?.ip);if(!ip)throw Error('لم يتم التحقق من عنوان العميل؛ يجب ضبط بروكسي الاستضافة قبل حظر IP');if(state.ipBans.length>=1000)throw Error('قائمة حظر الشبكات ممتلئة');changes.revoked=true;state.ipBans=[...state.ipBans.filter(x=>!(x.ip===ip&&x.memberId===member.id)),{ip,memberId:member.id,at:Date.now()}];}
   else if(b.action==='unban-ip'){state.ipBans=state.ipBans.filter(x=>x.memberId!==member.id);changes.revoked=false;}
   else{if(b.muted!==undefined&&typeof b.muted!=='boolean')throw Error('حالة الكتم غير صالحة');changes.muted=b.muted??!member.muted;}
   const previous=Object.fromEntries(Object.keys(changes).map(key=>[key,{had:Object.hasOwn(member,key),value:member[key]}]));pendingMemberAuth.set(member.id,{role:member.role,revoked:!!member.revoked,muted:!!member.muted});Object.assign(member,changes);
   try{await persist();}catch(error){state.ipBans=previousBans;for(const[key,old]of Object.entries(previous))if(old.had)member[key]=old.value;else delete member[key];pendingMemberAuth.delete(member.id);await persist().catch(()=>{});throw error;}
   pendingMemberAuth.delete(member.id);committedBans=state.ipBans;
   if(member.revoked)for(const map of [active,presence])for(const[k,v]of map)if(v.member===member.id)map.delete(k);
   for(const map of [active,presence])for(const value of map.values())if(value.member===member.id)Object.assign(value,{name:member.name,username:member.username,avatar:member.avatar||'purple'});
   if(member.muted)typing.delete(member.id);else if(typing.has(member.id))typing.get(member.id).name=member.name;
   bump();return {member:{...publicMember(member),revoked:!!member.revoked,muted:!!member.muted}};
  });joinQueue=operation.then(()=>{},()=>{});return operation;
 }
 async function settings(b){const s=state.settings;if(typeof b.name==='string')s.name=b.name.trim().slice(0,60)||'لمّة دشوف';for(const k of ['chatEnabled','reactionsEnabled'])if(typeof b[k]==='boolean')s[k]=b[k];if(b.slowSeconds!==undefined)s.slowSeconds=Math.min(60,Math.max(1,Number(b.slowSeconds)||3));if(b.maxViewers!==undefined)s.maxViewers=Math.min(30,Math.max(1,Math.floor(Number(b.maxViewers)||3)));if(typeof b.announcement==='string')s.announcement=b.announcement.slice(0,300);await persist();bump();}
 function chat(a,b){if(!state.settings.chatEnabled)throw Error('الدردشة مغلقة من المضيف');if(a.muted)throw Error('أوقف المضيف مشاركتك في الدردشة');limit(a.id,'chat',a.owner?500:state.settings.slowSeconds*1000);const text=String(b.text||'').trim().slice(0,400);if(!text)throw Error('اكتب رسالة أولًا');const reply=messages.find(x=>x.id===b.replyTo);messages.push({id:shortKey(),reply:reply?{name:reply.name,text:reply.text.slice(0,100)}:null,name:a.name,username:a.username||'',owner:!!a.owner,text,spoiler:!!b.spoiler,stand:['home','away'].includes(b.stand)?b.stand:'all',videoAt:Math.max(Date.now()-600000,Math.min(Date.now()+30000,Number(b.videoAt)||Date.now())),at:Date.now()});messages=messages.slice(-100);bump();}
 function react(a,b){if(!state.settings.reactionsEnabled)throw Error('التفاعلات مغلقة');if(!['like','love','heart'].includes(b.type))throw Error('تفاعل غير معروف');const person=reactionPeople.get(a.id)||{name:a.name,types:[]};if(person.types.includes(b.type))return false;limit(a.id,'react',800);person.types.push(b.type);person.name=a.name;reactionPeople.set(a.id,person);reactions[b.type]++;events.push({id:shortKey(),type:b.type,at:Date.now()});events=events.filter(x=>Date.now()-x.at<10000).slice(-12);bump();return true;}
 async function profile(a,b){
  limit(a.id,'profile',5000);const name=checkName(cleanName(b.name??b.displayName),a.owner),avatar=['purple','gold','blue','green'].includes(b.avatar)?b.avatar:'purple';
  if(a.member||state.members.some(m=>m.id===a.id)){
   const operation=joinQueue.catch(()=>{}).then(async()=>{const member=state.members.find(m=>m.id===a.id&&!m.revoked);if(!member)throw Error('انتهت جلسة المشاهدة');const username=b.username===undefined?member.username:normalizedUsername(b.username);if(state.members.some(m=>m.id!==a.id&&m.username===username))throw Error('اسم المستخدم مستخدم؛ اختر اسمًا آخر');const previous={name:member.name,username:member.username,avatar:member.avatar};Object.assign(member,{name,username,avatar});try{await persist();}catch(error){Object.assign(member,previous);await persist().catch(()=>{});throw error;}for(const map of [active,presence])for(const value of map.values())if(value.member===a.id)Object.assign(value,{name,username,avatar});bump();});joinQueue=operation.then(()=>{},()=>{});return operation;
  }
  if(a.owner)state.ownerProfile={name,avatar};else{if(state.invites.some(x=>x.id!==a.id&&!x.revoked&&(x.profileName||x.name)===name))throw Error('الاسم مستخدم، أضف علامة تميزك');const invite=state.invites.find(x=>x.id===a.id);if(!invite)throw Error('سجل دخولك لتغيير الاسم');invite.profileName=name;invite.avatar=avatar;}
  for(const map of [active,presence])for(const value of map.values())if(value.invite===a.id){value.name=name;value.avatar=avatar;}await persist();bump();
 }
 function scheduleTypingExpiry(){clearTimeout(typingTimer);if(!typing.size)return;const delay=Math.max(1,Math.min(...[...typing.values()].map(value=>value.at+5000-Date.now())));typingTimer=setTimeout(()=>{for(const[key,value]of typing)if(Date.now()-value.at>=5000)typing.delete(key);notify('typing');scheduleTypingExpiry();},delay);typingTimer.unref?.();}
 function type(a){if(a.muted||!state.settings.chatEnabled)return;if(typing.size>=100&&!typing.has(a.id)){for(const[k,v]of typing)if(Date.now()-v.at>5000)typing.delete(k);if(typing.size>=100)typing.delete(typing.keys().next().value);}typing.set(a.id,{id:a.id,name:a.name,at:Date.now()});notify('typing');scheduleTypingExpiry();}
 function pin(a,b){if(!a.owner&&a.role!=='moderator')throw Error('تثبيت الرسائل للمشرف');const m=messages.find(x=>x.id===b.id);state.roomHistory??={};state.roomHistory.pinned=m?{name:m.name,text:m.text,id:m.id,videoAt:m.videoAt,stand:m.stand,at:m.at}:null;bump();}
 const finite=(value,min,max,fallback=0)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Number(value))):fallback;
 const detailText=(value,max=80)=>typeof value==='string'?value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu,'').trim().slice(0,max):'';
 function clientDetails(details){
  const input=details?.clientInfo?.shared===true?details.clientInfo:{},info={at:Date.now(),shared:details?.clientInfo?.shared===true};for(const key of ['device','browser','os','timezone','locale']){const value=detailText(input[key],key==='locale'?40:80);if(value)info[key]=value;}
  if(input.screen&&typeof input.screen==='object')info.screen={width:finite(input.screen.width,0,16384),height:finite(input.screen.height,0,16384),pixelRatio:finite(input.screen.pixelRatio,0.1,16,1)};
  if(input.battery&&typeof input.battery==='object')info.battery={level:finite(input.battery.level,0,100),charging:input.battery.charging===true};
  if(input.network&&typeof input.network==='object'){const network=input.network;info.network={type:detailText(network.type,24),effectiveType:['slow-2g','2g','3g','4g'].includes(network.effectiveType)?network.effectiveType:'',downlink:finite(network.downlink,0,10000),rtt:finite(network.rtt,0,60000),saveData:network.saveData===true};}
  if(input.shared===true)info.subscription=['unspecified','fiber','mobile','dsl','wifi'].includes(input.subscription)?input.subscription:'unspecified';
  if(input.location&&typeof input.location==='object'&&Number.isFinite(input.location.latitude)&&Number.isFinite(input.location.longitude)&&Math.abs(input.location.latitude)<=90&&Math.abs(input.location.longitude)<=180)info.location={latitude:input.location.latitude,longitude:input.location.longitude,accuracy:finite(input.location.accuracy,0,100000)};
  if(typeof details?.ip==='string'&&isIP(details.ip)){info.ip=details.ip;info.ipSource=details.ipSource==='trusted-proxy'?'trusted-proxy':'socket';}return info;
 }
 function applyPrivacy(info,policy={}){if(policy.device===false)return {at:info.at,shared:false,...(info.ip?{ip:info.ip,ipSource:info.ipSource}:{})};if(policy.location===false)delete info.location;return info;}
 function privacy(a,b){
  if(!a.connection)return {ok:true};let visitor=presence.get(a.connection),lease=active.get(a.connection);if(!visitor){touchPresence(a.connection,{...(a.member?{member:a.id}:{invite:a.id}),name:a.name,username:a.username,avatar:a.avatar||'purple'});visitor=presence.get(a.connection);}
  const record=(a.member?state.members:state.invites).find(x=>x.id===a.id),policy={...(record?.privacyPolicy||{}),...(visitor?.privacyPolicy||lease?.privacyPolicy||{})};
  if(typeof b.persist==='boolean')policy.persist=b.persist;
  if(typeof b.device==='boolean'){policy.device=b.device;if(!b.device||policy.location!==true)policy.location=false;}
  if(typeof b.location==='boolean')policy.location=b.location&&policy.device!==false;
  if(record){record.privacyPolicy={...policy,updatedAt:Date.now()};if(record.diagnostics?.info)record.diagnostics.info=applyPrivacy({...record.diagnostics.info},policy);if(policy.persist===false&&record.diagnostics)record.diagnostics.info=applyPrivacy(record.diagnostics.info||{},{device:false});}
  for(const slot of [visitor,lease])if(slot){slot.privacyPolicy={...policy};if(slot.info)slot.info=applyPrivacy({...slot.info},policy);}return {ok:true};
 }
 function report(a,b,details){limit(a.id,'report',5000);if(a.connection){const visitor=presence.get(a.connection),lease=active.get(a.connection);if(!visitor&&!lease)return;const report={state:['playing','buffering','paused','error','youtube'].includes(b.state)?b.state:'unknown',buffer:finite(b.buffer,0,300),height:finite(b.height,0,1080),dropped:finite(b.dropped,0,1000000000),startupMs:finite(b.startupMs,0,60000),stalls:finite(b.stalls,0,1000000),help:!!b.help,at:Date.now()},record=(a.member?state.members:state.invites).find(x=>x.id===a.id),policy=record?.privacyPolicy||visitor?.privacyPolicy||lease?.privacyPolicy||{},info=details?applyPrivacy(clientDetails(details),policy):undefined;for(const slot of [visitor,lease])if(slot){slot.report=report;if(info)slot.info=info;}if(record){const old=record.diagnostics?.info||{},retained=info?applyPrivacy({...old,...info},policy.persist===true?policy:{device:false}):old;record.diagnostics={info:retained,report};record.lastSeen=Date.now();}}}
 function clear(b){if(b.id)messages=messages.filter(x=>x.id!==b.id);else messages=[];if(state.roomHistory?.pinned&&!messages.some(x=>x.id===state.roomHistory.pinned.id))state.roomHistory.pinned=null;bump();}
 function polling(a,b){if(b.action==='create'){if(!a.owner)throw Error('للمضيف فقط');const options=(b.options||[]).map(x=>String(x).trim().slice(0,70)).filter(Boolean).slice(0,4);if(options.length<2)throw Error('أدخل خيارين على الأقل');poll={id:shortKey(),question:String(b.question||'').trim().slice(0,160)||'ما رأيكم؟',options,closed:false};votes.clear();voteNames.clear();}else if(b.action==='close'){if(!a.owner)throw Error('للمضيف فقط');if(poll)poll.closed=true;}else{if(!poll||poll.closed)throw Error('التصويت مغلق');const choice=Number(b.choice);if(!Number.isInteger(choice)||!poll.options[choice])throw Error('خيار غير صالح');votes.set(a.id,choice);voteNames.set(a.id,a.name);}bump();}
 return {join,subscribe,profile,type,pin,owner,ownerSession,logout,access,snapshot,admin,invite,moderate,manageMember,settings,chat,react,report,clear,polling,bump,limit,active,presence,privacy};
}

