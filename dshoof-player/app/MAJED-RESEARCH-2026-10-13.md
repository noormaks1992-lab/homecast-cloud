# Majed extraction investigation — beta 16

## Observed failure
The user screenshot says the match page was read but sources cannot be prepared. This is before FFmpeg ingest, and is distinct from the earlier confirmed SIGSEGV. The previous automatic resolver swallowed individual player errors and guessed that the response might be an HTML page. The screenshot alone cannot identify the underlying provider failure.

## Implemented and verified
- Automatic resolution now reports a bounded, safe cause for each attempted player: HTTP rejection, DNS, timeout, missing authorization, incompatible data or media, or a generic diagnostic failure. It does not echo raw exceptions containing provider URLs/tokens.
- Explicit player selection continues to fail explicitly; no hidden server switch.
- Static player metadata extraction accepts spacing around equals, attribute order, casing of HTML attribute names, and unquoted values. It matches name rather than data-name and ignores commented/script examples.
- The regression with valid whitespace failed before this change and passed afterward.
- Existing authorization integrity checks, DRM rejection, public-address validation and media header isolation remain.
- Full node --test: 39 passed, zero failed or skipped. Fixtures and local real system FFmpeg are used; this is not proof of live Majed access.

## Research and decisions
- Streamlink uses provider-specific plugin matchers and stream extraction, rather than a universal extractor: https://streamlink.github.io/developing.html
- Brightcove plugin illustrates player context, API lookup and validated HLS/MP4 sources: https://github.com/streamlink/streamlink/blob/master/src/streamlink/plugins/brightcove.py
- yt-dlp has a generic extractor, but generic extraction does not establish compatibility with Majed's current player: https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/generic.py
- FFmpeg supports bounded reconnect options, but these do not repair an unavailable source URL or a native SIGSEGV: https://ffmpeg.org/ffmpeg-protocols.html
- MediaMTX proxies configured sources; installing it alone does not resolve this provider's page-to-stream handshake: https://mediamtx.org/docs/features/proxy
- HLS playlist and segment behavior: https://www.rfc-editor.org/info/rfc8216/
- HTML attribute syntax permits the forms covered by our regression: https://html.spec.whatwg.org/multipage/syntax.html#attributes-2
- Searches did not locate a verified ready-made Majed plugin. No third-party source code was copied or dependency added.

## Limits / next verification
- Direct testing here failed DNS resolution (EAI_AGAIN); web retrieval of the supplied watch-card and player endpoints was unavailable.
- Botkeep browser access still fails before navigation because native credential state cannot safely resume.
- This release is saved to GitHub, not deployed by this session. The HTML parsing bug is proven in fixtures, but is not confirmed as the cause of the user's current live source failure.
- Deploy beta 16 sources.mjs together with beta 15 server.mjs and ffmpeg-runtime.mjs. Retain data/, .env and hosting settings. Restart and inspect the actual player failure/ingest diagnostics and decoded audio/video before marking resolved.
