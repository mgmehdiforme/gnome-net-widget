#!/usr/bin/env bash
# Build the installable zip (same layout extensions.gnome.org expects).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/net-widget@mgmehdiforme.github.io.shell-extension.zip
(cd src && zip -q -9 ../dist/net-widget@mgmehdiforme.github.io.shell-extension.zip extension.js widget.js lib.js metadata.json)
echo "dist/net-widget@mgmehdiforme.github.io.shell-extension.zip"
