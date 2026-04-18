# Design: Move OUTPUTS Evaluation into the XState State Machine

**Date:** 2026-04-18
**Branch:** frontmatter-outputs

## Context

OUTPUTS evaluation (step-level variable assignments and frontmatter variable exports) currently lives in the CLI layer (`execution.ts`, `transitions.ts`, `runbook-pipeline.ts`). The machine produces a result (PASS/FAIL, done/stopped) and the CLI observes it, imperatively evaluates outputs, then writes back into machine state via `SET_VARIABLES` events or direct `manager.update` calls.

This creates two problems:

1. **Split responsibility.** The machine owns step results but not their consequences. The CLI must re-derive topology information (is this a substep? did the step advance?) that the machine already encodes structurally.
2. **Two write paths for variables.** `SET_VARIABLES` events work for live states; `manager.update` is used as a workaround for terminal states where XState silently drops events. The machine has no single owner for variable storage.

The fix: move evaluation into the machine as named actions in `setup()`, with output expressions embedded as params by the compiler.

---

## Behavior Changes

This refactor introduces two semantic changes alongside the structural move. Both are intentional.

**OUTPUTS fire on FAIL as well as PASS.** Previously, step OUTPUTS were only evaluated on PASS transitions. Under this design, `storeStepOutputs` fires on both PASS and FAIL. Rationale: OUTPUTS express "what this step produced" — a step that fails may still produce partial output (a log path, an error code, a computed value) that downstream steps or the parent runbook need. Gating on PASS was an arbitrary restriction, not a semantic requirement.

**Frontmatter OUTPUTS fire on STOPPED as well as COMPLETE.** Previously, frontmatter outputs were only evaluated when the runbook completed normally. Under this design, `storeFrontmatterOutputs` fires on both `COMPLETE` and `STOPPED`. Rationale: a stopped runbook is still a terminal state. Any outputs accumulated up to that point are valid and useful to the parent in a delegation chain.

Both changes require inverting three existing test assertions (see Testing section).

---

## Architecture

### Before

```
CLI layer (execution.ts / transitions.ts):
  - Observes machine result (PASS/FAIL)
  - Calls evaluateStepOutputs(), sends SET_VARIABLES to machine
  - On terminal: calls manager.update({ variables }) directly (bypasses XState)
  - On done/stopped: calls maybePersistFrontmatterOutputs(), manager.update({ finalVars })
```

### After

```
Core layer (compiler.ts + output-evaluator.ts):
  - storeStepOutputs named action: evaluates expressions, assign() into context.variables
  - storeFrontmatterOutputs named action: evaluates expressions, assign() into context.finalVars
  - Compiler embeds storeStepOutputs on the right transitions structurally
  - COMPLETE/STOPPED final states have storeFrontmatterOutputs as entry action

CLI layer (actorService):
  - Reads context.finalVars at actor completion, persists to RunbookState.finalVars
  - No OUTPUTS evaluation code anywhere in CLI
```

`SET_VARIABLES` remains in the machine. Its only remaining CLI caller is `delegation-completion.ts`, which forwards a completed child runbook's `finalVars` into the parent actor's `context.variables` across runbook boundaries. This is a distinct concern from OUTPUTS evaluation and stays.

---

## New Module: `packages/core/src/runbook/output-evaluator.ts`

Pure functions extracted from CLI's `template-renderer.ts` and `step-outputs.ts`. No I/O, no side effects.

```typescript
type OutputVars = Readonly<Record<string, string | number | boolean>>;

/** Evaluates a single output expression against vars.
 *  Four forms: {{ path "file.json" }}, {{ VarName }}, "literal", bare_identifier.
 *  On failure: throws (caller decides to omit or surface). */
export function evaluateOutputExpression(expr: string, vars: OutputVars): string;

/** Evaluates step-level output declarations.
 *  Naked form (no value) is invalid at step level — skipped with warning.
 *  Failed evaluations are OMITTED from the result (key not written; prior value in context.variables
 *  is preserved). This matches the existing non-fatal contract: failure is surfaced via
 *  ERROR_OCCURRED event, not by writing an empty string. */
export function evaluateStepOutputDeclarations(
  outputs: readonly OutputDeclaration[],
  vars: OutputVars,
): Record<string, string>;

/** Evaluates frontmatter output declarations.
 *  Naked form (no value) is resolved by name lookup from vars — this is the canonical
 *  frontmatter case (e.g. `- PlanPath` exports the current value of PlanPath).
 *  Failed evaluations are OMITTED (same contract as evaluateStepOutputDeclarations). */
export function evaluateFrontmatterOutputDeclarations(
  outputs: readonly OutputDeclaration[],
  vars: OutputVars,
): Record<string, string>;

/** Reduces TemplateVarValue map to OutputVars, stripping non-serializable values.
 *  JsonArray → comma-joined string (consistent with template rendering).
 *  JsonObject → JSON string.
 *  JsonArrayStream → omitted with warning (lazy stream, no concrete value at evaluation time). */
export function flattenTemplateVars(
  vars: Readonly<Record<string, TemplateVarValue>>,
): OutputVars;

/** Builds the complete evaluation frame from machine context at transition time.
 *  Merges context.templateVars (base vars) + context.variables (accumulated step outputs) +
 *  dynamic per-step values derived from context.step, context.substep, context.forStack
 *  (Step, Index, context.current.*, loop iteration variable).
 *  Called inside named action params resolvers — fires pre-transition, so context.step
 *  still reflects the completing step, not the next one. */
export function buildExecutionFrame(context: RunbookContext): OutputVars;
```

The `path "file.json"` helper inside `evaluateOutputExpression` reads `WorkPath` and `ContextId` from the vars map — always plain strings in `context.templateVars`, no CLI-specific type dependency.

`template-renderer.ts` retains its own `evaluateOutputExpression` wrapper (used for other template rendering concerns) but delegates to the core function internally.

---

## RunbookContext Changes

```typescript
export interface RunbookContext {
  // ... existing fields unchanged ...

  /** Serializable base template variables (WorkPath, ContextId, Branch, user vars, etc.).
   *  Populated at actor initialization from RunbookState.templateVars via flattenTemplateVars()
   *  (strips JsonArrayStream; converts JsonArray/JsonObject to strings).
   *  Stored in the XState snapshot so resumed actors have access to base vars. */
  readonly templateVars: Readonly<Record<string, string | number | boolean>>;

  /** Frontmatter output declarations, set at machine initialization. Empty array when none declared. */
  readonly frontmatterOutputs: readonly OutputDeclaration[];

  /** Evaluated frontmatter outputs. Populated when machine reaches COMPLETE or STOPPED. */
  readonly finalVars: Readonly<Record<string, string>>;
}
```

All three fields are `readonly` consistent with the rest of `RunbookContext`. `finalVars` starts as `{}` and is replaced (not mutated) by `storeFrontmatterOutputs` via `assign()`.

### Initialization path

`compileRunbookToMachine` gains two new options:

```typescript
function compileRunbookToMachine(
  steps: ResolvedStep[],
  options?: {
    templateVars?: Readonly<Record<string, string | number | boolean>>;
    frontmatterOutputs?: readonly OutputDeclaration[];
  },
)
```

The machine's initial context includes:

```typescript
context: {
  // ... existing initial values ...
  templateVars: options?.templateVars ?? {},
  frontmatterOutputs: options?.frontmatterOutputs ?? [],
  finalVars: {},
}
```

The CLI passes `flattenTemplateVars(runbookState.templateVars)` and the parsed frontmatter's `outputs` field when calling `compileRunbookToMachine`. No XState `input` type is needed — these are compiler-level initialization values, not runtime events.

**Snapshot migration:** `templateVars` is a new context field. Existing persisted snapshots will not have it. The actor-service snapshot migration code (`actor-service.ts:74–116`) must default it to `{}` on restore, consistent with how it handles other new context fields. This is safe — a resumed actor with `templateVars: {}` will evaluate output expressions against an empty base (falling back to `context.variables`), which is consistent with the pre-migration behavior where templateVars were not in machine context at all.

---

## runbookSetup Changes

```typescript
export const runbookSetup = setup({
  types: {
    context: {} as RunbookContext,
    events: {} as RunbookEvent,
    output: {} as { finalVars: Readonly<Record<string, string>> },
  },
  actions: {
    setLastAction: /* unchanged */,

    /** Evaluate step-level output declarations and merge into context.variables.
     *  buildExecutionFrame() reconstructs the full pre-transition vars from context:
     *  context.templateVars (base) + context.variables (accumulated) + dynamic Step/Index/etc.
     *  Transition actions fire before state changes, so context.step is the completing step. */
    storeStepOutputs: assign({
      variables: ({ context }, params: { outputs: readonly OutputDeclaration[] }) => {
        const vars = buildExecutionFrame(context);
        const evaluated = evaluateStepOutputDeclarations(params.outputs, vars);
        return { ...context.variables, ...evaluated };
        // Note: evaluated contains only successfully-evaluated keys (failures are omitted).
        // Prior values in context.variables for failed keys are preserved.
      },
    }),

    /** Evaluate frontmatter output declarations and store in context.finalVars.
     *  Uses buildExecutionFrame() for consistent var resolution.
     *  Naked-form declarations (e.g. `- PlanPath`) are resolved by name lookup from vars. */
    storeFrontmatterOutputs: assign({
      finalVars: ({ context }) => {
        const vars = buildExecutionFrame(context);
        return evaluateFrontmatterOutputDeclarations(context.frontmatterOutputs, vars);
      },
    }),
  },
});
```

`assign()` inside `setup({ actions })` is correct — `runbookSetup.assign()` (the type-bound helper) is for use outside the `setup()` call, consistent with existing compiler convention. Both actions are no-ops when their outputs array is empty.

---

## Compiler Changes

### Final states gain `storeFrontmatterOutputs`

The `COMPLETE` and `STOPPED` states are defined in `compileRunbookToMachine` (lines 2149–2161). They currently have inline `entry` assigns that set `completed: true` / `stopped: true` in `context.variables`. `storeFrontmatterOutputs` is prepended to each entry array, and `output` is added:

```typescript
COMPLETE: {
  type: 'final',
  entry: [
    { type: 'storeFrontmatterOutputs' },  // runs before terminal marker; reads clean context.variables
    runbookSetup.assign({ variables: ({ context }) => ({ ...context.variables, completed: true }) }),
  ],
  output: ({ context }) => ({ finalVars: context.finalVars }),
},
STOPPED: {
  type: 'final',
  entry: [
    { type: 'storeFrontmatterOutputs' },
    runbookSetup.assign({ variables: ({ context }) => ({ ...context.variables, stopped: true }) }),
  ],
  output: ({ context }) => ({ finalVars: context.finalVars }),
},
```

`storeFrontmatterOutputs` fires before the terminal marker assign so it reads clean accumulated `context.variables`. It is a no-op when `context.frontmatterOutputs` is empty. `buildTerminalTransition` targets these states unchanged.

The `output` field is declared for symmetry with `setup({ types: { output } })` and for future XState-native delegation (a parent machine invoking this machine as a child actor would receive `finalVars` via `onDone`). The current CLI reads `context.finalVars` directly via `actorService` — the machine output is not consumed by the existing implementation.

### `storeStepOutputs` embedded structurally on transitions

The `shouldPersistParentOutputs` runtime guard is eliminated. The compiler has structural knowledge of when outputs should fire:

**Substep with outputs** (`buildActionTransition`, substep code path):
```typescript
actions: [
  { type: 'storeStepOutputs', params: { outputs: substep.outputs } },
  { type: 'setLastAction', params: { ... } },
]
```

**Parent step with outputs, no substeps** (`buildActionTransition`, direct step):
```typescript
actions: [
  { type: 'storeStepOutputs', params: { outputs: step.outputs } },
  { type: 'setLastAction', params: { ... } },
]
```

**Parent step with outputs, has substeps** (`buildParentStateConfig`, `always` transitions that advance to next step or terminal):
```typescript
{ guard: ..., target: nextStepId, actions: [{ type: 'storeStepOutputs', params: { outputs: step.outputs } }] }
```

`always` transitions that remain within the same parent step (substep-internal routing) do not get `storeStepOutputs`. The distinction is already structurally encoded in the transition targets.

**`storeStepOutputs` fires on both PASS and FAIL** — the action is appended to transitions regardless of result kind. This applies to substeps, direct steps, and parent-step `always` transitions. For parent steps, `always` transitions that target the next step or a terminal state (`COMPLETE`, `STOPPED`) all carry `storeStepOutputs` — including FAIL→STOP and FAIL→COMPLETE cases. `always` transitions are the sole mechanism for parent-step result dispatch, so all parent-level FAIL handlers go through them.

**`storeStepOutputs` fires before the terminal state is entered** — transition actions in XState execute before the target state's entry actions. A FAIL→STOP transition therefore evaluates outputs first, then enters `STOPPED`. Tests must assert that `context.variables` contains the evaluated outputs in the terminal snapshot.

**FOR loop iterations — PASS and CONTINUE/NEXT** — `storeStepOutputs` fires per-iteration on the `always` transitions that advance the loop index. Each iteration's output evaluation uses the current iteration's vars (including the loop variable). Outputs from successive iterations overwrite prior values if the same key is declared — last iteration wins. An explicit test covers this: two iterations producing the same key result in iteration 2's value in `context.variables`.

**FOR loop iterations — FAIL+BREAK** — BREAK exits the loop without advancing the index; it routes to the post-loop aggregation state, not through the index-advance `always` transition. `storeStepOutputs` does NOT fire on BREAK. This is an intentional exception to "fires on FAIL": within a FOR loop, BREAK is a loop-exit signal, not a step-completion signal. The substep's individual FAIL transition (handled by `buildActionTransition`) does carry `storeStepOutputs` for substeps within the iteration, but the loop-level BREAK transition does not.

---

## actorService Changes

`updateFromActor()` gains one new extraction alongside the existing `context.variables` read:

```typescript
const finalVars = (snapshot.context as RunbookContext).finalVars;
// included in RunbookState update when non-empty
```

The cast is a current limitation — `snapshot` is typed as `unknown` in `actorService` because the machine type is not threaded through. The preferred fix (tracked separately) is to type `actorService` with `SnapshotFrom<typeof machine>` upstream, eliminating the cast. For this implementation, the cast is acceptable and consistent with existing context reads in the same function.

`RunbookState.finalVars` is populated as soon as the machine enters `COMPLETE` or `STOPPED`. No second write path.

---

## CLI Changes

**Removed:**

| File | Removed |
|---|---|
| `execution.ts` | OUTPUTS evaluation block (lines 245–293), `SET_VARIABLES` send |
| `transitions.ts` | OUTPUTS evaluation block (lines 505–551), `SET_VARIABLES` send |
| `transitions.ts` | `maybePersistFrontmatterOutputs` function and all four call sites |
| `runbook-pipeline.ts` | `evaluateFrontmatterOutputs` call and `done`/`stopped` guard block |
| `step-outputs.ts` | `evaluateStepOutputs`, `evaluateFrontmatterOutputs` (callers gone) |
| `execution-units.ts` | `shouldPersistParentOutputs` function |

**Modified (not removed):**

| File | Change |
|---|---|
| `template-renderer.ts` | `evaluateOutputExpression` retained but updated to delegate to `output-evaluator.ts` in core; other template rendering uses in the file are unchanged |

---

## Testing

**Updated tests (behavior inversion):**
- `frontmatter-outputs.test.ts`: FAIL STOP test inverts — `finalVars` should be populated on stopped
- `context-passing-outputs.test.ts`: two tests asserting OUTPUTS not stored on FAIL are inverted
- `transitions-explicit-target.test.ts`: test asserting OUTPUTS skipped on FAIL is inverted

**New tests in core (`compiler.test.ts`):**
- `storeStepOutputs` appears on PASS transition with correct `outputs` params
- `storeStepOutputs` appears on FAIL transition (not gated on result kind)
- `storeStepOutputs` appears on substep transition when substep has outputs
- `storeStepOutputs` appears on parent-advancing `always` transition when parent has outputs
- `storeStepOutputs` absent on substep-internal `always` transitions
- FAIL→STOP transition carries `storeStepOutputs` action before entering `STOPPED` state
- FAIL→BREAK transition does NOT carry `storeStepOutputs` (BREAK exits loop without advancing)
- FOR loop step with outputs: `storeStepOutputs` on iteration-advancing `always` transitions
- FOR loop, two iterations, same output key: `context.variables` holds iteration 2's value
- `storeFrontmatterOutputs` present as first entry action on `COMPLETE` state
- `storeFrontmatterOutputs` present as first entry action on `STOPPED` state

**New tests in core (`output-evaluator.test.ts`):**
- `evaluateOutputExpression`: all four expression forms (happy path)
- `evaluateOutputExpression`: failing expression → throws (caller omits, not empty string)
- `evaluateStepOutputDeclarations`: naked form skipped at step level, result does not contain the key
- `evaluateStepOutputDeclarations`: failed expression → key omitted from result, not written as `''`
- `evaluateStepOutputDeclarations`: with-value form evaluated correctly
- `evaluateFrontmatterOutputDeclarations`: naked form resolved by name lookup from vars
- `evaluateFrontmatterOutputDeclarations`: failed expression → key omitted from result
- `flattenTemplateVars`: JsonArray → comma-joined string
- `flattenTemplateVars`: JsonObject → JSON string
- `flattenTemplateVars`: JsonArrayStream → key omitted, warning observable via emitter/log
- `buildExecutionFrame`: Step, Index, loop variable, context.current.* all present
- `buildExecutionFrame`: context.variables merged after templateVars (step outputs win)

**New tests in core (`actor-service.test.ts` / snapshot migration):**
- Snapshot without `templateVars` field → migrated with `templateVars: {}`

---

## What Is Not Changed

- `SET_VARIABLES` event and its machine handler — retained for `delegation-completion.ts` cross-runbook forwarding
- `RunbookState.finalVars` field — persisted identically, just populated via context read instead of direct `manager.update`
- `context.variables` field in `RunbookContext` — still stores step-level outputs, same semantics
- The `required:` validation and variable resolution in `runbook-pipeline.ts` — unchanged
