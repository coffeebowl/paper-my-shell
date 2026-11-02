#!/bin/bash
# Run the extension in an isolated headless GNOME Shell, next to a helper
# extension that takes screenshots (check) or measures frame costs (perf).
# Settings, data and generated textures live in a temporary directory, the
# running session is not touched. The virtual monitor renders on the real GPU.
#
# Usage: run.sh check|perf OUTDIR [WxH[,WxH...]] [key=value ...]
#   Several sizes give several virtual monitors.
#   key=value pairs go into the extension's settings, e.g. intensity=0.1
#   BG=#rrggbb sets a solid desktop colour (default #f5f5f5).

set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
helper=$1
out=$(realpath -m "$2")
size=${3:-1600x1000}
shift $(($# < 3 ? $# : 3))

uuid=$(grep -o '"uuid": "[^"]*"' "$repo/extension/metadata.json" | cut -d'"' -f4)

# Short path: Wayland socket paths are limited to 108 bytes.
tmp=$(mktemp -d "${TMPDIR:-/tmp}/pms.XXXX")
trap 'fusermount3 -uz "$tmp/run/doc" 2>/dev/null; rm -rf "$tmp"' EXIT
mkdir -p "$tmp/data/gnome-shell/extensions" "$tmp/config/glib-2.0/settings" "$tmp/cache" "$tmp/run" "$out"
chmod 700 "$tmp/run"
ln -s "$repo/extension" "$tmp/data/gnome-shell/extensions/$uuid"
ln -s "$here/$helper@local" "$tmp/data/gnome-shell/extensions/$helper@local"
glib-compile-schemas "$repo/extension/schemas"

{
    echo "[org/gnome/shell]"
    echo "enabled-extensions=['$uuid', '$helper@local']"
    echo "disable-user-extensions=false"
    echo "welcome-dialog-last-shown-version='999'"
    echo
    echo "[org/gnome/desktop/background]"
    echo "picture-options='none'"
    echo "primary-color='${BG:-#f5f5f5}'"
    echo "color-shading-type='solid'"
    echo
    echo "[org/gnome/shell/extensions/paper-my-shell]"
    for kv in "$@"; do echo "$kv"; done
} > "$tmp/config/glib-2.0/settings/keyfile"

monitors=()
for m in ${size//,/ }; do monitors+=(--virtual-monitor "$m"); done

rm -f "$out"/*.png
timeout "${TIMEOUT:-60}" env \
    XDG_DATA_HOME="$tmp/data" XDG_CONFIG_HOME="$tmp/config" XDG_CACHE_HOME="$tmp/cache" \
    GSETTINGS_BACKEND=keyfile XDG_RUNTIME_DIR="$tmp/run" \
    PAPER_TEST_OUT="$out" PAPER_TEST_UUID="$uuid" \
    dbus-run-session -- gnome-shell --headless --wayland --no-x11 \
    "${monitors[@]}" --wayland-display=pms-0 \
    > "$out/shell.log" 2>&1 || true

grep -a "PAPERTEST\|PERF\|JS ERROR" "$out/shell.log" || true
