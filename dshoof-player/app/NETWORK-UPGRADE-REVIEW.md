# Dshoof: separate fast and weak network paths

Status: tested local candidate, NOT deployed to Botkeep. The authenticated browser could not safely resume its credential session. The latest live server and its data have not been downloaded or backed up. Do not replace the live installation wholesale with this older local baseline.

## Behavior

- The existing `/live/dshoof.m3u8` and default permanent M3U remain the original stream with `-c copy`. Source resolutions and source quality URLs remain uncompressed.
- Viewer connection selector: “النت السريع — السيرفرات الأسرع” or “النت الضعيف”. The name does not claim that an alternate faster source has been measured or selected.
- `/weak/dshoof.m3u8` is separately encoded from the local primary ingest, avoiding another upstream source connection. There is one shared weak encoder, not one per viewer. Original and weak video are available simultaneously.
- Owner controls start at 720p/25fps, ~1000k video +64k audio; 480p/25fps ~500k+48k; 360p/20fps ~280k+40k. Actual transport overhead varies. No upscaling of smaller sources. Source quality URLs may themselves have inaccurate upstream labels; transcoding verifies the resulting dimensions.
- Slow encoding (<0.85x over a 30s observation) falls to the next lower weak profile, then pauses/retries if the lowest cannot keep up. It never changes the primary encoder to transcoding. Two codec threads and one filter thread limit parallel work, not an absolute CPU quota.
- Weak encoding starts on authorized demand, stops after 120s without requests, has capped retry backoff and stalled-output recovery. Stop/source change shuts down weak encoding too.
- Weak server TS memory cache: 64MiB, 180s TTL, max 4MiB per cached item, 4 pending loads. Fast TS cache: 32MiB, 30s TTL, default 8MiB item bound. These are cache budgets, NOT whole-process RAM limits.
- Weak HLS window: 45 x ~4s segments (~180s once filled), plus 8 deletion-threshold segments. Weak browser forward buffer target 120s (max150s/48MiB), starts around 40s behind the live edge when the window allows. Capacity is not a promise that the buffer fills to 120s. Fast default forward target40s, unchanged live-sync distance4 segments; browser buffer ceiling64MiB. Primary HLS window remains24 segments as before.
- Weak disk cleanup removes orphan segments older than300s. Original source retains its existing cleanup. Low bitrate makes the weak disk window modest; do not enlarge without checking disk capacity.
- Quality manifests coalesce concurrent requests and cache for half TARGETDURATION. Up to40 manifests and8 in-flight manifest loads. HTTP429 honors Retry-After; absent header gets exponential delay up to30s. This applies to quality-manifest requests, not every upstream request in the project.
- Fixed-quality filters select exactly one variant by declaration identity, retain the chosen height through nested masters, and maintain authenticated opaque media URLs. A false source resolution declaration cannot manufacture pixels of that quality.
- Cache is behind existing access control; stop/revocation checks run before serving bytes. No public caching of authenticated streams.
- Numeric codes accept1–32 digits, including617106. The integration provider is a synthetic fixture: this does not prove that code617106 is still valid on the real provider.
- Controls sit beneath the player. Additional voice/shortcut tools follow playback controls. Removed a reference to the deleted `.hero-seal` element that could abort the design script; removed visible beta wording in the candidate. Official live release remains pending deployment validation.

## Evidence and remaining gates

Run `npm run test:stream` from the candidate directory. Real FFmpeg tests decode distinct480/720/1080 outputs, prove the separate weak path is720 while primary is1080, and compare original segment bytes exactly. Tests include auth, unchanged permanent links, stop behavior, profile switching, concurrent viewers, cache timing,429 cooldown, source recovery and decoder isolation.

`soak-test.mjs` exercises the720 encoder with synthetic1080 input for900 real seconds in the local container, records playlist freshness and disk use, and deletes its temporary media. This standalone endurance test retains24 segments, whereas the final weak service retains45. It is not a Botkeep capacity test. RSS may be unavailable in this container (null); do not interpret that as zero RAM.

Before live deployment:
1. Retrieve the current Botkeep files and create a real restore point preserving data, owner/viewer keys and permanent aliases.
2. Compare/merge the review bundle against those current files. Its before/after hashes and contents are supplied for this purpose. Never blindly overwrite a newer source.
3. Preserve all existing runtime assets, including hls.min.js, branding, optional modules and environment. The review bundle is intentionally NOT an auto-update release snapshot.
4. Validate FFmpeg/libx264 and measure CPU/RAM with the real match on Botkeep; test constrained clients. Local transcoding success cannot establish hosting capacity.
5. Test the live UI, fast and weak paths, source changes, calls/chat and rollback. Only then publish the first official release.

No new paid services, public repository access, tokens, or data migrations are introduced.

Validation update: the final streaming suite passed39 tests, followed by2 isolation/shutdown/watchdog tests after the last lifecycle changes. HTML IDs, control order and numeric-code pattern were checked locally. A browser visual check was unavailable because the native credential session was blocked.

Endurance completed:900s local720p run passed; an additional240s run with the final45-segment window and8-segment delete threshold passed. At210s,52 segments occupied29,115,372 bytes; FFmpeg exited0 with no stderr in both runs. These are synthetic local measurements, not hosting capacity guarantees.
