# Task A3 report

## Status

Complete.

## Commit

`a914d185d docs(core): correct claim liveness contracts`

## Summary

Corrected the renamed claim-seen API and field documentation so the raw mark
means holder liveness established after bearer verification and relevant grant
authorization. The subsequent mutation is explicitly independent: it need not
commit, advance, or succeed.

No runtime behavior, result unions, command classification, schemas, or dated
specification/plan provenance changed.

## Files changed

- `packages/core/src/runbook/session-service.ts`
  - Reframed `SessionService.recordClaimSeen` around authorized bearer
    presentation and holder liveness.
  - Kept AC5 primary: only the presented bearer's claim is recorded, and a
    parent cannot vouch for a child.
  - Replaced the stale `status`-polling rationale with caller-versus-target
    attribution for `status`, `stash`, and `pop`, including the deliberate
    under-reporting policy.
  - Corrected the method link to `SessionService.verifyClaimId`.
  - Preserved the complete non-reentrant session-lock warning, including the
    live-owner, five-second timeout, silently totalized `record-failed`, and
    stale-sighting symptoms.
  - Preserved and generalized RD-102 totality so recording cannot throw, block
    the protected mutation, or mask its outcome whether recording occurs before
    or after that outcome.
  - Corrected `ClaimSeenRecordResult` and the swallowed-error comment, which
    still carried commit/advancement semantics from the pre-rename contract.
- `packages/core/src/runbook/claim-id.ts`
  - Defined `ClaimRecord.lastSeenAt` as the holder's authorized bearer
    presentation and explicitly stated that later mutation success or progress
    is irrelevant.
  - Preserved the deliberate `lastSeenAt`/`updatedAt` separation.
  - Corrected `seenClaimRecord` TSDoc to describe the post-authorization holder
    observation rather than controlled-run advancement.
- `packages/core/src/runbook/claim-activity.ts`
  - Corrected the remaining production interface contract that said a holder
    becomes non-idle by advancing the run; it now derives from authorized bearer
    presentation.

## Requirement review

- Raw mark is holder liveness, not controlled-run progress: satisfied.
- Liveness is proved after bearer verification and grant authorization:
  satisfied.
- Later mutation need not commit, advance, or succeed: stated explicitly.
- AC5 presented-bearer-only attribution: preserved and made primary.
- Full non-reentrant session-lock warning: preserved in force and detail.
- RD-102 best-effort totality: preserved for both pre- and post-mutation
  recording order.
- `lastSeenAt` remains distinct from `updatedAt`: preserved.
- `status`, `stash`, and `pop` target-selector attribution: documented with
  deliberate under-reporting.
- Runtime behavior, unions, classifications, and dated provenance: unchanged.
- Exported-symbol TSDoc: complete for all touched exported contracts.

## Verification

- `pnpm exec biome check --formatter-enabled=true --linter-enabled=true packages/core/src/runbook/claim-id.ts packages/core/src/runbook/claim-activity.ts packages/core/src/runbook/session-service.ts` — passed.
- `pnpm exec eslint packages/core/src/runbook/claim-id.ts packages/core/src/runbook/claim-activity.ts packages/core/src/runbook/session-service.ts` — passed.
- `pnpm --filter @rundown-org/core check:types` — passed.
- `pnpm --filter @rundown-org/core exec jest --maxWorkers=2 --runInBand=false __tests__/runbook/claim-seen.test.ts __tests__/runbook/claim-activity.test.ts __tests__/runbook/claim-activity.properties.test.ts __tests__/runbook/delegation-schemas.test.ts` — 4 suites passed, 117 tests passed.
- `git diff --check` and staged diff check — passed.
- Commit-time Biome format and lint hooks — passed.

## Self-review

Reviewed the final diff against Task A3 and the 2026-07-17 liveness design.
Only contract-defining production comments changed. No executable TypeScript
tokens, data shapes, command classifications, tests, or dated documents changed.

## Concerns

None.

## Final review fix

Updated the three stale comments in
`packages/core/__tests__/runbook/claim-seen.test.ts` to match the governing
pre-mutation liveness contract. Each comment now states that best-effort,
total `recordClaimSeen` bookkeeping must neither prevent the subsequent
mutation nor mask its eventual outcome, while preserving the distinct test
rationale for save failure, outer lock-acquisition failure, and session-load
failure.

### Files

- `packages/core/__tests__/runbook/claim-seen.test.ts` — comments only; no test
  behavior or production code changed.
- `.superpowers/sdd/task-A3-report.md` — appended this final-review evidence.

### Verification

- `pnpm --filter @rundown-org/core exec jest __tests__/runbook/claim-seen.test.ts --runInBand`
  — exit 0; 1 suite passed, 15 tests passed, 0 snapshots; completed in 0.684s.
- `pnpm exec biome check --formatter-enabled=true --linter-enabled=true packages/core/__tests__/runbook/claim-seen.test.ts`
  — exit 0; checked 1 file in 53ms, no fixes applied.
- `pnpm exec eslint packages/core/__tests__/runbook/claim-seen.test.ts` — exit 0;
  no output.

### Self-review

Compared all three revised comments with `SessionService.recordClaimSeen` TSDoc
and the pre-mutation contract. The comments retain the reason unique to each
test and no longer claim that recording follows an already committed mutation.
Reviewed the diff to confirm that only comments and this report section changed;
test statements and production code are untouched.
