import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

export function hlsInputArgsFromHelp(help=''){
 const args=['-allowed_extensions','ALL'];
 if(/^\s*-allowed_segment_extensions\s/m.test(help))args.push('-allowed_segment_extensions','ALL');
 if(/^\s*-extension_picky\s/m.test(help))args.push('-extension_picky','0');
 return args;
}

// Some glibc-linked static Linux FFmpeg builds dlopen incompatible host gconv
// modules while parsing MPEG-TS service names. Isolate only that child runtime;
// do not modify Node's environment, video packets, codecs, or source headers.
export async function ffmpegRuntime(dataDir,{
 env=process.env,platform=process.platform,
 bundledPath=()=>createRequire(import.meta.url)('ffmpeg-static')
}={}){
 let executable=env.FFMPEG_PATH,bundled=false;
 if(!executable){try{executable=bundledPath();bundled=!!executable;}catch{}executable||='ffmpeg';}
 const childEnv={...env};
 const isolated=bundled&&platform==='linux';
 if(isolated){
  const directory=path.join(dataDir,'ffmpeg-gconv-empty');
  await mkdir(directory,{recursive:true,mode:0o700});
  childEnv.GCONV_PATH=directory;
 }
 // FFmpeg7 tightened both segment allowlists and suffix matching. Sources may
 // legitimately publish TS as .js/.css, so detect each supported option instead
 // of passing new flags to older bundled builds. Protocol controls stay with
 // the caller; extension compatibility does not permit additional transports.
 let help='';try{const result=await execute(executable,['-hide_banner','-h','demuxer=hls'],{env:childEnv,timeout:5000,killSignal:'SIGKILL',maxBuffer:256*1024,windowsHide:true});help=result.stdout+'\n'+result.stderr;}catch{}
 return {executable,env:childEnv,bundled,isolated,hlsInputArgs:hlsInputArgsFromHelp(help)};
}
