---
'@rundown-org/core': patch
'@rundown-org/cli': patch
---

Fix the re-entry frontier seam's render ordering, deduplicate `findStepOrThrow`,
let the entry seam accept a caller-precomputed position, and correct a
misleading comment (code review follow-up on #817/#819/#820).

- **`projectAndConsumeReEntryFrontier` (core)**: rendering the execution unit —
  which can invoke non-idempotent `--helpers` JS — now happens AFTER
  `DELEGATE_FRONTIER_CONSUMED` commits, not before. Previously a failed commit
  still ran the render's side effects; the next retry re-projects the
  still-persisted frontier and would run them again. The render now runs against
  the committed state, mirroring the pattern `collection-service.ts`'s
  `finishCollection` already used for the fenced twin.
- **`findStepOrThrow` (core, cli)**: the CLI (`services/execution.ts`) and two
  core modules (`collection-service.ts`, `completion-service.ts`) each carried
  their own copy of this lookup. All three now import the canonical
  implementation from `execution-units.ts`.
- **`deriveExecutionUnitEntry` (core)**: accepts an optional caller-precomputed
  `position`, used instead of re-deriving one via `countNumberedSteps` +
  `buildStepPosition`. The CLI execution loop already computes this value once
  per iteration for its own error-reporting events; it now forwards it to
  `enterExecutionUnit` instead of paying for the identical derivation twice.
- **`runExecutionLoop`'s `prompted` fallback comment (cli)**: corrected.
  `RunbookState.prompted` and `CreateOptions.prompted` are genuinely optional at
  the type level (unlike `templateVars`, `load()` carries no fail-closed guard
  for a missing one). The fallback is unreachable only because of call-site
  discipline, not because the type forbids `undefined`.
