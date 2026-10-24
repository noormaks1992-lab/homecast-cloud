import {test} from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('./public/app.js',import.meta.url),'utf8');
function fixture({quality="auto",relayReady=false}={}){
 let ahead=0,plays=0;const timers=[],nodes=new Map();
 const video={playbackRate:1,play:async()=>{plays++;},seekable:{length:0},readyState:0};nodes.set('video',video);nodes.set('playback-mode',{value:'close'});
 class Hls{static isSupported(){return true;}static Events={MANIFEST_PARSED:'manifest',FRAG_BUFFERED:'fragment',LEVEL_LOADED:'level',ERROR:'error'};static ErrorTypes={NETWORK_ERROR:'network',MEDIA_ERROR:'media'};constructor(config){this.config=config;this.events={};}on(n,f){this.events[n]=f;}attachMedia(){}loadSource(u){this.source=u;}}
 const c={state:{authorized:true,authenticated:true,ready:true,selection:{kind:'url'},relayReady},recoveryTimer:null,generation:1,channelChosen:false,paused:false,running:false,window:{Hls},Hls,playbackURL:()=>'/quality/'+quality+'.m3u8',channelPath:()=>'',stopLocal(){},notice(){},buffer:()=>ahead,clearTimeout(){},setTimeout(fn,ms){timers.push({fn,ms});},setInterval(){},Date,$:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);}};
 vm.createContext(c);vm.runInContext(code.slice(code.indexOf('function watch(){'),code.indexOf('function buffer(){')),c);c.watch();return {c,timers,video,setBuffer:n=>ahead=n,plays:()=>plays};
}
test('direct HLS uses measured retry settings and native HLS buffer/ABR defaults',()=>{const f=fixture(),c=f.c.hls.config;assert.equal(c.fragLoadingRetryDelay,750);assert.equal(c.fragLoadingMaxRetry,6);assert.equal(c.backBufferLength,30);assert.equal(c.fragLoadingTimeOut,20000);for(const k of ['maxBufferLength','maxBufferSize','liveMaxLatencyDurationCount','maxLiveSyncPlaybackRate'])assert.equal(c[k],undefined);});
test('startup requests playback immediately without a fixed waiting timer or forced seek',()=>{const f=fixture();f.c.hls.events.manifest();assert.equal(f.plays(),1);f.setBuffer(1.5);f.c.hls.events.fragment();assert.equal(f.plays(),1);assert.equal(f.video.currentTime,undefined);});
test('fatal direct recovery starts immediately and a stale channel error is ignored',()=>{const f=fixture();f.c.hls.events.error(null,{fatal:true,type:'network'});assert.equal(f.timers[0].ms,0);f.c.generation++;f.c.hls.events.error(null,{fatal:true,type:'network'});assert.equal(f.timers.length,1);});


test('automatic route uses healthy relay without exposing a manual server selector',()=>{
 const f=fixture({relayReady:true});f.c.hls.events.error(null,{fatal:true,type:'network'});f.c.hls.events.error(null,{fatal:true,type:'network'});
 assert.equal(f.c.hls.source,'/live/dshoof.m3u8');assert.equal(f.c.hls.dshoofSourceParity,false);
 assert.doesNotMatch(code,/stream-route/);
});
test('unhealthy relay and fixed resolution cannot trigger silent route or quality replacement',()=>{
 for(const options of [{relayReady:false},{quality:'720p',relayReady:true}]){const f=fixture(options);for(let i=0;i<4;i++)f.c.hls.events.error(null,{fatal:true,type:'network'});assert.equal(f.c.hls.source,'/quality/'+(options.quality||'auto')+'.m3u8');}
});
