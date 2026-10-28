import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildTelegramPublishUrl,createTelegramOutput} from './telegram-output.mjs';

test('builds a Telegram RTMPS destination from the server URL and stream key',()=>{
  assert.equal(buildTelegramPublishUrl('rtmps://dc4-1.rtmp.t.me/s/','12345678:abcd_EFG-123='),'rtmps://dc4-1.rtmp.t.me/s/12345678:abcd_EFG-123=');
  assert.throws(()=>buildTelegramPublishUrl('rtmp://dc4-1.rtmp.t.me/s/','12345678:abcd_EFG-123='),/rtmps/);
  assert.throws(()=>buildTelegramPublishUrl('rtmps://example.com/s/','12345678:abcd_EFG-123='),/تيليغرام/);
  assert.throws(()=>buildTelegramPublishUrl('rtmps://dc4-1.rtmp.t.me/s/?token=x','12345678:abcd_EFG-123='),/عنوان الخادم/);
  assert.throws(()=>buildTelegramPublishUrl('rtmps://dc4-1.rtmp.t.me/s/','bad key'),/Stream Key/);
});

test('stores Telegram credentials privately, hides the key from status and starts/stops publisher',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'dshoof-telegram-'));
  const input=path.join(directory,'dshoof.m3u8');
  const key='12345678:secret_key_abc';
  let fakeChild;
  const spawnImpl=(_exe,args)=>{
    fakeChild=new EventEmitter();fakeChild.stderr=new PassThrough();fakeChild.exitCode=null;fakeChild.signalCode=null;
    fakeChild.args=args;
    fakeChild.kill=signal=>{fakeChild.signalCode=signal;setImmediate(()=>fakeChild.emit('close',null,signal));return true;};
    setImmediate(()=>fakeChild.emit('spawn'));
    return fakeChild;
  };
  try{
    await writeFile(input,'#EXTM3U\n#EXTINF:4,\nsegment.ts\n');
    const output=await createTelegramOutput({directory,input,executable:'ffmpeg',env:process.env,spawnImpl});
    await output.configure({serverUrl:'rtmps://dc4-1.rtmp.t.me/s/',streamKey:key});
    const status=output.publicStatus();
    assert.equal(status.configured,true);
    assert.equal(JSON.stringify(status).includes(key),false);
    assert.equal(JSON.stringify(status).includes('secret_key_abc'),false);
    const saved=await readFile(path.join(directory,'telegram-output.json'),'utf8');
    assert.ok(saved.includes(key));
    const running=await output.start();
    assert.equal(running.active,true);
    assert.ok(fakeChild.args.includes('libx264'));
    assert.ok(fakeChild.args.at(-1).endsWith('/s/'+key));
    fakeChild.stderr.write('frame= 1 fps=25');
    await new Promise(resolve=>setImmediate(resolve));
    assert.match(output.publicStatus().status,/إرسال الفيديو/);
    await output.stop();
    assert.equal(output.publicStatus().active,false);
    assert.equal(output.publicStatus().enabled,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});
