# 608 Review Remediation Design

**Date:** 2026-07-22

## Objective

Resolve the technically valid findings recorded in
`.work/2026-07-22-608-coderabbit-review-findings.md` before further mutation-score
work. Preserve the SQLite state-machine architecture, the no-migration policy,
and R8's deliberate removal of linkage-version counters.

## Scope

### Delegated authority after parent deletion

An active delegated claim must not become ordinary child authority when SQLite's
`ON DELETE SET NULL` clears `claims.parent_run_id`. The immutable
`delegation_json` remains the durable indication that the claim was delegated.
Authority capture must retain the delegation's parent identity from that data so
the existing commit classifier returns `claim_superseded` when the live parent
row is absent.

A regression test will create a live delegated claim, delete its parent, and
prove that capture refuses it. The test must exercise the persisted store rather
than a synthetic classifier row.

### Store close/open serialization

The store registry will retain a per-database closing promise from the moment an
entry is removed until its driver disposal settles. A new open for the same key
must await that promise before opening a replacement driver. Clearing closing
state must use identity checks so an older close cannot erase a newer close.

The same rule applies to single-store and close-all operations. Disposal remains
best-effort and must not mask the caller's work. A deterministic race test will
hold disposal open and prove replacement construction does not begin until the
close is released.

### Recovery must not repeat an interrupted effect

Recovery coverage will persist a real machine snapshot at a command invoke
boundary, transition its execution attempt to `recovery_pending`, and recover it
through actor implementations that are inert or fail if invoked. The test must
prove the command callable is not invoked again and retain the existing
`recoveryRequired` snapshot assertions.

Production recovery code changes are required only if this regression test
exposes repeat execution. Recovery continues to send only
`EXECUTION_OUTCOME_UNKNOWN` and never retries an ambiguous effect.

### Adapter and probe hardening

- `isSqliteBusy` will normalize an integer SQLite result code to its low-byte
  primary code before comparing it with `SQLITE_BUSY` and `SQLITE_LOCKED`.
- Schema tests will exclude `sqlite_%` internals and compare the complete set of
  application tables with the expected set.
- The WebContainer SQLite probe will retain and await its output-drain promise
  after process exit before returning captured output.

## Explicit Non-Goals

- Do not restore `parent_linkage_version`; R8 deliberately removed a counter
  that had no legitimate transition.
- Do not rewrite existing dated prospective plans or specifications.
- Do not add raw compute-error logging; the reviewed executor has no established
  error-detail logging seam, and arbitrary external errors may contain secrets.
- Do not perform cosmetic promise-assertion rewrites as part of this remediation.
- Do not weaken mutation thresholds, exclude mutators, or lower timeouts.

## Test and Commit Strategy

Every behavior change follows RED-GREEN-REFACTOR: add the smallest regression,
run it and record the expected failure, implement the minimal correction, then
rerun the focused suite. Finish with core and site type/lint checks appropriate
to the touched files.

Keep commits reviewable by domain:

1. delegated-authority and recovery-safety regressions/fixes;
2. store-registry close/open serialization;
3. SQLite adapter, schema assertion, and WebContainer probe hardening.

Existing unrelated modifications, including `.serena`, `.superpowers`, dated
plans/notes, and the uncommitted R8 mutation tests, remain untouched except where
the authority regression must be integrated carefully into the already-modified
runbook-store test file.
