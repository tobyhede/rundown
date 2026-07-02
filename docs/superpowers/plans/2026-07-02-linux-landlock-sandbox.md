# Linux Landlock Sandbox (`rd-landlock`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the external `landrun` CLI with a first-party static Rust helper (`rd-landlock`) that reads the negotiated Landlock ABI from the kernel and enforces filesystem policy fail-closed, and rewire the core Linux sandbox backend, build, CI, and docs around it.

**Architecture:** A tiny standalone Rust binary applies a Landlock ruleset in a per-command child, reads its spec from fd 3, writes a typed status to fd 4, then `exec`s `/bin/sh -c <command>`. The core TypeScript `LandlockSandbox` resolves the bundled binary by arch, probes it for the ABI, and drives it over the fd-3/fd-4 protocol, failing closed on any under-enforcement or protocol violation. Two additive optional DTO fields (`landlockAbi`, `enforcementDowngraded`) carry the enforced ABI out to logs and observers.

**Tech Stack:** Rust (crates: `landlock`, `libc`, `serde`, `serde_json`), cross-compiled to `x86_64-unknown-linux-musl` + `aarch64-unknown-linux-musl`; TypeScript / Node 24 (`node:child_process`, `node:fs`); Jest (ESM, `unstable_mockModule` + real fixture helpers); GitHub Actions.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the design spec (`docs/superpowers/specs/2026-07-02-linux-landlock-sandbox-design.md`).

- **Fail closed, maximal security.** Never execute under a weaker guarantee than the policy promised. Under-enforcement refuses by default; `sandboxStrict:false` (`allowUnsandboxed:true`) is the only opt-out.
- **Required-ABI floor v3 (`TRUNCATE`), derived from the policy.** `required = 1`; if the spec has any non-writable (read-only OR read-exec) grant, `required = 3`. Rundown always grants system paths `rox` and repo root `ro`, so `required` is **3** for every real run. Derived, never hardcoded.
- **Per-grant rights sets.** Handled set = `AccessFs::from_all(abi)` (every access type governed). `ro` = `READ_FILE + READ_DIR` only (no `EXECUTE`, no `TRUNCATE`, no write/create/remove). `rox` = `ro` + `EXECUTE`. `rw` = the **full write set** = `from_all(abi)` minus `EXECUTE` (`READ_FILE`, `READ_DIR`, `WRITE_FILE`, `TRUNCATE`, `REMOVE_FILE`, `REMOVE_DIR`, all `MAKE_*`, and `REFER` when ABI ≥ 2). `WRITE_FILE` and `TRUNCATE` are always paired on `rw`.
- **fd protocol.** fd 3 = spec-in (JSON), fd 4 = typed status-out (`{"status":"applied","abi":N}` / `{"status":"denied","abi":N,"missing":"TRUNCATE"}` / `{"status":"error","message":"…"}`). fds 0/1/2 stay inherited. **fd 3 and fd 4 are marked `FD_CLOEXEC`.**
- **`PR_SET_NO_NEW_PRIVS` before `restrict_self`.** Applied via the `landlock` crate's `set_no_new_privs(true)` (default), which issues the prctl before `restrict_self()`.
- **Deny-path preflight.** Non-empty `denyPaths`/`denyPatterns` return `policyDenied:true`, exit 126, `sandboxed:false`, **before** the helper is spawned. Preserved verbatim from `linux.ts:320`.
- **Protocol violations fail closed regardless of `strict`.** An `error`, missing, or malformed fd-4 status once the helper has started → `policyDenied:true` even with `strict:false`; core tears down any running command via **detached process-group teardown** and never falls back to an unsandboxed run.
- **Policy denial is driven by status, not exit code.** A sandboxed command exiting non-zero (including 125) under an `applied` status is never misclassified as a policy denial.
- **PATH enhancement preserved.** Core prepends `<cwd>/node_modules/.bin` to the env handed to the helper; the helper inherits its own (already policy-filtered) environment across `exec` — no per-key forward list.
- **Arch allow-list.** `x64 → linux-x64`, `arm64 → linux-arm64`; any other `process.arch` → `unavailable`. Never fall back to an x64 binary.
- **Static musl builds.** No glibc coupling.
- **`#![deny(unsafe_code)]` with one audited `sys` module.** First-party filesystem logic uses only safe `landlock`-crate wrappers and `std::os::unix::process::CommandExt::exec` (safe). The unavoidable raw syscalls (numeric ABI read, borrowing fds 3/4, `FD_CLOEXEC`) are isolated in a single `sys` module annotated `#[allow(unsafe_code)]`. Crate root is `#![deny(unsafe_code)]` (never `forbid`, which cannot be locally overridden — per spec).
- **Prepack assertion.** Publish fails unless `dist/native/linux-x64/rd-landlock` and `dist/native/linux-arm64/rd-landlock` both exist and are executable.
- **No persisted-state migration.** The two new fields are event-payload / DTO fields only; no `RunbookState`, XState ID, snapshot, or schema change.
- **Testing conventions.** Use `isError()` / `getErrorMessage()` from `@rundown-org/core` — never `Error.isError()` directly. CLI/JSON defaults unchanged (this surface is not CLI output). Structural service doubles in non-core tests.

---

## File Structure

### Created

- `native/rd-landlock/Cargo.toml` — crate manifest: deps, static-musl profile, `edition 2021`.
- `native/rd-landlock/src/main.rs` — crate root (`#![deny(unsafe_code)]`); runtime orchestration: read fd 3 → parse → decide → apply → write fd 4 → `exec`; `--probe` dispatch.
- `native/rd-landlock/src/spec.rs` — `Spec`/`Grant` types + `parse_spec(&str)` (serde). Pure.
- `native/rd-landlock/src/abi.rs` — `required_abi(&Spec)`, `ro_access()`, `rox_access()`, `rw_access(abi)`, `decide(...)`, `Decision`. Pure logic.
- `native/rd-landlock/src/status.rs` — `Status` enum + `to_status_line(&Status)`. Pure.
- `native/rd-landlock/src/sys.rs` — **only** `#[allow(unsafe_code)]` module: `read_abi_version()`, `spec_reader()`/`status_writer()` (borrow fds 3/4 + set `FD_CLOEXEC`).
- `native/rd-landlock/src/ruleset.rs` — `apply_ruleset(abi, &Spec)` via the `landlock` crate. Enforcement.
- `native/rd-landlock/src/probe.rs` — `--probe` self-test.
- `native/rd-landlock/tests/enforcement.rs` — gated (`#[ignore]`) real-kernel enforcement tests.
- `scripts/build-native.mjs` — cross-compiles both musl targets (or, with `--from-artifacts <dir>`, copies pre-built CI binaries) into `dist/native/linux-<arch>/rd-landlock`, `chmod +x`.
- `scripts/assert-native.mjs` — `prepack` guard: both binaries exist + executable, else exit 1.
- `packages/core/__tests__/sandbox/fixtures/fake-helper.mjs` — parametrised fake helper honouring the fd-3/fd-4 protocol (status via env), used by core unit tests.
- `packages/core/__tests__/sandbox/fixtures/fake-helper-grandchild.mjs` — fake helper that `exec`s a shell spawning a long-lived grandchild (process-group teardown test).

### Modified

- `packages/core/src/sandbox/linux.ts` — rewritten: arch resolver, `--probe` availability, deny preflight, spec builder, detached fd-wired spawn, status handling, process-group teardown, DI helper-path seam.
- `packages/core/src/sandbox/types.ts` — `SandboxAvailability.landlockAbi?`, `SandboxExecutionResult.landlockAbi?` + `enforcementDowngraded?`.
- `packages/core/src/runbook/executor.ts:13-24,247-253` — `ExecutionResult` gains the two fields; the sandbox return copies them through.
- `packages/core/src/runbook/actors/command-exec-actor.ts:67-86` — `CommandExecutionCompletedOutput` gains the two fields.
- `packages/core/src/events/execution-observation.ts:268-287` — `commandCompletedEffect` copies the two fields.
- `packages/core/src/events/types.ts:114-123` — `CommandCompletedPayload` gains the two fields.
- `packages/core/package.json` — `build:native`, `build` = `tsc && build:native`, `prepack`, `files` += `dist/native`, `devDependencies` unchanged.
- `.github/workflows/ci.yml` — new `rd-landlock-build` job; `landlock-integration` retargeted (drop landrun install, fetch `rd-landlock`, assert reported ABI).
- `.github/workflows/release.yml` — download native artifacts into `dist/native/` before pack.
- `scripts/Dockerfile.verify` — remove the `landrun-builder` Go stage and its `COPY`.
- `packages/core/__tests__/sandbox/linux.test.ts` — rewritten against the fake helper.
- `packages/core/__tests__/sandbox/linux.enforcement.integration.test.ts` — retargeted to `rd-landlock` + ABI assertion + truncate case.
- `docs/reference/security.md` — replace landrun guidance; document fail-closed-on-low-ABI + override.

---

## Task 1: Rust crate scaffold

**Files:**
- Create: `native/rd-landlock/Cargo.toml`
- Create: `native/rd-landlock/src/main.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: a buildable crate `rd-landlock` whose binary prints its version on `--version`.

- [ ] **Step 1: Write the failing test (build-as-test)**

Create `native/rd-landlock/Cargo.toml`:

```toml
[package]
name = "rd-landlock"
version = "0.1.0"
edition = "2021"
publish = false
description = "First-party Landlock sandbox helper for Rundown"

[[bin]]
name = "rd-landlock"
path = "src/main.rs"

[dependencies]
landlock = "0.4"
libc = "0.2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
opt-level = "z"
lto = true
strip = true
panic = "abort"
```

Create `native/rd-landlock/src/main.rs`:

```rust
#![deny(unsafe_code)]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("rd-landlock {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    eprintln!("rd-landlock: no spec provided");
    std::process::exit(2);
}
```

- [ ] **Step 2: Run build to verify it fails then compiles clean**

Run: `cd native/rd-landlock && cargo build`
Expected first run: cargo downloads deps and compiles; FAILS only if the `landlock`/`libc` versions do not resolve. Fix versions until it PASSES: `Compiling rd-landlock v0.1.0` then `Finished`.

- [ ] **Step 3: Verify the binary runs**

Run: `cd native/rd-landlock && cargo run -- --version`
Expected: `rd-landlock 0.1.0`

- [ ] **Step 4: Commit**

```bash
git add native/rd-landlock/Cargo.toml native/rd-landlock/src/main.rs
git commit -m "feat(rd-landlock): scaffold Rust helper crate (#413)"
```

---

## Task 2: Spec model + JSON parsing

**Files:**
- Create: `native/rd-landlock/src/spec.rs`
- Modify: `native/rd-landlock/src/main.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub struct Spec { pub command: String, pub strict: bool, pub ro: Vec<String>, pub rox: Vec<String>, pub rw: Vec<String> }`
  - `pub fn parse_spec(json: &str) -> Result<Spec, String>`

- [ ] **Step 1: Write the failing test**

Create `native/rd-landlock/src/spec.rs`:

```rust
//! JSON spec read from fd 3: grant categories, strict flag, and the command.

use serde::Deserialize;

/// Ruleset inputs delivered to the helper over fd 3.
#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct Spec {
    /// Shell command to exec as `/bin/sh -c <command>`.
    pub command: String,
    /// When true, refuse if the negotiated ABI is below the required floor.
    #[serde(default = "default_strict")]
    pub strict: bool,
    /// Read-only grants (READ_FILE + READ_DIR).
    #[serde(default)]
    pub ro: Vec<String>,
    /// Read + execute grants.
    #[serde(default)]
    pub rox: Vec<String>,
    /// Read-write grants (full write set).
    #[serde(default)]
    pub rw: Vec<String>,
}

fn default_strict() -> bool {
    true
}

/// Parse the fd-3 JSON spec.
///
/// Returns a human-readable error string on malformed JSON or a missing
/// `command`.
pub fn parse_spec(json: &str) -> Result<Spec, String> {
    serde_json::from_str::<Spec>(json).map_err(|e| format!("invalid spec JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_spec() {
        let json = r#"{"command":"echo hi","strict":true,
            "ro":["/etc"],"rox":["/usr"],"rw":["/tmp"]}"#;
        let spec = parse_spec(json).expect("parse");
        assert_eq!(spec.command, "echo hi");
        assert!(spec.strict);
        assert_eq!(spec.ro, vec!["/etc".to_string()]);
        assert_eq!(spec.rox, vec!["/usr".to_string()]);
        assert_eq!(spec.rw, vec!["/tmp".to_string()]);
    }

    #[test]
    fn strict_defaults_true_and_grants_default_empty() {
        let spec = parse_spec(r#"{"command":"true"}"#).expect("parse");
        assert!(spec.strict);
        assert!(spec.ro.is_empty() && spec.rox.is_empty() && spec.rw.is_empty());
    }

    #[test]
    fn rejects_malformed_json() {
        let err = parse_spec("{ not json").unwrap_err();
        assert!(err.contains("invalid spec JSON"));
    }
}
```

Add `mod spec;` to `native/rd-landlock/src/main.rs` (below the `#![deny(unsafe_code)]` line):

```rust
#![deny(unsafe_code)]

mod spec;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd native/rd-landlock && cargo test spec::`
Expected: compiles and the three `spec::tests::*` PASS (this is pure logic with no missing symbols; if `serde` derive is misconfigured it FAILS to compile — fix until green).

- [ ] **Step 3: (implementation already complete in Step 1)**

No further code — `parse_spec` is the minimal implementation.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd native/rd-landlock && cargo test spec::`
Expected: `test result: ok. 3 passed`

- [ ] **Step 5: Commit**

```bash
git add native/rd-landlock/src/spec.rs native/rd-landlock/src/main.rs
git commit -m "feat(rd-landlock): fd-3 spec model and JSON parsing (#413)"
```

---

## Task 3: Required-ABI derivation

**Files:**
- Create: `native/rd-landlock/src/abi.rs`
- Modify: `native/rd-landlock/src/main.rs`

**Interfaces:**
- Consumes: `spec::Spec` (Task 2).
- Produces: `pub fn required_abi(spec: &Spec) -> u32`

- [ ] **Step 1: Write the failing test**

Create `native/rd-landlock/src/abi.rs`:

```rust
//! ABI math: required-floor derivation, per-grant rights sets, and the
//! fail-closed decision. Pure logic — no syscalls.

use crate::spec::Spec;

/// Derive the required Landlock ABI floor from the policy.
///
/// `1` is baseline (any filesystem enforcement). The floor rises to `3`
/// (`TRUNCATE`, kernel 6.2) as soon as the spec has any non-writable grant
/// (`ro` or `rox`), because a truncatable read-only path is not read-only.
pub fn required_abi(spec: &Spec) -> u32 {
    if spec.ro.is_empty() && spec.rox.is_empty() {
        1
    } else {
        3
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::parse_spec;

    #[test]
    fn floor_is_three_when_any_readonly_grant_present() {
        let spec = parse_spec(r#"{"command":"x","rox":["/usr"]}"#).unwrap();
        assert_eq!(required_abi(&spec), 3);
    }

    #[test]
    fn floor_is_three_for_ro_only() {
        let spec = parse_spec(r#"{"command":"x","ro":["/etc"]}"#).unwrap();
        assert_eq!(required_abi(&spec), 3);
    }

    #[test]
    fn floor_is_one_for_all_writable_policy() {
        let spec = parse_spec(r#"{"command":"x","rw":["/tmp"]}"#).unwrap();
        assert_eq!(required_abi(&spec), 1);
    }
}
```

Add `mod abi;` to `native/rd-landlock/src/main.rs`:

```rust
#![deny(unsafe_code)]

mod abi;
mod spec;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd native/rd-landlock && cargo test abi::tests::floor`
Expected: PASS on compile (pure logic). If `abi` is not declared in `main.rs`, compile FAILS with `unresolved module` — add the `mod abi;` line.

- [ ] **Step 3: (implementation complete in Step 1)**

- [ ] **Step 4: Run test to verify it passes**

Run: `cd native/rd-landlock && cargo test abi::tests::floor`
Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add native/rd-landlock/src/abi.rs native/rd-landlock/src/main.rs
git commit -m "feat(rd-landlock): derive required ABI floor from policy (#413)"
```

---

## Task 4: Per-grant rights sets

**Files:**
- Modify: `native/rd-landlock/src/abi.rs`

**Interfaces:**
- Consumes: the `landlock` crate's `ABI`, `AccessFs`, `BitFlags`.
- Produces:
  - `pub fn abi_from_u32(n: u32) -> ABI`
  - `pub fn ro_access() -> BitFlags<AccessFs>`
  - `pub fn rox_access() -> BitFlags<AccessFs>`
  - `pub fn rw_access(abi: ABI) -> BitFlags<AccessFs>`

- [ ] **Step 1: Write the failing test**

Append to `native/rd-landlock/src/abi.rs` (add imports at the top of the file, after the existing `use`):

```rust
use landlock::{Access, AccessFs, BitFlags, ABI};
```

Then add the functions:

```rust
/// Map a negotiated numeric ABI to the `landlock` crate's `ABI` enum, clamped
/// to the highest variant this build knows about.
pub fn abi_from_u32(n: u32) -> ABI {
    match n {
        0 | 1 => ABI::V1,
        2 => ABI::V2,
        3 => ABI::V3,
        4 => ABI::V4,
        _ => ABI::V5,
    }
}

/// Read-only rights: read a file and list a directory, nothing else.
/// Deliberately excludes EXECUTE and TRUNCATE so the path cannot be run or
/// emptied. These two flags are ABI-v1 stable, so a literal is correct.
pub fn ro_access() -> BitFlags<AccessFs> {
    AccessFs::ReadFile | AccessFs::ReadDir
}

/// Read + execute rights: the read-only set plus EXECUTE (for `/usr`, `/bin`, …).
pub fn rox_access() -> BitFlags<AccessFs> {
    ro_access() | AccessFs::Execute
}

/// Full write set: everything the negotiated ABI supports *except* EXECUTE.
/// Built from `AccessFs::from_all(abi)` so new ABI rights are covered
/// automatically; matches `landrun --rw` (not `--rwx`). WRITE_FILE and TRUNCATE
/// are paired here so `>` truncation still works once TRUNCATE is in the
/// handled set.
pub fn rw_access(abi: ABI) -> BitFlags<AccessFs> {
    AccessFs::from_all(abi) & !AccessFs::Execute
}

#[cfg(test)]
mod rights_tests {
    use super::*;

    #[test]
    fn ro_is_read_only_no_exec_no_truncate() {
        let ro = ro_access();
        assert!(ro.contains(AccessFs::ReadFile));
        assert!(ro.contains(AccessFs::ReadDir));
        assert!(!ro.contains(AccessFs::Execute));
        assert!(!ro.contains(AccessFs::Truncate));
        assert!(!ro.contains(AccessFs::WriteFile));
    }

    #[test]
    fn rox_adds_execute_to_ro() {
        assert_eq!(rox_access(), ro_access() | AccessFs::Execute);
    }

    #[test]
    fn rw_has_full_write_set_and_truncate_but_no_execute() {
        let rw = rw_access(ABI::V3);
        assert!(rw.contains(AccessFs::WriteFile));
        assert!(rw.contains(AccessFs::Truncate));
        assert!(rw.contains(AccessFs::RemoveFile));
        assert!(rw.contains(AccessFs::RemoveDir));
        assert!(rw.contains(AccessFs::MakeReg));
        assert!(!rw.contains(AccessFs::Execute));
    }

    #[test]
    fn rw_includes_refer_at_abi_v2_and_above() {
        assert!(rw_access(ABI::V2).contains(AccessFs::Refer));
        assert!(rw_access(ABI::V3).contains(AccessFs::Refer));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd native/rd-landlock && cargo test abi::rights_tests`
Expected: compile error if any `AccessFs` variant name differs from the installed `landlock` version (e.g. `Truncate` vs `TruncateFile`). Resolve variant names against `cargo doc -p landlock --open` until it compiles, then all 4 PASS.

- [ ] **Step 3: (implementation complete in Step 1)**

- [ ] **Step 4: Run test to verify it passes**

Run: `cd native/rd-landlock && cargo test abi::rights_tests`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add native/rd-landlock/src/abi.rs
git commit -m "feat(rd-landlock): per-grant rights sets (ro/rox/rw) (#413)"
```

---

## Task 5: Fail-closed decision

**Files:**
- Modify: `native/rd-landlock/src/abi.rs`

**Interfaces:**
- Consumes: `required_abi` (Task 3).
- Produces:
  - `pub enum Decision { Apply { downgraded: bool }, Deny { missing: &'static str } }`
  - `pub fn decide(negotiated: u32, required: u32, strict: bool) -> Decision`

- [ ] **Step 1: Write the failing test**

Append to `native/rd-landlock/src/abi.rs`:

```rust
/// Outcome of comparing the negotiated ABI against the required floor.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Apply the ruleset and exec. `downgraded` is true only when the
    /// negotiated ABI is below the required floor and strict was disabled.
    Apply { downgraded: bool },
    /// Refuse: negotiated ABI is below the required floor under strict mode.
    /// `missing` names the first right that cannot be enforced.
    Deny { missing: &'static str },
}

/// Fail-closed decision, atomic with the syscall that read `negotiated`.
///
/// * negotiated ≥ required → apply, not downgraded.
/// * negotiated < required, strict → deny (naming the missing right).
/// * negotiated < required, !strict → apply best-effort, downgraded.
pub fn decide(negotiated: u32, required: u32, strict: bool) -> Decision {
    if negotiated >= required {
        Decision::Apply { downgraded: false }
    } else if strict {
        // required rises to 3 only for TRUNCATE, so TRUNCATE is the gap.
        Decision::Deny { missing: "TRUNCATE" }
    } else {
        Decision::Apply { downgraded: true }
    }
}

#[cfg(test)]
mod decision_tests {
    use super::*;

    #[test]
    fn applies_when_negotiated_meets_floor() {
        assert_eq!(decide(3, 3, true), Decision::Apply { downgraded: false });
        assert_eq!(decide(5, 3, true), Decision::Apply { downgraded: false });
    }

    #[test]
    fn denies_below_floor_under_strict() {
        assert_eq!(decide(2, 3, true), Decision::Deny { missing: "TRUNCATE" });
    }

    #[test]
    fn downgrades_below_floor_when_not_strict() {
        assert_eq!(decide(2, 3, false), Decision::Apply { downgraded: true });
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd native/rd-landlock && cargo test abi::decision_tests`
Expected: PASS on compile. (Pure logic; fails only if a symbol is mistyped.)

- [ ] **Step 3: (implementation complete in Step 1)**

- [ ] **Step 4: Run test to verify it passes**

Run: `cd native/rd-landlock && cargo test abi::decision_tests`
Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add native/rd-landlock/src/abi.rs
git commit -m "feat(rd-landlock): fail-closed strict/downgrade decision (#413)"
```

---

## Task 6: Typed status + serialization

**Files:**
- Create: `native/rd-landlock/src/status.rs`
- Modify: `native/rd-landlock/src/main.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub enum Status { Applied { abi: u32, downgraded: bool }, Denied { abi: u32, missing: String }, Error { message: String } }`
  - `pub fn to_status_line(status: &Status) -> String` (single line, trailing `\n`)

- [ ] **Step 1: Write the failing test**

Create `native/rd-landlock/src/status.rs`:

```rust
//! The single typed status line written to fd 4 before any exec.

use serde::Serialize;

/// Typed fd-4 status. Serialized as a tagged JSON object on the `status` key.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Status {
    /// Ruleset applied; `abi` is the negotiated ABI actually enforced.
    Applied { abi: u32, downgraded: bool },
    /// Policy refused: `abi` fell below the required floor; `missing` names the gap.
    Denied { abi: u32, missing: String },
    /// The helper failed before applying/execing; enforcement state unknown.
    Error { message: String },
}

/// Render the status as exactly one newline-terminated JSON line.
pub fn to_status_line(status: &Status) -> String {
    let body = serde_json::to_string(status)
        .unwrap_or_else(|_| r#"{"status":"error","message":"status serialize failed"}"#.to_string());
    format!("{body}\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applied_line_carries_abi_and_downgraded() {
        let line = to_status_line(&Status::Applied { abi: 3, downgraded: false });
        assert_eq!(line, "{\"status\":\"applied\",\"abi\":3,\"downgraded\":false}\n");
    }

    #[test]
    fn denied_line_names_missing_right() {
        let line = to_status_line(&Status::Denied { abi: 2, missing: "TRUNCATE".into() });
        assert_eq!(
            line,
            "{\"status\":\"denied\",\"abi\":2,\"missing\":\"TRUNCATE\"}\n"
        );
    }

    #[test]
    fn error_line_carries_message() {
        let line = to_status_line(&Status::Error { message: "boom".into() });
        assert_eq!(line, "{\"status\":\"error\",\"message\":\"boom\"}\n");
    }
}
```

Add `mod status;` to `native/rd-landlock/src/main.rs`:

```rust
#![deny(unsafe_code)]

mod abi;
mod spec;
mod status;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd native/rd-landlock && cargo test status::`
Expected: PASS on compile. If serde emits keys in a different order, the exact-string asserts FAIL — adjust the expected strings to serde's emitted order (serde preserves struct field declaration order, so the above holds).

- [ ] **Step 3: (implementation complete in Step 1)**

- [ ] **Step 4: Run test to verify it passes**

Run: `cd native/rd-landlock && cargo test status::`
Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add native/rd-landlock/src/status.rs native/rd-landlock/src/main.rs
git commit -m "feat(rd-landlock): typed fd-4 status serialization (#413)"
```

---

## Task 7: Audited `sys` module (ABI read + fd wiring + CLOEXEC)

**Files:**
- Create: `native/rd-landlock/src/sys.rs`
- Modify: `native/rd-landlock/src/main.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub fn read_abi_version() -> Result<u32, String>` — the numeric negotiated ABI (0 if syscall unsupported).
  - `pub fn spec_reader() -> Result<std::fs::File, String>` — owned handle to fd 3, with `FD_CLOEXEC` set.
  - `pub fn status_writer() -> Result<std::fs::File, String>` — owned handle to fd 4, with `FD_CLOEXEC` set.

- [ ] **Step 1: Write the failing test**

Create `native/rd-landlock/src/sys.rs`:

```rust
//! The single module permitted to use `unsafe`. It contains only the raw
//! syscalls the safe `landlock`/`std` wrappers cannot express: the numeric
//! Landlock ABI probe and borrowing the inherited fds 3/4 with FD_CLOEXEC.
#![allow(unsafe_code)]

use std::fs::File;
use std::os::fd::{FromRawFd, RawFd};

const SPEC_FD: RawFd = 3;
const STATUS_FD: RawFd = 4;
const LANDLOCK_CREATE_RULESET_VERSION: libc::c_ulong = 1;

/// Read the kernel's supported Landlock ABI via
/// `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`.
///
/// Returns the version integer (≥ 1) on success, `Ok(0)` when the syscall is
/// unavailable (`ENOSYS`/`EPERM` — e.g. container seccomp), or `Err` for any
/// other errno.
pub fn read_abi_version() -> Result<u32, String> {
    // SAFETY: null attr pointer with size 0 is the documented ABI-probe form;
    // it creates no ruleset and returns the supported version.
    let ret = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    if ret >= 0 {
        return Ok(ret as u32);
    }
    let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    match errno {
        libc::ENOSYS | libc::EPERM | libc::EOPNOTSUPP => Ok(0),
        _ => Err(format!("landlock_create_ruleset probe failed: errno {errno}")),
    }
}

fn set_cloexec(fd: RawFd) -> Result<(), String> {
    // SAFETY: fcntl on a valid inherited fd; failure is reported, not ignored.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(format!("F_GETFD on fd {fd} failed"));
    }
    let rc = unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) };
    if rc < 0 {
        return Err(format!("F_SETFD FD_CLOEXEC on fd {fd} failed"));
    }
    Ok(())
}

/// Owned reader over inherited fd 3, marked FD_CLOEXEC so it closes at exec.
pub fn spec_reader() -> Result<File, String> {
    set_cloexec(SPEC_FD)?;
    // SAFETY: fd 3 is inherited from the parent per the spawn contract.
    Ok(unsafe { File::from_raw_fd(SPEC_FD) })
}

/// Owned writer over inherited fd 4, marked FD_CLOEXEC so it closes at exec.
pub fn status_writer() -> Result<File, String> {
    set_cloexec(STATUS_FD)?;
    // SAFETY: fd 4 is inherited from the parent per the spawn contract.
    Ok(unsafe { File::from_raw_fd(STATUS_FD) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_read_is_non_negative() {
        // Host-independent: on a Landlock host returns ≥ 1; on a non-Landlock
        // host returns Ok(0). Never errors on the common ENOSYS/EPERM path.
        let abi = read_abi_version().expect("probe returns Ok on supported errnos");
        assert!(abi <= 16, "sanity bound on ABI version");
    }
}
```

Add `mod sys;` to `native/rd-landlock/src/main.rs`:

```rust
#![deny(unsafe_code)]

mod abi;
mod spec;
mod status;
mod sys;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd native/rd-landlock && cargo test sys::`
Expected: compile succeeds only because `sys.rs` opens with `#![allow(unsafe_code)]`; if that inner attribute is missing the crate-level `#![deny(unsafe_code)]` FAILS the build. With it present, `abi_read_is_non_negative` PASSES on any host.

- [ ] **Step 3: (implementation complete in Step 1)**

- [ ] **Step 4: Run test to verify it passes**

Run: `cd native/rd-landlock && cargo test sys::`
Expected: `1 passed`

- [ ] **Step 5: Commit**

```bash
git add native/rd-landlock/src/sys.rs native/rd-landlock/src/main.rs
git commit -m "feat(rd-landlock): audited sys module for ABI probe and fd wiring (#413)"
```

---

## Task 8: Ruleset application

**Files:**
- Create: `native/rd-landlock/src/ruleset.rs`
- Modify: `native/rd-landlock/src/main.rs`

**Interfaces:**
- Consumes: `spec::Spec`, `abi::{abi_from_u32, ro_access, rox_access, rw_access}`.
- Produces: `pub fn apply_ruleset(negotiated: u32, spec: &Spec) -> Result<(), String>` — builds the ruleset (handled = `from_all(abi)`), adds per-grant path rules, sets `no_new_privs`, and calls `restrict_self`.

- [ ] **Step 1: Write the failing test (gated enforcement)**

Create `native/rd-landlock/src/ruleset.rs`:

```rust
//! Ruleset construction and application. The only enforcement code path.

use landlock::{
    path_beneath_rules, Access, AccessFs, Ruleset, RulesetAttr, RulesetCreatedAttr, ABI,
};

use crate::abi::{abi_from_u32, ro_access, rox_access, rw_access};
use crate::spec::Spec;

/// Build and apply the Landlock ruleset to the current thread.
///
/// The handled set is `AccessFs::from_all(abi)` so every access type is
/// governed and denied unless a rule grants it. Non-existent grant paths are
/// skipped (Landlock aborts on a missing path). `no_new_privs` is set true
/// (default), applied before `restrict_self`.
pub fn apply_ruleset(negotiated: u32, spec: &Spec) -> Result<(), String> {
    let abi: ABI = abi_from_u32(negotiated);
    let handled = AccessFs::from_all(abi);

    let rox: Vec<&String> = spec.rox.iter().filter(|p| exists(p)).collect();
    let ro: Vec<&String> = spec.ro.iter().filter(|p| exists(p)).collect();
    let rw: Vec<&String> = spec.rw.iter().filter(|p| exists(p)).collect();

    Ruleset::default()
        .handle_access(handled)
        .map_err(|e| format!("handle_access failed: {e}"))?
        .create()
        .map_err(|e| format!("ruleset create failed: {e}"))?
        .add_rules(path_beneath_rules(rox.iter().map(|p| p.as_str()), rox_access()))
        .map_err(|e| format!("add rox rules failed: {e}"))?
        .add_rules(path_beneath_rules(ro.iter().map(|p| p.as_str()), ro_access()))
        .map_err(|e| format!("add ro rules failed: {e}"))?
        .add_rules(path_beneath_rules(rw.iter().map(|p| p.as_str()), rw_access(abi)))
        .map_err(|e| format!("add rw rules failed: {e}"))?
        .set_no_new_privs(true)
        .restrict_self()
        .map_err(|e| format!("restrict_self failed: {e}"))?;
    Ok(())
}

fn exists(path: &str) -> bool {
    std::path::Path::new(path).exists()
}
```

Add `mod ruleset;` to `native/rd-landlock/src/main.rs`:

```rust
#![deny(unsafe_code)]

mod abi;
mod ruleset;
mod spec;
mod status;
mod sys;
```

Create `native/rd-landlock/tests/enforcement.rs`:

```rust
//! Real-kernel enforcement tests. `#[ignore]` by default; run explicitly with
//! `cargo test --test enforcement -- --ignored` on a Landlock ≥ v3 host, or in
//! CI via `RUNDOWN_REQUIRE_LANDLOCK=1`.

use std::process::Command;

/// Path to the built helper. Set by the harness invocation.
fn helper() -> String {
    env!("CARGO_BIN_EXE_rd-landlock").to_string()
}

/// Run the helper with a spec on fd 3 and capture the fd-4 status + child exit.
/// Returns (fd4_status_line, exit_code).
fn run_with_spec(spec_json: &str) -> (String, i32) {
    // Test harness lives in tests/support.rs (Task 11 adds richer helpers).
    // Minimal inline runner for this task:
    use std::io::Write;
    use std::os::unix::io::{AsRawFd, FromRawFd};
    let (spec_r, mut spec_w) = os_pipe::pipe().expect("spec pipe");
    let (status_r, status_w) = os_pipe::pipe().expect("status pipe");
    let mut cmd = Command::new(helper());
    // fds 3 and 4 wired via file_descriptor mapping.
    cmd.stdin(std::process::Stdio::null());
    // See Task 11 for the full os_pipe wiring; here we assert only that a denied
    // read is blocked. This test is #[ignore]d and finalised in Task 11.
    let _ = (spec_r, &mut spec_w, status_r, status_w, spec_json);
    let _ = cmd;
    (String::new(), 0)
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel"]
fn denied_read_returns_eacces() {
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("secret.txt");
    std::fs::write(&secret, "x").unwrap();
    let spec = format!(
        r#"{{"command":"cat {}","strict":true,"rox":["/usr","/bin","/lib","/lib64"],"ro":["/etc"]}}"#,
        secret.display()
    );
    let (status, code) = run_with_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""));
    assert_ne!(code, 0, "reading an ungranted path must fail under Landlock");
}
```

Add dev-dependencies to `native/rd-landlock/Cargo.toml`:

```toml
[dev-dependencies]
tempfile = "3"
os_pipe = "1"
```

- [ ] **Step 2: Run test to verify it fails / builds**

Run: `cd native/rd-landlock && cargo test --no-run`
Expected: the crate and the (ignored) enforcement test compile. `apply_ruleset` compiles against the installed `landlock` API — resolve any method-name drift (`set_no_new_privs`, `restrict_self`) via `cargo doc -p landlock` until it builds.

- [ ] **Step 3: (implementation complete in Step 1)**

- [ ] **Step 4: Run test to verify it passes on a Landlock host**

Run (Linux ≥ 6.2 only): `cd native/rd-landlock && cargo test --test enforcement -- --ignored denied_read`
Expected on a Landlock host after Task 11 finalises the runner: PASS. On a non-Landlock host the test is skipped (still `#[ignore]`).

- [ ] **Step 5: Commit**

```bash
git add native/rd-landlock/src/ruleset.rs native/rd-landlock/src/main.rs native/rd-landlock/tests/enforcement.rs native/rd-landlock/Cargo.toml
git commit -m "feat(rd-landlock): build and apply Landlock ruleset (#413)"
```

---

## Task 9: main orchestration (fd read → decide → apply → status → exec)

**Files:**
- Modify: `native/rd-landlock/src/main.rs`

**Interfaces:**
- Consumes: `spec::parse_spec`, `abi::{required_abi, decide, Decision}`, `status::{Status, to_status_line}`, `sys::{read_abi_version, spec_reader, status_writer}`, `ruleset::apply_ruleset`.
- Produces: a runnable helper: reads fd 3, writes exactly one fd-4 status line, and on `applied` `exec`s `/bin/sh -c <command>` (never returns); on `denied`/`error` exits non-zero without exec.

- [ ] **Step 1: Write the implementation (behaviour verified by core TS fake-helper tests in Tasks 14-19 and the gated Rust test in Task 11)**

Replace `native/rd-landlock/src/main.rs` body with:

```rust
#![deny(unsafe_code)]

mod abi;
mod probe;
mod ruleset;
mod spec;
mod status;
mod sys;

use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::process::Command;

use abi::{decide, required_abi, Decision};
use status::{to_status_line, Status};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("rd-landlock {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.iter().any(|a| a == "--probe") {
        probe::run();
        return;
    }
    std::process::exit(run());
}

/// Full protocol run. Returns the process exit code for `denied`/`error`
/// outcomes; on `applied` it `exec`s and never returns.
fn run() -> i32 {
    let mut status_out = match sys::status_writer() {
        Ok(f) => f,
        Err(e) => {
            eprintln!("rd-landlock: {e}");
            return 71; // EX_OSERR — no status channel to report on.
        }
    };

    let outcome = compute();
    let status = match &outcome {
        Ok((status, _spec)) => status.clone(),
        Err(status) => status.clone(),
    };
    // Write exactly one status line before any exec.
    let _ = status_out.write_all(to_status_line(&status).as_bytes());
    let _ = status_out.flush();

    match outcome {
        Ok((Status::Applied { .. }, spec)) => {
            // Never returns on success; the command *becomes* the process.
            let err = Command::new("/bin/sh").arg("-c").arg(&spec.command).exec();
            eprintln!("rd-landlock: exec failed: {err}");
            127
        }
        Ok((Status::Denied { .. }, _)) => 126,
        _ => 1,
    }
}

/// Read + parse + decide + apply. Returns the applied status and spec on
/// success, or an already-typed error/denied status.
fn compute() -> Result<(Status, spec::Spec), Status> {
    let mut reader = sys::spec_reader().map_err(|e| Status::Error { message: e })?;
    let mut buf = String::new();
    reader
        .read_to_string(&mut buf)
        .map_err(|e| Status::Error { message: format!("read fd3: {e}") })?;
    let spec = spec::parse_spec(&buf).map_err(|e| Status::Error { message: e })?;

    let negotiated = sys::read_abi_version().map_err(|e| Status::Error { message: e })?;
    let required = required_abi(&spec);

    match decide(negotiated, required, spec.strict) {
        Decision::Deny { missing } => Err(Status::Denied {
            abi: negotiated,
            missing: missing.to_string(),
        }),
        Decision::Apply { downgraded } => {
            ruleset::apply_ruleset(negotiated, &spec)
                .map_err(|e| Status::Error { message: e })?;
            Ok((Status::Applied { abi: negotiated, downgraded }, spec))
        }
    }
}
```

Add `#[derive(Clone)]` to `Status` in `native/rd-landlock/src/status.rs` (needed by `run`):

```rust
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
```

- [ ] **Step 2: Run build to verify it compiles**

Run: `cd native/rd-landlock && cargo build`
Expected: `Finished`. (`probe::run` is defined in Task 10; if Task 10 is not yet done, temporarily stub `pub fn run() {}` in `src/probe.rs` — Task 10 replaces it.)

Create a temporary `native/rd-landlock/src/probe.rs`:

```rust
//! `--probe` self-test. Replaced with the full implementation in Task 10.
pub fn run() {}
```

- [ ] **Step 3: Verify `--version` still works and a bad invocation exits non-zero**

Run: `cd native/rd-landlock && cargo run -- --version && (cargo run; echo "exit=$?")`
Expected: prints `rd-landlock 0.1.0`; the second run exits non-zero (no fd 3 wired → status writer or spec read fails → non-zero).

- [ ] **Step 4: Commit**

```bash
git add native/rd-landlock/src/main.rs native/rd-landlock/src/status.rs native/rd-landlock/src/probe.rs
git commit -m "feat(rd-landlock): main protocol orchestration and exec (#413)"
```

---

## Task 10: `--probe` mode

**Files:**
- Modify: `native/rd-landlock/src/probe.rs`

**Interfaces:**
- Consumes: `sys::read_abi_version`, `ruleset::apply_ruleset`, `spec::Spec`.
- Produces: `pub fn run()` — prints one JSON line to **stdout** (`{"available":bool,"abi":N}`) and exits 0. Availability is proven by applying a ruleset in a forked child and confirming a denied read is blocked.

- [ ] **Step 1: Write the implementation**

Replace `native/rd-landlock/src/probe.rs`:

```rust
//! `--probe`: read the ABI, run a self-test (apply a ruleset in a child,
//! confirm a denied read returns EACCES), print JSON to stdout, exit 0.
//! Replaces the old spawn-`true`-then-`cat` probe and detects the
//! "container seccomp blocks landlock_*" false positive (abi == 0).

use std::process::Command;

use crate::spec::Spec;
use crate::sys::read_abi_version;

pub fn run() {
    let abi = read_abi_version().unwrap_or(0);
    let available = abi >= 1 && self_test(abi);
    println!("{{\"available\":{available},\"abi\":{abi}}}");
}

/// Apply a ruleset granting only system paths in a child, then attempt to read
/// a path that was NOT granted. The read must fail for enforcement to be real.
fn self_test(abi: u32) -> bool {
    let dir = match tempdir() {
        Some(d) => d,
        None => return false,
    };
    let secret = format!("{dir}/probe-secret");
    if std::fs::write(&secret, b"x").is_err() {
        return false;
    }
    // The self-test runs the helper itself recursively is avoided; instead we
    // fork a child that applies the ruleset then execs `cat <secret>`.
    let spec = Spec {
        command: format!("cat {secret} 2>/dev/null"),
        strict: false, // probe never refuses; it only measures enforcement.
        ro: vec!["/etc".to_string()],
        rox: system_paths(),
        rw: vec![],
    };
    // Run the ruleset+cat in a subshell child via a helper thread is complex;
    // reuse the child-process model: apply in *this* process is irreversible,
    // so spawn `/bin/sh -c cat` under a freshly-applied ruleset in a child.
    let child = Command::new("/bin/sh")
        .arg("-c")
        .arg(&spec.command)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .pre_exec_apply(abi, &spec);
    let denied = match child {
        Ok(status) => !status.success(),
        Err(_) => false,
    };
    let _ = std::fs::remove_dir_all(dir);
    denied
}

/// System exec paths that exist on this host.
fn system_paths() -> Vec<String> {
    ["/usr", "/bin", "/sbin", "/lib", "/lib64"]
        .into_iter()
        .filter(|p| std::path::Path::new(p).exists())
        .map(str::to_string)
        .collect()
}

fn tempdir() -> Option<String> {
    let base = std::env::temp_dir().join(format!("rd-landlock-probe-{}", std::process::id()));
    std::fs::create_dir_all(&base).ok()?;
    Some(base.to_string_lossy().into_owned())
}

/// Extension: run a command in a child that applies the ruleset before exec.
trait PreExecApply {
    fn pre_exec_apply(&mut self, abi: u32, spec: &Spec) -> std::io::Result<std::process::ExitStatus>;
}

impl PreExecApply for Command {
    fn pre_exec_apply(
        &mut self,
        abi: u32,
        spec: &Spec,
    ) -> std::io::Result<std::process::ExitStatus> {
        let abi_copy = abi;
        let spec_ro = spec.ro.clone();
        let spec_rox = spec.rox.clone();
        // Apply the ruleset in the child immediately before exec.
        crate::sys::pre_exec_ruleset(self, move || {
            let s = Spec {
                command: String::new(),
                strict: false,
                ro: spec_ro.clone(),
                rox: spec_rox.clone(),
                rw: vec![],
            };
            crate::ruleset::apply_ruleset(abi_copy, &s)
                .map_err(|e| std::io::Error::other(e))
        });
        self.status()
    }
}
```

Add a `pre_exec_ruleset` helper to the audited `native/rd-landlock/src/sys.rs`:

```rust
use std::os::unix::process::CommandExt;
use std::process::Command;

/// Register a closure to run in the forked child immediately before exec.
/// Isolated here because `pre_exec` is unsafe.
pub fn pre_exec_ruleset<F>(cmd: &mut Command, f: F)
where
    F: FnMut() -> std::io::Result<()> + Send + Sync + 'static,
{
    let mut f = f;
    // SAFETY: the closure only applies a Landlock ruleset (async-signal-safe
    // syscalls) and allocates no locks shared with the parent.
    unsafe {
        cmd.pre_exec(move || f());
    }
}
```

- [ ] **Step 2: Run build to verify it compiles**

Run: `cd native/rd-landlock && cargo build`
Expected: `Finished`. Resolve any `std::io::Error::other` availability (Rust ≥ 1.74) — replace with `std::io::Error::new(std::io::ErrorKind::Other, e)` if the toolchain is older.

- [ ] **Step 3: Verify probe prints JSON**

Run: `cd native/rd-landlock && cargo run -- --probe`
Expected on a non-Landlock dev host: `{"available":false,"abi":0}`. On a Landlock ≥ v3 host: `{"available":true,"abi":3}` (or higher).

- [ ] **Step 4: Commit**

```bash
git add native/rd-landlock/src/probe.rs native/rd-landlock/src/sys.rs
git commit -m "feat(rd-landlock): --probe self-test with enforcement measurement (#413)"
```

---

## Task 11: Gated Rust enforcement tests (truncate, full write set, unprivileged)

**Files:**
- Create: `native/rd-landlock/tests/support.rs`
- Modify: `native/rd-landlock/tests/enforcement.rs`

**Interfaces:**
- Consumes: the built `rd-landlock` binary (`CARGO_BIN_EXE_rd-landlock`).
- Produces: a `run_spec(spec_json) -> (StatusLine, i32)` harness that wires fds 3/4 exactly as core does, plus the full gated enforcement suite.

- [ ] **Step 1: Write the failing test + harness**

Create `native/rd-landlock/tests/support.rs`:

```rust
//! Shared fd-3/fd-4 harness for the gated enforcement tests. Mirrors core's
//! spawn contract: fds 0/1/2 inherited, fd 3 = spec-in, fd 4 = status-out.

use std::io::{Read, Write};
use std::process::{Command, Stdio};

/// Run the helper with `spec_json` on fd 3; return (fd4_status_line, exit_code).
pub fn run_spec(spec_json: &str) -> (String, i32) {
    let bin = env!("CARGO_BIN_EXE_rd-landlock");
    let (mut spec_r, mut spec_w) = os_pipe::pipe().expect("spec pipe");
    let (mut status_r, status_w) = os_pipe::pipe().expect("status pipe");

    let mut cmd = Command::new(bin);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    // Map the read end of the spec pipe to fd 3 and the write end of the status
    // pipe to fd 4 in the child.
    map_fd(&mut cmd, spec_r.try_clone().unwrap(), 3);
    map_fd(&mut cmd, status_w.try_clone().unwrap(), 4);
    drop(spec_r);

    let mut child = cmd.spawn().expect("spawn helper");
    drop(status_w);

    spec_w.write_all(spec_json.as_bytes()).expect("write spec");
    drop(spec_w); // EOF so the helper's read_to_string returns.

    let mut status = String::new();
    let _ = status_r.read_to_string(&mut status);
    let code = child.wait().expect("wait").code().unwrap_or(-1);
    (status, code)
}

fn map_fd<F: std::os::fd::IntoRawFd>(cmd: &mut Command, f: F, target: i32) {
    use std::os::fd::FromRawFd;
    use std::os::unix::process::CommandExt;
    let raw = f.into_raw_fd();
    // SAFETY (test harness only): dup the pipe end onto `target` in the child.
    unsafe {
        cmd.pre_exec(move || {
            if libc::dup2(raw, target) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let _ = unsafe { std::fs::File::from_raw_fd(raw) }; // keep fd owned until spawn
    std::mem::forget(unsafe { std::fs::File::from_raw_fd(raw) });
}
```

Add `libc` to `[dev-dependencies]` in `native/rd-landlock/Cargo.toml` (already a normal dep, but tests need it too — normal deps are visible to integration tests, so no change needed if `libc` is a normal dependency; confirm).

Replace `native/rd-landlock/tests/enforcement.rs`:

```rust
//! Real-kernel enforcement tests. `#[ignore]` unless run explicitly on a
//! Landlock >= v3 host: `cargo test --test enforcement -- --ignored`.

mod support;
use support::run_spec;

fn system_grants() -> String {
    r#""rox":["/usr","/bin","/sbin","/lib","/lib64"],"ro":["/etc"]"#.to_string()
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel"]
fn denied_read_is_blocked_and_status_applied() {
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("secret.txt");
    std::fs::write(&secret, "x").unwrap();
    let spec = format!(
        r#"{{"command":"cat {}","strict":true,{}}}"#,
        secret.display(),
        system_grants()
    );
    let (status, code) = run_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""), "status: {status}");
    assert_ne!(code, 0, "ungranted read must fail");
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel"]
fn truncate_blocked_on_readonly_grant() {
    let dir = tempfile::tempdir().unwrap();
    let ro = dir.path().join("ro");
    std::fs::create_dir(&ro).unwrap();
    let file = ro.join("keep.txt");
    std::fs::write(&file, "important").unwrap();
    // `: > file` truncates in place. Under a ro grant with ABI >= 3 it must fail.
    let spec = format!(
        r#"{{"command":": > {}","strict":true,{},"ro":["{}","/etc"]}}"#,
        file.display(),
        r#""rox":["/usr","/bin","/sbin","/lib","/lib64"]"#,
        ro.display()
    );
    let (status, code) = run_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""), "status: {status}");
    assert_ne!(code, 0, "truncate on a read-only grant must be blocked");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "important");
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel"]
fn full_write_set_works_on_readwrite_grant() {
    let dir = tempfile::tempdir().unwrap();
    let rw = dir.path().join("rw");
    let rw2 = dir.path().join("rw2");
    std::fs::create_dir(&rw).unwrap();
    std::fs::create_dir(&rw2).unwrap();
    std::fs::write(rw.join("old.txt"), "old").unwrap();
    // create (MAKE_REG) + overwrite/truncate (>) + delete (REMOVE_FILE) +
    // cross-dir rename (REFER, ABI >= 2), all under rw grants.
    let cmd = format!(
        "printf hi > {new} && printf x > {old} && rm {old} && mv {new} {moved}",
        new = rw.join("new.txt").display(),
        old = rw.join("old.txt").display(),
        moved = rw2.join("moved.txt").display(),
    );
    let spec = format!(
        r#"{{"command":"{}","strict":true,{},"rw":["{}","{}"]}}"#,
        cmd.replace('"', "\\\""),
        r#""rox":["/usr","/bin","/sbin","/lib","/lib64"],"ro":["/etc"]"#,
        rw.display(),
        rw2.display()
    );
    let (status, code) = run_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""), "status: {status}");
    assert_eq!(code, 0, "full write set must succeed on rw grants: {status}");
    assert!(rw2.join("moved.txt").exists());
}

#[test]
#[ignore = "requires a real Landlock >= v3 kernel, run as an unprivileged user"]
fn enforcement_works_unprivileged() {
    // Landlock is unprivileged by design; PR_SET_NO_NEW_PRIVS + restrict_self
    // must enforce without elevated capabilities. CI runs this job as a
    // non-root user (see ci.yml). Assert we are not uid 0, then reuse the
    // denied-read assertion.
    assert_ne!(unsafe_getuid(), 0, "run this test as an unprivileged user");
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("s.txt");
    std::fs::write(&secret, "x").unwrap();
    let spec = format!(
        r#"{{"command":"cat {}","strict":true,{}}}"#,
        secret.display(),
        system_grants()
    );
    let (status, code) = run_spec(&spec);
    assert!(status.contains("\"status\":\"applied\""));
    assert_ne!(code, 0);
}

fn unsafe_getuid() -> u32 {
    // SAFETY (test only): getuid is always safe and never fails.
    unsafe { libc::getuid() }
}
```

- [ ] **Step 2: Run test to verify it fails (compiles + skips off-kernel)**

Run: `cd native/rd-landlock && cargo test --test enforcement`
Expected: compiles; all four tests report `ignored` (0 run). This proves the suite compiles and is correctly gated.

- [ ] **Step 3: Run the gated suite on a Landlock host**

Run (Linux ≥ 6.2, non-root): `cd native/rd-landlock && cargo test --test enforcement -- --ignored`
Expected: `4 passed`.

- [ ] **Step 4: Commit**

```bash
git add native/rd-landlock/tests/support.rs native/rd-landlock/tests/enforcement.rs native/rd-landlock/Cargo.toml
git commit -m "test(rd-landlock): gated enforcement suite (truncate, write set, unprivileged) (#413)"
```

---

## Task 12: Additive DTO fields (`landlockAbi`, `enforcementDowngraded`)

**Files:**
- Modify: `packages/core/src/sandbox/types.ts:69-90` (`SandboxAvailability`), `:43-64` (`SandboxExecutionResult`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SandboxAvailability.landlockAbi?: number`
  - `SandboxExecutionResult.landlockAbi?: number`, `SandboxExecutionResult.enforcementDowngraded?: boolean`

- [ ] **Step 1: Write the failing test**

Create `packages/core/__tests__/sandbox/types.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import type {
  SandboxAvailability,
  SandboxExecutionResult,
} from '../../src/sandbox/types.js';

describe('sandbox DTO ABI fields', () => {
  it('SandboxAvailability carries the negotiated ABI', () => {
    const a: SandboxAvailability = {
      available: true,
      mechanism: 'landlock',
      platform: 'linux',
      supportsReadRestrictions: true,
      supportsWriteRestrictions: true,
      supportsDenyPaths: false,
      landlockAbi: 3,
    };
    expect(a.landlockAbi).toBe(3);
  });

  it('SandboxExecutionResult carries ABI + downgrade flag', () => {
    const r: SandboxExecutionResult = {
      success: true,
      exitCode: 0,
      sandboxed: true,
      landlockAbi: 3,
      enforcementDowngraded: false,
    };
    expect(r.landlockAbi).toBe(3);
    expect(r.enforcementDowngraded).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/types.test.ts`
Expected: FAIL — `Object literal may only specify known properties, and 'landlockAbi' does not exist in type 'SandboxAvailability'` (ts-jest type error).

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/sandbox/types.ts`, add to `SandboxExecutionResult` (after `stderr?`):

```typescript
  /** Negotiated Landlock ABI the command ran under (Linux only). */
  landlockAbi?: number;

  /** True if enforcement ran below the required ABI floor under the opt-out. */
  enforcementDowngraded?: boolean;
```

Add to `SandboxAvailability` (after `supportsDenyPaths`):

```typescript
  /** Negotiated Landlock ABI reported by the helper probe (Linux only). */
  landlockAbi?: number;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sandbox/types.ts packages/core/__tests__/sandbox/types.test.ts
git commit -m "feat(core): additive sandbox ABI DTO fields (#413)"
```

---

## Task 13: Arch resolver

**Files:**
- Modify: `packages/core/src/sandbox/linux.ts` (rewrite begins here)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function resolveHelperPath(arch: NodeJS.Architecture, distRoot: string): string | null` — returns `<distRoot>/native/linux-<x64|arm64>/rd-landlock` for allow-listed arches, `null` otherwise.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__tests__/sandbox/linux-helper-path.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import { resolveHelperPath } from '../../src/sandbox/linux.js';

describe('resolveHelperPath', () => {
  it('maps x64 to linux-x64', () => {
    expect(resolveHelperPath('x64', '/pkg/dist')).toBe(
      '/pkg/dist/native/linux-x64/rd-landlock',
    );
  });

  it('maps arm64 to linux-arm64', () => {
    expect(resolveHelperPath('arm64', '/pkg/dist')).toBe(
      '/pkg/dist/native/linux-arm64/rd-landlock',
    );
  });

  it('returns null for unsupported arches (never falls back to x64)', () => {
    expect(resolveHelperPath('ppc64', '/pkg/dist')).toBeNull();
    expect(resolveHelperPath('s390x', '/pkg/dist')).toBeNull();
    expect(resolveHelperPath('ia32', '/pkg/dist')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-helper-path.test.ts`
Expected: FAIL — `resolveHelperPath is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

Add to the top of `packages/core/src/sandbox/linux.ts` (keep the existing file for now; the full rewrite lands across Tasks 13-19):

```typescript
import { join } from 'node:path';

/** Allow-listed Node arch → bundled binary subdir. Never falls back. */
const ARCH_DIRS: Partial<Record<NodeJS.Architecture, string>> = {
  x64: 'linux-x64',
  arm64: 'linux-arm64',
};

/**
 * Resolve the bundled `rd-landlock` binary path for the given architecture.
 *
 * @param arch - `process.arch` value.
 * @param distRoot - The core package `dist` directory.
 * @returns Absolute helper path, or `null` for an unsupported architecture.
 */
export function resolveHelperPath(
  arch: NodeJS.Architecture,
  distRoot: string,
): string | null {
  const sub = ARCH_DIRS[arch];
  return sub ? join(distRoot, 'native', sub, 'rd-landlock') : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-helper-path.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sandbox/linux.ts packages/core/__tests__/sandbox/linux-helper-path.test.ts
git commit -m "feat(core): arch allow-list resolver for rd-landlock (#413)"
```

---

## Task 14: `getAvailability()` via `--probe`

**Files:**
- Modify: `packages/core/src/sandbox/linux.ts` (rewrite `LandlockSandbox`)
- Create: `packages/core/__tests__/sandbox/fixtures/fake-helper.mjs`

**Interfaces:**
- Consumes: `resolveHelperPath` (Task 13); `SandboxAvailability.landlockAbi` (Task 12).
- Produces:
  - `new LandlockSandbox(opts?: { helperPath?: string; distRoot?: string })` — `helperPath` overrides arch resolution for tests.
  - `getAvailability(): Promise<SandboxAvailability>` — runs `<helper> --probe`, parses `{"available":bool,"abi":N}`, caches, surfaces `landlockAbi`.

- [ ] **Step 1: Write the fake helper fixture + failing test**

Create `packages/core/__tests__/sandbox/fixtures/fake-helper.mjs`:

```javascript
#!/usr/bin/env node
// Parametrised fake rd-landlock helper for core unit tests. Behaviour is
// driven entirely by env vars so a single fixture covers every protocol path.
//
//   FAKE_PROBE_JSON       — JSON printed to stdout for `--probe` (default unavailable)
//   FAKE_STATUS_LINE      — exact fd-4 status line (no trailing newline needed)
//   FAKE_NO_STATUS=1      — write nothing to fd-4 (missing-status protocol violation)
//   FAKE_EXIT             — exit code after writing status (default 0)
//   FAKE_ECHO_SPEC_FD5=1  — copy the fd-3 spec back to fd 5 (spec-inspection tests)
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--probe')) {
  process.stdout.write(
    (process.env.FAKE_PROBE_JSON ?? '{"available":false,"abi":0}') + '\n',
  );
  process.exit(0);
}

// Read the spec from fd 3 (best-effort; tests that don't write it still run).
let spec = '';
try {
  spec = readFileSync(3, 'utf8');
} catch {
  /* no spec wired */
}
if (process.env.FAKE_ECHO_SPEC_FD5 === '1') {
  try {
    writeFileSync(5, spec);
  } catch {
    /* fd 5 not wired */
  }
}

if (process.env.FAKE_NO_STATUS !== '1') {
  const line = process.env.FAKE_STATUS_LINE ?? '{"status":"applied","abi":3,"downgraded":false}';
  try {
    writeFileSync(4, line + '\n');
  } catch {
    /* fd 4 not wired */
  }
}

process.exit(Number(process.env.FAKE_EXIT ?? '0'));
```

Create `packages/core/__tests__/sandbox/linux-availability.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import { LandlockSandbox } from '../../src/sandbox/linux.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

describe('LandlockSandbox.getAvailability (--probe)', () => {
  const original = process.platform;
  beforeEach(() =>
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }),
  );
  afterEach(() =>
    Object.defineProperty(process, 'platform', { value: original, configurable: true }),
  );

  it('reports available and surfaces the ABI when the probe says so', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":4}' },
    });
    const a = await sandbox.getAvailability();
    expect(a.available).toBe(true);
    expect(a.mechanism).toBe('landlock');
    expect(a.landlockAbi).toBe(4);
    expect(a.supportsDenyPaths).toBe(false);
  });

  it('reports unavailable when the probe says available:false', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":false,"abi":0}' },
    });
    const a = await sandbox.getAvailability();
    expect(a.available).toBe(false);
    expect(a.mechanism).toBe('none');
  });

  it('reports unavailable for an unsupported arch (no helper resolved)', async () => {
    const sandbox = new LandlockSandbox({ helperPath: null });
    const a = await sandbox.getAvailability();
    expect(a.available).toBe(false);
    expect(a.reason).toContain('unsupported');
  });

  it('memoizes availability', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    });
    const first = await sandbox.getAvailability();
    const second = await sandbox.getAvailability();
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-availability.test.ts`
Expected: FAIL — constructor does not accept options / `getAvailability` still uses landrun probe.

- [ ] **Step 3: Write minimal implementation**

Rewrite the `LandlockSandbox` class in `packages/core/src/sandbox/linux.ts`. Replace the entire class and the landrun helper functions (`probeLandlockWrapper`, `findLandlockWrapper`, `buildSystemPathArgs`, `buildDevicePathArgs`, `buildGrantArgs`, and the landrun execution) with the following. Keep `resolveHelperPath` and `ARCH_DIRS` from Task 13. Imports at the top:

```typescript
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { getErrorMessage } from '../errors.js';
import type {
  SandboxOptions,
  SandboxExecutionResult,
  SandboxAvailability,
  SandboxImplementation,
} from './types.js';

/** Options for constructing a LandlockSandbox. Test seams only. */
export interface LandlockSandboxOptions {
  /** Override the resolved helper path (`null` simulates unsupported arch). */
  helperPath?: string | null;
  /** Override the core `dist` root used for arch resolution. */
  distRoot?: string;
  /** Extra env for the `--probe` invocation (test seam). */
  probeEnv?: Record<string, string>;
}

/** Default dist root: two levels up from this compiled module (dist/sandbox/). */
function defaultDistRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
```

Then the class:

```typescript
export class LandlockSandbox implements SandboxImplementation {
  private availabilityCache: SandboxAvailability | null = null;
  private readonly helperPath: string | null;
  private readonly probeEnv: Record<string, string>;

  constructor(opts: LandlockSandboxOptions = {}) {
    const distRoot = opts.distRoot ?? defaultDistRoot();
    this.helperPath =
      opts.helperPath !== undefined
        ? opts.helperPath
        : resolveHelperPath(process.arch, distRoot);
    this.probeEnv = opts.probeEnv ?? {};
  }

  async isAvailable(): Promise<boolean> {
    return (await this.getAvailability()).available;
  }

  getAvailability(): Promise<SandboxAvailability> {
    if (this.availabilityCache) {
      return Promise.resolve(this.availabilityCache);
    }
    this.availabilityCache = this.computeAvailability();
    return Promise.resolve(this.availabilityCache);
  }

  private computeAvailability(): SandboxAvailability {
    const unavailable = (reason: string): SandboxAvailability => ({
      available: false,
      mechanism: 'none',
      reason,
      platform: process.platform,
      supportsReadRestrictions: false,
      supportsWriteRestrictions: false,
      supportsDenyPaths: false,
    });

    if (process.platform !== 'linux') {
      return unavailable('Landlock is only available on Linux');
    }
    if (!this.helperPath) {
      return unavailable(`Landlock unavailable: unsupported architecture ${process.arch}`);
    }
    if (!existsSync(this.helperPath)) {
      return unavailable(`Landlock unavailable: bundled helper missing at ${this.helperPath}`);
    }

    const probe = spawnSync(this.helperPath, ['--probe'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      env: { ...process.env, ...this.probeEnv },
    });
    if (probe.status !== 0 || probe.error != null || !probe.stdout) {
      return unavailable('Landlock unavailable: rd-landlock --probe failed to run');
    }
    let parsed: { available?: boolean; abi?: number };
    try {
      parsed = JSON.parse(probe.stdout.trim());
    } catch {
      return unavailable('Landlock unavailable: rd-landlock --probe returned malformed JSON');
    }
    if (parsed.available !== true) {
      return unavailable(
        'Landlock unavailable: the kernel does not enforce Landlock (probe reported unavailable). ' +
          'Requires Linux 6.2+ with the Landlock LSM enabled and landlock_* syscalls permitted.',
      );
    }
    return {
      available: true,
      mechanism: 'landlock',
      platform: process.platform,
      supportsReadRestrictions: true,
      supportsWriteRestrictions: true,
      supportsDenyPaths: false,
      landlockAbi: parsed.abi,
    };
  }

  // execute() is filled in across Tasks 15-19.
  async execute(command: string, options: SandboxOptions): Promise<SandboxExecutionResult> {
    void command;
    void options;
    throw new Error('not implemented until Task 17');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-availability.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sandbox/linux.ts packages/core/__tests__/sandbox/fixtures/fake-helper.mjs packages/core/__tests__/sandbox/linux-availability.test.ts
git commit -m "feat(core): rd-landlock probe-based availability (#413)"
```

---

## Task 15: `execute()` deny-path preflight

**Files:**
- Modify: `packages/core/src/sandbox/linux.ts` (`execute`)

**Interfaces:**
- Consumes: `SandboxOptions.denyPaths`, `.denyPatterns`.
- Produces: `execute()` returns `{ success:false, exitCode:126, sandboxed:false, policyDenied:true, denialReason }` when deny policy is present, **before** spawning the helper.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__tests__/sandbox/linux-deny-preflight.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import { LandlockSandbox } from '../../src/sandbox/linux.js';
import type { SandboxOptions } from '../../src/sandbox/types.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

const base: SandboxOptions = {
  cwd: '/tmp',
  repoRoot: '/tmp',
  readOnlyPaths: [],
  readWritePaths: [],
  denyPaths: [],
  denyPatterns: [],
  env: {},
  allowUnsandboxed: false,
};

describe('LandlockSandbox.execute deny-path preflight', () => {
  const original = process.platform;
  beforeEach(() =>
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }),
  );
  afterEach(() =>
    Object.defineProperty(process, 'platform', { value: original, configurable: true }),
  );

  it('blocks denyPaths with exit 126 before spawning the helper', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    });
    const r = await sandbox.execute('echo hi', { ...base, denyPaths: ['/secret'] });
    expect(r.exitCode).toBe(126);
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
    expect(r.success).toBe(false);
  });

  it('blocks denyPatterns with exit 126', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    });
    const r = await sandbox.execute('echo hi', { ...base, denyPatterns: ['*.secret'] });
    expect(r.exitCode).toBe(126);
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-deny-preflight.test.ts`
Expected: FAIL — `execute` throws `not implemented until Task 17`.

- [ ] **Step 3: Write minimal implementation**

Replace the placeholder `execute` in `packages/core/src/sandbox/linux.ts`:

```typescript
  async execute(command: string, options: SandboxOptions): Promise<SandboxExecutionResult> {
    // Deny preflight: Landlock is allow-list-only and cannot carve a deny
    // exception out of an allowed subtree, so any deny policy is unenforceable
    // and must block *before* the helper is spawned (preserves linux.ts:320).
    if (options.denyPatterns.length > 0 || options.denyPaths.length > 0) {
      return {
        success: false,
        exitCode: 126,
        sandboxed: false,
        policyDenied: true,
        denialReason:
          'Linux sandbox backend cannot safely enforce deny-path policy. ' +
          'Execution was blocked to avoid weakening policy. Disable sandbox only for trusted runs.',
      };
    }

    const availability = await this.getAvailability();
    if (!availability.available) {
      return {
        success: false,
        exitCode: 126,
        sandboxed: false,
        policyDenied: true,
        denialReason: availability.reason,
      };
    }

    return this.runHelper(command, options); // filled in Task 17
  }

  private runHelper(
    _command: string,
    _options: SandboxOptions,
  ): Promise<SandboxExecutionResult> {
    throw new Error('not implemented until Task 17');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-deny-preflight.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sandbox/linux.ts packages/core/__tests__/sandbox/linux-deny-preflight.test.ts
git commit -m "feat(core): preserve deny-path preflight on rd-landlock backend (#413)"
```

---

## Task 16: Spec builder (grant categories → JSON)

**Files:**
- Modify: `packages/core/src/sandbox/linux.ts`

**Interfaces:**
- Consumes: `SandboxOptions`.
- Produces: `export function buildSpec(command: string, options: SandboxOptions): { command: string; strict: boolean; ro: string[]; rox: string[]; rw: string[] }` — `rox` = existing system exec paths; `ro` = existing policy read paths + existing system read paths (`/etc`); `rw` = existing policy write paths + existing device nodes; `strict = !allowUnsandboxed`; all filtered to existing paths.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__tests__/sandbox/linux-spec-builder.test.ts`:

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const actualFs = await import('node:fs');
jest.unstable_mockModule('node:fs', () => ({
  ...actualFs,
  existsSync: jest.fn(),
}));
const { existsSync } = await import('node:fs');
const { buildSpec } = await import('../../src/sandbox/linux.js');
import type { SandboxOptions } from '../../src/sandbox/types.js';

const base: SandboxOptions = {
  cwd: '/repo',
  repoRoot: '/repo',
  readOnlyPaths: ['/repo'],
  readWritePaths: ['/repo/dist'],
  denyPaths: [],
  denyPatterns: [],
  env: {},
  allowUnsandboxed: false,
};

describe('buildSpec', () => {
  beforeEach(() => jest.clearAllMocks());

  it('classifies grants and derives strict from allowUnsandboxed', () => {
    (existsSync as jest.Mock).mockReturnValue(true);
    const spec = buildSpec('echo hi', base);
    expect(spec.command).toBe('echo hi');
    expect(spec.strict).toBe(true);
    expect(spec.rox).toEqual(expect.arrayContaining(['/usr', '/bin']));
    expect(spec.ro).toEqual(expect.arrayContaining(['/repo', '/etc']));
    expect(spec.rw).toEqual(expect.arrayContaining(['/repo/dist', '/dev/null']));
  });

  it('sets strict=false when allowUnsandboxed', () => {
    (existsSync as jest.Mock).mockReturnValue(true);
    expect(buildSpec('x', { ...base, allowUnsandboxed: true }).strict).toBe(false);
  });

  it('filters non-existent grant paths (Landlock aborts on missing paths)', () => {
    (existsSync as jest.Mock).mockImplementation(
      (p: unknown) => p !== '/lib64' && p !== '/repo/dist' && p !== '/dev/random',
    );
    const spec = buildSpec('x', base);
    expect(spec.rox).not.toContain('/lib64');
    expect(spec.rw).not.toContain('/repo/dist');
    expect(spec.rw).not.toContain('/dev/random');
    expect(spec.rw).toContain('/dev/null');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-spec-builder.test.ts`
Expected: FAIL — `buildSpec is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/core/src/sandbox/linux.ts`:

```typescript
/** System paths granted read + execute (interpreter, libraries). */
const SYSTEM_EXEC_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64'];
/** System paths granted read-only (config, CA bundles, name resolution). */
const SYSTEM_READ_PATHS = ['/etc'];
/** Device nodes a command opens directly (e.g. `> /dev/null`), granted rw. */
const DEVICE_RW_PATHS = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom'];

/** The JSON spec written to the helper's fd 3. */
export interface LandlockSpec {
  command: string;
  strict: boolean;
  ro: string[];
  rox: string[];
  rw: string[];
}

function existing(paths: string[]): string[] {
  return paths.filter((p) => {
    if (existsSync(p)) return true;
    void logger.debug('sandbox: skipping non-existent grant path', { path: p });
    return false;
  });
}

/**
 * Build the fd-3 spec from sandbox options. Grant categories mirror the old
 * landrun flags: `rox` system exec paths, `ro` policy reads + `/etc`, `rw`
 * policy writes + device nodes. All filtered to existing paths (Landlock
 * aborts on a missing grant path). `strict = !allowUnsandboxed`.
 *
 * @param command - Shell command to run under the sandbox.
 * @param options - Resolved sandbox options.
 * @returns The spec object serialised to fd 3.
 */
export function buildSpec(command: string, options: SandboxOptions): LandlockSpec {
  return {
    command,
    strict: !options.allowUnsandboxed,
    rox: existing(SYSTEM_EXEC_PATHS),
    ro: existing([...options.readOnlyPaths, ...SYSTEM_READ_PATHS]),
    rw: existing([...options.readWritePaths, ...DEVICE_RW_PATHS]),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-spec-builder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sandbox/linux.ts packages/core/__tests__/sandbox/linux-spec-builder.test.ts
git commit -m "feat(core): fd-3 spec builder for rd-landlock grants (#413)"
```

---

## Task 17: `runHelper()` — detached fd-wired spawn + applied-status handling

**Files:**
- Modify: `packages/core/src/sandbox/linux.ts`

**Interfaces:**
- Consumes: `buildSpec` (Task 16); `LandlockSandboxOptions.helperPath`.
- Produces: `runHelper()` spawns the helper with `stdio: ['inherit','inherit','inherit','pipe','pipe']`, `detached:true`, PATH-enhanced env; writes the JSON spec to fd 3; reads the fd-4 status line; on `applied` runs to completion returning `{ success, exitCode, sandboxed:true, landlockAbi, enforcementDowngraded }`. A non-zero command exit under `applied` is **not** misclassified.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__tests__/sandbox/linux-execute.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import { LandlockSandbox } from '../../src/sandbox/linux.js';
import type { SandboxOptions } from '../../src/sandbox/types.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

const base: SandboxOptions = {
  cwd: process.cwd(),
  repoRoot: process.cwd(),
  readOnlyPaths: [],
  readWritePaths: [],
  denyPaths: [],
  denyPatterns: [],
  env: { PATH: '/usr/bin:/bin' },
  allowUnsandboxed: false,
};

function sandbox(statusLine: string, exit = 0) {
  return new LandlockSandbox({
    helperPath: FAKE,
    probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    // execute env is set per-run via the fake helper's own env below.
  });
}

describe('LandlockSandbox.execute applied path', () => {
  const original = process.platform;
  beforeEach(() =>
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }),
  );
  afterEach(() =>
    Object.defineProperty(process, 'platform', { value: original, configurable: true }),
  );

  it('applied status → sandboxed:true and surfaces the ABI', async () => {
    const sb = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    });
    const r = await sb.execute('echo hi', {
      ...base,
      env: {
        ...base.env,
        FAKE_STATUS_LINE: '{"status":"applied","abi":3,"downgraded":false}',
        FAKE_EXIT: '0',
      },
    });
    expect(r.sandboxed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.success).toBe(true);
    expect(r.landlockAbi).toBe(3);
    expect(r.enforcementDowngraded).toBe(false);
    expect(r.policyDenied).toBe(false);
  });

  it('non-zero command exit under applied is NOT a policy denial', async () => {
    const sb = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    });
    const r = await sb.execute('exit 125', {
      ...base,
      env: {
        ...base.env,
        FAKE_STATUS_LINE: '{"status":"applied","abi":3,"downgraded":false}',
        FAKE_EXIT: '125',
      },
    });
    expect(r.sandboxed).toBe(true);
    expect(r.exitCode).toBe(125);
    expect(r.success).toBe(false);
    expect(r.policyDenied).toBe(false);
  });
});
```

Note: the fake helper reads its behaviour from its process env; core passes `options.env` as the helper's env (PATH-enhanced), so the test threads `FAKE_STATUS_LINE`/`FAKE_EXIT` through `options.env`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-execute.test.ts`
Expected: FAIL — `runHelper` throws `not implemented until Task 17`.

- [ ] **Step 3: Write minimal implementation**

Replace `runHelper` in `packages/core/src/sandbox/linux.ts` and add the PATH + status helpers:

```typescript
function buildEnhancedPathFromEnv(cwd: string, env: Record<string, string>): string {
  const binPath = join(cwd, 'node_modules', '.bin');
  const existingPath = env.PATH || env.Path || '';
  return existingPath ? `${binPath}:${existingPath}` : binPath;
}

/** Parsed fd-4 status. */
type HelperStatus =
  | { status: 'applied'; abi: number; downgraded: boolean }
  | { status: 'denied'; abi: number; missing: string }
  | { status: 'error'; message: string };

function parseStatus(line: string): HelperStatus | null {
  try {
    const v = JSON.parse(line.trim()) as HelperStatus;
    if (v && (v.status === 'applied' || v.status === 'denied' || v.status === 'error')) {
      return v;
    }
    return null;
  } catch {
    return null;
  }
}
```

Then `runHelper`:

```typescript
  private runHelper(
    command: string,
    options: SandboxOptions,
  ): Promise<SandboxExecutionResult> {
    return new Promise((resolve) => {
      const env = {
        ...options.env,
        PATH: buildEnhancedPathFromEnv(options.cwd, options.env),
      };
      const spec = buildSpec(command, options);

      // fds 0/1/2 inherited; fd 3 = spec-in; fd 4 = status-out; detached so the
      // helper leads its own process group (see terminateGroup, Task 19).
      const child = spawn(this.helperPath as string, [], {
        cwd: options.cwd,
        env,
        stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'],
        detached: true,
      });

      const specPipe = child.stdio[3] as NodeJS.WritableStream;
      const statusPipe = child.stdio[4] as NodeJS.ReadableStream;
      let statusRaw = '';
      statusPipe.setEncoding('utf8');
      statusPipe.on('data', (c: string) => {
        statusRaw += c;
      });

      specPipe.write(`${JSON.stringify(spec)}\n`);
      specPipe.end();

      child.on('error', (err) => {
        // Spawn-level failure: the helper never started. Treat as protocol
        // violation → fail closed (see Task 18).
        resolve(this.failClosed(`rd-landlock failed to start: ${getErrorMessage(err)}`));
      });

      child.on('close', (code) => {
        const status = parseStatus(statusRaw);
        resolve(this.resolveStatus(status, code ?? 1, command)); // Task 18 fills denied/violation
      });
    });
  }

  private resolveStatus(
    status: HelperStatus | null,
    exitCode: number,
    _command: string,
  ): SandboxExecutionResult {
    if (status?.status === 'applied') {
      return {
        success: exitCode === 0,
        exitCode,
        sandboxed: true,
        policyDenied: false,
        landlockAbi: status.abi,
        enforcementDowngraded: status.downgraded,
      };
    }
    // denied / error / missing handled in Task 18.
    return this.failClosed('rd-landlock protocol violation (Task 18)');
  }

  private failClosed(reason: string): SandboxExecutionResult {
    return {
      success: false,
      exitCode: 126,
      sandboxed: false,
      policyDenied: true,
      denialReason: reason,
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-execute.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sandbox/linux.ts packages/core/__tests__/sandbox/linux-execute.test.ts
git commit -m "feat(core): rd-landlock detached fd-wired spawn and applied handling (#413)"
```

---

## Task 18: Status handling — denied + protocol violation (fails closed even with strict:false)

**Files:**
- Modify: `packages/core/src/sandbox/linux.ts` (`resolveStatus`)

**Interfaces:**
- Consumes: `HelperStatus`, `failClosed` (Task 17).
- Produces: `resolveStatus` maps `denied` → `policyDenied:true` with the ABI-gap `denialReason`; `error`/missing/malformed → `failClosed` **regardless of strict**.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__tests__/sandbox/linux-status.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import { LandlockSandbox } from '../../src/sandbox/linux.js';
import type { SandboxOptions } from '../../src/sandbox/types.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

const base: SandboxOptions = {
  cwd: process.cwd(),
  repoRoot: process.cwd(),
  readOnlyPaths: [],
  readWritePaths: [],
  denyPaths: [],
  denyPatterns: [],
  env: { PATH: '/usr/bin:/bin' },
  allowUnsandboxed: false,
};

function sb() {
  return new LandlockSandbox({
    helperPath: FAKE,
    probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
  });
}

describe('LandlockSandbox.execute status handling', () => {
  const original = process.platform;
  beforeEach(() =>
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }),
  );
  afterEach(() =>
    Object.defineProperty(process, 'platform', { value: original, configurable: true }),
  );

  it('denied status → policyDenied with ABI-gap reason', async () => {
    const r = await sb().execute('cat /secret', {
      ...base,
      env: {
        ...base.env,
        FAKE_STATUS_LINE: '{"status":"denied","abi":2,"missing":"TRUNCATE"}',
        FAKE_EXIT: '126',
      },
    });
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
    expect(r.denialReason).toContain('TRUNCATE');
    expect(r.denialReason).toContain('sandboxStrict');
  });

  it('error status fails closed even with allowUnsandboxed (strict:false)', async () => {
    const r = await sb().execute('echo hi', {
      ...base,
      allowUnsandboxed: true,
      env: {
        ...base.env,
        FAKE_STATUS_LINE: '{"status":"error","message":"boom"}',
        FAKE_EXIT: '1',
      },
    });
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
    expect(r.success).toBe(false);
  });

  it('missing status (protocol violation) fails closed', async () => {
    const r = await sb().execute('echo hi', {
      ...base,
      allowUnsandboxed: true,
      env: { ...base.env, FAKE_NO_STATUS: '1', FAKE_EXIT: '0' },
    });
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-status.test.ts`
Expected: FAIL — denied reason is the Task 17 placeholder text; assertions on `TRUNCATE`/`sandboxStrict` fail.

- [ ] **Step 3: Write minimal implementation**

Replace `resolveStatus` in `packages/core/src/sandbox/linux.ts`:

```typescript
  private resolveStatus(
    status: HelperStatus | null,
    exitCode: number,
    _command: string,
  ): SandboxExecutionResult {
    if (status?.status === 'applied') {
      return {
        success: exitCode === 0,
        exitCode,
        sandboxed: true,
        policyDenied: false,
        landlockAbi: status.abi,
        enforcementDowngraded: status.downgraded,
      };
    }
    if (status?.status === 'denied') {
      return {
        success: false,
        exitCode: 126,
        sandboxed: false,
        policyDenied: true,
        landlockAbi: status.abi,
        denialReason:
          `Landlock ABI ${status.abi} (kernel <6.2) cannot enforce ${status.missing}; ` +
          'read-only grants would be bypassable. Refusing under strict mode. ' +
          'Re-run with sandboxStrict:false to override.',
      };
    }
    // error / missing / malformed: the helper may already have applied a
    // ruleset and/or exec'd the command, so its enforcement state is unknown.
    // ALWAYS fail closed, regardless of strict:false. The unsandboxed fallback
    // is reserved strictly for preflight "sandbox unavailable" and the explicit
    // ABI downgrade — never a protocol violation.
    const detail =
      status?.status === 'error' ? status.message : 'missing or malformed fd-4 status';
    return this.failClosed(`rd-landlock protocol violation: ${detail}`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-status.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sandbox/linux.ts packages/core/__tests__/sandbox/linux-status.test.ts
git commit -m "feat(core): denied + fail-closed protocol-violation status handling (#413)"
```

---

## Task 19: Process-group teardown

**Files:**
- Modify: `packages/core/src/sandbox/linux.ts` (`runHelper` teardown on protocol violation)
- Create: `packages/core/__tests__/sandbox/fixtures/fake-helper-grandchild.mjs`

**Interfaces:**
- Consumes: the `detached:true` spawn from Task 17.
- Produces: on a protocol violation while the command may be running, core signals the whole group (`process.kill(-child.pid, 'SIGTERM')`, then `SIGKILL` after a timeout) and `await`s `close` to reap — leaving no survivors.

- [ ] **Step 1: Write the fixture + failing test**

Create `packages/core/__tests__/sandbox/fixtures/fake-helper-grandchild.mjs`:

```javascript
#!/usr/bin/env node
// Fake helper that writes an *error* status (protocol violation) but then execs
// a shell that spawns a long-lived grandchild, to prove group teardown reaps
// the whole tree. Writes the grandchild PID to fd 5 so the test can assert it
// is dead.
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

writeFileSync(4, '{"status":"error","message":"synthetic violation"}\n');

// Long-lived grandchild: sleeps 30s. Report its pid on fd 5.
const grandchild = spawn('sleep', ['30'], { stdio: 'ignore' });
try {
  writeFileSync(5, String(grandchild.pid));
} catch {
  /* fd 5 not wired */
}
// Keep the helper alive briefly so the group exists when core tears it down.
setTimeout(() => process.exit(0), 5000);
```

Create `packages/core/__tests__/sandbox/linux-teardown.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { chmodSync, openSync, readFileSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LandlockSandbox } from '../../src/sandbox/linux.js';
import type { SandboxOptions } from '../../src/sandbox/types.js';

const FAKE = fileURLToPath(
  new URL('./fixtures/fake-helper-grandchild.mjs', import.meta.url),
);
chmodSync(FAKE, 0o755);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('LandlockSandbox process-group teardown', () => {
  const original = process.platform;
  beforeEach(() =>
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }),
  );
  afterEach(() =>
    Object.defineProperty(process, 'platform', { value: original, configurable: true }),
  );

  it('reaps the whole group on a protocol violation, leaving no survivors', async () => {
    // The fixture writes the grandchild pid to a file on fd 5. Use a temp file
    // opened for write, mapped to the child's fd 5 by the sandbox test seam.
    const pidFile = join(tmpdir(), `rd-gc-${Date.now()}.pid`);
    const fd5 = openSync(pidFile, 'w');

    const sb = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
      extraStdioFd: fd5, // test seam: append a 6th stdio slot (fd 5) for the fixture
    });

    const options: SandboxOptions = {
      cwd: process.cwd(),
      repoRoot: process.cwd(),
      readOnlyPaths: [],
      readWritePaths: [],
      denyPaths: [],
      denyPatterns: [],
      env: { PATH: '/usr/bin:/bin' },
      allowUnsandboxed: true, // proves teardown happens even with strict:false
    };

    const r = await sb.execute('irrelevant', options);
    closeSync(fd5);
    expect(r.policyDenied).toBe(true);

    const gcPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(gcPid)).toBe(true);
    // Give SIGTERM/SIGKILL a moment to land.
    await new Promise((res) => setTimeout(res, 500));
    expect(isAlive(gcPid)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-teardown.test.ts`
Expected: FAIL — `extraStdioFd` unsupported and no teardown, so the grandchild survives (`isAlive` true) / constructor option ignored.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/sandbox/linux.ts`, extend `LandlockSandboxOptions` and the constructor:

```typescript
export interface LandlockSandboxOptions {
  helperPath?: string | null;
  distRoot?: string;
  probeEnv?: Record<string, string>;
  /** Test seam: an extra inherited stdio fd appended as fd 5. */
  extraStdioFd?: number;
}
```

Store it: add `private readonly extraStdioFd?: number;` and in the constructor `this.extraStdioFd = opts.extraStdioFd;`.

Update the `spawn` stdio in `runHelper`:

```typescript
      const stdio: Array<'inherit' | 'pipe' | number> = [
        'inherit',
        'inherit',
        'inherit',
        'pipe',
        'pipe',
      ];
      if (this.extraStdioFd !== undefined) {
        stdio.push(this.extraStdioFd); // fd 5 for tests
      }
      const child = spawn(this.helperPath as string, [], {
        cwd: options.cwd,
        env,
        stdio,
        detached: true,
      });
```

Add group teardown and use it on protocol violations. Replace the `close` handler and add `terminateGroup`:

```typescript
      child.on('close', (code) => {
        const status = parseStatus(statusRaw);
        if (status?.status === 'applied' || status?.status === 'denied') {
          resolve(this.resolveStatus(status, code ?? 1, command));
          return;
        }
        // Protocol violation: the helper may have exec'd a command whose
        // grandchildren are still running. Tear down the whole group, then
        // fail closed. terminateGroup awaits reaping before resolving.
        void this.terminateGroup(child).then(() => {
          const detail =
            status?.status === 'error'
              ? status.message
              : 'missing or malformed fd-4 status';
          resolve(this.failClosed(`rd-landlock protocol violation: ${detail}`));
        });
      });
```

Add the method:

```typescript
  /**
   * Signal the helper's whole process group and reap it. The negative PID
   * targets the group (only valid because the child was spawned `detached`, so
   * it leads its own group and the signal cannot reach core's group). SIGTERM
   * first, SIGKILL after a short grace, always awaiting exit.
   */
  private terminateGroup(child: import('node:child_process').ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      const pid = child.pid;
      if (pid == null) {
        resolve();
        return;
      }
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolve();
      };
      const signalGroup = (sig: NodeJS.Signals): void => {
        try {
          process.kill(-pid, sig);
        } catch {
          /* group already gone */
        }
      };
      // The child may have already emitted 'close' (this runs from within it);
      // guard reaping via 'exit' too.
      child.once('exit', finish);
      signalGroup('SIGTERM');
      const killTimer = setTimeout(() => signalGroup('SIGKILL'), 1000);
      // Safety net: if exit never fires (already reaped), resolve after grace.
      setTimeout(finish, 1500);
    });
  }
```

Note: `resolveStatus`'s error/missing branch is now unreachable from `runHelper` (handled inline), but keep it for the deny path and Task 18 unit coverage; leave it unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-teardown.test.ts`
Expected: PASS (1 test). Also re-run the status suite to confirm no regression: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux-status.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sandbox/linux.ts packages/core/__tests__/sandbox/fixtures/fake-helper-grandchild.mjs packages/core/__tests__/sandbox/linux-teardown.test.ts
git commit -m "feat(core): detached process-group teardown on protocol violation (#413)"
```

---

## Task 20: Propagate ABI fields through executor → payload

**Files:**
- Modify: `packages/core/src/runbook/executor.ts:13-24,247-253`
- Modify: `packages/core/src/runbook/actors/command-exec-actor.ts:67-86`
- Modify: `packages/core/src/events/execution-observation.ts:268-287`
- Modify: `packages/core/src/events/types.ts:114-123`

**Interfaces:**
- Consumes: `SandboxExecutionResult.landlockAbi`/`enforcementDowngraded` (Task 12).
- Produces: `ExecutionResult`, `CommandExecutionCompletedOutput`, and `CommandCompletedPayload` all carry `landlockAbi?: number` and `enforcementDowngraded?: boolean`; the executor sandbox return and `commandCompletedEffect` copy them through.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__tests__/events/command-completed-abi.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import { commandCompletedEffect } from '../../src/events/execution-observation.js';

describe('commandCompletedEffect ABI propagation', () => {
  it('copies landlockAbi and enforcementDowngraded into the payload', () => {
    const effect = commandCompletedEffect({
      kind: 'completed',
      command: 'echo hi',
      displayCommand: 'echo hi',
      success: true,
      result: 'pass',
      exitCode: 0,
      sandboxed: true,
      landlockAbi: 3,
      enforcementDowngraded: false,
      channels: [],
      position: { qualified: '1', index: 0 },
    });
    expect(effect.event.type).toBe('COMMAND_COMPLETED');
    if (effect.event.type === 'COMMAND_COMPLETED') {
      expect(effect.event.payload.landlockAbi).toBe(3);
      expect(effect.event.payload.enforcementDowngraded).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/events/command-completed-abi.test.ts`
Expected: FAIL — `landlockAbi` not assignable to `CommandExecutionCompletedOutput` / not present on payload.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/events/types.ts`, add to `CommandCompletedPayload` (after `sandboxed?`):

```typescript
  /** Negotiated Landlock ABI the command ran under (Linux sandbox only). */
  readonly landlockAbi?: number;
  /** True if Landlock enforcement ran below the required ABI floor. */
  readonly enforcementDowngraded?: boolean;
```

In `packages/core/src/runbook/actors/command-exec-actor.ts`, add to `CommandExecutionCompletedOutput` (after `sandboxed?`):

```typescript
  /** Negotiated Landlock ABI the command ran under (Linux sandbox only). */
  readonly landlockAbi?: number;
  /** True if Landlock enforcement ran below the required ABI floor. */
  readonly enforcementDowngraded?: boolean;
```

In `packages/core/src/events/execution-observation.ts`, add to the `commandCompletedEffect` payload (after `sandboxed: input.sandboxed,`):

```typescript
        landlockAbi: input.landlockAbi,
        enforcementDowngraded: input.enforcementDowngraded,
```

In `packages/core/src/runbook/executor.ts`, add to `ExecutionResult` (after `sandboxed?`):

```typescript
  /** Negotiated Landlock ABI the command ran under (Linux sandbox only). */
  landlockAbi?: number;
  /** True if Landlock enforcement ran below the required ABI floor. */
  enforcementDowngraded?: boolean;
```

And in the sandbox return at `executor.ts:247-253`:

```typescript
      return {
        success: result.success,
        exitCode: result.exitCode,
        denialReason: result.denialReason,
        policyDenied: result.policyDenied,
        sandboxed: result.sandboxed,
        landlockAbi: result.landlockAbi,
        enforcementDowngraded: result.enforcementDowngraded,
      };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/events/command-completed-abi.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events/types.ts packages/core/src/runbook/actors/command-exec-actor.ts packages/core/src/events/execution-observation.ts packages/core/src/runbook/executor.ts packages/core/__tests__/events/command-completed-abi.test.ts
git commit -m "feat(core): surface negotiated Landlock ABI to COMMAND_COMPLETED (#413)"
```

---

## Task 21: Build wiring (`build:native`, `prepack` assertion, `files`)

**Files:**
- Create: `scripts/build-native.mjs`
- Create: `scripts/assert-native.mjs`
- Modify: `packages/core/package.json`

**Interfaces:**
- Consumes: the `rd-landlock` crate (Task 1-11).
- Produces:
  - `pnpm --filter @rundown-org/core run build:native` → `dist/native/linux-x64/rd-landlock` + `dist/native/linux-arm64/rd-landlock` (executable).
  - `assert-native.mjs` exits 1 unless both binaries exist and are executable.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__tests__/build/assert-native.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/assert-native.mjs', import.meta.url));

function runAssert(distRoot: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, RD_NATIVE_DIST_ROOT: distRoot },
    encoding: 'utf8',
  });
}

describe('assert-native', () => {
  it('exits non-zero when binaries are missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-'));
    expect(runAssert(root).status).not.toBe(0);
  });

  it('exits 0 when both executable binaries exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-'));
    for (const arch of ['linux-x64', 'linux-arm64']) {
      const dir = join(root, 'native', arch);
      mkdirSync(dir, { recursive: true });
      const bin = join(dir, 'rd-landlock');
      writeFileSync(bin, '#!/bin/sh\ntrue\n');
      chmodSync(bin, 0o755);
    }
    expect(runAssert(root).status).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/build/assert-native.test.ts`
Expected: FAIL — `assert-native.mjs` does not exist (spawnSync error / non-zero for both).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/assert-native.mjs`:

```javascript
#!/usr/bin/env node
// Pack-time guard: fail the publish unless both bundled rd-landlock binaries
// exist and are executable. Prevents shipping a core whose Linux sandbox
// silently reports unavailable.
import { accessSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot =
  process.env.RD_NATIVE_DIST_ROOT ??
  join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'core', 'dist');

const required = ['linux-x64', 'linux-arm64'].map((a) =>
  join(distRoot, 'native', a, 'rd-landlock'),
);

let ok = true;
for (const bin of required) {
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    console.error(`assert-native: missing or non-executable: ${bin}`);
    ok = false;
  }
}
if (!ok) {
  console.error('assert-native: refusing to pack core without both rd-landlock binaries.');
  process.exit(1);
}
console.log('assert-native: both rd-landlock binaries present and executable.');
```

Create `scripts/build-native.mjs`:

```javascript
#!/usr/bin/env node
// Build (or, with --from-artifacts <dir>, copy) the rd-landlock binaries into
// packages/core/dist/native/linux-<arch>/rd-landlock. Local dev cross-compiles
// both musl targets; CI release passes --from-artifacts to copy prebuilt ones.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = join(repoRoot, 'native', 'rd-landlock');
const distNative = join(repoRoot, 'packages', 'core', 'dist', 'native');

const TARGETS = [
  { rust: 'x86_64-unknown-linux-musl', out: 'linux-x64' },
  { rust: 'aarch64-unknown-linux-musl', out: 'linux-arm64' },
];

function copyInto(srcBinary, outDir) {
  const dir = join(distNative, outDir);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, 'rd-landlock');
  cpSync(srcBinary, dest);
  chmodSync(dest, 0o755);
  console.log(`build-native: placed ${dest}`);
}

const fromIdx = process.argv.indexOf('--from-artifacts');
if (fromIdx !== -1) {
  const artifactRoot = process.argv[fromIdx + 1];
  for (const t of TARGETS) {
    const src = join(artifactRoot, t.out, 'rd-landlock');
    if (!existsSync(src)) {
      console.error(`build-native: artifact missing: ${src}`);
      process.exit(1);
    }
    copyInto(src, t.out);
  }
  process.exit(0);
}

// Local cross-compile path.
for (const t of TARGETS) {
  const res = spawnSync('cargo', ['build', '--release', '--target', t.rust], {
    cwd: crateDir,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    console.error(`build-native: cargo build failed for ${t.rust}`);
    process.exit(res.status ?? 1);
  }
  copyInto(join(crateDir, 'target', t.rust, 'release', 'rd-landlock'), t.out);
}
```

Update `packages/core/package.json`:

```json
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc && node ../../scripts/build-native.mjs",
    "build:native": "node ../../scripts/build-native.mjs",
    "prepack": "node ../../scripts/assert-native.mjs",
    "check:types": "tsc --noEmit -p tsconfig.test.json",
    "test": "jest",
    "test:unit": "jest --maxWorkers=2",
    "test:coverage": "jest --coverage",
    "test:property": "jest --maxWorkers=2 --testPathPatterns='\\.properties\\.test\\.ts$'",
    "test:mutate": "stryker run",
    "clean": "rm -rf dist"
  },
```

`dist/native` is already covered by `files: ["dist"]`, so no `files` change is strictly required; keep `["dist"]`. (The spec's "files += dist/native" is satisfied because `dist` already includes `dist/native`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/build/assert-native.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/build-native.mjs scripts/assert-native.mjs packages/core/package.json packages/core/__tests__/build/assert-native.test.ts
git commit -m "build(core): build:native + prepack assertion for rd-landlock binaries (#413)"
```

---

## Task 22: CI — Rust build job

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `rd-landlock` crate.
- Produces: a `rd-landlock-build` job that installs the Rust toolchain + both musl targets, builds both binaries, and uploads them as `rd-landlock-binaries` artifacts under `linux-x64/` and `linux-arm64/`.

- [ ] **Step 1: Add the job**

Insert this job into `.github/workflows/ci.yml` (after `stryker-dry`, before `landlock-integration`):

```yaml
  rd-landlock-build:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0
        with:
          persist-credentials: false

      - name: Install Rust toolchain and musl targets
        run: |
          set -euo pipefail
          rustup toolchain install stable --profile minimal
          rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends musl-tools gcc-aarch64-linux-gnu

      - name: Build rd-landlock (x64 + arm64 musl)
        working-directory: native/rd-landlock
        env:
          CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER: aarch64-linux-gnu-gcc
        run: |
          set -euo pipefail
          cargo build --release --target x86_64-unknown-linux-musl
          cargo build --release --target aarch64-unknown-linux-musl

      - name: Stage binaries for upload
        run: |
          set -euo pipefail
          mkdir -p out/linux-x64 out/linux-arm64
          cp native/rd-landlock/target/x86_64-unknown-linux-musl/release/rd-landlock out/linux-x64/
          cp native/rd-landlock/target/aarch64-unknown-linux-musl/release/rd-landlock out/linux-arm64/

      - name: Upload rd-landlock binaries
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a  # v7
        with:
          name: rd-landlock-binaries
          path: out/
          retention-days: 1
```

- [ ] **Step 2: Verify workflow is well-formed**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo OK`
Expected: `OK` (valid YAML). If `actionlint` is installed: `actionlint .github/workflows/ci.yml` → no errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build rd-landlock musl binaries and upload artifacts (#413)"
```

---

## Task 23: CI — retarget the Landlock enforcement job

**Files:**
- Modify: `.github/workflows/ci.yml` (`landlock-integration`)

**Interfaces:**
- Consumes: the `rd-landlock-binaries` artifact (Task 22).
- Produces: a `landlock-integration` job that drops the landrun install, downloads `rd-landlock` into `packages/core/dist/native/`, and runs the enforcement integration test with `RUNDOWN_REQUIRE_LANDLOCK=1` (which now asserts the reported ABI).

- [ ] **Step 1: Replace the job body**

Replace the entire `landlock-integration:` job in `.github/workflows/ci.yml` with:

```yaml
  landlock-integration:
    runs-on: ubuntu-latest
    needs:
      - setup-build-node24
      - rd-landlock-build
    permissions:
      actions: read
      contents: read

    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0
        with:
          persist-credentials: false

      - uses: ./.github/actions/setup-node-deps
        with:
          node-version: 24

      - name: Download build artifacts
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c  # v8.0.1
        with:
          name: build-artifacts-node24
          path: packages

      - name: Download rd-landlock binaries
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c  # v8.0.1
        with:
          name: rd-landlock-binaries
          path: rd-landlock-out

      - name: Place rd-landlock into core dist
        run: |
          set -euo pipefail
          node scripts/build-native.mjs --from-artifacts "$PWD/rd-landlock-out"
          test -x packages/core/dist/native/linux-x64/rd-landlock

      - name: Report Landlock environment
        run: |
          uname -r
          cat /sys/kernel/security/lsm 2>/dev/null \
            || echo "securityfs lsm not readable — functional probe fallback will be used"

      # RUNDOWN_REQUIRE_LANDLOCK=1 turns a missing/non-enforcing sandbox into a
      # hard failure, so this job genuinely exercises real Landlock enforcement
      # (including the reported-ABI assertion) rather than silently skipping.
      - name: Run Landlock enforcement integration test
        env:
          RUNDOWN_REQUIRE_LANDLOCK: '1'
        run: pnpm --filter @rundown-org/core test -- --testPathPatterns 'enforcement\.integration\.test\.ts$'
```

- [ ] **Step 2: Verify workflow is well-formed**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo OK`
Expected: `OK`. Confirm the old `Install landrun (Landlock wrapper)` step and its `LANDRUN_*` env are gone: `grep -c landrun .github/workflows/ci.yml` → `0`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: retarget landlock-integration to rd-landlock, drop landrun (#413)"
```

---

## Task 24: Release — download native artifacts before pack

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `rd-landlock` binaries built in the release job.
- Produces: the release job builds the binaries and places them into `packages/core/dist/native/` before `pnpm test`/publish, so `prepack` (Task 21) passes.

- [ ] **Step 1: Add the Rust build + placement steps**

In `.github/workflows/release.yml`, insert after the `Build Packages` step (line 37-38) and before `Run Tests`:

```yaml
      - name: Install Rust toolchain and musl targets
        run: |
          set -euo pipefail
          rustup toolchain install stable --profile minimal
          rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends musl-tools gcc-aarch64-linux-gnu

      - name: Build and place rd-landlock binaries
        working-directory: native/rd-landlock
        env:
          CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER: aarch64-linux-gnu-gcc
        run: |
          set -euo pipefail
          cargo build --release --target x86_64-unknown-linux-musl
          cargo build --release --target aarch64-unknown-linux-musl

      - name: Copy rd-landlock into core dist
        run: |
          set -euo pipefail
          mkdir -p artifacts/linux-x64 artifacts/linux-arm64
          cp native/rd-landlock/target/x86_64-unknown-linux-musl/release/rd-landlock artifacts/linux-x64/
          cp native/rd-landlock/target/aarch64-unknown-linux-musl/release/rd-landlock artifacts/linux-arm64/
          node scripts/build-native.mjs --from-artifacts "$PWD/artifacts"
          node scripts/assert-native.mjs
```

Note: `RD_NATIVE_DIST_ROOT` is unset in release, so `assert-native.mjs` checks the default `packages/core/dist` — correct.

- [ ] **Step 2: Verify workflow is well-formed**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): build and bundle rd-landlock binaries before pack (#413)"
```

---

## Task 25: Remove the landrun stage from Dockerfile.verify

**Files:**
- Modify: `scripts/Dockerfile.verify`

**Interfaces:**
- Consumes: nothing.
- Produces: a Dockerfile with no Go `landrun-builder` stage and no `landrun` `COPY`. The bundled `rd-landlock` (shipped inside the core tarball's `dist/native`) provides enforcement.

- [ ] **Step 1: Delete the stage and its COPY**

In `scripts/Dockerfile.verify`, delete lines 20-30 (the `── Landrun builder ──` comment block and the `FROM golang:1.23-bookworm AS landrun-builder` … `go install` stage), and delete lines 44-45 (the `# Install the Landlock wrapper …` comment and `COPY --from=landrun-builder /out/landrun /usr/local/bin/landrun`).

Resulting top of file (after the header comment block through the base stage) reads:

```dockerfile
# ── Base stage ───────────────────────────────────────────────────────────────

FROM node:24-slim AS base

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      sudo \
      git \
      curl \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Claude Code blocks root — create non-root user
RUN useradd -m -s /bin/bash testuser && \
    echo "testuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
```

- [ ] **Step 2: Verify no landrun references remain and the Dockerfile parses**

Run: `grep -c -i landrun scripts/Dockerfile.verify`
Expected: `0`.
Run (if Docker available): `docker build -f scripts/Dockerfile.verify --target base -t rd-verify-base-check .`
Expected: builds through the base stage without the Go stage.

- [ ] **Step 3: Commit**

```bash
git add scripts/Dockerfile.verify
git commit -m "build: remove landrun-builder stage from Dockerfile.verify (#413)"
```

---

## Task 26: Retarget the core enforcement integration test

**Files:**
- Modify: `packages/core/__tests__/sandbox/linux.enforcement.integration.test.ts`

**Interfaces:**
- Consumes: the bundled `rd-landlock` binary at `dist/native/linux-<arch>/rd-landlock` (resolved by `LandlockSandbox`'s default arch path).
- Produces: the integration test asserts the reported ABI (`availability.landlockAbi >= 3`, and `result.landlockAbi >= 3`) and adds a truncate-blocked-on-ro case; still gated by `RUNDOWN_REQUIRE_LANDLOCK=1`.

- [ ] **Step 1: Rewrite the test**

Replace `packages/core/__tests__/sandbox/linux.enforcement.integration.test.ts`:

```typescript
/**
 * Real-enforcement integration test for the Linux Landlock sandbox.
 *
 * Runs the actual {@link LandlockSandbox} against the bundled `rd-landlock`
 * binary and the host kernel.
 *
 * Behaviour by environment:
 *   - Landlock available  -> assert real enforcement (granted reads/writes
 *     succeed; an ungranted read is blocked; a truncate on a read-only grant is
 *     blocked; the negotiated ABI is >= 3).
 *   - Landlock unavailable -> skip so dev machines stay green.
 *   - RUNDOWN_REQUIRE_LANDLOCK=1 and unavailable -> FAIL.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LandlockSandbox } from '../../src/sandbox/linux.js';
import type { SandboxOptions } from '../../src/sandbox/types.js';

const sandbox = new LandlockSandbox();
const availability = await sandbox.getAvailability();
const required = process.env.RUNDOWN_REQUIRE_LANDLOCK === '1';

if (!availability.available) {
  const reason = availability.reason ?? 'unknown reason';
  if (required) {
    describe('LandlockSandbox real enforcement (integration)', () => {
      it('Landlock must be available when RUNDOWN_REQUIRE_LANDLOCK=1', () => {
        throw new Error(`Expected a working Landlock sandbox but it is unavailable: ${reason}`);
      });
    });
  } else {
    console.info(`[landlock-integration] skipped — sandbox unavailable: ${reason}`);
    describe.skip(`LandlockSandbox real enforcement (integration) — ${reason}`, () => {
      it('enforces filesystem policy', () => {
        /* skipped */
      });
    });
  }
} else {
  describe('LandlockSandbox real enforcement (integration)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rundown-landlock-it-'));
    const grantedDir = join(root, 'granted');
    const secretDir = join(root, 'secret');
    mkdirSync(grantedDir);
    mkdirSync(secretDir);
    writeFileSync(join(grantedDir, 'ok.txt'), 'ok');
    writeFileSync(join(secretDir, 'secret.txt'), 'top secret');

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const run = (command: string, readOnlyPaths: string[], readWritePaths: string[] = []) =>
      sandbox.execute(command, {
        cwd: grantedDir,
        repoRoot: root,
        readOnlyPaths,
        readWritePaths,
        denyPaths: [],
        denyPatterns: [],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        allowUnsandboxed: false,
      } satisfies SandboxOptions);

    it('negotiates and reports a Landlock ABI of at least 3', () => {
      expect(availability.landlockAbi ?? 0).toBeGreaterThanOrEqual(3);
    });

    it('allows reads inside a granted read-only path and surfaces the ABI', async () => {
      const result = await run(`cat ${join(grantedDir, 'ok.txt')}`, [grantedDir]);
      expect(result.sandboxed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
      expect(result.landlockAbi ?? 0).toBeGreaterThanOrEqual(3);
    });

    it('blocks reads outside granted paths (real kernel enforcement)', async () => {
      const result = await run(`cat ${join(secretDir, 'secret.txt')}`, [grantedDir]);
      expect(result.sandboxed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });

    it('allows writes inside a granted read-write path', async () => {
      const result = await run(`printf hi > ${join(grantedDir, 'written.txt')}`, [], [grantedDir]);
      expect(result.sandboxed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
    });

    it('blocks truncation of a file in a read-only grant (ABI >= 3 TRUNCATE)', async () => {
      const keep = join(grantedDir, 'ok.txt');
      const result = await run(`: > ${keep}`, [grantedDir]);
      expect(result.sandboxed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
      // The file content must be intact — truncate was denied.
      expect(readFileSync(keep, 'utf8')).toBe('ok');
    });
  });
}
```

- [ ] **Step 2: Run test to verify it fails / skips correctly**

Run (dev host, no Landlock): `pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux.enforcement.integration.test.ts`
Expected: skipped (`sandbox unavailable`) — proves the gating still compiles and runs.
Run (Landlock ≥ v3 host, after `build:native`): `RUNDOWN_REQUIRE_LANDLOCK=1 pnpm --filter @rundown-org/core exec jest __tests__/sandbox/linux.enforcement.integration.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/__tests__/sandbox/linux.enforcement.integration.test.ts
git commit -m "test(core): retarget enforcement integration to rd-landlock + ABI/truncate (#413)"
```

---

## Task 27: Delete the old landrun unit test + update security docs

**Files:**
- Delete: `packages/core/__tests__/sandbox/linux.test.ts`
- Modify: `docs/reference/security.md:640-642,644-672,693-702`

**Interfaces:**
- Consumes: nothing.
- Produces: the landrun-specific unit test is removed (its coverage is replaced by Tasks 13-19); `security.md` documents the bundled `rd-landlock`, the fail-closed-on-low-ABI behaviour, and the `sandboxStrict:false` override.

- [ ] **Step 1: Remove the obsolete landrun unit test**

The old `packages/core/__tests__/sandbox/linux.test.ts` targets landrun `--best-effort` argv and the `which landrun` probe, which no longer exist. Its behaviours are covered by the new suites (`linux-helper-path`, `linux-availability`, `linux-deny-preflight`, `linux-spec-builder`, `linux-execute`, `linux-status`, `linux-teardown`).

```bash
git rm packages/core/__tests__/sandbox/linux.test.ts
```

- [ ] **Step 2: Verify the core sandbox suite passes as a whole**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/sandbox`
Expected: all new sandbox suites PASS; no references to the deleted file.

- [ ] **Step 3: Update security.md**

In `docs/reference/security.md`, replace the paragraph at lines 640-642:

```markdown
If Landlock is unavailable, upgrade to Linux kernel 5.13 or later, ensure
`CONFIG_SECURITY_LANDLOCK` is enabled, or install a Landlock wrapper such as
`landrun` v0.1.0 or later.
```

with:

```markdown
Rundown ships a bundled first-party Landlock helper (`rd-landlock`) inside the
`@rundown-org/core` package — there is **no external tool to install**. The
helper reads the kernel's negotiated Landlock ABI directly and enforces
fail-closed.

**ABI floor.** A true read-only guarantee requires `TRUNCATE` (Landlock ABI v3,
Linux kernel 6.2+): below v3 the kernel cannot restrict `truncate()`, so a
"read-only" path could be emptied. Because every real run grants system paths
read-execute and the repo root read-only, the required floor is **v3**. On a
kernel below 6.2 the sandbox **refuses by default** (fail closed) rather than
enforce a bypassable read-only grant. Affected long-lived servers (RHEL 9,
Debian 12, Amazon Linux 2023) can opt out per run with `--no-sandbox`
(`sandboxStrict:false`), which applies the best-available ruleset and runs the
command anyway.

If the `rd-landlock --probe` self-test reports the syscalls are unavailable
(e.g. container seccomp blocks `landlock_*`), the sandbox reports unavailable
and the fail-closed default blocks command steps until you upgrade the kernel or
pass `--no-sandbox`.
```

At lines 693-702, replace the "Affected hosts" paragraph and the "Linux deny-path note" — change `on Linux without \`landrun\`` to `on Linux where the kernel is older than 6.2 (no TRUNCATE) or where seccomp blocks the \`landlock_*\` syscall`, and drop the `install the sandbox backend` clause (nothing to install):

```markdown
Affected hosts: the fail-closed default blocks command steps on platforms with
no sandbox backend (Windows), on Linux where the kernel is older than 6.2 (no
`TRUNCATE`, so read-only grants cannot be guaranteed), and on Linux where
seccomp blocks the `landlock_*` syscall. macOS ships Seatbelt, so it is
unaffected. To run on such a host, upgrade the kernel to 6.2+ or pass
`--no-sandbox` for that run.
```

The deny-path guidance at lines 644-672 remains accurate (Landlock is still allow-list only) — leave it unchanged.

- [ ] **Step 4: Verify docs lint**

Run: `pnpm run check:spell && pnpm run check:format`
Expected: pass (prettier may reformat the markdown — accept the reformat).

- [ ] **Step 5: Commit**

```bash
git add docs/reference/security.md packages/core/__tests__/sandbox/linux.test.ts
git commit -m "docs(security): document bundled rd-landlock and fail-closed ABI floor (#413)"
```

---

## Final Verification

- [ ] **Step 1: Rust suite (host-independent + gated)**

Run: `cd native/rd-landlock && cargo test`
Expected: all pure-logic unit tests PASS; enforcement tests report `ignored` on a non-Landlock host.

- [ ] **Step 2: Core TS suite**

Run: `pnpm --filter @rundown-org/core test`
Expected: PASS (new sandbox suites + event propagation + build assertion; enforcement integration skipped off-kernel).

- [ ] **Step 3: Full pre-PR gate**

Run: `pnpm run verify`
Expected: format, spell, lint, typecheck, build, test all green. (`build` now cross-compiles Rust — ensure the Rust toolchain + musl targets are installed locally, or run `pnpm --filter @rundown-org/core run build` after installing them.)

---

## Self-Review

**1. Spec coverage.**

- Rust crate: Cargo.toml (T1), spec parsing (T2), required-ABI derivation (T3), rights sets incl. `from_all(abi)` minus EXECUTE and REFER≥v2 (T4), strict/downgrade decision (T5), typed fd-4 status + serialization (T6), ABI syscall read + fd 3/4 borrow + FD_CLOEXEC (T7), ruleset construction with no_new_privs + restrict_self (T8), main orchestration + execvp via CommandExt::exec (T9), `--probe` (T10), gated enforcement tests incl. truncate-blocked-on-ro / full-write-set-on-rw (create/overwrite/delete/refer) / unprivileged (T11). ✔
- Core TS rewrite: arch resolver allow-list (T13), `--probe` availability (T14), deny preflight exit 126 (T15), spec builder w/ grant categories + non-existent filtering + device nodes + PATH note (T16), detached fd-wired spawn + PATH enhancement + applied handling + non-zero-not-misclassified (T17), denied + protocol-violation-fails-closed-even-strict:false (T18), process-group teardown (T19). ✔
- DTO + propagation: types (T12), executor + CommandExecutionCompletedOutput + commandCompletedEffect + CommandCompletedPayload (T20). ✔
- Build wiring: build:native, prepack assertion, files (T21). ✔
- CI: Rust build job (T22), retargeted enforcement job + ABI assertion + landrun removal (T23), release artifact placement (T24). ✔
- Dockerfile landrun-builder removal (T25). ✔
- Docs (T27). ✔

**2. Placeholder scan.** No "TBD"/"similar to Task N"/bare "add error handling". Every code step shows complete code. The only cross-references ("filled in Task N") are paired with a working throwing stub so each intermediate task still compiles and its own test passes.

**3. Type consistency.** `resolveHelperPath(arch, distRoot)`, `LandlockSandboxOptions { helperPath, distRoot, probeEnv, extraStdioFd }`, `buildSpec → LandlockSpec { command, strict, ro, rox, rw }`, `HelperStatus` union (`applied|denied|error`), `Status`/`Decision` Rust enums, and the `landlockAbi`/`enforcementDowngraded` field names are used identically across every task that references them. The Rust `apply_ruleset(negotiated: u32, spec: &Spec)`, `required_abi(&Spec) -> u32`, `decide(u32,u32,bool) -> Decision`, `to_status_line(&Status) -> String`, and `read_abi_version() -> Result<u32,String>` signatures match their consumers in T9/T10.

**Open items flagged for the implementer** (resolve against installed crate versions, not blockers):

1. **`landlock` crate API drift.** Variant names (`AccessFs::Truncate`, `MakeReg`, `Refer`), `AccessFs::from_all(ABI)`, `set_no_new_privs`, and `restrict_self` are written against `landlock` 0.4.x. If the resolved version differs, adjust names via `cargo doc -p landlock` (T4/T8 note this).
2. **`libc` Landlock constants.** `SYS_landlock_create_ruleset` and `LANDLOCK_CREATE_RULESET_VERSION` are assumed present in `libc`; T7 defines the flag as a local const to be robust if `libc` lacks it.
3. **`PR_SET_NO_NEW_PRIVS` sourcing.** The plan uses the `landlock` crate's `set_no_new_privs(true)` (its safe prctl wrapper, applied before `restrict_self`) rather than a separate `prctl` crate dependency — a deliberate simplification of the spec's dependency list that still satisfies "PR_SET_NO_NEW_PRIVS before restrict_self". If a standalone explicit prctl call is preferred, add it inside the audited `sys` module.
4. **`#![deny(unsafe_code)]` vs `forbid`.** The crate root uses `deny` (not `forbid`) so the single audited `sys` module can carry `#![allow(unsafe_code)]` for the three unavoidable raw operations (ABI syscall, fd 3/4 borrow, `pre_exec`) — exactly the spec's stated fallback. The spec's aspirational "genuinely forbid" is not achievable given the numeric-ABI syscall requirement; this is the one intentional deviation.
