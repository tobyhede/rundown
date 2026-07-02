# Linux Landlock sandbox: first-party `rd-landlock` helper with ABI-correct fail-closed enforcement

- **Date:** 2026-07-02
- **Issue:** [#413](https://github.com/tobyhede/rundown/issues/413)
- **Status:** Design approved; ready for implementation planning
- **Scope:** Replace the external `landrun` binary with a first-party Rust helper
  that reads the negotiated Landlock ABI from the syscall and enforces
  fail-closed. Seccomp network isolation is explicitly deferred.

## Problem

Rundown's Linux sandbox (`packages/core/src/sandbox/linux.ts`) shells out to the
third-party [`landrun`](https://github.com/Zouuup/landrun) CLI with
`--best-effort`. Best-effort silently negotiates the Landlock ABI *down* to
whatever the running kernel supports and gives the caller no way to learn what
ABI was actually applied. Lower ABIs silently drop access rights from the
ruleset. The one that matters:

- **`TRUNCATE` (Landlock ABI v3 / kernel 6.2).** Below v3 the kernel cannot
  restrict `truncate()`, so a process can empty a file it was granted only
  read-only access to. A "read-only" grant is therefore not actually read-only on
  kernels older than 6.2.

The current availability probe verifies only that *some* enforcement happens (a
single ungranted read is denied). It cannot detect a partial downgrade, so a
policy can be under-enforced while the result still reports `sandboxed: true`.
`landrun` also carries packaging friction: amd64-only releases (the E2E image
builds it from source via a Go stage for arm64), a hardcoded ABI-v5 demand, and
being a single-maintainer dependency discovered at runtime on `PATH`.

## Goals

- Read and report the **negotiated Landlock ABI** directly from the syscall; no
  more silent best-effort.
- **Fail closed** when the negotiated ABI cannot cover every right the active
  policy requires. `TRUNCATE` (v3) is required whenever the policy has any
  non-writable (read-only or read-execute) grant, because a truncatable read-only
  path is not read-only. In practice that is every real run, since system paths
  are always granted read-execute.
- Remove the external `landrun` dependency and its arch-packaging friction as a
  direct consequence.
- Preserve the existing availability posture: absence or non-enforcement →
  `sandbox: unavailable`; `sandboxStrict` governs run-vs-refuse.

## Non-goals (this spec)

- **Seccomp / network isolation.** Deferred to a follow-up issue (see
  [Follow-up work](#follow-up-work)). The helper's interface is shaped so seccomp
  slots in later without rework, but no BPF is built here.
- **Deny-path parity on Linux.** Landlock is allow-list-only and cannot carve an
  exception out of an allowed subtree, so `supportsDenyPaths` stays `false`. No
  change from today.
- No changes to the macOS/Seatbelt backend, the policy mapper's public shape, the
  state machine, or persisted state. The executor and the `COMMAND_COMPLETED`
  event payload gain two optional fields (see
  [Surfaced result](#surfaced-result)) so the negotiated ABI reaches logs and
  callers — an additive, non-persisted DTO change, not a state-machine change.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Primary goal | ABI correctness | The concrete correctness gap is silent best-effort downgrade, not merely the external dependency. |
| Under-enforcement behaviour | Fail closed (maximal security) | Never execute under a weaker guarantee than the policy promised. Reuses the existing `sandboxStrict` switch; `sandboxStrict:false` / `allowUnsandboxed` is the explicit opt-out. |
| Required-ABI floor | v3 (`TRUNCATE`), derived from policy | Read-only integrity requires truncate protection. Derived from the spec's grants rather than hardcoded, so the rule is self-documenting and future-proof. |
| Configurable minimum-ABI knob | Not built | YAGNI; its only real use case is network/seccomp, which is deferred. |
| Mechanism | Standalone Rust helper (`rd-landlock`) | Landlock is irreversible and inherited, so any mechanism must apply in a per-command child that then `exec`s — the same shape as `landrun`. A standalone binary is a drop-in for that shape, has zero Node-ABI coupling, the smallest security surface for a #1-correctness path, and is the natural home for the deferred seccomp work. |
| Language | Rust | The `landlock` crate handles ABI negotiation and rights masks (as Codex does); `seccompiler` is available for the deferred network work. Hand-rolled C would move the riskiest code (rights masks, later BPF) into hand-written syscalls. |
| Kernel-compatibility cost | Accepted | Requiring v3 refuses on pre-6.2 hosts (RHEL 9, Debian 12, Amazon Linux 2023). These are long-lived servers, not typical agent hosts (macOS → Seatbelt; modern Linux/WSL2/Docker Desktop/CI → ≥ v3). Affected users retain the explicit `sandboxStrict:false` opt-out. |

### Landlock ABI reference

| ABI | Kernel | Adds | Relevant here? |
| --- | --- | --- | --- |
| v1 | 5.13 | Core filesystem read/write/exec rights | Baseline |
| v2 | 5.19 | `REFER` (cross-dir rename/link) | No — absence is *more* restrictive (reparenting denied under any ruleset), not a gap |
| v3 | 6.2 | `TRUNCATE` | **Yes — the required floor** |
| v4 | 6.7 | Network TCP (bind/connect) | No — network is deferred |
| v5 | 6.12 | `IOCTL_DEV` | No — not a policy intent |
| v6 | 6.14 | Scopes (abstract UNIX socket, signal) | No — isolation scoping is out of scope |

Every right introduced above v3 is intentionally out of scope for this spec:
network TCP (v4), `IOCTL_DEV` (v5), the v6 scopes (abstract UNIX socket, signal),
UNIX-socket path resolution (v9), and UDP network rights (v10), per the
[Landlock kernel docs](https://docs.kernel.org/userspace-api/landlock.html). They
belong to the deferred network/isolation follow-up. Because those rights are
*not* handled by this ruleset, the kernel leaves them unrestricted, which is the
same posture as today; the "future-ready" claim in
[Follow-up work](#follow-up-work) means only that the helper's spec/status
interface can carry a network intent later, not that this ruleset restricts those
operations now.

## Architecture

Three units with a clear seam between them.

### 1. `rd-landlock` — the Rust helper (new crate, `native/rd-landlock/`)

A tiny standalone binary. Per invocation it:

1. Reads the kernel's supported ABI via
   `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`.
2. Reads a **JSON spec from fd 3** (a dedicated spec-in pipe) — grants, required
   rights, `strict`, and the command. **Not stdin**: fds 0/1/2 must stay inherited
   so the sandboxed command keeps its own stdin/stdout/stderr (the current
   `landrun` path inherits all three). A dedicated fd also keeps the *spec* (grant
   paths, env values) off the helper's argv and avoids arg-length limits. Note the
   command string itself is still `exec`'d as `/bin/sh -c <command>` and is
   therefore visible in the command process's `/proc/<pid>/cmdline` — exactly as
   today with `landrun`; the fd-3 spec only keeps the *ruleset inputs* out of
   argv, not the command.
3. Computes required-vs-negotiated ABI and applies the
   [fail-closed decision](#fail-closed-decision).
4. Sets **`PR_SET_NO_NEW_PRIVS`** (required for unprivileged Landlock), builds the
   ruleset with the `landlock` crate, and applies it to the current thread. The
   ruleset's *handled* rights include `TRUNCATE` (when ABI ≥ 3): read-only/`rox`
   grants get read (± execute) **without** `TRUNCATE` so they cannot be emptied,
   while read-write grants get `WRITE_FILE` **and** `TRUNCATE` together so
   legitimate overwrite / `>` truncation still works.
5. Writes exactly one bounded JSON status line to **fd 4** (a dedicated status-out
   pipe) — a typed variant: `{"status":"applied","abi":N}`,
   `{"status":"denied","abi":N,"missing":"TRUNCATE"}`, or
   `{"status":"error","message":"…"}`. **fd 3 and fd 4 are marked `FD_CLOEXEC`** so
   they close automatically at `exec` and the command can neither read the spec
   nor write to the status pipe.
6. On `applied`, **only after the fd-4 status write *and* flush have both
   succeeded**, `execvp`s `/bin/sh -c <command>`. If writing or flushing the status
   fails, the helper must **not** `exec` — it exits non-zero without running the
   command. This preserves the status-before-exec contract: core must never be left
   unable to learn the enforcement state while the command runs anyway. After
   `exec` the command *is* the process: its exit code and inherited stdio (fds
   0/1/2) pass straight through, exactly as with `landrun` today. On
   `denied`/`error`, the helper likewise does **not** `exec` — it exits non-zero
   without ever running the command.

**Environment.** Core spawns the helper with the already-policy-filtered
environment as the helper's own environment, and the helper `execvp`s (inheriting
that environment). There is no per-key forward list: because the helper's
environment *is* the filtered set, plain inheritance forwards exactly what policy
allows and nothing more. (The `--env KEY` machinery in the `landrun` path existed
only because `landrun` clears the environment; a first-party helper does not.)
Core still applies the current backend's **`PATH` enhancement** — prepending
`<cwd>/node_modules/.bin` (`buildEnhancedPathFromEnv`, `linux.ts:384`) — to the
env it hands the helper, so local package binaries keep resolving and do not
regress to exit 127.

It also supports `--probe`: read the ABI and run a self-test (apply a ruleset,
confirm a denied read returns `EACCES`), print the result as JSON, and exit. This
replaces the current spawn-`true`-then-`cat` probe and directly detects the
"container seccomp blocks `landlock_*`" false positive (the syscall returns
`ENOSYS`/`EPERM`).

The binary contains no runbook logic. It is a Category A/C external-execution
seam — the equivalent of the `landrun` process it replaces.

### 2. `LandlockSandbox` (core, `packages/core/src/sandbox/linux.ts`) — rewritten

Keeps the same `SandboxImplementation` interface, so `index.ts`, `executor.ts`,
and `policy-mapper.ts` are untouched. Changes:

- `getAvailability()` resolves the bundled helper by arch, runs `rd-landlock
  --probe`, and caches `available` plus the negotiated ABI. Absent binary or
  failed probe → `unavailable` (the existing degrade path).
- `execute()` **first rejects any policy the Linux backend cannot enforce**:
  non-empty `denyPaths` or `denyPatterns` return `policyDenied: true` (exit 126,
  `sandboxed: false`) *before* the helper is spawned — Landlock is allow-list-only
  and cannot carve a deny exception out of an allowed subtree, so silently
  dropping deny policy is not acceptable. This preserves the current behaviour at
  `linux.ts:320` verbatim and is covered by a dedicated test.
- Otherwise `execute()` spawns the helper with
  `stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe']` — fds 0/1/2 inherited
  (the command keeps its own stdio), **fd 3 = spec-in**, **fd 4 = status-out** —
  and `detached: true` so the helper leads its own process group (see
  *Process-group teardown*). `detached` puts the command in a new session without a
  controlling terminal, which is acceptable for non-interactive command steps and
  matches the intent that a sandboxed command should not seize the parent's tty. It
  sets the helper's environment to the policy-filtered command env, writes the
  JSON spec to fd 3, and reads the single typed status line from fd 4.
  **Policy denial is driven by the `denied` status, not by an exit code**, so a
  sandboxed command that happens to exit non-zero (including 125) is never
  misclassified. Status handling:
  - `applied` → run to completion; `sandboxed: true`, surface the reported `abi`.
  - `denied` → `policyDenied: true` with the ABI-gap `denialReason`.
  - `error`, or a missing/malformed status once the helper has started, is a
    **protocol violation** — the helper may already have applied a ruleset and/or
    `exec`'d the command, so its enforcement state is unknown. This **always fails
    closed** (`policyDenied: true`), **regardless of `strict:false`**, and core
    tears down any command that may be running (see *Process-group teardown*
    below). The unsandboxed fallback is reserved strictly for *preflight*
    "sandbox unavailable" (no helper / failed `--probe`) and the explicit ABI
    downgrade under the opt-out — never for a protocol violation. The command's
    own exit code is never interpreted as a policy signal.

**Process-group teardown.** So the helper *and* any grandchildren can be killed as
a unit, core spawns it with `detached: true` (Node sets it as a new session/group
leader via `setsid`, so its PID is also its PGID). Teardown signals the whole
group — `process.kill(-child.pid, 'SIGTERM')`, then `SIGKILL` after a short
timeout if it has not exited — and always `await`s the child's `close`/`exit` to
reap it. The negative-PID signal targets the group; it is only ever issued once
`detached` has made the child a group leader, so it can never reach core's own
group. `child.kill()` alone is insufficient because it signals only the helper,
leaving an `exec`'d shell's grandchildren running.
- The grant categories carry over as JSON fields — the logic is preserved, just
  re-expressed:
  - `rox` system exec paths (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`),
  - `ro` policy read paths and `/etc`,
  - `rw` policy write paths,
  - `rw` device nodes (`/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`),
  - non-existent-path filtering (Landlock, like `landrun`, aborts on a grant path
    that does not exist).
  Environment is not a grant category: it is passed as the helper's process
  environment and inherited across `exec` (see the helper's *Environment* note),
  so there is no per-key list to serialise.

### 3. Seam & distribution

- `native/rd-landlock/` is a Cargo crate. Dependencies: `landlock`, a small JSON
  reader (`serde_json`), and a safe `prctl` wrapper for `PR_SET_NO_NEW_PRIVS`.
  First-party code uses only these **safe wrapper APIs**, so the crate can
  genuinely declare `#![forbid(unsafe_code)]` (a dependency's internal `unsafe` is
  not governed by our crate's lint). If a raw syscall ever proves unavoidable, it
  is isolated in one small audited module gated by `#![deny(unsafe_code)]` with a
  local `#[allow(unsafe_code)]` — never `forbid`, which cannot be locally
  overridden.
- Cross-compiled to **`x86_64-unknown-linux-musl`** and
  **`aarch64-unknown-linux-musl`** — static builds, so no glibc-version coupling;
  the binary runs on any Linux regardless of the build host's distro.
- Core resolves the binary from `dist/native/linux-<arch>/rd-landlock` using an
  **explicit allow-list** of supported architectures — `x64 → linux-x64`,
  `arm64 → linux-arm64` — and returns `unavailable` for any other `process.arch`
  (e.g. `ppc64`, `s390x`, `ia32`). It never falls back to an x64 binary for an
  unsupported arch.
- Absent (WebContainer, macOS, unsupported arch, unbuilt) → `getAvailability()`
  returns `unavailable`, exactly as today when `landrun` is not on `PATH`.

The binaries do **not** appear under `dist/native/` automatically — today core's
`build` is bare `tsc` and `files` is `["dist"]`, and release runs only
`pnpm run build` (`release.yml:37`). Wiring is therefore explicit
(see [Build, CI & distribution](#build-ci--distribution)): a native build/copy
step produces both binaries, a **pack-time assertion fails the publish** if either
is missing or non-executable, and `files` gains `dist/native`.

## Behaviour: ABI negotiation & fail-closed rules

### Required-ABI, derived from the policy

```
required = 1                       // any filesystem enforcement at all
if spec has any non-writable (read-only OR read-exec) grant:
    required = 3                   // truncate protection for a true read-only guarantee
```

The floor is v3 only when there is something to protect from truncation — a
non-writable grant. Rundown always grants system paths `rox` and the repo root
`ro`, so `required` resolves to **3** for every real run. Deriving it (rather than
hardcoding) keeps the door open for a hypothetical all-writable policy and
documents *why* the floor is 3.

**Ruleset rights, per grant category.** The *handled* set is
`AccessFs::from_all(effectiveAbi)` where **`effectiveAbi = min(negotiated, v3)`** —
the FS handling is **capped at ABI v3**. This is deliberate: v3 gives us the
`TRUNCATE` right the read-only guarantee needs, while capping keeps every right
introduced *above* v3 (`IOCTL_DEV` at v5, and anything newer) **out of the handled
set**, so the kernel leaves those operations unrestricted — matching the
[out-of-scope note](#landlock-abi-reference) and avoiding regressions like denying
`ioctl()` on `/dev/null`. Handling `from_all(abi)` uncapped would silently start
restricting `IOCTL_DEV` on a v5 kernel, which is *not* a policy intent here. Within
that capped handled set, each grant category maps to a rights subset built from the
crate's ABI-aware helpers (never a hand-picked literal list):

| Grant | Rights granted on the path |
| --- | --- |
| `ro` (read-only) | `READ_FILE` + `READ_DIR` only — no `EXECUTE`, no `TRUNCATE`, no write/create/remove → cannot be modified or emptied |
| `rox` (read + exec) | `ro` set **+ `EXECUTE`** |
| `rw` (read-write) | the **full write set** — `from_all(effectiveAbi)` minus `EXECUTE`: `READ_FILE`, `READ_DIR`, `WRITE_FILE`, `TRUNCATE`, `REMOVE_FILE`, `REMOVE_DIR`, all `MAKE_*` (regular/dir/char/block/fifo/sock/sym), and `REFER` (ABI ≥ 2) — never `IOCTL_DEV`, since the handled set is capped at v3 |

This mirrors `landrun`'s `--rw` semantics. Granting only `WRITE_FILE` + `TRUNCATE`
would be wrong: creating a new file (`printf hi > new.txt`) needs `MAKE_REG`,
deleting needs `REMOVE_FILE`, and cross-directory rename/link needs `REFER` — all
denied once they are in the handled set but not granted. `EXECUTE` is deliberately
excluded from `rw` (matching `landrun --rw`, not `--rwx`); executability comes only
from `rox` system paths.

Pairing `WRITE_FILE` with `TRUNCATE` on `rw` grants matters: once `TRUNCATE` is in
the ruleset's *handled* set (to protect read-only paths), truncation is denied
everywhere it is not explicitly granted, so omitting it on writable paths would
break legitimate overwrite / `>` truncation. The kernel docs call this out.

### Fail-closed decision

The authority lives in the helper, atomic with the syscall. Core passes `strict`
in the spec (`strict = !allowUnsandboxed`). The helper reads the negotiated ABI
at apply time and:

| Negotiated vs required | `strict` (default) | `strict:false` (explicit opt-out) |
| --- | --- | --- |
| **≥ required** | Apply full ruleset, emit `applied`, `exec` | same |
| **< required** | **Refuse — emit `denied` (naming the ABI + missing right), never `exec`**; helper exits non-zero without running the command | Apply best available ruleset, emit `applied` with `downgraded:true`, `exec` |
| **Landlock syscall unavailable** | existing `unavailable` path (executor already refuses under strict) | existing `unavailable` path (runs unsandboxed) |

The refusal is signalled by the `denied` **status on fd 4**, written before any
`exec`, so core distinguishes a policy refusal from a command's own non-zero exit
regardless of the numeric code.

### Surfaced result

Additive, non-breaking type changes — and, so the fields actually reach callers
rather than dying at the sandbox boundary, the two DTOs on the path out:

- `SandboxAvailability.landlockAbi?: number` — negotiated ABI, from `--probe`.
- `SandboxExecutionResult.landlockAbi?: number` and
  `enforcementDowngraded?: boolean` — populated from the fd-4 status.
- **`executor.ts` return** (`packages/core/src/runbook/executor.ts:247`) copies
  the two new optional fields through, alongside the existing
  `success`/`exitCode`/`denialReason`/`policyDenied`/`sandboxed`.
- **`CommandCompletedPayload`** (`packages/core/src/events/types.ts:115`) gains
  the two optional fields so `COMMAND_COMPLETED` observers see the enforced ABI.
  These are event-payload fields, not persisted `RunbookState`, so the
  no-migration rule is unaffected.
- On refusal: `policyDenied: true` and a `denialReason` such as: *"Landlock ABI 2
  (kernel <6.2) cannot enforce TRUNCATE; read-only grants would be bypassable.
  Refusing under strict mode. Re-run with sandboxStrict:false to override."*

## Build, CI & distribution

The native binaries must be wired into the build and release paths explicitly —
none of this happens today (`core` `build` is bare `tsc`; `files` is `["dist"]`;
`release.yml:37` runs only `pnpm run build`).

- **Native build/copy scripts (core `package.json`):** a **separate** `build:native`
  script cross-compiles both musl targets (or, with `--from-artifacts`, copies
  pre-built CI binaries) to `dist/native/linux-<arch>/rd-landlock` with the
  executable bit set. **The default `build` stays bare `tsc`** and does *not* invoke
  `build:native` — the Rust toolchain is not available on every `pnpm run build`
  path (most CI node jobs, contributor machines), so chaining it into `build` would
  break them. The binary is produced explicitly by the paths that need it (the
  release/publish job, the E2E/enforcement jobs, or a local `pnpm --filter
  @rundown-org/core build:native`). `files` already includes `dist`, so
  `dist/native` ships without a `files` change. Absent binaries simply mean the
  Linux backend reports `unavailable` at dev time — the intended degrade path.
- **Pack-time assertion (`prepack`):** a script that **fails the publish** unless
  both `dist/native/linux-x64/rd-landlock` and `.../linux-arm64/rd-landlock` are
  **valid static ELF binaries of the expected architecture** (validated by parsing
  the ELF header: `ELFCLASS64`, `e_machine` = `x86-64`/`AArch64`, `ET_EXEC`/`ET_DYN`
  with no `PT_INTERP`/`DT_NEEDED`) — not merely "exists and executable". A shell
  script or a wrong-arch/dynamically-linked binary must be rejected, so a broken
  native build can never ship a core package whose Linux sandbox silently reports
  `unavailable` or ships an unrunnable file.
- **Reproducible, pinned native builds.** The crate commits a **`Cargo.lock`** and a
  **`rust-toolchain.toml`** pinning the toolchain version; all `cargo build`
  invocations (CI, release, `build:native`) use `--locked --frozen`. Dependency
  versions are exact-pinned, not floating ranges. This makes the security-critical
  binary reproducible from a given commit.
- **`--from-artifacts` provenance.** When the release job copies pre-built CI
  binaries rather than compiling, it verifies each against a manifest binding
  commit SHA, target triple, and a SHA-256 of the binary — filenames alone are not
  trusted.
- **Release credential hygiene.** The publish workflow checks out with
  `persist-credentials: false`; native build + test steps run with **no** write /
  OIDC / npm credentials in scope — those are confined to the publish step (ideally
  a separate job that consumes the already-built, asserted artifacts).
- **New CI build job:** installs the pinned Rust toolchain and both musl targets and
  builds `rd-landlock` with a **real musl cross-linker** for aarch64 (e.g.
  `cargo-zigbuild`/Zig or a `musl-cross` toolchain — **not** the glibc
  `aarch64-linux-gnu-gcc`, which is the wrong linker for a static musl target), then
  asserts each output is a static ELF of the right arch and uploads the two binaries
  as artifacts. The release/publish job downloads them into `dist/native/` before
  `prepack` runs. Gated to Linux; other jobs unaffected.
- **Existing Landlock enforcement integration job**
  (`RUNDOWN_REQUIRE_LANDLOCK=1`): drop the `landrun` download/install step; build
  or fetch `rd-landlock` instead. Keep failing closed when enforcement is absent,
  and **add an assertion on the reported ABI** so the job proves real negotiation,
  not just a passing read-deny.
- **`scripts/Dockerfile.verify`:** remove the Go / `landrun-builder` stage
  entirely.
- **Docs:** `docs/reference/security.md` — replace "install landrun" guidance with
  "bundled `rd-landlock`, no external install"; document the fail-closed-on-low-ABI
  behaviour and the `sandboxStrict:false` override.

## Testing

- **Rust unit tests** (in-crate): required-ABI computation from a spec; JSON
  parsing; strict-vs-downgrade branch selection. Pure logic, host-independent.
- **Rust enforcement tests** (Linux-only, `#[ignore]` unless a kernel env flag is
  set, mirroring the gated integration job): a denied read → `EACCES`, a denied
  write → `EACCES`; new coverage — a `truncate()` on a read-only grant is blocked
  when ABI ≥ 3, while on a read-write grant the **full write set works**: create
  (`printf hi > new.txt` / `MAKE_REG`), overwrite/truncate (`>`), delete
  (`REMOVE_FILE`), and cross-directory rename (`REFER`, ABI ≥ 2) all succeed; and
  the enforcement path is exercised **as an unprivileged user** to prove
  `PR_SET_NO_NEW_PRIVS` + `restrict_self` work without elevated capabilities.
- **Core TS unit tests** (`packages/core/__tests__/sandbox/linux.test.ts`):
  rewritten against a **fake helper** (a stub honouring the fd-3 spec-in / fd-4
  typed-status protocol), testing spec serialisation, fd-4 status parsing,
  `denied`-status → `policyDenied` mapping (and that a command exiting non-zero
  under an `applied` status is *not* misclassified), ABI surfacing, the
  `PATH`-enhancement pass-through, and the strict/opt-out plumbing without a real
  kernel — keeps macOS / Landlock-less CI green. Two behaviours get dedicated
  tests: **deny-path preflight** — non-empty `denyPaths`/`denyPatterns` return
  `policyDenied` with exit 126 and never spawn the helper; and **protocol
  violation** — an `error`/missing/malformed fd-4 status fails closed
  (`policyDenied`) *even with* `strict:false`, and does not fall back to an
  unsandboxed run. A **process-group teardown** test (fake helper that `exec`s a
  child which spawns a long-lived grandchild) asserts the whole group is signalled
  and reaped on a protocol violation, leaving no survivors.
- **Core enforcement integration test**
  (`packages/core/__tests__/sandbox/linux.enforcement.integration.test.ts`):
  retargeted to `rd-landlock`; gated by `RUNDOWN_REQUIRE_LANDLOCK=1`; adds the
  ABI-reported assertion and a truncate-blocked case.
- **No new migration/property tests** — no persisted-state or parser surface
  changes.

## Follow-up work

- **Seccomp-BPF network isolation** (new GitHub issue, references #413): build
  outbound-network blocking (`connect`/`bind`/`sendto`, exempting `AF_UNIX`) into
  the `rd-landlock` helper, matching Codex parity. Requires a network-intent
  policy mapping and its own tests. The helper's fd-3 spec / fd-4 status interface
  is designed to accept a network intent and its enforcement result without
  rework.

## References

- `packages/core/src/sandbox/linux.ts` — current `landrun` integration
- `packages/core/src/sandbox/macos.ts` — Seatbelt backend
- `packages/core/src/sandbox/types.ts` — `SandboxAvailability` /
  `SandboxExecutionResult`
- Codex Linux sandbox:
  <https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md>
- A deep dive on agent sandboxes:
  <https://pierce.dev/notes/a-deep-dive-on-agent-sandboxes>
- Landlock kernel docs:
  <https://docs.kernel.org/userspace-api/landlock.html>
