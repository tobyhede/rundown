# Security Policy Specification

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in normative policy sections of this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. Scope

This document specifies Rundown security policy behavior for command execution, file access, environment access, policy configuration, CLI overrides, JavaScript policy trust, data source files, prompts, session grants, and OS sandbox enforcement.

Sections marked "non-normative" provide explanation, examples, or troubleshooting. All other sections are normative.

<a id="security-model"></a>

## 2. Terminology

An **operation** is a requested command execution, file read, file write, or environment variable access.

A **policy document** is a data policy loaded from `.rundownrc`, `.rundownrc.json`, `.rundownrc.yaml`, `.rundownrc.yml`, the `rundown` field in `package.json`, or an explicitly selected policy file.

A **JavaScript policy** is a `.js`, `.cjs`, or `.mjs` policy file. JavaScript policies are executable code.

A **configured list** is an `allow` or `deny` list loaded from a policy document.

A **CLI grant** is a permission supplied by command-line flags such as `--allow-run`, `--allow-read`, `--allow-write`, or `--allow-env`.

A **session grant** is a memory-only permission created by an interactive prompt decision.

The **policy mode** is one of `prompted`, `execute`, or `deny`.

The **sandbox** is the optional OS-level filesystem enforcement layer used on supported Linux and macOS hosts.

## 3. Threat Model (non-normative)

Rundown security policy is designed to reduce risk when executable runbooks are evaluated on a user's machine.

| Threat | Protection |
|--------|------------|
| Arbitrary command execution | Command allow and deny lists control which executables may run. |
| Sensitive file access | Path policy and, when available, OS sandboxing restrict file reads and writes. |
| Credential leakage | Environment variable policy can block secret-bearing names. |
| Runbook tampering | Runbook overrides allow different trust levels for different file patterns. |
| Shell injection | The policy tokenizer extracts executables from compound shell syntax where possible. |

Trust boundaries:

```text
User
  -> Policy evaluator
  -> OS sandbox, when enabled and available
  -> Runbook command
```

The user is trusted to approve prompts, configure policy files, and choose CLI overrides. A runbook is not inherently trusted.

<a id="sandbox-usage"></a>

## 4. Security Layers

Rundown has two security layers.

### 4.1 Command Policy

The command policy layer applies on all platforms. It MUST evaluate command execution before spawning a process, and it MUST filter environment variables before passing them to that process. It MUST evaluate file read and write paths when Rundown itself mediates those paths, such as file-backed data source loading or sandbox option assembly. File access performed inside an already allowed process is enforced only by the sandbox layer when sandboxing is enabled and available.

The command policy layer MUST parse supported shell syntax and check each extracted executable. Supported compound forms include pipelines, logical operators, command substitutions, backticks, redirects, and here-documents. Executable words that depend on runtime expansion and cannot be parsed statically MUST be treated as unlisted executables, after which the effective policy mode determines whether to prompt, allow, or deny.

### 4.2 Filesystem Sandbox

When enabled, the sandbox layer SHOULD enforce policy-derived file access restrictions at the OS level.

| Platform | Mechanism | Requirement |
|----------|-----------|-------------|
| Linux | Landlock LSM | Kernel 5.13+ with Landlock enabled |
| macOS | Seatbelt (`sandbox-exec`) | macOS 10.5+ |
| Windows | Not supported | Use WSL for Linux sandbox behavior |

macOS Seatbelt MUST allow only required system and runtime paths plus policy-derived read and write roots. It MUST NOT grant blanket reads of `$HOME`.

Linux allow-path enforcement MAY be used when representable by the backend. Linux deny-path rules that cannot be safely represented MUST fail closed. The built-in **Linux default policy** carries no file-access deny rules for this reason, so it is enforceable under Landlock without failing closed (see §7.1 and §16.1); the fail-closed requirement governs user-authored policies that do specify such deny-paths.

## 5. Policy Discovery

<a id="policy-configuration"></a>
<a id="config-file-locations"></a>
When `--policy <file>` is supplied, Rundown MUST load that file directly. Explicit policy loading MUST NOT search other policy locations first.

When `--policy` is not supplied, Rundown MUST search for policy configuration in this order:

1. `.rundownrc`
2. `.rundownrc.json`
3. `.rundownrc.yaml`
4. `.rundownrc.yml`
5. `package.json` `rundown` field

When no policy configuration is found, Rundown MUST use the built-in default policy.

Invalid auto-discovered configuration MUST trigger a warning and fall back to the built-in default policy. A missing or invalid explicitly selected policy file MUST fail closed.

JavaScript policy files MUST NOT be auto-discovered.

## 6. Policy Document Model

A policy document contains a default policy and MAY contain runbook-specific
overrides, persisted grants, and helper module declarations.

| Key | Requirement |
|-----|-------------|
| `version` | Schema version. Missing value defaults to `1`. |
| `default` | Default policy applied to every runbook unless an override changes the effective policy. |
| `overrides` | Ordered list of runbook-specific policy fragments. Missing value defaults to an empty list. |
| `grants` | Ordered list of persisted user grants. Missing value defaults to an empty list. |
| `helpers` | Optional helper module paths. Loading these modules requires `--trust-js-policy`. |

The `default` policy object contains these fields:

| Key | Requirement |
|-----|-------------|
| `mode` | One of `prompted`, `execute`, or `deny`. Missing value defaults to `prompted`. |
| `run` | Command permission rules. Missing value defaults to empty `allow` and `deny` lists. |
| `read` | File-read permission rules. Missing value defaults to empty `allow` and `deny` lists. |
| `write` | File-write permission rules. Missing value defaults to empty `allow` and `deny` lists. |
| `env` | Environment-variable permission rules. Missing value defaults to empty `allow` and `deny` lists. |

Each permission rule object contains:

| Key | Requirement |
|-----|-------------|
| `allow` | Ordered list of glob patterns that may allow matching operations. Missing value defaults to an empty list. |
| `deny` | Ordered list of glob patterns that may deny matching operations. Missing value defaults to an empty list. |

Each override contains a `runbook` glob and MAY contain `mode`, `run`, `read`,
`write`, or `env`. Each persisted grant contains `type`, `pattern`, optional
`runbook`, optional `grantedAt`, and `scope`.

Pattern matching uses picomatch-compatible glob syntax.

Path patterns MAY use these placeholders:

| Placeholder | Resolves To |
|-------------|-------------|
| `{repo}` | Repository root, defaulting to `process.cwd()` |
| `{tmp}` | System temporary directory, such as `/tmp` or `%TEMP%` |

Command `run` patterns match executable names. File `read` and `write` patterns match resolved paths. Environment `env` patterns match variable names.

Runbook override patterns MUST be matched against runbook file paths. A matching override mode replaces the default mode for that runbook. Matching override permission rules are appended to the default permission rules for that runbook.

## 7. Effective Policy Assembly

The effective policy for a run MUST be assembled from:

1. The selected policy document, or the built-in default policy when no document is found.
2. Any matching runbook overrides. Override modes replace the effective mode, and override permission lists are appended to the default permission lists.
3. Persisted grants from the policy document. Persisted grants are appended to the effective allow lists for their permission type.
4. CLI options for the current invocation.
5. Session grants created during interactive prompts.

The built-in policy mode is `prompted`.

<a id="default-policy"></a>

### 7.1 Built-In Default Policy

When no configuration file is found, Rundown uses the built-in default policy.

Allowed commands:

- Version control: `git`
- Node.js ecosystem: `node`, `npm`, `npx`, `pnpm`, `yarn`, `bun`
- Build tools: `tsc`, `esbuild`, `vite`, `webpack`, `rollup`
- Linting: `eslint`, `prettier`, `biome`
- Testing: `jest`, `vitest`, `mocha`, `playwright`, `cypress`
- Other languages: `python`, `python3`, `pip`, `pip3`, `go`, `cargo`, `rustc`, `make`, `cmake`
- Rundown: `rd`, `rundown`, `rdpath`, `rdx`

Denied commands:

- System administration: `sudo`, `su`, `passwd`, `useradd`, `usermod`, `userdel`, `chown`, `chmod`
- Network tools: `curl`, `wget`, `nc`, `netcat`, `ncat`, `ssh`, `scp`, `sftp`, `rsync`
- Destructive operations: `rm`, `rmdir`, `mv`, `dd`, `mkfs`, `fdisk`, `parted`
- Process control: `kill`, `killall`, `pkill`
- Container tools: `docker`, `podman`, `kubectl`, `helm`

Default file access:

- Read allow: `{repo}/**`, `{tmp}/**`
- Read deny: `**/.env`, `**/.env.*`, `**/credentials.json`, `**/*secret*`, `**/*password*`, `**/id_rsa`, `**/id_ed25519`, `**/*.pem`, `**/*.key`
- Write allow: `{repo}/.claude/**`, `{repo}/.rundown/runs/**`, `{repo}/.rundown/locks/**`, `{repo}/.rundown/contexts/**`, `{repo}/.rundown/session.json`, `{repo}/.rundown/work/**`, `{repo}/node_modules/**`, `{repo}/dist/**`, `{repo}/build/**`, `{repo}/.next/**`, `{tmp}/**`
- Write deny: `**/.env`, `**/.env.*`, `**/credentials.json`, `**/*secret*`, `**/*password*`, `{repo}/.rundown/config.yaml`

On **Linux**, the built-in default omits the `read` and `write` deny lists above (they become empty). Linux Landlock is allow-list only and cannot enforce subtractive file denies, so the canonical default would fail closed there; the Linux default is allow-list only so the sandbox engages instead. The `run` and `env` deny lists are unchanged (the policy evaluator enforces them on every platform). macOS and other platforms use the canonical default shown above. See §16.1 for the rationale and trade-off.

The default `WorkPath` built-in resolves to the project-shared
`.rundown/work` directory. Rundown does not add branch- or run-derived suffixes
to that base path. Workflows that need separation should use the `ContextId`
scope (`.rundown/work/.rd-<ContextId>/`) or run-scoped artifact paths below that
context; the default policy intentionally grants the full `.rundown/work/**`
tree so those scoped paths remain writable.

Read deny includes SSH keys and certificates (`id_rsa`, `id_ed25519`, `*.pem`, `*.key`) to reduce credential exfiltration risk. Write deny does not include those patterns so key generation workflows can write new keys when otherwise allowed.

Allowed environment variables:

- System: `PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `LANG`, `LC_*`, `TMPDIR`, `TMP`, `TEMP`
- Development: `CI`, `NODE_ENV`, `DEBUG`, `npm_*`, `RUNDOWN_*`

Denied environment variables:

- Tokens and secrets: `*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL`
- Cloud credentials: `AWS_*`, `GCP_*`, `AZURE_*`, `GOOGLE_*`
- Infrastructure: `KUBECONFIG`, `DOCKER_*`, `SSH_*`, `GPG_*`
- Specific tokens: `GITHUB_TOKEN`, `GITLAB_TOKEN`, `NPM_TOKEN`

<a id="allowdeny-lists"></a>

## 8. Policy Decisions

Policy decisions MUST use this precedence order:

1. `--deny-all`
2. `--allow-all`
3. CLI grants
4. Session grants
5. Configured deny lists
6. Configured allow lists
7. Policy mode

`--deny-all` MUST take precedence over `--allow-all` when both are supplied.

CLI grants and session grants MUST be evaluated before configured deny and allow lists.

Configured deny lists MUST take precedence over configured allow lists.

The policy mode MUST be consulted only after no earlier rule decides the operation.

<a id="policy-modes"></a>

### 8.1 Policy Modes

| Mode | Behavior |
|------|----------|
| `prompted` | Prompt for unlisted operations when interactive. |
| `execute` | Allow unlisted operations. |
| `deny` | Deny unlisted operations. |

The built-in default mode is `prompted`. In `prompted` mode, unlisted operations MUST prompt when the process is interactive. Prompt-required decisions MUST fail closed when the process is non-interactive.

## 9. CLI Overrides

<a id="cli-options"></a>
CLI overrides apply only to the current invocation unless they create a session grant through an interactive prompt.

| Option | Description |
|--------|-------------|
| `--allow-run <cmds>` | Allow specific commands, comma-separated. |
| `--allow-read <paths>` | Allow reading specific paths, comma-separated. |
| `--allow-write <paths>` | Allow writing specific paths, comma-separated. |
| `--allow-env <vars>` | Allow specific environment variables, comma-separated. |
| `--allow-all` | Bypass policy checks and disable sandboxing. |
| `--deny-all` | Deny all operations; wins over `--allow-all` and all grants. |
| `--policy <file>` | Load a specific policy file directly. |
| `--trust-js-policy` | Trust an explicitly selected JavaScript policy and config-declared helper modules. |
| `-y, --yes` | Skip confirmation prompts by approving promptable operations. |
| `--non-interactive` | Disable prompts; prompt-required decisions fail closed. |
| `--sandbox` | Enable OS-level sandboxing. |
| `--no-sandbox` | Disable OS-level sandboxing. |
| `--sandbox-strict` | Fail closed if sandboxing is unavailable. |

`--allow-all` MUST imply `--no-sandbox`.

`--deny-all` MUST win over `--allow-all`.

`--helpers` is an explicit CLI opt-in for helper modules. Helper modules supplied through `--helpers` are not treated as auto-discovered configuration.

## 10. Sandbox Enforcement

The sandbox MUST be enabled by default unless `--no-sandbox` or `--allow-all` is supplied.

`--allow-all` MUST disable sandboxing.

When sandboxing is enabled but unavailable, Rundown MUST warn and execute unsandboxed unless `--sandbox-strict` is supplied.

With `--sandbox-strict`, unavailable sandboxing MUST fail closed and MUST NOT execute the command.

When the Linux sandbox backend cannot safely represent effective deny-path rules, Rundown MUST fail closed instead of silently weakening policy.

When sandboxing is disabled with `--no-sandbox`, file read and write policy still applies in the policy evaluator, but OS-level enforcement does not apply. Commands can access any file the user account can access if the command itself bypasses or exceeds the evaluator's visibility.

Allowing interpreters such as `python`, `node`, or `sh` grants broad code execution. The sandbox can restrict file access, but it does not make interpreter logic safe.

## 11. Data Source File Security

File-backed data sources use `file:` values, such as `--input items=file:data.jsonl`, and are used by `FOR variable IN {{ source }}` loops.

File-backed data sources MUST resolve symlinks before validation.

Resolved data source paths MUST remain inside the project root. Traversal or symlink escape outside the project root MUST fail visibly.

Resolved data source paths MUST pass the active read policy before execution or iteration starts. Promptable reads MAY ask for permission in interactive mode and MUST fail closed in non-interactive mode.

Rundown MUST detect data source drift between iterations. Drift includes material changes to the file snapshot, such as size, mtime, or sampled content hash changes. Drift MUST fail visibly.

File-backed JSONL data sources persist a file snapshot after each successful
iteration. Before reading the next iteration, Rundown validates that snapshot.
Drift failures surface as `FOR_RESOLUTION_FAILED` with code `drift-detected`.

Missing, denied, invalid, escaped, or drifted data sources MUST NOT produce silent zero-iteration loops. They MUST fail visibly before or during loop execution.

File-backed data source controls MUST apply independently of the sandbox layer.

Implementations SHOULD cap file-backed iteration to prevent runaway loops. The current cap is `MAX_FILE_ITERATIONS` at 10,000 iterations.

## 12. JavaScript Policy and Helper Trust

<a id="executable-javascript-policies"></a>
JavaScript, CommonJS, and ES module policy files are executable code. Files ending in `.js`, `.cjs`, or `.mjs` MUST be treated as JavaScript policies.

JavaScript policies MUST NOT be auto-discovered.

JavaScript policies MUST be loaded only when both conditions are true:

1. The file is explicitly selected with `--policy <file>`.
2. `--trust-js-policy` is supplied.

If a JavaScript policy is explicitly selected without `--trust-js-policy`, Rundown MUST fail closed.

Helper modules declared by policy configuration are executable code. Config-declared helper modules MUST be skipped unless `--trust-js-policy` is supplied.

Helper modules passed directly through `--helpers` are allowed only because `--helpers` is an explicit CLI opt-in.

## 13. Prompts, Session Grants, and Non-Interactive Mode

In interactive prompted mode, unlisted operations MUST ask the user for a decision.

Prompt decisions MAY create session grants with these scopes:

| Option | Effect |
|--------|--------|
| Allow once | Allow one operation. |
| Allow for this session | Remember the operation until the runbook or process ends. |
| Allow all of this type for this session | Allow all operations of that type until the runbook or process ends. |
| Deny once | Deny one operation. |
| Deny all of this type for this session | Deny all operations of that type until the runbook or process ends. |

Session grants MUST be memory-only. They MUST NOT persist to disk. They MUST be cleared when the runbook completes, the CLI process exits, or the user explicitly resets them.

When `--non-interactive` is supplied, or when the process is detected as non-interactive, prompts MUST NOT be shown. Any decision that would require a prompt MUST fail closed unless allowed by an earlier precedence rule.

`-y` or `--yes` MAY approve promptable operations without showing a prompt. It MUST NOT override `--deny-all`, configured deny rules, or other earlier denial decisions.

<a id="fallback-behavior"></a>

## 14. Failure Semantics

| Case | Behavior |
|------|----------|
| No policy config found | Use built-in defaults. |
| Invalid auto-discovered config | Warn and use built-in defaults. |
| Missing or invalid explicit `--policy` config | Fail closed. |
| JavaScript policy without `--trust-js-policy` | Fail closed. |
| Config-declared helper without `--trust-js-policy` | Skip helper. |
| Not parseable command | Fail closed unless `--allow-all` is active. |
| Dynamic executable word | Treat as an unlisted operation; policy mode determines whether to prompt, allow, or deny. |
| Unlisted operation in interactive prompted mode | Prompt. |
| Unlisted operation requiring prompt in non-interactive mode | Fail closed. |
| `--allow-all` and `--deny-all` both supplied | `--deny-all` wins. |
| Sandbox unavailable with default sandboxing | Warn and run unsandboxed. |
| Sandbox unavailable with `--sandbox-strict` | Fail closed. |
| Linux deny-path rules cannot be safely represented | Fail closed. |
| Missing data source file | Fail visibly. |
| Denied data source file | Fail visibly. |
| Invalid data source file | Fail visibly. |
| Data source escapes project root | Fail visibly. |
| Data source drift detected | Fail visibly. |

## 15. Examples (non-normative)

### 15.1 Policy Files

```bash
# Data-only policy file
rundown run deploy.runbook.md --policy ./.rundownrc.yaml

# Executable policy file
rundown run deploy.runbook.md --policy ./rundown.config.cjs --trust-js-policy
```

Migration from `rundown.config.js`:

- Move the policy object into `.rundownrc.yaml`, `.rundownrc.json`, or `package.json` when executable logic is not needed.
- Keep JavaScript only when executable policy logic is intentional.
- Require `--policy ... --trust-js-policy` in workflows that keep JavaScript policy files.

### 15.2 Command, File, and Environment Rules

```yaml
version: 1
default:
  mode: prompted
  run:
    allow:
      - git
      - npm
    deny:
      - sudo
  read:
    allow:
      - "{repo}/**"
      - "{tmp}/rundown-*"
    deny:
      - "**/.env"
      - "**/secrets/**"
  env:
    allow:
      - PATH
      - NODE_ENV
      - npm_*
      - RUNDOWN_*
    deny:
      - "*_TOKEN"
      - "*_SECRET"
      - AWS_*
```

For compound commands, every extracted executable must be allowed:

```bash
git log | grep fix
sh -c "npm install"
npm test && npm run build
```

### 15.3 CLI Overrides

```bash
# Allow specific commands for this run
rundown run deploy.runbook.md --allow-run docker,kubectl

# Allow file operations
rundown run backup.runbook.md --allow-read /var/log --allow-write /backup

# Prompted mode with default policy
rundown run deploy.runbook.md

# Strict mode with no prompts
rundown run test.runbook.md --non-interactive

# Trust mode for a controlled environment
rundown run deploy.runbook.md --allow-all
```

### 15.4 Runbook Overrides

```yaml
overrides:
  - runbook: "deploy/**/*.runbook.md"
    mode: execute
    run:
      allow:
        - docker
        - kubectl
        - helm

  - runbook: "community/**/*.runbook.md"
    mode: deny

  - runbook: "backup.runbook.md"
    run:
      allow:
        - rsync
        - tar
```

### 15.5 CI

```bash
# Pre-approve known commands
rundown run test.runbook.md --yes --allow-run npm,jest,eslint

# Use non-interactive mode with a policy file
rundown run test.runbook.md --non-interactive --policy ./ci-policy.yaml

# Trust mode for a controlled CI environment
rundown run deploy.runbook.md --allow-all
```

```yaml
# ci-policy.yaml
version: 1
default:
  mode: execute
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

## 16. Troubleshooting (non-normative)

<a id="sandbox-troubleshooting"></a>

### 16.1 Linux Landlock

```bash
# Check whether Landlock is enabled in the kernel
cat /sys/kernel/security/lsm

# Check kernel version; Landlock requires 5.13+
uname -r
```

If Landlock is unavailable, upgrade to Linux kernel 5.13 or later, ensure `CONFIG_SECURITY_LANDLOCK` is enabled, or install a Landlock wrapper such as `landrun` v0.1.0 or later.

#### Landlock and deny-path policies

Landlock is an allow-list mechanism: it grants access to paths and denies everything else. It **cannot** express "allow this tree *except* these files", so subtractive file-access deny rules — like `read`/`write` denies for `**/.env`, `**/*secret*`, `**/*.pem` — are not representable. When the effective policy contains such deny-paths, the Linux backend fails closed and blocks execution rather than silently not enforcing the deny (see §16.3).

**The built-in default is platform-specific.** Because the canonical default policy carries those file-path deny globs, Rundown ships a distinct **Linux default** that is allow-list only — the same policy with the `read`/`write` deny lists removed — so Landlock engages out of the box instead of failing closed. macOS keeps the canonical default: Seatbelt enforces the file denies natively. The command (`run`) and environment (`env`) deny lists are identical on both platforms, since the policy evaluator (not the sandbox) enforces them.

Trade-off on Linux: a permitted command can read/write secret-named files that live inside the allowed `{repo}/**` or `{tmp}/**` trees, and Rundown's own policy-checked file operations (`file:` data sources, `ARTIFACTS` reads) likewise no longer deny those names. Access is still confined to the granted trees — everything outside `{repo}/**` and `{tmp}/**` (e.g. `~/.ssh`, `/etc`) remains blocked — and the env deny list still keeps tokens out of the command environment while the command deny list still blocks exfiltration tools.

This applies only to the **default**. A user-authored policy with `read`/`write` denies is never rewritten: on Linux it still fails closed under Landlock (run it with `--no-sandbox` for trusted runs, or remove the file denies to opt into allow-list enforcement). On macOS such a policy enforces natively.

### 16.2 macOS Seatbelt

```bash
which sandbox-exec
```

`sandbox-exec` should resolve to `/usr/bin/sandbox-exec`. If sandbox-protected commands fail unexpectedly, check whether System Integrity Protection or application entitlements affect the command.

### 16.3 Sandbox Fallbacks

| Scenario | Behavior |
|----------|----------|
| `--sandbox` or default sandboxing | Falls back to unsandboxed execution with a warning when the sandbox is unavailable. |
| `--sandbox-strict` | Fails with an error and does not execute the command when the sandbox is unavailable. |
| `--no-sandbox` | Executes without sandboxing and does not warn about sandbox availability. |

Linux deny-path note: if the effective policy contains deny-path rules that the Linux backend cannot enforce safely, Rundown blocks execution instead of silently weakening policy. For trusted runs only, disable sandboxing with `--no-sandbox`.

### 16.4 Debugging Sandbox Issues

```bash
# Require sandbox availability
rundown run test.runbook.md --sandbox-strict

# Disable sandbox for a trusted runbook
rundown run trusted.runbook.md --no-sandbox
```

## 17. Conformance

An implementation conforms to this specification when it follows the normative requirements in sections 1, 2, 4 through 14, and 17.

Documentation, examples, and troubleshooting sections are non-normative and MUST NOT override normative requirements.
