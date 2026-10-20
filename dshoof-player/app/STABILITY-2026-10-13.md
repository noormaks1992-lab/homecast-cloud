# Dshoof beta 15 verification — 2026-10-13

## Changes
- Bundled Linux FFmpeg receives an isolated GCONV_PATH in its child environment. The host SIGSEGV is confirmed; the proposed gconv cause and fix still require verification with the hosting binary.
- A failed recovery for an obsolete selection cannot overwrite the status or failure count of a newly selected source, or schedule another retry after stop/shutdown.
- Retains fresh-manifest checks, stable M3U URLs, selected Majed server persistence, the 1080 cap and stream copying.
- Updates two obsolete tests for removed prediction and embedded-page functionality.

## Evidence
- node --test: 35 passed, 0 failed, 0 skipped.
- The stale recovery regression failed before the server change with an old 403 replacing the new source status; passed after.
- Integration tests use real local system FFmpeg and synthetic media with controlled provider fixtures. They verify audio/video remux, code/direct URL playback, source switching, restart persistence, stable playlists, quality routes and invitation revocation.
- No claim that synthetic tests validate the current external provider or the hosting static FFmpeg binary.

## Deployment status
- Saved to GitHub; NOT applied to Botkeep.
- Hosting access is blocked by the browser runtime's credential-state resume error.
- Host was last observed on beta 13 with repeated SIGSEGV ingest exits.
- To deploy this change, server.mjs AND ffmpeg-runtime.mjs must be installed together, retaining data/, .env and all hosting settings, followed by restart.
- After deployment verify [ffmpeg-runtime] linuxGconvIsolation:true, successful ingest, advancing media sequence, and decoded audio/video. Observe beyond the prior 1–2 minute failure window.
- Provider availability, token expiry and hosting interruptions cannot be guaranteed by this update.
