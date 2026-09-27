#!/usr/bin/env bash
# Installs the dsh-zotero DSH plugin into one DSH profile — macOS / Linux.
#
# It does four things:
#   1. unpacks the prebuilt plugin into  <DshHome>/plugins/dsh-zotero
#   2. installs its one runtime dependency (pdfjs-dist)
#   3. links it into  <profile>/node_modules/@dsh-external/dsh-zotero
#   4. appends the loader anchor to  <profile>/cordis.patch.yml  (only once)
#
# Nothing is compiled here: the plugin ships prebuilt, so no pnpm / TypeScript /
# DSH source checkout is needed. The host half is plain JS, and the one place
# that touches the OS (opening a file or URL) already branches on darwin.
#
# Usage:
#   bash install-dsh.sh
#   bash install-dsh.sh --profile zotero
#   bash install-dsh.sh --plugin-dir /path/to/already-built/package
#   bash install-dsh.sh --home /custom/dsh-home
#
# Re-run it after every "dsh plugin install": the package manager rebuilds the
# profile's node_modules and wipes the link.
set -euo pipefail

PROFILE="web"
DSH_HOME_ARG=""
PLUGIN_DIR=""
HERE="$(cd "$(dirname "$0")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --home) DSH_HOME_ARG="$2"; shift 2 ;;
    --plugin-dir) PLUGIN_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "[dsh-zotero] unknown option: $1" >&2; exit 1 ;;
  esac
done

DSH_HOME="${DSH_HOME_ARG:-${DSH_HOME:-$HOME/.dsh}}"
say() { printf '[dsh-zotero] %s\n' "$1"; }
die() { printf '[dsh-zotero] %s\n' "$1" >&2; exit 1; }

# ---- 1. resolve a source package -------------------------------------------
STAGING=""
if [ -n "$PLUGIN_DIR" ]; then
  [ -f "$PLUGIN_DIR/lib/index.js" ] || die "no lib/index.js under $PLUGIN_DIR"
  STAGING="$PLUGIN_DIR"
  say "using prebuilt package at $STAGING"
else
  TGZ="$(ls -1 "$HERE"/dsh-zotero-*.tgz 2>/dev/null | head -n 1 || true)"
  [ -n "$TGZ" ] || die "no dsh-zotero-*.tgz next to this script; pass --plugin-dir instead"
  STAGING="$(mktemp -d)"
  tar -xzf "$TGZ" -C "$STAGING"
  [ -f "$STAGING/lib/index.js" ] || die "failed to unpack $TGZ"
  say "unpacked $(basename "$TGZ")"
fi

# ---- 2. place it under <DshHome>/plugins ------------------------------------
TARGET="$DSH_HOME/plugins/dsh-zotero"
mkdir -p "$(dirname "$TARGET")"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -R "$STAGING"/. "$TARGET"/
[ -f "$TARGET/lib/index.js" ] || die "install went wrong: $TARGET has no lib/index.js"
say "plugin files -> $TARGET"

# one runtime dependency; skip if it is somehow already there
if [ ! -d "$TARGET/node_modules/pdfjs-dist" ]; then
  if command -v npm >/dev/null 2>&1; then
    say "installing pdfjs-dist…"
    ( cd "$TARGET" && npm install --omit=dev --no-audit --no-fund --silent ) \
      || say "pdfjs-dist install failed — PDF rendering will fall back, the rest still works"
  else
    say "npm not found — PDF rendering may not work; install Node.js first"
  fi
fi

# ---- 3. link into the profile ----------------------------------------------
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
[ -d "$PROFILE_DIR" ] || die "profile '$PROFILE' not found at $PROFILE_DIR — start DSH once for that profile, or pass --profile <name>"
SCOPE="$PROFILE_DIR/node_modules/@dsh-external"
mkdir -p "$SCOPE"
LINK="$SCOPE/dsh-zotero"
rm -rf "$LINK"
ln -s "$TARGET" "$LINK"
[ -f "$LINK/lib/index.js" ] || die "link created but lib/index.js unreachable"
say "linked $LINK"

# ---- 4. add the loader anchor ----------------------------------------------
PATCH="$PROFILE_DIR/cordis.patch.yml"
if [ ! -f "$PATCH" ]; then
  printf '# Your patch layer for this dsh profile.\n' > "$PATCH"
fi
if grep -q '@dsh-external/dsh-zotero' "$PATCH" 2>/dev/null; then
  say "cordis.patch.yml already references the package — left untouched"
else
  cat >> "$PATCH" <<'YAML'

# dsh-zotero -- Zotero library access (Local API tools, PDF reading, side panel).
- insert:
    - id: dsh-zotero
      name: '@dsh-external/dsh-zotero'
YAML
  say "anchor appended to $PATCH"
fi

echo
say "done. restart the DSH instance for profile '$PROFILE', for example:"
say "    dsh $PROFILE"
