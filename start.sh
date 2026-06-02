#!/usr/bin/env bash
set -e

echo "Railway wacli worker booting..."
echo "Current user: $(whoami)"
echo "Current directory: $(pwd)"

mkdir -p /data/wacli

echo "Testing persistent volume..."
date >> /data/wacli/boot-log.txt
cat /data/wacli/boot-log.txt

echo "Listing /data:"
ls -lah /data
ls -lah /data/wacli

echo "Worker is alive. Sleeping forever for first deployment test."

while true; do
  echo "Still alive at $(date)"
  sleep 60
done