# Manual classic restore candidate (2026-10-20)

This branch has NOT been deployed or tested on Botkeep. It starts from commit 09085c121aae43f0e3b4e15baae1575f178591a2, preserves both channels and other existing features, and reverts the in-browser player to the native video with outside controls. The extra helper iframe/player is disabled, not supported as a playback mode. Previously stored helper source choices are not deleted; the owner must choose an HLS URL or code manually if either channel had a helper source.

## Files to replace under the existing dshoof-player application root

- `dshoof-player/app/public/app.js` => `public/app.js`
- `dshoof-player/app/public/index.html` => `public/index.html`
- `dshoof-player/app/public/style.css` => `public/style.css`
- `dshoof-player/app/server.mjs` => `server.mjs`
- `dshoof-player/release/pinned-start-classic-restore.mjs` => `github-start.mjs` **only if the running startup file is the previously installed guarded pinned launcher**.

HLS settings from before 20 October restored: nominal 4-second segments, playlist length 24, delete threshold 2, shared segment-cache RAM 32MiB, 300-second stale-media cleanup, and browser HLS balanced/stable/close presets. The two media directories are preserved. Helper URL/iframe player routes now return 410.

**Do not touch** `data/`, `media/`, `media-2/`, `.env`, `node_modules/`, permanent M3U URLs, owner/viewer credentials, or channel identities. Make backups of the original five runtime files and data before changing anything. Stop the complete Botkeep service, replace the files only, and restart the service yourself after verifying file paths. The service preloads public assets at startup; merely copying files does not activate them. After starting, verify `/healthz` and each channel's real video playback, the old player controls, M3U links, and buffer behavior. Performance improvements are unverified until real host playback.
