#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then printf '%s\n' '.env already exists; preserving your keys and stream URLs.'; exit 0; fi
read -r -p 'Domain pointing to this server (for example stream.example.com): ' domain
if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] || [[ "$domain" != *.* ]]; then printf '%s\n' 'Invalid domain.'; exit 1; fi
umask 077
printf 'DOMAIN=%s\nCONTROL_TOKEN=%s\nSTREAM_KEY=%s\n' "$domain" "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > .env
printf '%s\n' 'Created .env. Keep it private and back it up. Start with: docker compose up -d --build'
