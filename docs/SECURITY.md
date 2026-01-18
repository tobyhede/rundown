# Security Policy

Rundown includes a Deno-inspired security policy layer that provides explicit allowlist-based permission control for runbook execution.

## Overview

The security policy layer enforces a **default-deny** model:

- Commands not in the allowlist require user confirmation
- Deny lists take precedence over allow lists
- Granular control over commands, file access, and environment variables
- Session grants provide temporary permissions without modifying config
- CLI flags can override policy for specific runs

## Threat Model

The policy layer protects against:

| Threat | Protection |
|--------|------------|
| Arbitrary command execution | Allowlist controls which commands can run |
| Sensitive file access | Path patterns restrict read/write operations |
| Credential leakage | Environment variable filtering blocks secrets |
| Runbook tampering | Per-runbook overrides allow different trust levels |

### Trust Boundaries

```
┌─────────────────────────────────────────────────────┐
│                     User                            │
│  - Approves permission prompts                      │
│  - Configures policy files                          │
│  - Uses CLI flags for temporary overrides           │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│                Policy Evaluator                      │
│  - Checks commands against allow/deny lists         │
│  - Applies runbook-specific overrides               │
│  - Manages session grants                           │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│                   Runbook                           │
│  - Defines steps and commands                       │
│  - Subject to policy restrictions                   │
└─────────────────────────────────────────────────────┘
```

## Policy Configuration

### Config File Locations

Policy configuration is discovered in the following order (highest to lowest priority):

1. `.rundownrc` (JSON or YAML)
2. `.rundownrc.json`
3. `.rundownrc.yaml` / `.rundownrc.yml`
4. `rundown.config.js` / `.cjs` / `.mjs`
5. `package.json` (`rundown` field)

### Schema Reference

```yaml
# .rundownrc.yaml
version: 1

default:
  # Policy mode: 'prompted' | 'execute' | 'deny'
  mode: prompted

  # Command execution rules
  run:
    allow:
      - git
      - npm
      - node
    deny:
      - sudo
      - rm

  # File read rules (supports {repo}, {tmp} placeholders)
  read:
    allow:
      - "{repo}/**"
      - "{tmp}/**"
    deny:
      - "**/.env"
      - "**/credentials.json"

  # File write rules
  write:
    allow:
      - "{repo}/.claude/**"
      - "{repo}/dist/**"
    deny:
      - "**/.env"

  # Environment variable rules (supports glob patterns)
  env:
    allow:
      - PATH
      - HOME
      - NODE_ENV
      - npm_*
    deny:
      - "*_TOKEN"
      - "*_SECRET"
      - AWS_*

# Runbook-specific overrides
overrides:
  - runbook: "deploy/*.runbook.md"
    mode: execute  # Trusted deployment scripts
    run:
      allow:
        - docker
        - kubectl

# Persisted grants
grants:
  - type: run
    pattern: curl
    scope: permanent
```

### Default Policy

When no configuration file is found, Rundown uses built-in defaults:

**Allowed commands:**
- Version control: `git`
- Node.js ecosystem: `node`, `npm`, `npx`, `pnpm`, `yarn`, `bun`
- Build tools: `tsc`, `esbuild`, `vite`, `webpack`, `rollup`
- Linting: `eslint`, `prettier`, `biome`
- Testing: `jest`, `vitest`, `mocha`, `playwright`, `cypress`
- Other languages: `python`, `python3`, `pip`, `pip3`, `go`, `cargo`, `rustc`, `make`, `cmake`
- Rundown: `rd`, `rundown`

**Denied commands:**
- System administration: `sudo`, `su`, `passwd`, `useradd`, `usermod`, `userdel`, `chown`, `chmod`
- Network tools: `curl`, `wget`, `nc`, `netcat`, `ncat`, `ssh`, `scp`, `sftp`, `rsync`
- Destructive operations: `rm`, `rmdir`, `mv`, `dd`, `mkfs`, `fdisk`, `parted`
- Process control: `kill`, `killall`, `pkill`
- Container tools: `docker`, `podman`, `kubectl`, `helm`

**Default file access:**
- Read allow: `{repo}/**`, `{tmp}/**`
- Read deny: `**/.env`, `**/.env.*`, `**/credentials.json`, `**/*secret*`, `**/*password*`, `**/id_rsa`, `**/id_ed25519`, `**/*.pem`, `**/*.key`
- Write allow: `{repo}/.claude/**`, `{repo}/node_modules/**`, `{repo}/dist/**`, `{repo}/build/**`, `{repo}/.next/**`, `{tmp}/**`
- Write deny: `**/.env`, `**/.env.*`, `**/credentials.json`, `**/*secret*`, `**/*password*`

**Note:** Read deny includes SSH keys and certificates (`id_rsa`, `id_ed25519`, `*.pem`, `*.key`) to prevent credential exfiltration, but write deny does not include these patterns to allow key generation workflows.

**Allowed environment variables:**
- System: `PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `LANG`, `LC_*`, `TMPDIR`, `TMP`, `TEMP`
- Development: `CI`, `NODE_ENV`, `DEBUG`, `npm_*`, `RUNDOWN_*`

**Denied environment variables:**
- Tokens/secrets: `*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL`
- Cloud credentials: `AWS_*`, `GCP_*`, `AZURE_*`, `GOOGLE_*`
- Infrastructure: `KUBECONFIG`, `DOCKER_*`, `SSH_*`, `GPG_*`
- Specific tokens: `GITHUB_TOKEN`, `GITLAB_TOKEN`, `NPM_TOKEN`

## Policy Modes

| Mode | Behavior |
|------|----------|
| `prompted` (default) | Ask user for permission on unlisted commands |
| `execute` | Allow all commands without prompting |
| `deny` | Block all unlisted commands without prompting |

### Mode Selection

```bash
# Use prompted mode (default)
rundown run deploy.runbook.md

# Trust mode - skip all policy checks
rundown run deploy.runbook.md --allow-all

# Strict mode - block everything not explicitly allowed
rundown run deploy.runbook.md --deny-all
```

## Allow/Deny Lists

Pattern matching uses [picomatch](https://github.com/micromatch/picomatch) for glob syntax. Command parsing uses [shell-quote](https://github.com/substack/shell-quote) to extract executables from complex shell commands.

### Command Execution (run)

Commands are matched by their executable name:

```yaml
run:
  allow:
    - git        # Matches: git status, git push, etc.
    - npm        # Matches: npm install, npm test
  deny:
    - sudo       # Blocks: sudo anything
```

For piped commands, shell wrappers, and logical operators, all executables are extracted and checked:

```bash
git log | grep fix        # Both 'git' and 'grep' must be allowed
sh -c "npm install"       # 'sh' and 'npm' must be allowed
npm test && npm build     # 'npm' must be allowed
```

### File Access (read/write)

Path patterns support glob syntax with special placeholders:

| Placeholder | Resolves To |
|-------------|-------------|
| `{repo}` | Repository root (defaults to `process.cwd()`) |
| `{tmp}` | System temporary directory (e.g., `/tmp` on Unix, `%TEMP%` on Windows) |

```yaml
read:
  allow:
    - "{repo}/**"        # All files in repo
    - "{tmp}/rundown-*"  # Temp files with prefix
  deny:
    - "**/.env"          # All .env files
    - "**/secrets/**"    # Any secrets directory
```

### Environment Variables (env)

Variable names support glob patterns:

```yaml
env:
  allow:
    - PATH
    - NODE_ENV
    - npm_*              # All npm_ prefixed vars
    - RUNDOWN_*          # All Rundown vars
  deny:
    - "*_TOKEN"          # Any token
    - "*_SECRET"         # Any secret
    - AWS_*              # All AWS credentials
```

## CLI Options

| Option | Description |
|--------|-------------|
| `--allow-run <cmds>` | Allow specific commands (comma-separated) |
| `--allow-read <paths>` | Allow reading specific paths (comma-separated) |
| `--allow-write <paths>` | Allow writing to specific paths (comma-separated) |
| `--allow-env <vars>` | Allow specific environment variables (comma-separated) |
| `--allow-all` | Bypass all policy checks (trust mode) |
| `--deny-all` | Block all operations not explicitly allowed |
| `--policy <file>` | Use a specific policy configuration file |
| `-y, --yes` | Skip confirmation prompts (auto-approve) |
| `--non-interactive` | Non-interactive mode (auto-deny, CI-friendly) |

**Note:** If both `--allow-all` and `--deny-all` are specified, `--deny-all` takes precedence.

### Precedence Order

Permissions are evaluated in this order (first match wins):

1. **CLI grants** (`--allow-run`, etc.) - highest priority
2. **Session grants** (user-approved during prompts)
3. **Deny list** - if matched, operation is blocked
4. **Allow list** - if matched, operation is allowed
5. **Policy mode** - `prompted`, `execute`, or `deny`

### Examples

```bash
# Allow specific commands for this run
rundown run deploy.runbook.md --allow-run docker,kubectl

# Allow file operations
rundown run backup.runbook.md --allow-read /var/log --allow-write /backup

# CI/CD: auto-approve with pre-approved commands
rundown run test.runbook.md --yes --allow-run npm,jest

# CI/CD: strict mode with no prompts
rundown run test.runbook.md --non-interactive

# Use custom policy file
rundown run deploy.runbook.md --policy ./ci-policy.yaml
```

## Runbook Overrides

Different runbooks can have different trust levels:

```yaml
overrides:
  # Trust deployment scripts
  - runbook: "deploy/**/*.runbook.md"
    mode: execute
    run:
      allow:
        - docker
        - kubectl
        - helm

  # Strict mode for untrusted runbooks
  - runbook: "community/**/*.runbook.md"
    mode: deny

  # Additional permissions for specific runbook
  - runbook: "backup.runbook.md"
    run:
      allow:
        - rsync
        - tar
```

Override patterns use glob matching against runbook file paths.

## Session Grants

When prompted for permission, users can choose grant scope:

| Option | Effect |
|--------|--------|
| Allow once | Single operation only |
| Allow for this session | Remembered until runbook completes |
| Allow all [type] for this session | Allow all operations of that type |
| Deny once | Single denial |
| Deny all [type] for this session | Block all operations of that type |

Session grants are **memory-only** and do not persist to disk. They are cleared when:

- The runbook completes
- The CLI process exits
- The user explicitly resets them

## Best Practices

### Principle of Least Privilege

1. Start with the default policy and add specific permissions as needed
2. Use `--allow-run` for one-off operations rather than modifying config
3. Prefer `prompted` mode over `execute` for production runbooks

### Repository-Specific Configurations

Create `.rundownrc.yaml` in your repository with project-specific allowlists:

```yaml
version: 1
default:
  mode: prompted
  run:
    allow:
      - turbo      # Project uses Turborepo
      - prisma     # Database migrations
```

### CI/CD Considerations

For CI environments:

```bash
# Option 1: Pre-approve known commands
rundown run test.runbook.md --yes --allow-run npm,jest,eslint

# Option 2: Use non-interactive mode with policy file
rundown run test.runbook.md --non-interactive --policy ./ci-policy.yaml

# Option 3: Trust mode for controlled CI environment
rundown run deploy.runbook.md --allow-all
```

Create a dedicated CI policy file:

```yaml
# ci-policy.yaml
version: 1
default:
  mode: execute  # No prompts in CI
  run:
    allow:
      - npm
      - node
      - git
      - jest
      - eslint
    deny:
      - sudo
      - curl
      - wget
```

### Auditing

Review your policy configuration periodically:

1. Check for overly permissive `allow` patterns
2. Ensure `deny` lists include sensitive operations
3. Review runbook overrides for appropriate trust levels
4. Monitor session grants during development
