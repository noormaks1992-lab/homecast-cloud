import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';

const KEY_PATTERN=/^[A-Za-z0-9:_=-]{8,512}$/;

export function buildTelegramPublishUrl(serverUrl,streamKey){
  let u;
  try{u=new URL(String(serverUrl||'').trim());}catch{throw Error('أدخل عنوان خادم RTMPS الصحيح من تيليغرام');}
  if(u.protocol!=='rtmps:')throw Error('عنوان تيليغرام يجب أن يبدأ بـ rtmps:// لحماية مفتاح البث');
  if(u.username||u.password||u.search||u.hash)throw Error('عنوان الخادم يجب أن يكون عنوان السيرفر فقط، دون بيانات سرية إضافية');
  const host=u.hostname.toLowerCase();
  if(!(host==='rtmp.t.me'||host.endsWith('.rtmp.t.me')))throw Error('عنوان الخادم ليس من خوادم بث تيليغرام');
  if(u.pathname.endsWith('/s'))u.pathname+='/';
  if(!u.pathname.endsWith('/s/'))throw Error('عنوان تيليغرام يجب أن ينتهي بالمسار /s/');
  const key=String(streamKey||'').trim();
  if(!KEY_PATTERN.test(key))throw Error('أدخل Stream Key من نافذة البث المباشر في تيليغرام، وليس رمز بوت');
  return u.href+key;
}

function safeDiagnostic(value,key){
  let s=String(value||'').replace(/rtmps?:\/\/[^\s"'<>]+/gi,'[عنوان بث مخفي]');
  if(key)s=s.split(key).join('[مفتاح مخفي]');
  return s.replace(/[\r\n\t]+/g,' ').slice(0,700);
}

export async function createTelegramOutput({directory,input,executable,env,spawnImpl=spawn}){
  await mkdir(directory,{recursive:true,mode:0o700});
  const configPath=path.join(directory,'telegram-output.json');
  let config=null,child=null,wanted=false,retryTimer=null,retryCount=0,connectTimer=null;
  let message='أدخل عنوان خادم تيليغرام ومفتاح البث أولًا',lastError='';
  try{
    const saved=JSON.parse(await readFile(configPath,'utf8'));
    if(saved&&typeof saved.serverUrl==='string'&&typeof saved.streamKey==='string'){
      buildTelegramPublishUrl(saved.serverUrl,saved.streamKey);
      config={serverUrl:saved.serverUrl,streamKey:saved.streamKey};
      message='بيانات البث محفوظة على الخادم؛ الإرسال متوقف';
    }
  }catch(error){if(error.code!=='ENOENT'){config=null;message='تعذر قراءة إعدادات تيليغرام المحفوظة؛ أعد إدخالها';}}
  function publicStatus(){
    return {configured:!!config,serverUrl:config?.serverUrl||'',active:!!child,enabled:wanted,retrying:!!retryTimer,status:message,lastError};
  }
  async function save(){
    const temp=configPath+'.tmp';
    await writeFile(temp,JSON.stringify(config),{mode:0o600});
    await rename(temp,configPath);
  }
  async function configure({serverUrl,streamKey}={}){
    if(child||wanted)throw Error('أوقف إرسال تيليغرام قبل تغيير إعدادات الوجهة');
    const nextUrl=String(serverUrl||config?.serverUrl||'').trim();
    const nextKey=String(streamKey||'').trim()||config?.streamKey||'';
    buildTelegramPublishUrl(nextUrl,nextKey);
    config={serverUrl:nextUrl,streamKey:nextKey};
    await save();
    lastError='';
    message='حُفظت بيانات تيليغرام على الخادم؛ المفتاح لا يُعرض في الموقع';
    return publicStatus();
  }
  function scheduleRetry(){
    if(!wanted||retryTimer)return;
    const delay=Math.min(30000,2000*Math.pow(2,Math.min(retryCount,4)));
    retryCount++;
    message='انقطع الإرسال؛ إعادة محاولة الاتصال خلال '+Math.ceil(delay/1000)+' ثوانٍ';
    retryTimer=setTimeout(()=>{retryTimer=null;launch().catch(()=>{});},delay);
    retryTimer.unref?.();
  }
  async function launch(){
    if(!wanted||child)return publicStatus();
    if(!config)throw Error('احفظ بيانات تيليغرام أولًا');
    await stat(input);
    const target=buildTelegramPublishUrl(config.serverUrl,config.streamKey);
    const args=[
      '-hide_banner','-nostdin','-loglevel','info','-rw_timeout','15000000',
      '-fflags','+genpts+discardcorrupt','-i',input,
      '-map','0:v:0','-map','0:a:0?',
      '-vf','scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
      '-c:v','libx264','-preset','veryfast','-tune','zerolatency','-pix_fmt','yuv420p',
      '-b:v','2500k','-maxrate','3000k','-bufsize','5000k','-g','60','-keyint_min','60','-sc_threshold','0',
      '-c:a','aac','-b:a','128k','-ar','44100','-ac','2','-af','aresample=async=1:first_pts=0',
      '-f','flv',target
    ];
    const p=spawnImpl(executable,args,{stdio:['ignore','ignore','pipe'],env});
    child=p;
    message='يجري الاتصال بخادم تيليغرام…';
    lastError='';
    let spawnSettled=false;
    return await new Promise((resolve,reject)=>{
      const onSpawn=()=>{
        spawnSettled=true;
        message='اتصلت عملية الإرسال؛ بانتظار تأكيد وصول الإطارات إلى تيليغرام…';
        connectTimer=setTimeout(()=>{
          if(child===p&&wanted&&message.startsWith('اتصلت عملية الإرسال'))
            message='عملية الإرسال تعمل؛ إذا بقي تيليغرام يعرض عدم وصول البث، تحقق من Stream Key واضغط بدء البث في تيليغرام';
        },12000);
        connectTimer.unref?.();
        resolve(publicStatus());
      };
      const onError=error=>{
        if(child===p)child=null;
        clearTimeout(connectTimer);connectTimer=null;
        lastError=safeDiagnostic(error.message,config?.streamKey);
        message='تعذر تشغيل عملية الإرسال؛ تحقق من توفر FFmpeg على الاستضافة';
        if(!spawnSettled)reject(Error('تعذر تشغيل FFmpeg لإرسال البث إلى تيليغرام'));
        else scheduleRetry();
      };
      p.once('spawn',onSpawn);
      p.once('error',onError);
      p.stderr?.on('data',chunk=>{
        const s=String(chunk);
        if(/frame=\s*\d+/.test(s)&&child===p){
          message='يجري إرسال الفيديو إلى تيليغرام؛ اضغط «بدء البث» في نافذة تيليغرام لإظهاره للمشاهدين';
          clearTimeout(connectTimer);connectTimer=null;
        }
        const lines=s.split(/\r?\n/).filter(line=>/(error|failed|denied|refused|timed out|invalid)/i.test(line));
        if(lines.length)lastError=safeDiagnostic(lines[lines.length-1],config?.streamKey);
      });
      p.once('close',(code,signal)=>{
        if(child!==p)return;
        child=null;clearTimeout(connectTimer);connectTimer=null;
        if(!wanted)return;
        message='توقفت عملية إرسال تيليغرام (رمز الإنهاء '+String(code??signal??'غير معروف')+')';
        scheduleRetry();
      });
    });
  }
  async function start(){
    if(!config)throw Error('أدخل عنوان خادم تيليغرام ومفتاح البث واحفظهما أولًا');
    buildTelegramPublishUrl(config.serverUrl,config.streamKey);
    if(child)return publicStatus();
    wanted=true;retryCount=0;
    clearTimeout(retryTimer);retryTimer=null;
    try{return await launch();}
    catch(error){lastError=safeDiagnostic(error.message,config?.streamKey);message=error.message;wanted=false;throw error;}
  }
  async function stop(reason='أوقف إرسال تيليغرام'){
    wanted=false;clearTimeout(retryTimer);retryTimer=null;clearTimeout(connectTimer);connectTimer=null;
    const p=child;child=null;
    if(p){
      await new Promise(resolve=>{
        if(p.exitCode!==null||p.signalCode!==null)return resolve();
        const timer=setTimeout(()=>{try{p.kill('SIGKILL');}catch{}},3000);
        timer.unref?.();
        p.once('close',()=>{clearTimeout(timer);resolve();});
        try{p.kill('SIGTERM');}catch{clearTimeout(timer);resolve();}
      });
    }
    message=reason;lastError='';
    return publicStatus();
  }
  return {configure,start,stop,publicStatus,close:()=>stop('توقف تطبيق دشوف')};
}
