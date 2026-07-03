# shellcheck shell=bash
# native-build.sh — shared rd-landlock native build guard + invocation.
# Sourced by build-e2e.sh and verify-install.sh so the toolchain check and the
# build command cannot drift between them.
#
# Contract: the sourcing script defines `log` (message logger). Call
# `build_native_binaries "<fallback hint>"` where the hint is the script's own
# no-toolchain alternative (printed as the last line of the error).
#
# Builds the bundled rd-landlock native binaries into
# packages/core/dist/native/. `pnpm run build` is bare `tsc` and does NOT
# produce them, but core's `prepack` (scripts/assert-native.mjs) requires both
# static ELF binaries, so `pnpm pack` on core aborts without this step.
# Needs the pinned Rust toolchain + Zig/cargo-zigbuild.

build_native_binaries() {
  fallback_hint="$1"
  if ! command -v cargo >/dev/null 2>&1 || ! cargo zigbuild --version >/dev/null 2>&1; then
    log "ERROR: building the rd-landlock native binaries requires the Rust toolchain"
    log "       and cargo-zigbuild. Install rustup + the musl targets and"
    log "       'cargo install --locked cargo-zigbuild' (see native/rd-landlock/rust-toolchain.toml),"
    log "       $fallback_hint"
    return 1
  fi
  log "Building rd-landlock native binaries..."
  pnpm --filter @rundown-org/core run build:native
}
