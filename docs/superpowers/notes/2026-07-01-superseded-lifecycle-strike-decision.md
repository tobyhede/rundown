# Decision: strike persisted `superseded` lifecycle state

- **Date:** 2026-07-01
- **Area:** delegation lifecycle (roadmap item 13; Cluster B)
- **Supersedes:** the `superseded` passages in
  `docs/superpowers/specs/2026-06-17-claim-delegation-lifecycle-design.md`
  (terminology table row; the `claim_active -> superseded -> closed` side-path;
  the "claimable unless cancelled or superseded" clause). Those passages named a
  lifecycle state but never specified its mechanics; the code comments citing a
  "retry-semantics spec §3/§3.1/§4.4" reference a file that never existed.

## Decision

Do **not** add a persisted `superseded` per-claim status. The delegation
lifecycle is derived from live state by `delegation-lifecycle-read-model.ts`
(reading `resolvedCompletions` rows and substep `delegation` records). A stored
status union would:

- violate **derive-from-state / no synthetic IDs** (the read model is the single
  source of truth), and
- introduce a **persisted-state schema change**, which the no-migration rule
  forbids for active runs.

## How supersession is realized instead

"Retry supersedes pending collection" (the spec's one behavioral requirement) is
delivered behaviorally, not as a stored state:

1. Retry **force-cancels** the prior delegation (existing `abortDelegation` →
   `cancelledAt`; conceptually `cancelled -> closed`) and mints a fresh attempt.
2. `createDelegation` **resets** the re-issued substep to
   `{ status: 'pending', result: undefined }` (matching the machine RETRY hook).
3. The seam **consumes** the prior attempt's reported `resolvedCompletions` row
   (`RunbookLifecycleCommandService.#supersedePendingOutcome`).
4. `rd collect` readiness reads **live outcome rows**, so a superseded substep is
   uncollectable until the fresh attempt reports.

The supersession of a prior attempt is therefore observable (the pending outcome
is gone; the fresh token is live) without any persisted `superseded` field.

Consuming the row before persisting the reset substep **narrows** the window in
which a concurrent `rd collect` could drain the stale row — it does not fully
close it. A retry is not atomic against a concurrent collect; full lock-span
atomicity is tracked separately (Cluster D) and is out of scope here.

## Follow-up

Reconcile any **descriptive** doc under `docs/internal/` that asserts a persisted
`superseded` state so it reflects the derived model. (As of this note, none does —
the only `docs/internal` match for "supersed" is an unrelated mutation-testing
reference.) Do not edit the dated 2026-06-17 spec's substance.
