# Docker Testing

Docker-based tests verify CLI installation, plugin integration, and end-to-end workflows in clean Linux containers.

## Quick Start

| Test | Command | Purpose |
|------|---------|---------|
| Verify (local) | `pnpm run verify:claude` | Build from source, install in container |
| Verify (npm) | `pnpm run verify:claude:npm` | Install from npm registry |
| E2E | `pnpm run test:e2e` | Full plugin workflow (claude -p → runbook) |
| E2E build | `pnpm run test:e2e:build` | Build E2E image only (no test run) |
| E2E Claude shell | `pnpm run test:e2e:claude` | Build + interactive Claude Code session |
| E2E Codex shell | `pnpm run test:e2e:codex` | Build + interactive Codex CLI session |
| E2E shell alias | `pnpm run test:e2e:shell` | Backward-compatible Claude shell alias |

All scripts can be run from a worktree — they resolve paths relative to their own location.

## Verification Pipeline

### Modes

| Mode | Purpose | When to use |
|------|---------|-------------|
| `local` | Build from source, pack tarballs, install in container | Pre-publish verification |
| `npm` | Install from npm registry at runtime | Post-publish verification |

### Verification Coverage

1. `rd` and `rundown` binaries are executable
2. Plugin directory exists with expected files and directories
3. A test runbook executes successfully
4. Claude Code integration (if credentials are available)

### Verification Files

| File | Role |
|------|------|
| `scripts/verify-install.sh` | Host-side orchestrator (builds, packs, launches Docker) |
| `scripts/Dockerfile.verify` | Multi-stage Dockerfile (`base`, `local`, `npm`, `e2e` stages) |
| `scripts/docker-entrypoint.sh` | Container entrypoint running verification checks |
| `docker-compose.verify.yml` | Compose services (`test-local`, `test-npm`) |

### Verification Direct Docker Usage

```bash
# Build and run local verification
docker compose -f docker-compose.verify.yml build test-local
docker compose -f docker-compose.verify.yml run --rm test-local

# Build and run npm verification
docker compose -f docker-compose.verify.yml build test-npm
docker compose -f docker-compose.verify.yml run --rm test-npm
```

### Verification Interactive Shell

Drop into the container for manual testing:

```bash
# Build first (or run verify-install.sh local to build everything)
docker compose -f docker-compose.verify.yml build test-local

# Launch a shell instead of the entrypoint
docker compose -f docker-compose.verify.yml run --rm --entrypoint bash test-local
```

Inside the container:

```bash
# Check versions
rd --version
claude --version

# Launch Claude Code with the plugin
PLUGIN_DIR="$(npm root -g)/@rundown-org/claude-code-plugin"
claude --plugin-dir "$PLUGIN_DIR"

# Launch with debug logging
claude --plugin-dir "$PLUGIN_DIR" --debug-file /home/testuser/logs/claude-debug.log
```

### Architecture

The Dockerfile uses a multi-stage build:

- **`base`** — Shared foundation: `node:24-slim`, git, curl, sudo, non-root `testuser`, Claude Code (native installer)
- **`local`** — Copies pre-packed tarballs from `dist/` and installs them globally
- **`npm`** — Defers installation to the entrypoint, which runs `npm install -g` at container start
- **`e2e`** — Extends `local` with test fixture and E2E/shell entrypoints

The `verify-install.sh` orchestrator handles the host-side workflow: building packages, packing tarballs (local mode), preparing credentials, and launching the Docker container via Compose.

#### Claude Code Installation

Claude Code is installed via the native installer (`curl -fsSL https://claude.ai/install.sh | bash`), not npm. The install runs as `testuser` after `WORKDIR /home/testuser` is set — this is required because the installer's `claude install` subcommand scans the current directory and will OOM if run from `/`.

The binary is installed to `~/.local/bin/claude` and the `PATH` is extended in the Dockerfile.

## E2E Test Harness

Tests the full plugin workflow: `claude -p` triggers hook dispatch, the `/writing-plans` skill, and runbook execution against a realistic test application.

**Prerequisites:** Docker, Claude Code credentials (mandatory — exits with error if missing).

Persisted runbook state follows the repository no-migration rule in E2E runs too. If state from a previous run is stale or incompatible, finish or close the affected run, or prune the state and restart. The harness must not silently migrate, shim, or rewrite stale runbook state.

### E2E Files

| File | Role |
|------|------|
| `scripts/build-e2e.sh` | Build packages, pack tarballs, prepare credentials, build Docker image |
| `scripts/lib/e2e-auth.sh` | Sourced library: agent-scoped credential preparation (the testable auth-gating seam) |
| `scripts/run-e2e.sh` | Host-side orchestrator (calls build, launches test) |
| `scripts/e2e-shell.sh` | Host-side launcher for interactive Claude **or Codex** session |
| `scripts/Dockerfile.verify` | Shared Dockerfile (`e2e` stage extends `local`) |
| `docker-compose.e2e.yml` | Compose service with volume mounts |
| `scripts/e2e-entrypoint.sh` | Container entrypoint (6-phase test runner) |
| `scripts/e2e-shell-entrypoint.sh` | Container entrypoint (workspace setup + interactive claude) |
| `scripts/e2e-codex-shell-entrypoint.sh` | Container entrypoint (workspace setup + AGENTS.md install + interactive codex) |
| `scripts/e2e-codex-agents.md` | Rundown-aware `AGENTS.md` guidance copied into the Codex workspace |
| `tests/e2e/fixtures/test-app/` | Test fixture (Hono + SQLite REST API) |
| `scripts/__tests__/e2e-codex-harness.test.mjs` | Behavioral harness tests (run under `pnpm test` / `pnpm run verify` and CI) |

### Agent-scoped credential gating

`scripts/build-e2e.sh` prepares credentials according to which agent will
actually launch, selected via the `RUNDOWN_E2E_AGENT` environment variable
(`claude` | `codex` | `none`). `scripts/e2e-shell.sh` derives this from `--agent`
and `--bash`:

| Invocation | Effective agent | Claude auth required | Codex auth required |
|------------|-----------------|----------------------|---------------------|
| `--agent claude` | `claude` | Yes | No |
| `--agent codex` | `codex` | No | Yes |
| `--bash` (any agent) | `none` | No | No |

Only the active agent's credentials are required. Running the Codex shell on a
Codex-authenticated machine never demands Claude auth, and `--bash` debug mode
("no agent") requires no agent credentials at all. The gating decision lives in
`scripts/lib/e2e-auth.sh` (`e2e_prepare_claude_auth`, `e2e_prepare_codex_auth`)
so it is unit-testable without a Docker build.

### Codex ↔ Rundown integration (AGENTS.md)

The Claude entrypoint wires Rundown into the session with `--plugin-dir`. Codex
has no plugin mechanism, so the harness uses the simplest explicit path Codex
already supports: **Codex reads `AGENTS.md` from its working directory on
startup.** `scripts/e2e-codex-shell-entrypoint.sh` copies the Rundown-aware
guidance (`scripts/e2e-codex-agents.md`, baked into the image at
`/usr/local/share/rundown/codex-agents.md`) into the workspace as `AGENTS.md`,
so each Codex session starts with instructions for driving runbooks via the `rd`
CLI. An `AGENTS.md` already present in a mounted project is preserved untouched.

### E2E Coverage

| Phase | Description |
|-------|-------------|
| 1. Prepare workspace | Copies fixture, git init, installs deps, runs fixture tests |
| 2. Resolve plugin | Finds globally-installed plugin directory |
| 3. Check credentials | Verifies Claude credentials exist (hard fail if missing) |
| 4. Run claude -p | Executes `/writing-plans` prompt with plugin (600s timeout) |
| 5. Verify artifacts | Checks plan file exists, schema validation (rdx), structural validation |
| 6. Report | Pass/fail summary with log locations |

> **Warning:** The E2E harness runs agents with elevated, non-interactive automation flags. `scripts/e2e-entrypoint.sh` uses Claude Code's `--dangerously-skip-permissions`, and `scripts/e2e-codex-shell-entrypoint.sh` (added via `scripts/Dockerfile.verify`) uses Codex's `--sandbox danger-full-access` and `--ask-for-approval never`. These flags permit elevated access so automated tests stay non-interactive. Both are test-harness plumbing only; they are not security guarantees and are not production-style workflows.

### E2E Direct Docker Usage

```bash
docker compose -f docker-compose.e2e.yml build e2e
docker compose -f docker-compose.e2e.yml run --rm e2e
```

### E2E Interactive Shell

The provider-specific shell tasks build the image and launch an interactive agent session against the test-app fixture by default. Each task requires only its own agent's credentials — `test:e2e:codex` works on a Codex-authenticated machine without Claude auth. `--no-build` skips the rebuild, and `--bash` bypasses the launcher and drops into a plain shell (no agent, so no agent credentials are required):

```bash
pnpm run test:e2e:claude                                  # Build + launch Claude with test-app fixture
pnpm run test:e2e:codex                                   # Build + launch Codex with test-app fixture
pnpm run test:e2e:codex -- ~/path/to/project              # Build + launch Codex with mounted project
pnpm run test:e2e:codex -- --bash                         # Build + drop to bash (no agent, no fixture setup)
pnpm run test:e2e:codex -- ~/path/to/project --bash       # Build + bash in mounted project
pnpm run test:e2e:codex -- --no-build                     # Cached image + launch Codex with test-app fixture
pnpm run test:e2e:shell -- --no-build ~/path/to/project   # Cached image + launch Claude with mounted project
```

When a custom project is mounted, changes persist back to the host filesystem. This enables dogfooding — using the plugin to build itself:

```bash
# Launch Claude Code against your own project
pnpm run test:e2e:claude -- ~/path/to/project

# Launch Codex CLI against your own project
pnpm run test:e2e:codex -- ~/path/to/project
```

Without a project path, the default launcher copies the built-in test-app fixture (Hono + SQLite REST API) to a temporary workspace with git initialised. The `--bash` variants skip that setup.

### E2E Architecture

The E2E stage extends the `local` stage from `Dockerfile.verify`, adding the test fixture and entrypoints. This eliminates duplication — Claude Code installation, Codex CLI installation, system packages, and tarball setup are defined once in the `base`/`local` stages.

## Plugin Smoke Tests

Cross-platform tests for plugin functionality (CLI commands, hook dispatch, session management). These run without Docker by default.

```bash
cd packages/claude-code-plugin && pnpm run test:smoke
```

## Credential Persistence

Credentials persist across container runs via volume mounts. The compose file mounts `.claude-docker/` as `~/.claude` and `.codex-docker/` as `~/.codex` inside the container, then sets `CLAUDE_CONFIG_DIR` and `CODEX_HOME` so each native CLI uses file-based credential storage.

### How It Works

1. **Claude on macOS**: when the active agent is Claude, `build-e2e.sh` extracts OAuth credentials from the macOS Keychain (`Claude Code-credentials`) and writes them to `.claude-docker/.credentials.json`. Missing Claude credentials are a hard error only when Claude is the active agent.
2. **Codex**: when the active agent is Codex, `build-e2e.sh` copies the host `~/.codex/auth.json` and optional `~/.codex/config.toml` into `.codex-docker/`. Missing Codex credentials are a hard error only when Codex is the active agent. Running the Codex shell never requires Claude auth.
3. **`--bash` (no agent)**: neither Claude nor Codex credentials are required — the entrypoint is plain bash and no agent launches.
4. **Subsequent runs**: Credentials are already present in the repo-local Docker homes, so no login is required

### Key Files in `.claude-docker/`

| File | Purpose |
|------|---------|
| `.credentials.json` | OAuth tokens (access + refresh) |
| `.claude.json` | Onboarding state, feature flags, account info |

The `.claude-docker/` directory is gitignored. Do not commit credentials.

### Key Files in `.codex-docker/`

| File | Purpose |
|------|---------|
| `auth.json` | Codex authentication data |
| `config.toml` | Optional Codex CLI configuration |

Only these selected files are copied from the host Codex home. Session history, logs, sqlite databases, caches, memories, and plugins are not copied. The `.codex-docker/` directory is gitignored. Do not commit credentials.

### Troubleshooting Login Issues

If Claude prompts for login on every run:

1. **Check credentials exist**:
   - On the host: `ls -la .claude-docker/.credentials.json`
   - Inside the container: `ls -la ~/.claude/.credentials.json`
2. **Check onboarding marker** in `.claude-docker/.claude.json` on the host, or `~/.claude/.claude.json` inside the container:
   - Verification runs require `"hasCompletedOnboarding": true`
   - E2E runs require `"onboardingComplete": true`
3. **Check `CLAUDE_CONFIG_DIR`**: Must be set in the container environment (the compose file sets this to `/home/testuser/.claude`)
4. **Check token expiry**: The `expiresAt` field in `.credentials.json` — expired access tokens should auto-refresh via the refresh token, but if both are expired, re-login is needed
5. **Reset credentials**: Delete `.claude-docker/.credentials.json` on the host, or `~/.claude/.credentials.json` inside the container, and run again to re-authenticate

### Differences Between Systems

| Aspect | Verification | E2E |
|--------|-------------|-----|
| Required | Optional (Claude tests skipped) | Mandatory (exit 1) |
| Credential file | `.credentials.json` | `.credentials.json` |
| Cleanup | Persists across runs | Cleaned up on exit (`trap`) |
| Onboarding marker | `hasCompletedOnboarding` | `onboardingComplete` |

## Logs

Logs are written to two locations, both mounted to the host via Docker volumes.

### Verification Logs

The entrypoint writes structured pass/fail output to `./logs/` on the host:

```bash
# List verification logs
ls logs/verify-*.log

# View the latest
cat logs/verify-local-*.log | tail -20
```

### Claude Code Debug Logs

When the entrypoint launches Claude Code interactively, it enables `--debug-file` automatically:

```bash
# List Claude debug logs
ls logs/claude-debug-*.log

# Search for errors
grep -i 'error\|fail\|hook' logs/claude-debug-*.log

# Search for plugin/hook issues
grep -i 'plugin\|hook\|startup' logs/claude-debug-*.log
```

When using an interactive shell, pass `--debug-file` manually:

```bash
claude --plugin-dir "$PLUGIN_DIR" --debug-file /home/testuser/logs/claude-debug.log
```

### E2E Logs

The E2E entrypoint writes to `./logs/` on the host (via volume mount):

```bash
ls logs/e2e-*.log              # Entrypoint pass/fail output
ls logs/workflow-*.jsonl       # claude -p JSON output
ls logs/debug-*.log            # Claude Code debug logs
```

### Debugging Plugin Issues

1. **Hook errors** (`SessionStart:startup hook error`): Check the debug log for the hook that failed. Common causes: missing files in the plugin directory, permission issues, or incompatible plugin format
2. **Plugin not loading**: Verify the plugin directory structure inside the container:

   ```bash
   PLUGIN_DIR="$(npm root -g)/@rundown-org/claude-code-plugin"
   ls -la "$PLUGIN_DIR/.claude-plugin/plugin.json"
   ls -la "$PLUGIN_DIR/hooks/hooks.json"
   ls -la "$PLUGIN_DIR/dist/cli.js"
   ```

3. **Debug categories**: Use `--debug` with category filters for targeted output:

   ```bash
   claude --plugin-dir "$PLUGIN_DIR" --debug "hooks,plugins"
   ```

## Prerequisites

- Docker and Docker Compose
- On macOS, the orchestrator automatically attempts to extract Claude Code credentials from the Keychain for optional integration testing
