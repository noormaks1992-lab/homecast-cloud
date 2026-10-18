import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('./public/app.js',import.meta.url),'utf8');
const html=await readFile(new URL('./public/index.html',import.meta.url),'utf8');
function section(start,end){
 const first=source.indexOf(start),last=source.indexOf(end,first+start.length);
 assert(first>=0&&last>first,`client section missing: ${start}`);
 return source.slice(first,last);
}
const helpers=source.slice(0,source.indexOf('function stopLocal()'));
const chat=section('function renderChat()','function render(){');
const refresh=section('async function refresh(',"$('start').onclick=watch;");
const privacy=section('function privacyUpdate(',"$('help-stream').onclick=");
const sharing=section("if($('copy-public-room'))","let majedLoadedURL=");
const welcomeEvents=section("if($('welcome-dialog'))$('welcome-dialog').addEventListener", "(async()=>{const key=");
const plain=value=>JSON.parse(JSON.stringify(value));
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});

// A small DOM model keeps node identity and browser form state observable. Deliberately
// reject innerHTML so untrusted member/message fields must use text nodes.
class Element{
 constructor(tag='div'){
  this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={};
  this.attributes={};this.listeners=new Map();this.parentNode=null;this._text='';
  this.hidden=false;this.disabled=false;this.value='';this.checked=false;this.open=false;
  this.scrollTop=0;this.scrollHeight=0;this.clientHeight=0;this.className='';
  const classes=new Set();this.classList={contains:name=>classes.has(name),add:name=>classes.add(name),remove:name=>classes.delete(name),toggle:(name,force)=>{const add=force??!classes.has(name);add?classes.add(name):classes.delete(name);return add;}};
 }
 get childNodes(){return this.children;}
 get isConnected(){for(let node=this;node;node=node.parentNode)if(node===this.ownerDocument?.body)return true;return false;}
 set textContent(value){for(const child of this.children)child.parentNode=null;this.children=[];this._text=String(value??'');}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 set innerHTML(_value){throw Error('Unsafe HTML assignment');}
 append(...children){for(const child of children){child.remove();child.parentNode=this;this.children.push(child);}}
 replaceChildren(...children){this.textContent='';this.append(...children);}
 insertBefore(child,before){if(child===before)return;child.remove();const index=before?this.children.indexOf(before):this.children.length;assert(index>=0);child.parentNode=this;this.children.splice(index,0,child);}
 remove(){if(this.parentNode){const siblings=this.parentNode.children,index=siblings.indexOf(this);if(index>=0)siblings.splice(index,1);this.parentNode=null;}}
 replaceWith(child){const parent=this.parentNode;if(!parent)return;const index=parent.children.indexOf(this);child.remove();this.parentNode=null;child.parentNode=parent;parent.children[index]=child;}
 setAttribute(name,value){this.attributes[name]=String(value);if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=String(value);}
 getAttribute(name){return this.attributes[name]??(name.startsWith('data-')?this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]:null)??null;}
 removeAttribute(name){delete this.attributes[name];}
 addEventListener(name,listener){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(listener);}
 dispatchEvent(event){this['on'+event.type]?.(event);for(const listener of this.listeners.get(event.type)||[])listener(event);return !event.defaultPrevented;}
 click(){if(this.disabled)return;const event={type:'click',target:this,preventDefault(){}};let result=this.onclick?.(event);for(const listener of this.listeners.get('click')||[])result=listener(event)??result;return result;}
 focus(){this.ownerDocument.activeElement=this;}
 showModal(){this.open=true;this.showCount=(this.showCount||0)+1;}
 close(){this.open=false;this.dispatchEvent({type:'close'});}
 contains(node){for(let current=node;current;current=current.parentNode)if(current===this)return true;return false;}
 matches(selector){if(selector.startsWith('.'))return this.className.split(/\s+/).includes(selector.slice(1));if(selector.startsWith('#'))return this.id===selector.slice(1);const attribute=/^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);if(attribute){const value=this.getAttribute(attribute[1]);return value!==null&&(attribute[2]===undefined||value===attribute[2]);}return this.tagName===selector.toUpperCase();}
 closest(selector){for(let node=this;node;node=node.parentNode)if(node.matches(selector))return node;return null;}
 querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}

function fixture({state={},room={},fetch:fetchHandler,navigator:nav={},storage={}}={}){
 const elements=new Map(),timers=new Map(),requests=[],streams=[],copied=[],shares=[],stored=new Map(Object.entries(storage));let timerId=0;
 const document={hidden:false,activeElement:null,body:new Element('body'),createElement(tag){const node=new Element(tag);node.ownerDocument=document;return node;},getElementById(id){if(!elements.has(id)){const node=this.createElement(id.includes('dialog')?'dialog':'div');node.id=id;elements.set(id,node);this.body.append(node);}return elements.get(id);},querySelector:selector=>document.body.querySelector(selector),querySelectorAll:selector=>document.body.querySelectorAll(selector),addEventListener(){}};
 document.body.ownerDocument=document;
 class EventSource{
  constructor(url){this.url=url;this.listeners=new Map();this.closed=false;streams.push(this);}
  addEventListener(name,listener){this.listeners.set(name,listener);}
  emit(name,value){this.listeners.get(name)?.({data:JSON.stringify(value)});}
  close(){this.closed=true;}
 }
 const navigator={onLine:true,language:'ar-IQ',clipboard:{writeText:async value=>copied.push(value)},share:async value=>shares.push(value),...nav};
 const context={document,navigator,URL,URLSearchParams,AbortSignal,AbortController,Intl,Date,console,
  location:{origin:'https://room.example',pathname:'/',search:'?key=private',hash:'#admin=secret'},
  window:{EventSource,screen:{width:1080,height:1920},devicePixelRatio:2},
  localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)},
  fetch:async(path,options={})=>{const request={path,...options,body:options.body?JSON.parse(options.body):undefined};requests.push(request);return fetchHandler?fetchHandler(request):response({});},
  setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval:()=>++timerId,clearInterval(){},
  watchCount:0,stopCount:0,nextRevision:'same-source:fast'};
 vm.createContext(context);
 vm.runInContext(helpers+chat+refresh+privacy+`
  const v=$('video');
  function buffer(){return 4;}
  function watch(){watchCount++;running=true;}
  function stopLocal(){stopCount++;running=false;}
  function playbackRevision(){return nextRevision;}
  function render(){renderPublicEntry();renderRoom();if(state.canControl)renderMembers();}
  globalThis.client={
   setState:value=>state=value,getState:()=>state,setRoom:value=>{room=value;state.room=room;},getRoom:()=>room,
   setRevision:value=>revision=value,getRevision:()=>revision,setRunning:value=>running=value,isRunning:()=>running,
   setPollFailures:value=>pollFailures=value,getPollFailures:()=>pollFailures,
   setPageLeaving:value=>pageLeaving=value,getConnected:()=>eventsConnected,
   getJoining:()=>joining,getSharedLocation:()=>sharedLocation,getNodes:()=>chatNodes,
   needsRegistration,publicRoomURL,renderPublicEntry,joinRoom,mergeRoom,applyRoom,renderChat,renderRoom,
   connectRoomEvents,stopRoomEvents,statusPollDelay,pollStatus,refresh,toggleChat,sendChat,
   collectClientInfo,shareLocation,clearLocation,setupPrivacy,renderMembers,showMemberDetails
  };`,context);
 context.client.setState({authorized:true,authenticated:true,canControl:false,ready:false,profile:{name:'مشاهد'},...state});
 context.client.setRoom({version:1,settings:{chatEnabled:true,reactionsEnabled:true},messages:[],...room});
 document.getElementById('network-mode').value='fast';
 document.getElementById('privacy-telemetry').checked=true;
 document.getElementById('video').paused=false;document.getElementById('video').readyState=4;
 const runTimer=id=>{const timer=timers.get(id);assert(timer,'timer must exist');timers.delete(id);return timer.fn();};
 return {context,client:context.client,document,element:id=>document.getElementById(id),timers,requests,streams,copied,shares,stored,runTimer,load:code=>vm.runInContext(code,context)};
}

function memberFixture(members,{state={},fetch:handler}={}){
 let records=members;const ownerState={authorized:true,authenticated:true,canControl:true,ready:false,members,...state};
 const f=fixture({state:ownerState,fetch:async request=>{
  if(handler)return handler(request);
  if(request.path==='/api/members'){
   const {id,action,...changes}=request.body;
   records=records.map(member=>member.id===id?{...member,...(action==='restore'?{revoked:false}:changes)}:member);
   return response({ok:true});
  }
  if(request.path.startsWith('/api/status'))return response({...ownerState,members:records,room:{version:1,settings:{chatEnabled:true},messages:[]}});
  return response({});
 }});
 f.load('Object.assign(client,{filteredMembers,openMemberEditor,submitMemberEdit,restoreMember,closeMemberEditor,changeMemberPage,setupMemberControls});');
 f.element('members-filter').value='all';f.client.setupMemberControls();
 return f;
}

test('public entry requires registration, cannot close, and never starts unauthenticated playback',async()=>{
 const f=fixture({state:{authorized:false,authenticated:false,registrationRequired:true},fetch:async()=>response({authorized:false,authenticated:false,registrationRequired:true,ready:true,selection:{kind:'url'},room:{version:2,messages:[],settings:{chatEnabled:true}}})});
 f.load(welcomeEvents);f.client.renderPublicEntry();
 assert.equal(f.element('welcome-dialog').open,true);assert.equal(f.element('welcome-close').hidden,true);assert.equal(f.element('welcome-close').disabled,true);
 assert.equal(f.element('welcome-submit').disabled,false);assert.equal(f.document.activeElement,f.element('welcome-username'));
 const cancel={type:'cancel',defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
 assert.equal(f.element('welcome-dialog').dispatchEvent(cancel),false);
 await f.client.refresh();
 assert.equal(f.context.watchCount,0);assert.equal(f.element('start').hidden,true);assert.equal(f.element('chat-text').disabled,true);assert.equal(f.streams.length,0);
 assert.equal(f.element('welcome-dialog').showCount,1,'status polls preserve the existing signup dialog');
});

test('direct player entry also rejects a ready but unauthenticated session',()=>{
 const f=fixture({state:{authorized:true,authenticated:false,ready:true}});
 f.load(section('function watch()','function buffer()')+';watch();');
 assert.equal(f.context.stopCount,0);assert.equal(f.client.isRunning(),false);
});

test('join submits once, trims fields, and waits for authenticated status before closing',async()=>{
 let release;const waiting=new Promise(resolve=>{release=resolve;});
 const f=fixture({state:{authorized:false,authenticated:false,registrationRequired:true},fetch:async request=>request.path==='/api/join'?waiting:request.path.startsWith('/api/status')?response({authorized:true,authenticated:true,registrationRequired:false,ready:false,profile:{name:'سارة'},room:{version:2,name:'سارة',settings:{chatEnabled:true},messages:[]}}):response({})});
 f.element('privacy-telemetry').checked=false;f.client.renderPublicEntry();
 f.element('welcome-username').value='  sara_22  ';f.element('welcome-name').value=' سارة ';f.element('welcome-avatar').value='green';
 let prevented=0;const event={preventDefault(){prevented++;}};
 const first=f.client.joinRoom(event);await f.client.joinRoom(event);
 assert.equal(f.requests.filter(request=>request.path==='/api/join').length,1);assert.equal(f.element('welcome-submit').disabled,true);assert.equal(f.client.getJoining(),true);
 assert.deepEqual(f.requests[0].body,{username:'sara_22',name:'سارة',avatar:'green'});
 release(response({ok:true}));await first;await settle();
 assert.equal(prevented,2);assert.equal(f.client.getJoining(),false);assert.equal(f.element('welcome-submit').disabled,false);
 assert.equal(f.element('welcome-error').hidden,true);assert.equal(f.element('welcome-dialog').open,false);assert.equal(f.streams.length,1);
 assert(f.requests.some(request=>request.path.startsWith('/api/status')),'join must verify the server session');
});

test('join errors retain the entered identity and allow a retry',async()=>{
 const f=fixture({state:{authorized:false,authenticated:false,registrationRequired:true},fetch:async()=>response({error:'اسم المستخدم مستخدم مسبقًا'},409)});
 f.element('welcome-username').value='sara_22';f.element('welcome-name').value='سارة';
 await f.client.joinRoom({preventDefault(){}});
 assert.equal(f.element('welcome-error').hidden,false);assert.equal(f.element('welcome-error').textContent,'اسم المستخدم مستخدم مسبقًا');
 assert.equal(f.element('welcome-username').value,'sara_22');assert.equal(f.element('welcome-name').value,'سارة');assert.equal(f.element('welcome-submit').disabled,false);
 await f.client.joinRoom({preventDefault(){}});assert.equal(f.requests.length,2);
});

test('joining during an old guest poll fetches a fresh authenticated status after that poll',async()=>{
 let releaseGuest,statusCalls=0;const guest=new Promise(resolve=>{releaseGuest=resolve;});
 const f=fixture({state:{authorized:false,authenticated:false,registrationRequired:true},fetch:async request=>{
  if(request.path.startsWith('/api/status'))return ++statusCalls===1?guest:response({authorized:true,authenticated:true,registrationRequired:false,ready:false,room:{version:2,name:'سارة',settings:{chatEnabled:true},messages:[]}});
  return response({ok:true});
 }});
 f.element('privacy-telemetry').checked=false;const oldPoll=f.client.refresh();
 const joining=f.client.joinRoom({preventDefault(){}});await settle();assert.equal(statusCalls,1);assert.equal(f.client.getJoining(),true);
 releaseGuest(response({authorized:false,authenticated:false,registrationRequired:true,ready:true}));await oldPoll;await joining;
 assert.equal(statusCalls,2);assert.equal(f.client.needsRegistration(),false);assert.equal(f.element('welcome-dialog').open,false);assert.equal(f.element('welcome-error').hidden,true);
});

test('a join response without an authenticated cookie keeps the registration gate open',async()=>{
 const f=fixture({state:{authorized:false,authenticated:false,registrationRequired:true},fetch:async request=>response(request.path==='/api/join'?{ok:true}:{authorized:false,authenticated:false,registrationRequired:true,ready:true})});
 await f.client.joinRoom({preventDefault(){}});
 assert.equal(f.element('welcome-dialog').open,true);assert.match(f.element('welcome-error').textContent,/جلستك/);assert.equal(f.context.watchCount,0);
});

test('SSE delta and full action acknowledgments deduplicate messages and preserve the active chat UI',()=>{
 const at=Date.now(),one={id:'one',name:'سارة',text:'مخفي',spoiler:true,at},two={id:'two',name:'علي',text:'أهلًا',at:at+1},three={id:'three',name:'نور',text:'وصلت',at:at+2};
 const f=fixture({room:{version:10,messages:[one,two]}}),log=f.element('chat-log');
 log.scrollHeight=1600;log.clientHeight=300;log.scrollTop=220;f.client.renderChat();
 const first=log.children[0],second=log.children[1],spoiler=first.querySelector('details');spoiler.open=true;
 first.querySelectorAll('button').find(button=>button.textContent==='رد').click();
 const draft=f.element('chat-text');draft.value='رد لا يزال قيد الكتابة';draft.selectionStart=5;draft.selectionEnd=8;
 f.client.setRevision('unchanged-source:weak');f.client.setRunning(true);f.client.connectRoomEvents();
 const stream=f.streams[0];stream.onopen();stream.emit('room',{room:{version:11,messagesDelta:{added:[three,three],removed:[]}}});
 f.client.applyRoom({version:11,messages:[one,two,three,three]});
 stream.emit('room',{room:{version:11,messagesDelta:{added:[three],removed:[]}}});
 assert.deepEqual(plain(f.client.getRoom().messages).map(message=>message.id),['one','two','three']);
 assert.equal(log.children.length,3);assert.equal(log.children[0],first);assert.equal(log.children[1],second);assert.equal(spoiler.open,true);
 assert.equal(log.scrollTop,220);assert.equal(draft.value,'رد لا يزال قيد الكتابة');assert.equal(draft.selectionStart,5);assert.equal(draft.selectionEnd,8);assert.equal(f.document.activeElement,draft);assert.equal(f.element('reply-preview').hidden,false);
 assert.equal(f.client.getRevision(),'unchanged-source:weak');assert.equal(f.client.isRunning(),true);assert.equal(f.context.watchCount,0);assert.equal(f.context.stopCount,0);
 stream.emit('room',{room:{version:12,messagesDelta:{added:[],removed:['two']}}});
 assert.deepEqual(plain(f.client.getRoom().messages).map(message=>message.id),['one','three']);assert.equal(second.parentNode,null);assert.equal(log.children[0],first);
 f.client.applyRoom({version:10,messages:[]});assert.equal(log.children.length,2,'late acknowledgments must not roll back newer messages');
});

test('delta removal wins over duplicate additions and full snapshots can clear the chat',()=>{
 const f=fixture({room:{version:2,messages:[{id:'keep',text:'باقية',name:'أ',at:1},{id:'gone',text:'تحذف',name:'ب',at:2}]}});
 f.client.applyRoom({version:3,messagesDelta:{added:[{id:'gone',text:'قديمة'},null,{id:'new',text:'جديدة',name:'ج',at:3}],removed:['gone']}});
 assert.deepEqual(plain(f.client.getRoom().messages).map(message=>message.id),['keep','new']);
 f.client.applyRoom({version:4,messages:[]});assert.equal(f.element('chat-log').children.length,0);assert.equal(f.client.getNodes().size,0);
});

test('a delayed first SSE snapshot cannot overwrite a newer acknowledged chat state',()=>{
 const message={id:'acknowledged',text:'وصلت للتو',name:'نور',at:Date.now()},f=fixture({room:{version:5,messages:[]}});
 f.client.connectRoomEvents();f.client.applyRoom({version:7,messages:[message]});
 f.streams[0].emit('room',{room:{version:6,messages:[]}});
 assert.deepEqual(plain(f.client.getRoom().messages),[message]);assert.equal(f.element('chat-log').children.length,1);
});

test('reconnect snapshots keep same-instance version ordering and accept a restarted server instance',()=>{
 const message={id:'before-restart',text:'رسالة سابقة',name:'نور',at:Date.now()},f=fixture({room:{instanceId:'server-a',version:80,messages:[message],role:'moderator',pinned:message}});
 f.client.renderChat();f.client.connectRoomEvents();f.streams[0].onerror();const timer=[...f.timers.keys()][0];f.runTimer(timer);
 const reconnected=f.streams[1];reconnected.onopen();reconnected.emit('room',{room:{instanceId:'server-a',version:79,messages:[],settings:{chatEnabled:false}}});
 assert.equal(f.client.getRoom().version,80);assert.deepEqual(plain(f.client.getRoom().messages),[message]);assert.equal(f.client.getRoom().settings.chatEnabled,true);
 assert.equal(f.client.mergeRoom({instanceId:'server-a',version:2,messages:[]},{reset:true}),false,'a reconnect hint cannot bypass same-instance ordering');
 const fresh={id:'after-restart',text:'بدأ الخادم الجديد',name:'سارة',at:Date.now()};
 f.client.setRevision('preserved-playback');f.client.setRunning(true);
 reconnected.emit('room',{room:{instanceId:'server-b',version:1,messages:[fresh],settings:{chatEnabled:true}}});
 assert.equal(f.client.getRoom().instanceId,'server-b');assert.equal(f.client.getRoom().version,1);assert.deepEqual(plain(f.client.getRoom().messages),[fresh]);
 assert.equal(f.client.getRoom().role,undefined);assert.equal(f.client.getRoom().pinned,undefined);assert.equal(f.element('chat-log').children.length,1);assert.equal(f.element('chat-log').children[0].dataset.messageId,'after-restart');
 assert.equal(f.client.getRevision(),'preserved-playback');assert.equal(f.context.watchCount,0);assert.equal(f.context.stopCount,0);assert.equal(f.client.isRunning(),true);
});

test('status fallback fetches full history after a server restart with a matching version number',async()=>{
 const oldMessage={id:'old-history',name:'نور',text:'قبل إعادة التشغيل',at:Date.now()},newMessage={id:'new-history',name:'سارة',text:'بعد إعادة التشغيل',at:Date.now()+1};
 const status={authorized:true,authenticated:true,ready:true,selection:{kind:'url'},room:{instanceId:'new-server',version:1,settings:{chatEnabled:true}}};
 let releaseHistory;const history=new Promise(resolve=>{releaseHistory=resolve;});
 const f=fixture({state:{ready:true},room:{instanceId:'old-server',version:1,messages:[oldMessage]},fetch:async request=>request.path==='/api/status?since=1'?response(status):request.path==='/api/status?since=0'?history:assert.fail('unexpected request: '+request.path)});
 f.context.window.EventSource=undefined;f.client.renderChat();f.client.setRunning(true);f.client.setRevision('same-source:fast');
 const refreshing=f.client.refresh();await settle();
 assert.deepEqual(f.requests.map(request=>request.path),['/api/status?since=1','/api/status?since=0']);assert(f.requests.every(request=>request.method===undefined),'both requests are read only status GETs');
 assert.equal(f.client.getRoom().instanceId,'old-server');assert.equal(f.element('chat-log').children[0].dataset.messageId,'old-history','keep existing history while the replacement snapshot loads');
 releaseHistory(response({...status,room:{...status.room,messages:[newMessage]}}));await refreshing;
 assert.equal(f.requests.length,2);assert.equal(f.client.getRoom().instanceId,'new-server');assert.equal(f.client.getRoom().version,1);assert.deepEqual(plain(f.client.getRoom().messages),[newMessage]);
 assert.equal(f.element('chat-log').children.length,1);assert.equal(f.element('chat-log').children[0].dataset.messageId,'new-history');assert.equal(f.streams.length,0);
 assert.equal(f.client.getRevision(),'same-source:fast');assert.equal(f.client.isRunning(),true);assert.equal(f.context.watchCount,0);assert.equal(f.context.stopCount,0);
});

test('failed chat sends preserve the draft and a successful acknowledgment does not delete newer typing',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const f=fixture({fetch:async()=>pending});f.element('chat-text').value='الرسالة الأولى';
 const sending=f.client.sendChat({preventDefault(){}});await f.client.sendChat({preventDefault(){}});
 assert.equal(f.requests.length,1);assert.equal(f.element('send-chat').disabled,true);
 f.element('chat-text').value='بدأت كتابة رسالة ثانية';release(response({room:{version:2,messages:[]}}));await sending;
 assert.equal(f.element('chat-text').value,'بدأت كتابة رسالة ثانية');assert.equal(f.element('send-chat').disabled,false);
 const failed=fixture({fetch:async()=>response({error:'حاول بعد قليل'},429)});failed.element('chat-text').value='لا تفقدني';await failed.client.sendChat({preventDefault(){}});
 assert.equal(failed.element('chat-text').value,'لا تفقدني');assert.equal(failed.element('notice').textContent,'حاول بعد قليل');assert.equal(failed.element('send-chat').disabled,false);
});

test('chat toggle is owner only even for a moderator invoking the handler directly',async()=>{
 const moderator=fixture({state:{canControl:false},room:{role:'moderator'}});moderator.client.renderRoom();await moderator.client.toggleChat();
 assert.equal(moderator.element('owner-chat-controls').hidden,true);assert.equal(moderator.element('chat-toggle').hidden,true);assert.equal(moderator.element('chat-toggle').disabled,true);assert.equal(moderator.requests.length,0);
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const owner=fixture({state:{canControl:true},fetch:async()=>pending});
 const first=owner.client.toggleChat();await owner.client.toggleChat();assert.equal(owner.requests.length,1);assert.deepEqual(owner.requests[0].body,{chatEnabled:false});assert.equal(owner.element('chat-toggle').disabled,true);
 release(response({room:{version:2,settings:{chatEnabled:false}}}));await first;
 assert.equal(owner.element('chat-toggle').disabled,false);assert.equal(owner.element('chat-toggle').getAttribute('aria-pressed'),'false');assert.equal(owner.element('chat-text').disabled,true);
});

test('public links and browser sharing never include an admin key, query, or private path',async()=>{
 const f=fixture();f.load(sharing);
 for(const candidate of ['https://room.example/admin?key=private#admin=secret','/admin?token=private','https://external.example/?key=private','javascript:alert(1)']){
  f.client.setState({...f.client.getState(),publicRoomURL:candidate,playlist:'https://room.example/private?key=owner'});
  f.client.renderPublicEntry();assert.equal(f.element('public-room-link').value,'https://room.example/');
  await f.element('copy-public-room').click();await f.element('share-public-room').click();
 }
 assert.deepEqual(f.copied,Array(4).fill('https://room.example/'));assert.equal(f.shares.length,4);
 for(const share of f.shares)assert.deepEqual(plain(share),{title:'شاهد معي على دشوف',url:'https://room.example/'});
 const fallback=fixture({state:{publicRoomURL:'/admin#admin=private'},navigator:{share:undefined}});fallback.load(sharing);await fallback.element('share-public-room').click();assert.deepEqual(fallback.copied,['https://room.example/']);
});

test('SSE reconnects use a single bounded retry timer and stop on exit or lost authorization',()=>{
 const f=fixture(),delays=[];f.client.connectRoomEvents();f.client.connectRoomEvents();assert.equal(f.streams.length,1);assert.equal(f.streams[0].url,'/api/events');
 for(let attempt=0;attempt<8;attempt++){
  const stream=f.streams.at(-1);stream.onerror();stream.onerror();assert.equal(stream.closed,true);assert.equal(f.timers.size,1);
  const [id,timer]=[...f.timers][0];delays.push(timer.ms);f.client.connectRoomEvents();assert.equal(f.streams.length,attempt+1);f.runTimer(id);
 }
 assert.deepEqual(delays,[1000,2000,4000,8000,16000,30000,30000,30000]);
 f.streams.at(-1).onopen();assert.equal(f.client.getConnected(),true);f.streams.at(-1).onerror();assert.equal([...f.timers.values()][0].ms,1000,'successful reconnect resets backoff');
 f.client.stopRoomEvents();assert.equal(f.timers.size,0);f.client.setPageLeaving(true);f.client.connectRoomEvents();assert.equal(f.streams.length,9);
 f.client.setPageLeaving(false);f.client.setState({authorized:false,authenticated:false});f.client.connectRoomEvents();assert.equal(f.streams.length,9);
});

test('status polling slows with SSE, weak connections, hidden pages, and repeated failures',async()=>{
 const f=fixture();f.client.connectRoomEvents();f.streams[0].onopen();
 assert.equal(f.client.statusPollDelay(),10000);f.element('network-mode').value='weak';assert.equal(f.client.statusPollDelay(),15000);
 f.element('network-mode').value='emergency';assert.equal(f.client.statusPollDelay(),30000);f.document.hidden=true;assert.equal(f.client.statusPollDelay(),30000);
 f.client.setPollFailures(7);assert.equal(f.client.statusPollDelay(),60000);f.client.stopRoomEvents();f.client.setPollFailures(0);f.document.hidden=false;
 assert.equal(f.client.statusPollDelay(),15000);f.element('network-mode').value='weak';assert.equal(f.client.statusPollDelay(),12000);
 const offline=fixture({fetch:async()=>{throw Error('offline');}});await offline.client.pollStatus();assert.equal(offline.client.getPollFailures(),1);assert.equal([...offline.timers.values()][0].ms,20000);
 offline.client.setPageLeaving(true);await offline.client.pollStatus();assert.equal(offline.requests.length,1,'leaving pages cannot start another status request');
});

test('hidden SSE retry waits at least fifteen seconds and ignores obsolete stream callbacks',()=>{
 const f=fixture();f.document.hidden=true;f.client.connectRoomEvents();const first=f.streams[0];first.onerror();
 const [id,timer]=[...f.timers][0];assert.equal(timer.ms,15000);f.runTimer(id);const current=f.streams[1];current.onopen();
 first.onerror();first.onopen();first.emit('room',{room:{version:99,messages:[]}});
 assert.equal(current.closed,false);assert.equal(f.timers.size,0);assert.equal(f.client.getConnected(),true);assert.equal(f.client.getRoom().version,1);
});

test('privacy opt out suppresses battery and location calls, including explicit location requests',async()=>{
 let batteryCalls=0,locationCalls=0;
 const f=fixture({navigator:{getBattery:async()=>{batteryCalls++;return {level:.5,charging:true};},geolocation:{getCurrentPosition(){locationCalls++;},watchPosition(){throw Error('background location is forbidden');}}},storage:{'dshoof-telemetry':'off'}});
 f.client.setupPrivacy();assert.equal(f.element('privacy-telemetry').checked,false);assert.equal(f.element('privacy-location-button').disabled,true);
 assert.deepEqual(plain(await f.client.collectClientInfo()),{});await f.client.shareLocation();
 assert.equal(batteryCalls,0);assert.equal(locationCalls,0);assert.equal(f.client.getSharedLocation(),null);
});

test('location collection starts only on a click, rounds coordinates, and clearing cancels stale callbacks',async()=>{
 const locations=[];let watches=0;
 const f=fixture({navigator:{geolocation:{getCurrentPosition(success,error,options){locations.push({success,error,options});},watchPosition(){watches++;}}}});
 f.client.setupPrivacy();const before=await f.client.collectClientInfo();assert.equal(locations.length,0);assert.equal(Object.hasOwn(before,'location'),false);
 await f.element('privacy-location-button').click();assert.equal(locations.length,1);assert.equal(locations[0].options.enableHighAccuracy,false);assert.equal(locations[0].options.timeout,10000);
 await locations[0].success({coords:{latitude:33.315267,longitude:44.366081,accuracy:12.7}});await settle();
 assert.deepEqual(plain(f.client.getSharedLocation()),{latitude:33.315,longitude:44.366,accuracy:13});
 const report=f.requests.find(request=>request.path==='/api/report');assert.deepEqual(report.body.clientInfo.location,{latitude:33.315,longitude:44.366,accuracy:13});
 await f.element('privacy-location-button').click();assert.equal(locations.length,2);await f.element('privacy-location-clear').click();
 await locations[1].success({coords:{latitude:1.23456,longitude:2.34567,accuracy:1}});await settle();
 assert.equal(f.client.getSharedLocation(),null);assert.equal(Object.hasOwn(await f.client.collectClientInfo(),'location'),false);assert.equal(f.element('privacy-location-clear').hidden,true);assert.equal(watches,0);
 assert.deepEqual(f.requests.at(-1).body,{location:false},'clearing explicitly revokes location on the server');
});

test('opting out during pending battery or location requests cannot publish stale private data',async()=>{
 let releaseBattery,locationSuccess;const battery=new Promise(resolve=>{releaseBattery=resolve;});
 const f=fixture({navigator:{getBattery:()=>battery,geolocation:{getCurrentPosition(success){locationSuccess=success;}}}});
 f.client.setupPrivacy();const collecting=f.client.collectClientInfo();await f.element('privacy-location-button').click();
 f.element('privacy-telemetry').checked=false;const optingOut=f.element('privacy-telemetry').onchange();
 await locationSuccess({coords:{latitude:33.12345,longitude:44.67891,accuracy:10}});releaseBattery({level:.72,charging:false});await optingOut;
 assert.deepEqual(plain(await collecting),{});await settle();assert.equal(f.client.getSharedLocation(),null);assert.equal(f.stored.get('dshoof-telemetry'),'off');
 assert(f.requests.filter(request=>request.path==='/api/report').every(request=>Object.keys(request.body.clientInfo).length===0));assert.equal([...f.timers.values()].filter(timer=>timer.ms===1200).length,0,'completed battery calls clear their deadline');
 assert(f.requests.some(request=>request.path==='/api/privacy'&&request.body.device===false),'opting out explicitly revokes server device data');
});

test('a late location policy acknowledgment after clearing cannot reinsert coordinates or report them',async()=>{
 let locationSuccess,releasePermission;const permission=new Promise(resolve=>{releasePermission=resolve;});
 const f=fixture({navigator:{geolocation:{getCurrentPosition(success){locationSuccess=success;}}},fetch:async request=>request.path==='/api/privacy'&&request.body.location===true?permission:response({})});
 f.client.setupPrivacy();await f.element('privacy-location-button').click();
 const pendingLocation=locationSuccess({coords:{latitude:33.315267,longitude:44.366081,accuracy:5}});
 await settle();assert.deepEqual(f.requests.filter(request=>request.path==='/api/privacy').map(request=>request.body),[{location:true}]);
 assert.equal(f.client.getSharedLocation(),null);assert.equal(f.requests.filter(request=>request.path==='/api/report').length,0,'coordinates wait for privacy policy acknowledgment');
 const clearing=f.element('privacy-location-clear').click();await settle();
 assert.equal(f.client.getSharedLocation(),null);assert.deepEqual(f.requests.filter(request=>request.path==='/api/privacy').map(request=>request.body),[{location:true}],'revocation waits so an older allow request cannot finish after the final deny');
 releasePermission(response({}));await Promise.all([pendingLocation,clearing]);await settle();
 assert.equal(f.client.getSharedLocation(),null);assert.equal(f.requests.filter(request=>request.path==='/api/report').length,0);
 assert.deepEqual(f.requests.filter(request=>request.path==='/api/privacy').map(request=>request.body),[{location:true},{location:false}]);
});

test('opting in waits for server privacy acknowledgment before reading sensors or reporting',async()=>{
 let releasePermission,batteryCalls=0;const permission=new Promise(resolve=>{releasePermission=resolve;});
 const f=fixture({storage:{'dshoof-telemetry':'off'},navigator:{getBattery:async()=>{batteryCalls++;return {level:.4,charging:false};}},fetch:async request=>request.path==='/api/privacy'?permission:response({})});
 f.client.setupPrivacy();f.element('privacy-telemetry').checked=true;const optingIn=f.element('privacy-telemetry').onchange();
 assert.equal(f.element('privacy-telemetry').disabled,true);assert.deepEqual(plain(await f.client.collectClientInfo()),{});assert.equal(batteryCalls,0);assert.equal(f.requests.filter(request=>request.path==='/api/report').length,0);
 releasePermission(response({}));await optingIn;await settle();assert.equal(f.element('privacy-telemetry').disabled,false);assert.equal(batteryCalls,1);
 const report=f.requests.find(request=>request.path==='/api/report');assert.equal(report.body.clientInfo.shared,true);assert.equal(report.body.clientInfo.location,undefined);
});

test('a rejected privacy policy update keeps optional collection disabled',async()=>{
 let batteryCalls=0;const f=fixture({storage:{'dshoof-telemetry':'off'},navigator:{getBattery:async()=>{batteryCalls++;return {level:.5};}},fetch:async()=>response({error:'تعذر الحفظ'},503)});
 f.client.setupPrivacy();f.element('privacy-telemetry').checked=true;await f.element('privacy-telemetry').onchange();
 assert.deepEqual(plain(await f.client.collectClientInfo()),{});assert.equal(batteryCalls,0);assert.equal(f.element('privacy-location-button').disabled,true);assert.match(f.element('notice').textContent,/تعذر تأكيد حفظ الخصوصية/);
});

test('member roster and detailed device information remain owner only',()=>{
 const member={id:'m1',username:'sara',name:'سارة',online:true,info:{device:'هاتف',ip:'198.51.100.10',battery:{level:50,charging:false}}};
 const f=fixture({state:{members:[member]},room:{role:'moderator',online:7,roster:[{name:'سارة'}]}});
 f.element('members-list').append(f.document.createElement('div'));f.client.renderRoom();f.client.renderMembers();f.client.showMemberDetails(member);
 assert.equal(f.element('audience').hidden,true);assert.equal(f.element('audience').textContent,'');assert.equal(f.element('viewer-roster').hidden,true);assert.equal(f.element('viewer-roster').children.length,0);
 assert.equal(f.element('members-list').children.length,0);assert.equal(f.element('viewer-details-dialog').open,false);assert.equal(f.element('viewer-details-body').children.length,0);
});

test('owner member details show flat metadata as text and member actions use the opaque ID',async()=>{
 const malicious='<img src=x onerror=alert(1)>',member={id:'opaque-member-7',username:'sara',name:malicious,displayName:malicious,online:true,joinedAt:'2026-10-18T00:00:00Z',info:{at:'2026-10-18T00:01:00Z',device:'هاتف',browser:'متصفح',os:'Android',ip:'198.51.100.22',ipSource:'proxy',battery:{level:72,charging:true},network:{effectiveType:'4g',downlink:5,rtt:100,saveData:true},screen:{width:1080,height:1920},location:{latitude:33.315,longitude:44.366,accuracy:13}},report:{buffer:8}};
 const f=fixture({state:{canControl:true,members:[member]},room:{roster:[{name:malicious}]}});f.client.renderRoom();f.client.renderMembers();
 const card=f.element('members-list').children[0];assert(card.textContent.includes(malicious));assert(card.textContent.includes('هاتف'));
 const title=card.querySelector('.member-title');assert.equal(title.tagName,'BUTTON');title.click();
 assert.equal(f.element('viewer-details-dialog').open,true);assert.equal(f.element('viewer-details-title').textContent,malicious);
 const details=f.element('viewer-details-body').textContent;for(const value of ['198.51.100.22','هاتف','متصفح','Android','72%','33.315, 44.366'])assert(details.includes(value),value);
 assert.equal(card.querySelector('img'),null);assert.equal(f.element('viewer-details-body').querySelector('img'),null);
 await card.querySelectorAll('button').find(button=>button.textContent==='كتم الدردشة').click();
 assert.equal(f.requests[0].path,'/api/revoke');assert.deepEqual(f.requests[0].body,{id:'opaque-member-7',action:'mute'});
});

test('owner analytics display audience counts and hours, then clear immediately after owner access is lost',()=>{
 const analytics={current:{unique:12},day:{unique:33},total:{unique:87,watchSeconds:9000}},member={id:'private-member',name:'سارة',info:{ip:'198.51.100.22'}};
 const f=fixture({state:{canControl:true,analytics,members:[member]}});f.client.renderRoom();f.client.renderMembers();f.client.showMemberDetails(member);
 assert.equal(f.element('owner-analytics').hidden,false);
 for(const [id,value]of Object.entries({'analytics-current-viewers':'12','analytics-today-viewers':'33','analytics-total-viewers':'87','analytics-total-hours':'2.5'}))assert.equal(f.element(id).textContent,value,id);
 assert.equal(f.element('viewer-details-dialog').open,true);assert(f.element('viewer-details-body').textContent.includes('198.51.100.22'));
 f.client.setState({...f.client.getState(),canControl:false});f.client.setRoom({...f.client.getRoom(),role:'moderator'});f.client.renderRoom();
 assert.equal(f.element('owner-analytics').hidden,true);
 for(const id of ['analytics-current-viewers','analytics-today-viewers','analytics-total-viewers','analytics-total-hours'])assert.equal(f.element(id).textContent,'',id);
 assert.equal(f.element('viewer-details-dialog').open,false);assert.equal(f.element('viewer-details-body').children.length,0);assert.equal(f.element('members-list').children.length,0);
});

test('owner session history shows only the latest twenty sessions, readable durations, and untrusted titles as text',()=>{
 const malicious='<img src=x onerror=alert(1)>',sessions=Array.from({length:25},(_,index)=>({broadcastTitle:index===24?malicious:'جلسة '+index,start:new Date(Date.UTC(2026,9,1,0,index)).toISOString(),...(index<24?{end:new Date(Date.UTC(2026,9,1,1,index)).toISOString()}:{}),seconds:index===24?3661:index===23?61:45}));
 const member={id:'history-member',name:'سارة',info:{location:{latitude:33.315,longitude:44.366,accuracy:13}},analytics:{currentSeconds:45,todaySeconds:120,totalSeconds:7260,sessions}};
 const f=fixture({state:{canControl:true}});f.client.showMemberDetails(member);const body=f.element('viewer-details-body'),list=body.querySelector('.member-sessions');
 assert.equal(list.children.length,20);assert(list.children[0].textContent.startsWith(malicious+' · '));assert(list.children[0].textContent.includes('قيد المشاهدة'));assert(list.children[0].textContent.endsWith('1:01 ساعة'));
 assert(list.children[1].textContent.startsWith('جلسة 23 · '));assert(list.children[1].textContent.endsWith('1 دقيقة'));assert(list.children[2].textContent.endsWith('45 ثانية'));assert(list.children[19].textContent.startsWith('جلسة 5 · '));
 const rows=new Map(body.querySelectorAll('.member-detail').map(row=>[row.children[0].textContent,row.children[1].textContent]));
 assert.equal(rows.get('مدة المشاهدة في البث الحالي · تقريبية'),'45 ثانية');assert.equal(rows.get('مدة المشاهدة اليوم · تقريبية'),'2 دقيقة');assert.equal(rows.get('إجمالي مدة المشاهدة · تقريبية'),'2:01 ساعة');
 assert.equal(body.querySelector('img'),null);assert.equal(body.querySelector('iframe'),null);
 const map=body.querySelector('a');assert(map);const url=new URL(map.href);assert.equal(url.origin,'https://www.openstreetmap.org');assert.equal(url.searchParams.get('mlat'),'33.315');assert.equal(url.searchParams.get('mlon'),'44.366');assert.equal(map.target,'_blank');assert.equal(map.rel,'noopener noreferrer');assert.equal(f.requests.length,0,'viewing shared coordinates does not contact a map service');
 f.client.showMemberDetails({...member,info:{location:{latitude:91,longitude:44.366}}});assert.equal(body.querySelector('a'),null,'out of range coordinates must not create a map link');
});

test('account management is owner only and the editor offers exactly the three assignable roles',async()=>{
 const roleSelect=/<select id="member-edit-role">([\s\S]*?)<\/select>/.exec(html);assert(roleSelect);
 assert.deepEqual([...roleSelect[1].matchAll(/<option value="([^"]+)"/g)].map(match=>match[1]),['viewer','stream','moderator']);
 const member={id:'member-guard',name:'سارة',username:'sara',role:'viewer',revoked:true};
 for(const role of ['viewer','stream','moderator']){
  const f=memberFixture([member],{state:{canControl:false},fetch:async()=>assert.fail('nonowner account management must not issue requests')});f.client.setRoom({...f.client.getRoom(),role});
  f.client.openMemberEditor(member.id);f.element('member-edit-id').value=member.id;
  await f.client.submitMemberEdit({preventDefault(){}});await f.client.restoreMember(member.id);
  assert.equal(f.element('member-edit-dialog').open,false);assert.equal(f.requests.length,0);
 }
 const lost=memberFixture([member]);lost.client.openMemberEditor(member.id);assert.equal(lost.element('member-edit-dialog').open,true);lost.client.setState({...lost.client.getState(),canControl:false});lost.client.renderRoom();
 assert.equal(lost.element('member-edit-dialog').open,false);for(const id of ['member-edit-id','member-edit-username','member-edit-name'])assert.equal(lost.element(id).value,'');
 await lost.client.submitMemberEdit({preventDefault(){}});assert.equal(lost.requests.length,0);
});

test('owner account edits send the exact member ID and selected permitted role, then refresh the member record',async()=>{
 for(const role of ['viewer','stream','moderator']){
  const original={id:'opaque-edit-id',username:'sara_old',name:'سارة القديمة',avatar:'purple',role:'viewer'},f=memberFixture([original]);f.client.renderMembers();
  f.client.openMemberEditor(original.id);assert.equal(f.element('member-edit-dialog').open,true);assert.equal(f.element('member-edit-username').value,'sara_old');
  f.element('member-edit-id').value='tampered-other-id';f.element('member-edit-username').value='  SARA_new  ';f.element('member-edit-name').value=' سارة الجديدة ';f.element('member-edit-avatar').value='green';f.element('member-edit-role').value=role;
  await f.client.submitMemberEdit({preventDefault(){}});
  const update=f.requests.find(request=>request.path==='/api/members');assert(update);assert.equal(update.method,'POST');
  assert.deepEqual(update.body,{action:'update',id:'opaque-edit-id',username:'sara_new',name:'سارة الجديدة',avatar:'green',role});
  assert(f.requests.some(request=>request.path.startsWith('/api/status')));assert.equal(f.client.getState().members[0].name,'سارة الجديدة');assert.equal(f.client.getState().members[0].role,role);
  assert.equal(f.element('member-edit-dialog').open,false);assert.equal(f.element('member-edit-submit').disabled,false);assert(f.element('members-list').textContent.includes('سارة الجديدة'));
 }
 const invalid=memberFixture([{id:'invalid-role',username:'sara',name:'سارة',role:'viewer'}]);invalid.client.openMemberEditor('invalid-role');invalid.element('member-edit-role').value='owner';
 await invalid.client.submitMemberEdit({preventDefault(){}});assert.equal(invalid.requests.length,0,'a tampered role cannot attempt to grant owner access');assert.equal(invalid.element('member-edit-dialog').open,true);assert.equal(invalid.element('member-edit-error').hidden,false);
});

test('account editing suppresses duplicate submissions and preserves the draft after a server error',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const f=memberFixture([{id:'conflicting-user',username:'sara',name:'سارة',role:'viewer'}],{fetch:async()=>pending});f.client.openMemberEditor('conflicting-user');
 f.element('member-edit-username').value='username_taken';f.element('member-edit-name').value='اسم قيد التعديل';f.element('member-edit-avatar').value='gold';f.element('member-edit-role').value='moderator';
 const first=f.client.submitMemberEdit({preventDefault(){}});await f.client.submitMemberEdit({preventDefault(){}});assert.equal(f.requests.length,1);assert.equal(f.element('member-edit-submit').disabled,true);
 f.client.closeMemberEditor();assert.equal(f.element('member-edit-dialog').open,true,'an in-flight update cannot close its editor before the result arrives');
 const cancel={type:'cancel',defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};assert.equal(f.element('member-edit-dialog').dispatchEvent(cancel),false);
 release(response({error:'اسم المستخدم مستخدم مسبقًا'},409));await first;
 assert.equal(f.element('member-edit-dialog').open,true);assert.equal(f.element('member-edit-error').hidden,false);assert.equal(f.element('member-edit-error').textContent,'اسم المستخدم مستخدم مسبقًا');assert.equal(f.element('member-edit-submit').disabled,false);
 assert.equal(f.element('member-edit-username').value,'username_taken');assert.equal(f.element('member-edit-name').value,'اسم قيد التعديل');assert.equal(f.element('member-edit-avatar').value,'gold');assert.equal(f.element('member-edit-role').value,'moderator');
});

test('restoring a blocked account sends a restore action and refreshes its status without changing its identity',async()=>{
 const member={id:'blocked-member-id',username:'sara',name:'سارة',avatar:'blue',role:'moderator',revoked:true},f=memberFixture([member]);f.client.renderMembers();
 const card=f.element('members-list').children[0],restoreButton=card.querySelectorAll('button').find(button=>button.textContent==='إلغاء الحظر');assert.equal(restoreButton.hidden,false);assert.equal(card.querySelectorAll('button').find(button=>button.textContent==='حظر العضو').hidden,true);
 await f.client.restoreMember(member.id);
 const restore=f.requests.find(request=>request.path==='/api/members');assert(restore);assert.deepEqual(restore.body,{action:'restore',id:member.id});
 assert(f.requests.some(request=>request.path.startsWith('/api/status')));assert.equal(f.client.getState().members[0].revoked,false);assert.equal(f.client.getState().members[0].username,'sara');assert.equal(f.client.getState().members[0].role,'moderator');
 assert.equal(f.element('members-list').children[0],card);assert.equal(restoreButton.hidden,true);const count=f.requests.length;await f.client.restoreMember(member.id);assert.equal(f.requests.length,count,'an account that is already active does not need restoration');
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const guarded=memberFixture([member],{fetch:async request=>request.path==='/api/members'?pending:response({authorized:true,authenticated:true,canControl:true,ready:false,members:[{...member,revoked:false}],room:{version:1,settings:{chatEnabled:true},messages:[]}})});guarded.client.renderMembers();
 const restoring=guarded.client.restoreMember(member.id);await guarded.client.restoreMember(member.id);assert.equal(guarded.requests.length,1);assert(guarded.element('members-list').children[0].querySelectorAll('button').filter(button=>button.textContent!=='تفاصيل العضو'&&button.className!=='member-title').every(button=>button.disabled));
 release(response({ok:true}));await restoring;assert.equal(guarded.client.getState().members[0].revoked,false);
});

test('member search and status filters compose with twelve-card pages and clamp the current page',()=>{
 const members=Array.from({length:29},(_,index)=>({id:'member-'+index,username:'user_'+String(index).padStart(2,'0'),name:'العضو '+index,online:index%2===0&&index%5!==0,muted:index%3===0,revoked:index%5===0,role:'viewer'})),f=memberFixture(members);
 f.client.renderMembers();assert.equal(f.element('members-list').children.length,12);assert.equal(f.element('members-prev').disabled,true);assert.equal(f.element('members-next').disabled,false);
 f.client.changeMemberPage(1);assert.equal(f.element('members-list').children.length,12);assert.equal(f.element('members-prev').disabled,false);
 f.client.changeMemberPage(1);assert.equal(f.element('members-list').children.length,5);assert.equal(f.element('members-next').disabled,true);
 f.client.changeMemberPage(1000);assert.equal(f.element('members-list').children.length,5);assert.equal(f.element('members-next').disabled,true);
 f.element('members-search').value='  USER_14  ';f.element('members-search').dispatchEvent({type:'input'});assert.equal(f.client.filteredMembers().length,1);assert.equal(f.element('members-list').children.length,1);assert(f.element('members-list').textContent.includes('العضو 14'));assert.equal(f.element('members-prev').disabled,true);assert.equal(f.element('members-next').disabled,true);
 f.element('members-search').value='';f.element('members-search').dispatchEvent({type:'input'});
 for(const filter of ['online','muted','blocked']){
  f.element('members-filter').value=filter;f.element('members-filter').dispatchEvent({type:'change'});
  const expected=members.filter(member=>filter==='blocked'?member.revoked:member[filter]);assert.deepEqual(plain(f.client.filteredMembers()).map(member=>member.id),expected.map(member=>member.id));assert(f.element('members-list').children.length<=12);
 }
 f.element('members-search').value='لا يوجد هذا العضو';f.element('members-search').dispatchEvent({type:'input'});assert.equal(f.client.filteredMembers().length,0);assert.equal(f.element('members-list').children.length,0);assert.equal(f.element('members-prev').disabled,true);assert.equal(f.element('members-next').disabled,true);
});

test('member polling keeps stable buttons, active search, and unsaved edit fields while old buttons read fresh member data',()=>{
 const original={id:'stable-member',username:'sara_old',name:'الاسم الأول',avatar:'purple',role:'viewer',info:{device:'جهاز قديم'}},f=memberFixture([original]);f.element('members-search').value='sara';f.client.renderMembers();
 const card=f.element('members-list').children[0],title=card.querySelector('.member-title'),edit=card.querySelectorAll('button').find(button=>button.textContent.includes('تعديل'));assert(edit,'member card exposes an edit action');
 f.client.openMemberEditor(original.id);f.element('member-edit-name').value='مسودة الاسم';f.element('member-edit-username').value='unsaved_username';f.element('member-edit-role').value='stream';f.element('member-edit-name').focus();f.element('member-edit-name').selectionStart=4;
 f.client.setState({...f.client.getState(),members:[{...original,name:'الاسم المحدّث',info:{device:'جهاز جديد'}}]});f.client.renderMembers();
 assert.equal(f.element('members-list').children[0],card);assert.equal(card.querySelector('.member-title'),title);assert.equal(card.querySelectorAll('button').find(button=>button.textContent.includes('تعديل')),edit);
 assert.equal(f.element('members-search').value,'sara');assert.equal(f.element('member-edit-dialog').open,true);assert.equal(f.element('member-edit-name').value,'مسودة الاسم');assert.equal(f.element('member-edit-username').value,'unsaved_username');assert.equal(f.element('member-edit-role').value,'stream');assert.equal(f.document.activeElement,f.element('member-edit-name'));assert.equal(f.element('member-edit-name').selectionStart,4);
 f.client.closeMemberEditor();f.client.setState({...f.client.getState(),members:[{...original,username:'sara_latest',name:'أحدث اسم',info:{device:'أحدث جهاز'}}]});
 title.click();assert.equal(f.element('viewer-details-title').textContent,'أحدث اسم');assert(f.element('viewer-details-body').textContent.includes('أحدث جهاز'));
 f.element('viewer-details-close').click();edit.click();assert.equal(f.element('member-edit-username').value,'sara_latest');assert.equal(f.element('member-edit-name').value,'أحدث اسم');
});

test('member details return focus to a stable opener or the members heading when that card is filtered out',()=>{
 const member={id:'focus-member',username:'sara',name:'سارة',role:'viewer'},f=memberFixture([member]);f.client.renderMembers();const title=f.element('members-list').children[0].querySelector('.member-title');
 title.focus();title.click();f.client.renderMembers();f.element('viewer-details-close').click();assert.equal(f.document.activeElement,title);assert.equal(f.element('viewer-details-dialog').open,false);
 title.focus();title.click();f.element('members-search').value='لا يطابق';f.element('members-search').dispatchEvent({type:'input'});assert.equal(title.isConnected,false);
 f.element('viewer-details-close').click();assert.equal(f.document.activeElement,f.element('members-heading'));assert.equal(f.element('viewer-details-dialog').open,false);
});
