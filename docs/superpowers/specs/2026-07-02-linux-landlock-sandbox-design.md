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
  policy requires. `TRUNCATE` (v3) is required for any filesystem grant, because
  a truncatable read-only path is not read-only.
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
  state machine, the executor, or persisted state.

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

## Architecture

Three units with a clear seam between them.

### 1. `rd-landlock` — the Rust helper (new crate, `native/rd-landlock/`)

A tiny standalone binary. Per invocation it:

1. Reads the kernel's supported ABI via
   `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`.
2. Reads a **JSON spec on stdin** — grants, required rights, `argv`, and the env
   keys to forward. Stdin (not argv flags) keeps paths and values out of
   `/proc/<pid>/cmdline` and avoids arg-length limits.
3. Computes required-vs-negotiated ABI. If short, applies the
   [fail-closed decision](#fail-closed-decision).
4. If sufficient (or downgrade is permitted), builds the ruleset with the
   `landlock` crate, applies it to the current thread, writes a one-line status
   `{"abi":N,"enforced":true}` to **fd 3**, then `execvp`s `/bin/sh -c <command>`.
   After `exec` the command *is* the process: its exit code and inherited stdio
   pass straight through, exactly as with `landrun` today.

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
- `execute()` serialises the spec, spawns the helper with
  `stdio: ['pipe', 'inherit', 'inherit', 'pipe']` (fd 3 = status), writes the
  JSON spec to stdin, reads fd 3 for `{abi, enforced}`, and maps exit `125` →
  `policyDenied` with the ABI-gap reason.
- The grant categories carry over as JSON fields — the logic is preserved, just
  re-expressed:
  - `rox` system exec paths (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`),
  - `ro` policy read paths and `/etc`,
  - `rw` policy write paths,
  - `rw` device nodes (`/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`),
  - non-existent-path filtering (Landlock, like `landrun`, aborts on a grant path
    that does not exist),
  - env pass-through by key (values sourced from the spawned process environment,
    never argv).

### 3. Seam & distribution

- `native/rd-landlock/` is a Cargo crate. Dependencies: `landlock`, a small JSON
  reader (`serde_json`). `#![forbid(unsafe_code)]` except where the syscall crate
  requires it.
- Cross-compiled to **`x86_64-unknown-linux-musl`** and
  **`aarch64-unknown-linux-musl`** — static builds, so no glibc-version coupling;
  the binary runs on any Linux regardless of the build host's distro.
- Artifacts are copied to `packages/core/dist/native/linux-<arch>/rd-landlock` and
  listed in core's `files` so they ship on `npm publish`. Core resolves
  `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}/rd-landlock` at runtime.
- Absent (WebContainer, macOS, unbuilt) → `getAvailability()` returns
  `unavailable`, exactly as today when `landrun` is not on `PATH`.

## Behaviour: ABI negotiation & fail-closed rules

### Required-ABI, derived from the policy

```
required = 1                       // any filesystem enforcement at all
if spec has any read-only / read-exec grant:
    required = 3                   // truncate protection for a true read-only guarantee
```

Rundown always grants system paths `rox` and the repo root `ro`, so `required`
resolves to **3** for every real run. Deriving it (rather than hardcoding) keeps
the door open for a hypothetical all-writable policy and documents *why* the
floor is 3.

### Fail-closed decision

The authority lives in the helper, atomic with the syscall. Core passes `strict`
in the spec (`strict = !allowUnsandboxed`). The helper reads the negotiated ABI
at apply time and:

| Negotiated vs required | `strict` (default) | `strict:false` (explicit opt-out) |
| --- | --- | --- |
| **≥ required** | Apply full ruleset, `exec`, report `abi` | same |
| **< required** | **Refuse — exit `125`, command never runs**; JSON reason names the ABI and the missing right | Apply best available ruleset, `exec`, report `abi` + `downgraded:true` |
| **Landlock syscall unavailable** | existing `unavailable` path (executor already refuses under strict) | existing `unavailable` path (runs unsandboxed) |

### Surfaced result (additive type changes, no breaks)

- `SandboxAvailability.landlockAbi?: number` — negotiated ABI, from `--probe`.
- `SandboxExecutionResult.landlockAbi?: number` and
  `enforcementDowngraded?: boolean` — so logs and callers see exactly what was
  enforced.
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
  write → `EACCES`, and — new coverage — a `truncate()` on a read-only grant is
  blocked when ABI ≥ 3.
- **Core TS unit tests** (`packages/core/__tests__/sandbox/linux.test.ts`):
  rewritten against a **fake helper** (a stub honouring the JSON-spec / fd-3 /
  exit-`125` protocol), testing spec serialisation, fd-3 parsing, exit-`125` →
  `policyDenied` mapping, ABI surfacing, and the strict/opt-out plumbing without a
  real kernel — keeps macOS / Landlock-less CI green.
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
  policy mapping and its own tests. The helper's JSON-spec / fd-3 interface is
  designed to accept a seccomp mode without rework.

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
