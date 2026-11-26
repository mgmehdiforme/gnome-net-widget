#!/usr/bin/env bash
# Install Net Widget for the current user.
set -euo pipefail
UUID="net-widget@mgmehdiforme.github.io"
SRC="$(cd "$(dirname "$0")" && pwd)/src"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

command -v gnome-shell >/dev/null || { echo "GNOME Shell not found. Net Widget needs GNOME 49 or 50."; exit 1; }
ver="$(gnome-shell --version | grep -oE '[0-9]+' | head -1)"
case "$ver" in 49|50) ;; *) echo "Warning: tested on GNOME 49 and 50, you have GNOME $ver." ;; esac

mkdir -p "$DEST"
cp "$SRC"/extension.js "$SRC"/widget.js "$SRC"/lib.js "$SRC"/metadata.json "$DEST"/
echo "Installed to $DEST"

if gnome-extensions enable "$UUID" 2>/dev/null; then
  echo "Enabled. If you don't see it yet, or you just updated it, log out and back in (GNOME keeps the old code until then)."
else
  # GNOME on Wayland only discovers new extensions at login: pre-enable it for the next session.
  cur="$(gsettings get org.gnome.shell enabled-extensions)"
  case "$cur" in *"$UUID"*) ;; "@as []") gsettings set org.gnome.shell enabled-extensions "['$UUID']" ;;
    *) gsettings set org.gnome.shell enabled-extensions "${cur%]}, '$UUID']" ;; esac
  echo "Enabled for your next session: log out and back in (Wayland loads new extensions at login)."
fi
