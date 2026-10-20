import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {inspect} from 'node:util';

const [source,markup]=await Promise.all([
 readFile(new URL('./public/beta.js',import.meta.url),'utf8'),
 readFile(new URL('./public/index.html',import.meta.url),'utf8')
]);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const decode=value=>value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi,entity=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[entity.slice(1,-1)]??String.fromCodePoint(entity[2].toLowerCase()==='x'?parseInt(entity.slice(3,-1),16):Number(entity.slice(2,-1)))));
const dataName=key=>'data-'+key.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase());
function selectors(value,separator=','){
 const result=[];let part='',quote='',depth=0;
 for(const char of value){
  if(quote){part+=char;if(char===quote)quote='';continue;}
  if(char==='"'||char==="'"){quote=char;part+=char;continue;}
  if(char==='['||char==='(')depth++;if(char===']'||char===')')depth--;
  if(!depth&&char===separator){if(part.trim())result.push(part.trim());part='';}else part+=char;
 }
 if(part.trim())result.push(part.trim());return result;
}
function terms(value){
 const result=[];let part='',quote='',depth=0;
 for(const char of value){
  if(quote){part+=char;if(char===quote)quote='';continue;}
  if(char==='"'||char==="'"){quote=char;part+=char;continue;}
  if(char==='['||char==='(')depth++;if(char===']'||char===')')depth--;
  if(!depth&&(/\s/.test(char)||char==='>')){if(part){result.push(part);part='';}if(char==='>')result.push('>');}else part+=char;
 }
 if(part)result.push(part);return result;
}
function simpleMatch(node,selector){
 if(node.nodeType!==1)return false;
 let valid=true;
 selector=selector.replace(/:not\(([^)]+)\)/g,(_,inner)=>{if(node.matches(inner))valid=false;return '';});
 selector=selector.replace(/:(checked|disabled|enabled)/g,(_,kind)=>{if(kind==='checked'?!node.checked:kind==='disabled'?!node.disabled:node.disabled)valid=false;return '';});
 selector=selector.replace(/\[([\w:-]+)(?:\s*([~|^$*]?=)\s*("[^"]*"|'[^']*'|[^\]]*))?\]/g,(_,name,operator,raw)=>{
  const actual=node.getAttribute(name),expected=raw?.replace(/^(['"])(.*)\1$/,'$2');
  if(actual===null)valid=false;else if(operator&&!(operator==='='?actual===expected:operator==='^='?actual.startsWith(expected):operator==='$='?actual.endsWith(expected):operator==='*='?actual.includes(expected):operator==='~='?actual.split(/\s+/).includes(expected):false))valid=false;
  return '';
 });
 selector=selector.replace(/#([\w-]+)/g,(_,id)=>{if(node.id!==id)valid=false;return '';});
 selector=selector.replace(/\.([\w-]+)/g,(_,name)=>{if(!node.classList.contains(name))valid=false;return '';});
 return valid&&(!selector||selector==='*'||node.tagName===selector.toUpperCase());
}

class BrowserEvent{
 constructor(type,options={}){this.type=type;this.bubbles=!!options.bubbles;this.defaultPrevented=false;Object.assign(this,options);}
 preventDefault(){this.defaultPrevented=true;}
 stopPropagation(){this.stopped=true;}
}
class BrowserNode{
 constructor(tag='',document=null,text=''){
  this.nodeType=tag?1:3;this.tagName=tag.toUpperCase();this.ownerDocument=document;this.parentNode=null;this.childNodes=[];this.attributes=new Map();this.listeners=new Map();this._text=text;this.style={};this.scrollTop=0;this.scrollHeight=500;this.clientHeight=300;this.paused=true;this.currentTime=0;this.videoHeight=0;this.readyState=0;
  this.dataset=new Proxy({}, {get:(_,key)=>this.attributes.get(dataName(key)),set:(_,key,value)=>{this.attributes.set(dataName(key),String(value));return true;}});
  const change=(name,add)=>{const classes=new Set(this.className.split(/\s+/).filter(Boolean));add?classes.add(name):classes.delete(name);this.className=[...classes].join(' ');};
  this.classList={contains:name=>this.className.split(/\s+/).includes(name),add:(...names)=>names.forEach(name=>change(name,true)),remove:(...names)=>names.forEach(name=>change(name,false)),toggle:(name,force)=>{const add=force??!this.classList.contains(name);change(name,add);return add;}};
 }
 get children(){return this.childNodes.filter(node=>node.nodeType===1);}
 [inspect.custom](){return `<${this.tagName.toLowerCase()}${this.id?'#'+this.id:''}>`;}
 get firstChild(){return this.childNodes[0]||null;}
 get lastChild(){return this.childNodes.at(-1)||null;}
 get id(){return this.getAttribute('id')||'';}set id(value){this.setAttribute('id',value);}
 get className(){return this.getAttribute('class')||'';}set className(value){this.setAttribute('class',value);}
 get name(){return this.getAttribute('name')||'';}set name(value){this.setAttribute('name',value);}
 get href(){const value=this.getAttribute('href');return value===null?'':new URL(value,this.ownerDocument.location).href;}set href(value){this.setAttribute('href',value);}
 get hidden(){return this.hasAttribute('hidden');}set hidden(value){value?this.setAttribute('hidden',''):this.removeAttribute('hidden');}
 get disabled(){return this.hasAttribute('disabled');}set disabled(value){value?this.setAttribute('disabled',''):this.removeAttribute('disabled');}
 get open(){return this.hasAttribute('open');}set open(value){value?this.setAttribute('open',''):this.removeAttribute('open');}
 get checked(){return this.hasAttribute('checked');}set checked(value){value?this.setAttribute('checked',''):this.removeAttribute('checked');}
 get value(){return this._value??(this.tagName==='SELECT'?(this.options.find(option=>option.hasAttribute('selected'))||this.options[0])?.value||'':this.getAttribute('value')||'');}set value(value){this._value=String(value);}
 get options(){return this.querySelectorAll('option');}
 get tabIndex(){const value=this.getAttribute('tabindex');return value!==null?Number(value):/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(this.tagName)?0:-1;}set tabIndex(value){this.setAttribute('tabindex',value);}
 get textContent(){return this.nodeType===3?this._text:this.childNodes.map(node=>node.textContent).join('');}
 set textContent(value){if(this.nodeType===3)this._text=String(value);else{for(const child of this.childNodes)child.parentNode=null;this.childNodes=[];if(value!=='')this.append(String(value));}}
 get isConnected(){for(let node=this;node;node=node.parentNode)if(node===this.ownerDocument?.documentElement)return true;return false;}
 setAttribute(name,value){if(name==='id'){this.ownerDocument?.ids?.delete(this.id);this.ownerDocument?.ids?.set(String(value),this);}this.attributes.set(name,String(value));}getAttribute(name){return this.attributes.get(name)??null;}hasAttribute(name){return this.attributes.has(name);}removeAttribute(name){if(name==='id')this.ownerDocument?.ids?.delete(this.id);this.attributes.delete(name);}
 append(...nodes){for(const value of nodes){const node=typeof value==='string'?new BrowserNode('',this.ownerDocument,value):value;node.remove();node.parentNode=this;this.childNodes.push(node);}}
 prepend(...nodes){for(const node of [...nodes].reverse())this.insertBefore(typeof node==='string'?new BrowserNode('',this.ownerDocument,node):node,this.firstChild);}
 insertBefore(node,before){if(node===before)return;node.remove();const index=before?this.childNodes.indexOf(before):this.childNodes.length;assert(index>=0);node.parentNode=this;this.childNodes.splice(index,0,node);}
 replaceChildren(...nodes){this.textContent='';this.append(...nodes);}
 remove(){if(this.parentNode){this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this),1);this.parentNode=null;}}
 before(...nodes){if(this.parentNode)for(const node of nodes)this.parentNode.insertBefore(node,this);}
 after(node){if(this.parentNode){const siblings=this.parentNode.childNodes;this.parentNode.insertBefore(node,siblings[siblings.indexOf(this)+1]||null);}}
 contains(node){for(let current=node;current;current=current.parentNode)if(current===this)return true;return false;}
 matches(selector){return selectors(selector).some(value=>{const parts=terms(value);const match=(node,index)=>{if(!node||!simpleMatch(node,parts[index]))return false;if(index===0)return true;if(parts[index-1]==='>')return match(node.parentNode,index-2);for(let parent=node.parentNode;parent;parent=parent.parentNode)if(match(parent,index-1))return true;return false;};return match(this,parts.length-1);});}
 closest(selector){for(let node=this;node;node=node.parentNode)if(node.matches(selector))return node;return null;}
 querySelectorAll(selector){return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 addEventListener(name,listener){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(listener);}removeEventListener(name,listener){this.listeners.set(name,(this.listeners.get(name)||[]).filter(item=>item!==listener));}
 dispatchEvent(event){event.target??=this;event.currentTarget=this;this['on'+event.type]?.(event);for(const listener of this.listeners.get(event.type)||[])listener(event);if(event.bubbles&&!event.stopped)this.parentNode?.dispatchEvent(event);return !event.defaultPrevented;}
 click(){if(this.disabled)return;this.dispatchEvent(new BrowserEvent('click',{bubbles:true}));}
 focus(){if(this.getClientRects().length)this.ownerDocument.activeElement=this;}
 getClientRects(){for(let node=this;node;node=node.parentNode)if(node.hidden)return [];return this.isConnected?[this.getBoundingClientRect()]:[];}
 getBoundingClientRect(){return {left:0,top:0,right:200,bottom:100,width:200,height:100};}
 scrollIntoView(options){this.scrollOptions=options;this.ownerDocument.lastScroll=this;}
 scrollTo(options){this.scrollTop=options.top||0;}
 showModal(){this.open=true;}
 close(){if(!this.open)return;this.open=false;this.dispatchEvent(new BrowserEvent('close'));}
 pause(){this.paused=true;}play(){this.paused=false;return Promise.resolve();}load(){}
}
function parseDocument(html,location){
 const document={location,hidden:false,visibilityState:'visible',activeElement:null,listeners:new Map(),ids:new Map(),createElement:tag=>new BrowserNode(tag,document),createElementNS:(namespace,tag)=>{const node=new BrowserNode(tag,document);node.namespaceURI=namespace;return node;},createTextNode:text=>new BrowserNode('',document,text),getElementById:id=>{const node=document.ids.get(id);return node?.isConnected?node:null;},querySelectorAll:selector=>document.documentElement?[...(document.documentElement.matches(selector)?[document.documentElement]:[]),...document.documentElement.querySelectorAll(selector)]:[],querySelector:selector=>document.querySelectorAll(selector)[0]||null,addEventListener:BrowserNode.prototype.addEventListener,removeEventListener:BrowserNode.prototype.removeEventListener,dispatchEvent:BrowserNode.prototype.dispatchEvent};
 const stack=[],voidTags=new Set(['AREA','BASE','BR','COL','EMBED','HR','IMG','INPUT','LINK','META','PARAM','SOURCE','TRACK','WBR']);
 for(const token of html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>|[^<]+/g)||[]){
  if(token.startsWith('<!'))continue;
  if(token.startsWith('</')){const tag=/^<\/([\w:-]+)/.exec(token)[1].toUpperCase();while(stack.length){if(stack.pop().tagName===tag)break;}continue;}
  if(token.startsWith('<')){
   const match=/^<([\w:-]+)/.exec(token),node=document.createElement(match[1]);
   for(const attribute of token.slice(match[0].length,-1).matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))node.setAttribute(attribute[1],decode(attribute[2]??attribute[3]??attribute[4]??''));
   if(stack.length)stack.at(-1).append(node);else if(node.tagName==='HTML')document.documentElement=node;
   if(node.tagName==='BODY')document.body=node;if(!voidTags.has(node.tagName)&&!token.endsWith('/>'))stack.push(node);
  }else if(stack.length)stack.at(-1).append(decode(token));
 }
 assert(document.body,'HTML fixture needs a body');document.activeElement=document.body;return document;
}

function fixture({owner=false,hash='',storage={},reducedMotion=false,saveData=false,state={}}={}){
 const location=new URL('https://room.example/'+hash),document=parseDocument(markup,location),stored=new Map(Object.entries(storage)),timers=new Map(),notices=[],historyCalls=[],networkEvents=[];let timerID=0;
 const listeners=new Map(),window={document,location,listeners,addEventListener:BrowserNode.prototype.addEventListener,removeEventListener:BrowserNode.prototype.removeEventListener,dispatchEvent:BrowserNode.prototype.dispatchEvent};
 const context={document,window,location,HTMLElement:BrowserNode,Event:BrowserEvent,URL,URLSearchParams,Intl,Date,console,navigator:{onLine:true,connection:{saveData,addEventListener(){}}},
  state:{authorized:true,authenticated:true,canControl:owner,ready:false,registrationRequired:false,...state},room:{settings:{name:'لمّة الاختبار'},online:3},running:false,
  history:{replaceState:(state,title,url)=>{historyCalls.push({kind:'replace',url});if(url!==undefined)location.href=new URL(url,location).href;},pushState:(state,title,url)=>{historyCalls.push({kind:'push',url});if(url!==undefined)location.href=new URL(url,location).href;}},
  localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,String(value)),removeItem:key=>stored.delete(key)},
  matchMedia:()=>({matches:reducedMotion,addEventListener(){},removeEventListener(){}}),MutationObserver:class{observe(){}disconnect(){}},
  setTimeout:(fn,ms)=>{const id=++timerID;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),requestAnimationFrame:fn=>{fn();return 1;},cancelAnimationFrame(){},
  buffer:()=>6,rate:value=>String(value),notice:value=>notices.push(value),fetch:()=>assert.fail('navigation must not fetch media or API data'),api:()=>assert.fail('navigation must not send API requests'),watch:()=>assert.fail('navigation must not restart playback')};
 context.$=id=>document.getElementById(id);context.button=(value,handler,cls)=>{const node=document.createElement('button');node.textContent=value;node.onclick=handler;node.className=cls||'';return node;};
 // app.js owns this inner panel's permission state before beta.js routes its parent.
 if(document.getElementById('owner-chat-controls'))document.getElementById('owner-chat-controls').hidden=!owner;
 document.getElementById('network-mode')?.addEventListener('change',event=>networkEvents.push({value:event.currentTarget.value,bubbles:event.bubbles}));
 Object.assign(window,{HTMLElement:BrowserNode,Event:BrowserEvent,matchMedia:context.matchMedia,requestAnimationFrame:context.requestAnimationFrame,history:context.history});
 vm.createContext(context);vm.runInContext(source,context,{filename:'public/beta.js'});
 return {context,window,document,stored,timers,notices,historyCalls,networkEvents,element:id=>document.getElementById(id),query:selector=>document.querySelector(selector),all:selector=>document.querySelectorAll(selector),render:()=>window.dshoofStudio.render(),setOwner:value=>{context.state={...context.state,canControl:value};},hash:value=>{location.hash=value;window.dispatchEvent(new BrowserEvent('hashchange'));}};
}

const pagePanels=f=>f.all('[data-page-panel],[data-page-view]');
const panelPage=panel=>panel.dataset.pagePanel||panel.dataset.pageView;
function assertPage(f,page){
 assert.equal(f.document.body.dataset.page,page);
 assert.equal(f.document.body.hidden,false,'route state must never hide the entire document');
 for(const panel of pagePanels(f))assert.equal(panel.hidden,panelPage(panel)!==page,`page visibility: ${panelPage(panel)}`);
 for(const control of f.all('[data-page-target]')){
  const active=control.dataset.pageTarget===page;
  assert.equal(control.getAttribute('aria-current'),active?'page':null,`page selection: ${control.dataset.pageTarget}`);
 }
}

test('the real page starts on watch and routes viewer controls between watch, chat, and tools without media requests',()=>{
 const f=fixture();assert.deepEqual(pagePanels(f).map(panelPage),['watch','tools','admin']);assertPage(f,'watch');
 f.query('[data-page-target="tools"]').click();assertPage(f,'tools');assert.equal(f.context.location.hash,'#tools');
 assert(f.element('tools-view').contains(f.document.activeElement),'navigation focuses the selected view heading');
 f.query('[data-page-target="watch"]').click();assertPage(f,'watch');assert.equal(f.context.location.hash,'#watch');
 f.query('[data-page-target="chat"]').click();assertPage(f,'watch');assert(f.document.activeElement===f.element('chat-text'),'chat navigation focuses the draft');assert.equal(f.context.running,false);assert.equal(f.networkEvents.length,0);
 assert.equal(f.window.dshoofStudio.navigate('unknown'),false);assertPage(f,'watch');
});

test('viewers and delegated roles cannot expose owner navigation through buttons or exported handlers',()=>{
 for(const role of ['viewer','stream','moderator']){
  const f=fixture({state:{role}});assertPage(f,'watch');
  for(const control of f.all('[data-page-target="admin"]'))assert.equal(control.hidden,true);
  assert.equal(f.window.dshoofStudio.navigate('admin'),false);assert.equal(f.window.dshoofStudio.openAdmin('members'),false);
  f.query('[data-page-target="admin"]').click();assertPage(f,'watch');
  for(const panel of f.all('[data-admin-panel]'))assert.equal(panel.hidden,true);
  for(const control of f.all('[data-admin-target],button[data-admin-tab]')){assert.equal(control.hidden,true);assert.equal(control.tabIndex,-1);assert.equal(control.getAttribute('aria-selected'),'false');}
  assert(f.notices.every(message=>message.includes('للمالك')));assert(f.notices.length>=2);
 }
});

test('owner tabs select only the matching management panel and publish canonical deep links',()=>{
 const f=fixture({owner:true}),hashes={broadcast:'#admin-broadcast',members:'#admin-members',chat:'#owner-chat-controls',analytics:'#owner-analytics',settings:'#admin-settings'};
 assert.deepEqual(f.all('[data-admin-panel]').map(panel=>panel.dataset.adminPanel),Object.keys(hashes));
 for(const [tab,hash]of Object.entries(hashes)){
  f.query(`[data-admin-target="${tab}"]`).click();assertPage(f,'admin');assert.equal(f.document.body.dataset.adminTab,tab);assert.equal(f.context.location.hash,hash);
  for(const panel of f.all('[data-admin-panel]'))assert.equal(panel.hidden,panel.dataset.adminPanel!==tab,tab);
  for(const control of f.all('[data-admin-target],button[data-admin-tab]')){const selected=(control.dataset.adminTarget||control.dataset.adminTab)===tab;assert.equal(control.getAttribute('aria-selected'),String(selected));assert.equal(control.tabIndex,selected?0:-1);}
  if(tab==='chat')assert(f.document.activeElement===f.element('chat-toggle'),'owner chat navigation focuses its toggle');
 }
 f.query('[data-page-target="tools"]').click();assertPage(f,'tools');assert.equal(f.context.location.hash,'#tools');
});

test('known deep links and hash changes reach the correct view while unauthorized and unknown links stay private',()=>{
 for(const [hash,page,tab]of [['#pro-center','tools'],['#tools','tools'],['#admin-members','admin','members'],['#owner-chat-controls','admin','chat'],['#owner-analytics','admin','analytics'],['#admin-settings','admin','settings']]){
  const f=fixture({owner:true,hash});assertPage(f,page);if(tab)assert.equal(f.document.body.dataset.adminTab,tab);
 }
 const f=fixture({owner:true});f.hash('#admin-members');assertPage(f,'admin');assert.equal(f.document.body.dataset.adminTab,'members');f.hash('#pro-center');assertPage(f,'tools');f.hash('#chat-panel');assertPage(f,'watch');assert(f.document.activeElement===f.element('chat-text'),'chat hash focuses the draft');
 const denied=fixture({hash:'#admin-members'});assertPage(denied,'watch');assert.equal(denied.context.location.hash,'#watch');
 for(const hash of ['#admin=private-key','#unknown','#../admin-members']){const unknown=fixture({hash});assertPage(unknown,'watch');assert.equal(unknown.element('admin').hidden,true);}
});

test('an initial owner deep link waits for authentication and resolves once the first status establishes ownership',()=>{
 const pending=fixture({hash:'#admin-members',state:{authenticated:undefined,authorized:false}});assertPage(pending,'watch');assert.equal(pending.context.location.hash,'#admin-members');assert.equal(pending.notices.length,0);
 pending.context.state={...pending.context.state,authorized:true,authenticated:true,canControl:true};pending.render();assertPage(pending,'admin');assert.equal(pending.document.body.dataset.adminTab,'members');
 const denied=fixture({hash:'#admin-settings',state:{authenticated:undefined,authorized:false}});denied.context.state={...denied.context.state,authorized:true,authenticated:true,canControl:false};denied.render();assertPage(denied,'watch');assert.equal(denied.context.location.hash,'#watch');
});

test('loss of owner access closes private dialogs and returns visible focus to watch without restoring an old admin tab',()=>{
 const f=fixture({owner:true});f.window.dshoofStudio.openAdmin('members');const input=f.element('member-edit-name');
 f.element('member-edit-dialog').showModal();input.focus();f.element('viewer-details-dialog').showModal();f.element('viewer-details-close').focus();
 f.setOwner(false);f.render();assertPage(f,'watch');assert.equal(f.document.body.dataset.adminTab,'broadcast');assert.equal(f.context.location.hash,'#watch');
 assert.equal(f.element('member-edit-dialog').open,false);assert.equal(f.element('viewer-details-dialog').open,false);
 const heading=f.element('watch-view').querySelector('[data-view-heading],h1,h2,h3');assert(f.document.activeElement===heading,'owner loss focuses the watch heading');assert(heading.getClientRects().length>0,'focus must land on a visible public heading');
 f.setOwner(true);f.render();assertPage(f,'watch');assert.equal(f.document.body.dataset.adminTab,'broadcast');
});

test('one network preset group delegates once to the canonical hidden select and respects disabled or repeated choices',()=>{
 const f=fixture(),select=f.element('network-mode');assert(select);assert.equal(select.hidden,true);assert.equal(select.tabIndex,-1);assert.equal(f.all('#network-mode').length,1);
 assert.deepEqual(f.all('[data-network-preset]').map(control=>control.dataset.networkPreset),['fast','weak','emergency']);
 const originalSelect=select,weak=f.query('[data-network-preset="weak"]'),emergency=f.query('[data-network-preset="emergency"]');
 weak.click();assert.equal(select.value,'weak');assert.deepEqual(f.networkEvents,[{value:'weak',bubbles:true}]);f.render();assert.equal(weak.getAttribute('aria-pressed'),'true');assert(f.document.body.classList.contains('data-saver'));
 weak.click();assert.equal(f.networkEvents.length,1);emergency.click();f.render();assert.equal(f.networkEvents.length,2);assert.equal(select.value,'emergency');
 for(let count=0;count<4;count++){f.window.dshoofStudio.navigate(count%2?'tools':'watch');f.render();}
 assert(f.element('network-mode')===originalSelect,'navigation keeps the canonical select instance');assert.equal(f.all('#network-mode').length,1);assert.equal(f.all('[data-network-preset]').length,3);
 weak.dataset.networkPreset='unsupported';weak.click();assert.equal(select.value,'emergency');assert.equal(f.networkEvents.length,2);weak.dataset.networkPreset='weak';
 select.disabled=true;f.render();assert(f.all('[data-network-preset]').every(control=>control.disabled));weak.click();assert.equal(select.value,'emergency');assert.equal(f.networkEvents.length,2);
});

test('legacy appearance migrates the old default colors while preserving font, compactness, chat, and motion choices',()=>{
 const saved={theme:'midnight',accent:'mint',font:'xlarge',compact:true,chat:false},f=fixture({storage:{'dshoof-appearance':JSON.stringify(saved),'dshoof-motion':'off'}});
 assert.equal(f.document.body.dataset.theme,'ivory');assert.equal(f.document.body.dataset.accent,'coral');assert.equal(f.document.body.dataset.fontScale,'xlarge');assert(f.document.body.classList.contains('layout-compact'));assert(f.document.body.classList.contains('custom-chat-hidden'));assert(f.document.body.classList.contains('motion-off'));
 assert.deepEqual(JSON.parse(f.stored.get('dshoof-appearance')),{...saved,theme:'ivory',accent:'coral'});assert.equal(f.stored.get('dshoof-appearance-version'),'club-1');assert.equal(f.stored.get('dshoof-motion'),'off');
 const oldLight=fixture({storage:{'dshoof-appearance':JSON.stringify({theme:'light',accent:'purple',font:'large'})}});assert.equal(oldLight.document.body.dataset.theme,'ivory');assert.equal(oldLight.document.body.dataset.accent,'purple');assert.equal(oldLight.document.body.dataset.fontScale,'large');
 const chosen=fixture({storage:{'dshoof-appearance':JSON.stringify({theme:'midnight',accent:'gold',chat:false}),'dshoof-appearance-version':'club-1'}});assert.equal(chosen.document.body.dataset.theme,'midnight');assert.equal(chosen.document.body.dataset.accent,'gold');assert(chosen.document.body.classList.contains('custom-chat-hidden'));
});

test('appearance controls save valid choices, reject unknown values, and reset the current design defaults',()=>{
 const f=fixture(),theme=f.query('[name="custom-theme"][value="stadium"]'),accent=f.query('[name="custom-accent"][value="gold"]');assert(theme);assert(accent);
 theme.checked=true;theme.dispatchEvent(new BrowserEvent('change',{bubbles:true}));accent.checked=true;accent.dispatchEvent(new BrowserEvent('change',{bubbles:true}));
 f.element('custom-font').value='large';f.element('custom-font').dispatchEvent(new BrowserEvent('change',{bubbles:true}));f.element('custom-compact').checked=true;f.element('custom-compact').dispatchEvent(new BrowserEvent('change',{bubbles:true}));
 assert.equal(f.document.body.dataset.theme,'stadium');assert.equal(f.document.body.dataset.accent,'gold');assert.equal(f.document.body.dataset.fontScale,'large');assert(f.document.body.classList.contains('layout-compact'));
 f.element('custom-font').value='invalid';f.element('custom-font').dispatchEvent(new BrowserEvent('change',{bubbles:true}));assert.equal(f.document.body.dataset.fontScale,'large');
 f.element('studio-motion').click();assert.equal(f.stored.get('dshoof-motion'),'off');assert(f.document.body.classList.contains('motion-off'));
 f.element('custom-reset').click();assert.deepEqual(JSON.parse(f.stored.get('dshoof-appearance')),{theme:'ivory',accent:'coral',font:'normal',compact:false,chat:true});assert.equal(f.stored.get('dshoof-motion'),'on');assert.equal(f.document.body.dataset.theme,'ivory');assert.equal(f.document.body.dataset.accent,'coral');
 const reduced=fixture({reducedMotion:true});assert(reduced.document.body.classList.contains('motion-off'));assert.equal(reduced.stored.get('dshoof-motion'),'on','device motion preference does not overwrite the saved user setting');
});
