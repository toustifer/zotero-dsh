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
  # Newest wins: several releases can sit side by side, and a bare head -n 1 would
  # pick whichever the shell happens to list first.
  TGZ="$(ls -1 "$HERE"/dsh-zotero-*.tgz 2>/dev/null | sort -V | tail -n 1 || true)"
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

# ---- 2b. resolve peer dependencies -------------------------------------------
# 宿主代码 import @deepseek-ai/dsh-tools / dsh-llm / schemastery 和 cordis。
# 这些是 peer，tarball 里没有 —— 但 DSH 自己的 profiles 作用域里全都有，链过去即可，
# 否则启动时会 ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'。
SHARED="$DSH_HOME/profiles/node_modules"
if [ -d "$SHARED/@deepseek-ai" ]; then
  mkdir -p "$TARGET/node_modules/@deepseek-ai"
  linked_peers=0
  for p in dsh-tools dsh-llm dsh-client-ui-slots schemastery dsh-system-prompt dsh-session; do
    if [ -d "$SHARED/@deepseek-ai/$p" ]; then
      ln -sfn "$SHARED/@deepseek-ai/$p" "$TARGET/node_modules/@deepseek-ai/$p"
      linked_peers=$((linked_peers + 1))
    fi
  done
  # cordis 在作用域里叫 @deepseek-ai/cordis，但插件 import 的是裸名
  if [ -d "$SHARED/@deepseek-ai/cordis" ]; then
    ln -sfn "$SHARED/@deepseek-ai/cordis" "$TARGET/node_modules/cordis"
    ln -sfn "$SHARED/@deepseek-ai/cordis" "$TARGET/node_modules/@deepseek-ai/cordis"
  fi
  say "linked $linked_peers peer packages from $SHARED"
else
  say "WARNING: $SHARED/@deepseek-ai not found — start DSH once so it can install its own scope, then re-run"
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

# ---- 5. install the research agent preset -----------------------------------
# 预设放在 DSH 的用户根下，是给人改的东西 —— 已经存在就不覆盖。
# 缺了它，工具照常可用，但模型不会按文献工作的纪律去用它们。
PRESET_SRC="$STAGING/presets/research"
if [ -f "$PRESET_SRC/agent.cordis.yml" ]; then
  PRESET_DST="$DSH_HOME/.agent-presets/research"
  if [ -d "$PRESET_DST" ]; then
    say "preset already at $PRESET_DST — left untouched (yours wins)"
  else
    mkdir -p "$PRESET_DST"
    cp -R "$PRESET_SRC/." "$PRESET_DST/"
    say "research preset -> $PRESET_DST"
  fi
else
  say "no presets/research in the package — skipping the agent preset"
fi

# ---- 6. install the session-log healer --------------------------------------
# DSH validates every session log's first Zstd frame when it scans the session
# store at boot, and fails closed: one half-written header frame — what an
# interrupted write leaves — takes down the whole plugin tree, and the Web GUI
# then reports "Failed to load plugins". This sweep quarantines such a log
# before DSH ever sees it. Run it from whatever starts this instance.
HEALER_SRC="$HERE/heal-sessions.cjs"
if [ -f "$HEALER_SRC" ]; then
  HEALER_DST="$DSH_HOME/heal-sessions.cjs"
  cp -f "$HEALER_SRC" "$HEALER_DST"
  say "session healer -> $HEALER_DST"
  say "  call it before starting DSH, e.g.: node \"$HEALER_DST\""
else
  say "no heal-sessions.cjs next to this script — skipping the session healer"
fi

echo
say "done. restart the DSH instance for profile '$PROFILE', for example:"
say "    dsh $PROFILE"
