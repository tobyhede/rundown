# Size gate scope: where 6,400 and 8,600 came from

> **Status:** Measurement record for the [ADR 0005](../../adr/0005-one-writer-per-run.md) size gates, written at the end of epic #899 (#908, design review #920). It records the derivation of the two gate numbers, which until now lived only in a design-session transcript, and corrects the scope the `machinery` gate is measured over. It supersedes the scope, not the numbers, of [2026-10-07-size-baseline-before-rebuild.md](2026-10-07-size-baseline-before-rebuild.md).

## Derivation (2026-09-29 design session, questions Q38 and Q39)

Q38 re-derived the rebuild's size mechanism by mechanism, preferring reuse of proven code, and split the source in two:

| Subset | Lines then | Estimate after | Gate (estimate + 15%) |
| --- | --- | --- | --- |
| (1) Delegation, authority, concurrency | ~21,000 | ~5,550 | 6,400 |
| (2) General machinery touched: storage (store, schema, drivers), the rest of `lifecycle-command-service.ts`, `runbook-pipeline.ts`, the core of Run Progression, session and targeting | ~18,300 | ~7,450 | ~8,600 |

The subset (2) line items were: storage ~2,500, `lifecycle-command-service.ts` 1,800, `runbook-pipeline.ts` 1,200, `run-progression.ts` 1,000, session and targeting 150. Q39 chose to gate both subsets, so that logic could not move across the line to dodge the delegation gate. ADR 0005 recorded the result.

## The scope error

#901 committed `scripts/size-allowlist.json`. Its `machinery` list took 36 files totalling 35,355 lines. That matched the earlier "28–35K entangled" audit figure that the spec quotes, not the ~18,300-line subset the 8,600 gate was estimated over. It added modules no estimate covered: the compiler, the actor service, the output and state schemas, the state types, the error codes, and a dozen CLI command files. Measured over that list, machinery read 21,124 against 8,600 at the end of #908, which raised design review #920.

## Corrected measurement

The `machinery` list now names the subset (2) files that still exist; the session modules were deleted by the rebuild. `storage/mutation-result.ts` stays on the `authority` list so it is not counted twice.

| Area | Estimate | At the end of #908 |
| --- | --- | --- |
| Storage (store, schema, registry, drivers) | ~2,500 | 3,817 |
| `lifecycle-command-service.ts` | 1,800 | 1,007 |
| `runbook-pipeline.ts` | 1,200 | 952 |
| `run-progression.ts` | 1,000 | 1,603 |
| Session and targeting | 150 | 484 |
| **Total** | **~7,450** | **7,863** |

Both gates hold: `authority` 5,733 / 6,400 and `machinery` 7,863 / 8,600. Storage, Run Progression and targeting each exceed their own line item, and the lifecycle service and pipeline come in under theirs. `verify` runs `measure-size.mjs --enforce`, so growth past either gate fails the build and triggers a design review rather than a higher limit.

Whether the compiler and the other general modules should shrink is a separate question about the general engine. They were never part of this budget.
