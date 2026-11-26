#!/usr/bin/env bash
set -euo pipefail
UUID="net-widget@mgmehdiforme.github.io"
gnome-extensions disable "$UUID" 2>/dev/null || true
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
rm -rf "$DATA/gnome-shell/extensions/$UUID"
if [ -d "$DATA/gnome-shell/extensions/hot-reload@net-widget" ]; then
  gnome-extensions disable hot-reload@net-widget 2>/dev/null || true
  rm -rf "$DATA/gnome-shell/extensions/hot-reload@net-widget"
fi
echo "Removed. Your saved layout and usage stay in $DATA/gnome-net-widget (delete it to reset)."
