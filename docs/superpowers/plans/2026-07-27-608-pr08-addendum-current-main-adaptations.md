# 608 PR 8 addendum — selective recovery and storage hardening

**Amends:** [2026-07-23-608-pr08-recovery-storage-hardening.md](2026-07-23-608-pr08-recovery-storage-hardening.md). That plan is write-once and unchanged; read it first, then apply the deltas below. Where the two disagree, this file wins.

**Tracked in:** [#648](https://github.com/tobyhede/rundown/issues/648).

**Base:** `c51ff24f39db0012b4ab26bb9bfbca973ad30d7e`, the merge of PR 7 (#655). Re-fetch `origin/main` and record the actual base before branching; if it differs, re-audit every adaptation below before applying it.

**Why this exists:** PR 8 was written as an exact replay of twelve salvage commits. Current `main` now contains later review fixes, already-satisfied storage hardening, and a different site layout. Replaying the commits verbatim would regress recovery truthfulness, mix the later output-contract cutover into this PR, and target a site path that does not exist.

This addendum narrows PR 8 to recovery and storage hardening. It does not change the remaining sequence: PR 8 → PR 9 → PR 10 → PR 11 → PR 12 → PR 13 → PR 14.

## Delta 1 — salvage commits are hunk-level evidence

Do not apply the original instruction to cherry-pick all twelve commits exactly. Inspect each commit against the recorded base and retain only recovery/storage behavior that remains absent. Already-satisfied hunks are verification evidence, not changes to replay.

The owned commit order remains useful for review:

```text
6f1e323fe c1298a91d 9edfa08ef ebc396411 2b86d2188 fdfb1c6aa
3c62faca9 401522b07 c3e0c156d 177e049ed 4b67d806b 5cd9566a4
```

For every retained hunk, record its source commit in the PR description. For every omitted hunk, record one of: already present on `main`, superseded by a later fix, or deferred to PR 13/14. The resulting allowlist is the union of paths containing retained hunks, not the union of every historical commit path.

## Delta 2 — preserve truthful recovery recording

Do not replay `6f1e323fe`'s failure handling around `abandonToRecovery` over the current implementation in `effectful-mutation-executor.ts`.

Current `main` deliberately distinguishes recovery that was durably recorded from recovery that was not recorded. If the recovery write returns `not_recorded`, the executor rethrows the primary effect error; it must not emit `recovery_required` for state that was never persisted. Preserve that behavior and its tests.

Retain or adapt the commit's other dead-owner protocol improvements only after proving they do not weaken this invariant:

```text
recovery_required ⇒ a durable recovery_pending attempt exists
```

## Delta 3 — keep PR 8 out of the output-contract cutover

`ebc396411` mixes recovery/storage hardening with a broad 42-path event and output-contract cutover, including removal of `runbook_started.statePath`. PR 8 owns only its still-needed recovery/storage hunks, including schema-open cleanup, recovery commit-row validation, and any unchanged-stash generation protection not already present.

Defer these concerns to PR 13/14:

- removal of `statePath` from event, CLI, renderer, schema, snapshot, and documentation contracts;
- broad output-schema and rendering changes;
- release-level schema parity and documentation evidence.

Do not partially remove `statePath` in PR 8. The public contract must move once, with its schemas, fixtures, renderers, snapshots, and docs in the same later PR.

## Delta 4 — adapt the WebContainer probe to current `main`

`c3e0c156d` names `site/src/pages/dev/sqlite-substrate-probe.astro`; the current page is `site/src/pages/sqlite-substrate-probe.astro`. The awaited stdout-drain fix is already present on `main`, so do not reimplement it or move the page in PR 8.

Retain the commit's missing native-driver cleanup and adapter contract tests when they are not already present. If a source-level regression test for the awaited drain is still valuable, adapt it to the current root page and list that exact test path as an allowlist expansion. PR 14 owns the `/dev` route move and the built-snapshot/offline proof.

## Delta 5 — do not expand PR 8 into liveness reconciliation

The transaction-local open-child predicate and `classifyDelegationLiveness` are not semantically identical. The divergence can cause false refusal or delayed self-healing, but the transaction-local guard does not accept stale mutation authority. Track reconciliation in its own issue; it is not a PR 8 or #608 seven-path blocker.

PR 8 may retain `c1298a91d`'s canonical active-frame correction where it belongs in recovery/targeting behavior. It must not claim that doing so reconciles every duplicated liveness predicate.

## Delta 6 — current mutation-testing policy replaces every historical command

The original whole-file Stryker command is superseded by the repository's current instructions. After implementation:

```bash
pnpm run test:mutate:changed --package core
```

Use `--related-tests` if an in-scope mutant is covered only through broader integration behavior. For any manual scope, use package-relative changed-line ranges and `--force`. Never run a whole-file campaign over a large existing source, never delete the incremental baseline as a substitute for `--force`, and never accept a run that instruments zero source files or zero mutants.

Judge the gate on in-scope `Survived` and `NoCoverage` mutants, not on aggregate percentage. Record the changed ranges, instrumented file/mutant counts, tests selected, and disposition of every in-scope survivor.

## Revised execution checklist

- [ ] Fetch `origin/main`, record the SHA, and confirm the base includes #655 and the later recovery truthfulness fix. If the SHA differs from the base above, re-audit this addendum before editing.
- [ ] Inspect the twelve owned commits in order. Build a retained-hunk ledger and derive the actual path allowlist from those hunks.
- [ ] Apply only the retained recovery/storage hunks. Preserve `not_recorded` behavior, omit the output-contract cutover, do not move the site page, and do not reapply the awaited drain fix.
- [ ] Run `git diff --check` and compare the changed paths with the retained-hunk allowlist. Any unrecorded path is a stop-and-review event.
- [ ] Run the amended plan's named core tests, plus every dedicated test for a retained source hunk. Confirm adapter parity, strict row validation, close/reopen serialization, and that recovery never repeats a persisted effect.
- [ ] Run `pnpm run build` before any CLI or site test that consumes built core output.
- [ ] Run `pnpm run test:mutate:changed --package core`; use `--related-tests` only when needed and record nonzero instrumentation plus survivor dispositions.
- [ ] Run `pnpm run verify`; record the retained/omitted hunk ledger in the PR description and #648; open and merge PR 8 before branching PR 9.

## Acceptance invariants

- A `recovery_required` result always names durably recorded recovery state.
- Recovery never repeats an effect whose committed attempt is already durable.
- Native SQLite and sql.js agree on cleanup, validation, and reopen behavior.
- PR 8 does not change the public `statePath`/output contract or the probe route.
- No mutation result is accepted from a zero-instrumentation or stale-cache run.
