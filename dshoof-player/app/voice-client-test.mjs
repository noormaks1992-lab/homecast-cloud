import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('./public/voice.js',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function client({poll,media,offer,own='z'}={}){
 const elements=new Map(),created=[],pcs=[],events=new Map(),calls=[];let interval;
 class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.attributes={};this.value=tag==='input'?'1':'';this.muted=false;created.push(this);}
  append(...nodes){for(const node of nodes){this.children.push(node);node.parent=this;}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
  setAttribute(key,value){this.attributes[key]=value;}
  pause(){this.paused=true;}
  play(){return Promise.resolve();}
 }
 const $=id=>{if(!elements.has(id)){const node=new Element(id==='voice-volume'?'input':'div');elements.set(id,node);}return elements.get(id);};
 class Peer{
  constructor(){this.connectionState='new';this.closed=false;pcs.push(this);}
  addTrack(){}
  close(){this.closed=true;}
  async createOffer(){return offer?offer():{type:'offer',sdp:'test'};}
  async createAnswer(){return {type:'answer',sdp:'test'};}
  async setLocalDescription(value){this.localDescription={...value,toJSON:()=>value};}
  async setRemoteDescription(value){this.remoteDescription=value;}
  async addIceCandidate(){}
 }
 const track={enabled:true,stopped:0,stop(){this.stopped++;}},captured={getTracks:()=>[track],getAudioTracks:()=>[track]};
 const context={document:{createElement:tag=>new Element(tag)},$,state:{authorized:true,canControl:true},navigator:{mediaDevices:{getUserMedia:media||(()=>Promise.resolve(captured))}},RTCPeerConnection:Peer,button:(label,handler)=>{const b=new Element('button');b.textContent=label;b.onclick=handler;return b;},notice:()=>{},setInterval:handler=>{interval=handler;},fetch:()=>Promise.resolve({ok:true}),api:async(route,data)=>{calls.push({route,data});if(route.endsWith('voice-join'))return {id:own};if(route.endsWith('voice-poll'))return poll();return {ok:true};}};
 context.window={RTCPeerConnection:Peer,addEventListener:(event,handler)=>events.set(event,handler)};vm.runInNewContext(source,context,{filename:'public/voice.js'});
 return {$,pcs,created,track,captured,calls,events,tick:()=>interval(),join:()=>$('voice-join').onclick(),leave:()=>$('voice-leave').onclick()};
}
const reply=(muted=false,name='صديق')=>({muted:false,peers:[{id:'z',name:'أنا',muted:false},{id:'a',name,muted}],signals:[],sequence:1});
test('a late voice poll after leaving cannot create peer connections or audio elements',async()=>{
 const pending=deferred(),app=client({poll:()=>pending.promise}),joined=app.join();await flush();assert.equal(app.calls.filter(call=>call.route.endsWith('voice-poll')).length,1);
 await app.leave();pending.resolve(reply());await joined;
 assert.equal(app.pcs.length,0);assert.equal(app.created.filter(node=>node.tag==='audio').length,0);assert.equal(app.$('voice-peers').children.length,0);assert.ok(app.track.stopped>=1);assert.equal(app.$('voice-state').textContent,'غادرت غرفة الصوت');
});
test('receiver audio, participant name and owner mute button follow updated peer moderation',async()=>{
 let latest=reply();const app=client({poll:()=>Promise.resolve(latest)});await app.join();assert.equal(app.pcs.length,1);
 const wrapper=app.$('voice-peers').children[0],audio=wrapper.children.find(node=>node.tag==='audio'),label=wrapper.children.find(node=>node.tag==='strong'),mute=wrapper.children.find(node=>node.tag==='button');assert.equal(audio.muted,false);
 latest=reply(true,'الاسم الجديد');await app.tick();assert.equal(audio.muted,true);assert.equal(label.textContent,'الاسم الجديد');assert.equal(mute.textContent,'السماح بالميكروفون');assert.equal(mute.attributes['aria-pressed'],'true');
 app.pcs[0].ontrack({streams:[{}]});assert.equal(audio.muted,true);
 latest=reply(false);await app.tick();assert.equal(audio.muted,false);assert.equal(mute.textContent,'كتم الصديق');await app.leave();assert.equal(app.pcs[0].closed,true);
});
test('leaving while an offer is pending prevents stale descriptions and signaling',async()=>{
 const pending=deferred(),app=client({own:'a',offer:()=>pending.promise,poll:()=>Promise.resolve({muted:false,peers:[{id:'a',name:'أنا'},{id:'z',name:'صديق'}],signals:[],sequence:1})}),joined=app.join();await flush();assert.equal(app.pcs.length,1);
 await app.leave();pending.resolve({type:'offer',sdp:'late'});await joined;assert.equal(app.pcs[0].closed,true);assert.equal(app.pcs[0].localDescription,undefined);assert.equal(app.calls.filter(call=>call.route.endsWith('voice-signal')).length,0);assert.equal(app.$('voice-peers').children.length,0);
});
test('pagehide during microphone acquisition stops the late stream and never joins signaling',async()=>{
 const pending=deferred(),app=client({media:()=>pending.promise,poll:()=>Promise.resolve(reply())}),joined=app.join();app.events.get('pagehide')();pending.resolve(app.captured);await joined;
 assert.equal(app.track.stopped,1);assert.equal(app.pcs.length,0);assert.equal(app.calls.filter(call=>call.route.endsWith('voice-join')).length,0);
});
