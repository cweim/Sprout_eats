#!/usr/bin/env bash
# Minify app.js → app.min.js using esbuild (via npx, no install needed).
# Run from any directory before committing when app.js changes.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

npx --yes esbuild app.js \
    --bundle=false \
    --minify \
    --legal-comments=none \
    --outfile=app.min.js

echo "Built app.min.js ($(wc -c < app.min.js | tr -d ' ') bytes, source $(wc -c < app.js | tr -d ' ') bytes)"
