#!/usr/bin/env bash
set -e

echo "Railway wacli worker booting..."
echo "Current user: $(whoami)"
echo "Current directory: $(pwd)"
echo "WACLI_STORE_DIR=${WACLI_STORE_DIR:-not set}"
echo "RAILWAY_VOLUME_NAME=${RAILWAY_VOLUME_NAME:-not set}"
echo "RAILWAY_VOLUME_MOUNT_PATH=${RAILWAY_VOLUME_MOUNT_PATH:-not set}"

mkdir -p "${WACLI_STORE_DIR:-/data/wacli}"

echo "Testing persistent volume..."
date >> "${WACLI_STORE_DIR:-/data/wacli}/boot-log.txt"
cat "${WACLI_STORE_DIR:-/data/wacli}/boot-log.txt"

echo "Checking wacli install..."
which wacli
wacli --version

echo "---- wacli help ----"
wacli --help

echo "---- wacli auth help ----"
wacli auth --help || true

echo "---- wacli sync help ----"
wacli sync --help || true

echo "Listing wacli store:"
ls -lah "${WACLI_STORE_DIR:-/data/wacli}"

echo "Worker is alive. Sleeping forever for command inspection."

while true; do
  echo "Still alive at $(date)"
  sleep 60
done