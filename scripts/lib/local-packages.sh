#!/usr/bin/env bash
# Shared package list for local Docker tarball builds.
#
# scripts/Dockerfile.verify consumes these tarballs in its `local` stage. Keep
# both local verifiers sourcing this file so a new Docker COPY requirement cannot
# be added to only one build path.

RUNDOWN_LOCAL_PACKAGES=(parser core cli claude-code-plugin mcp)

pack_rundown_local_packages() {
  local dist_abs="$1"

  # pnpm pack has no workspace selector (--filter rejects `pack`), so pack each
  # package from inside its directory, writing to the absolute dist/ path.
  for pkg in "${RUNDOWN_LOCAL_PACKAGES[@]}"; do
    log "  Packing packages/$pkg..."
    ( cd "packages/$pkg" && pnpm pack --pack-destination "$dist_abs" )
  done
}
