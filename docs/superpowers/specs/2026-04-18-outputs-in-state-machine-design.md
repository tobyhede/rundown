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

The `SET_VARIABLES` event remains in the machine as a public API for external variable injection. Only the CLI's own OUTPUTS-driven sends are removed.

---

## New Module: `packages/core/src/runbook/output-evaluator.ts`

Pure functions extracted from CLI's `template-renderer.ts` and `step-outputs.ts`. No I/O, no side effects.

```typescript
type OutputVars = Readonly<Record<string, string | number | boolean>>;

/** Evaluates a single output expression against vars.
 *  Four forms: {{ path "file.json" }}, {{ VarName }}, "literal", bare_identifier */
export function evaluateOutputExpression(expr: string, vars: OutputVars): string;

/** Evaluates all declarations. Naked-form (no value) is invalid at step level — skipped with warning.
 *  Non-fatal: evaluation failures return empty string. */
export function evaluateOutputDeclarations(
  outputs: readonly OutputDeclaration[],
  vars: OutputVars,
): Record<string, string>;

/** Reduces TemplateVarValue map to OutputVars.
 *  JsonArray → comma-joined string (consistent with template rendering).
 *  JsonObject → JSON string.
 *  JsonArrayStream → omitted with warning (lazy stream, no concrete value). */
export function flattenTemplateVars(
  vars: Readonly<Record<string, TemplateVarValue>>,
): OutputVars;
```

The `path "file.json"` helper inside `evaluateOutputExpression` reads `WorkPath` and `ContextId` from the vars map — always plain strings, no CLI-specific type dependency.

---

## RunbookContext Changes

```typescript
export interface RunbookContext {
  // ... existing fields unchanged ...

  /** Frontmatter output declarations, set at machine initialization. Empty array when none declared. */
  frontmatterOutputs: readonly OutputDeclaration[];

  /** Evaluated frontmatter outputs. Populated when machine reaches COMPLETE or STOPPED. */
  finalVars: Record<string, string>;
}
```

---

## runbookSetup Changes

```typescript
export const runbookSetup = setup({
  types: {
    context: {} as RunbookContext,
    events: {} as RunbookEvent,
    output: {} as { finalVars: Record<string, string> },
  },
  actions: {
    setLastAction: /* unchanged */,

    /** Evaluate step-level output declarations and merge into context.variables. */
    storeStepOutputs: assign({
      variables: ({ context }, params: { outputs: readonly OutputDeclaration[] }) => {
        const vars = { ...flattenTemplateVars(context.templateVars ?? {}), ...context.variables };
        return { ...context.variables, ...evaluateOutputDeclarations(params.outputs, vars) };
      },
    }),

    /** Evaluate frontmatter output declarations and store in context.finalVars. */
    storeFrontmatterOutputs: assign({
      finalVars: ({ context }) => {
        const vars = { ...flattenTemplateVars(context.templateVars ?? {}), ...context.variables };
        return evaluateOutputDeclarations(context.frontmatterOutputs, vars);
      },
    }),
  },
});
```

Both actions are no-ops when their outputs array is empty. `storeStepOutputs` fires on PASS and FAIL paths (not conditional on result). `storeFrontmatterOutputs` fires on both `COMPLETE` and `STOPPED` terminal states.

---

## Compiler Changes

### Final states gain `storeFrontmatterOutputs`

The `COMPLETE` and `STOPPED` states are defined in `compileRunbookToMachine` (lines 2149–2161). They currently have inline `entry` assigns that set `completed: true` / `stopped: true` in `context.variables`. `storeFrontmatterOutputs` is prepended to each entry array, and `output` is added:

```typescript
COMPLETE: {
  type: 'final',
  entry: [
    { type: 'storeFrontmatterOutputs' },  // evaluate before terminal marker is written
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

**`storeStepOutputs` fires on both PASS and FAIL** — the action is appended regardless of result kind. No conditional on result.

---

## actorService Changes

`updateFromActor()` gains one new extraction alongside the existing `context.variables` read:

```typescript
const finalVars = (snapshot.context as RunbookContext).finalVars;
// included in RunbookState update when non-empty
```

This fires on every `updateFromActor` call. `RunbookState.finalVars` is populated as soon as the machine enters `COMPLETE` or `STOPPED`. No second write path.

---

## CLI Removals

| File | Removed |
|---|---|
| `execution.ts` | OUTPUTS evaluation block (lines 245–293), `SET_VARIABLES` send |
| `transitions.ts` | OUTPUTS evaluation block (lines 505–551), `SET_VARIABLES` send |
| `transitions.ts` | `maybePersistFrontmatterOutputs` function and all four call sites |
| `runbook-pipeline.ts` | `evaluateFrontmatterOutputs` call and `done`/`stopped` guard block |
| `step-outputs.ts` | `evaluateStepOutputs`, `evaluateFrontmatterOutputs` (callers gone) |
| `execution-units.ts` | `shouldPersistParentOutputs` function |
| `template-renderer.ts` | `evaluateOutputExpression` — updated to delegate to core function |

---

## Testing

**Updated tests:**
- `frontmatter-outputs.test.ts`: FAIL STOP test inverts — `finalVars` should be populated on stopped
- `context-passing-outputs.test.ts`: two tests asserting OUTPUTS not stored on FAIL are inverted
- `transitions-explicit-target.test.ts`: test asserting OUTPUTS skipped on FAIL is inverted

**New tests in core:**
- `output-evaluator.test.ts`: unit tests for `evaluateOutputExpression`, `evaluateOutputDeclarations`, `flattenTemplateVars`
- `compiler.test.ts`: tests confirming `storeStepOutputs` appears on correct transitions with correct params, both PASS and FAIL paths, substep vs parent paths

---

## What Is Not Changed

- `SET_VARIABLES` event and its machine handler — stays as public API for external injection
- `RunbookState.finalVars` field — persisted identically, just populated via context read instead of direct `manager.update`
- `context.variables` field in `RunbookContext` — still stores step-level outputs, same semantics
- The `required:` validation and variable resolution in `runbook-pipeline.ts` — unchanged
