#!/usr/bin/env bash
#
# Verify the site package: build the WebContainer snapshot, then run Playwright.
#
# `pnpm run verify` does not cover site/ — no Playwright, and Biome and cspell
# both exclude the directory — so this is the gate for anything under site/src.
#
# Why this is a script rather than `build:snapshot && playwright test`: Astro 7's
# `astro dev` daemonizes. It prints "Dev server running at ..." and the
# foreground process exits 0 while the server keeps serving. Playwright's
# `webServer` treats its command exiting as the server dying and aborts with
# "Process from config.webServer exited early" before running a single test — so
# the obvious one-liner never works locally. We start the server ourselves, wait
# for it to answer, and let Playwright reuse it (`reuseExistingServer` is on
# whenever CI is unset).

set -euo pipefail

URL="http://localhost:4321"
READY_TIMEOUT_SECONDS=60
started_server=0

server_is_up() {
  curl -sf -o /dev/null --max-time 2 "$URL"
}

cleanup() {
  if [ "$started_server" -eq 1 ]; then
    pnpm --filter site exec astro dev stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

pnpm --filter site run build:snapshot

if server_is_up; then
  # A server we did not start may belong to a different worktree, in which case
  # the suite would exercise that checkout's code instead of this one. Name the
  # risk rather than silently testing the wrong tree.
  echo "verify-site: reusing the dev server already listening on 4321."
  echo "verify-site: if it belongs to another worktree, stop it (astro dev stop) and re-run."
else
  echo "verify-site: starting the Astro dev server."
  pnpm --filter site exec astro dev >/dev/null 2>&1
  started_server=1

  elapsed=0
  until server_is_up; do
    if [ "$elapsed" -ge "$READY_TIMEOUT_SECONDS" ]; then
      echo "verify-site: dev server did not answer on $URL within ${READY_TIMEOUT_SECONDS}s." >&2
      exit 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
fi

pnpm --filter site test
