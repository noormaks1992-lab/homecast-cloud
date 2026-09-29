'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const {spawn, execFile} = require('child_process');
const {promisify} = require('util');
const run = promisify(execFile), crypto = require('crypto');
const ROOT = process.env.HOMECAST_ROOT || __dirname, BIN = path.join(__dirname, 'bin'), DATA = path.join(ROOT, 'runtime');
const REMOTE=process.env.HOMECAST_REMOTE==='1', WINDOWS=process.platform==='win32';
const FFMPEG = process.env.HOMECAST_FFMPEG || (WINDOWS?path.join(BIN,'ffmpeg.exe'):'ffmpeg'), FFPROBE = process.env.HOMECAST_FFPROBE || (WINDOWS?path.join(BIN,'ffprobe.exe'):'ffprobe');
const MEDIA_PORT = Number(process.env.HOMECAST_MEDIA_PORT)||8877, ADMIN_PORT = Number(process.env.HOMECAST_ADMIN_PORT)||8878;
const mediaBridge=require('./media-bridge')(ADMIN_PORT+100);
fs.mkdirSync(DATA, {recursive:true});
const configPath = path.join(ROOT, 'config.json');
let config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/,''));
const token = REMOTE?process.env.HOMECAST_CONTROL_TOKEN:crypto.randomBytes(24).toString('hex');
if(REMOTE&&(!token||token.length<32))throw Error('Set HOMECAST_CONTROL_TOKEN to at least 32 random characters');
const STREAM_KEY=REMOTE?process.env.HOMECAST_STREAM_KEY:'';
if(REMOTE&&(!STREAM_KEY||!/^[a-zA-Z0-9_-]{24,}$/.test(STREAM_KEY)))throw Error('Set a random HOMECAST_STREAM_KEY, minimum 24 characters');
const remoteClient = !REMOTE ? require('./remote-client')({config,save:saveConfig,ffmpeg:FFMPEG,loopback:path.join(BIN,'loopback.exe'),inputArgs,bin:BIN}) : null;
const profiles = {144:[256,144,350],240:[426,240,600],360:[640,360,1100],480:[854,480,1800],720:[1280,720,3500],1080:[1920,1080,6500]};
config.fpsMode=config.fpsMode==='60'?'60':'source';
config.outputMode=config.outputMode==='multi'?'multi':'single';
config.singleQuality=String(config.singleQuality||480);
const workers = new Map(), remuxers = new Set();
let source = {mode:'test',label:'شاشة اختبار',since:Date.now()}, changing=false, sourceError='', lastRefresh=0;
let screenAudio = null;
try { if(WINDOWS&&!REMOTE)screenAudio=JSON.parse(require('child_process').execFileSync(path.join(BIN,'loopback.exe'),['--info'],{windowsHide:true,encoding:'utf8',timeout:10000})); } catch {}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function saveConfig(){ fs.writeFileSync(configPath, JSON.stringify(config,null,2)); }
function ipList(){ return Object.values(os.networkInterfaces()).flat().filter(x=>x.family==='IPv4'&&!x.internal&&!x.address.startsWith('169.254.')).map(x=>x.address); }
function playlist(ts=false,single=config.outputMode==='single'){ const base=REMOTE?`${config.publicBase}/${STREAM_KEY}`:`http://${config.host}:${MEDIA_PORT}`;return '#EXTM3U\r\n'+(single?['channel']:Object.keys(profiles)).map(q=>`#EXTINF:-1 tvg-id="homecast-${q}" group-title="HomeCast",HomeCast ${q==='channel'?'Channel':q+'p'}\r\n${base}/live/${q}/${ts?'stream.ts':'index.m3u8'}\r\n`).join(''); }
function exportLists(){ fs.writeFileSync(path.join(ROOT,'HomeCast.m3u'),playlist()); fs.writeFileSync(path.join(ROOT,'HomeCast-TS.m3u'),playlist(true));fs.writeFileSync(path.join(ROOT,'HomeCast-Single.m3u'),playlist(false,true)); }
exportLists();
function send(res,status,body,type='application/json; charset=utf-8') { if(res.destroyed)return; res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(typeof body==='string'?body:JSON.stringify(body)); }
async function jsonBody(req) { let size=0,chunks=[]; for await(const c of req){size+=c.length;if(size>16384)throw Error('الطلب أكبر من الحد');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString()); }
function spawnHidden(exe,args,opts={}){return spawn(exe,args,{windowsHide:true,...opts});}
function headersArgs(headers={}){
  const entries=Object.entries(headers).filter(([k,v])=>/^(User-Agent|Referer|Origin|Accept|Accept-Language)$/i.test(k)&&typeof v==='string'&&!/[\r\n]/.test(v));
  return entries.length?['-headers',entries.map(([k,v])=>`${k}: ${v}\r\n`).join('')]:[];
}
async function probe(input,headers){
  const original=input;input=mediaBridge.map(input,headers);
  const network=/^https?:\/\//i.test(input);
  const args=['-v','error',...(network?['-rw_timeout','15000000',...headersArgs(headers)]:[]),'-show_streams','-show_format','-of','json',input];
  const {stdout}=await run(FFPROBE,args,{windowsHide:true,timeout:25000,maxBuffer:1024*1024});
  const p=JSON.parse(stdout);if(!p.streams?.some(s=>s.codec_type==='video'))throw Error('المصدر لا يحتوي فيديو يمكن قراءته');
  return {...(input!==original?{input}:{}),audio:p.streams.some(s=>s.codec_type==='audio'),duration:Number(p.format?.duration)||0,videoStreams:p.streams.filter(s=>s.codec_type==='video'&&s.width&&s.height).map(s=>({index:s.index,width:s.width,height:s.height}))};
}
async function resolveSource(data){
  if(data.mode==='test')return {mode:'test',label:'شاشة اختبار'};
  if(data.mode==='screen'){if(REMOTE)throw Error('ابث الشاشة من برنامج الحاسبة عبر زر الشاشة');return {mode:'screen',label:screenAudio?'شاشة الحاسبة وصوت النظام':'شاشة الحاسبة (الصوت غير متاح)'};}
  if(data.mode==='ingest'&&REMOTE)return {mode:'ingest',input:path.join(DATA,'ingest','index.m3u8'),audio:true,label:'بث مباشر من الحاسبة'};
  let value=String(data.value||'').trim().replace(/^"|"$/g,'');
  if(data.mode==='file'){
    if(!path.isAbsolute(value)||!fs.statSync(value).isFile())throw Error('اختر ملف فيديو موجودًا');
    const info=await probe(value);return {mode:'file',input:value,label:path.basename(value),...info};
  }
  if(data.mode!=='url'||!/^https?:\/\//i.test(value))throw Error('أدخل رابط http أو https صالحًا');
  // First test as media. A webpage may be resolvable by yt-dlp; no browser cookies are read.
  try { const info=await probe(value);return {mode:'url',original:value,input:value,label:'رابط بث مباشر',...info}; } catch {}
  let info;
  try {
    const {stdout}=await run(process.env.HOMECAST_YTDLP || (WINDOWS?path.join(BIN,'yt-dlp.exe'):'yt-dlp'),['--ignore-config','--no-playlist','--no-warnings','--skip-download','--dump-single-json','--socket-timeout','15','--js-runtimes',`node:${process.execPath}`,'-f','best[height<=1080]/bestvideo[height<=1080]+bestaudio/best','--',value],{windowsHide:true,timeout:65000,maxBuffer:5*1024*1024});
    info=JSON.parse(stdout);
  }catch{
    const discovered=await require('./discover-media')(value,probe);
    if(discovered)return {mode:'url',original:value,label:'فيديو مكتشف داخل الموقع',extracted:true,...discovered};
    throw Error('تعذّر استخراج بث مستقل. جرى فحص الرابط والمواقع المدعومة وعناصر الفيديو والإطارات. هذا الموقع قد يحتاج متصفحًا أو جلسة مشاهدة؛ استخدم فتح الموقع وبث الشاشة.');
  }
  const list=info.requested_formats||[info],video=list.find(f=>f.vcodec&&f.vcodec!=='none')||list[0],audio=list.find(f=>f.vcodec==='none'&&f.acodec!=='none');
  if(!video.url||!/^https?:\/\//i.test(video.url)||audio&&!/^https?:\/\//i.test(audio.url))throw Error('بروتوكول المصدر غير مدعوم');
  const inspected=await probe(video.url,video.http_headers||info.http_headers);
  return {mode:'url',original:value,input:inspected.input||video.url,videoStreams:inspected.videoStreams,headers:video.http_headers||info.http_headers,audioInput:audio?.url,audioHeaders:audio?.http_headers||info.http_headers,audio:!!audio||video.acodec!=='none',duration:info.is_live?0:Number(info.duration)||0,label:String(info.title||'فيديو من رابط').slice(0,180),extracted:true};
}
function stopWorker(w){w.intentional=true;if(w.proc){w.proc.kill();w.proc=null;}if(w.audioProc){w.audioProc.kill();w.audioProc=null;}}
async function setSource(data){
  if(changing)throw Error('يوجد تغيير مصدر قيد التنفيذ');changing=true;sourceError='';
  try {
    const next=await resolveSource(data);
    source={...next,since:Date.now()};
    config.lastSource=next.mode==='screen'?{mode:'test'}:{mode:data.mode,value:data.value||''};saveConfig();
    for(const w of workers.values()){stopWorker(w);w.attempt=0;w.nextRetry=0;w.resetPlaylist=true;}
    for(const w of workers.values())if(Date.now()-w.lastAccess<90000)startWorker(w);
  }catch(e){sourceError=e.message;throw e;}finally{changing=false;}
}
function inputArgs(s){
  const a=[];let audioMap='0:a:0',needsLoopback=false;
  if(s.mode==='test')a.push('-re','-f','lavfi','-i',`testsrc2=size=1280x720:rate=${config.fpsMode==='60'?60:30}`,'-re','-f','lavfi','-i','sine=frequency=440:sample_rate=48000'),audioMap='1:a:0';
  else if(s.mode==='screen'){
    a.push('-thread_queue_size','512','-f','gdigrab','-framerate',config.fpsMode==='60'?'60':'30','-draw_mouse','1','-i','desktop');
    if(screenAudio){a.push('-thread_queue_size','1024','-f',screenAudio.format,'-ar',String(screenAudio.rate),'-ac',String(screenAudio.channels),'-i','pipe:0');needsLoopback=true;}
    else a.push('-re','-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
    audioMap='1:a:0';
  } else {
    if(s.mode==='file'){
      a.push('-re','-stream_loop','-1');
      if(s.duration>0)a.push('-ss',String(((Date.now()-s.since)/1000)%s.duration));
      a.push('-i',s.input);
    }else if(s.mode==='ingest'){
      a.push('-re','-live_start_index','-2','-i',s.input);
    }else{
      a.push('-re','-rw_timeout','15000000','-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','3',...headersArgs(s.headers),'-i',s.input);
    }
    if(s.audioInput){a.push('-re','-rw_timeout','15000000',...headersArgs(s.audioHeaders),'-i',s.audioInput);audioMap='1:a:0';}
    else if(!s.audio){a.push('-re','-f','lavfi','-i','anullsrc=r=48000:cl=stereo');audioMap='1:a:0';}
  }
  return {args:a,audioMap,needsLoopback};
}
function startWorker(w){
  if(w.proc||Date.now()<w.nextRetry)return;
  w.intentional=false;w.started=Date.now();w.error='';w.progress='';w.speed=0;
  const [width,height,bitrate]=profiles[w.q],input=inputArgs(source);
  const variants=(source.videoStreams||[]).slice().sort((a,b)=>(a.width*a.height)-(b.width*b.height));
  const selected=variants.find(v=>Math.max(v.width/width,v.height/height)>=1)||variants[variants.length-1];
  const videoMap=selected?`0:${selected.index}`:'0:v:0';
  const scale=`${config.fpsMode==='60'?'fps=60,':''}scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=nv12`;
  const encoder=config.encoder==='h264_qsv'?['-c:v','h264_qsv','-preset','veryfast','-look_ahead','0','-async_depth','4','-forced_idr','1']:['-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-threads','2'];
  const epoch=Date.now(),args=['-hide_banner','-loglevel','warning','-nostats','-progress','pipe:1','-filter_threads','2',...input.args,'-map',videoMap,'-map',input.audioMap,'-vf',scale,...encoder,'-profile:v','main','-level:v','4.2','-b:v',`${bitrate}k`,'-maxrate',`${Math.round(bitrate*1.2)}k`,'-bufsize',`${bitrate*2}k`,'-g','120','-bf','0','-force_key_frames','expr:gte(t,n_forced*2)','-c:a','aac','-b:a','128k','-ac','2','-ar','48000','-af','aresample=async=1000:first_pts=0','-max_muxing_queue_size','2048','-f','hls','-hls_time','2','-hls_list_size','6','-hls_delete_threshold','4','-hls_start_number_source','epoch_us','-hls_flags','delete_segments+independent_segments+temp_file+discont_start+omit_endlist'+(w.resetPlaylist===false?'+append_list':''),'-hls_segment_filename',path.join(w.dir,`s${epoch}_%d.ts`),path.join(w.dir,'index.m3u8')];
  const p=spawnHidden(FFMPEG,args,{stdio:['pipe','pipe','pipe']});w.proc=p;w.pid=p.pid;w.resetPlaylist=false;
  if(input.needsLoopback){
    const a=spawnHidden(path.join(BIN,'loopback.exe'),[],{stdio:['ignore','pipe','pipe']});w.audioProc=a;
    a.stdout.pipe(p.stdin);a.stderr.on('data',d=>w.error=String(d).slice(-1000));a.on('error',e=>w.error=e.message);
    a.on('exit',()=>{if(w.proc===p&&!w.intentional)p.kill();});
  }else p.stdin.end();
  p.stdin.on('error',()=>{});
  p.stdout.on('data',d=>{w.progress+=d.toString();const lines=w.progress.split('\n');w.progress=lines.pop();for(const line of lines){const [k,v]=line.trim().split('=');if(k==='speed')w.speed=parseFloat(v)||0;if(k==='fps')w.fps=Number(v)||0;}});
  p.stderr.on('data',d=>{w.error=(w.error+d.toString()).slice(-2500);});
  p.on('error',e=>{w.error=e.message;});
  p.on('exit',code=>{
    if(w.proc!==p)return;
    w.proc=null;if(w.audioProc){w.audioProc.kill();w.audioProc=null;}
    if(!w.intentional){w.attempt++;w.nextRetry=Date.now()+Math.min(30000,2000*2**Math.min(w.attempt,4));if(!w.error)w.error=`FFmpeg stopped (${code})`;}
  });
}
function getWorker(q){
  let w=workers.get(q);if(!w){const dir=path.join(DATA,q);fs.mkdirSync(dir,{recursive:true});w={q,dir,proc:null,lastAccess:Date.now(),nextRetry:0,attempt:0};workers.set(q,w);}
  w.lastAccess=Date.now();startWorker(w);return w;
}
function freshPlaylist(w){
  try{const f=path.join(w.dir,'index.m3u8');return fs.statSync(f).mtimeMs>w.started&&fs.readFileSync(f,'utf8').includes('#EXTINF:');}catch{return false;}
}
async function ready(w){const end=Date.now()+35000;while(Date.now()<end){if(freshPlaylist(w))return true;if(!w.proc&&w.attempt>0)return false;await sleep(200);}return false;}
function serveFile(req,res,file,type){
  let stat;try{stat=fs.statSync(file);}catch{return send(res,404,'Not ready','text/plain');}
  const headers={'Content-Type':type,'Content-Length':stat.size,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*'};
  if(req.method==='HEAD'){res.writeHead(200,headers);return res.end();}
  res.writeHead(200,headers);const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
}
const media=http.createServer(async(req,res)=>{
  try{
    if(!['GET','HEAD'].includes(req.method))return send(res,405,'Method not allowed');
    const url=new URL(req.url,'http://localhost');
    if(REMOTE){if(!url.pathname.startsWith('/'+STREAM_KEY+'/'))return send(res,404,'Not found');url.pathname=url.pathname.slice(STREAM_KEY.length+1);}
    if(!REMOTE&&config.backend==='external')return remoteClient.proxy(req,res);
    if(url.pathname==='/playlist.m3u'||url.pathname==='/playlist-ts.m3u')return send(res,200,playlist(url.pathname.includes('-ts')),'audio/x-mpegurl');
    const m=url.pathname.match(/^\/live\/(144|240|360|480|720|1080|channel)\/(index\.m3u8|stream\.ts|s\d+_\d+\.ts)$/);
    if(!m)return send(res,404,'Not found','text/plain');
    const q=m[1]==='channel'?config.singleQuality:m[1];
    if(config.outputMode==='single'&&m[1]!=='channel'&&q!==config.singleQuality&&!/^s\d/.test(m[2]))return send(res,409,'Single quality mode is enabled','text/plain');
    if(/^s\d/.test(m[2]))return serveFile(req,res,path.join(DATA,q,m[2]),'video/mp2t');
    const w=getWorker(q);
    if(m[2]==='index.m3u8'||m[2]==='stream.ts'){
      if(!await ready(w))return send(res,503,'Source unavailable. Open HomeCast control on the computer.','text/plain');
      if(m[2]==='stream.ts'){
        if(req.method==='HEAD'){res.writeHead(200,{'Content-Type':'video/mp2t'});return res.end();}
        if(remuxers.size>=4)return send(res,503,'Maximum viewers reached','text/plain');
        const p=spawnHidden(FFMPEG,['-hide_banner','-loglevel','error','-live_start_index','-2','-i',path.join(w.dir,'index.m3u8'),'-map','0','-c','copy','-mpegts_flags','+resend_headers','-muxdelay','0','-f','mpegts','pipe:1'],{stdio:['ignore','pipe','pipe']});
        remuxers.add(p);const touch=setInterval(()=>w.lastAccess=Date.now(),5000);
        res.writeHead(200,{'Content-Type':'video/mp2t','Cache-Control':'no-store','Connection':'close'});p.stdout.pipe(res);p.stderr.resume();
        const clean=()=>{clearInterval(touch);remuxers.delete(p);p.kill();};res.on('close',clean);p.on('error',()=>{clean();res.destroy();});p.on('exit',()=>{clean();res.end();});return;
      }
    }
    if(m[1]==='channel'&&m[2]==='index.m3u8')return send(res,200,fs.readFileSync(path.join(w.dir,'index.m3u8'),'utf8').replace(/^(s\d+_\d+\.ts)$/gm,`../${q}/$1`),'application/vnd.apple.mpegurl');
    serveFile(req,res,path.join(w.dir,m[2]),m[2].endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t');
  }catch{if(!res.headersSent)send(res,500,'Stream error','text/plain');else res.destroy();}
});
const admin=http.createServer(async(req,res)=>{
  const host=req.headers.host;
  if(!REMOTE&&![`127.0.0.1:${ADMIN_PORT}`,`localhost:${ADMIN_PORT}`].includes(host))return send(res,403,{error:'Invalid host'});
  if(!REMOTE&&req.headers.origin&&req.headers.origin!==`http://${host}`)return send(res,403,{error:'Invalid origin'});
  if(REMOTE&&req.headers['x-homecast-token']!==token)return send(res,403,{error:'Unauthorized'});
  const url=new URL(req.url,`http://${host}`);
  try{
    if(req.method==='GET'&&url.pathname==='/'&&!REMOTE)return send(res,200,fs.readFileSync(path.join(__dirname,'control.html'),'utf8').replace('__TOKEN__',token),'text/html; charset=utf-8');
    if(req.method==='GET'&&url.pathname==='/api/status'){
      let state={source:{mode:source.mode,label:source.label},changing,sourceError,host:config.host,reservedHost:config.reservedHost||'',ips:ipList(),encoder:config.encoder,settings:{fpsMode:config.fpsMode,outputMode:config.outputMode,singleQuality:config.singleQuality},screenAudio:!!screenAudio,backend:config.backend||'local',remoteConfigured:!!config.remote?.base,remoteBase:config.remote?.base||'',workers:[...workers.values()].map(w=>({quality:w.q,running:!!w.proc,pid:w.pid,speed:w.speed,fps:w.fps,ready:freshPlaylist(w),error:(w.error||'').replace(/https?:\/\/\S+/g,'[source URL]')}))};
      if(!REMOTE&&config.backend==='external'){try{const other=await remoteClient.status();state={...state,settings:other.settings,source:other.source,workers:other.workers,encoder:other.encoder,sourceError:other.sourceError};}catch(e){state.sourceError=e.message;state.source={mode:'offline',label:'الخارجي غير متصل'};state.workers=[];}}
      return send(res,200,state);
    }
    if(req.method==='GET'&&url.pathname==='/download-external.m3u'&&!REMOTE){if(!config.remote?.base)throw Error('اربط سيرفرًا خارجيًا أولًا');res.setHeader('Content-Disposition','attachment; filename="HomeCast-External.m3u"');return send(res,200,await remoteClient.playlist(),'audio/x-mpegurl');}
    if(req.method==='GET'&&url.pathname==='/download.m3u'){res.setHeader('Content-Disposition','attachment; filename="HomeCast.m3u"');return send(res,200,playlist(),'audio/x-mpegurl');}
    if(req.method==='GET'&&url.pathname==='/download-ts.m3u'){res.setHeader('Content-Disposition','attachment; filename="HomeCast-TS.m3u"');return send(res,200,playlist(true),'audio/x-mpegurl');}
    if(req.method!=='POST'||req.headers['x-homecast-token']!==token)return send(res,403,{error:'غير مصرح'});
    if(url.pathname==='/api/upload'){
      const uploadDir=path.join(DATA,'uploads');fs.mkdirSync(uploadDir,{recursive:true});
      const file=path.join(uploadDir,'video-'+Date.now()+'.mp4');const fd=fs.openSync(file,'wx');let size=0;
      try{for await(const chunk of req){size+=chunk.length;if(size>512*1024*1024)throw Error('الحد 512 ميغابايت للفيديو؛ استخدم مسار الملف للفيديو المحلي الأكبر');fs.writeSync(fd,chunk);}fs.closeSync(fd);if(!REMOTE&&config.backend==='external')await remoteClient.source({mode:'file',value:file});else await setSource({mode:'file',value:file});return send(res,200,{ok:true});}catch(e){try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(file);}catch{}throw e;}
    }
    if(REMOTE&&url.pathname==='/api/ingest')return receiveIngest(req,res);
    const data=await jsonBody(req);
    if(!REMOTE&&url.pathname==='/api/remote-config'){await remoteClient.configure(data);return send(res,200,{ok:true});}
    if(!REMOTE&&url.pathname==='/api/remote-disconnect'){remoteClient.stop();delete config.remote;config.backend='local';saveConfig();return send(res,200,{ok:true});}
    if(!REMOTE&&url.pathname==='/api/backend'){
      if(!['local','external'].includes(data.backend))throw Error('خيار غير صحيح');
      if(data.backend==='external')await remoteClient.status();else remoteClient.stop();
      for(const w of workers.values())stopWorker(w);workers.clear();config.backend=data.backend;saveConfig();return send(res,200,{ok:true});
    }
    if(url.pathname==='/api/settings'){
      if(!['source','60'].includes(data.fpsMode)||!['single','multi'].includes(data.outputMode)||!Object.hasOwn(profiles,String(data.singleQuality)))throw Error('إعدادات البث غير صالحة');
      if(!REMOTE&&config.backend==='external')await remoteClient.settings(data);
      Object.assign(config,{fpsMode:data.fpsMode,outputMode:data.outputMode,singleQuality:String(data.singleQuality)});saveConfig();exportLists();
      for(const w of workers.values())stopWorker(w);workers.clear();return send(res,200,{ok:true});
    }
    if(url.pathname==='/api/source'){if(!REMOTE&&config.backend==='external')await remoteClient.source(data);else await setSource(data);return send(res,200,{ok:true});}
    if(url.pathname==='/api/pick'&&!REMOTE){
      const {stdout}=await run('powershell.exe',['-NoProfile','-STA','-File',path.join(ROOT,'pick-file.ps1')],{windowsHide:true,timeout:180000,encoding:'utf8'});return send(res,200,{path:stdout.trim()});
    }
    if(url.pathname==='/api/stop'){if(!REMOTE&&config.backend==='external'){await remoteClient.source({mode:'test'});return send(res,200,{ok:true});}for(const w of workers.values())stopWorker(w);workers.clear();source={mode:'test',label:'شاشة اختبار',since:Date.now()};sourceError='';config.lastSource={mode:'test'};saveConfig();return send(res,200,{ok:true});}
    if(url.pathname==='/api/host'){
      if(!ipList().includes(data.host))throw Error('العنوان يجب أن يكون عنوان الحاسبة الحالي');
      config.host=data.host;saveConfig();exportLists();return send(res,200,{ok:true});
    }
    if(url.pathname==='/api/shutdown'){send(res,200,{ok:true});setTimeout(shutdown,300);return;}
    send(res,404,{error:'غير موجود'});
  }catch(e){send(res,400,{error:e.message});}
});
const monitor=setInterval(()=>{
  if(source.extracted&&!changing&&Date.now()-lastRefresh>60000&&[...workers.values()].some(w=>w.attempt>=2)){
    const old=source;lastRefresh=Date.now();
    resolveSource({mode:'url',value:old.original}).then(next=>{
      if(source!==old)return;source={...next,since:Date.now()};sourceError='';
      for(const w of workers.values()){stopWorker(w);w.attempt=0;w.nextRetry=0;startWorker(w);}
    }).catch(()=>{if(source===old)sourceError='تعذر تجديد رابط الموقع تلقائيًا؛ أعد تشغيل المصدر أو استخدم الشاشة';});
  }
  for(const [q,w]of workers){
    if(Date.now()-w.lastAccess>90000){stopWorker(w);workers.delete(q);continue;}
    if(!w.proc)startWorker(w);
    else if(Date.now()-w.started>45000){
      let changed=0;try{changed=fs.statSync(path.join(w.dir,'index.m3u8')).mtimeMs;}catch{}
      if(Date.now()-changed>25000){stopWorker(w);w.nextRetry=Date.now()+2000;w.error='المصدر توقف؛ تجري إعادة الاتصال';}
    }
  }
  // Only generated media fragments are removed; source videos are never deleted.
  for(const q of Object.keys(profiles)){
    const dir=path.join(DATA,q);if(!fs.existsSync(dir))continue;
    let keep=new Set();try{keep=new Set(fs.readFileSync(path.join(dir,'index.m3u8'),'utf8').split(/\r?\n/).filter(x=>x.endsWith('.ts')));}catch{}
    for(const f of fs.readdirSync(dir))if(/^s\d+_\d+\.ts(?:\.tmp)?$/.test(f)&&!keep.has(f)){try{const p=path.join(dir,f);if(Date.now()-fs.statSync(p).mtimeMs>120000)fs.unlinkSync(p);}catch{}}
  }
},5000);
let ingestProcess=null;
function receiveIngest(req,res){
  if(ingestProcess)return send(res,409,{error:'يوجد بث شاشة جارٍ؛ أوقفه أولًا'});
  const dir=path.join(DATA,'ingest');fs.mkdirSync(dir,{recursive:true});
  const started=Date.now(),target=path.join(dir,'index.m3u8');
  const p=spawnHidden(FFMPEG,['-hide_banner','-loglevel','error','-i','pipe:0','-map','0','-c','copy','-f','hls','-hls_time','2','-hls_list_size','6','-hls_flags','delete_segments+temp_file+omit_endlist','-hls_segment_filename',path.join(dir,`input${started}_%d.ts`),target],{stdio:['pipe','ignore','pipe']});
  ingestProcess=p;req.pipe(p.stdin);p.stdin.on('error',()=>{});p.stderr.resume();
  const timer=setInterval(()=>{try{if(fs.statSync(target).mtimeMs>started){clearInterval(timer);setSource({mode:'ingest'}).catch(()=>{});}}catch{}},500);
  const clean=()=>{clearInterval(timer);if(ingestProcess===p)ingestProcess=null;p.kill();};req.on('aborted',clean);req.on('end',()=>p.stdin.end());p.on('error',()=>{clean();send(res,500,{error:'Ingest failed'});});p.on('exit',()=>{clean();send(res,200,{ok:true});});
}
function shutdown(){clearInterval(monitor);mediaBridge.close();remoteClient?.stop();ingestProcess?.kill();for(const w of workers.values())stopWorker(w);for(const p of remuxers)p.kill();media.close();admin.close();setTimeout(()=>process.exit(0),300);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
for(const s of [media,admin])s.on('error',e=>{console.error(e.message);shutdown();});
mediaBridge.onError(e=>{console.error(e.message);shutdown();});
media.listen(MEDIA_PORT,process.env.HOMECAST_BIND || '0.0.0.0',()=>console.log(`HomeCast media ready on port ${MEDIA_PORT}`));
admin.listen(ADMIN_PORT,process.env.HOMECAST_BIND || (REMOTE?'0.0.0.0':'127.0.0.1'),()=>console.log(`HomeCast control ready on port ${ADMIN_PORT}`));
admin.requestTimeout=0; // Authenticated screen uploads are intentionally long-lived.
fs.writeFileSync(path.join(DATA,'server.pid'),String(process.pid));
if(config.lastSource&&['url','file'].includes(config.lastSource.mode))setSource(config.lastSource).catch(()=>{});
