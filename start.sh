#!/usr/bin/env bash
set -e

echo "Railway wacli worker booting..."
echo "WACLI_STORE_DIR=${WACLI_STORE_DIR:-not set}"
echo "RAILWAY_VOLUME_NAME=${RAILWAY_VOLUME_NAME:-not set}"
echo "RAILWAY_VOLUME_MOUNT_PATH=${RAILWAY_VOLUME_MOUNT_PATH:-not set}"

mkdir -p "${WACLI_STORE_DIR:-/data/wacli}"

echo "Checking auth status..."
wacli auth status || true

echo "Starting WhatsApp auth..."
echo "Open WhatsApp → Settings → Linked devices → Link a device"
echo "Then scan the QR/pairing output below."

wacli auth \
  --qr-format terminal \
  --follow \
  --download-media=false