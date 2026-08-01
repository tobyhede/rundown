# 608 PR 11 — stacked-base addendum

**Date:** 2026-07-31

This addendum records the deliberate sequencing change requested while PR 10 is
still open. It supplements, and does not rewrite, the dated PR 11 plan and the
PR 9–14 correction ledger.

## Base and publication

- Branch: `issue-608/pr11-lifecycle-execution-fencing`
- Stacked base: `issue-608/pr10-atomic-claim-link`
- Base commit at branch creation: `089718dd3`
- Pull-request base: `issue-608/pr10-atomic-claim-link`
- After PR 10 merges, rebase this branch onto the merged `origin/main`, verify
  that the range contains only PR 11 changes, and retarget the pull request to
  `main` before merging.

This is an explicit exception to the original merge-first instruction. It does
not widen PR 11 or authorize replaying salvage commits.

## Current construction inventory

The implementation must account for the current, post-PR-10 graph rather than
the older file list alone:

- `RunbookLifecycleCommandService` owns pass/fail policy, target resolution,
  terminal forcing, completion draining, and terminal release/reporting.
- `packages/cli/src/helpers/lifecycle-seam-factory.ts` constructs the shared CLI
  lifecycle seam and is therefore a required wiring surface.
- `RunbookActorService.prepareActorMutation` already supplies the non-persisting
  compute half of the fence.
- `CoreEffectfulMutationExecutor` and `RunbookStoreActorCommitter` already own
  acquire → effect boundary → compute → guarded commit.
- `RunbookStateManager.captureRunAuthorityState` already atomically returns the
  bare run authority and state. Claim-authenticated capture must use the claim
  key derived from the presented bearer and return typed capture refusals.
- `ExecutionRecoveryService` already commits the pure `recoveryRequired`
  machine snapshot. PR 11 must exhaustively map `recovered`, `missing`,
  `not_pending`, and `superseded`.
- `goto-workflow.ts` still performs the GOTO actor transition after the core
  navigation policy seam and must be included in the migration.
- `execution.ts` still performs lifecycle transitions reached by the execution
  loop and must share the same fenced core path.

The final changed-file list is derived from this inventory and the required
tests. Any additional production path remains a stop-and-review event.

## Multi-run terminal decision

Complete/stop use an aggregate run-set lease and one atomic commit, not a
sequence of independently fenced mutations. The affected set contains every
inline-chain member that can be forced or released and, when terminal reporting
updates a delegating parent, that parent as well.

The protocol is:

1. capture and deterministically order every affected run;
2. acquire the entire set or none of it;
3. mark the entire set `effect_started` in one transaction;
4. prepare every machine-derived next state and completion/report update without
   persistence;
5. classify every captured authority/execution tuple, then atomically commit all
   states, completion changes, attempt phases, ownership clears, session-stack
   changes, and claim release/tombstones.

Any refusal leaves every member unchanged. Ambiguous failure abandons the exact
set to recovery atomically. A sequence of single-run leases or commits is not an
acceptable approximation because it can partially force a chain or report a
parent without releasing the corresponding child. The existing single SQLite
database and `acquireAll` primitive make this smaller than adding a durable
resumable-cleanup journal; no schema-version change is expected.

## Corrected crash evidence

Tests use the three real boundaries from the correction ledger:

1. owner dies after `claimed` and before `effect_started`;
2. owner dies after `effect_started` and before the transaction commits;
3. the transaction commits and the owner dies before observing/returning the
   committed result.

The third case must prove that a retry observes durable completion and does not
repeat the effect. There is no separate post-commit ownership-clear boundary:
the state write and ownership clear are one transaction.

## Validation adaptation

The repository's current mutation policy supersedes the older plan command that
deleted incremental state. Use `pnpm run test:mutate:changed` first (with
`--related-tests` where the dedicated unit suite is insufficient), retain
`--force` for source-change scopes, and judge changed-line survivors rather than
an aggregate percentage. Run `pnpm run verify` immediately before every push.
