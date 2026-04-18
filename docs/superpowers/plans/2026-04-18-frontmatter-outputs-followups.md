# Handoff: Follow-ups After Chained-OUTPUTS Plan

> **Status:** Not scheduled. Each section below is a tracked-issue draft — lift any one into a ticket or a new plan when ready.
>
> **Parent work:** `docs/superpowers/plans/2026-04-18-fix-chained-outputs-and-stale-finalvars.md` (merged) and `docs/superpowers/plans/2026-04-18-frontmatter-outputs-cleanup.md` (the stop.ts + TSDoc cleanup plan). Read those first for the context that led to these follow-ups.

**Branch state at handoff:** `frontmatter-outputs` ahead of `origin/frontmatter-outputs` by 12 commits (full plan + cleanup). `npm run verify` exits 0. No open issues blocking the branch from a correctness perspective — the items below are latent bugs, intentional divergences, or structural improvements that were deliberately scoped out.

**Priority ordering:** `[1]` is the highest-value next bite because it is real user-facing behaviour that's broken today with nothing else needed to unblock it. `[2]` needs a product decision first. `[3]` is the biggest but also the only one that would meaningfully reduce future bug surface.

---

## [1] `scenarios:` frontmatter loses step OUTPUTS in manual `rd pass` flow

> **⚠️ Stale / not reproducible in this worktree (2026-04-18 investigation).**
>
> Re-running the reproducer against the worktree's own build (`node packages/cli/dist/cli.js …`) shows OUTPUTS land correctly in `state.variables` with scenarios frontmatter present. The original report was produced with `npx rd`, which in this monorepo resolves to `/Users/tobyhede/psrc/rundown/packages/cli/dist/cli.js` — the **main worktree's** CLI, not this worktree's. Verify with `node -e "console.log(require.resolve('@rundown-org/cli/package.json'))"`.
>
> On `main`, OUTPUTS persist to `.rundown/contexts/<ContextId>/outputs.json` (old channel-based model), never to `state.variables`. The "control works, scenarios breaks" asymmetry was an artifact of looking at the wrong storage location; neither case populates `state.variables` on main.
>
> **Rule of thumb for future worktree-scoped testing:** do not trust `npx rd` / `rd` / `rundown` on `$PATH` — they bind to the first install Node resolves, typically the main checkout. Use `node packages/cli/dist/cli.js` (after `npm run build` in `packages/cli`) when verifying behaviour on a feature branch.
>
> Leaving the item below as-written for historical context. No action required.

### Symptoms

A runbook with a `scenarios:` frontmatter block and step-level `OUTPUTS` silently loses those OUTPUTS in the manual-pass code path. The template reference `{{Message}}` in downstream steps renders as a literal, and final `state.variables` is missing the written key.

The bug is **pre-existing** — not introduced by the chained-outputs plan. But it was only surfaced because Task 7's manual smoke test walked through the exact shape of runbook that triggers it.

### Reproducer

From `/Users/tobyhede/psrc/rundown/.worktrees/frontmatter-outputs`:

```bash
rm -rf .rundown/runs .rundown/session.json

# Broken: runbook WITH scenarios frontmatter
npx rd run --prompted runbooks/context-passing/outputs-inputs.runbook.md
npx rd pass
cat .rundown/runs/*.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('variables:', d['variables'])"
# Output: variables: {}   ← Message missing
```

Now the control case — identical runbook BODY, no `scenarios:` frontmatter:

```bash
rm -rf .rundown/runs .rundown/session.json
cat > /tmp/no-scenarios.runbook.md <<'EOF'
---
name: no-scenarios
---
# Context Passing

## 1. Produce output
- PASS CONTINUE
- FAIL CONTINUE
- OUTPUTS
  - Message "hello from step 1"

## 2. Consume input
- PASS COMPLETE
- FAIL STOP

The message is: {{Message}}
EOF

npx rd run --prompted /tmp/no-scenarios.runbook.md
npx rd pass
cat .rundown/runs/*.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('variables:', d['variables'])"
# Output: variables: {'Message': 'hello from step 1'}   ← works
```

### What works today

- `packages/cli/__tests__/integration/context-passing-outputs.test.ts` — 5 passing tests that exercise the same step/OUTPUTS/INPUTS flow. The test's runbook has no `scenarios:` frontmatter. That's why the test suite does not catch this.
- Auto-execution path (`rd run` with command blocks) appears unaffected in spot-checks (not exhaustively verified).

### Root-cause hypothesis (unconfirmed)

Two possibilities, both plausible:

1. **Parser side:** `scenarios:` presence changes how the frontmatter/body is parsed, and something downstream reads `currentStep.outputs` as empty/undefined. Look at `packages/parser/src/frontmatter.ts` — does the `scenarios:` schema leak into the body-parsing path? Grep for `scenarios` in parser and core. See `docs/SCENARIOS.md` for the stated semantics (internal testing/demo feature, not public spec).
2. **Runtime side:** something in the CLI checks `frontmatter.scenarios` and short-circuits the OUTPUTS write, e.g., assuming a scenarios-enabled runbook is inside a test harness that persists differently.

My smoke evidence narrows it: `state.variables` is `{}` AND `snapshot.context.variables` is `{}` after `rd pass` on step 1 (with OUTPUTS declared). That means the `allEvaluated` object at `packages/cli/src/helpers/transitions.ts:521-537` is either empty or the subsequent `sendAndSync` isn't landing. Either `currentStep.outputs` is empty when `scenarios:` is present (parser issue), or the eval returns empty (unlikely, same expression works without scenarios), or the code is skipping the write entirely (runtime guard).

### Investigation plan

1. Add a temporary `console.error` inside `transitions.ts:538` logging `currentStep.outputs`, `allEvaluated`, `actionType` for both the broken and control runbook. Compare.
2. If `currentStep.outputs` differs, the bug is parser. Inspect how frontmatter parsing interacts with `scenarios:` in `packages/parser/src`.
3. If `currentStep.outputs` is identical but `allEvaluated` is empty, trace `evaluateStepOutputs` (`packages/cli/src/helpers/step-outputs.ts`). Maybe templateVars is missing something when scenarios is set.
4. If `allEvaluated` is populated but storage is empty, the bug is in the SET_VARIABLES / `sendAndSync` path (`packages/core/src/runbook/actor-service.ts:277`). Maybe the actor restore is silently dropping vars.
5. Remove the logs before committing any fix.

### Acceptance criteria

- Add an integration test mirroring `context-passing-outputs.test.ts`'s scenario 1, but with `scenarios:` frontmatter present in the runbook. The test must fail before the fix and pass after.
- Existing tests in `context-passing-outputs.test.ts` remain green.
- No regression in `.rundown/` state-file shape.

### Estimated size

Half a day to find the root cause; the fix itself is likely one-line depending on where the skip happens.

---

## [2] OUTPUTS-on-FAIL: spec/code divergence needs product decision

### Symptoms (not a bug per se)

The spec says OUTPUTS evaluate on **every step completion** (PASS or FAIL). The code only evaluates on PASS. Runbook authors reading the spec expect FAIL-path variable plumbing; they will not get it today.

### Evidence

**Spec** (`docs/cipherpowers/specs/2026-04-17-inputs-outputs-variable-flow-design.md:41`):

> Evaluated on **every** step completion, regardless of PASS or FAIL. This is intentional: FAIL paths may need to pass information forward (e.g. an error code or partial result for a recovery step).

**Code** — both OUTPUTS evaluation paths gate on PASS only:

- Execution-loop path — `packages/cli/src/services/execution.ts:245`:
  ```typescript
  if (result === 'pass') {
    // ... evaluate step OUTPUTS, inject via SET_VARIABLES or manager.update
  }
  ```
- Manual-transition path — `packages/cli/src/helpers/transitions.ts:509`:
  ```typescript
  if (config.lastResult === 'pass') {
    // ... evaluate step OUTPUTS, inject via SET_VARIABLES or manager.update
  }
  ```

No FAIL branch exists in either place.

### Decision required (before touching code)

**Option A — align code to spec.** Evaluate and write step OUTPUTS on FAIL too. Use case: a step that fails still produces a useful diagnostic value ("PartialCount", "ErrorCode") that downstream recovery steps consume. Rationale matches the spec's stated intent.

**Option B — align spec to code.** Leave the code as-is, edit the spec to say "OUTPUTS evaluate on PASS only." Simpler. Matches current behaviour. Forces authors to use explicit transition routing (e.g., FAIL → a recovery step that produces the needed output on its own PASS).

**Option C — add a new opt-in modifier.** E.g., `OUTPUTS ALWAYS` vs default-PASS-only. Most flexible but adds syntax surface.

### Recommended first step

Ask the product owner (likely Toby) which option reflects intent. My read: the spec was written with Option A in mind but nobody has needed it yet — the failing-step recovery pattern is probably rare enough that Option B is pragmatic. Option C is over-engineering until there's evidence authors want both.

### Implementation sketch (Option A, if chosen)

- Change `result === 'pass'` to `result === 'pass' || result === 'fail'` at both sites.
- For FAIL, compute `allEvaluated` the same way but from `currentStep.outputs` / `executionUnit.outputs` (no change in the fan-out logic).
- For a FAIL transition hitting a terminal (FAIL STOP), route through the same `manager.update({ variables })` direct path (as with PASS COMPLETE).
- For non-terminal FAIL, SET_VARIABLES via `sendAndSync`. Verify XState's SET_VARIABLES handler (`packages/core/src/runbook/compiler.ts:2125-2133`) is unconditional (it is — the handler is on the root `on:` block).
- Add failing tests first: a runbook with `FAIL CONTINUE` and an OUTPUTS line; assert the variable is in `state.variables` after the FAIL.
- Consider whether FAIL should also feed frontmatter `outputs:` at `maybePersistFrontmatterOutputs`. Likely yes, by symmetry. Task 4's reload already sees whatever lands in storage.

### Acceptance criteria

- Whichever option is chosen, code and spec agree.
- If Option A: new integration test covering FAIL-with-OUTPUTS flow, plus spec cross-reference in the plan.
- If Option B: update the spec line 41 to reflect current behaviour, and note in a migration/CHANGELOG that this was deliberate.

### Estimated size

Option A: ~1 day with tests.
Option B: 15 minutes (spec edit only).

---

## [3] `completed` / `stopped` stored as pseudo-variables — extract to lifecycle field

### Problem

The runbook's terminal status (completed vs stopped) is stored inside `state.variables` as the keys `completed` and `stopped`:

```json
{
  "variables": {
    "Message": "hello",
    "completed": true
  }
}
```

This conflates two different concepts:
- **Template variables** — string/number/boolean values authors reference as `{{Message}}`.
- **Lifecycle metadata** — whether this run is complete or stopped.

Consequences observed during this plan's work:

1. **Bug surface.** The entire class of stomp-on-merge bugs fixed in Task 5 (and the sixth site in `stop.ts`) exists precisely because the terminal flag and template variables share the same merge semantics. If `completed` were a top-level field, the terminal write could not stomp template variables.
2. **Author confusion.** An author who declares `OUTPUTS - completed "true"` creates a collision with the runtime flag. (Unclear whether validation catches this today — grep `state.variables.completed` for uses; there are at least parent-propagation and terminal-detection paths.)
3. **Type widening.** `state.variables` is typed as `Record<string, boolean | number | string>` precisely because `completed: true` needs to fit alongside string OUTPUTS. A dedicated field would let OUTPUTS be `Record<string, string>`, matching the spec.
4. **Frontmatter outputs leak.** When `maybePersistFrontmatterOutputs` merges `state.variables` into `effectiveVars`, `completed: true` becomes available as `{{completed}}` in frontmatter output expressions. Probably harmless but semantically incorrect.

### Proposed shape

Add a top-level `lifecycle` field to `RunbookState`:

```typescript
type Lifecycle = 'running' | 'completed' | 'stopped';

interface RunbookState {
  // ... existing fields ...
  variables: Record<string, string>;   // now narrowed — OUTPUTS only
  lifecycle: Lifecycle;
  // `completed`/`stopped` removed from variables
}
```

All reads of `state.variables.completed === true` → `state.lifecycle === 'completed'`. Same for stopped.

All writes of `{ variables: { completed: true } }` → `{ lifecycle: 'completed' }` (and drop the variables field from the update payload entirely — the Task 5 simplification takes its final form).

### Call-site audit (non-exhaustive, from grep during this plan's work)

Readers of `completed`/`stopped` inside `state.variables`:
- `packages/cli/src/commands/pass.ts` around line 63 — parent propagation terminal check.
- Other commands that propagate to parent likely have the same check. Grep `state.variables.completed` and `variables.stopped`.

Writers:
- `packages/cli/src/helpers/transition-orchestrator.ts:215` (completed) and `:232` (stopped).
- `packages/cli/src/services/execution.ts:546` (completed for-loop) and `:565` (stopped for-loop).
- `packages/cli/src/commands/complete.ts:50` (manual completer).
- `packages/cli/src/commands/stop.ts:68` (manual stopper).

### Migration note

`CLAUDE.md` contains this explicit principle:

> **Principle:** Never migrate persisted runbook state between versions. On schema changes, running runbooks should be completed/closed and restarted. The CLI should detect stale state and prompt the user rather than attempting silent migration.

So this refactor would ship as a schema version bump. Runs persisted under the old schema (with `completed`/`stopped` inside `variables`) should be detected and prompted for cleanup rather than migrated. Update the state load path in `packages/core/src/runbook/state.ts` accordingly.

### Acceptance criteria

- Every read/write of `state.variables.completed` and `.stopped` migrated to a top-level `lifecycle` field.
- `state.variables` type narrows to `Record<string, string>` (spec alignment).
- Old persisted state is detected at load and prompts the user (no silent migration).
- Existing tests pass with minimal edits (each site where tests asserted on `state.variables.completed` rewrites to `state.lifecycle === 'completed'`).
- Parent-propagation logic continues to work end-to-end (integration test for delegation chain terminal propagation).
- Frontmatter outputs `{{completed}}` expressions stop resolving (if they ever did — check behaviour before removing).

### Estimated size

2-4 days. Main effort is tracking down every consumer and rewriting tests. The code change itself is mechanical.

### Is this worth doing now?

Only if:
- Team capacity exists for a schema-breaking refactor.
- There's appetite for catching the remaining latent bug class proactively rather than reactively (Task 5's bug already slipped through once; it will slip through again on the next contributor who spreads the variables snapshot).

If not now, this doc is the blueprint for when it's scheduled.

---

## Cross-references

- Parent plan: `docs/superpowers/plans/2026-04-18-fix-chained-outputs-and-stale-finalvars.md`
- Cleanup plan: `docs/superpowers/plans/2026-04-18-frontmatter-outputs-cleanup.md`
- Related design doc: `docs/superpowers/specs/2026-04-18-outputs-in-state-machine-design.md` (the in-flight XState-native OUTPUTS refactor; items [2] and [3] may land more naturally during or after that work)
- Spec: `docs/cipherpowers/specs/2026-04-17-inputs-outputs-variable-flow-design.md`
- Scenarios doc: `docs/SCENARIOS.md`
