import {inputURL,inspectSource,inspectDirect} from './sources.mjs';

export function audioSettings(value={}){
 const mode=value.mode??'source';
 if(!['source','mute','external'].includes(mode))throw Error('اختر صوت المصدر أو الكتم أو مصدر صوت مستقل');
 const gain=Number(value.gain??100),delay=Number(value.delay??0);
 if(!Number.isFinite(gain)||gain<0||gain>200)throw Error('مستوى الصوت يجب أن يكون بين 0 و200');
 if(!Number.isFinite(delay)||delay<0||delay>30)throw Error('تأخير الصوت يجب أن يكون بين 0 و30 ثانية');
 const url=mode==='external'?inputURL(String(value.url||'').trim()).href:'';
 return {mode,url,gain,delay};
}
export function mixedAudio(value={}){const a=audioSettings(value);return a.mode!=='source'||a.gain!==100||a.delay!==0;}
export async function resolveAudio(value){
 const settings=audioSettings(value);
 if(settings.mode!=='external')return null;
 // Same public-address validation and page extraction as video. Audio-only
 // MP3/AAC/Ogg responses are permitted only for this explicitly audio input.
 return inspectSource(settings.url,{inspect:(url,headers)=>inspectDirect(url,headers,{audio:true})});
}
export function audioOutputArgs(value={}){
 const a=audioSettings(value);
 if(a.mode==='mute'||a.gain===0)return ['-an'];
 const args=['-map',a.mode==='external'?'1:a:0':'0:a:0?'];
 if(!mixedAudio(a))return [...args,'-c:a','copy'];
 const filters=['aresample=async=1000:first_pts=0'];
 if(a.gain!==100)filters.push('volume='+a.gain/100);
 if(a.delay>0)filters.push('adelay='+Math.round(a.delay*1000)+':all=1');
 return [...args,'-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-af',filters.join(',')];
}
