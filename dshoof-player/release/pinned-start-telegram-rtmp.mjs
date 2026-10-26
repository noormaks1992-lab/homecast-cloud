// Deployment launcher for the Telegram RTMP release. Install as github-start.mjs
// in the confirmed Botkeep application root; preserve its existing DATA_DIR.
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';

const root=path.dirname(fileURLToPath(import.meta.url));
const release='3.5.0-telegram-rtmp.1';
const directory=path.resolve(root,process.env.DATA_DIR||'data');

let state;
try{state=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));}
catch{throw Error('Pinned startup requires the verified existing state.json');}
if(!['owner','viewer','playlistAlias'].every(name=>typeof state[name]==='string'&&state[name].length>0)){
 throw Error('Pinned startup requires the existing owner and playlist identity');
}
state=null;

process.env.DATA_DIR=directory;
process.env.DSHOOF_RELEASE=release;
delete process.env.DSHOOF_GITHUB_TOKEN;
process.chdir(root);
console.log('[pinned-start] '+release+'; existing state verified');
await import(pathToFileURL(path.join(root,'supervisor.mjs')).href);
