// Rebuild the complete updater snapshot from reviewable source, without runtime data.
import {readFile,writeFile,readdir,lstat,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateSnapshot} from '../app/github-start.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.join(project,'app');
const version='3.3.0-clubhouse.1';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const files={},base64Files={};
async function collect(relative=''){
 for(const entry of (await readdir(path.join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(entry.name.startsWith('.')||['node_modules','data','test-results'].includes(entry.name))continue;
  const name=path.posix.join(relative,entry.name),full=path.join(root,name);
  if(entry.isSymbolicLink())throw Error('Do not package symlinks: '+name);
  if(entry.isDirectory()){if(name==='public')await collect(name);continue;}
  if(!entry.isFile())continue;
  if(relative!==''&&relative!=='public')continue;
  if(name==='soak-results.json'||name.endsWith('-results.json'))continue;
  const text=/\.(?:mjs|js|css|html|svg|webmanifest|md)$/.test(name)||['package.json','package-lock.json'].includes(name);
  const binary=/\.(?:png|webp|ico|woff2?)$/.test(name);
  if(!text&&!binary)continue;
  if(!(await lstat(full)).isFile())throw Error('File changed during packaging');
  const bytes=await readFile(full);(text?files:base64Files)[name]=bytes.toString(text?'utf8':'base64');
 }
}
await collect();
// Keep the separately downloadable launcher aligned with canonical source.
for(const name of ['github-start.mjs','GITHUB-AUTOUPDATE.md']){
 const content=await readFile(path.join(root,name));
 if(process.argv.includes('--check')){
  if(!content.equals(await readFile(path.join(project,name))))throw Error('Standalone '+name+' differs from app source');
 }else await writeFile(path.join(project,name),content);
}
const snapshot={version,files,base64Files};
validateSnapshot(snapshot);
const bytes=JSON.stringify(snapshot,null,2)+'\n';
const destination=path.join(project,'source.snapshot.json');
if(process.argv.includes('--check')){
 if(await readFile(destination,'utf8')!==bytes)throw Error('Snapshot differs from app source; run node tools/release.mjs');
 console.log('Snapshot matches source; '+Object.keys(files).length+' text files, '+Object.keys(base64Files).length+' binary assets.');
}else{
 await writeFile(destination,bytes);
 console.log('Saved complete '+version+' snapshot; sha256 '+digest(bytes));
}

// These are the candidate sources which matched the live public files before
// development. Backend hashes must still be verified against a private live backup.
const beforeHashes=JSON.parse(await readFile(path.join(project,'release','baseline-hashes.json'),'utf8')).files;
const runtime=['server.mjs','supervisor.mjs','sources.mjs','quality.mjs','room.mjs','chat-events.mjs','viewer-info.mjs','watch-analytics.mjs','pro.mjs','cap.mjs','segment-cache.mjs','ffmpeg-runtime.mjs','stream-profile.mjs','weak-stream.mjs','github-start.mjs','package.json','package-lock.json'];
const changes=[];
for(const [name,content] of Object.entries(files)){
 if(!runtime.includes(name)&&!name.startsWith('public/'))continue;
 if(beforeHashes[name]===digest(content))continue;
 changes.push({path:name,beforeSha256:beforeHashes[name]||null,afterSha256:digest(content),bytes:Buffer.byteLength(content)});
}
for(const [name,content] of Object.entries(base64Files)){const decoded=Buffer.from(content,'base64');if(beforeHashes[name]!==digest(decoded))changes.push({path:name,beforeSha256:beforeHashes[name]||null,afterSha256:digest(decoded),bytes:decoded.length});}
const manifest=JSON.stringify({version,snapshotSha256:digest(bytes),status:'prepared; see deployment record for live status',requiresPrivateLiveBackup:true,unchangedPermanentLinks:true,changes},null,2)+'\n';
if(process.argv.includes('--check')){if(await readFile(path.join(project,'release','manifest.json'),'utf8')!==manifest)throw Error('Release manifest differs from sources');}
else{await mkdir(path.join(project,'release'),{recursive:true});await writeFile(path.join(project,'release','manifest.json'),manifest);}
