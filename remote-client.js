'use strict';
const fs=require('fs'),http=require('http'),https=require('https'),{spawn}=require('child_process');
module.exports=function({config,save,ffmpeg,loopback,inputArgs}){
  let publisher=null,audio=null,upload=null;
  function check(){if(!config.remote?.base||!config.remote?.token||!config.remote?.streamKey)throw Error('الخارجي غير مفعّل: تحتاج حسابًا وسيرفرًا، ثم إدخال عنوانه ومفتاحه.');return config.remote;}
  function url(p){return new URL(p,check().base+'/');}
  async function call(p,body){const c=check(),r=await fetch(url(p),{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-HomeCast-Token':c.token},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(body===undefined?8000:110000)});let j;try{j=await r.json();}catch{throw Error('استجابة السيرفر الخارجي غير صالحة');}if(!r.ok)throw Error(j.error||'تعذر الاتصال بالسيرفر');return j;}
  function stop(){publisher?.kill();audio?.kill();upload?.destroy();publisher=null;audio=null;upload=null;}
  function request(p){const u=url(p);return (u.protocol==='https:'?https:http).request(u,{method:'POST',headers:{'X-HomeCast-Token':check().token,'Content-Type':'application/octet-stream'}});}
  async function configure(data){
    const base=String(data.base||'').trim().replace(/\/$/,'');const u=new URL(base);
    if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)))throw Error('التحكم الخارجي يحتاج HTTPS، أو نفق SSH محلي.');
    if(u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('أدخل عنوان السيرفر فقط دون مسار أو بيانات دخول');
    if(String(data.token||'').length<32||!/^[a-zA-Z0-9_-]{24,}$/.test(data.streamKey||''))throw Error('أدخل مفاتيح التثبيت كاملة');
    const old=config.remote;config.remote={base,token:data.token,streamKey:data.streamKey};
    try{await call('/api/status');save();}catch(e){config.remote=old;throw e;}
  }
  async function source(data){
    check();stop();
    if(data.mode==='file'){
      const file=String(data.value||'').replace(/^"|"$/g,'');const stat=fs.statSync(file);
      if(!stat.isFile()||stat.size>512*1024*1024)throw Error('الرفع الخارجي يدعم ملفًا حتى 512 ميغابايت.');
      return new Promise((resolve,reject)=>{
        const req=request('/api/upload');req.setHeader('Content-Length',stat.size);req.setTimeout(300000,()=>req.destroy(Error('Upload timed out')));upload=req;
        const input=fs.createReadStream(file);input.on('error',e=>req.destroy(e));req.on('error',e=>{input.destroy();reject(e);});
        req.on('response',res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>{upload=null;if(res.statusCode===200)resolve();else{try{reject(Error(JSON.parse(body).error));}catch{reject(Error('تعذر رفع الفيديو'));}}});});input.pipe(req);
      });
    }
    if(data.mode==='screen'){
      const i=inputArgs({mode:'screen'}),enc=config.encoder==='h264_qsv'?['-c:v','h264_qsv','-preset','veryfast','-forced_idr','1']:['-c:v','libx264','-preset','ultrafast','-tune','zerolatency'];
      const p=spawn(ffmpeg,['-hide_banner','-loglevel','error','-filter_threads','2',...i.args,'-map','0:v:0','-map',i.audioMap,'-vf',`${config.fpsMode==='60'?'fps=60,':''}scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=nv12`,...enc,'-b:v','3500k','-g','120','-bf','0','-force_key_frames','expr:gte(t,n_forced*2)','-c:a','aac','-b:a','128k','-ac','2','-ar','48000','-f','mpegts','pipe:1'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      publisher=p;p.stderr.resume();p.stdin.on('error',()=>{});
      if(i.needsLoopback){audio=spawn(loopback,[],{windowsHide:true,stdio:['ignore','pipe','ignore']});audio.stdout.pipe(p.stdin);audio.on('error',()=>stop());}else p.stdin.end();
      const req=request('/api/ingest');upload=req;p.stdout.pipe(req);req.on('error',()=>stop());req.on('response',res=>{res.resume();if(res.statusCode!==200)stop();});p.on('error',()=>stop());p.on('exit',()=>stop());
      await new Promise(r=>setTimeout(r,1000));if(!publisher)throw Error('تعذر إرسال الشاشة إلى السيرفر');return;
    }
    return call('/api/source',data);
  }
  function proxy(req,res){
    const c=check();const u=new URL('/'+c.streamKey+req.url,c.base);
    const out=(u.protocol==='https:'?https:http).request(u,{method:req.method},remote=>{res.writeHead(remote.statusCode,{'Content-Type':remote.headers['content-type']||'application/octet-stream','Cache-Control':'no-store'});remote.pipe(res);remote.on('error',()=>res.destroy());});
    out.setTimeout(45000,()=>out.destroy());out.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'Content-Type':'text/plain'});res.end('External server unavailable');});res.on('close',()=>out.destroy());out.end();
  }
  async function playlist(){const c=check(),r=await fetch(new URL('/'+c.streamKey+'/playlist.m3u',c.base),{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('تعذر تنزيل قائمة الخارجي');return r.text();}
  return {configure,source,stop,proxy,playlist,settings:data=>call('/api/settings',data),status:()=>call('/api/status')};
};
