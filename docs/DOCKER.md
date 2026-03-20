# Docker Verification

Docker-based verification tests CLI and plugin installation in a clean Linux container.

## Modes

| Mode | Purpose | When to use |
|------|---------|-------------|
| `local` | Build from source, pack tarballs, install in container | Pre-publish verification |
| `npm` | Install from npm registry at runtime | Post-publish verification |

## Quick Start

```bash
./scripts/verify-install.sh local   # Pre-publish: build, pack, verify
./scripts/verify-install.sh npm     # Post-publish: install from registry
```

The script can be run from a worktree — it resolves paths relative to its own location.

## What It Verifies

1. `rd` and `rundown` binaries are executable
2. Plugin directory exists with expected files and directories
3. A test runbook executes successfully
4. Claude Code integration (if credentials are available)

## Files

| File | Role |
|------|------|
| `scripts/verify-install.sh` | Host-side orchestrator (builds, packs, launches Docker) |
| `scripts/Dockerfile.verify` | Multi-stage Dockerfile (`base`, `local`, `npm` stages) |
| `scripts/docker-entrypoint.sh` | Container entrypoint running verification checks |
| `docker-compose.verify.yml` | Compose services (`test-local`, `test-npm`) |

## Direct Docker Usage

```bash
# Build and run local verification
docker compose -f docker-compose.verify.yml build test-local
docker compose -f docker-compose.verify.yml run --rm test-local

# Build and run npm verification
docker compose -f docker-compose.verify.yml build test-npm
docker compose -f docker-compose.verify.yml run --rm test-npm
```

## Interactive Shell

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

## Architecture

The Dockerfile uses a multi-stage build:

- **`base`** — Shared foundation: `node:24-slim`, git, curl, sudo, non-root `testuser`, Claude Code (native installer)
- **`local`** — Copies pre-packed tarballs from `dist/` and installs them globally
- **`npm`** — Defers installation to the entrypoint, which runs `npm install -g` at container start

The `verify-install.sh` orchestrator handles the host-side workflow: building packages, packing tarballs (local mode), preparing credentials, and launching the Docker container via Compose.

### Claude Code Installation

Claude Code is installed via the native installer (`curl -fsSL https://claude.ai/install.sh | bash`), not npm. The install runs as `testuser` after `WORKDIR /home/testuser` is set — this is required because the installer's `claude install` subcommand scans the current directory and will OOM if run from `/`.

The binary is installed to `~/.local/bin/claude` and the `PATH` is extended in the Dockerfile.

## Credential Persistence

Credentials persist across container runs via a volume mount. The compose file mounts `.claude-docker/` as `~/.claude` inside the container and sets `CLAUDE_CONFIG_DIR` to ensure the native CLI uses file-based credential storage.

### How It Works

1. **First run on macOS**: `verify-install.sh` extracts OAuth credentials from the macOS Keychain (`Claude Code-credentials`) and writes them to `.claude-docker/.credentials.json`
2. **First run without Keychain**: Claude Code prompts for interactive login. Credentials are saved to the mounted volume and persist for subsequent runs
3. **Subsequent runs**: Credentials are already present in `.claude-docker/.credentials.json` — no login required

### Key Files in `.claude-docker/`

| File | Purpose |
|------|---------|
| `.credentials.json` | OAuth tokens (access + refresh) |
| `.claude.json` | Onboarding state, feature flags, account info |

The `.claude-docker/` directory is gitignored. Do not commit credentials.

### Troubleshooting Login Issues

If Claude prompts for login on every run:

1. **Check credentials exist**: `ls -la .claude-docker/.credentials.json`
2. **Check onboarding marker**: `.claude-docker/.claude.json` must contain `"hasCompletedOnboarding": true`
3. **Check `CLAUDE_CONFIG_DIR`**: Must be set in the container environment (the compose file sets this to `/home/testuser/.claude`)
4. **Check token expiry**: The `expiresAt` field in `.credentials.json` — expired access tokens should auto-refresh via the refresh token, but if both are expired, re-login is needed
5. **Reset credentials**: Delete `.claude-docker/.credentials.json` and run again to re-authenticate

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
