// Deployment template: install as github-start.mjs in the confirmed application
// root only after verifying its original startup command and persistent DATA_DIR.
// Do not run this template directly from the repository's tools directory.
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';

const root=path.dirname(fileURLToPath(import.meta.url));
const release='3.5.0-live-player.3';
const directory=path.resolve(root,process.env.DATA_DIR||'data');

// A mistaken application root must fail before server.mjs can create new owner
// credentials or replace the installation's permanent playlist identity.
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
// supervisor.mjs retains ownership of restart backoff and graceful signals.
await import(pathToFileURL(path.join(root,'supervisor.mjs')).href);

