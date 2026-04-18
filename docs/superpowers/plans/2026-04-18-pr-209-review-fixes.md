# PR #209 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address four confirmed code-quality issues identified in PR #209 review: a dead type-branch that fails `lint-typed`, wrong mock shapes in tests, a spurious validation reject that blocks the core pass-through use-case, and a silent failure that corrupts parent execution state.

**Architecture:** Four independent fixes across three packages. No shared state — tasks can be ordered or parallelised freely. Each fix follows the TDD pattern: failing test → minimal implementation → green.

**Tech Stack:** TypeScript, Jest, `@rundown-org/cli`, `@rundown-org/parser`

---

## Dismissed Issues (do not implement)

These two coderabbit comments were verified against the current implementation and are not real issues:

- **`runbook-pipeline.test.ts:928`** — The test that asserts `evaluateFrontmatterOutputs` is NOT called when `loopResult === 'stopped'` is **correct**. Both `launchRunbook` and `transitions.ts` consistently skip output evaluation for stopped runs. The design is intentional.
- **`delegation-dispatch.ts:85`** — The `shellQuote` only wrapping the value (not `key=value`) is **safe**. Key names are constrained to `[a-zA-Z_][a-zA-Z0-9_]*` by spec and cannot contain `$`, backticks, or spaces.

---

## Task 1: Fix dead `=== null` branch in `evaluateFrontmatterOutputs`

**Files:**
- Modify: `packages/cli/src/helpers/step-outputs.ts:83`
- Test: `packages/cli/__tests__/helpers/step-outputs.test.ts`

The `StepVariables` type does not include `null`, so `rawVal === null` at line 83 is unreachable dead code. TypeScript's strict `lint-typed` check flags this. Remove the null arm.

- [ ] **Step 1: Locate the existing test file for step-outputs**

```bash
cd packages/cli && npx jest --listTests 2>&1 | grep step-outputs
```

Expected: shows path to `__tests__/helpers/step-outputs.test.ts` (or similar).

- [ ] **Step 2: Add a failing test that documents the dead branch is gone**

In `packages/cli/__tests__/helpers/step-outputs.test.ts`, add inside `describe('evaluateFrontmatterOutputs', ...)`:

```typescript
it('skips naked-form output when variable is undefined (not null)', () => {
  // rawVal is undefined — valid skip case
  const result = evaluateFrontmatterOutputs(
    [{ name: 'Missing' }],
    { PlanPath: '/some/path' },
  );
  expect(result).toEqual({});
});
```

- [ ] **Step 3: Run the test to confirm it currently passes (baseline)**

```bash
cd packages/cli && npx jest --testPathPattern="step-outputs" -t "skips naked-form"
```

Expected: PASS (the skip logic already works; we're testing the surviving branch, not the dead one).

- [ ] **Step 4: Fix the dead branch in production code**

In `packages/cli/src/helpers/step-outputs.ts`, change line 83 from:

```typescript
        if (rawVal === null || rawVal === undefined) {
```

to:

```typescript
        if (rawVal === undefined) {
```

- [ ] **Step 5: Run lint-typed to confirm the CI failure is resolved**

```bash
cd packages/cli && npm run check:lint:typed 2>&1 | grep "step-outputs"
```

Expected: no errors referencing `step-outputs.ts`.

- [ ] **Step 6: Run the full step-outputs test suite**

```bash
cd packages/cli && npx jest --testPathPattern="step-outputs"
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/helpers/step-outputs.ts packages/cli/__tests__/helpers/step-outputs.test.ts
git commit -m "fix(cli): remove dead null branch in evaluateFrontmatterOutputs"
```

---

## Task 2: Fix test mock shape for `inputs:` in runbook-pipeline tests

**Files:**
- Modify: `packages/cli/__tests__/helpers/runbook-pipeline.test.ts:432, 453, 466`

The mock frontmatter uses `{ inputs: ['Region'] }` (array) but the parser emits `inputs` as `Record<string, string | number | boolean>`. The mocks and their corresponding assertions must use the Record shape.

- [ ] **Step 1: Locate the two failing tests**

Open `packages/cli/__tests__/helpers/runbook-pipeline.test.ts` and find:
- Line ~432: `frontmatter: { inputs: ['Region'] }` inside "passes parser frontmatter inputs into variable resolution"
- Line ~453: `frontmatter: { inputs: ['context'] }` inside "returns VALIDATION_ERROR when frontmatter inputs use reserved names"
- Line ~466: `expect(validateFrontmatterVars).toHaveBeenCalledWith(['context'])`

- [ ] **Step 2: Update the first mock and assertion**

Change the mock and assertion in "passes parser frontmatter inputs into variable resolution":

```typescript
// Before (wrong — array shape):
frontmatter: { inputs: ['Region'] },
// ...
expect(resolveVariables).toHaveBeenCalledWith(
  expect.objectContaining({
    frontmatterVars: ['Region'],
  }),
  '/test',
  expect.anything(),
);

// After (correct — Record shape):
frontmatter: { inputs: { Region: '' } },
// ...
expect(resolveVariables).toHaveBeenCalledWith(
  expect.objectContaining({
    frontmatterVars: { Region: '' },
  }),
  '/test',
  expect.anything(),
);
```

- [ ] **Step 3: Update the second mock and assertion**

Change the mock and assertion in "returns VALIDATION_ERROR when frontmatter inputs use reserved names":

```typescript
// Before (wrong):
frontmatter: { inputs: ['context'] },
// ...
expect(validateFrontmatterVars).toHaveBeenCalledWith(['context']);

// After (correct):
frontmatter: { inputs: { context: '' } },
// ...
expect(validateFrontmatterVars).toHaveBeenCalledWith({ context: '' });
```

- [ ] **Step 4: Run the affected tests to confirm they pass**

```bash
cd packages/cli && npx jest --testPathPattern="runbook-pipeline" -t "passes parser frontmatter|returns VALIDATION_ERROR when frontmatter inputs"
```

Expected: both PASS.

- [ ] **Step 5: Run the full runbook-pipeline test suite to check for regressions**

```bash
cd packages/cli && npx jest --testPathPattern="runbook-pipeline"
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/__tests__/helpers/runbook-pipeline.test.ts
git commit -m "test(cli): fix inputs mock shape from array to Record in runbook-pipeline tests"
```

---

## Task 3: Allow frontmatter outputs to reference existing inputs

**Files:**
- Modify: `packages/cli/src/helpers/validate-frontmatter-vars.ts:106-131`
- Modify: `packages/cli/__tests__/helpers/validate-frontmatter-vars.test.ts:182-199`

`validateOutputsDeclarations` currently rejects any output whose name also appears in `inputs`. This blocks the core pass-through use-case where a runbook declares `PlanPath` in both `inputs:` (with a default) and `outputs:` (naked form, to publish the value set during execution).

The check at lines 124-129 must be removed. Two tests that assert the error must be updated.

- [ ] **Step 1: Write a new test documenting the pass-through use-case is valid**

Add inside `describe('validateOutputsDeclarations', ...)` in `packages/cli/__tests__/helpers/validate-frontmatter-vars.test.ts`:

```typescript
it('allows output that references an existing input (pass-through use-case)', () => {
  const result = validateOutputsDeclarations(
    [{ name: 'PlanPath' }],
    { PlanPath: '/default/plan.json' },
  );
  expect(result).toEqual([]);
});
```

- [ ] **Step 2: Run the new test to confirm it fails**

```bash
cd packages/cli && npx jest --testPathPattern="validate-frontmatter-vars" -t "allows output that references"
```

Expected: FAIL — "Expected length: 0, Received length: 1".

- [ ] **Step 3: Remove the vars-conflict check from production code**

In `packages/cli/src/helpers/validate-frontmatter-vars.ts`, remove lines 124-129:

```typescript
// Delete these lines:
    if (varsKeys.has(output.name)) {
      diagnostics.push({
        severity: 'error',
        message: `Variable "${output.name}" cannot be both in "outputs" and "vars"`,
      });
    }
```

After removal, the `validateOutputsDeclarations` function body should have only the duplicate-name check and the reserved-name check.

- [ ] **Step 4: Run the new test to confirm it passes**

```bash
cd packages/cli && npx jest --testPathPattern="validate-frontmatter-vars" -t "allows output that references"
```

Expected: PASS.

- [ ] **Step 5: Update the two tests that expected the now-removed error**

In `packages/cli/__tests__/helpers/validate-frontmatter-vars.test.ts`:

**Test A** — "returns error when output name conflicts with vars" (line ~182): update to assert no error:

```typescript
it('allows output that shares a name with an input (no conflict)', () => {
  const result = validateOutputsDeclarations([{ name: 'PlanPath' }], {
    PlanPath: 'default.json',
  });
  expect(result).toEqual([]);
});
```

**Test B** — "does not flag a second duplicate for vars conflict (seen set short-circuits)" (line ~192): remove the vars conflict from the comment and update the count from 2 to 1:

```typescript
it('flags only the duplicate error for repeated output names even when input name matches', () => {
  // Both entries share a name with an input. First entry: no error (input overlap allowed).
  // Second entry: duplicate error only.
  const result = validateOutputsDeclarations([{ name: 'PlanPath' }, { name: 'PlanPath' }], {
    PlanPath: 'default.json',
  });
  expect(result).toHaveLength(1);
  expect(result[0].message.toLowerCase()).toContain('duplicate');
});
```

- [ ] **Step 6: Run the full validate-frontmatter-vars test suite**

```bash
cd packages/cli && npx jest --testPathPattern="validate-frontmatter-vars"
```

Expected: all pass.

- [ ] **Step 7: Run the full cli test suite to check for regressions**

```bash
cd packages/cli && npm test
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/helpers/validate-frontmatter-vars.ts packages/cli/__tests__/helpers/validate-frontmatter-vars.test.ts
git commit -m "fix(cli): allow frontmatter outputs to reference existing inputs"
```

---

## Task 4: Surface SET_VARIABLES failure in delegation-completion

**Files:**
- Modify: `packages/cli/src/helpers/delegation-completion.ts:197-203`
- Modify: `packages/cli/__tests__/helpers/delegation-completion.test.ts`

When forwarding child `finalVars` to the parent actor via `SET_VARIABLES`, a failure is silently logged at `warn` level and execution continues. The parent then drains completions without the child's variables — corrupting the execution context. At minimum the failure must be surfaced to the CLI user via `output.warning(...)`.

- [ ] **Step 1: Write a failing test for the SET_VARIABLES failure path**

Find the `describe` block containing "forwards child finalVars to parent actor via SET_VARIABLES before drain" in `packages/cli/__tests__/helpers/delegation-completion.test.ts`.

Add after that test:

```typescript
it('surfaces a warning to output when SET_VARIABLES fails', async () => {
  const delegation = makeDelegationLinkage();
  const childState = makeState('child-run-id', {
    parentLinkage: delegation,
    finalVars: { PlanPath: '/work/plan.json' },
  });
  const parentState = makeState('parent-run-id', {
    substepStates: [{ id: '1', frameKey: '1|', status: 'pending', delegation: null }],
  });

  const states = new Map([[parentState.id, parentState]]);
  const manager = makeManager(states);
  const _lock = makeLock();
  const lifecycleService = makeLifecycleService();
  const output = makeOutput();

  // Override the actor mock so sendAndSync throws for this test
  const MockActor = core.RunbookActorService as jest.MockedClass<typeof core.RunbookActorService>;
  MockActor.mockImplementation(
    () =>
      ({
        sendAndSync: jest.fn<any>().mockRejectedValue(new Error('machine rejected event')),
      }) as any,
  );

  (core.RunbookStateManager as jest.Mock).mockImplementation(() => manager);
  (core.ExecutionLifecycleService as jest.Mock).mockImplementation(() => makeLifecycleService());
  (core.SessionService as jest.Mock).mockImplementation(() => ({
    popRunbook: jest.fn().mockResolvedValue(null),
  }));

  (drainResolvedCompletions as jest.Mock).mockResolvedValue({
    status: 'continue',
    applied: 0,
    state: parentState,
  });

  await handleParentCompletion(childState, 'pass', '/test', output);

  expect(output.warning).toHaveBeenCalledWith(expect.stringContaining('SET_VARIABLES'));
});
```

- [ ] **Step 2: Run the new test to confirm it fails**

```bash
cd packages/cli && npx jest --testPathPattern="delegation-completion" -t "surfaces a warning to output when SET_VARIABLES fails"
```

Expected: FAIL — `output.warning` was not called.

- [ ] **Step 3: Add `output.warning` call to the catch block**

In `packages/cli/src/helpers/delegation-completion.ts`, change lines 197-203 from:

```typescript
    } catch (err) {
      void logger.warn('delegation-completion: failed to forward child finalVars to parent actor', {
        error: getErrorMessage(err),
        childRunId: childState.id,
        parentRunId,
      });
    }
```

to:

```typescript
    } catch (err) {
      const errMsg = getErrorMessage(err);
      void logger.warn('delegation-completion: failed to forward child finalVars to parent actor', {
        error: errMsg,
        childRunId: childState.id,
        parentRunId,
      });
      output.warning(
        `SET_VARIABLES failed — child variables not forwarded to parent run. ${errMsg}`,
      );
    }
```

- [ ] **Step 4: Run the new test to confirm it passes**

```bash
cd packages/cli && npx jest --testPathPattern="delegation-completion" -t "surfaces a warning to output when SET_VARIABLES fails"
```

Expected: PASS.

- [ ] **Step 5: Run the full delegation-completion test suite**

```bash
cd packages/cli && npx jest --testPathPattern="delegation-completion"
```

Expected: all pass.

- [ ] **Step 6: Run the full cli test suite to check for regressions**

```bash
cd packages/cli && npm test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/helpers/delegation-completion.ts packages/cli/__tests__/helpers/delegation-completion.test.ts
git commit -m "fix(cli): surface SET_VARIABLES failure to CLI user in delegation-completion"
```

---

## Final Verification

- [ ] **Step 1: Run the full verify script**

```bash
npm run verify
```

Expected: format, spell, lint (including `lint-typed`), and tests all pass.

- [ ] **Step 2: Run integration tests**

```bash
npm run test:integration
```

Expected: all pass.

---

## Self-Review

**Spec coverage:**

| Issue | Task |
|-------|------|
| Dead `=== null` in evaluateFrontmatterOutputs | Task 1 |
| Test mock shape for `inputs:` (array vs Record) | Task 2 |
| validateOutputsDeclarations rejects inputs overlap | Task 3 |
| Silent SET_VARIABLES failure in delegation-completion | Task 4 |
| Dismissed: stopped test correct | noted above |
| Dismissed: shellQuote key names safe | noted above |

**Placeholder scan:** No TBDs, no "handle edge cases", no "similar to" references. All code blocks are complete and copy-pasteable.

**Type consistency:** `validateFrontmatterVars` and `validateOutputsDeclarations` use `Record<string, string | number | boolean>` consistently. `evaluateFrontmatterOutputs` parameter type is `Readonly<StepVariables>` which excludes null — the fix aligns the runtime guard with the type.
