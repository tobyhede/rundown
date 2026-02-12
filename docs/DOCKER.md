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

## Architecture

The Dockerfile uses a multi-stage build:

- **`base`** — Shared foundation: `node:22-slim`, git, sudo, Claude Code, non-root `testuser`
- **`local`** — Copies pre-packed tarballs from `dist/` and installs them globally
- **`npm`** — Defers installation to the entrypoint, which runs `npm install -g` at container start

The `verify-install.sh` orchestrator handles the host-side workflow: building packages, packing tarballs (local mode), preparing credentials, and launching the Docker container via Compose.

## Prerequisites

- Docker and Docker Compose
- On macOS, the orchestrator automatically attempts to extract Claude Code credentials from the Keychain for optional integration testing
