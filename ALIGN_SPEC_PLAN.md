# Align `SPEC.md` and `FORMAT.md` with Current Runtime Behavior

## Summary
Audit result: the referenced worktree docs are behind current implementation.  
They miss both earlier language/runtime changes (runbook-list shorthand, FOR iteration-level actions) and the newest completion-routing semantics (frame+entry isolation for parallel substep completions and re-entry safety).

This plan updates only:

- `/Users/tobyhede/psrc/rundown/.worktrees/for-loop-data-source-refactor-II/docs/SPEC.md`
- `/Users/tobyhede/psrc/rundown/.worktrees/for-loop-data-source-refactor-II/docs/FORMAT.md`

and makes them decision-complete against current behavior in parser/compiler/CLI.

## Why This Change Is Required (context to include in docs)
Add explicit rationale text: parallel substep completions plus control-flow re-entry (`GOTO`, `RETRY`, FOR iteration changes) can produce stale/late completions if identity is only cursor-based.  
Current runtime solves this by scoping completion application to `frame + entry + substep`, which prevents cross-entry misapplication and keeps fan-in deterministic.

## Public Interface / Semantics To Document
These are user-visible language/runtime contract updates that must be reflected:

1. Step-level runbook list is syntax sugar for implicit substep `.1`.
2. Canonical runtime target identity is `step + substep + iteration`; `STEP.INDEX.SUBSTEP` is display-only.
3. FOR nested transitions (under `- FOR ...`) are iteration-level and allow `CONTINUE/BREAK/GOTO/STOP/COMPLETE` (+ `RETRY` wrapper semantics).
4. Iteration-level retry order is deterministic: retry first, then exhausted action.
5. Iteration-level `BREAK` contributes current iteration result to parent aggregation; `GOTO/STOP/COMPLETE` bypass parent aggregation.
6. Nested non-transition bullets under FOR are invalid (must fail parse, not be ignored).
7. Completion routing semantics:
- Acceptance requires active frame+entry match.
- Out-of-order completions in same frame+entry are retained and drained in substep order.
- Cross-frame/cross-entry completions are rejected as stale.
8. Compatibility note: legacy in-progress state may lose ambiguous deferred completions (safe stale-drop behavior).

## Implementation Plan

1. Baseline sync from current docs
- Bring both worktree files up to parity with current root versions first (the large existing drift), including:
  - runbook-list shorthand wording
  - aggregation complement rule
  - FOR iteration-level action set notes
  - execution path notation
  - code info-string case-insensitivity
  - grammar tightening (`positive_integer`, optional whitespace in `{{ }}`, frontmatter openness)

2. Add missing “recent changes” semantics to `SPEC.md`
- Insert a new subsection under runtime identity (after current identity/path notation) titled:
  - `Execution Entry Isolation (Runtime)`
- Normative bullets:
  - define `frame = step|iteration`
  - define monotonic `entry` per frame
  - define completion application key `frame + entry + substep`
  - stale rejection rule (mismatch on frame/entry)
  - deterministic fan-in drain rule (ordered by declared substeps)
- Add a short rationale paragraph (late completion prevention across re-entry).
- Extend compatibility section with legacy-state handling note (ambiguous deferred completions treated stale).

3. Add matching constraints to `FORMAT.md`
- Under transition/for-clause rules add explicit structure rule:
  - nested FOR bullets must be transition paragraphs; non-transition nested structures invalid.
- Under execution path notation add runtime semantics subsection:
  - `STEP.INDEX.SUBSTEP` display-only
  - frame/entry-scoped completion application
  - stale rejection and ordered drain behavior
- Keep this as normative runtime format behavior (not authoring grammar).

4. Ensure wording matches actual implementation
- Validate every statement against code paths:
  - parser FOR nested bullet rejection (`packages/parser/src/parser.ts`)
  - FOR-level action validation (`packages/parser/src/validator.ts`)
  - iteration retry/exhaustion and break/goto semantics (`packages/core/src/runbook/compiler.ts`)
  - frame/entry state and completion keying (`packages/core/src/runbook/execution-lifecycle-service.ts`, `packages/core/src/schemas.ts`)
  - acceptance/rejection and drain pipeline (`packages/cli/src/helpers/transitions.ts`, `packages/cli/src/services/execution.ts`)

5. Consistency pass
- Ensure no conflicting text remains (old “deferred frontier” wording, BREAK-only-in-substeps wording, runbooks-as-third-body wording).
- Ensure terminology is consistent:
  - `at` for display location
  - `step + substep + iteration` for canonical target identity
  - `frame`/`entry` for runtime isolation (internal semantics)

## Test Cases and Scenarios (documentation validation checklist)

1. Step-level runbook list equivalence
- Explicitly show `## 1` + runbook list vs explicit `### 1.1` equivalence.

2. FOR iteration-level behavior
- Example with nested FOR transitions using `RETRY ... BREAK`, and parent aggregation effect.
- Example with iteration-level `GOTO` bypassing parent aggregation.

3. Stale completion prevention
- Example command sequence where completion from prior re-entry is rejected due to entry mismatch.

4. Parallel out-of-order completion
- Example where substep `1.2` resolves before `1.1`; state remains in current frame until ordered drain can apply.

5. Invalid FOR nested bullet
- Example malformed nested content under FOR that must be rejected.

## Acceptance Criteria
- Both target files contain all semantics listed above with no contradictions to current runtime behavior.
- All statements are traceable to implementation paths listed in this plan.
- Legacy/deferred compatibility behavior is explicitly documented (safe stale-drop context).
- Reader can answer “why frame+entry exists” without reading code.

## Assumptions and Defaults
1. Source of truth is current implementation in `/Users/tobyhede/psrc/rundown/packages/*` (not historical behavior).
2. Scope is limited to the two requested docs.
3. Runtime-internal concepts (`frame`, `entry`) are documented only to explain observable behavior and failure modes.
4. If any existing wording conflicts, implementation wins and docs are updated accordingly.
