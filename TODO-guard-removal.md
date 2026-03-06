# Follow-up: Remove `step.transitions` guard from vacuous-aggregation check

## Context

PR #79 upgraded the vacuous-aggregation validator check from warning to error but kept the `step.transitions &&` guard. Removing the guard (so it fires for steps with implicit transitions too) caused 36 test failures across conformance, parser, and validator tests.

## Problem

Many pattern runbooks have steps with sequential substeps using CONTINUE/STOP but no parent-level aggregation transitions. Without the guard, every step-with-substeps requires at least one DEFER substep, which is too strict for simple sequential patterns.

## Affected files (16+ pattern runbooks)

```
runbooks/patterns/composition/substep-runbook-list.runbook.md
runbooks/patterns/examples/code-review.runbook.md
runbooks/patterns/examples/install.runbook.md
runbooks/patterns/goto/goto-cross-step-substep.runbook.md
runbooks/patterns/goto/goto-named-substep.runbook.md
runbooks/patterns/goto/goto-substep-self-loop.runbook.md
runbooks/patterns/goto/goto-substep.runbook.md
runbooks/patterns/named-steps/named-step-mixed-substeps.runbook.md
runbooks/patterns/named-steps/named-step-named-substeps.runbook.md
runbooks/patterns/named-steps/named-step-with-substeps.runbook.md
runbooks/patterns/substeps/dot-named-substeps.runbook.md
runbooks/patterns/substeps/mixed-substeps.runbook.md
runbooks/patterns/substeps/substep-goto.runbook.md
runbooks/patterns/substeps/substep-pass-fail.runbook.md
runbooks/patterns/substeps/substep-retry.runbook.md
runbooks/patterns/transitions/substep-transitions.runbook.md
```

Plus 6 parser tests that construct steps with substeps without DEFER.

## Options

1. **Add DEFER to all affected runbooks** where substeps should propagate results, then remove the guard
2. **Refine the guard** to only check steps whose parent transitions use aggregation semantics (check for `step.transitions.all !== undefined` or similar)
3. **Keep current behavior** (guard stays, check only fires for steps with explicit parent transitions)

## To implement option 1

1. Remove `step.transitions &&` from `packages/parser/src/validator.ts:228`
2. Update validator comment (line 224) from "so only error" to remove mention of guard
3. Update test "does not fire when step has no parent transitions" to expect 1 error
4. For each affected runbook: add `- DEFER` to substeps that should propagate results to parent
5. For each affected parser test: add DEFER transitions or parent transitions as appropriate
6. Run `npm test` and `npm run check:spell` to verify
