#!/usr/bin/env bash
# build-link.sh — Build the workspace and expose the local CLI on PATH.
#
# Links the built CLI by symlinking packages/cli/dist/cli.js directly into a bin
# directory on PATH (default: ~/.local/bin). This is deliberately NOT
# `pnpm link --global`: that installs @rundown-org/cli into pnpm's global store,
# which resolves the CLI's workspace deps (@rundown-org/core, @rundown-org/parser)
# against stale published copies instead of the live workspace — the CLI then
# crashes with "does not provide an export named …". A direct symlink runs the
# file in-place, so Node resolves those deps through the workspace node_modules.
#
# Because the symlink targets the build output, subsequent `pnpm run build` runs
# are picked up with no relink. The link step is therefore one-time; re-running
# this script is idempotent.
#
# Usage:
#   ./scripts/build-link.sh              # build, then (re)link rundown + rd
#   ./scripts/build-link.sh --no-build   # skip the build, just ensure the links
#   BIN_DIR=~/bin ./scripts/build-link.sh   # link into a different PATH dir
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

CLI_ENTRY="$ROOT_DIR/packages/cli/dist/cli.js"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=true ;;
    *)
      echo "[build-link] ERROR: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [ "$SKIP_BUILD" = false ]; then
  echo "[build-link] Building workspace..."
  pnpm run build
else
  echo "[build-link] Skipping build (--no-build)"
fi

if [ ! -f "$CLI_ENTRY" ] || [ ! -x "$CLI_ENTRY" ]; then
  echo "[build-link] ERROR: CLI build output is missing or not executable at $CLI_ENTRY (run without --no-build)" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
for name in rundown rd; do
  link="$BIN_DIR/$name"
  if [ -d "$link" ] && [ ! -L "$link" ]; then
    echo "[build-link] ERROR: refusing to replace directory $link" >&2
    exit 1
  fi
  rm -f "$link"
  ln -s "$CLI_ENTRY" "$link"
  echo "[build-link] Linked $link -> $CLI_ENTRY"
done

path_has_bin_dir=false
IFS=':' read -ra path_entries <<< "$PATH"
for entry in "${path_entries[@]}"; do
  if [ "$entry" = "$BIN_DIR" ]; then
    path_has_bin_dir=true
    break
  fi
done
if [ "$path_has_bin_dir" = false ]; then
  echo "[build-link] WARNING: $BIN_DIR is not on PATH. Add it, e.g.:" >&2
  echo "             export PATH=\"$BIN_DIR:\$PATH\"" >&2
fi

echo "[build-link] Done. Verify with: rundown --version"
