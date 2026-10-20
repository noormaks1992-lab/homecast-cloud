# Helper player deployment

Target: existing private Dshoof installation on Botkeep.
Release: 3.5.0-helper-player.1.

## Behavior

The source form now has code, direct URL extraction, and helper player modes. Helper accepts an HTTPS URL or iframe snippet, including escaped markup. Plain pages are followed through at most three actual iframe levels; iframe strings in scripts are ignored. It is provider-neutral and falls back to the validated original page if server-side discovery fails.

Helper playback uses a same-origin authenticated wrapper around the external player. Source quality and buffering remain controlled by that player. This mode is website-only; M3U endpoints explicitly return 409. Source framing restrictions, login requirements, DRM, expiring keys, and source outages are not bypassed. Preview is owner-only and does not change the selected broadcast.

Each wrapper permits only its selected external origin through CSP, escapes its URL, and uses a sandbox without popups or top navigation. Existing persistent state, authentication, both channel identities and permanent playlist aliases remain unchanged.

## Checkpoint and rollback

Previous private remote checkpoint: 2587af9f74f41aa9c6a71cd4777b152fb79f48aa.
Local implementation checkpoint: b2c05e4.
Host pre-helper backups: server (copy 6).mjs; github-start (copy 2).mjs; public/app (copy 4).js; public/index (copy 3).html; public/style (copy 2).css. Additional current-state safety copy: data/state (copy 2).json.

Restore the prior runtime files and pinned launcher from that checkpoint if necessary. Do not replace state.json or restore old account data. The generic source snapshot launcher is not the deployed startup override; keep using the guarded pinned launcher from release/pinned-start-3.5.0.mjs.

## Validation

Full suite: 174 passed, two skipped; one old CSP expectation was updated to allow the authenticated same-origin wrapper. The corrected assertion plus ten source and live-player tests passed. Effective total: 175 passing, two skipped. Earlier targeted helper/entry/navigation/source run: 54 passing.

Production verified: /healthz returned status ok and release 3.5.0-helper-player.1. SHA-256 hashes for app.js, index.html and style.css match their deployed contents, including the 420px minimum preview height.

Both user-supplied input forms worked in owner preview. The supplied iframe loaded 1280x720 video. The plain sports page followed its nested iframe chain to the same player. The browser reported readyState 4 and paused false; currentTime advanced from 143.416569 to 165.580585. Existing broadcast selections were not changed by this verification. External source ads and controls remain part of the original player.

The prior direct ingest was not ready during the check and was retrying; helper preview success does not prove that older upstream source is healthy. No claim of universal source support or interruption-free playback is made.

Botkeep's first lifecycle action remained at Starting despite healthy HTTP service, leaving Restart disabled. After verifying the console and health and copying the current state, force stop reached Offline and Start relaunched the guarded application. This activated the final CSS/index changes. No full redeployment, key rotation, data restoration or state replacement was performed.

The final admin form screenshot is saved as helper-preview.png. The user was actively editing the admin form during the final UI check; their draft was left in place.
