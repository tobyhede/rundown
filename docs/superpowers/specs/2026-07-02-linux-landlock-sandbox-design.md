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

Rights introduced above v3 — network TCP/UDP, `IOCTL_DEV`, and the v6 scopes and
UNIX-socket path resolution — are intentionally out of scope for this spec. They
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
   `landrun` path inherits all three). A dedicated fd also keeps paths and values
   out of `/proc/<pid>/cmdline` and avoids arg-length limits.
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
6. On `applied`, `execvp`s `/bin/sh -c <command>`. After `exec` the command *is*
   the process: its exit code and inherited stdio (fds 0/1/2) pass straight
   through, exactly as with `landrun` today. On `denied`/`error`, the helper does
   **not** `exec` — it exits non-zero without ever running the command.

**Environment.** Core spawns the helper with the already-policy-filtered
environment as the helper's own environment, and the helper `execvp`s (inheriting
that environment). There is no per-key forward list: because the helper's
environment *is* the filtered set, plain inheritance forwards exactly what policy
allows and nothing more. (The `--env KEY` machinery in the `landrun` path existed
only because `landrun` clears the environment; a first-party helper does not.)

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
- `execute()` spawns the helper with
  `stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe']` — fds 0/1/2 inherited
  (the command keeps its own stdio), **fd 3 = spec-in**, **fd 4 = status-out** —
  sets the helper's environment to the policy-filtered command env, writes the
  JSON spec to fd 3, and reads the single typed status line from fd 4.
  **Policy denial is driven by the `denied` status, not by an exit code**, so a
  sandboxed command that happens to exit non-zero (including 125) is never
  misclassified. Status handling:
  - `applied` → run to completion; `sandboxed: true`, surface the reported `abi`.
  - `denied` → `policyDenied: true` with the ABI-gap `denialReason`.
  - `error`, or missing/malformed status after the helper started → treat as an
    internal failure: fail closed under strict (`policyDenied: true`), degrade to
    `unavailable` under the opt-out — the command's own exit code is never
    interpreted as a policy signal.
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
  reader (`serde_json`). `#![forbid(unsafe_code)]` except where the syscall crate
  requires it.
- Cross-compiled to **`x86_64-unknown-linux-musl`** and
  **`aarch64-unknown-linux-musl`** — static builds, so no glibc-version coupling;
  the binary runs on any Linux regardless of the build host's distro.
- Artifacts are copied to `packages/core/dist/native/linux-<arch>/rd-landlock` and
  listed in core's `files` so they ship on `npm publish`. Core resolves the binary
  from an **explicit allow-list** of supported architectures — `x64 → linux-x64`,
  `arm64 → linux-arm64` — and returns `unavailable` for any other `process.arch`
  (e.g. `ppc64`, `s390x`, `ia32`). It never falls back to an x64 binary for an
  unsupported arch.
- Absent (WebContainer, macOS, unsupported arch, unbuilt) → `getAvailability()`
  returns `unavailable`, exactly as today when `landrun` is not on `PATH`.

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

**Ruleset rights, per grant category** (when ABI ≥ 3, so `TRUNCATE` is handled):

| Grant | Handled rights granted on the path |
| --- | --- |
| `ro` (read-only) | read rights, **no** `TRUNCATE` → cannot be emptied |
| `rox` (read + exec) | read + execute, **no** `TRUNCATE` |
| `rw` (read-write) | read + `WRITE_FILE` **and** `TRUNCATE` together |

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

- **New CI build job:** installs the Rust toolchain and both musl targets, builds
  `rd-landlock`, and uploads the two binaries as artifacts consumed by the
  release/publish job. Gated to Linux; other jobs unaffected.
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
  when ABI ≥ 3, while `truncate()`/`>` on a read-write grant still succeeds; and
  the enforcement path is exercised **as an unprivileged user** to prove
  `PR_SET_NO_NEW_PRIVS` + `restrict_self` work without elevated capabilities.
- **Core TS unit tests** (`packages/core/__tests__/sandbox/linux.test.ts`):
  rewritten against a **fake helper** (a stub honouring the fd-3 spec-in / fd-4
  typed-status protocol), testing spec serialisation, fd-4 status parsing,
  `denied`-status → `policyDenied` mapping (and that a command exiting non-zero
  under an `applied` status is *not* misclassified), `error`/missing-status
  handling, ABI surfacing, and the strict/opt-out plumbing without a real kernel —
  keeps macOS / Landlock-less CI green.
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
