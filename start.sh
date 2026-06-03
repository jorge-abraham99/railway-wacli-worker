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

echo "Messages schema:"
sqlite3 "${WACLI_STORE_DIR:-/data/wacli}/wacli.db" "pragma table_info(messages);" || true

echo "Chats schema:"
sqlite3 "${WACLI_STORE_DIR:-/data/wacli}/wacli.db" "pragma table_info(chats);" || true

echo "Recent messages raw preview:"
sqlite3 "${WACLI_STORE_DIR:-/data/wacli}/wacli.db" \
  "select * from messages order by rowid desc limit 1;" || true

echo "Recent messages selected fields:"
sqlite3 "${WACLI_STORE_DIR:-/data/wacli}/wacli.db" \
  "select rowid, chat_jid, msg_id, sender_jid, sender_name, ts, substr(display_text, 1, 120) from messages order by rowid desc limit 10;" || true

echo "Inspection complete. Sleeping so logs stay visible."

while true; do
  echo "Still alive at $(date)"
  sleep 60
done