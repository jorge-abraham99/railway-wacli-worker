#!/usr/bin/env bash
set -e

echo "Railway wacli worker booting..."
echo "WACLI_STORE_DIR=${WACLI_STORE_DIR:-not set}"
echo "RAILWAY_VOLUME_NAME=${RAILWAY_VOLUME_NAME:-not set}"
echo "RAILWAY_VOLUME_MOUNT_PATH=${RAILWAY_VOLUME_MOUNT_PATH:-not set}"

mkdir -p "${WACLI_STORE_DIR:-/data/wacli}"

echo "Checking wacli version..."
wacli --version

echo "Checking auth status..."
wacli auth status || true

echo "Listing wacli store:"
ls -lah "${WACLI_STORE_DIR:-/data/wacli}"

echo "SQLite tables:"
sqlite3 "${WACLI_STORE_DIR:-/data/wacli}/wacli.db" ".tables" || true

echo "Recent messages:"
sqlite3 "${WACLI_STORE_DIR:-/data/wacli}/wacli.db" \
  "select rowid, datetime(ts, 'unixepoch') as message_time, chat_jid, sender_jid, substr(display_text, 1, 80) from messages order by rowid desc limit 10;" || true

echo "Starting continuous WhatsApp sync..."
wacli sync \
  --follow \
  --download-media=false \
  --max-db-size "${WACLI_MAX_DB_SIZE:-2GB}" \
  --events