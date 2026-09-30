#!/usr/bin/env bash
# next-baking-app launcher: builds if needed, then serves UI + sync hub on the LAN.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PORT="${PORT:-7902}"

if [ ! -d dist ]; then
  echo "→ first run: building the static app (astro build) …"
  npm run build
fi

LAN_IPS_RAW="$(hostname -I 2>/dev/null || ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1)"
LAN_IPS="$(echo "$LAN_IPS_RAW" | tr ' ' ',' | sed 's/,$//')"

echo "→ starting hub on :$PORT"
PORT="$PORT" LAN_IPS="$LAN_IPS" exec node server/hub.ts
