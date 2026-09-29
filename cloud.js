'use strict';
const $ = id => document.getElementById(id);
let csrf = '', links = null, authenticated = false, busy = false, refreshTimer, messageTimer;
function message(text, error = false) {
  $('message').textContent = text; $('message').classList.toggle('error', error); $('message').hidden = false;
  clearTimeout(messageTimer); messageTimer = setTimeout(() => {$('message').hidden = true;}, error ? 12000 : 6000);
}
async function request(url, data, method) {
  const headers = {'X-CSRF-Token': csrf};
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {method: method || (data === undefined ? 'GET' : 'POST'), headers, body: data === undefined ? undefined : JSON.stringify(data), credentials: 'same-origin'});
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login') showLogin();
    throw Error(result.error || 'تعذر الاتصال');
  }
  return result;
}
function showLogin() {
  authenticated = false; csrf = ''; links = null; clearTimeout(refreshTimer);
  $('dashboard').hidden = true; $('login').hidden = false;
  for (const id of ['hlsLink','tsLink','serverBase','streamKey']) $(id).value = '';
}
async function refresh(initial = false) {
  clearTimeout(refreshTimer);
  if (!authenticated) return;
  try {
    const status = await request('/api/status');
    $('sourceLabel').textContent = status.changing ? 'يجري تجهيز المصدر…' : status.source.label;
    $('stateLight').classList.toggle('offline', !!status.sourceError);
    $('statusDetail').textContent = status.sourceError || (status.workers.length ? status.workers.some(w => w.ready) ? 'البث جاهز للمشاهدة' : 'يجري تحضير البث' : 'جاهز — يبدأ تحويل الفيديو عند فتح القناة');
    $('workers').textContent = status.workers.length ? status.workers.map(w => `${w.quality}p · ${w.running ? 'قيد العمل' : 'إعادة اتصال'} · ${w.fps || 0} إطار/ث · سرعة ${w.speed || 0}x${w.error ? '\n' + w.error : ''}`).join('\n\n') : 'لا توجد مشاهدة نشطة بعد.';
    if (initial) for (const name of ['fpsMode','outputMode','singleQuality']) $(name).value = status.settings[name];
  } catch (error) {$('statusDetail').textContent = error.message; $('stateLight').classList.add('offline');}
  if (authenticated) refreshTimer = setTimeout(refresh, 5000);
}
async function openDashboard() {
  const session = await request('/api/session'); csrf = session.csrf;
  links = await request('/api/links'); authenticated = true;
  $('hlsLink').value = links.hls; $('tsLink').value = links.ts; $('streamKey').value = links.streamKey; $('serverBase').value = session.base;
  $('login').hidden = true; $('dashboard').hidden = false;
  await refresh(true);
}
async function action(fn) {
  if (busy) return; busy = true;
  const buttons = [...document.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
  try {await fn();} catch (error) {message(error.message, true);} finally {busy = false; buttons.forEach(b => b.disabled = false);}
}
$('loginForm').addEventListener('submit', event => {event.preventDefault(); action(async () => {
  await request('/api/login', {token: $('token').value.trim()}); $('token').value = ''; await openDashboard();
});});
$('logout').addEventListener('click', () => action(async () => {await request('/api/logout', {}); showLogin();}));
$('sourceForm').addEventListener('submit', event => {event.preventDefault(); action(async () => {
  message('يجري فحص الرابط واستخراج الفيديو…');
  await request('/api/source', {mode: 'url', value: $('sourceUrl').value.trim()});
  message('تم اختيار المصدر. افتح قناة الرسيفر لبدء المشاهدة.'); await refresh();
});});
$('testSource').addEventListener('click', () => action(async () => {await request('/api/stop', {}); message('تم تشغيل شاشة الاختبار'); await refresh();}));
$('settingsForm').addEventListener('submit', event => {event.preventDefault(); action(async () => {
  await request('/api/settings', {fpsMode: $('fpsMode').value, outputMode: $('outputMode').value, singleQuality: $('singleQuality').value});
  message('تم حفظ إعدادات القناة'); await refresh();
});});
$('upload').addEventListener('click', () => action(async () => {
  const file = $('videoFile').files[0];
  if (!file) throw Error('اختر ملف فيديو أولًا');
  if (file.size > 512 * 1024 * 1024) throw Error('الحد الأعلى للملف 512 ميغابايت');
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/upload'); xhr.setRequestHeader('X-CSRF-Token', csrf); xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.timeout = 600000;
    xhr.upload.onprogress = e => {$('uploadStatus').textContent = e.lengthComputable ? `يجري رفع الفيديو: ${Math.round(e.loaded / e.total * 100)}%` : 'يجري رفع الفيديو…';};
    xhr.onerror = () => reject(Error('انقطع الاتصال أثناء رفع الفيديو'));
    xhr.ontimeout = () => reject(Error('انتهت مهلة الرفع. جرّب ملفًا أصغر أو اتصالًا أسرع.'));
    xhr.onload = () => {
      if (xhr.status === 401) showLogin();
      if (xhr.status === 200) return resolve();
      try {reject(Error(JSON.parse(xhr.responseText).error));} catch {reject(Error('تعذّر رفع الفيديو'));}
    };
    xhr.send(file);
  });
  $('uploadStatus').textContent = 'اكتمل الرفع وأصبح الفيديو مصدر القناة.'; $('videoFile').value = ''; await refresh();
}));
$('copyLink').addEventListener('click', () => action(async () => {await navigator.clipboard.writeText(links.hls); message('تم نسخ رابط القناة');}));
$('checkStream').addEventListener('click', () => action(async () => {
  $('streamCheck').textContent = 'يجري تحضير القناة وفحص قائمة البث…';
  const response = await fetch(links.hls); const manifest = await response.text();
  if (!response.ok || !manifest.includes('#EXTINF:')) throw Error('البث لم يصبح جاهزًا. راجع المصدر وحالة المعالجة ثم حاول مجددًا.');
  const segment = manifest.split(/\r?\n/).find(line => line && !line.startsWith('#'));
  const media = await fetch(new URL(segment, links.hls), {method: 'HEAD'});
  if (!media.ok) throw Error('القائمة متاحة لكن مقطع الفيديو لا يستجيب');
  $('streamCheck').textContent = 'تم التحقق: قائمة البث ومقطع الفيديو متاحان. اختبر المشاهدة على الرسيفر أيضًا.'; await refresh();
}));
openDashboard().catch(() => showLogin());
