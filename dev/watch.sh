#!/usr/bin/env bash
# Dev watcher — rebuilds shell on source changes and serves via Docker.
# Usage: cd dev && ./watch.sh [generate.py flags]
#   e.g. ./watch.sh --password test --tunnel ../webtun/webtun_servers/tunnel.php
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"
cd "$ROOT"

EXTRA_FLAGS="${@}"
SHELL_NAME="dev.php"

build() {
    python3 generate.py --output "$SHELL_NAME" $EXTRA_FLAGS 2>&1 | tail -1
}

echo "[dev] Initial build..."
build

echo "[dev] Starting Docker containers..."
docker compose -f dev/docker-compose.yml up -d

echo ""
echo "============================================"
echo "  Shell:  http://localhost:8888/dev.php"
echo "  Flags:  $EXTRA_FLAGS"
echo "============================================"
echo ""
echo "[dev] Watching src/ templates/ for changes (Ctrl+C to stop)..."

# Use inotifywait if available, otherwise poll
if command -v inotifywait &>/dev/null; then
    while true; do
        inotifywait -r -q -e modify,create,delete \
            src/ templates/ generate.py 2>/dev/null
        echo "[dev] Change detected, rebuilding..."
        build
    done
else
    echo "[dev] (inotifywait not found, using 2s poll)"
    LAST_HASH=""
    while true; do
        sleep 2
        HASH=$(find src/ templates/ generate.py -type f -newer dist/$SHELL_NAME 2>/dev/null | head -1)
        if [ -n "$HASH" ] && [ "$HASH" != "$LAST_HASH" ]; then
            LAST_HASH="$HASH"
            echo "[dev] Change detected, rebuilding..."
            build
        fi
    done
fi
