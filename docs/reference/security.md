# Security Policy

Rundown includes a Deno-inspired security policy layer that provides explicit allowlist-based permission control for runbook execution.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in normative policy sections of this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## Security Model

Rundown provides **two layers of security**:

### Layer 1: Command Policy (All Platforms)

The policy engine checks which commands are allowed to run. This layer:

- Blocks denied executables (rm, sudo, curl, etc.)
- Allows approved executables (git, npm, tsc, etc.)
- Can prompt for unknown commands
- Parses complex shell commands including pipes, subshells, and backticks

### Layer 2: Filesystem Sandbox (Linux/macOS)

When sandboxing is enabled (default on supported platforms), Rundown uses OS-level mechanisms to enforce file access:

| Platform | Mechanism | Requirement |
|----------|-----------|-------------|
| Linux | Landlock LSM | Kernel 5.13+ with Landlock enabled |
| macOS | Seatbelt (sandbox-exec) | macOS 10.5+ |
| Windows | Not supported | Use WSL |

The sandbox enforces:
- Read-only access to allowed paths
- Read-write access to specific directories
- Blocking of denied paths at the kernel level

Platform-specific behavior:
- macOS Seatbelt allows only system/runtime paths plus policy-derived read/write roots. It no longer grants blanket reads of `$HOME`.
- Linux allow-path enforcement is available, but deny-path policies fail closed when the current backend cannot represent them safely.

## Sandbox Usage

```bash
# Enable sandboxing (default on supported platforms)
rundown run <file> --sandbox

# Disable sandboxing (trust mode)
rundown run <file> --no-sandbox

# Fail if sandbox unavailable (strict mode)
rundown run <file> --sandbox-strict
```

### Sandbox Limitations

**Without sandbox (`--no-sandbox` or unsupported platform):**
- File read/write policies are NOT enforced
- Commands can access any file the user can access
- Use only with trusted runbooks

**Interpreter bypass:**
Allowing interpreters (python, node, sh) grants unrestricted code execution.
The sandbox limits file access, but the interpreter can execute arbitrary logic.

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
| Sensitive file access | Path patterns + OS sandbox restrict read/write operations |
| Credential leakage | Environment variable filtering blocks secrets |
| Runbook tampering | Per-runbook overrides allow different trust levels |
| Command injection via backticks | Parser extracts and checks commands in backticks |

### Trust Boundaries

```text
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
│  - Extracts commands from backticks and $()         │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│              OS-Level Sandbox                        │
│  (Linux: Landlock | macOS: Seatbelt)                │
│  - Enforces file read/write restrictions            │
│  - Kernel-level enforcement (cannot be bypassed)    │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│                   Runbook                           │
│  - Defines steps and commands                       │
│  - Subject to policy restrictions                   │
└─────────────────────────────────────────────────────┘
```

### Data Source File Security

File-backed data sources (`--input items=file:data.txt`) are subject to security controls:

- **Symlink resolution:** `fs.realpath()` resolves symlinks before path validation
- **Path containment:** Resolved paths must stay within the project root directory
- **Policy enforcement:** The resolved path is checked against the active `read` policy before it becomes a FOR-loop source
- **Prompt behavior:** Promptable reads ask for permission in interactive mode and fail startup in non-interactive mode
- **Blocked sources:** Paths escaping the project are omitted from variable discovery with a warning. A FOR loop depending on that omitted variable fails closed when the loop starts with `ForResolutionError('undefined-variable')`; a `JsonArrayStream` that later resolves outside the project root fails with `policy-violation`, never zero silent iterations.
- **Drift detection:** File snapshots (size, mtime, SHA-256 of first 64 KiB) detect modification between iterations
- **Iteration cap:** `MAX_FILE_ITERATIONS` (10,000) prevents runaway loops from unbounded file sources

These controls are always active, independent of the sandbox layer.

## Policy Configuration

### Config File Locations

Policy configuration is discovered in the following order (highest to lowest priority):

1. `.rundownrc` (JSON or YAML)
2. `.rundownrc.json`
3. `.rundownrc.yaml` / `.rundownrc.yml`
4. `package.json` (`rundown` field)

### Executable JavaScript Policies

JavaScript policy files are executable code. They are **not** auto-discovered.

- Supported only when explicitly passed with `--policy`
- Require `--trust-js-policy`
- Supported extensions: `.js`, `.cjs`, `.mjs`

Examples:

```bash
# Data-only policy file (recommended)
rundown run deploy.runbook.md --policy ./.rundownrc.yaml

# Executable policy file (explicit trust required)
rundown run deploy.runbook.md --policy ./rundown.config.cjs --trust-js-policy
```

Migration from `rundown.config.js`:
- Move the policy object into `.rundownrc.yaml`, `.rundownrc.json`, or `package.json`
- Keep JavaScript only if you intentionally need executable policy logic
- If you keep JavaScript, require `--policy ... --trust-js-policy` in your workflow

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
- Write allow: `{repo}/.claude/**`, `{repo}/.rundown/contexts/**`, `{repo}/node_modules/**`, `{repo}/dist/**`, `{repo}/build/**`, `{repo}/.next/**`, `{tmp}/**`
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
| `--trust-js-policy` | Trust an explicitly selected executable JS policy file and helper modules declared by policy config |
| `-y, --yes` | Skip confirmation prompts (auto-approve) |
| `--non-interactive` | Non-interactive mode (auto-deny, CI-friendly) |
| `--sandbox` | Enable OS-level sandbox (default on supported platforms) |
| `--no-sandbox` | Disable sandbox enforcement |
| `--sandbox-strict` | Fail if sandbox is unavailable |

**Note:** If both `--allow-all` and `--deny-all` are specified, `--deny-all` takes precedence.

**Note:** `--allow-all` implies `--no-sandbox` (trust mode bypasses all enforcement).

**Note:** Helper modules declared by `.rundownrc`, `.rundownrc.json`, `.rundownrc.yaml`, `.rundownrc.yml`, or `package.json` are executable JavaScript and are skipped unless `--trust-js-policy` is set. Helper modules passed directly with `--helpers` are treated as explicit CLI opt-in.

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

# Use executable JS policy file (explicit trust required)
rundown run deploy.runbook.md --policy ./rundown.config.cjs --trust-js-policy
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

## Sandbox Troubleshooting

### Linux: Checking Landlock Availability

```bash
# Check if Landlock is enabled in kernel
cat /sys/kernel/security/lsm
# Output should include 'landlock'

# Check kernel version (requires 5.13+)
uname -r
```

If Landlock is not available:
- Upgrade to Linux kernel 5.13 or later
- Ensure CONFIG_SECURITY_LANDLOCK is enabled in kernel config
- Install a Landlock wrapper like [landrun](https://github.com/Zouuup/landrun) (v0.1.0 or later recommended)

### macOS: Seatbelt Permissions

The `sandbox-exec` command is built into macOS but may require adjustments:

```bash
# Verify sandbox-exec exists
which sandbox-exec
# Should output: /usr/bin/sandbox-exec
```

Common issues:
- **SIP restrictions**: System Integrity Protection may block certain sandbox operations
- **Entitlements**: Some apps may need specific entitlements for sandbox access

### Fallback Behavior

When sandbox is unavailable:

| Scenario | Behavior |
|----------|----------|
| `--sandbox` (default) | Falls back to unsandboxed with warning |
| `--sandbox-strict` | Fails with error, command not executed |
| `--no-sandbox` | Executes without sandbox, no warning |

Linux deny-path note:
- If the effective policy contains deny-path rules that the Linux backend cannot enforce safely, Rundown blocks execution instead of silently weakening policy.
- To proceed in that case, disable sandboxing only for trusted runs with `--no-sandbox`.

### Debugging Sandbox Issues

To debug sandbox-related issues:

```bash
# Run with sandbox strict to see if sandbox is available
rundown run test.runbook.md --sandbox-strict

# If it fails, check availability:
# Linux: cat /sys/kernel/security/lsm
# macOS: which sandbox-exec

# Disable sandbox for trusted runbooks
rundown run trusted.runbook.md --no-sandbox
```
