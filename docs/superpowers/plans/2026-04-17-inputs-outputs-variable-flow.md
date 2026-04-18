# INPUTS / OUTPUTS Variable Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the file-based `outputs.json` side-channel with first-class state machine integration — step OUTPUTS go into `RunbookState.variables` directly, frontmatter `outputs:` write to `RunbookState.finalVars` at termination, and cross-runbook forwarding injects `--var` flags derived from child's `inputs:` defaults + parent's live variable space.

**Architecture:** The parser renames `vars:` → `inputs:` (same Record type, same semantics) and removes the old `inputs: string[]` / `- INPUTS` directive entirely. The XState machine gains a `SET_VARIABLES` event that updates `context.variables` in-machine. Step OUTPUTS are evaluated AFTER `sendAndSync(PASS/FAIL)` (so `updatedStepId` is known for the `shouldPersistParentOutputs` guard), then sent via `sendAndSync(SET_VARIABLES)` before `applyResultTransition` returns — this ensures the persisted snapshot's `context.variables` reflects OUTPUTS, which the next actor (created fresh from snapshot) will see. **Direct `manager.update({ variables })` must NOT be used for variables** — `createActor` restores from `state.snapshot`, not from the flat `state.variables` field, so a raw manager update is invisible to the next actor. Frontmatter `outputs:` are evaluated at termination and written to `state.finalVars`. Delegation forwarding uses `actorService.sendAndSync(parentId, parentSteps, SET_VARIABLES)` before firing the parent substep transition. The plugin reads child's `frontmatter.inputs` keys + parent's live vars to build `--var` flags.

**Tech Stack:** TypeScript, XState v5, Zod, gray-matter, Vitest

---

## Files

**Modified (Parser)**
- `packages/parser/src/frontmatter.ts` — rename `vars:` → `inputs:`, change type from `string[]` to `Record`
- `packages/parser/src/ast.ts` — remove `inputs` from `ContextDirectiveFields`
- `packages/parser/src/parser.ts` — replace `handleInputsDirective` with parse error

**Modified (Core)**
- `packages/core/src/runbook/compiler.ts` — add `SET_VARIABLES` event + root-level handler
- `packages/core/src/runbook/types.ts` — add `finalVars` to `RunbookState`
- `packages/core/src/schemas.ts` — add `finalVars` to `RunbookStateSchema`

**Deleted (Core)**
- `packages/core/src/runbook/context-outputs.ts` — removed entirely

**Modified (CLI)**
- `packages/cli/src/services/variable-discovery.ts` — `frontmatter.vars` → `frontmatter.inputs`
- `packages/cli/src/helpers/step-outputs.ts` — rewrite as pure evaluation (no file I/O)
- `packages/cli/src/helpers/execution-units.ts` — remove `collectExecutionUnitInputs` only (OUTPUTS logic moves to execution.ts)
- `packages/cli/src/helpers/runbook-pipeline.ts` — remove `loadContextOutputs` block + `inputsResolvedKeys`
- `packages/cli/src/helpers/transitions.ts` — use `evaluateFrontmatterOutputs` + write `finalVars`
- `packages/cli/src/services/execution.ts` — remove `loadContextOutputs` + INPUTS injection block
- `packages/cli/src/helpers/delegation-completion.ts` — read child `finalVars`, update parent `state.variables`
- `packages/cli/src/helpers/status-builder.ts` — add `vars` field to `StatusOutputData`
- `packages/cli/src/helpers/validate-frontmatter-vars.ts` — remove `validateInputsDeclarations`

**Modified (Plugin)**
- `packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts` — inject `--var` flags

**Modified (Tests)**
- `packages/parser/__tests__/frontmatter.test.ts` — replace `vars:` tests with `inputs:` Record tests
- `packages/parser/__tests__/outputs-inputs.test.ts` — remove INPUTS directive tests, add parse error test
- `packages/cli/__tests__/integration/frontmatter-outputs.test.ts` — rewrite for new behavior

**Migration**
- All `.runbook.md` files — rename `vars:` → `inputs:`, remove `- INPUTS` blocks
- `docs/SPEC.md`, `docs/FORMAT.md` — update variable documentation

---

## Task 1: Parser — Rename `vars:` → `inputs:` in frontmatter interface

**Files:**
- Modify: `packages/parser/src/frontmatter.ts`
- Test: `packages/parser/__tests__/frontmatter.test.ts`

### Context

`RunbookFrontmatter` currently has two fields:
- `vars?: Record<string, string | number | boolean>` — default template variables
- `inputs?: string[]` — identifiers of vars to import from outputs.json (being removed)

After this task, `inputs:` takes on the role of `vars:` (same Record type), and `vars:` is dropped from the interface (becomes an unknown passthrough field).

- [ ] **Step 1: Write failing test for new `inputs:` Record shape**

In `packages/parser/__tests__/frontmatter.test.ts`, add a describe block for the new `inputs:` behavior. Find an existing test for `vars:` defaults and add a parallel one for `inputs:`:

```typescript
describe('inputs: field (new — default variable values)', () => {
  it('parses inputs: as Record<string, string|number|boolean>', () => {
    const markdown = `---
inputs:
  environment: staging
  port: 3000
  debug: true
---
# Test`;
    const { frontmatter, diagnostics } = extractFrontmatter(markdown);
    expect(diagnostics).toHaveLength(0);
    expect(frontmatter?.inputs).toEqual({
      environment: 'staging',
      port: 3000,
      debug: true,
    });
  });

  it('filters null values per-entry (PlanPath: with no value = null in YAML)', () => {
    const markdown = `---
inputs:
  environment: staging
  PlanPath:
---
# Test`;
    const { frontmatter, diagnostics } = extractFrontmatter(markdown);
    expect(diagnostics).toHaveLength(0);
    // null value filtered; scalar value kept
    expect(frontmatter?.inputs).toEqual({ environment: 'staging' });
    // PlanPath key is absent (filtered), not present as null
    expect((frontmatter?.inputs as Record<string, unknown>)?.PlanPath).toBeUndefined();
  });

  it('treats vars: as unknown passthrough (not a known field)', () => {
    const markdown = `---
vars:
  old: value
---
# Test`;
    const { frontmatter } = extractFrontmatter(markdown);
    // vars: is no longer a known field — it passes through as-is
    expect((frontmatter as Record<string, unknown>)['vars']).toEqual({ old: 'value' });
    expect(frontmatter?.inputs).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd packages/parser && npx jest --testPathPattern="frontmatter" --no-coverage 2>&1 | tail -20
```

Expected: failures on the new `inputs:` Record test.

- [ ] **Step 3: Update `RunbookFrontmatter` interface**

In `packages/parser/src/frontmatter.ts`, change the interface (currently at line 64):

```typescript
// BEFORE:
export interface RunbookFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  tags?: string[];
  vars?: Record<string, string | number | boolean>;
  required?: string[];
  inputs?: string[];
  outputs?: OutputDeclaration[];
  [key: string]: unknown;
}

// AFTER:
export interface RunbookFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  tags?: string[];
  inputs?: Record<string, string | number | boolean>;
  required?: string[];
  outputs?: OutputDeclaration[];
  [key: string]: unknown;
}
```

- [ ] **Step 4: Update `RunbookFrontmatterSchema` Zod schema**

In `packages/parser/src/frontmatter.ts`, replace the schema (currently at line 81):

```typescript
// BEFORE:
export const RunbookFrontmatterSchema = z
  .object({
    // ...
    vars: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .catch(undefined),
    required: z.array(z.unknown()).optional().catch(undefined),
    inputs: z.array(z.unknown()).optional().catch(undefined),
    outputs: z.array(z.unknown()).optional().catch(undefined),
  })
  .passthrough();

// AFTER:
export const RunbookFrontmatterSchema = z
  .object({
    // ... (name, description, version, author, tags unchanged)
    inputs: z
      .record(z.union([z.string(), z.number(), z.boolean()]).nullable())
      .optional()
      .transform((val) =>
        val
          ? (Object.fromEntries(
              Object.entries(val).filter(([, v]) => v !== null),
            ) as Record<string, string | number | boolean>)
          : undefined,
      )
      .catch(undefined),
    required: z.array(z.unknown()).optional().catch(undefined),
    outputs: z.array(z.unknown()).optional().catch(undefined),
  })
  .passthrough();
// Note: null values (e.g., `PlanPath:` with no value in YAML) are silently filtered
// per-entry rather than dropping the entire record via .catch(undefined).
```

Note: `vars` is removed from the schema. Since the schema uses `.passthrough()`, a `vars:` key in the YAML will be preserved as-is on the frontmatter object (unknown field passthrough), but won't be available as the typed `inputs` field. That's correct.

- [ ] **Step 5: Update `extractFrontmatter` to not call `filterIdentifierArray` for `inputs`**

In `packages/parser/src/frontmatter.ts`, in the `extractFrontmatter` function (around line 183), the `inputs:` field previously needed `filterIdentifierArray` because it was `string[]`. Now Zod validates it directly as `Record<>`, so remove that call:

```typescript
// BEFORE:
const frontmatter: RunbookFrontmatter = {
  ...parsed,
  required: parsed.required !== undefined
    ? filterIdentifierArray(parsed.required, 'required', diagnostics)
    : undefined,
  inputs: parsed.inputs !== undefined
    ? filterIdentifierArray(parsed.inputs, 'inputs', diagnostics)
    : undefined,
  outputs: parsed.outputs !== undefined
    ? filterOutputDeclarationArray(parsed.outputs, diagnostics)
    : undefined,
};

// AFTER:
const frontmatter: RunbookFrontmatter = {
  ...parsed,
  required: parsed.required !== undefined
    ? filterIdentifierArray(parsed.required, 'required', diagnostics)
    : undefined,
  outputs: parsed.outputs !== undefined
    ? filterOutputDeclarationArray(parsed.outputs, diagnostics)
    : undefined,
};
// Note: `inputs` is no longer listed — it comes through `...parsed` already
// validated by Zod as Record<string, string|number|boolean> | undefined.
```

- [ ] **Step 6: Update `filterIdentifierArray` signature**

Change the `field` parameter type from `'inputs' | 'required'` to just `'required'` (around line 216):

```typescript
// BEFORE:
function filterIdentifierArray(
  raw: unknown[],
  field: 'inputs' | 'required',
  diagnostics: ValidationDiagnostic[],
): string[] | undefined

// AFTER:
function filterIdentifierArray(
  raw: unknown[],
  field: 'required',
  diagnostics: ValidationDiagnostic[],
): string[] | undefined
```

- [ ] **Step 7: Update `NORMALIZED_FRONTMATTER_KEYS` (remove `vars`)**

Find `NORMALIZED_FRONTMATTER_KEYS` or the normalization function (around line 14). Remove `'vars'` from the set of keys to normalize:

```typescript
// BEFORE (example — find the actual set):
const NORMALIZED_FRONTMATTER_KEYS = new Set(['name', 'description', 'version', 'author', 'tags',
  'vars', 'required', 'inputs', 'outputs']);

// AFTER:
const NORMALIZED_FRONTMATTER_KEYS = new Set(['name', 'description', 'version', 'author', 'tags',
  'required', 'inputs', 'outputs']);
```

- [ ] **Step 8: Run tests to confirm they pass**

```bash
cd packages/parser && npx jest --testPathPattern="frontmatter" --no-coverage 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/parser/src/frontmatter.ts packages/parser/__tests__/frontmatter.test.ts
git commit -m "feat(parser): rename vars: → inputs: as Record, remove old inputs: string[]"
```

---

## Task 2: Parser — Remove `- INPUTS` directive; update AST

**Files:**
- Modify: `packages/parser/src/parser.ts`
- Modify: `packages/parser/src/ast.ts`

### Context

`ContextDirectiveFields` in the AST has `inputs?: readonly string[]` from the old `- INPUTS` step directive. The parser's `handleInputsDirective` function populates this. Both are being removed — the directive is replaced by a parse error.

- [ ] **Step 1: Write failing test for parse error on `- INPUTS` directive**

In `packages/parser/__tests__/outputs-inputs.test.ts`, add a test:

```typescript
it('emits a parse error when - INPUTS directive appears in a step', () => {
  const markdown = `---
inputs:
  Message: hello
---
# My Runbook

## 1. Use message
- INPUTS
  - Message

The message is: {{Message}}
PASS CONTINUE
`;
  const result = parseRunbookDocument(markdown);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  expect(errors.length).toBeGreaterThanOrEqual(1);
  expect(errors[0].message).toMatch(/INPUTS step directive has been removed/);
});
```

Also add a test confirming that no `inputs` field is set on steps:

```typescript
it('does not populate step.inputs on any step', () => {
  const markdown = `# Runbook\n\n## 1. Step\nDo a thing.\nPASS CONTINUE\n`;
  const result = parseRunbookDocument(markdown);
  const step = result.runbook?.steps[0];
  expect(step).toBeDefined();
  // inputs is no longer a field on step AST nodes
  expect((step as Record<string, unknown>)['inputs']).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd packages/parser && npx jest --testPathPattern="outputs-inputs" --no-coverage 2>&1 | tail -20
```

Expected: failures on the new parse error test.

- [ ] **Step 3: Remove `inputs` from `ContextDirectiveFields` in `ast.ts`**

In `packages/parser/src/ast.ts`, find `ContextDirectiveFields` (around line 191):

```typescript
// BEFORE:
interface ContextDirectiveFields {
  readonly inputs?: readonly string[];
  readonly outputs?: readonly OutputDeclaration[];
}

// AFTER:
interface ContextDirectiveFields {
  readonly outputs?: readonly OutputDeclaration[];
}
```

This change propagates to `ExecutionUnitFields` and `BaseStep` via inheritance — `inputs` is gone from all step AST types.

- [ ] **Step 4: Replace `handleInputsDirective` with a parse error in `parser.ts`**

Find the `handleInputsDirective` function (around line 657) and the call site in the list item handler (around line 724 — checks `trimmedText === 'INPUTS'`).

Replace the call to `handleInputsDirective` with a direct parse error:

```typescript
// In the list item handler, where INPUTS directive was matched:
if (trimmedText === 'INPUTS') {
  // BEFORE: return handleInputsDirective(node, ctx);
  // AFTER:
  ctx.diagnostics.push({
    severity: 'error',
    message:
      'INPUTS step directive has been removed — use frontmatter inputs: field instead',
  });
  return SKIP;
}
```

Then delete the entire `handleInputsDirective` function (lines 657–699 approximately).

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd packages/parser && npx jest --testPathPattern="outputs-inputs" --no-coverage 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Build parser to catch type errors**

```bash
cd packages/parser && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors (removing `inputs` from ContextDirectiveFields may cause downstream type errors in CLI — those are fixed in later tasks).

- [ ] **Step 7: Commit**

```bash
git add packages/parser/src/ast.ts packages/parser/src/parser.ts packages/parser/__tests__/outputs-inputs.test.ts
git commit -m "feat(parser): remove - INPUTS directive, emit parse error; remove inputs from AST"
```

---

## Task 3: Parser — Update existing frontmatter + outputs tests

**Files:**
- Modify: `packages/parser/__tests__/frontmatter.test.ts`
- Modify: `packages/parser/__tests__/outputs-inputs.test.ts`

### Context

Existing tests reference `inputs: string[]` behavior and `vars:` field. Update them to reflect the new semantics.

- [ ] **Step 1: Remove all `inputs: string[]` tests from `frontmatter.test.ts`**

Search for tests referencing `inputs:` as an array (e.g., `inputs: ['Foo', 'Bar']`). Remove them or rewrite them as tests for the new Record form.

- [ ] **Step 2: Update `vars:` tests to use `inputs:` instead**

Find tests that set `vars: { key: value }` in frontmatter markdown. Rewrite to use `inputs: { key: value }`. Example:

```typescript
it('parses inputs: as default template variables', () => {
  const markdown = `---
inputs:
  environment: staging
  port: 3000
---
# Runbook`;
  const { frontmatter } = extractFrontmatter(markdown);
  expect(frontmatter?.inputs).toEqual({ environment: 'staging', port: 3000 });
});
```

- [ ] **Step 3: Remove all `- INPUTS` directive tests from `outputs-inputs.test.ts`**

Find tests like:
```typescript
it('parses INPUTS directive', () => { ... })
it('validates INPUTS identifiers', () => { ... })
it('rejects reserved names in INPUTS', () => { ... })
```

Remove them. The parse error test added in Task 2 covers the new behavior.

- [ ] **Step 4: Run all parser tests**

```bash
cd packages/parser && npx jest --no-coverage 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/parser/__tests__/
git commit -m "test(parser): update frontmatter + outputs-inputs tests for inputs:/vars: rename"
```

---

## Task 4: Core — Add `SET_VARIABLES` event to machine

**Files:**
- Modify: `packages/core/src/runbook/compiler.ts`
- Test: `packages/core/__tests__/runbook/compiler.test.ts`

### Context

The XState machine needs a `SET_VARIABLES` event that updates `context.variables`. This is used when cross-runbook delegation completion wants to inject child's output vars into the parent's variable space before firing the parent substep transition.

- [ ] **Step 1: Write failing test for `SET_VARIABLES` event**

Find the compiler test file (`packages/core/__tests__/runbook/compiler.test.ts`) and **copy the step fixture format from the existing tests in that file** — the exact shape of `ResolvedStep.transitions` (lowercase `pass`/`fail` keys with typed `TransitionObject`) must match what `compileRunbookToMachine` expects. Use what's already there rather than guessing. The code below shows the logical structure; adapt types to match:

```typescript
it('SET_VARIABLES event merges into context.variables without changing step', () => {
  // Build a minimal two-step runbook machine
  // IMPORTANT: use the step fixture format from existing compiler.test.ts
  const steps: ResolvedStep[] = [
    {
      name: '1', kind: 'base',
      description: 'Step 1',
      transitions: { /* copy format from existing tests */ },
    },
    {
      name: '2', kind: 'base',
      description: 'Step 2',
      transitions: { /* copy format from existing tests */ },
    },
  ];
  const machine = compileRunbookToMachine(steps);
  const actor = createActor(machine);
  actor.start();

  // Verify initial variables are empty
  expect(actor.getSnapshot().context.variables).toEqual({});

  // Send SET_VARIABLES
  actor.send({ type: 'SET_VARIABLES', vars: { PlanPath: 'plan.json', count: 3 } });

  // variables updated, but step unchanged (still on step 1)
  const snapshot = actor.getSnapshot();
  expect(snapshot.context.variables).toEqual({ PlanPath: 'plan.json', count: 3 });
  expect(snapshot.value).toMatch(/step::1/);
});

it('SET_VARIABLES merges additively (does not replace)', () => {
  const steps: ResolvedStep[] = [
    {
      id: '1', name: '1', kind: 'base',
      description: 'Step 1',
      transitions: { PASS: { action: 'COMPLETE' }, FAIL: { action: 'STOP' } },
    },
  ];
  const machine = compileRunbookToMachine(steps);
  const actor = createActor(machine);
  actor.start();

  actor.send({ type: 'SET_VARIABLES', vars: { A: 'first' } });
  actor.send({ type: 'SET_VARIABLES', vars: { B: 'second' } });

  expect(actor.getSnapshot().context.variables).toEqual({ A: 'first', B: 'second' });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd packages/core && npx jest --testPathPattern="compiler" --no-coverage 2>&1 | tail -20
```

Expected: TypeScript error or runtime error — `SET_VARIABLES` is not a known event type.

- [ ] **Step 3: Add `SET_VARIABLES` to `RunbookEvent` type**

In `packages/core/src/runbook/compiler.ts`, update the type (currently at line 117):

```typescript
// BEFORE:
export type RunbookEvent =
  | { type: 'PASS' }
  | { type: 'FAIL' }
  | { type: 'RETRY' }
  | { type: 'GOTO'; target: StepId };

// AFTER:
export type RunbookEvent =
  | { type: 'PASS' }
  | { type: 'FAIL' }
  | { type: 'RETRY' }
  | { type: 'GOTO'; target: StepId }
  | { type: 'SET_VARIABLES'; vars: Record<string, boolean | number | string> };
```

- [ ] **Step 4: Add root-level `on: { SET_VARIABLES }` handler to `compileRunbookToMachine`**

In `packages/core/src/runbook/compiler.ts`, find the `return runbookSetup.createMachine({...})` call (around line 2119). Add a root-level `on:` handler immediately after the `context:` block:

```typescript
return runbookSetup.createMachine({
  id: 'runbook',
  initial: allStates.length > 0 ? allStates[0].id : 'step::1',
  context: {
    retryCount: 0,
    parentRetryCount: 0,
    iterationRetryCount: 0,
    retryMax: undefined,
    substep: undefined,
    variables: {},
    lastAction: undefined,
    lastMessage: undefined,
    forStack: [],
    iterationResults: undefined,
    substepCompletedCount: 0,
    deferredResults: undefined,
  },
  // ADD THIS:
  on: {
    SET_VARIABLES: {
      actions: runbookSetup.assign({
        variables: ({ context, event }) => ({
          ...context.variables,
          ...event.vars,
        }),
      }),
    },
  },
  states: {
    ...states,
    // ...
  },
});
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd packages/core && npx jest --testPathPattern="compiler" --no-coverage 2>&1 | tail -20
```

Expected: new SET_VARIABLES tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/compiler.ts packages/core/__tests__/runbook/compiler.test.ts
git commit -m "feat(core): add SET_VARIABLES event to machine for variable injection"
```

---

## Task 5: Core — Add `finalVars` to `RunbookState` + schema

**Files:**
- Modify: `packages/core/src/runbook/types.ts`
- Modify: `packages/core/src/schemas.ts`
- Test: `packages/core/__tests__/schemas.test.ts` (or create it if needed)

### Context

`RunbookState.finalVars` stores the evaluated frontmatter `outputs:` declarations at runbook termination. Parent delegation completion reads this to forward values to the parent's variable space.

- [ ] **Step 1: Write failing test for `finalVars` in schema**

Find `packages/core/__tests__/schemas.test.ts` (or search for schema tests). Add:

```typescript
it('RunbookStateSchema accepts finalVars as optional Record<string, string>', () => {
  // Build a minimal valid state fixture and add finalVars
  const state = buildMinimalRunbookState(); // use existing fixture builder
  const withFinalVars = { ...state, finalVars: { PlanPath: 'plan.json', version: '1.2.3' } };
  expect(() => RunbookStateSchema.parse(withFinalVars)).not.toThrow();
  expect(RunbookStateSchema.parse(withFinalVars).finalVars).toEqual({
    PlanPath: 'plan.json',
    version: '1.2.3',
  });
});

it('RunbookStateSchema accepts state without finalVars', () => {
  const state = buildMinimalRunbookState();
  expect(() => RunbookStateSchema.parse(state)).not.toThrow();
  expect(RunbookStateSchema.parse(state).finalVars).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd packages/core && npx jest --testPathPattern="schemas" --no-coverage 2>&1 | tail -20
```

Expected: failure — schema does not yet know about `finalVars`.

- [ ] **Step 3: Add `finalVars` to `RunbookState` interface**

In `packages/core/src/runbook/types.ts`, add after the `runbookSrc` field (around line 668):

```typescript
/** Evaluated frontmatter outputs: values at runbook termination. Read by parent delegation completion. */
readonly finalVars?: Readonly<Record<string, string>>;
```

- [ ] **Step 4: Add `finalVars` to `RunbookStateSchema`**

In `packages/core/src/schemas.ts`, find `RunbookStateSchema` (around line 285) and add:

```typescript
finalVars: z.record(z.string(), z.string()).optional(),
```

Add it near `templateVars` — both are optional terminal-phase fields.

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd packages/core && npx jest --testPathPattern="schemas" --no-coverage 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/types.ts packages/core/src/schemas.ts packages/core/__tests__/schemas.test.ts
git commit -m "feat(core): add finalVars to RunbookState for cross-runbook output forwarding"
```

---

## Task 6: Core — Delete `context-outputs.ts` and remove exports

**Files:**
- Delete: `packages/core/src/runbook/context-outputs.ts`
- Modify: `packages/core/src/index.ts`

### Context

`context-outputs.ts` exports `loadContextOutputs`, `storeContextOutputs`, and `setContextOutputsBeforeRenameHook`. These are consumed by the CLI (`step-outputs.ts`, `runbook-pipeline.ts`, `execution.ts`). Those callers are updated in later tasks — delete this file AFTER those callers are cleaned up, or accept build failures during the transition and fix them last.

**Order note — execute this task AFTER Task 11, not at position 6.**

Three CLI files import from `context-outputs.ts` and must be cleaned up first:
- `packages/cli/src/helpers/step-outputs.ts` — cleaned in Task 8
- `packages/cli/src/helpers/runbook-pipeline.ts` — cleaned in Task 10
- `packages/cli/src/services/execution.ts` — cleaned in Task 11

The file should only be deleted once all three callers no longer import from it. Attempting this at position 6 breaks the build for Tasks 7–11. Execute the steps below only after Task 11 is committed.

- [ ] **Step 1: Remove exports from `packages/core/src/index.ts`**

Find and remove the lines exporting from `context-outputs.ts`:

```typescript
// Remove lines like:
export { loadContextOutputs, storeContextOutputs, setContextOutputsBeforeRenameHook } from './runbook/context-outputs.js';
```

- [ ] **Step 2: Delete the file**

```bash
rm packages/core/src/runbook/context-outputs.ts
```

- [ ] **Step 3: Build core to see which exports were used**

```bash
cd packages/core && npx tsc --noEmit 2>&1 | head -30
```

Expected: errors in core/index.ts (fixed by step 1). CLI errors are expected until later tasks.

- [ ] **Step 4: Commit (partial — CLI still broken)**

```bash
git add packages/core/src/index.ts
git rm packages/core/src/runbook/context-outputs.ts
git commit -m "feat(core): delete context-outputs.ts (outputs.json side-channel)"
```

---

## Task 7: CLI — Update `variable-discovery.ts` (`vars` → `inputs`)

**Files:**
- Modify: `packages/cli/src/services/variable-discovery.ts`

> **Review note [P2]:** The validation entrypoint in `runbook-pipeline.ts` is not covered by this task. Lines 376, 380, and 381 still call `validateFrontmatterVars(frontmatter?.vars)`, `validateRequiredVars(fmRequired, frontmatter?.vars)`, and `validateInputsDeclarations(fmInputs, frontmatter?.vars)` — all with `frontmatter?.vars`. After Task 1 renames `vars:` → `inputs:`, these calls must be updated to use `frontmatter?.inputs`. Add those three sites to the Step 2 grep sweep, or add an explicit step here that patches `runbook-pipeline.ts` lines 376 and 380.

### Context

`resolveVariables()` in variable-discovery accepts a `frontmatterVars` option (type `Record<string, string|number|boolean>`) which comes from `frontmatter.vars`. After Task 1, `frontmatter.vars` no longer exists — callers must now pass `frontmatter.inputs` instead.

The `variable-discovery.ts` file itself doesn't need to change — only its call sites do. The option type is already correct (same `Record<>` shape). Find every place where `resolveVariables()` or `collectRawLayers()` is called with `frontmatterVars: frontmatter.vars` and change to `frontmatterVars: frontmatter.inputs`.

- [ ] **Step 1: Find all call sites using `frontmatter.vars`**

```bash
grep -rn "frontmatter\.vars\|frontmatterVars.*vars" packages/cli/src/ 2>&1
```

- [ ] **Step 2: Replace each `frontmatter.vars` with `frontmatter.inputs`**

For each match, change:
```typescript
// BEFORE:
frontmatterVars: frontmatter.vars,
// or:
frontmatterVars: prepared.frontmatter?.vars,

// AFTER:
frontmatterVars: frontmatter.inputs,
// or:
frontmatterVars: prepared.frontmatter?.inputs,
```

- [ ] **Step 3: Build CLI to check for remaining errors**

```bash
cd packages/cli && npx tsc --noEmit 2>&1 | grep "vars" | head -20
```

Expected: no more `frontmatter.vars` errors.

- [ ] **Step 4: Run unit tests for variable-discovery**

```bash
cd packages/cli && npx jest --testPathPattern="variable-discovery" --no-coverage 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/
git commit -m "feat(cli): variable-discovery uses frontmatter.inputs instead of frontmatter.vars"
```

---

## Task 8: CLI — Rewrite `step-outputs.ts` as pure evaluation functions

**Files:**
- Modify: `packages/cli/src/helpers/step-outputs.ts`
- Test: `packages/cli/__tests__/unit/helpers/step-outputs.test.ts`

### Context

`storeStepOutputs` and `storeFrontmatterOutputs` currently call `storeContextOutputs` from core (file I/O to outputs.json). The new design is:
- `evaluateStepOutputs` — pure function, returns `Record<string, string>`, no file I/O
- `evaluateFrontmatterOutputs` — pure function, returns `Record<string, string>`, no file I/O

Callers are responsible for writing the results to the appropriate storage (state.variables or state.finalVars).

- [ ] **Step 1: Write failing tests for the new pure functions**

In `packages/cli/__tests__/unit/helpers/step-outputs.test.ts` (create if needed):

```typescript
import { evaluateStepOutputs, evaluateFrontmatterOutputs } from '../../../src/helpers/step-outputs.js';
import type { OutputDeclaration } from '@rundown-org/parser';

describe('evaluateStepOutputs', () => {
  it('evaluates with-value form expressions', () => {
    const outputs: OutputDeclaration[] = [
      { name: 'Result', value: '"literal-value"' },
    ];
    const vars = { ContextId: 'ctx-abc', Step: '1' };
    const result = evaluateStepOutputs(outputs, vars);
    expect(result).toEqual({ Result: 'literal-value' });
  });

  it('skips naked form (no value) — only valid for frontmatter', () => {
    const outputs: OutputDeclaration[] = [{ name: 'NakedVar' }];
    const vars = { NakedVar: 'hello', ContextId: 'ctx-abc' };
    const result = evaluateStepOutputs(outputs, vars);
    expect(result).toEqual({}); // naked form skipped at step level
  });

  it('returns empty object on evaluation failure (non-fatal)', () => {
    const outputs: OutputDeclaration[] = [
      { name: 'Bad', value: '{{ unknownHelper "x" }}' },
    ];
    const result = evaluateStepOutputs(outputs, { ContextId: 'ctx' });
    expect(result).toEqual({});
  });
});

describe('evaluateFrontmatterOutputs', () => {
  it('handles naked form by reading var by name', () => {
    const outputs: OutputDeclaration[] = [{ name: 'PlanPath' }];
    const vars = { PlanPath: '/work/plan.json', ContextId: 'ctx-abc' };
    const result = evaluateFrontmatterOutputs(outputs, vars);
    expect(result).toEqual({ PlanPath: '/work/plan.json' });
  });

  it('handles with-value form via expression evaluation', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Literal', value: '"hello-world"' }];
    const result = evaluateFrontmatterOutputs(outputs, { ContextId: 'ctx-abc' });
    expect(result).toEqual({ Literal: 'hello-world' });
  });

  it('skips naked form when var is absent', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Missing' }];
    const result = evaluateFrontmatterOutputs(outputs, { ContextId: 'ctx-abc' });
    expect(result).toEqual({});
  });

  it('skips naked form when var is non-scalar (array)', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Items' }];
    const vars = { Items: ['a', 'b', 'c'], ContextId: 'ctx-abc' };
    const result = evaluateFrontmatterOutputs(outputs, vars as Record<string, unknown>);
    expect(result).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd packages/cli && npx jest --testPathPattern="step-outputs" --no-coverage 2>&1 | tail -20
```

Expected: `evaluateStepOutputs is not a function` type errors.

- [ ] **Step 3: Rewrite `step-outputs.ts`**

Replace the entire file content:

```typescript
/**
 * Pure OUTPUTS evaluation helpers for step and frontmatter declarations.
 *
 * These functions evaluate OUTPUTS expressions and return key-value pairs.
 * No file I/O — callers persist results to state.variables or state.finalVars.
 *
 * @module helpers/step-outputs
 */

import { getErrorMessage, logger } from '@rundown-org/core';
import type { OutputDeclaration } from '@rundown-org/parser';
import type { ExecutionEventEmitter } from '@rundown-org/core';
import type { StepVariables } from '../services/execution-vars.js';
import { evaluateOutputExpression } from '../services/template-renderer.js';

/**
 * Evaluate OUTPUTS declarations for a step that just completed (pass or fail).
 *
 * Naked form (no `value`) is invalid at step level and silently skipped.
 * Expression evaluation failures are non-fatal: logged + emitted as ERROR_OCCURRED.
 *
 * @param outputs - Output declarations from the step definition
 * @param effectiveVars - Template variables available at evaluation time
 * @param emitter - Optional emitter for surfacing evaluation failures
 * @returns Evaluated key-value pairs (empty if nothing evaluated)
 */
export function evaluateStepOutputs(
  outputs: readonly OutputDeclaration[],
  effectiveVars: Readonly<StepVariables>,
  emitter?: ExecutionEventEmitter,
): Record<string, string> {
  const evaluated: Record<string, string> = {};
  for (const output of outputs) {
    if (output.value === undefined) {
      void logger.warn('evaluateStepOutputs: naked form invalid at step level, skipping', {
        name: output.name,
      });
      continue;
    }
    try {
      evaluated[output.name] = evaluateOutputExpression(output.value, { ...effectiveVars });
    } catch (err) {
      const message = getErrorMessage(err);
      void logger.warn('evaluateStepOutputs: failed to evaluate output expression', {
        name: output.name,
        value: output.value,
        error: message,
      });
      emitter?.emit('ERROR_OCCURRED', {
        message: `OUTPUTS evaluation failed for "${output.name}": ${message}`,
        code: 'OUTPUTS_EVAL_FAILED',
      });
    }
  }
  return evaluated;
}

/**
 * Evaluate frontmatter OUTPUTS declarations at runbook termination.
 *
 * Handles both forms:
 * - Naked form (`PlanPath`): reads variable by name from effectiveVars, stringified
 * - With-value form (`PlanPath "literal"`): delegates to evaluateOutputExpression
 *
 * Failures are non-fatal.
 *
 * @param outputs - Output declarations from frontmatter
 * @param effectiveVars - Template variables at termination (templateVars + machineContext.variables)
 * @param emitter - Optional emitter for surfacing evaluation failures
 * @returns Evaluated key-value pairs (empty if nothing evaluated)
 */
export function evaluateFrontmatterOutputs(
  outputs: readonly OutputDeclaration[],
  effectiveVars: Readonly<StepVariables>,
  emitter?: ExecutionEventEmitter,
): Record<string, string> {
  const evaluated: Record<string, string> = {};
  for (const output of outputs) {
    try {
      if (output.value !== undefined) {
        evaluated[output.name] = evaluateOutputExpression(output.value, { ...effectiveVars });
      } else {
        const rawVal = (effectiveVars as Record<string, unknown>)[output.name];
        if (rawVal === null || rawVal === undefined) {
          void logger.warn(
            'evaluateFrontmatterOutputs: naked-form variable not found, skipping',
            { name: output.name },
          );
          continue;
        }
        if (
          typeof rawVal === 'string' ||
          typeof rawVal === 'number' ||
          typeof rawVal === 'boolean'
        ) {
          evaluated[output.name] = String(rawVal);
        } else {
          void logger.warn(
            'evaluateFrontmatterOutputs: naked-form variable is non-scalar, skipping',
            { name: output.name },
          );
        }
      }
    } catch (err) {
      const message = getErrorMessage(err);
      void logger.warn('evaluateFrontmatterOutputs: failed to evaluate output expression', {
        name: output.name,
        value: output.value,
        error: message,
      });
      emitter?.emit('ERROR_OCCURRED', {
        message: `Frontmatter OUTPUTS evaluation failed for "${output.name}": ${message}`,
        code: 'OUTPUTS_EVAL_FAILED',
      });
    }
  }
  return evaluated;
}
```

- [ ] **Step 4: Update any imports of old function names**

```bash
grep -rn "storeStepOutputs\|storeFrontmatterOutputs\|storeContextOutputs" packages/cli/src/ 2>&1
```

For each match, note the caller — they'll be fixed in later tasks (execution-units.ts, runbook-pipeline.ts, transitions.ts).

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd packages/cli && npx jest --testPathPattern="step-outputs" --no-coverage 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/helpers/step-outputs.ts packages/cli/__tests__/unit/helpers/step-outputs.test.ts
git commit -m "feat(cli): rewrite step-outputs as pure evaluation functions, no file I/O"
```

---

## Task 9: CLI — Update `execution-units.ts` (remove INPUTS only)

**Files:**
- Modify: `packages/cli/src/helpers/execution-units.ts`
- Test: `packages/cli/__tests__/unit/helpers/execution-units.test.ts`

### Context

Only one change here: remove `collectExecutionUnitInputs` (the INPUTS directive is gone from the AST). The `persistPassOutputs` function is **deleted** (not renamed — step OUTPUTS evaluation moves entirely into `execution.ts applyResultTransition` in Task 11, where `actorService` is available). The helpers `shouldPersistParentOutputs`, `mergeExecutionTemplateVars`, and `resolveCurrentExecutionUnit` **stay** — they're still used by `execution.ts`.

**Why `persistPassOutputs` is deleted, not refactored:** The correct mechanism for writing step OUTPUTS is `actorService.sendAndSync(SET_VARIABLES)`, not `manager.update({ variables })`. `createActor()` restores the actor from `state.snapshot`, not from the flat `state.variables` field — so a direct manager update is invisible to the next actor. The OUTPUTS flow must go through the machine event to update the XState snapshot.

- [ ] **Step 1: Write failing test for removal of `collectExecutionUnitInputs`**

In `packages/cli/__tests__/unit/helpers/execution-units.test.ts`:

```typescript
import * as executionUnits from '../../../src/helpers/execution-units.js';

it('collectExecutionUnitInputs is no longer exported', () => {
  expect('collectExecutionUnitInputs' in executionUnits).toBe(false);
});

it('persistPassOutputs is no longer exported', () => {
  expect('persistPassOutputs' in executionUnits).toBe(false);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd packages/cli && npx jest --testPathPattern="execution-units" --no-coverage 2>&1 | tail -20
```

Expected: failures — both functions currently exist.

- [ ] **Step 3: Delete `collectExecutionUnitInputs` from `execution-units.ts`**

Delete the `collectExecutionUnitInputs` function entirely (currently lines 62–77). Also remove any `inputs` references on `currentStep` or `substep` AST nodes — `inputs` is no longer in the AST after Task 2.

- [ ] **Step 4: Delete `persistPassOutputs` from `execution-units.ts`**

Delete the `persistPassOutputs` function (currently lines 166–204). Its OUTPUTS evaluation logic moves into `execution.ts` in Task 11, using `actorService.sendAndSync(SET_VARIABLES)`.

Keep `shouldPersistParentOutputs`, `mergeExecutionTemplateVars`, `resolveCurrentExecutionUnit`, `isTerminalActionType` — they're still used.

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd packages/cli && npx jest --testPathPattern="execution-units" --no-coverage 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/helpers/execution-units.ts packages/cli/__tests__/unit/helpers/execution-units.test.ts
git commit -m "feat(cli): remove collectExecutionUnitInputs and persistPassOutputs from execution-units"
```

---

## Task 10: CLI — Update `runbook-pipeline.ts`

**Files:**
- Modify: `packages/cli/src/helpers/runbook-pipeline.ts`

### Context

Three changes:
1. Remove `loadContextOutputs` import and the block that injects outputs.json into mergedVariables (lines 40, 550–588)
2. Remove `inputsResolvedKeys` from `required:` validation (line 594)
3. Update frontmatter OUTPUTS call: fire on `'done'` AND `'stopped'`, write result to `state.finalVars`
4. Remove `validateInputsDeclarations` import and call

- [ ] **Step 1: Remove `loadContextOutputs` import**

```typescript
// REMOVE from the import block around line 35-41:
loadContextOutputs,
```

- [ ] **Step 2: Remove the INPUTS injection block (lines 550–588)**

Delete this entire section:
```typescript
const inputsResolvedKeys = new Set<string>();
const declaredInputs = frontmatter?.inputs;
const declaredInputSet = declaredInputs ? new Set(declaredInputs) : undefined;
const isDelegationChild = ...
try {
  const contextId = ...
  if (contextId && (declaredInputSet || isDelegationChild)) {
    const contextOutputs = await loadContextOutputs(cwd, contextId);
    // ... injection loop
  }
} catch (err) { ... }
```

After removing this block, `inputsResolvedKeys` no longer exists.

- [ ] **Step 3: Update `required:` validation to remove `inputsResolvedKeys`**

Find the `required:` check (around line 591–598):

```typescript
// BEFORE:
const missing = requiredVars.filter(
  (name: string) => !providedKeys.has(name) && !inputsResolvedKeys.has(name),
);

// AFTER:
const missing = requiredVars.filter(
  (name: string) => !providedKeys.has(name),
);
```

- [ ] **Step 4: Remove `validateInputsDeclarations` import and call**

Find the import (around line 65–69):
```typescript
// REMOVE:
validateInputsDeclarations,
```

Find the call site where `validateInputsDeclarations` is called and remove it.

- [ ] **Step 5: Update frontmatter OUTPUTS call to fire on all terminations**

Find the current call (around line 768–772):

```typescript
// BEFORE:
if (loopResult === 'done' && frontmatterOutputs?.length) {
  await storeFrontmatterOutputs(frontmatterOutputs, prepared.mergedVariables, cwd, emitter);
}

// AFTER: evaluate on 'done' or 'stopped', write to finalVars
if ((loopResult === 'done' || loopResult === 'stopped') && frontmatterOutputs?.length) {
  // Build effective vars: templateVars + state.variables (step OUTPUTS that fired)
  const postState = await manager.get(stateId);
  const effectiveVars = {
    ...prepared.mergedVariables,
    ...(postState?.variables ?? {}),
  };
  const finalVars = evaluateFrontmatterOutputs(frontmatterOutputs, effectiveVars, emitter);
  if (Object.keys(finalVars).length > 0) {
    await manager.update(stateId, { finalVars });
  }
}
```

Update imports:
```typescript
// REMOVE:
import { storeFrontmatterOutputs } from './step-outputs.js';

// ADD:
import { evaluateFrontmatterOutputs } from './step-outputs.js';
```

- [ ] **Step 6: Build to check for errors**

```bash
cd packages/cli && npx tsc --noEmit 2>&1 | head -40
```

Expected: no errors related to `loadContextOutputs`, `inputsResolvedKeys`, or `validateInputsDeclarations`.

- [ ] **Step 7: Run unit tests**

```bash
cd packages/cli && npx jest --testPathPattern="runbook-pipeline" --no-coverage 2>&1 | tail -20
```

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/helpers/runbook-pipeline.ts
git commit -m "feat(cli): remove loadContextOutputs injection, use finalVars for frontmatter outputs"
```

---

## Task 11: CLI — Update `transitions.ts` and `execution.ts`

**Files:**
- Modify: `packages/cli/src/helpers/transitions.ts`
- Modify: `packages/cli/src/services/execution.ts`

> **Review note:** `syncResult` is reassigned to `setVarsResult` at the end of the OUTPUTS block. `actionType` is computed from the PASS/FAIL snapshot *before* the block — that ordering is correct. Verify nothing between the initial `sendAndSync(PASS/FAIL)` and the SET_VARIABLES block reads `syncResult` expecting it to still be the PASS/FAIL result.

> **Review note [P1 — rendering path gap]:** Step OUTPUTS written to `context.variables` via `SET_VARIABLES` will NOT be visible to subsequent steps as template variables. The rendering path at `execution.ts:658–663` calls `buildStepVariables(..., currentState.templateVars)` — it only reads `templateVars`, not `currentState.variables`. After `SET_VARIABLES` fires, `currentState` is refreshed from the snapshot, so `currentState.variables` will contain OUTPUTS — but they are never merged into the `buildStepVariables` call. Fix: the `buildStepVariables` call at line 658 must merge `currentState.variables` into the `templateVars` argument (or `buildStepVariables` must accept a second variables map). This is a gap in the plan that must be addressed in this task.

> **Review note [P1 — OUTPUTS pass+fail broadening]:** The plan's replacement block in Step 4 removes the `result === 'pass'` guard (currently at `execution.ts:244`), meaning OUTPUTS would fire on both PASS and FAIL. Current behavior is pass-only. This is a semantic change, not an implementation detail — decide explicitly whether OUTPUTS on FAIL is intentional. If not, re-add the guard inside the new block for at least the parent-step path.

### Context

`transitions.ts` has `maybePersistFrontmatterOutputs` (around line 210) that calls `storeFrontmatterOutputs`. Update to use `evaluateFrontmatterOutputs` + write `finalVars` via manager.

`execution.ts` has:
1. `loadContextOutputs` import (line 39) — remove
2. INPUTS injection block (lines 590–636) — remove  
3. `persistPassOutputs` call (line 254) — rename to `persistStepOutputs`, update args, remove `result === 'pass'` guard

- [ ] **Step 1: Update `transitions.ts` — replace `storeFrontmatterOutputs`**

Find `maybePersistFrontmatterOutputs` (around line 210):

```typescript
// BEFORE:
async function maybePersistFrontmatterOutputs(
  state: Pick<RunbookState, 'runbookSrc' | 'runbookPath' | 'templateVars'>,
  cwd: string,
  emitter?: ExecutionEventEmitter,
): Promise<void> {
  if (!state.runbookSrc) return;
  const { frontmatter } = parseRunbookDocument(state.runbookSrc, path.basename(state.runbookPath));
  if (!frontmatter?.outputs?.length) return;
  await storeFrontmatterOutputs(
    frontmatter.outputs,
    state.templateVars as Readonly<StepVariables>,
    cwd,
    emitter,
  );
}

// AFTER:
async function maybePersistFrontmatterOutputs(
  state: Pick<RunbookState, 'runbookSrc' | 'runbookPath' | 'templateVars' | 'variables'>,
  manager: RunbookStateManager,
  stateId: string,
  emitter?: ExecutionEventEmitter,
): Promise<void> {
  if (!state.runbookSrc) return;
  const { frontmatter } = parseRunbookDocument(state.runbookSrc, path.basename(state.runbookPath));
  if (!frontmatter?.outputs?.length) return;

  // Effective vars: templateVars (CLI/config) + state.variables (step OUTPUTS)
  const effectiveVars = {
    ...(state.templateVars as Readonly<StepVariables>),
    ...state.variables,
  };
  const finalVars = evaluateFrontmatterOutputs(frontmatter.outputs, effectiveVars, emitter);
  if (Object.keys(finalVars).length > 0) {
    await manager.update(stateId, { finalVars });
  }
}
```

Update all call sites of `maybePersistFrontmatterOutputs` to pass `manager` and `stateId` instead of `cwd`.

Update imports:
```typescript
// REMOVE:
import { storeFrontmatterOutputs } from './step-outputs.js';
// ADD:
import { evaluateFrontmatterOutputs } from './step-outputs.js';
```

- [ ] **Step 2: Update `execution.ts` — remove `loadContextOutputs` import**

Remove from imports (around line 39):
```typescript
loadContextOutputs,
```

- [ ] **Step 3: Remove the INPUTS injection block in `execution.ts` (lines 590–636)**

Delete this section — it injects context outputs into template vars when INPUTS are declared. The new design doesn't need this at runtime (vars are injected via `--var` flags at startup or via SET_VARIABLES for delegation).

- [ ] **Step 4: Replace `persistPassOutputs` call with `sendAndSync(SET_VARIABLES)` in `execution.ts`**

**Why this order matters:** `sendAndSync(PASS/FAIL)` fires first so `syncResult.state.step` is known (needed for `shouldPersistParentOutputs`'s `parentStepAdvanced` check). Then OUTPUTS are evaluated and `sendAndSync(SET_VARIABLES)` is called. The SET_VARIABLES call updates the XState snapshot's `context.variables`, which the NEXT actor will read when created fresh from the snapshot. The final `syncResult` returned is the post-SET_VARIABLES state, so the execution loop's `currentState` has the correct `variables`.

Find the area around line 240–264 in `applyResultTransition`:

```typescript
// BEFORE (the existing block around line 240–264):
const actionType = parseActionType(extractLastAction(syncResult.snapshot));

if (cwd && result === 'pass') {
  const preTransitionStepVars = buildStepVariables(...);
  await persistPassOutputs({
    cwd, currentStep, ...
  });
}

// AFTER — restructure the entire block:
const actionType = parseActionType(extractLastAction(syncResult.snapshot));

// Evaluate step OUTPUTS for both PASS and FAIL.
// Done AFTER PASS/FAIL so updatedStepId is known for shouldPersistParentOutputs.
{
  const preTransitionStepVars = buildStepVariables(
    currentState.step,
    currentState.substep,
    currentState.forStack,
    currentStep.kind === 'for' ? currentStep.forClause : undefined,
    currentState.templateVars,
  );
  const templateVars = mergeExecutionTemplateVars(preTransitionStepVars, syncResult.state.templateVars);

  if (templateVars) {
    const allEvaluated: Record<string, string | number | boolean> = {};

    // Substep OUTPUTS: always fire immediately on substep completion
    const executionUnit = resolveCurrentExecutionUnit(currentStep, currentState.substep);
    if (isSubstep(executionUnit) && executionUnit.outputs?.length) {
      Object.assign(allEvaluated, evaluateStepOutputs(executionUnit.outputs, templateVars));
    }

    // Parent step OUTPUTS: only when shouldPersistParentOutputs
    const parentOutputs = currentStep.outputs ?? [];
    if (
      parentOutputs.length > 0 &&
      shouldPersistParentOutputs({
        isSubstepContext: currentState.substep !== undefined,
        parentStepAdvanced: syncResult.state.step !== currentState.step,
        isTerminalAction: actionType === 'STOP' || actionType === 'COMPLETE',
        parentHasOutputs: true,
      })
    ) {
      Object.assign(allEvaluated, evaluateStepOutputs(parentOutputs, templateVars));
    }

    if (Object.keys(allEvaluated).length > 0) {
      // Send SET_VARIABLES via the actor — this updates state.snapshot.context.variables,
      // which is what createActor() restores from on the next sendAndSync() call.
      // Direct manager.update({ variables }) is NOT sufficient: createActor reads from
      // state.snapshot, not from the flat state.variables field.
      const setVarsResult = await actorService.sendAndSync(runbookId, steps, {
        type: 'SET_VARIABLES',
        vars: allEvaluated,
      });
      if (setVarsResult) {
        syncResult = setVarsResult; // update syncResult so caller gets post-OUTPUTS state
      }
    }
  }
}
```

Update imports:
```typescript
// REMOVE:
import { persistPassOutputs, ... } from '../helpers/execution-units.js';
// ADD (keep the helpers that remain):
import {
  shouldPersistParentOutputs,
  mergeExecutionTemplateVars,
  resolveCurrentExecutionUnit,
  // ... other remaining exports
} from '../helpers/execution-units.js';
import { evaluateStepOutputs } from '../helpers/step-outputs.js';
```

Also add `isSubstep` import from `@rundown-org/parser` if not already present.

Verify `actorService` is in scope in `applyResultTransition`. If not, thread it from `runExecutionLoop` via the args object (it already has `actorService: RunbookActorService` at the loop level).

- [ ] **Step 5: Build check**

```bash
cd packages/cli && npx tsc --noEmit 2>&1 | head -40
```

Expected: no `storeContextOutputs`, `loadContextOutputs`, `persistPassOutputs` errors.

- [ ] **Step 6: Run unit tests**

```bash
cd packages/cli && npx jest --no-coverage 2>&1 | tail -30
```

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/helpers/transitions.ts packages/cli/src/services/execution.ts
git commit -m "feat(cli): remove INPUTS injection from execution loop, use persistStepOutputs for both pass+fail"
```

---

## Task 12: CLI — Update `delegation-completion.ts` (cross-runbook variable forwarding)

**Files:**
- Modify: `packages/cli/src/helpers/delegation-completion.ts`

> **Review note:** Before starting this task, read `delegation-completion.ts` to confirm that `parentActorService` and `parentSteps` are already in scope at the insertion point (Step 1 describes this, but verify the actual line numbers match). If the function signature or local variable names have drifted, the insertion block in Step 2 will need adjustment before the `actorService.sendAndSync` call will compile.

### Context

When a child runbook completes, its `finalVars` should be forwarded to the parent actor's `context.variables` BEFORE the parent substep's PASS/FAIL fires.

**Critical:** Do NOT use `manager.update({ variables })` here. `createActor()` restores from `state.snapshot`, not from `state.variables`. The update must go through `actorService.sendAndSync(SET_VARIABLES)` so the XState snapshot is updated — then the parent substep transition fires with the correct context.

The parent's `actorService` and `steps` array are needed. `actorService` is already imported (`RunbookActorService`) and likely instantiated in this file (or passed from the call site). The parent steps must be resolved: load the parent's `RunbookState` to get `runbookPath`, then parse the runbook to get the steps.

- [ ] **Step 1: Locate the insertion point in `handleParentCompletion`**

The insertion point is just before `drainResolvedCompletions` is called. The surrounding code (already in the function) looks like this — the insertion goes between lines `parentSteps = [...]` and the `drainResolvedCompletions(...)` call:

```typescript
// Already in the function (around lines 163–199):
const transitionConfig =
  result === 'pass' ? createPassTransitionConfig() : createFailTransitionConfig();

const parentActorService = new RunbookActorService(manager);  // ← actorService already here
const sessionService = new SessionService(manager);
const lifecycleService = new ExecutionLifecycleService(manager);

parentState = await manager.load(parentRunId);
if (!parentState) {
  return 'not-applicable';
}

const readonlySteps = getRunbookFromState(parentState, cwd);
const parentSteps = [...readonlySteps];  // ← parentSteps already here

// ↑ INSERT the SET_VARIABLES forward HERE ↑

const emitter = createBridgedEmitter(parentState, output);
const drained = await drainResolvedCompletions({
  manager,
  actorService: parentActorService,
  ...
});
```

Both `parentActorService` and `parentSteps` are already available. No new variables needed.

- [ ] **Step 2: Add `finalVars` forwarding via `sendAndSync(SET_VARIABLES)`**

Before the call that fires the parent substep PASS/FAIL transition (`createPassTransitionConfig`/`createFailTransitionConfig` or the equivalent `drainResolvedCompletions` invocation), insert:

```typescript
// Forward child's finalVars into parent actor's context.variables via SET_VARIABLES.
// Must use actorService.sendAndSync (not manager.update) — createActor() restores from
// state.snapshot, so a direct manager.update({ variables }) is invisible to the next actor.
if (childState.finalVars && Object.keys(childState.finalVars).length > 0) {
  try {
    const setVarsResult = await actorService.sendAndSync(
      linkage.parentRunId,
      parentSteps, // resolved parent runbook steps
      { type: 'SET_VARIABLES', vars: childState.finalVars },
    );
    if (!setVarsResult) {
      void logger.warn('delegation-completion: SET_VARIABLES returned null — parent state not found', {
        parentRunId: linkage.parentRunId,
      });
    }
  } catch (err) {
    void logger.warn('delegation-completion: failed to forward child finalVars to parent actor', {
      error: getErrorMessage(err),
      childRunId: childState.id,
      parentRunId: linkage.parentRunId,
    });
  }
}
```

If `parentSteps` is not already in scope, resolve them by loading the parent runbook:

```typescript
// Load parent steps (needed for sendAndSync)
const parentRunbookState = await manager.get(linkage.parentRunId);
const parentSteps: ResolvedStep[] = parentRunbookState?.runbookSrc
  ? resolveRunbookSteps(parentRunbookState) // use existing resolver from runbook-loader.ts
  : [];
```

Check `delegation-completion.ts` imports and nearby helpers — there is likely already code that loads the parent runbook and resolves steps for `drainResolvedCompletions`. Reuse it rather than duplicating.

- [ ] **Step 3: Build check**

```bash
cd packages/cli && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Run existing delegation tests**

```bash
cd packages/cli && npx jest --testPathPattern="delegation" --no-coverage 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/helpers/delegation-completion.ts
git commit -m "feat(cli): forward child finalVars to parent via SET_VARIABLES event (not manager.update)"
```

---

## Task 13: CLI — Add `vars` field to `status-builder.ts`

**Files:**
- Modify: `packages/cli/src/helpers/status-builder.ts`
- Modify: `packages/cli/src/commands/status.ts` (if it builds the status output)
- Test: `packages/cli/__tests__/unit/helpers/status-builder.test.ts`

### Context

`rd status` gains a `vars` field showing the effective variable space: `state.templateVars` (base) merged with `state.variables` (step OUTPUTS). Only scalar values are shown (strings, numbers, booleans — skip JsonObject, JsonArray, JsonArrayStream).

- [ ] **Step 1: Write failing test**

`buildActiveStatus` signature: `buildActiveStatus(activeState: RunbookState, cwd: string, stashedId?: string): StatusOutputData`

```typescript
import { buildActiveStatus } from '../../../src/helpers/status-builder.js';

it('includes vars in status output when state has templateVars and variables', () => {
  const state: RunbookState = {
    ...minimalRunbookState(), // use the existing minimal state fixture
    templateVars: {
      environment: 'staging',
      port: 3000,
      items: { kind: 'json-array', value: ['a', 'b'] }, // non-scalar, excluded
    },
    variables: {
      PlanPath: '/work/plan.json', // from step OUTPUTS
    },
  };
  const result = buildActiveStatus(state, '/project/root');
  expect(result.vars).toEqual({
    environment: 'staging',
    port: '3000',
    PlanPath: '/work/plan.json',
  });
});

it('state.variables overrides templateVars for same key', () => {
  const state: RunbookState = {
    ...minimalRunbookState(),
    templateVars: { Answer: '41' },
    variables: { Answer: '42' }, // step OUTPUTS wins
  };
  const result = buildActiveStatus(state, '/project/root');
  expect(result.vars?.Answer).toBe('42');
});
```

- [ ] **Step 2: Add `vars` to `StatusOutputData` interface**

In `packages/cli/src/helpers/status-builder.ts`, after `parentLinkage?:` (around line 92):

```typescript
/** Effective variable space: templateVars (base) merged with step OUTPUTS (state.variables). */
vars?: Record<string, string>;
```

- [ ] **Step 3: Build the `vars` value in the builder function**

Find the function that builds `StatusOutputData` (likely `buildActiveStatus` or similar). Add:

```typescript
function buildVars(state: RunbookState): Record<string, string> | undefined {
  const fromTemplateVars = Object.fromEntries(
    Object.entries(state.templateVars ?? {})
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .map(([k, v]) => [k, String(v)]),
  );
  const fromStateVars = Object.fromEntries(
    Object.entries(state.variables).map(([k, v]) => [k, String(v)]),
  );
  const merged = { ...fromTemplateVars, ...fromStateVars };
  return Object.keys(merged).length > 0 ? merged : undefined;
}
```

Then in the status builder:
```typescript
vars: buildVars(state),
```

- [ ] **Step 4: Run tests**

```bash
cd packages/cli && npx jest --testPathPattern="status" --no-coverage 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/helpers/status-builder.ts packages/cli/__tests__/unit/helpers/status-builder.test.ts
git commit -m "feat(cli): add vars field to rd status output (templateVars + step OUTPUTS)"
```

---

## Task 14: Plugin — Update `delegation-dispatch.ts` (`--var` injection)

**Files:**
- Modify: `packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts`

> **Review note [P2 — wrong runbook when multiple delegations pending]:** The plan reads the child runbook path from `statusData.delegations[i].runbook` and injects `--var` flags based on its `frontmatter.inputs`. When more than one delegation is pending, picking the right entry from the `delegations` array requires matching by delegation token — the token being claimed is known at dispatch time and must be used as the key to identify the correct delegation entry, not positional indexing. Clarify how the hook identifies which delegation entry corresponds to the current `rd claim <token>` invocation before implementing Step 2.

> **Review note [P2 — --var flags override frozen snapshot]:** `--var` flags are the highest-precedence variable source (above `RD_VAR_*`, config, and `inputs:` defaults). Injecting parent vars as `--var` flags silently overrides any value the child runbook's `inputs:` field sets as a default — including cases where the parent's variable is stale or semantically wrong for the child. Consider injecting at a lower precedence (e.g., passing only keys the child declares in `required:`, or using `--var-file` written to a temp path) to avoid unintended overrides.

### Context

When the plugin builds the `rd claim <token>` command, it should inject `--var key=value` for each key declared in the child runbook's `frontmatter.inputs`. Values come from the parent's live variable space (available via `rd status --json` which now includes the `vars` field added in Task 13).

The flow:
1. At delegation time, `rd delegate` has already fired — the parent's variable space is frozen in the context snapshot (or readable via `rd status`)
2. Parse the child runbook's frontmatter to get `inputs:` keys (the defaults — keys callers should provide)
3. For each key in `frontmatter.inputs`, look up the value in parent's `statusData.vars`
4. Build `--var key=value` flags for each matched key
5. Inject into `rd claim <token> --var A=<val> --var B=<val> ...`

- [ ] **Step 1: Find where `rd claim` command is assembled**

In `packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts`, find the line building the `rd claim <token>` string (around line 72–74).

- [ ] **Step 2: Add logic to read parent vars and build `--var` flags**

The child runbook name is available from the parent's `rd status --json` output — it's in the `delegations` array as `delegations[i].runbook`. The parent's `vars` field (added in Task 13) gives the parent's live variable space. The plugin already calls `rundown(['status'], input.cwd)` to get status.

Before the `rd claim` assembly, add:

```typescript
import { parseRunbookDocument } from '@rundown-org/parser';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Inside the dispatch handler, after the existing status call:
// statusOutput already has the parent's status JSON (from the existing rundown(['status']) call)
const parentVars = (status as { vars?: Record<string, string> }).vars;

// Find the pending delegation to get the child runbook name
const delegations = (status as { delegations?: Array<{ runbook: string; state: string }> })
  .delegations ?? [];
const pending = delegations.find((d) => d.state === 'pending');
const childRunbookName = pending?.runbook;

async function buildChildVarFlags(
  childRunbookName: string | undefined,
  parentVars: Record<string, string> | undefined,
  cwd: string,
): Promise<string> {
  if (!childRunbookName || !parentVars || Object.keys(parentVars).length === 0) return '';
  try {
    // Resolve the runbook file from its name/path
    const runbookPath = path.isAbsolute(childRunbookName)
      ? childRunbookName
      : path.resolve(cwd, childRunbookName);
    const src = await fs.readFile(runbookPath, 'utf-8');
    const { frontmatter } = parseRunbookDocument(src);
    const inputKeys = Object.keys(frontmatter?.inputs ?? {});
    const flags = inputKeys
      .filter((key) => Object.hasOwn(parentVars, key))
      .map((key) => `--var ${key}=${JSON.stringify(parentVars[key])}`)
      .join(' ');
    return flags ? ` ${flags}` : '';
  } catch {
    return ''; // non-fatal — child runs without pre-injected vars
  }
}
```

Then use it when building the claim command:

```typescript
const varFlags = await buildChildVarFlags(childRunbookName, parentVars, input.cwd);
const claimCommand = `rd claim ${token}${varFlags}`;
```

**Note:** If the child runbook name in `status.delegations[i].runbook` is a short name (not a path), you'll need to resolve it using the runbook discovery logic. Check what format it appears in by running `rd status --json` with an active delegation and inspecting the `delegations` array.

- [ ] **Step 3: Build plugin**

```bash
cd packages/claude-code-plugin && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts
git commit -m "feat(plugin): inject --var flags from child inputs: keys into rd claim command"
```

---

## Task 15: Migration — Update all runbook files and docs

**Files:**
- All `*.runbook.md` files in `runbooks/`, `packages/*/`, `.rundown/runbooks/`
- `docs/SPEC.md`, `docs/FORMAT.md`

### Context

Every runbook using `vars:` frontmatter must be renamed to `inputs:`. Every step using `- INPUTS` directives must have those blocks removed.

- [ ] **Step 1: Rename `vars:` → `inputs:` in all runbook files**

```bash
# Preview what will change:
grep -rn "^vars:" --include="*.runbook.md" .

# Apply the rename (safe — vars: only appears in frontmatter context):
find . -name "*.runbook.md" -exec sed -i '' 's/^vars:$/inputs:/g' {} +
```

Verify the change looks correct in a few files:
```bash
git diff --stat
```

- [ ] **Step 2: Remove `- INPUTS` directive blocks from all runbook files**

```bash
# Find all files with INPUTS directives:
grep -rln "^- INPUTS" --include="*.runbook.md" .
```

For each file found, manually remove the `- INPUTS` block and its nested list items. These are step-level blocks and cannot be mechanically removed without risk of corrupting surrounding content — review each one.

Example: in `runbooks/context-passing/outputs-inputs.runbook.md`:
```markdown
# BEFORE step 2:
## 2. Use the message
- INPUTS
  - Message

The message is: {{Message}}
PASS COMPLETE

# AFTER: inputs now come via --var injection, not declared in step
## 2. Use the message
The message is: {{Message}}
PASS COMPLETE
```

- [ ] **Step 3: Validate all runbooks after migration**

```bash
for f in $(find . -name "*.runbook.md" ! -path "*/node_modules/*"); do
  echo "Checking: $f"
  rd check "$f" 2>&1 | grep -E "error|warning" || true
done
```

Expected: no INPUTS directive errors. If any `vars:` are in non-frontmatter positions (shouldn't be), fix manually.

- [ ] **Step 4: Update docs**

In `docs/SPEC.md` and `docs/FORMAT.md`:
- Replace all references to `vars:` frontmatter field with `inputs:`
- Remove documentation for `- INPUTS` step directive
- Update variable precedence table (level 4 is now `inputs:` not `vars:`)
- Update examples

- [ ] **Step 5: Run full test suite**

```bash
npm test 2>&1 | tail -40
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add runbooks/ packages/ docs/
git commit -m "feat: migrate all runbooks from vars: to inputs:, remove - INPUTS directives"
```

---

## Task 16: Remove `validateInputsDeclarations` from `validate-frontmatter-vars.ts`

**Files:**
- Modify: `packages/cli/src/helpers/validate-frontmatter-vars.ts`

### Context

`validateInputsDeclarations` validated that `inputs: string[]` items were identifiers. Now `inputs:` is a Record validated by Zod, so this function is dead code.

- [ ] **Step 1: Check if `validateInputsDeclarations` is still referenced**

```bash
grep -rn "validateInputsDeclarations" packages/ 2>&1
```

After Task 10 removed the call from `runbook-pipeline.ts`, this should show no remaining references.

- [ ] **Step 2: Delete the function**

In `packages/cli/src/helpers/validate-frontmatter-vars.ts`, find and delete the `validateInputsDeclarations` function and its export.

- [ ] **Step 3: Build check**

```bash
cd packages/cli && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/helpers/validate-frontmatter-vars.ts
git commit -m "feat(cli): remove validateInputsDeclarations (inputs: now validated by Zod)"
```

---

## Task 17: Rewrite integration tests

**Files:**
- Modify: `packages/cli/__tests__/integration/frontmatter-outputs.test.ts`

### Context

The existing integration tests assert that outputs are written to `outputs.json` and read back. Rewrite to:
1. Assert that frontmatter `outputs:` write to `state.finalVars` (not outputs.json)
2. Assert that step OUTPUTS update `state.variables` (not outputs.json)
3. Assert that `rd status --json` includes `vars` field
4. Assert delegation forwarding: child's `finalVars` appear in parent's `state.variables`

- [ ] **Step 1: Run existing integration tests to understand what passes**

```bash
npm run test:integration 2>&1 | grep -A5 "frontmatter-outputs" | head -30
```

- [ ] **Step 2: Rewrite test: frontmatter outputs write to `state.finalVars`**

```typescript
it('stores frontmatter naked-form output to state.finalVars on completion', async () => {
  const runbook = createTempRunbook(`---
outputs:
  - SomeVar
---
# Test Runbook

## 1. Step one
Do a thing.
PASS COMPLETE
`);
  await runWith(runbook, ['--var', 'SomeVar=hello', '--yes']);

  // Find the state file and assert finalVars
  const state = await loadRunbookState(runbook); // helper to find .rundown/runs/*.json
  expect(state.finalVars).toEqual({ SomeVar: 'hello' });
  // outputs.json must NOT exist
  const contextId = state.templateVars?.ContextId;
  const outputsPath = `.rundown/contexts/${contextId}/outputs.json`;
  await expect(fs.access(outputsPath)).rejects.toThrow(); // file does not exist
});
```

- [ ] **Step 3: Rewrite test: step OUTPUTS update `state.variables`**

```typescript
it('stores step OUTPUTS to state.variables on completion', async () => {
  const runbook = createTempRunbook(`---
name: step-outputs-test
---
# Step OUTPUTS Test

## 1. Produce output
- OUTPUTS
  - Result "computed-value"
PASS CONTINUE

## 2. Verify output
PASS COMPLETE
`);
  await runWith(runbook, ['--yes']);

  const state = await loadRunbookState(runbook);
  expect(state.variables).toMatchObject({ Result: 'computed-value' });
});
```

- [ ] **Step 4: Rewrite test: `rd status` includes `vars` field**

```typescript
it('rd status --json includes vars field with template and step OUTPUTS vars', async () => {
  const runbook = createTempRunbook(`---
inputs:
  environment: staging
---
# Vars Status Test

## 1. Step one
PASS CONTINUE

## 2. Step two (waiting)
Do a manual thing.
PASS COMPLETE
`);
  // Start runbook — will stop at step 2 waiting for manual pass
  await runInBackground(runbook, ['--yes']);

  const statusOutput = JSON.parse(
    await runCommand(['status', '--json'])
  );
  expect(statusOutput.vars).toBeDefined();
  expect(statusOutput.vars.environment).toBe('staging');
});
```

- [ ] **Step 5: Remove old `outputs.json` assertion helpers**

Delete or update any helpers that checked for `outputs.json` existence, read its content, or cleaned it up.

- [ ] **Step 6: Run integration tests**

```bash
npm run test:integration 2>&1 | grep -E "PASS|FAIL|Error" | head -30
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/__tests__/integration/frontmatter-outputs.test.ts
git commit -m "test(cli): rewrite frontmatter-outputs integration tests for new variable flow"
```

---

## Task 18: Full verification

- [ ] **Step 1: Build all packages**

```bash
npm run build 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 2: Run full test suite**

```bash
npm run test:all 2>&1 | tail -40
```

Expected: all tests pass.

- [ ] **Step 3: Validate all runbook files**

```bash
for f in $(find . -name "*.runbook.md" ! -path "*/node_modules/*" ! -path "*/.git/*"); do
  rd check "$f" 2>&1 | grep -E "^ERROR|error:" | grep -v "^$" && echo "  ^ in $f" || true
done
```

Expected: no errors.

- [ ] **Step 4: Smoke test — step OUTPUTS flow through to `rd status`**

```bash
# Write a test runbook
cat > /tmp/smoke-test.runbook.md << 'EOF'
---
name: smoke-test
---
# Smoke Test

## 1. Produce output
- OUTPUTS
  - Answer "forty-two"
PASS CONTINUE

## 2. Verify
PASS COMPLETE
EOF

rd run /tmp/smoke-test.runbook.md --yes --text
rd status --json | python3 -m json.tool | grep -A5 '"vars"'
```

Expected: `vars.Answer = "forty-two"` in status output.

- [ ] **Step 5: Smoke test — frontmatter outputs write to finalVars**

```bash
cat > /tmp/fm-outputs-test.runbook.md << 'EOF'
---
outputs:
  - WorkPath
---
# Frontmatter Outputs Test

## 1. Step
PASS COMPLETE
EOF

rd run /tmp/fm-outputs-test.runbook.md --yes --text
# Find the state file and check finalVars
find .rundown/runs/ -name "*.json" -newer /tmp/fm-outputs-test.runbook.md | \
  head -1 | xargs python3 -c "import sys,json; d=json.load(open(sys.argv[1])); print(d.get('finalVars'))"
```

Expected: `{'WorkPath': '.rundown/work/...'}` (the built-in WorkPath variable).

- [ ] **Step 6: Run pre-PR verification**

```bash
npm run verify 2>&1 | tail -20
```

Expected: format, spell, lint, tests all pass.

- [ ] **Step 7: Final commit if any cleanup needed**

```bash
git add -p  # stage any cleanup
git commit -m "chore: verification cleanup for inputs/outputs variable flow"
```
