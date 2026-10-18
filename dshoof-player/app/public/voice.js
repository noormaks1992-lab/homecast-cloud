(()=>{const section=document.createElement('details');section.innerHTML='<summary>غرفة الصوت · حتى أربعة أجهزة</summary><p>الاتصال صوتي مباشر بين الأجهزة، وقد لا يعمل خلف بعض الشبكات دون خادم TURN. قد يكشف عنوان الشبكة للمشاركين. الميكروفون مغلق بعد الدخول حتى تفعّله. المكالمة تستهلك بيانات إضافية؛ اتركها مغلقة إذا كان اتصالك محدودًا.</p><div class="pro-controls"><button id="voice-join">دخول غرفة الصوت</button><button id="voice-mic" disabled>فتح الميكروفون</button><button id="voice-leave" disabled>مغادرة</button><label>صوت الأصدقاء<input id="voice-volume" type="range" min="0" max="1" step="0.1" value="1"></label><button id="voice-commentary">المعلق الأصلي / صوت الأصدقاء</button></div><p id="voice-state" role="status" aria-live="polite"></p><div id="voice-peers"></div>';$('pro-tab-social').append(section);let stream=null,own='',since=0,active=false,pollingVersion=null,forcedMute=false,joining=false,joinVersion=0;const peers=new Map();
const current=version=>version===joinVersion&&active&&!!stream&&state.authorized;
const connected=(version,id,p)=>current(version)&&peers.get(id)===p;
async function send(type,to,data,version){if(!current(version))return;await api('/api/pro/voice-signal',{type,to,data});}
function drop(id){const p=peers.get(id);if(p){peers.delete(id);p.pc.close();p.audio.pause();p.audio.srcObject=null;p.wrapper.remove();}}
function updatePeer(p,peer){p.muted=!!peer.muted;p.label.textContent=peer.name;p.audio.muted=p.muted;p.audio.setAttribute('aria-label','صوت '+peer.name);if(p.mute){p.mute.textContent=p.muted?'السماح بالميكروفون':'كتم الصديق';p.mute.setAttribute('aria-pressed',String(p.muted));}}
function connection(peer,version){
 if(!current(version))return null;if(peers.has(peer.id)){const p=peers.get(peer.id);updatePeer(p,peer);return p;}
 const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]}),audio=document.createElement('audio');audio.autoplay=true;audio.controls=true;audio.volume=Number($('voice-volume').value);
 const wrapper=document.createElement('div');wrapper.className='voice-person';const label=document.createElement('strong');wrapper.append(label,audio);
 const p={pc,audio,wrapper,label,muted:false,candidates:[],mute:null};peers.set(peer.id,p);
 if(state.canControl){p.mute=button('كتم الصديق',async()=>{if(!connected(version,peer.id,p))return;const next=!p.muted;try{await api('/api/pro/voice-mute',{id:peer.id,muted:next});if(connected(version,peer.id,p))updatePeer(p,{name:p.label.textContent,muted:next});}catch(e){if(current(version))notice(e.message);}});wrapper.append(p.mute);}
 updatePeer(p,peer);$('voice-peers').append(wrapper);for(const track of stream.getTracks())pc.addTrack(track,stream);
 pc.onicecandidate=e=>{if(e.candidate&&connected(version,peer.id,p))send('candidate',peer.id,e.candidate.toJSON(),version).catch(()=>{});};
 pc.ontrack=e=>{if(!connected(version,peer.id,p))return;audio.srcObject=e.streams[0];audio.muted=p.muted;audio.play().catch(()=>{if(connected(version,peer.id,p))$('voice-state').textContent='اضغط تشغيل في أداة الصوت للسماح بسماع الأصدقاء';});};
 pc.onconnectionstatechange=()=>{if(connected(version,peer.id,p)&&pc.connectionState==='failed')$('voice-state').textContent='تعذر الاتصال بمشارك؛ هذه الشبكة قد تحتاج خادم TURN';};return p;
}
async function flushCandidates(p,version,id){const candidates=p.candidates;p.candidates=[];for(const candidate of candidates){await p.pc.addIceCandidate(candidate);if(!connected(version,id,p))return false;}return connected(version,id,p);}
async function tick(){
 if(active&&!state.authorized){leave();return;}if(!active||pollingVersion===joinVersion)return;const version=joinVersion;pollingVersion=version;
 try{
  const r=await api('/api/pro/voice-poll',{since});if(!current(version))return;
  forcedMute=!!r.muted;if(forcedMute)stream.getAudioTracks().forEach(track=>track.enabled=false);
  $('voice-mic').disabled=forcedMute;const enabled=!!stream.getAudioTracks()[0]?.enabled;$('voice-mic').textContent=forcedMute?'المضيف كتم ميكروفونك':enabled?'كتم الميكروفون':'فتح الميكروفون';$('voice-mic').setAttribute('aria-pressed',String(enabled));
  const ids=r.peers.map(peer=>peer.id);for(const id of peers.keys())if(!ids.includes(id))drop(id);
  for(const peer of r.peers){
   if(!current(version))return;if(peer.id===own)continue;const existing=peers.has(peer.id),p=connection(peer,version);if(!p)return;
   if(!existing&&own<peer.id){const offer=await p.pc.createOffer();if(!connected(version,peer.id,p))return;await p.pc.setLocalDescription(offer);if(!connected(version,peer.id,p))return;await send('offer',peer.id,p.pc.localDescription.toJSON(),version);if(!connected(version,peer.id,p))return;}
  }
  for(const signal of r.signals){
   if(!current(version))return;const peer=r.peers.find(item=>item.id===signal.from);if(!peer)continue;const p=connection(peer,version);if(!p)return;
   if(signal.type==='offer'){
    await p.pc.setRemoteDescription(signal.data);if(!connected(version,peer.id,p))return;if(!await flushCandidates(p,version,peer.id))return;
    const answer=await p.pc.createAnswer();if(!connected(version,peer.id,p))return;await p.pc.setLocalDescription(answer);if(!connected(version,peer.id,p))return;
    await send('answer',signal.from,p.pc.localDescription.toJSON(),version);if(!connected(version,peer.id,p))return;
   }else if(signal.type==='answer'){await p.pc.setRemoteDescription(signal.data);if(!connected(version,peer.id,p))return;if(!await flushCandidates(p,version,peer.id))return;}
   else if(signal.type==='candidate'){if(p.pc.remoteDescription){await p.pc.addIceCandidate(signal.data);if(!connected(version,peer.id,p))return;}else if(p.candidates.length<100)p.candidates.push(signal.data);}
  }
  if(!current(version))return;since=r.sequence;$('voice-state').textContent=r.peers.length+' أجهزة في الغرفة'+(forcedMute?' · الميكروفون مكتوم من المضيف':'');
 }catch(e){if(version===joinVersion&&active){$('voice-state').textContent=e.message;if(!state.authorized)leave();}}finally{if(pollingVersion===version)pollingVersion=null;}
}
function stopLocal(){joinVersion++;joining=false;active=false;pollingVersion=null;stream?.getTracks().forEach(track=>track.stop());stream=null;for(const id of peers.keys())drop(id);}
async function leave(){stopLocal();$('voice-join').disabled=!state.authorized;$('voice-mic').disabled=$('voice-leave').disabled=true;$('voice-mic').textContent='فتح الميكروفون';$('voice-mic').setAttribute('aria-pressed','false');$('voice-state').textContent='غادرت غرفة الصوت';try{await api('/api/pro/voice-leave',{});}catch{}}
$('voice-join').onclick=async()=>{
 if(joining||active||!state.authorized)return;joining=true;const version=++joinVersion;let captured=null;$('voice-join').disabled=true;
 try{
  if(!navigator.mediaDevices?.getUserMedia||!window.RTCPeerConnection)throw Error('متصفحك لا يدعم الغرفة الصوتية');
  captured=await navigator.mediaDevices.getUserMedia({video:false,audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  if(version!==joinVersion||!state.authorized){captured.getTracks().forEach(track=>track.stop());return;}
  stream=captured;stream.getAudioTracks().forEach(track=>track.enabled=false);const r=await api('/api/pro/voice-join',{});
  if(version!==joinVersion||!state.authorized){captured.getTracks().forEach(track=>track.stop());if(stream===captured)stream=null;return;}
  own=r.id;since=0;active=true;forcedMute=false;$('voice-join').disabled=true;$('voice-mic').disabled=$('voice-leave').disabled=false;await tick();
 }catch(e){captured?.getTracks().forEach(track=>track.stop());if(stream===captured)stream=null;if(version===joinVersion){active=false;for(const id of peers.keys())drop(id);$('voice-state').textContent=e.message;}}
 finally{if(version===joinVersion){joining=false;$('voice-join').disabled=active||!state.authorized;}}
};
$('voice-mic').onclick=()=>{if(forcedMute)return;for(const track of stream?.getAudioTracks()||[])track.enabled=!track.enabled;const enabled=!!stream?.getAudioTracks()[0]?.enabled;$('voice-mic').textContent=enabled?'كتم الميكروفون':'فتح الميكروفون';$('voice-mic').setAttribute('aria-pressed',String(enabled));};
$('voice-leave').onclick=leave;$('voice-volume').oninput=()=>{for(const p of peers.values())p.audio.volume=Number($('voice-volume').value);};$('voice-commentary').onclick=()=>{$('video').muted=!$('video').muted;};setInterval(tick,2000);
window.addEventListener('pagehide',()=>{const wasActive=active||joining;stopLocal();$('voice-join').disabled=!state.authorized;$('voice-mic').disabled=$('voice-leave').disabled=true;$('voice-mic').textContent='فتح الميكروفون';$('voice-mic').setAttribute('aria-pressed','false');if(wasActive)fetch('/api/pro/voice-leave',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',keepalive:true}).catch(()=>{});});})();
