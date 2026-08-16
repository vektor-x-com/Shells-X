#!/usr/bin/env bash
# Dev watcher — rebuilds the shell on source changes and deploys it into the
# btpanel research lab (aaPanel-default PHP-FPM posture: disable_functions
# active, FPM unix socket owned by the pool user). This is the environment
# the FastCGI takeover bypass targets; the stock dev/watch.sh runs a plain
# Apache mod_php container where the bypass has no endpoint to find.
#
# Usage:  cd dev && ./watch-btpanel.sh [generate.py flags]
# Env:    BTPANEL_LAB  path to the lab repo (default:
#         ~/Desktop/research/btpanel_aapanel)
#
# The lab must be running:  docker compose up -d   (inside $BTPANEL_LAB)
# Shell URL:  http://localhost/uploads/dev.php
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"
cd "$ROOT"

EXTRA_FLAGS="${@}"
SHELL_NAME="dev.php"
BTPANEL_LAB="${BTPANEL_LAB:-$HOME/Desktop/research/btpanel_aapanel}"
DEPLOY_DIR="$BTPANEL_LAB/docker/vulnerable-site/uploads"

PY=python3
command -v python3 >/dev/null 2>&1 || PY=python

if [ ! -d "$DEPLOY_DIR" ]; then
    echo "[!] lab deploy dir not found: $DEPLOY_DIR"
    echo "    set BTPANEL_LAB=<path to btpanel_aapanel repo> or start the lab:"
    echo "    docker compose -f $BTPANEL_LAB/docker-compose.yml up -d"
    exit 1
fi

build() {
    "$PY" generate.py --output "$SHELL_NAME" $EXTRA_FLAGS 2>&1 | tail -1
    cp -f "dist/$SHELL_NAME" "$DEPLOY_DIR/$SHELL_NAME"
}

echo "[dev-btpanel] Initial build + deploy..."
build

echo ""
echo "============================================"
echo "  Shell:  http://localhost/uploads/dev.php"
echo "  Lab:    $BTPANEL_LAB (container aapanel-lab)"
echo "  Flags:  $EXTRA_FLAGS"
echo "============================================"
echo ""

echo "[dev-btpanel] Watching src/ templates/ for changes (Ctrl+C to stop)..."

LAST_HASH=""
while true; do
    sleep 2
    HASH=$(find src/ templates/ generate.py -type f -newer "dist/$SHELL_NAME" 2>/dev/null | head -1)
    if [ -n "$HASH" ] && [ "$HASH" != "$LAST_HASH" ]; then
        LAST_HASH="$HASH"
        echo "[dev-btpanel] Change detected, rebuilding + deploying..."
        build
    fi
done
