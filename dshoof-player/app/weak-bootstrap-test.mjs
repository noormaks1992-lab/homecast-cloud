import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createWeakStream} from './weak-stream.mjs';
test('existing local segments bootstrap thirty seconds without waiting thirty real seconds',{timeout:25000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'weak-bootstrap-'));let weak;
 try{
 const input=path.join(dir,'input.m3u8');
 const result=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=25','-t','48','-c:v','libx264','-threads','2','-preset','ultrafast','-g','100','-sc_threshold','0','-f','hls','-hls_time','4','-hls_list_size','20','-hls_segment_filename',path.join(dir,'input_%d.ts'),input]);assert.equal(result.status,0);
 await writeFile(input,(await readFile(input,'utf8')).replace('#EXT-X-ENDLIST',''));
 weak=createWeakStream({directory:path.join(dir,'weak'),input,executable:'ffmpeg',env:process.env});await weak.reset('economy360');const start=Date.now();await weak.touch();let seconds=0;
 while(Date.now()-start<15000){try{const text=await readFile(path.join(dir,'weak/dshoof.m3u8'),'utf8');seconds=[...text.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((n,m)=>n+Number(m[1]),0);}catch{}if(seconds>=32)break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(seconds>=32,'at least thirty-two prepared seconds');assert.ok(Date.now()-start<15000);console.log(JSON.stringify({preparedSeconds:seconds,elapsedMs:Date.now()-start}));
 }finally{await weak?.close();await rm(dir,{recursive:true,force:true});}
});
