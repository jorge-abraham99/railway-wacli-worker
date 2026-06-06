#!/usr/bin/env bash
set -e

echo "Railway wacli worker booting..."
echo "INGESTOR_BUILD_VERSION=debug-upsert-2026-06-04-1"
echo "WACLI_STORE_DIR=${WACLI_STORE_DIR:-not set}"
echo "RAILWAY_VOLUME_NAME=${RAILWAY_VOLUME_NAME:-not set}"
echo "RAILWAY_VOLUME_MOUNT_PATH=${RAILWAY_VOLUME_MOUNT_PATH:-not set}"

mkdir -p "${WACLI_STORE_DIR:-/data/wacli}"

echo "Checking wacli version..."
wacli --version

echo "Checking auth status..."
wacli auth status || true

echo "Starting Node bridge..."
node /app/bridge.js &
BRIDGE_PID=$!

sleep 3

echo "Checking bridge health..."
curl -fsS "http://localhost:${PORT:-8787}/health" || {
  echo "Bridge failed health check"
  exit 1
}

echo "Starting continuous WhatsApp sync with webhook..."
wacli sync \
  --follow \
  --download-media=false \
  --max-db-size "${WACLI_MAX_DB_SIZE:-2GB}" \
  --webhook "http://localhost:${PORT:-8787}/wacli" \
  --webhook-secret "$WACLI_WEBHOOK_SECRET" \
  --webhook-allow-private \
  --events

wait $BRIDGE_PID
