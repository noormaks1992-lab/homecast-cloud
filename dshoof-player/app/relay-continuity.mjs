import {readFile} from 'node:fs/promises';

export async function relayStart(file){
 try{
  const text=await readFile(file,'utf8'),sequence=text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)$/m)?.[1];
  if(sequence&&/^segment_\d+\.ts$/m.test(text)&&!text.includes('#EXT-X-ENDLIST'))return {sequence,continuing:true};
 }catch(error){if(error.code!=='ENOENT')throw error;}
 return {sequence:String(Date.now()*1000),continuing:false};
}

// FFmpeg append_list preserves segments, but does not retain the discontinuity
// sequence once earlier markers slide out. Derive it from overlapping segments.
export function createRelayTimeline(){
 const known=new Map();let lastSequence=-1,lastCC=0;
 function reset(){known.clear();lastSequence=-1;lastCC=0;}
 function normalize(text){
  const lines=text.split(/\r?\n/),entries=[];let local=0;
  const declared=Number(text.match(/^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)$/m)?.[1])||0;
  for(const line of lines){if(line==='#EXT-X-DISCONTINUITY')local++;const match=line.match(/^segment_(\d+)\.ts$/);if(match)entries.push({sequence:Number(match[1]),local});}
  let base=declared;const overlap=entries.find(e=>known.has(e.sequence));
  if(overlap)base=known.get(overlap.sequence)-overlap.local;
  else if(entries.length&&lastSequence>=0&&entries[0].sequence>lastSequence)base=lastCC+1-entries[0].local;
  base=Math.max(0,base);
  for(const e of entries){const cc=base+e.local;known.set(e.sequence,cc);if(e.sequence>=lastSequence){lastSequence=e.sequence;lastCC=cc;}}
  while(known.size>4096)known.delete(known.keys().next().value);
  return lines.filter(l=>!l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')).join('\n').replace('#EXTM3U','#EXTM3U\n#EXT-X-DISCONTINUITY-SEQUENCE:'+base);
 }
 return {reset,normalize};
}
