const $=id=>document.getElementById(id);let state={},room={},hls=null,revision='',running=false,paused=false,refreshing=false,initialized=false,generation=0,recoveryTimer,sleepTimer,wakeLock,wantWake=false,warmController=null,playbackMonitor=null,pollTimer=null,pollFailures=0;const seen=new Set();let replyTo=null,lastTyping=0;let joining=false,chatSending=false,chatTogglePending=false,roomEvents=null,reconnectTimer=null,eventFailures=0,eventsConnected=false,pageLeaving=false;const chatNodes=new Map();let refreshRequest=null;let typingTimer,batteryPromise=null,sharedLocation=null,locationRequest=0,locationBusy=false,telemetryAllowed=true,privacyChanging=false,privacyQueue=Promise.resolve();
let channelChosen=false,sourceFormChannel=null,telegramFormChannel=null;let activeChannel='1';try{activeChannel=localStorage.getItem('dshoof-channel')==='2'?'2':'1';}catch{}
const memberNodes=new Map(),memberActionPending=new Set();let memberPage=0,memberEditId=null,memberDetailsId=null,memberEditPending=false,memberDetailsSignature='';let hadOwnerControls=false;
let noticeTimer;const notice=t=>{clearTimeout(noticeTimer);$('notice').textContent=t;$('notice').hidden=!t;if(t)noticeTimer=setTimeout(()=>{$('notice').hidden=true;},12000);};
async function api(path,body){if(path.startsWith('/api/status')||path==='/api/pro')path+=(path.includes('?')?'&':'?')+'channel='+activeChannel;if(body!==undefined&&['/api/select','/api/stop','/api/resume','/api/channel-name','/api/report','/api/telegram/config','/api/telegram/start','/api/telegram/stop'].includes(path))body={...body,channel:activeChannel};const response=await fetch(path,{...(body!==undefined?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(35000),cache:'no-store'});let data;try{data=await response.json();}catch{throw Error('تعذر الاتصال بالخادم، حاول مجددًا');}if(!response.ok)throw Error(data.error||'تعذر إكمال الطلب');return data;}
async function action(path,body){try{const r=await api(path,body);if(r.room)applyRoom(r.room);if(!r.room||!['/api/chat','/api/react','/api/poll','/api/chat/pin','/api/chat/clear','/api/settings'].includes(path))await refresh({afterCurrent:true});return r;}catch(e){notice(e.message);return null;}}
function button(text,fn,cls){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=fn;if(cls)b.className=cls;return b;}
function text(tag,value,cls){const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e;}
function controlLabel(id,value,iconName){const control=$(id);if(!control)return;let label=control.querySelector('span');if(label)label.textContent=value;else if(control.querySelector('svg')){label=text('span',value);control.append(label);}else control.textContent=value;const use=control.querySelector('use');if(use&&iconName)use.setAttribute('href','/club-icons.svg#'+iconName);}
async function copy(value){try{await navigator.clipboard.writeText(value);notice('تم نسخ الرابط');}catch{notice('تعذر النسخ التلقائي؛ انسخ الرابط من خانته');}}

function needsRegistration(){return !state.canControl&&(state.registrationRequired===true||state.authenticated===false);}
function publicRoomURL(){try{const url=new URL(state.publicRoomURL||'/',location.origin);return (url.origin===location.origin?url.origin:location.origin)+'/';}catch{return location.origin+'/';}}
function renderPublicEntry(){
 const link=$('public-room-link');if(link)link.value=publicRoomURL();
 const dialog=$('welcome-dialog'),required=needsRegistration();
 if($('welcome-close')){$('welcome-close').hidden=required;$('welcome-close').disabled=required;}
 if($('welcome-join-open'))$('welcome-join-open').hidden=!required;
 if(!dialog)return;
 if(required&&!dialog.open){if(dialog.showModal)dialog.showModal();else{dialog.hidden=false;dialog.open=true;}$('welcome-username')?.focus();}
 else if(!required&&dialog.open){if(dialog.close)dialog.close();else{dialog.hidden=true;dialog.open=false;}}
}
async function joinRoom(event){
 event.preventDefault();if(joining)return;
 joining=true;$('welcome-submit').disabled=true;$('welcome-error').textContent='';$('welcome-error').hidden=true;
 try{await api('/api/join',{username:$('welcome-username').value.trim(),name:$('welcome-name').value.trim(),avatar:$('welcome-avatar').value});await refresh({afterCurrent:true});if(needsRegistration())throw Error('تعذر تثبيت جلستك؛ حاول مرة أخرى.');report();}
 catch(error){$('welcome-error').textContent=error.message;$('welcome-error').hidden=false;}
 finally{joining=false;$('welcome-submit').disabled=false;}
}
function mergeRoom(update){
 if(!update||typeof update!=='object'||Array.isArray(update))return false;
 const reset=!!update.instanceId&&!!room.instanceId&&update.instanceId!==room.instanceId;
 if(!reset&&Number.isFinite(update.version)&&Number.isFinite(room.version)&&update.version<room.version)return false;
 const next=reset?{...update}:{...room,...update};
 if(update.messagesDelta&&!Object.hasOwn(update,'messages')){
  const removed=new Set(update.messagesDelta.removed||[]),messages=new Map((room.messages||[]).filter(message=>!removed.has(message.id)).map(message=>[message.id,message]));
  for(const message of update.messagesDelta.added||[])if(message&&typeof message.id==='string'&&!removed.has(message.id))messages.set(message.id,message);
  next.messages=[...messages.values()].slice(-100);
 }
 if(Object.hasOwn(update,'messages'))next.messages=[...new Map((update.messages||[]).filter(message=>message&&typeof message.id==='string').map(message=>[message.id,message])).values()];
 delete next.messagesDelta;room=next;state.room=room;
 if(state.profile)state.profile={...state.profile,...(room.name?{name:room.name}:{}),...(room.username?{username:room.username}:{}),...(room.avatar?{avatar:room.avatar}:{})};
 return true;
}
function applyRoom(update){
 if(!mergeRoom(update))return;
 renderRoom();if(Object.hasOwn(update,'messages')||update.messagesDelta)renderChat();
 if(Object.hasOwn(update,'poll'))renderPoll();
 if(Object.hasOwn(update,'reactionNames')||Object.hasOwn(update,'myReactions'))renderReactionNames();
}
function stopRoomEvents(){clearTimeout(reconnectTimer);reconnectTimer=null;const previous=roomEvents;roomEvents=null;eventsConnected=false;previous?.close();}
function connectRoomEvents(){
 if(pageLeaving||!state.authorized||needsRegistration()||!window.EventSource||roomEvents||reconnectTimer||navigator.onLine===false)return;
 const stream=new window.EventSource('/api/events');roomEvents=stream;
 stream.onopen=()=>{if(roomEvents!==stream)return;eventsConnected=true;eventFailures=0;};
 stream.addEventListener('room',event=>{if(roomEvents!==stream||pageLeaving)return;try{const value=JSON.parse(event.data),update=value.room||value;applyRoom(update);}catch{}});
 stream.onerror=()=>{if(roomEvents!==stream)return;stream.close();roomEvents=null;eventsConnected=false;if(pageLeaving||!state.authorized)return;const delay=Math.max(document.hidden?15000:1000,Math.min(30000,1000*2**Math.min(eventFailures++,5)));reconnectTimer=setTimeout(()=>{reconnectTimer=null;connectRoomEvents();},delay);};
}
function statusPollDelay(){return Math.min(60000,(document.hidden?30000:10000)*2**Math.min(pollFailures,3));}
async function pollStatus(){if(pageLeaving)return;await refresh();if(!pageLeaving)pollTimer=setTimeout(pollStatus,statusPollDelay());}
function watchDuration(seconds){const value=Math.max(0,Number(seconds)||0);if(value<60)return Math.round(value)+' ثانية';if(value<3600)return Math.floor(value/60)+' دقيقة';return Math.floor(value/3600)+':'+String(Math.floor(value%3600/60)).padStart(2,'0')+' ساعة';}
function renderOwnerAnalytics(){
 const panel=$('owner-analytics');if(panel)panel.hidden=!state.canControl||!!window.dshoofStudio&&(document.body.dataset.page!=='admin'||document.body.dataset.adminTab!=='analytics');const fields={'analytics-current-viewers':state.analytics?.current?.unique,'analytics-today-viewers':state.analytics?.day?.unique,'analytics-total-viewers':state.analytics?.total?.unique,'analytics-total-hours':(Math.max(0,Number(state.analytics?.total?.watchSeconds)||0)/3600).toFixed(1)};
 for(const [id,value]of Object.entries(fields))if($(id))$(id).textContent=state.canControl?String(value??0):'';
}
function memberInfo(member){return member.info||(member.connections||[]).find(connection=>connection.info)?.info||{};}
function memberDate(value){return value?new Date(value).toLocaleString('ar-IQ'):'غير متاح';}
function showMemberDetails(member){
 if(!state.canControl)return;const dialog=$('viewer-details-dialog'),body=$('viewer-details-body');if(!dialog||!body)return;
 memberDetailsId=member.id||null;memberDetailsSignature=JSON.stringify(member);
 $('viewer-details-title').textContent=member.name||member.username||'تفاصيل العضو';body.replaceChildren();const info=memberInfo(member),client=info.clientInfo||info,report=member.report||(member.connections||[]).find(connection=>connection.report)?.report||{};
 const row=(label,value)=>{const item=text('div','','member-detail');item.append(text('strong',label),text('span',value===undefined||value===null||value===''?'غير متاح':String(value)));body.append(item);};
 row('اسم المستخدم',member.username?'@'+member.username:null);row('الاسم',member.name);row('تاريخ الانضمام',memberDate(member.joinedAt||member.createdAt));row('آخر تقرير',memberDate(report.at||info.at));row('آخر دخول',memberDate(member.lastSeen));row('الحالة',member.deletedAt?'محذوف':member.revoked?'محظور':member.online?'متصل':'غير متصل');
 row('الجهاز',client.device);row('المتصفح',client.browser);row('نظام التشغيل',client.os);row('عنوان الشبكة',member.network?.ip||info.ip);row('مصدر عنوان الشبكة',({'socket':'عنوان الاتصال بالخادم (قد يكون بروكسي الاستضافة)','trusted-proxy':'عنوان يمر عبر بروكسي موثوق'})[info.ipSource]);row('الشاشة',client.screen?client.screen.width+' × '+client.screen.height:null);row('البطارية',client.battery?Math.round(client.battery.level)+'%'+(client.battery.charging?' · تشحن':''):null);
 row('نوع الاتصال',client.network?.effectiveType||client.network?.type);row('تقدير المتصفح للاتصال',Number.isFinite(client.network?.downlink)?client.network.downlink+' ميغابت/ث (تقدير وليس اختبار سرعة)':null);row('تقدير زمن الاستجابة',Number.isFinite(client.network?.rtt)?client.network.rtt+' مللي ثانية':null);row('توفير البيانات',client.network?client.network.saveData?'مفعّل':'غير مفعّل':null);
 row('شركة الإنترنت والباقه','غير متاحة من المتصفح');row('وصف الاتصال الذي اختاره العضو',({fiber:'ألياف ضوئية',mobile:'بيانات هاتف',dsl:'DSL',wifi:'واي فاي'})[client.subscription]);row('المنطقة الزمنية',client.timezone);row('اللغة',client.locale);row('الموقع الذي شاركه العضو',client.location?client.location.latitude+', '+client.location.longitude+' · دقة الجهاز '+Math.round(client.location.accuracy||0)+' م':null);row('مخزون الفيديو',Number.isFinite(report.buffer)?Math.round(report.buffer)+' ثوانٍ':null);
 const analytics=member.analytics;if(analytics){row('مدة المشاهدة في البث الحالي · تقريبية',watchDuration(analytics.currentSeconds));row('مدة المشاهدة اليوم · تقريبية',watchDuration(analytics.todaySeconds));row('إجمالي مدة المشاهدة · تقريبية',watchDuration(analytics.totalSeconds));const sessions=Array.isArray(analytics.sessions)?analytics.sessions.slice(-20).reverse():[];if(sessions.length){body.append(text('h3','جلسات المشاهدة الأخيرة · مدد تقريبية'));const list=text('ul','','member-sessions');for(const session of sessions)list.append(text('li',(session.broadcastTitle||'بث دشوف')+' · '+memberDate(session.start)+' — '+(session.end?memberDate(session.end):'قيد المشاهدة')+' · '+watchDuration(session.seconds)));body.append(list);}}
 const place=client.location;if(place&&Number.isFinite(place.latitude)&&Number.isFinite(place.longitude)&&Math.abs(place.latitude)<=90&&Math.abs(place.longitude)<=180){const map=text('a','عرض الموقع المشترك على الخريطة','button');map.href='https://www.openstreetmap.org/?mlat='+place.latitude+'&mlon='+place.longitude+'#map=12/'+place.latitude+'/'+place.longitude;map.target='_blank';map.rel='noopener noreferrer';body.append(map);}
 if(!dialog.open)dialog.showModal?.();
}
function currentMember(id){return state.canControl?(state.members||[]).find(member=>member.id===id):undefined;}
function filteredMembers(){
 if(!state.canControl)return [];const query=($('members-search')?.value||'').normalize('NFKC').trim().toLocaleLowerCase(),filter=$('members-filter')?.value||'all';
 return (state.members||[]).filter(member=>(!query||[member.username,member.name,member.displayName].some(value=>String(value||'').normalize('NFKC').toLocaleLowerCase().includes(query)))&&(filter==='deleted'?!!member.deletedAt:!member.deletedAt&&(filter==='online'?!!member.online&&!member.revoked:filter==='muted'?!!member.muted:filter==='blocked'?!!member.revoked||!!member.ipBlocked:true)));
}
function memberFocus(id){const entry=memberNodes.get(id),target=entry?.node.parentNode===$('members-list')?entry.title:$('members-heading')||$('members-search');target?.focus();}
function closeMemberDetails(){const dialog=$('viewer-details-dialog');if(dialog?.open)dialog.close();}
function closeMemberEditor(){if(memberEditPending)return;const dialog=$('member-edit-dialog');if(dialog?.open)dialog.close();}
function openMemberEditor(id){
 const member=currentMember(id),dialog=$('member-edit-dialog');if(!member||!dialog||memberEditPending)return;memberEditId=id;
 for(const [field,value]of Object.entries({id,username:member.username||'',name:member.name||member.displayName||'',avatar:member.avatar||'purple',role:['viewer','stream','moderator'].includes(member.role)?member.role:'viewer'}))if($('member-edit-'+field))$('member-edit-'+field).value=value;
 $('member-edit-error').textContent='';$('member-edit-error').hidden=true;if(!dialog.open)dialog.showModal?.();$('member-edit-username')?.focus();
}
async function submitMemberEdit(event){
 event.preventDefault();if(!state.canControl||memberEditPending||!memberEditId||!currentMember(memberEditId))return;const error=$('member-edit-error');
 const username=$('member-edit-username').value.normalize('NFKC').trim().toLowerCase(),name=$('member-edit-name').value.normalize('NFKC').trim(),avatar=$('member-edit-avatar').value,role=$('member-edit-role').value;
 if(!/^[a-z0-9_]{3,24}$/.test(username)||[...name].length<2||[...name].length>32||!['purple','gold','blue','green'].includes(avatar)||!['viewer','stream','moderator'].includes(role)){
  error.textContent='تحقق من الاسم واسم المستخدم والصورة والصلاحية المختارة.';error.hidden=false;return;
 }
 const id=memberEditId;memberEditPending=true;$('member-edit-submit').disabled=true;$('member-edit-close').disabled=true;error.textContent='';error.hidden=true;
 try{const result=await api('/api/members',{action:'update',id,username,name,avatar,role});if(result.room)applyRoom(result.room);await refresh({afterCurrent:true});if(memberEditId===id)$('member-edit-dialog').close();}
 catch(failure){if(state.canControl&&memberEditId===id){error.textContent=failure.message;error.hidden=false;}}
 finally{memberEditPending=false;$('member-edit-submit').disabled=false;$('member-edit-close').disabled=false;}
}
async function changeMember(id,operation){
 if(!currentMember(id)||memberActionPending.has(id))return;if(operation==='ban-ip'&&!window.confirm('حظر عنوان الشبكة يمنع الحسابات والأجهزة الأخرى التي تشارك نفس IP. هل تريد المتابعة؟'))return;if(operation==='delete'&&!window.confirm('حذف العضو من القائمة وإيقاف جلسته؟ يمكنك استرجاعه من المحذوفين.'))return;memberActionPending.add(id);renderMembers();
 try{const result=await api(['restore','delete','ban-ip','unban-ip'].includes(operation)?'/api/members':'/api/revoke',{id,action:operation});if(result.room)applyRoom(result.room);await refresh({afterCurrent:true});}
 catch(error){notice(error.message);}finally{memberActionPending.delete(id);renderMembers();}
}
async function restoreMember(id){const member=currentMember(id);if(!member?.revoked)return;return changeMember(id,'restore');}
function changeMemberPage(step){if(!state.canControl)return;memberPage+=step;renderMembers();}
function clearOwnerFields(){
 for(const id of ['playlist','source-url','code','source-title','setting-name','setting-announcement'])if($(id))$(id).value='';
 for(const id of ['download-playlist','download-qualities'])$(id)?.removeAttribute('href');for(const id of ['quality-links','history'])$(id)?.replaceChildren();
 for(const id of ['selected-title','selected-majed-server','server-state','viewers','quality-note'])if($(id))$(id).textContent='';initialized=false;
 if(typeof invalidateSourceOptions==='function')invalidateSourceOptions();
}
function clearMemberControls(){
 const hadPrivateDialog=$('viewer-details-dialog')?.open||$('member-edit-dialog')?.open;memberDetailsId=null;memberDetailsSignature='';memberEditId=null;
 if($('viewer-details-dialog')?.open)$('viewer-details-dialog').close();if($('member-edit-dialog')?.open)$('member-edit-dialog').close();$('viewer-details-body')?.replaceChildren();$('members-list')?.replaceChildren();memberNodes.clear();memberPage=0;
 for(const id of ['member-edit-id','member-edit-username','member-edit-name'])if($(id))$(id).value='';if($('member-edit-error')){$('member-edit-error').textContent='';$('member-edit-error').hidden=true;}if(hadPrivateDialog)$('viewer-name')?.focus();
}
function renderMembers(){
 const target=$('members-list');if(!target)return;if(!state.canControl){clearMemberControls();return;}
 const all=state.members||[],filtered=filteredMembers(),pages=Math.max(1,Math.ceil(filtered.length/12));memberPage=Math.max(0,Math.min(memberPage,pages-1));const visible=filtered.slice(memberPage*12,memberPage*12+12),visibleIds=new Set(visible.map(member=>member.id)),allIds=new Set(all.map(member=>member.id));
 for(const [id,entry]of memberNodes){if(!visibleIds.has(id))entry.node.remove();if(!allIds.has(id))memberNodes.delete(id);}
 visible.forEach((member,index)=>{
  const id=member.id;let entry=memberNodes.get(id);if(!entry){
   const node=text('div','','member-card'),avatar=text('span','','member-avatar'),open=()=>{const latest=currentMember(id);if(latest)showMemberDetails(latest);},title=button('',open,'member-title'),meta=text('small','','member-meta'),report=text('small','','member-meta'),actions=text('div','','member-actions');
   const details=button('تفاصيل العضو',open),edit=button('تعديل الحساب',()=>openMemberEditor(id)),mute=button('',()=>changeMember(id,'mute')),block=button('حظر العضو',()=>changeMember(id,'revoke')),restore=button('إلغاء الحظر',()=>restoreMember(id));const remove=button('حذف العضو',()=>changeMember(id,'delete')),ipBlock=button('حظر IP',()=>changeMember(id,currentMember(id)?.ipBlocked?'unban-ip':'ban-ip'));actions.append(details,edit,mute,block,restore,ipBlock,remove);node.append(avatar,title,meta,report,actions);node.dataset.memberId=id;entry={node,avatar,title,meta,report,details,edit,mute,block,restore,ipBlock,remove};memberNodes.set(id,entry);
  }
  const info=memberInfo(member);entry.avatar.textContent=[...(member.name||member.username||'د')][0];entry.avatar.dataset.color=member.avatar||'purple';entry.title.textContent=member.displayName||member.name||member.username||'عضو';entry.meta.textContent='@'+(member.username||'')+' · '+(member.revoked?'محظور':member.online?'متصل':'غير متصل')+' · '+({viewer:'مشاهد',stream:'إدارة البث',moderator:'مشرف الدردشة',observer:'مشاهد'})[member.role||'viewer'];entry.report.textContent='انضم '+memberDate(member.joinedAt||member.createdAt)+' · '+(info.clientInfo?.device||info.device||'الجهاز غير متاح')+' · آخر تقرير '+memberDate(member.report?.at||info.at);entry.mute.textContent=member.muted?'السماح بالدردشة':'كتم الدردشة';entry.block.hidden=!!member.revoked;entry.restore.hidden=!member.revoked;entry.restore.textContent=member.deletedAt?'استرجاع العضو':'إلغاء حظر الحساب';entry.remove.hidden=!!member.deletedAt;entry.ipBlock.textContent=member.ipBlocked?'إلغاء حظر IP':'حظر IP';entry.ipBlock.disabled=memberActionPending.has(id)||(!member.ipBlocked&&!member.ipBanAvailable);entry.ipBlock.title=member.ipBanAvailable?'يشمل الأجهزة المشتركة في عنوان الشبكة':'عنوان العميل غير موثّق من بروكسي الاستضافة';
  for(const control of [entry.edit,entry.mute,entry.block,entry.restore,entry.remove])control.disabled=memberActionPending.has(id);if(target.children[index]!==entry.node)target.insertBefore(entry.node,target.children[index]||null);
 });
 if($('members-page-state'))$('members-page-state').textContent='صفحة '+(memberPage+1)+' من '+pages+' · '+filtered.length+' حساب';if($('members-prev'))$('members-prev').disabled=memberPage===0;if($('members-next'))$('members-next').disabled=memberPage>=pages-1;
 if(memberDetailsId&&$('viewer-details-dialog')?.open){const latest=currentMember(memberDetailsId);if(!latest)closeMemberDetails();else if(JSON.stringify(latest)!==memberDetailsSignature)showMemberDetails(latest);}
}
function setupMemberControls(){
 if($('members-search'))$('members-search').oninput=()=>{memberPage=0;renderMembers();};if($('members-filter'))$('members-filter').onchange=()=>{memberPage=0;renderMembers();};
 if($('members-prev'))$('members-prev').onclick=()=>changeMemberPage(-1);if($('members-next'))$('members-next').onclick=()=>changeMemberPage(1);
 if($('member-edit-form'))$('member-edit-form').onsubmit=submitMemberEdit;if($('member-edit-close'))$('member-edit-close').onclick=closeMemberEditor;if($('viewer-details-close'))$('viewer-details-close').onclick=closeMemberDetails;
 $('member-edit-dialog')?.addEventListener('cancel',event=>{if(memberEditPending)event.preventDefault();});$('member-edit-dialog')?.addEventListener('close',()=>{const id=memberEditId;memberEditId=null;if(state.canControl)memberFocus(id);});
 $('viewer-details-dialog')?.addEventListener('close',()=>{const id=memberDetailsId;memberDetailsId=null;memberDetailsSignature='';if(state.canControl)memberFocus(id);});
 document.querySelector('.admin-section-nav a[href="#owner-chat-controls"]')?.addEventListener('click',()=>{if(!state.canControl)return;window.dshoofStudio?.showChat(false);$('owner-chat-controls')?.scrollIntoView({behavior:'smooth',block:'center'});$('chat-toggle')?.focus();});
}
function renderRoom(){
 renderOwnerAnalytics();const settings=room.settings||{},profile=state.profile||{},allowed=!!state.authorized&&!needsRegistration(),chat=!!settings.chatEnabled;
 if(state.canControl)hadOwnerControls=true;else{clearMemberControls();if(hadOwnerControls){hadOwnerControls=false;clearOwnerFields();}}
 $('room-name').textContent=settings.name||'لمّة دشوف';$('audience').hidden=!state.canControl;$('audience').textContent=state.canControl?(room.online||0)+' أصدقاء متصلين':'';$('viewer-roster').hidden=!state.canControl;
 $('viewer-name').textContent=room.name||profile.name||'ضيف دشوف';$('viewer-avatar').textContent=[...(room.name||profile.name||'د')][0];$('viewer-avatar').dataset.color=room.avatar||profile.avatar||'purple';$('edit-profile').disabled=!allowed;
 $('viewer-roster').replaceChildren(...(state.canControl?room.roster||[]:[]).map(person=>text('span',person.name,'roster-chip')));$('typing-indicator').textContent=(room.typing||[]).length?room.typing.join('، ')+' يكتب…':'';clearTimeout(typingTimer);if(room.typing?.length)typingTimer=setTimeout(()=>{room.typing=[];$('typing-indicator').textContent='';},5000);if($('owner-chat-controls'))$('owner-chat-controls').hidden=!state.canControl;
 $('pinned-message').hidden=!room.pinned||(window.dshoofPro&&!window.dshoofPro.chatAllowed(room.pinned));$('pinned-message').textContent=room.pinned?'📌 '+room.pinned.name+' · '+room.pinned.text:'';
 $('announcement').textContent=settings.announcement||'';$('announcement').hidden=!settings.announcement;
 $('chat-state').textContent=!chat?'الدردشة مغلقة من المضيف':room.muted?'أوقف المضيف مشاركتك':'تحدث مع أصدقائك';$('chat-text').disabled=!allowed||!chat||room.muted;$('send-chat').disabled=!allowed||!chat||room.muted||chatSending;
 if($('chat-toggle')){$('chat-toggle').hidden=!state.canControl;$('chat-toggle').disabled=!state.canControl||chatTogglePending;$('chat-toggle').setAttribute('aria-pressed',String(chat));$('chat-toggle').textContent=chat?'إغلاق الدردشة':'فتح الدردشة';}
 if($('chat-toggle-status'))$('chat-toggle-status').textContent=chat?'الدردشة مفتوحة للجميع':'الدردشة مغلقة؛ يبقى البث يعمل';
 $('reactions').hidden=!settings.reactionsEnabled;for(const type of ['like','love','heart'])$('count-'+type).textContent=room.reactions?.[type]||0;
 for(const event of room.events||[]){if(seen.has(event.id)||Date.now()-event.at>4000||document.hidden||document.body.classList.contains('data-saver')||document.body.classList.contains('motion-off'))continue;seen.add(event.id);const node=text('span',{like:'👍',love:'😍',heart:'💜'}[event.type],'float-reaction');node.style.left=(15+Math.random()*70)+'%';$('reaction-cloud').append(node);setTimeout(()=>node.remove(),3000);}if(seen.size>200)seen.clear();
 $('start').hidden=!state.ready||!allowed;
}
async function toggleChat(){if(!state.canControl||chatTogglePending)return;chatTogglePending=true;renderRoom();try{const result=await api('/api/settings',{chatEnabled:!room.settings?.chatEnabled});if(result.room)applyRoom(result.room);else await refresh();}catch(error){notice(error.message);}finally{chatTogglePending=false;renderRoom();}}
async function sendChat(event){
 event.preventDefault();if(chatSending||!state.authorized||needsRegistration()||!room.settings?.chatEnabled||room.muted)return;
 const input=$('chat-text'),draft=input.value;if(!draft.trim())return;const replying=replyTo;
 chatSending=true;renderRoom();
 try{const result=await api('/api/chat',{text:draft,spoiler:$('spoiler').checked,replyTo:replying,videoAt:window.dshoofPro?.wall(),stand:$('pro-stand')?.value||'all'});if(result.room)applyRoom(result.room);else await refresh();if(input.value===draft)input.value='';if(replyTo===replying){replyTo=null;$('reply-preview').hidden=true;}}
 catch(error){notice(error.message);}
 finally{chatSending=false;renderRoom();}
}

function isFrameSource(selection=state.selection){return ['youtube','helper'].includes(selection?.kind);}
function stopLocal(){generation++;clearTimeout(recoveryTimer);clearInterval(playbackMonitor);warmController?.abort();warmController=null;window.dispatchEvent(new Event('dshoof:playback-reset'));hls?.stopLoad();hls?.destroy();hls=null;const v=$('video');v.onerror=v.onprogress=v.oncanplay=v.onloadedmetadata=v.onended=null;v.pause();v.removeAttribute('src');v.load();$('youtube').removeAttribute('src');$('youtube').hidden=true;$('helper-frame')?.removeAttribute('src');if($('helper-frame'))$('helper-frame').hidden=true;running=false;}
function channelPath(){return activeChannel==='1'?'':'/channels/2';}
function playbackURL(){const q=$('quality-select').value;return channelPath()+($('stream-route').value==='relay'?'/live/dshoof.m3u8':'/quality/'+q+'.m3u8');}
function playbackRevision(){return activeChannel+':'+String(state.selection?.updatedAt||'')+':'+state.selection?.kind;}
function watch(){
 channelChosen=true;
 if(state.selection?.kind==='helper'){stopLocal();paused=true;$('waiting').hidden=false;notice('تم إلغاء المشغّل المساعد. اختر كودًا أو رابط فيديو مباشرًا من إدارة القناة.');return;}
 if(!state.authorized||state.authenticated===false||!state.ready||state.stopped)return;
 stopLocal();paused=false;running=true;
 const v=$('video'),g=generation;
 $('waiting').hidden=true;
 if(state.selection?.kind==='youtube'){
  v.hidden=true;$('youtube').hidden=false;
  $('youtube').src='https://www.youtube-nocookie.com/embed/'+state.selection.videoId+'?autoplay=1&playsinline=1&origin='+encodeURIComponent(location.origin);
  return;
 }
 v.hidden=false;v.playbackRate=1;
 const mode=$('playback-mode').value;
 // These sync distances are fractions of the *rolling* 48-fragment server window.
 // The old 120–140 second sync target exceeded the 24-fragment (~96s) playlist.
 const presets={
  close:{maxBufferLength:16,liveSyncDurationCount:3,liveMaxLatencyDurationCount:8,maxLiveSyncPlaybackRate:1.1},
  balanced:{maxBufferLength:38,liveSyncDurationCount:5,liveMaxLatencyDurationCount:14,maxLiveSyncPlaybackRate:1.04},
  stable:{maxBufferLength:56,liveSyncDurationCount:7,liveMaxLatencyDurationCount:18,maxLiveSyncPlaybackRate:1.02}
 };
 const settings=presets[mode]||presets.close,streamURL=playbackURL(),directSource=streamURL.includes('/quality/');
 let currentURL=streamURL,switchedToRelay=false;
 const play=()=>v.play().catch(()=>notice('اضغط تشغيل للسماح للمتصفح بعرض الفيديو'));
 if(window.Hls?.isSupported()){
  // Measured from Majed's active HLS adapter (2026-10-24), same HLS.js 1.7.3.
  // Keep its defaults for ABR, forward buffer and live synchronization.
  const sourceConfig={autoStartLoad:true,enableWorker:true,lowLatencyMode:false,
   liveSyncDurationCount:mode==='stable'?5:mode==='balanced'?3:2,backBufferLength:30,fragLoadingTimeOut:20000,fragLoadingMaxRetry:6,
   fragLoadingRetryDelay:750,manifestLoadingTimeOut:20000,manifestLoadingMaxRetry:6,
   levelLoadingTimeOut:20000,levelLoadingMaxRetry:6};
  const relayConfig={...settings,startPosition:-1,initialLiveManifestSize:3,maxMaxBufferLength:64,
   maxBufferSize:40*1024*1024,backBufferLength:24,lowLatencyMode:false,startFragPrefetch:true,
   fragLoadingTimeOut:20000,manifestLoadingTimeOut:12000,levelLoadingTimeOut:12000,liveSyncOnStallIncrease:1};
  const p=new Hls(directSource?sourceConfig:relayConfig);
  p.dshoofSourceParity=directSource;
  hls=p;
  let errors=0,lastProgress=Date.now(),lastTime=-1,lastRepair=0;
  let repairs=0,isLive=false,lastManifestAdvance=Date.now(),lastSequence=null,lastReload=0;
  // Some clients begin at 00:00 of the rolling playlist even when it represents LIVE.
  // Once seekable media exists, jump ahead to the hls.js live sync point just once.
  let initialLiveAligned=false;
  const alignInitialLive=()=>{
   if(directSource||initialLiveAligned||g!==generation||paused||!isLive)return;
   const ranges=v.seekable;
   if(!ranges?.length||v.readyState<1)return;
   const last=ranges.length-1,start=ranges.start(last),end=ranges.end(last);
   if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return;
   const sync=p.liveSyncPosition;
   const desired=Number.isFinite(sync)&&sync>=end-30&&sync<=end?sync:end-9;
   const target=Math.min(end-0.35,Math.max(start,desired));
   if(!Number.isFinite(target))return;
   if(target-v.currentTime>6){
    try{v.currentTime=target;}catch{return;}
   }
   initialLiveAligned=true;
  };
  v.onloadedmetadata=alignInitialLive;
  v.oncanplay=alignInitialLive;
  let startupPlayed=false;
  p.on(Hls.Events.MANIFEST_PARSED,()=>{startupPlayed=true;play();});
  p.on(Hls.Events.LEVEL_LOADED,(_,info)=>{
   const details=info.details;
   isLive=!!details?.live;
   const sequence=Number(details?.endSN);
   if(Number.isFinite(sequence)&&sequence!==lastSequence){
    lastSequence=sequence;lastManifestAdvance=Date.now();
   }
   alignInitialLive();
  });
  p.on(Hls.Events.FRAG_BUFFERED,()=>{errors=0;alignInitialLive();if(directSource&&!startupPlayed&&buffer()>=1.5){startupPlayed=true;play();}});
  p.on(Hls.Events.ERROR,(_,info)=>{
   if(!info.fatal||g!==generation||paused||state.stopped)return;
   errors++;
   clearTimeout(recoveryTimer);
   // Direct HLS is preferred. The original Dshoof/FFmpeg HLS remains a
   // bounded fallback when its separate server-side relay is actually ready.
   if(!switchedToRelay&&errors>=3&&info.type===Hls.ErrorTypes.NETWORK_ERROR&&state.relayReady===true&&streamURL.includes('/quality/auto.m3u8')){
    switchedToRelay=true;currentURL=channelPath()+'/live/dshoof.m3u8';$('stream-route').value='relay';render();
    errors=0;lastManifestAdvance=Date.now();lastSequence=null;initialLiveAligned=false;
    $('status').textContent='المصدر المباشر يتعثر؛ نستخدم المسار الاحتياطي مؤقتاً';
    p.loadSource(currentURL);
    return;
   }
   if(info.type===Hls.ErrorTypes.MEDIA_ERROR&&errors<=3){
    p.recoverMediaError();return;
   }
   const wait=directSource&&errors===1?0:Math.min(9000,(directSource?750:1200)*2**Math.min(Math.max(0,errors-2),3));
   recoveryTimer=setTimeout(()=>{
    if(g!==generation||paused||state.stopped)return;
    // Reloading an unchanged/expired manifest only restarts playback from 00:00.
    const now=Date.now();
    if(errors>=5&&buffer()<1&&now-lastManifestAdvance<30000&&now-lastReload>45000){
     lastReload=now;p.loadSource(currentURL);
    }else{
     p.startLoad(-1);
    }
   },wait);
  });
  playbackMonitor=setInterval(()=>{
   if(g!==generation){clearInterval(playbackMonitor);return;}
   if(paused||v.paused||v.seeking||state.stopped){lastProgress=Date.now();return;}
   const now=Date.now();
   if(Math.abs(v.currentTime-lastTime)>.15){
    lastTime=v.currentTime;lastProgress=now;repairs=0;return;
   }
   if(directSource||!isLive||now-lastProgress<7500||now-lastRepair<6500)return;
   lastRepair=now;repairs++;
   if(now-lastManifestAdvance>30000){
    $('status').textContent='مصدر البث لم يرسل مقاطع جديدة؛ ننتظر عودته';
    p.startLoad(-1);
    return;
   }
   $('status').textContent='نحاول مواصلة المقاطع دون إعادة البث من البداية…';
   if(buffer()<1){
    const target=p.liveSyncPosition;
    if(Number.isFinite(target)&&target>v.currentTime+12){
     try{v.currentTime=target;}catch{}
    }
    p.startLoad(-1);
   }else if(v.readyState>=2){
    play();
   }
   if(repairs>=3&&buffer()<1&&now-lastProgress>21000&&now-lastReload>45000){
    lastReload=now;repairs=0;p.loadSource(currentURL);
   }
  },2000);
  v.onended=()=>{
   if(g!==generation||paused||state.stopped||!isLive)return;
   p.startLoad(-1);
   const target=p.liveSyncPosition;
   if(!directSource&&Number.isFinite(target)&&target>v.currentTime+2){
    try{v.currentTime=target;}catch{}
   }
   play();
  };
  p.attachMedia(v);p.loadSource(currentURL);
 }else if(v.canPlayType('application/vnd.apple.mpegurl')){
  // Safari native HLS playback; no synthetic 120-second start delay.
  let failures=0;
  const current=()=>g===generation&&!paused&&!state.stopped;
  const load=()=>{
   if(!current())return;
   v.preload='auto';v.src=streamURL;v.load();play();
  };
  v.onerror=()=>{
   if(!current())return;
   $('status').textContent='نحاول إعادة الاتصال بالمصدر…';
   clearTimeout(recoveryTimer);
   recoveryTimer=setTimeout(load,Math.min(15000,2000*2**Math.min(failures++,3)));
  };
  load();
 }else{
  running=false;paused=true;$('waiting').hidden=false;
  notice('هذا المتصفح لا يدعم تشغيل HLS؛ استخدم رابط M3U في مشغل متوافق');
 }
}
function buffer(){const v=$('video');for(let i=0;i<v.buffered.length;i++)if(v.currentTime>=v.buffered.start(i)&&v.currentTime<=v.buffered.end(i))return v.buffered.end(i)-v.currentTime;return 0;}
function renderChat(){
 if(!room.messages)return;const log=$('chat-log'),previousScroll=log.scrollTop,near=log.scrollHeight-log.scrollTop-log.clientHeight<80;
 const messages=[...new Map(room.messages.filter(message=>message&&typeof message.id==='string'&&(!window.dshoofPro||window.dshoofPro.chatAllowed(message))).map(message=>[message.id,message])).values()],wanted=new Set(messages.map(message=>message.id));
 for(const [id,entry]of chatNodes)if(!wanted.has(id)){entry.node.remove();chatNodes.delete(id);}
 messages.forEach((message,index)=>{
  const signature=JSON.stringify([message.name,message.owner,message.text,message.at,message.reply,message.spoiler,!!state.canControl,room.role]);let entry=chatNodes.get(message.id);
  if(!entry||entry.signature!==signature){
   const box=text('div','','message'+(message.owner?' owner':'')),head=text('div',message.name+' · '+new Date(message.at).toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'}),'message-top');box.dataset.messageId=message.id;
   if(state.canControl||room.role==='moderator')head.append(button('حذف',()=>action('/api/chat/clear',{id:message.id}),'delete'));
   head.append(button('رد',()=>{replyTo=message.id;$('reply-preview').hidden=false;$('reply-preview').textContent='رد على '+message.name+': '+message.text.slice(0,70);$('chat-text').focus();},'message-reply'));
   if(state.canControl||room.role==='moderator')head.append(button('تثبيت',()=>action('/api/chat/pin',{id:message.id}),'delete'));
   box.append(head);if(message.reply)box.append(text('blockquote',message.reply.name+' · '+message.reply.text));if(message.spoiler){const details=document.createElement('details');details.append(text('summary','رسالة مخفية • اضغط للعرض'),text('p',message.text));box.append(details);}else box.append(text('p',message.text));
   if(entry)entry.node.replaceWith(box);entry={node:box,signature};chatNodes.set(message.id,entry);
  }
  if(log.children[index]!==entry.node)log.insertBefore(entry.node,log.children[index]||null);
 });
 if(near)log.scrollTop=log.scrollHeight;else log.scrollTop=previousScroll;window.dshoofStudio?.chatChanged(near);
}
function renderPoll(){const p=room.poll;$('poll-card').hidden=!p;if(!p)return;const total=p.counts.reduce((a,b)=>a+b,0);$('poll-question').textContent=p.question;$('poll-state').textContent=(p.closed?'انتهى التصويت':'صوت واحد لكل مشاهد • يمكنك تغيير اختيارك')+' · '+total+' أصوات · الأسماء ظاهرة للجميع';$('poll-options').replaceChildren(...p.options.map((o,i)=>{const card=text('div','','poll-option');const percent=total?Math.round(p.counts[i]/total*100):0;const b=button(o,()=>action('/api/poll',{action:'vote',choice:i}),p.myVote===i?'voted':'');b.setAttribute('aria-pressed',String(p.myVote===i));b.append(text('span',p.counts[i]+' أصوات · '+percent+'%','poll-tally'));b.disabled=p.closed;const meter=document.createElement('progress');meter.max=100;meter.value=percent;meter.setAttribute('aria-label',o+' '+percent+'%');const names=text('div','','participant-names');for(const name of p.voters?.[i]||[])names.append(text('span',name,'name-chip'));if(!names.childNodes.length)names.append(text('small','كن أول المصوّتين'));card.append(b,meter,names);return card;}));}
function renderReactionNames(){const labels={like:'أعجبهم البث',love:'أحبّوا البث',heart:'أرسلوا قلبًا'};$('reaction-names').replaceChildren(...Object.entries(labels).map(([type,label])=>{const wrap=text('div','','reaction-group');const names=room.reactionNames?.[type]||[];wrap.append(text('strong',label));for(const name of names)wrap.append(text('span',name,'name-chip'));if(!names.length)wrap.append(text('small','لا توجد تفاعلات مسمّاة بعد'));return wrap;}));document.querySelectorAll('[data-reaction]').forEach(b=>{const chosen=(room.myReactions||[]).includes(b.dataset.reaction);b.disabled=chosen||!state.authorized;b.setAttribute('aria-pressed',String(chosen));b.title=chosen?'تم تسجيل تفاعلك مرة واحدة':'تفاعل مرة واحدة باسمك';});}

function render(){renderChannels();showDiagnosticConsent();const s=state;renderPublicEntry();document.body.classList.toggle('guest',!s.authorized);renderConnection();const qs=$('quality-select'),previous=qs.value,options=[{id:'auto',label:s.adaptive?'المصدر الأصلي · مباشر (مفضّل)':'تلقائي · مسار متوافق'},...(s.qualities||[])];const signature=JSON.stringify(options);if(qs.dataset.options!==signature){qs.replaceChildren(...options.map(x=>{const o=document.createElement('option');o.value=x.id;o.textContent=x.label;return o;}));qs.value=options.some(x=>x.id===previous)?previous:'auto';qs.dataset.options=signature;}qs.disabled=isFrameSource(s.selection)||$('stream-route').value==='relay';$('stream-route').disabled=isFrameSource(s.selection);$('go-live').disabled=isFrameSource(s.selection);window.dshoofStudio?.render();$('server-stream-controls').hidden=!s.canControl;$('admin').hidden=!s.canControl||!!window.dshoofStudio&&document.body.dataset.page!=='admin';$('admin-link').hidden=!s.canControl;$('guest-message').hidden=s.authorized;$('guest-reason').textContent=s.status||'اختر اسمك للانضمام إلى اللمّة';$('title').textContent=s.selection?.title||'دشوف مباشر';if(!running||v.readyState>=3&&!v.paused)$('status').textContent=s.status||'';$('live-badge').textContent=s.stopped?'متوقف':s.ready?'جاهز':'بانتظار البث';$('source-badge').textContent=s.selection?.kind==='helper'?'مصدر ملغى':s.selection?.kind==='youtube'?'YouTube':'HLS';$('waiting').hidden=running;const idle=s.stopped||!s.selection||s.ended;$('waiting-title').textContent=!channelChosen?'اختر قناتك أعلاه':idle?'لا توجد مباراة حالياً':s.ready?'البث جاهز':'جاري تجهيز البث';$('waiting-text').textContent=idle?'اللمّة ترجع مع صافرة البداية. تابعنا لمعرفة موعد البث القادم.':s.status||'نجهّز لك المشاهدة…';renderRoom();if(!s.canControl)return;$('playlist').value=s.playlist;$('quality-note').textContent=s.qualityNote||'';$('download-qualities').href=s.allQualitiesPlaylist;$('download-qualities').hidden=isFrameSource(s.selection);$('quality-links').hidden=isFrameSource(s.selection);$('download-playlist').hidden=s.selection?.kind==='helper';$('copy-playlist').hidden=s.selection?.kind==='helper';$('playlist').closest('label')?.classList.toggle('helper-unavailable',s.selection?.kind==='helper');$('quality-links').replaceChildren(...(s.qualityPlaylists||[]).map(q=>{const row=document.createElement('div');const a=document.createElement('a');a.className='button';a.href=q.url;a.textContent=q.label+' · تنزيل M3U';a.download='dshoof-'+q.id+'.m3u';row.append(a,button('نسخ رابط '+q.label,()=>copy(q.url)));return row;}));$('download-playlist').href=s.playlist;$('youtube-note').hidden=s.selection?.kind!=='youtube';$('selected-title').textContent=s.selection?.title||'لم يتم اختيار بث';$('selected-majed-server').hidden=!s.selection?.serverName;$('selected-majed-server').textContent=s.selection?.serverName?'مشغّل ماجد الحالي: '+s.selection.serverName+(s.selection.serverId?' · اختيار محفوظ':' · اختيار تلقائي'):'';$('server-state').textContent=(s.stopped?'البث متوقف بأمرك':'التشغيل على الاستضافة مستقل عن هذه الصفحة')+' · مدة تشغيل الخادم '+Math.floor(s.uptime/60)+' دقيقة';$('viewers').textContent=s.viewers+' / '+s.maxViewers+' متصلين';$('resume-broadcast').disabled=!s.selection||!s.stopped;$('stop-broadcast').disabled=s.stopped||!s.selection;renderTelegram();renderMembers();$('history').replaceChildren(...(s.history||[]).filter(x=>x.kind!=='helper').map(x=>button(x.title||x.code||x.url,()=>action('/api/select',x))));if(!initialized){const a=room.settings;$('setting-name').value=a.name;$('setting-announcement').value=a.announcement;$('setting-chat').checked=a.chatEnabled;$('setting-reactions').checked=a.reactionsEnabled;$('setting-slow').value=a.slowSeconds;$('setting-max').value=a.maxViewers;initialized=true;if(s.selection?.kind==='url'&&isMajedPage(s.selection.url)){$('source-kind').value='url';$('source-url').value=s.selection.url;$('source-title').value=s.selection.title||'';$('source-kind').onchange();}}}
async function refresh({afterCurrent=false}={}){
 if(refreshRequest){const pending=refreshRequest;await pending;if(!afterCurrent)return;if(refreshRequest===pending)refreshRequest=null;return refresh();}
 const pending=fetchStatus();refreshRequest=pending;try{return await pending;}finally{if(refreshRequest===pending)refreshRequest=null;}
}
async function fetchStatus(){
 const requestedChannel=activeChannel;refreshing=true;
 try{let s=await api('/api/status?since='+(room.version||0));if(s.room?.instanceId&&room.instanceId&&s.room.instanceId!==room.instanceId&&!Object.hasOwn(s.room,'messages'))s=await api('/api/status?since=0');if(requestedChannel!==activeChannel)return;state=s;const changed=s.room&&(Object.hasOwn(s.room,'messages')||s.room.messagesDelta);if(s.room)mergeRoom(s.room);
  if(!s.authorized){room={};chatNodes.clear();stopRoomEvents();stopLocal();$('chat-log').replaceChildren();$('poll-card').hidden=true;}
  if(s.stopped&&running)stopLocal();render();const next=playbackRevision();if(channelChosen&&s.authorized&&s.authenticated!==false&&!needsRegistration()&&s.ready&&!paused&&(!running||revision!==next)){revision=next;watch();}
  if(changed){renderChat();renderPoll();renderReactionNames();}connectRoomEvents();pollFailures=0;$('connection').textContent='متصل بالخادم';$('connection-dot').classList.remove('off');
 }catch(error){pollFailures++;$('connection').textContent=navigator.onLine?'إعادة اتصال…':'الاتصال غير متاح';$('connection-dot').classList.add('off');}
 finally{refreshing=false;}
}
$('start').onclick=watch;$('reload-video').onclick=watch;$('play-toggle').onclick=()=>{if(isFrameSource()){if(running){paused=true;stopLocal();render();}else watch();return;}if($('video').paused){paused=false;if(running){hls?.startLoad(-1);$('video').play().catch(e=>notice(e.message));}else watch();}else{paused=true;hls?.stopLoad();$('video').pause();}};
$('go-live').onclick=()=>{
 const video=$('video'),ranges=video.seekable;
 if(!ranges.length){hls?.startLoad(-1);return;}
 const last=ranges.length-1,start=ranges.start(last),end=ranges.end(last);
 const liveSync=hls?.liveSyncPosition;
 const desired=Number.isFinite(liveSync)&&liveSync>=end-30&&liveSync<=end?liveSync:end-9;
 const target=Math.max(start,Math.min(end-.35,desired));
 if(!Number.isFinite(target))return;
 try{video.currentTime=target;}catch{}
 hls?.startLoad(-1);
 paused=false;video.play().catch(()=>{});
};
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if($('screen').requestFullscreen)await $('screen').requestFullscreen();else $('video').webkitEnterFullscreen?.();}catch(e){notice(e.message);}};
$('pip').hidden=!document.pictureInPictureEnabled;$('pip').onclick=async()=>{try{if(document.pictureInPictureElement)await document.exitPictureInPicture();else await $('video').requestPictureInPicture();}catch{notice('ابدأ الفيديو أولًا؛ الميزة تعتمد على المتصفح ونوع البث');}};
const v=$('video');$('cast').hidden=!(v.remote||v.webkitShowPlaybackTargetPicker);$('cast').onclick=async()=>{try{if(v.webkitShowPlaybackTargetPicker)v.webkitShowPlaybackTargetPicker();else await v.remote.prompt();}catch{notice('لم يتوفر جهاز عرض متوافق');}};
async function wake(){try{if(wantWake&&document.visibilityState==='visible')wakeLock=await navigator.wakeLock.request('screen');else{await wakeLock?.release();wakeLock=null;}controlLabel('wake',wantWake?'إلغاء إبقاء الشاشة':'إبقاء الشاشة','eye');}catch{wantWake=false;notice('تعذر إبقاء الشاشة مضاءة على هذا الجهاز');}}
$('wake').hidden=!navigator.wakeLock;$('wake').onclick=()=>{wantWake=!wantWake;wake();};document.addEventListener('visibilitychange',()=>{wake();if(!document.hidden)refresh();});
$('focus').onclick=()=>{$('focus').setAttribute('aria-pressed',String(document.body.classList.toggle('cinema')));};$('chat-hide').onclick=()=>{$('chat-body').hidden=!$('chat-body').hidden;controlLabel('chat-hide',$('chat-body').hidden?'إظهار':'إخفاء',$('chat-body').hidden?'eye':'eye-off');$('chat-hide').setAttribute('aria-expanded',String(!$('chat-body').hidden));$('chat-hide').setAttribute('aria-label',$('chat-body').hidden?'إظهار الدردشة':'إخفاء الدردشة');};
$('stream-route').onchange=()=>{render();if(state.ready)watch();};
$('quality-select').onchange=()=>{if(state.ready){revision=playbackRevision();watch();}};
$('playback-mode').onchange=()=>{try{localStorage.setItem('dshoof-live-mode-v2',$('playback-mode').value);}catch{}if(running)watch();};
try{$('playback-mode').value=localStorage.getItem('dshoof-live-mode-v2')||'close';}catch{$('playback-mode').value='close';}
$('sleep').onchange=()=>{clearTimeout(sleepTimer);const minutes=Number($('sleep').value);if(minutes)sleepTimer=setTimeout(()=>{paused=true;stopLocal();render();notice('انتهى مؤقتك؛ توقف العرض عندك فقط، والبث مستمر على الاستضافة');},minutes*60000);};

function privacyUpdate(value){const update=privacyQueue.catch(()=>{}).then(()=>api('/api/privacy',value));privacyQueue=update.then(()=>{},()=>{});return update;}
function telemetryEnabled(){return !pageLeaving&&$('privacy-telemetry')?.checked!==false&&telemetryAllowed;}
async function collectClientInfo(){
 if(!telemetryEnabled())return {};
 const result={shared:true,screen:{width:Math.round(window.screen?.width||0),height:Math.round(window.screen?.height||0),pixelRatio:window.devicePixelRatio||1},locale:navigator.language||'',subscription:$('privacy-subscription')?.value||'unspecified'};
 if(result.subscription==='notshared')result.subscription='unspecified';
 try{result.timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;}catch{}
 const connection=navigator.connection||navigator.mozConnection||navigator.webkitConnection;if(connection){result.network={};for(const key of ['effectiveType','downlink','rtt','saveData','type'])if(connection[key]!==undefined)result.network[key]=connection[key];}
 if(navigator.getBattery){let deadline;try{batteryPromise||=navigator.getBattery().catch(()=>null);const battery=await Promise.race([batteryPromise,new Promise(resolve=>{deadline=setTimeout(()=>resolve(null),1200);})]);if(battery)result.battery={level:Math.round(battery.level*100),charging:!!battery.charging};}catch{}finally{clearTimeout(deadline);}}
 if(!telemetryEnabled())return {};if(sharedLocation)result.location={...sharedLocation};return result;
}
function renderLocationPrivacy(){if($('privacy-location-clear'))$('privacy-location-clear').hidden=!sharedLocation&&!locationBusy;if($('privacy-location-button'))$('privacy-location-button').disabled=!telemetryEnabled()||locationBusy;if($('privacy-location-state'))$('privacy-location-state').textContent=sharedLocation?'تشارك موقعًا تقريبيًا مع المضيف فقط.':locationBusy?'بانتظار موافقتك وتأكيد مشاركة الموقع…':'لم تشارك موقعك.';}
async function shareLocation(){
 if(!telemetryEnabled()||locationBusy||!navigator.geolocation){if($('privacy-location-state'))$('privacy-location-state').textContent='مشاركة الموقع غير متاحة أو معلومات المشاهدة مغلقة.';return;}
 const request=++locationRequest;locationBusy=true;renderLocationPrivacy();
 navigator.geolocation.getCurrentPosition(async position=>{
  if(request!==locationRequest||!telemetryEnabled())return;
  try{await privacyUpdate({location:true});if(request!==locationRequest||!telemetryEnabled())return;sharedLocation={latitude:Number(position.coords.latitude.toFixed(3)),longitude:Number(position.coords.longitude.toFixed(3)),accuracy:Math.round(position.coords.accuracy)};locationBusy=false;renderLocationPrivacy();report();}
  catch(error){if(request===locationRequest){locationBusy=false;renderLocationPrivacy();$('privacy-location-state').textContent='لم تتم مشاركة الموقع: '+error.message;}}
 },()=>{if(request===locationRequest){locationBusy=false;renderLocationPrivacy();$('privacy-location-state').textContent='لم تتم مشاركة الموقع. يمكنك المحاولة لاحقًا.';}},{enableHighAccuracy:false,timeout:10000,maximumAge:60000});
}
async function clearLocation(){
 const request=++locationRequest;sharedLocation=null;locationBusy=false;renderLocationPrivacy();$('privacy-location-state').textContent='توقف إرسال موقعك؛ نؤكد مسحه من لوحة المضيف…';
 try{await privacyUpdate({location:false});if(request===locationRequest){renderLocationPrivacy();$('privacy-location-state').textContent='ألغيت مشاركة الموقع وأزيلت بياناته من لوحة المضيف.';}}
 catch(error){if(request===locationRequest)$('privacy-location-state').textContent='توقف الإرسال من هذا الجهاز، وتعذر تأكيد مسح البيانات: '+error.message;}
}
async function setTelemetryPolicy(){
 if(privacyChanging)return;const selected=$('privacy-telemetry').checked;privacyChanging=true;$('privacy-telemetry').disabled=true;telemetryAllowed=false;
 try{localStorage.setItem('dshoof-telemetry',selected?'on':'off');localStorage.setItem('dshoof-diagnostics-consent','v1');}catch{}
 locationRequest++;sharedLocation=null;locationBusy=false;batteryPromise=null;renderLocationPrivacy();
 try{await privacyUpdate({device:selected,persist:selected});telemetryAllowed=selected;renderLocationPrivacy();notice(selected?'سمحت بمعلومات التشغيل للمضيف فقط؛ الموقع يحتاج موافقة مستقلة.':'أوقفت مشاركة المعلومات الاختيارية وأزيلت بياناتها من لوحة المضيف.');if(selected)report();}
 catch(error){notice('توقف إرسال المعلومات من هذا الجهاز؛ تعذر تأكيد حفظ الخصوصية: '+error.message);}
 finally{privacyChanging=false;$('privacy-telemetry').disabled=false;renderLocationPrivacy();}
}
function setupPrivacy(){
 try{if($('privacy-telemetry'))$('privacy-telemetry').checked=localStorage.getItem('dshoof-telemetry')!=='off';if($('privacy-subscription'))$('privacy-subscription').value=localStorage.getItem('dshoof-subscription')||'unspecified';}catch{}
 try{if(localStorage.getItem('dshoof-diagnostics-consent')!=='v1')$('privacy-telemetry').checked=false;}catch{$('privacy-telemetry').checked=false;}telemetryAllowed=$('privacy-telemetry')?.checked!==false;if($('privacy-telemetry'))$('privacy-telemetry').onchange=setTelemetryPolicy;
 if($('privacy-subscription'))$('privacy-subscription').onchange=()=>{try{localStorage.setItem('dshoof-subscription',$('privacy-subscription').value);}catch{}report();};
 if($('privacy-location-button'))$('privacy-location-button').onclick=shareLocation;if($('privacy-location-clear'))$('privacy-location-clear').onclick=clearLocation;if($('viewer-details-close'))$('viewer-details-close').onclick=()=>$('viewer-details-dialog').close();renderLocationPrivacy();
}

async function report(help=false){if(pageLeaving||!state.authorized)return;if(state.canControl){if(help)notice('جرّب وضع الثبات أو جودة أقل متاحة من المصدر، وتحقق من مخزون التشغيل.');return;}try{const clientInfo=await collectClientInfo();if(pageLeaving)return;await api('/api/report',{clientInfo,state:isFrameSource()?'youtube':v.error?'error':v.paused?'paused':v.readyState<3?'buffering':'playing',buffer:buffer(),height:v.videoHeight,help,...(window.dshoofPro?.report()||{})});if(help)notice('وصل تنبيهك إلى المضيف');}catch(e){if(help)notice(e.message);}}
$('help-stream').onclick=()=>report(true);setInterval(()=>report(),15000);setInterval(()=>{const b=Math.round(buffer());$('buffer-state').textContent='مخزون '+b+' ث';window.dshoofStudio?.metrics(b);$('diagnostics').textContent=state.selection?.kind==='helper'?'البث المساعد: استخدم أدوات المشغّل الأصلي للجودة والصوت':state.selection?.kind==='youtube'?'يوتيوب يعمل داخل مشغله الخاص':(v.videoHeight?v.videoWidth+' × '+v.videoHeight+' · ':'')+'مخزون التشغيل '+b+' ثانية · '+(navigator.onLine?'الجهاز متصل بالشبكة':'الشبكة غير متصلة');controlLabel('play-toggle',v.paused?'تشغيل':'إيقاف عندي',v.paused?'play':'pause');},2000);
$('copy-playlist').onclick=()=>copy($('playlist').value);if($('copy-public-room'))$('copy-public-room').onclick=()=>copy(publicRoomURL());if($('share-public-room'))$('share-public-room').onclick=async()=>{try{if(navigator.share)await navigator.share({title:'شاهد معي على دشوف',url:publicRoomURL()});else await copy(publicRoomURL());}catch{}};
let majedLoadedURL='',majedLoadVersion=0,majedLoadTimer,majedPending=null;
function invalidateSourceOptions(){clearTimeout(majedLoadTimer);majedLoadVersion++;majedLoadedURL='';majedPending=null;$('majed-server')?.replaceChildren();if($('majed-server'))$('majed-server').disabled=true;if($('majed-fields'))$('majed-fields').hidden=true;if($('majed-server-note'))$('majed-server-note').textContent='';}
function isMajedPage(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&['live.xn----zmcaegc7cl3msazv.com','majed-koora.live'].includes(u.hostname)&&/^[A-Za-z0-9_-]{20,160}$/.test(u.searchParams.get('mk')||'');}catch{return false;}}
function updateMajedControls(){clearTimeout(majedLoadTimer);majedPending=null;majedLoadVersion++;majedLoadedURL='';const visible=$('source-kind').value==='url'&&isMajedPage($('source-url').value.trim());$('majed-fields').hidden=!visible;$('majed-server').disabled=true;$('majed-server').replaceChildren(new Option('تلقائي · أول مشغّل متاح',''));$('load-majed-servers').disabled=false;$('majed-server-note').textContent=visible?'جاري قراءة مشغّلات المباراة…':'ستظهر هنا المشغّلات التي توفرها صفحة المباراة.';if(visible)majedLoadTimer=setTimeout(()=>loadMajedServers(true),400);}
function loadMajedServers(quiet=false){const url=$('source-url').value.trim();if(majedPending?.url===url)return majedPending.promise;const promise=readMajedServers(quiet),pending={url,promise};majedPending=pending;promise.finally(()=>{if(majedPending===pending)majedPending=null;});return promise;}
async function readMajedServers(quiet=false){clearTimeout(majedLoadTimer);const url=$('source-url').value.trim();if(!isMajedPage(url))return false;const version=++majedLoadVersion,previous=majedLoadedURL===url?$('majed-server').value:((state.selection?.url===url&&state.selection.serverId)||'');$('load-majed-servers').disabled=true;$('majed-server').disabled=true;$('majed-server-note').textContent='جاري قراءة مشغّلات المباراة…';try{const data=await api('/api/source-options',{url});if(version!==majedLoadVersion||$('source-url').value.trim()!==url)return false;$('majed-server').replaceChildren(new Option('تلقائي · أول مشغّل متاح',''),...data.servers.map(x=>new Option([x.name,x.quality].filter(Boolean).join(' · '),x.id)));const missing=!!previous&&!data.servers.some(x=>x.id===previous);if(missing){const unavailable=new Option('المشغّل السابق غير متاح — اختر مشغّلًا آخر',previous);unavailable.disabled=true;$('majed-server').append(unavailable);}if(previous)$('majed-server').value=previous;majedLoadedURL=url;$('majed-server').disabled=false;$('majed-server-note').textContent=missing?'المشغّل المحفوظ لم يعد متاحًا؛ اختر مشغّلًا آخر بنفسك.':'متاح '+data.servers.length+' مشغّل — اختر ثم اضغط تشغيل وتحديث قناة دشوف.';return true;}catch(e){if(version===majedLoadVersion){majedLoadedURL='';$('majed-server-note').textContent=e.message;if(!quiet)notice(e.message);}return false;}finally{if(version===majedLoadVersion)$('load-majed-servers').disabled=false;}}
$('load-majed-servers').onclick=()=>loadMajedServers();
$('source-url').addEventListener('input',updateMajedControls);
$('source-kind').onchange=()=>{const direct=$('source-kind').value==='url';$('code-fields').hidden=direct;$('url-fields').hidden=!direct;$('code').required=!direct;$('source-url').required=direct;updateMajedControls();};
$('select-form').onsubmit=async e=>{e.preventDefault();$('select').disabled=true;try{const kind=$('source-kind').value,url=$('source-url').value.trim();if(kind==='url'&&isMajedPage(url)&&majedLoadedURL!==url&&!await loadMajedServers())return;notice('جاري فحص المصدر وتجهيزه على الاستضافة…');const result=await action('/api/select',{kind,code:$('code').value,url,title:$('source-title').value,...(kind==='url'&&isMajedPage(url)?{serverId:$('majed-server').value}:{})});if(result){paused=false;notice('تم حفظ المصدر والمشغّل؛ يستمر البث على الاستضافة عند إغلاق الصفحة');}}finally{$('select').disabled=false;}};
$('stop-broadcast').onclick=()=>action('/api/stop',{});$('resume-broadcast').onclick=()=>action('/api/resume',{});
$('telegram-config-form').onsubmit=async event=>{event.preventDefault();const result=await action('/api/telegram/config',{serverUrl:$('telegram-server-url').value.trim(),streamKey:$('telegram-stream-key').value});if(result){$('telegram-server-url').value=result.telegram.serverUrl;$('telegram-stream-key').value='';notice('تم حفظ إعدادات Telegram للقناة المحددة');}};
$('telegram-start').onclick=()=>action('/api/telegram/start',{});$('telegram-stop').onclick=()=>action('/api/telegram/stop',{});$('telegram-clear').onclick=async()=>{if(!window.confirm('حذف إعدادات Telegram المحفوظة لهذه القناة؟'))return;const result=await action('/api/telegram/config',{clearSettings:true});if(result){$('telegram-server-url').value='';$('telegram-stream-key').value='';notice('تم حذف إعدادات Telegram لهذه القناة');}};$('logout').onclick=async()=>{if(await action('/api/logout',{})){stopLocal();location.replace('/');}};
$('settings-form').onsubmit=async e=>{e.preventDefault();if(await action('/api/settings',{name:$('setting-name').value,announcement:$('setting-announcement').value,chatEnabled:$('setting-chat').checked,reactionsEnabled:$('setting-reactions').checked,slowSeconds:Number($('setting-slow').value),maxViewers:Number($('setting-max').value)}))notice('تم حفظ إعدادات الغرفة');};
$('chat-form').onsubmit=sendChat;$('clear-chat').onclick=()=>action('/api/chat/clear',{});document.querySelectorAll('[data-reaction]').forEach(b=>b.onclick=()=>action('/api/react',{type:b.dataset.reaction}));
$('poll-form').onsubmit=e=>{e.preventDefault();action('/api/poll',{action:'create',question:$('poll-input').value,options:$('poll-choices').value.split('\n')});};$('close-poll').onclick=()=>action('/api/poll',{action:'close'});
document.addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY/.test(e.target.tagName)||e.target.isContentEditable)return;const id={f:'fullscreen',l:'go-live',' ':'play-toggle'}[e.key.toLowerCase()];if(id){e.preventDefault();$(id).click();}if(e.key.toLowerCase()==='m')v.muted=!v.muted;});
setupPrivacy();setupMemberControls();if($('welcome-form'))$('welcome-form').onsubmit=joinRoom;
if($('welcome-dialog'))$('welcome-dialog').addEventListener('cancel',event=>{if(needsRegistration())event.preventDefault();});
if($('welcome-close'))$('welcome-close').onclick=event=>{if(needsRegistration()){event.preventDefault();return;}$('welcome-dialog').close();};
if($('welcome-join-open'))$('welcome-join-open').onclick=()=>renderPublicEntry();
if($('chat-toggle'))$('chat-toggle').onclick=toggleChat;
(async()=>{const key=new URLSearchParams(location.hash.slice(1)).get('admin');if(key||location.search)history.replaceState(null,'',location.pathname+(key?'':location.hash));if(key){try{await api('/api/login',{key});}catch(error){notice(error.message);}}await refresh();if(!pageLeaving)pollTimer=setTimeout(pollStatus,statusPollDelay());})();

$('edit-profile').onclick=()=>{$('profile-form').hidden=!$('profile-form').hidden;$('profile-name').value=room.name||state.profile?.name||'';$('profile-avatar').value=room.avatar||state.profile?.avatar||'purple';if($('profile-username'))$('profile-username').value=room.username||state.profile?.username||'';$('profile-name').focus();};$('profile-form').onsubmit=async e=>{e.preventDefault();if(await action('/api/profile',{name:$('profile-name').value,avatar:$('profile-avatar').value})){$('profile-form').hidden=true;notice('تم حفظ اسمك؛ سيظهر للمضيف وللأصدقاء');}};$('reply-preview').onclick=()=>{replyTo=null;$('reply-preview').hidden=true;};$('chat-text').addEventListener('input',()=>{if(Date.now()-lastTyping>3000){lastTyping=Date.now();api('/api/typing',{}).catch(()=>{});}});document.querySelectorAll('[data-emoji]').forEach(b=>b.onclick=()=>{$('chat-text').value+=b.dataset.emoji;$('chat-text').focus();});

$('network-mode').value='fast';
window.addEventListener('pagehide',()=>{pageLeaving=true;locationRequest++;sharedLocation=null;clearTimeout(typingTimer);stopRoomEvents();stopLocal();clearTimeout(pollTimer);});window.addEventListener('pageshow',e=>{if(e.persisted)location.reload();});window.addEventListener('online',()=>{refresh();connectRoomEvents();});window.addEventListener('offline',stopRoomEvents);

function rate(kbps){return Number(kbps)>=1000?(Number(kbps)/1000).toFixed(2)+' ميغابت/ث':Math.round(Number(kbps))+' كيلوبت/ث';}
function renderConnection(){
 const summary=$('network-summary');if(!summary)return;summary.dataset.mode='fast';
 if(state.selection?.kind==='helper'){$('network-heading').textContent='البث المساعد · المشغّل الأصلي';$('network-detail').textContent='الجودة والصوت والتخزين المؤقت من المشغّل الأصلي. إذا لم تظهر الصورة فقد يكون المصدر متوقفًا أو يمنع التضمين؛ أخبر المضيف لتجربة رابط مشغّل آخر.';$('network-rate').hidden=true;return;}
 $('network-heading').textContent='جودة المصدر · دون ضغط';
 $('network-detail').textContent='نبدأ قرب أحدث مقطع متاح. يحتفظ السيرفر بالمقاطع السابقة للإعادة دون إجبارك على تأخير المشاهدة. وضع الثبات يضيف مقطعًا احتياطيًا.';
 $('network-rate').textContent='حسب جودة المصدر';$('network-rate').hidden=state.selection?.kind==='youtube';
}
function renderTelegram(){
 const t=state.telegram||{},server=$('telegram-server-url'),key=$('telegram-stream-key');if(!server||!key)return;
 if(state.canControl&&telegramFormChannel!==activeChannel&&String(state.channel)===activeChannel){server.value=t.serverUrl||'';key.value='';telegramFormChannel=activeChannel;}
 $('telegram-state').textContent=t.running?'يرسل الآن':t.configured?'مُعدّ للإرسال':'غير مُعدّ';
 $('telegram-status').textContent=t.status||'لم يتم ضبط البث إلى Telegram';
 $('telegram-start').disabled=!t.configured||!!t.running||!!state.stopped||!state.selection||['helper','youtube'].includes(state.selection.kind);
 $('telegram-stop').disabled=!t.running;
 $('telegram-clear').disabled=!t.configured;
}
function renderChannels(){
 const options=state.channels?.length?state.channels:[{id:'1',name:'دشوف 1'},{id:'2',name:'دشوف 2 (HDR)'}];
 for(const id of ['channel-select','admin-channel-select']){const menu=$(id);if(!menu)continue;const signature=JSON.stringify(options.map(c=>[c.id,c.name]));if(menu.dataset.signature!==signature){menu.replaceChildren(...options.map(c=>new Option(c.name,c.id)));menu.dataset.signature=signature;}menu.value=activeChannel;}
 for(const c of options){const card=$('channel-card-'+c.id);if(!card)continue;card.setAttribute('aria-pressed',String(channelChosen&&activeChannel===c.id));$('channel-title-'+c.id).textContent=c.name;$('channel-state-'+c.id).textContent=c.ready?'يبث الآن'+(c.title?' · '+c.title:''):'بانتظار البث';}
 $('channel-rename-form').hidden=!state.canControl;const name=$('channel-name');
 if(name.dataset.channel!==activeChannel){name.value=state.channelName||options.find(c=>c.id===activeChannel)?.name||'';name.dataset.channel=activeChannel;}
 $('channel-admin-label').textContent='إعدادات '+(state.channelName||options.find(c=>c.id===activeChannel)?.name||'القناة');
  if(state.canControl&&telegramFormChannel!==activeChannel&&String(state.channel)===activeChannel){const t=state.telegram||{};$('telegram-server-url').value=t.serverUrl||'';$('telegram-stream-key').value='';telegramFormChannel=activeChannel;}
 if(state.canControl&&sourceFormChannel!==activeChannel&&String(state.channel)===activeChannel){sourceFormChannel=activeChannel;const selection=state.selection;$('source-kind').value=selection?.kind==='code'?'code':'url';$('source-url').value=selection?.kind==='url'?selection.url||'':'';$('code').value=selection?.code||'';$('source-title').value=selection?.title||'';$('source-kind').onchange();}
}
async function switchChannel(id){
 if(!['1','2'].includes(id))return;channelChosen=true;
 if(id===activeChannel){if(!running)watch();renderChannels();return;}
 activeChannel=id;try{localStorage.setItem('dshoof-channel',id);}catch{}telegramFormChannel=null;stopLocal();paused=false;revision='';sourceFormChannel=null;invalidateSourceOptions();
 state={...state,ready:false,selection:null,channel:null,channelName:null,stopped:false};render();await refresh({afterCurrent:true});
}
$('channel-select').onchange=()=>switchChannel($('channel-select').value);
$('admin-channel-select').onchange=()=>switchChannel($('admin-channel-select').value);
for(const id of ['1','2'])$('channel-card-'+id).onclick=()=>switchChannel(id);
$('channel-rename-form').onsubmit=async event=>{event.preventDefault();await action('/api/channel-name',{name:$('channel-name').value.trim()});};
function showDiagnosticConsent(){
 if(!state.authorized||state.canControl||needsRegistration())return;
 try{if(localStorage.getItem('dshoof-diagnostics-consent')==='v1')return;}catch{return;}
 const dialog=$('diagnostic-consent');if(dialog&&!dialog.open)dialog.showModal();
}
async function chooseDiagnosticConsent(allowed){
 $('diagnostic-yes').disabled=$('diagnostic-no').disabled=true;
 try{await privacyUpdate({device:allowed,persist:allowed,location:false});telemetryAllowed=allowed;$('privacy-telemetry').checked=allowed;localStorage.setItem('dshoof-telemetry',allowed?'on':'off');localStorage.setItem('dshoof-diagnostics-consent','v1');$('diagnostic-consent').close();renderLocationPrivacy();report();}
 catch(error){notice(error.message);}finally{$('diagnostic-yes').disabled=$('diagnostic-no').disabled=false;}
}
$('diagnostic-yes').onclick=()=>chooseDiagnosticConsent(true);
$('diagnostic-no').onclick=()=>chooseDiagnosticConsent(false);

$('diagnostic-consent').addEventListener('cancel',()=>{chooseDiagnosticConsent(false);});
