## بث قناة دشوف إلى Telegram عبر RTMP

من لوحة الإدارة افتح **إدارة القناة**، ألصق **Server URL** و**Stream Key** من نافذة Telegram «البث باستخدام تطبيقات أخرى»، ثم احفظ الإعدادات وابدأ الإرسال بعد تشغيل مصدر فيديو مباشر. يعمل كل بث Telegram على القناة المحددة فقط، ولا يحتاج إلى بوت. يدعم العناوين الرسمية `rtmp.t.me` و`*.rtmp.t.me` عبر RTMP أو RTMPS. يخزّن الخادم المفتاح ولا يعيده إلى المتصفح؛ تبقى النسخ الاحتياطية الخاصة محتوية عليه، لذلك لا تشاركها. ينتهي الإرسال عند إيقاف القناة أو تغيير مصدرها.

# دشوف3.3 — CLUBHOUSE

إعادة بناء هيكل الواجهة: مساحة مشاهدة مصوّرة، مشغّل ودردشة، تنقل جانبي للحاسوب وسفلي للهاتف، إعدادات تشغيل في نافذة واحدة، وإدارة بتبويبات مستقلة. صور ورموز وخط مستضافة محليًا، مع حفظ البيانات والمفاتيح والروابط وآلية البث المستقلة.

# دشوف 3.2 — رابط واحد وتجربة قابلة للتخصيص

الانضمام العام من `/` باسم مستخدم واسم عرض مرة واحدة في هذا المتصفح. المشاركة تستخدم رابط الموقع فقط؛ بيانات الإدارة وروابط الرسيفر القديمة لا تتغير. لا تستعد عضوية باستخدام اسم المستخدم وحده بعد فقد كوكي الجلسة؛ لا توجد كلمة مرور أو آلية إثبات ملكية لذلك في هذه النسخة.

قائمة بثلاث شرطات وتخصيص المظهر والألوان وحجم النص والكثافة والحركة، مع دعوة اختيارية لكروب دشوف. تُحدّث الدردشة عبر SSE مع تحديث دوري احتياطي، وفتحها وإغلاقها للمالك فقط. أُزيلت المحادثة الصوتية بالكامل؛ يبقى صوت الفيديو.

قائمة المشاهدين وتفاصيل الجهاز والبطارية والشبكة والموقع الاختياري وإحصاءات المشاهدة لا تظهر إلا للمالك. معلومات الجهاز والموقع لا تُحفظ في قاعدة البيانات، ويمكن إيقاف مشاركتها فورًا. لا يُطلب GPS تلقائيًا، ولا تُحمّل خريطة خارجية تلقائيًا. تقدير سرعة الشبكة من المتصفح لا يعادل اختبار سرعة أو كشف اشتراك الإنترنت. عنوان الاتصال قد يكون بروكسي Botkeep، فلا تضبط `TRUST_PROXY_HOPS` إلا بعد التحقق من مسار الاستضافة.

تعتمد مدد المشاهدة على تقارير المشغّل وتُعرض كتقديرات، وتُحفظ مجمعة دون IP أو موقع. يلزم الحفاظ على مجلد البيانات للعضويات والإحصاءات والمفاتيح القديمة. الأدلة النهائية وحدود النشر في `../UPGRADE-2026-10-18.md` و`../release/validation.json`.

---

# دشوف 3.1 — صيانة البث والاتصال الضعيف

التشغيل المحلي: Node.js 22+ وFFmpeg يدعم H.264/AAC. نفّذ `npm ci` ثم `npm run start:local`. مع FFmpeg النظام يمكن تثبيت الحزم بـ `npm ci --ignore-scripts` وتعيين `FFMPEG_PATH=/usr/bin/ffmpeg`. أمر `npm start` يشغّل محدث GitHub؛ استخدم الأمر المحلي عند تطوير نسخة لم تُنشر بعد.

- بيانات التطبيق والمالك والدعوات والروابط الدائمة في `DATA_DIR` (الافتراضي `data/`). لا تحذفها ولا تضفها إلى Git أو حزمة التحديث.
- البث الأصلي يبقى بنسخ `-c copy` ونافذته السابقة؛ الضعيف والطوارئ مشتقان من المصدر المحلي مرة واحدة لكل مسار، مع حدود بيانات تتكيف مع حجم المصدر.
- يبدأ الضغط من آخر 20 مقطعًا متاحًا بأسرع ما يسمح به المعالج؛ يبدأ المشاهد بعد أول مقطع ومخزون قصير، دون انتظار 30 أو 96 ثانية. مخزون التنزيل الأمامي محدود حتى لا ينزّل تاريخًا كبيرًا أو مسارًا أصليًا خفيًا في الوضع الضعيف.
- يعرض التشخيص معدل MPEG-TS المقاس. هذه الأرقام تشمل الصوت وتغليف TS، ولا تشمل كل HTTP/TLS أو الصوت الجماعي الاختياري.
- جلسة الإدارة موقعة وصالحة 12 ساعة وتُلغى عند الخروج أو إعادة تشغيل الخادم. رابط الإدارة المحفوظ في `data/owner-link.txt` ومفاتيح المالك والمشاهدة لا تتغير؛ افتح رابط الإدارة المحفوظ بعد Restart.
- اختبارات المصادر تمنع SSRF وتثبت عنوان IPv4 عامًا لكل قفزة. تبقى المصادر ذات منافذ 80/443 وحدود البروتوكولات السابقة؛ DRM وتسجيل الدخول للمزوّد ليسا مدعومين.

التحقق: `FFMPEG_PATH=/usr/bin/ffmpeg npm test`. الاختبارات تستخدم مصادر محلية مضبوطة ولا تحتاج كلمات مرور حقيقية. `npm run test:soak` فحص تحمل يدوي مستقل؛ لا يُشغّل ضمن الاختبارات المعتادة.

مصدر التطوير المقروء هو هذا المجلد. لتوليد نسخة التحديث المحددة وبصماتها شغّل `node ../tools/release.mjs`. لا ترفع ملفات JS دون HTML وCSS المتوافقة معها. لا تستبدل نسخة Botkeep قبل تنزيل ملفاتها الحالية وحفظ نقطة رجوع خاصة ومقارنة بصمات الملفات المتغيرة. حزمة الإصدار لا تحتوي `data/` أو `.env`.

الملاحظات التاريخية أدناه تصف الإصدارات السابقة؛ بيان الإصدار الجديد ونتائج فحوصه في `../UPGRADE-2026-10-18.md` هما المرجع الحالي.

---

# دشوف بلاير

Portable Node.js 22 application for Botkeep. Start: `npm install && npm start`. Bind: `0.0.0.0`, `SERVER_PORT` (or `PORT`, default 3000).

Node supervisor restarts the application after a crash with bounded backoff. A single FFmpeg process remuxes the selected source into a rolling HLS playlist. Source switching appends a discontinuity and new segment sequence values; device-specific behavior still needs playback validation. No transcoding is performed, so source codec compatibility matters.

Data lives in `data/` and MUST survive redeploys. Back up this directory privately. Never publish it or include it in source archives. `data/owner-link.txt` contains the private administrator access fragment; append it to the website origin in your own browser. Do not share it. Owner login uses an HttpOnly same-site cookie. The permanent personal playlist is `/dshoof.m3u?key=…` and is shown only in the owner UI.

Friend invitations default to 24 hours, maximum 30 days. Up to 50 nonexpired invites and 3 concurrent friend devices by default (owner configurable to 10). Device limits use browser device cookies with IP/user-agent fallback, and a 30-second lease; they are not verified identities. Invitations are revocable. They are bearer links, not verified identities. Do not put any invitation or owner key into GitHub.

Optional configuration: `DATA_DIR`, `PUBLIC_URL` (canonical HTTPS origin), `FFMPEG_PATH`. Runtime uses npm `ffmpeg-static` 5.3.0 or an installed FFmpeg. No hosting passwords are required in application configuration. FFmpeg exits retry after 30 seconds. Provider expiry cannot be extended by this application.

Operational limits: source must allow the hosting server IP, CPU/bandwidth remain subject to hosting capacity, and there is no 100% uptime guarantee. Permanent link requires retaining hostname and data. Backups and a domain you control improve portability. An idle source error is surfaced, not hidden behind success. Health endpoint checks process and playlist freshness, not decoded audiovisual correctness.

The original site is preserved during migration. This distribution is independent of ChatGPT authentication and hosting. Public page, player branding, playlist name and downloaded file are all Dshoof / دشوف.

## Version 1.1 — shared source selection
Owner can select a provider code, direct public HTTP(S) video URL (MP4/HLS and other FFmpeg-readable containers with supported codecs), or a YouTube watch/short/live link. All direct sources feed the same stable personal M3U and friend watch page. File playback is read at real-time speed and is not looped after normal EOF. Source format and codec compatibility still apply.

YouTube uses the official privacy-enhanced embedded player in the shared watch page. It is NOT extracted or converted to M3U: the HLS endpoint responds with an explicit 409 message while a YouTube selection is active. Viewers share the video selection, not synchronized playback time. YouTube may disallow embedding or restrict a video.

Direct input is validated and every HTTP hop is pinned to a checked public IPv4 address. Local/private addresses, nonstandard ports, URL passwords, unsupported protocols and HTML pages are rejected. Nested HLS URLs and keys are rewritten through the same checked input path. IPv6-only origins are currently unsupported. No provider login/cookie entry or DRM support is added.

Update: Stop the app, replace the supplied code files, and retain data/, .env, hosting settings and your domain. Upload public/ contents inside public/, not at root. Start the app again. Existing owner key, personal playlist and friend invitations are retained. There is no need to regenerate links.

Tests: node --test test.mjs source-test.mjs. Direct-media integration uses a synthetic video and a controlled mock of the public upstream, verifies actual FFmpeg MPEG-TS output, verifies that a YouTube switch retains the permanent playlist URL, and preserves existing owner/viewer keys. Actual external URL availability and receiver behavior require deployment validation.

## الإصدار 2.0

- هوية بنفسجية وذهبية متجاوبة، دردشة اختيارية وكتم وحذف ووضع بطيء، إعجاب وأحببته وقلب، تصويت وإعلان مثبت ورسائل مخفية للحرق.
- روابط مختصرة لكل مشاهد مع مدة صلاحية وحد أجهزة وإلغاء، ورابط M3U شخصي مختصر ثابت مع استمرار صلاحية الرابط القديم.
- تشغيل مباشر على الخادم مستقل عن صفحة المتصفح. إيقاف البث للجميع محفوظ بعد إعادة التشغيل، وزر لاستئناف المصدر.
- مراقبة وصول المقاطع كل 15 ثانية؛ عند عدم تقدمها لأكثر من 60 ثانية يعاد تشغيل جلب المصدر. عند فشل المصدر تعاد المحاولة بعد 30 ثانية. مشرف Node يعيد تشغيل التطبيق بعد تعطل العملية طالما الحاوية تعمل.
- حفظ المصدر تلقائيًا في data/state.json واستعادته عند تشغيل الخادم، إلا إذا أوقفه المالك. إذا توقفت الاستضافة نفسها يلزم تشغيلها من لوحة الاستضافة؛ لا يمكن لهذا البرنامج ضمان استمرارية مزود الاستضافة أو تجديد رابط انتهت صلاحيته دون دعم المزوّد.
- وضع سينما، عودة للمباشر، مخزون تشغيل قابل للضبط، مؤقت محلي، إشعار المضيف بالتقطيع، معلومات المخزون والدقة. نافذة عائمة وإبقاء الشاشة مضاءة واختيار شاشة خارجية حسب إمكانات المتصفح؛ ليست هذه ضمانًا لدعم Chromecast على كل جهاز.
- تشغيل الفيديو المباشر يستمر إذا أغلق المالك الموقع أو جهازه. المصدر ملف فيديو ينتهي عند نهاية الملف ولا يكرر نفسه. يوتيوب يبقى مشغّلًا مضمنًا في الموقع فقط وليس قناة M3U.

### التحديث
استبدل ملفات الشفرة المقدمة وملفات public ثم أعد تشغيل التطبيق. لا تحذف data أو .env أو إعدادات الاستضافة. احتفظ بملف public/hls.min.js الموجود إن استخدمت أرشيف التحديث. استخدم Node 22 أو أحدث وأمر npm install && npm start. الإصدار الجديد يظهر 2.0.0 في /healthz. يمكن حفظ نسخة إعدادات خاصة من لوحة المالك؛ تحوي مفاتيح الدخول فلا تشاركها.

### التحقق
npm test: اختبارات وصول المالك وصلاحيات الضيوف وحد الأجهزة والإلغاء، الدردشة والتصويت والتفاعلات، منع المصادر المحلية، إنتاج MPEG-TS فعليًا من فيديو تجريبي عبر FFmpeg، تقدم المقاطع دون أي صفحة متصلة، حفظ الإيقاف بعد إعادة تشغيل الخادم وثبات رابط M3U. الاختبارات لا تثبت توافق كل رسيفر أو مصدر ولا انعدام التقطيع؛ يلزم اختبار جهازك ومصدر الفيديو الفعلي.

المصادر التصميمية: وثائق YouTube Live Chat، Twitch moderation، MDN Picture-in-Picture وScreen Wake Lock، وواجهة إعدادات hls.js. جميع النصوص المشاركة تعرض كـtextContent لمنع حقن HTML، وتبقى مفاتيح الإدارة على الخادم وفي كوكي HttpOnly.

## الإصدار 2.1 — الدقات

يفحص التطبيق قوائم HLS الرئيسية ويعرض دقاتها الفعلية، مثل 480p و720p و1080p، دون تحويل أو اختلاق دقات غير موجودة. «تلقائي» يمرر الدقات الأصلية للمشغل ليختار وفق الاتصال؛ في Safari الاختيار التلقائي من مشغل النظام. الدقة الثابتة تنتج قائمة تحتوي المسار المحدد مع مجموعات الصوت الأصلية. أعلى جودة تستخدم اختيار FFmpeg التلقائي لأعلى دقة فيديو، بدل إجباره على أول مسار.

لوحة المالك تعرض روابط ثابتة مقروءة `/p/<key>/480p.m3u` و`720p.m3u` و`1080p.m3u` إذا توفرت، إضافة إلى `auto.m3u` و`highest.m3u` و`all.m3u`. الملف الجامع يحمل اسم القناة والدقة في كل سطر EXTINF. بقاء العنوان ثابتًا يتطلب الاحتفاظ بالدومين وdata. ملف M3U الذي تم تنزيله لقطة للدقات المتاحة وقت تنزيله؛ يمكن تنزيله مجددًا إذا تغيّر المصدر. بعض المشغلات الخارجية تحتاج إعادة فتح المسار التكيفي بعد تغيير مصدره.

روابط المقاطع والدقات تتحقق من صلاحية المشاهد في كل طلب. عناوين المصدر تبقى على الخادم، وتمريرها يخضع لحماية DNS/SSRF نفسها. اختيار دقة غير موجودة يرجع خطأ واضحًا ولا يعرض دقة أخرى باسم مضلل. مصدر MP4 أو HLS أحادي الدقة يبقى بدقته الأصلية؛ إنشاء دقات إضافية منه يحتاج خدمة تحويل فيديو أو موارد CPU/GPU مناسبة. هذا الإصدار لا يشغل ثلاثة محولات على الاستضافة المحدودة ولا يضمن توافق codecs على كل رسيفر. يوتيوب يستخدم خيارات مشغله الرسمي ولا يدخل ملفات M3U.

الاختبارات الإضافية تتحقق من قوائم 480/720/1080 والصوت المنفصل والقائمة الجامعة وعناوين الدقات والحماية والإيقاف. هذه تستخدم قوائم HLS تجريبية مضبوطة وليست تأكيدًا لدقات مصدر المستخدم الحالي.

## الإصدار 3.0
راجع FEATURES-3.md للحالة الفعلية لكل مطلب، إعداد API، وحدود الاستضافة. أعلى جودة الآن مقيدة بـ1080p مع فحص معلومات الفيديو قبل تشغيل مسار النسخ؛ لا يوجد تحويل متعدد الدقات. واجهة واضحة، أسماء وتفاعلات فريدة وتصويت علني محفوظ، مركز مباراة وخدمات اختيارية، جدولة ودليل XMLTV وإعادة قصيرة ومزامنة وريموت وغرفة صوت تجريبية. npm test يشمل 11 حالة تحقق.

استعادة source.snapshot.json: الكائن files يحوي الملفات النصية UTF-8، وbase64Files يحوي الأيقونات الثنائية بترميز Base64؛ فكها إلى الأسماء نفسها. لا يحتوي الأرشيف على بيانات خاصة أو مفاتيح أو hls.min.js؛ احتفظ بنسخة vendor الموجودة.


## واجهة بيتا 2
حُذفت الإحصاءات والتشكيلات واختيار المباراة والتوقعات المرتبطة بالنتائج والتحليل بالذكاء الاصطناعي وإعدادات مفاتيحها. لا يستدعي الخادم مزود إحصاءات أو خدمة ذكاء اصطناعي. تبقى الدردشة والتصويت والتفاعلات وغرفة الصوت وأدوات الفيديو والبث والجدولة. وصف هذه الميزات المحذوفة في الوثائق الأقدم تاريخي ولم يعد ينطبق.

## بيتا 3 — تحسين التحمل
مناسب للموارد المؤكدة: 2048MB ذاكرة و150% CPU و2048MB تخزين. تخزين مؤقت مشترك للمقاطع المحلية فقط بسقف 64MiB، وحد للمقطع 8MiB وأربع قراءات متزامنة، وصلاحية 30 ثانية. يدمج طلبات نفس المقطع. تبقى المصادقة وفحص وجود الملف قبل قراءة الكاش، ولا تُخزّن قوائم البث المتغيرة. سقف أجهزة الأصدقاء القابل للضبط 30 مع إبقاء القيمة الحالية؛ هذا حد برمجي وليس ضمان تحمل الشبكة. حد 1080p ونسخ الفيديو دون تحويل لم يتغيرا.
