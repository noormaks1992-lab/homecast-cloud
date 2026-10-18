// One shared encoder per broadcast; the original path always copies its source.
const profile=(value)=>Object.freeze({...value,requiredKbps:Math.ceil((value.maxKbps+value.audioKbps)*1.15+(value.transportOverheadKbps||24))});
export const streamProfiles=Object.freeze({
 emergency144:profile({id:'emergency144',label:'الطوارئ · 144p',height:144,width:256,videoKbps:40,maxKbps:44,audioKbps:12,fps:10,channels:1,sampleRate:16000,segmentSeconds:8,crf:36,transportOverheadKbps:12}),
 source:Object.freeze({id:'source',label:'جودة المصدر',height:1080}),
 economy720:profile({id:'economy720',label:'720p اقتصادي',height:720,width:1280,videoKbps:700,maxKbps:770,audioKbps:48,fps:25,channels:2,crf:28,transportOverheadKbps:30}),
 economy360:profile({id:'economy360',label:'360p توفير أقصى',height:360,width:640,videoKbps:200,maxKbps:220,audioKbps:32,fps:20,channels:1,crf:30,transportOverheadKbps:24}),
 economy480:profile({id:'economy480',label:'480p للاتصال الأضعف',height:480,width:854,videoKbps:360,maxKbps:396,audioKbps:40,fps:24,channels:2,crf:29,transportOverheadKbps:26})
});
export function streamProfile(id='source'){
 if(!Object.hasOwn(streamProfiles,id))throw Error('وضع البث غير صالح');
 return streamProfiles[id];
}
export function budgetProfile(id,sourceKbps=0){
 let p=streamProfile(id);if(id==='source'||!Number.isFinite(sourceKbps)||sourceKbps<=0)return p;
 // A fixed 720p bitrate can be larger than an already economical source. Choose
 // an honest smaller rendition and cap its transport budget against that source.
 const order=['economy720','economy480','economy360'],minimum={economy720:420,economy480:230,economy360:80};
 const transportBudget=sourceKbps*.7;
 let index=order.indexOf(p.id);
 while(index>=0&&index<order.length-1&&transportBudget<minimum[p.id])p=streamProfiles[order[++index]];
 const audioKbps=Math.min(p.audioKbps,Math.max(8,Math.floor(transportBudget*.16)));
 // Small streams need an absolute MPEG-TS packetization allowance as well as
 // percentage overhead. Treating all mux overhead as 20% undercounts low rates.
 const maxKbps=Math.min(p.maxKbps,Math.max(12,Math.floor((transportBudget-p.transportOverheadKbps)/1.15-audioKbps)));
 const videoKbps=Math.min(p.videoKbps,Math.max(10,Math.floor(maxKbps/1.1)));
 return profile({...p,videoKbps,maxKbps,audioKbps,channels:audioKbps<=32?1:p.channels,sampleRate:audioKbps<=16?16000:p.sampleRate,sourceKbps:Math.round(sourceKbps)});
}
export function encodingArgs(id='source',{resolved,threads=2,preset='veryfast'}={}){
 const p=resolved||streamProfile(id);if(id==='source')return ['-c','copy'];
 const segmentSeconds=p.segmentSeconds||4,gop=p.fps*segmentSeconds;
 // Preserve aspect ratio, even dimensions, and never upscale a smaller source.
 // CRF avoids inflating low-motion sources to a fixed target. VBV bounds complex
 // scenes, while a shorter reservoir limits oversized startup/keyframe bursts.
 return ['-vf',`scale=w='min(iw,${p.width})':h='min(ih,${p.height})':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=${p.fps}`,
 '-c:v','libx264','-preset',preset,'-threads',String(threads),'-pix_fmt','yuv420p','-profile:v','main',
 '-crf',String(p.crf),'-b:v',p.videoKbps+'k','-maxrate',p.maxKbps+'k','-bufsize',(p.maxKbps*2)+'k',
 '-g',String(gop),'-keyint_min',String(gop),'-sc_threshold','0','-bf','0',
 '-force_key_frames',`expr:gte(t,n_forced*${segmentSeconds})`,
 '-c:a','aac','-b:a',p.audioKbps+'k','-ac',String(p.channels||2),'-ar',String(p.sampleRate||48000),
 '-af','aresample=async=1000:first_pts=0','-pat_period',p.id==='emergency144'?'1':'0.5','-sdt_period','5','-pcr_period','100'];
}
