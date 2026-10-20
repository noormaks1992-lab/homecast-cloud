/* Cache only the public offline shell and its small stylesheet. Never cache invitations, API or video. */
const CACHE='dshoof-shell-club7';
const ASSETS=['/offline.html','/club-mark.svg','/style.css?v=club7','/club-pages.css?v=club7','/club-icons.svg'];
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('dshoof-shell-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(url.origin!==location.origin||event.request.method!=='GET')return;
 if(event.request.mode==='navigate'){
  event.respondWith(fetch(event.request).catch(()=>caches.match('/offline.html')));
  return;
 }
 if(ASSETS.includes(url.pathname+url.search))event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));
});
