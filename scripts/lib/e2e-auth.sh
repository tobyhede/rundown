# e2e-auth.sh — Agent-scoped credential preparation for the E2E harness.
#
# This file is a *sourced* shell library, not an executable script. It exposes
# pure functions so the auth-gating decision can be exercised by the harness
# tests (scripts/__tests__/e2e-codex-harness.test.mjs) without running a full
# Docker build.
#
# Contract — the single source of truth for "which agent needs which auth":
#
#   RUNDOWN_E2E_AGENT selects the gating policy:
#     claude  — prepare (and require) Claude credentials only
#     codex   — prepare (and require) Codex credentials only
#     none    — prepare neither; require neither (used by `--bash` debug mode)
#
# The selected agent is the ONLY agent whose credentials are required. Running
# the Codex shell on a Codex-authenticated machine must not demand Claude auth,
# and `--bash` (agent `none`) must not demand any agent credentials at all.
#
# Each function returns 0 on success and a non-zero status (with a logged
# reason) on a hard gating failure, so callers can `set -e` around them.

# Prepare the .claude-docker/ credential home.
#
# When the active agent is Claude, missing credentials are a hard error. For any
# other agent the directory is still created (so volume mounts resolve) but the
# absence of credentials is tolerated.
#
# Arguments:
#   $1 — active agent (claude|codex|none)
#   $2 — credential home directory (e.g. .claude-docker)
# Environment:
#   OSTYPE — used to decide whether to read the macOS Keychain
# Returns: 0 on success, 1 when Claude is the active agent but credentials are
#   unavailable.
e2e_prepare_claude_auth() {
  local agent="$1"
  local claude_home="$2"

  mkdir -p "$claude_home"

  # Onboarding marker skips Claude Code's first-run prompts.
  if [ ! -f "$claude_home/.claude.json" ]; then
    echo '{"hasCompletedOnboarding":true,"installMethod":"native"}' > "$claude_home/.claude.json"
  fi

  local required=false
  if [ "$agent" = claude ]; then
    required=true
  fi

  if [[ "${OSTYPE:-}" == darwin* ]]; then
    e2e_log "Extracting Claude credentials from macOS Keychain..."
    local cred_json
    cred_json=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
    if [ -n "$cred_json" ]; then
      printf '%s' "$cred_json" > "$claude_home/.credentials.json"
      chmod 600 "$claude_home/.credentials.json"
      e2e_log "  Claude credentials extracted successfully."
      return 0
    fi
  fi

  if [ -f "$claude_home/.credentials.json" ]; then
    return 0
  fi

  if [ "$required" = true ]; then
    e2e_log "ERROR: No Claude credentials found ($claude_home/.credentials.json)."
    e2e_log "The Claude E2E agent requires Claude credentials. Log in to Claude Code first."
    return 1
  fi

  e2e_log "Skipping Claude credentials (agent is '$agent', Claude auth not required)."
  return 0
}

# Prepare the .codex-docker/ credential home.
#
# When the active agent is Codex, missing credentials are a hard error. For any
# other agent the directory is still created but missing credentials are
# tolerated.
#
# Arguments:
#   $1 — active agent (claude|codex|none)
#   $2 — credential home directory (e.g. .codex-docker)
# Environment:
#   CODEX_HOME — source Codex home to copy auth.json/config.toml from
#   HOME       — fallback when CODEX_HOME is unset
# Returns: 0 on success, 1 when Codex is the active agent but credentials are
#   unavailable.
e2e_prepare_codex_auth() {
  local agent="$1"
  local codex_home="$2"

  mkdir -p "$codex_home"

  local source_dir="${CODEX_HOME:-$HOME/.codex}"
  local required=false
  if [ "$agent" = codex ]; then
    required=true
  fi

  if [ -f "$source_dir/auth.json" ]; then
    cp "$source_dir/auth.json" "$codex_home/auth.json"
    chmod 600 "$codex_home/auth.json"
    if [ -f "$source_dir/config.toml" ]; then
      cp "$source_dir/config.toml" "$codex_home/config.toml"
      chmod 600 "$codex_home/config.toml"
    fi
    e2e_log "  Codex credentials prepared successfully."
    return 0
  fi

  if [ "$required" = true ]; then
    e2e_log "ERROR: Codex auth file not found at $source_dir/auth.json"
    e2e_log "The Codex E2E agent requires Codex credentials. Log in to Codex CLI first."
    return 1
  fi

  e2e_log "Skipping Codex credentials (agent is '$agent', Codex auth not required)."
  return 0
}

# Fallback logger so the library is usable when sourced standalone (tests).
# Callers that define their own `e2e_log` before sourcing keep their version.
if ! declare -F e2e_log > /dev/null 2>&1; then
  e2e_log() { echo "[e2e-auth] $*"; }
fi
