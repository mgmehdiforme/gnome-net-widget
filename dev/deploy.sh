#!/usr/bin/env bash
# Development: push the current src/ into the hot-reload loader without logging out.
# First time: ./dev/deploy.sh --install, then log out and back in once.
set -euo pipefail
cd "$(dirname "$0")/.."
D="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/hot-reload@net-widget"
if [ "${1:-}" = "--install" ]; then
  mkdir -p "$D" && cp dev/hot-reload@net-widget/{extension.js,metadata.json} "$D"/
  gnome-extensions disable net-widget@mgmehdiforme.github.io 2>/dev/null || true
  cur="$(gsettings get org.gnome.shell enabled-extensions)"
  case "$cur" in *hot-reload@net-widget*) ;; "@as []") gsettings set org.gnome.shell enabled-extensions "['hot-reload@net-widget']" ;;
    *) gsettings set org.gnome.shell enabled-extensions "${cur%]}, 'hot-reload@net-widget']" ;; esac
  echo "Loader installed. Log out and back in once, then run ./dev/deploy.sh after each change."; exit 0
fi
[ -d "$D" ] || { echo "Run ./dev/deploy.sh --install first."; exit 1; }
shopt -s nullglob
last=0
for f in "$D"/widget-*.js; do k="${f##*/widget-}"; k="${k%.js}"; [ "$k" -gt "$last" ] && last="$k"; done
n=$(( last + 1 ))
# ES modules are cached by URL, so lib.js gets a fresh name each time too.
cp src/lib.js "$D/lib-$n.js"
{ sed "s#from './lib.js'#from './lib-$n.js'#" src/widget.js; printf '\nexport function createWidget() { return new NetWidget(); }\n'; } > "$D/widget-$n.js.tmp"
mv "$D/widget-$n.js.tmp" "$D/widget-$n.js"
for f in "$D"/widget-*.js "$D"/lib-*.js; do case "$f" in "$D/widget-$n.js"|"$D/lib-$n.js") ;; *) rm -f "$f" ;; esac; done
echo "Loaded widget-$n.js (watch errors: journalctl --user -f -o cat | grep -i hot-reload)"
