# Noor Player — reviewed application source

Live cloud site: https://noor-stream-player.tendertulip8.chatgpt.site

Fixed M3U: https://noor-stream-player.tendertulip8.chatgpt.site/playlist.m3u

This folder contains the reviewed application source, API routes, schema and migration, without credentials, deployment identity, owner identity hash, runtime data or generated bundles. It runs in a Sites Vinext starter with a Cloudflare D1 binding named DB. Restore the owner email hash in lib/tv-owner.ts for a separate deployment. Supply Hls.js at public/hls.min.js. The currently deployed site is already configured. GitHub stores source; Sites runs the server. GitHub Pages alone cannot run these API routes.

To operate: sign in as owner, enter a valid provider code, keep automatic TV update enabled and press Play. Import the fixed M3U once. Reopen the channel if your receiver does not automatically refresh. HTTPS/HLS compatibility is required. Codes and upstream sources may expire. No absolute uptime guarantee.

Run `python restore-source.py` to unpack the reviewed text snapshot into the source directory. This is the application layer, not a standalone copy of Sites infrastructure.
