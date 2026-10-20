# Dshoof production handoff — 20 October 2026

Production: `https://dshoof.bot-keep.xyz/`

Botkeep project: `83275da8-1731-45e5-a55e-91e3a564cf88`

Current pinned release: **3.5.0-live-player.3**. Runtime remains Node 22 with copy-only FFmpeg ingest, two independent channels, and the existing persistent data directory. No owner key, viewer key, member identity, permanent playlist alias, or source selection was replaced.

## Runtime files and startup

The application source is in `dshoof-player/app/`. `release/manifest.json` records the deployed file hashes. Production `github-start.mjs` is the guarded launcher in `release/pinned-start-3.5.0.mjs`, not the generic GitHub updater in the application source/snapshot. It validates the existing owner and playlist identity before importing the supervisor. Preserve this override when updating the existing installation.

The historical `release/install-3.5.0.mjs` installed the initial `.1` release; it is not the installer for the `.3` hotfix. Do not rerun it to deploy `.3`. The hotfix was applied to individual files through Botkeep and verified before restarting.

Restore point on the host: `data/restorepoints/3.5.0-live-player.1/`, including the original files, launcher, and pre-update state. Restoring runtime files does not require overwriting current member data with the older state backup. Keep all backups private.

## Changes in this hotfix

- Player controls overlay the video, disappear after three seconds during playback, and remain available while paused, using keyboard navigation, or changing settings.
- Quality, audio tracks, subtitles, equalizer, fit, sleep timer, and supported device controls are inside the player. Fullscreen preserves the entire viewport for video, with a contained-image default and optional crop-to-fill.
- Default live synchronization uses three source segments; the stability option uses five. A larger permitted buffer and modest catch-up rate reduce repeated jumps toward an empty live edge. This is not video compression and cannot compensate for bandwidth permanently below the source bitrate.
- Manual rewind suspends forced live catch-up until the viewer chooses Live. Live resumes paused playback and the loader.
- Early upstream response errors have an immediate listener. Async ingest requests are awaited inside the HTTP error boundary: DNS failures, timeouts, and aborts return a controlled upstream error instead of escaping and crashing both channels.

## Verification and limits

The initial suite passed 166 tests with two platform skips. Subsequent navigation/entry checks passed 47 tests; the final targeted source/security/live/DVR/dual-stream run passed 10 tests, including real FFmpeg decoding of distinct channels and preserved identities. Published UI files matched local SHA-256 hashes. Fullscreen video bounds matched the browser viewport, settings stayed inside it, and auto-hide was observed.

Responsive CSS includes touch-sized controls, compact mobile layout, and no fixed-width player content. The connected browser did not apply its requested mobile viewport override, so a real mobile visual check remains outstanding. Do not describe that check as completed.

Upstream sources can still expire, reject requests, or stall. Extractors support bounded public pages and embeds, not arbitrary DRM or login-protected sites. Optional device diagnostics remain consensual. IP bans require a verified client IP and correct trusted-proxy configuration; never ban the hosting proxy as a viewer IP.
