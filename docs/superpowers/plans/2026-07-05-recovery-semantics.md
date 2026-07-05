# Recovery Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make command-step infrastructure failures recoverable in delegated runs, without collapsing policy denial, command execution failure, or timeout/tool errors into delegated `fail`.

**Architecture:** Command execution remains machine-owned Category C: core invokes typed command actors and frontends supply runtime callables. Delegation propagation must project terminal children through core-owned semantics that inspect `lastAction`, not just `lifecycle`. Retry and abort cleanup for linked terminal children must run through core seams or core helpers, with the CLI only rendering outcomes and performing CLI-owned process/session effects.

**Tech Stack:** TypeScript, XState, Jest, pnpm workspace packages `@rundown-org/core` and `@rundown-org/cli`.

---

## Current Status

#545, #547, and #520 are still open after the sandbox/policy coherence work. Main already contains these partial fixes:

- `packages/core/src/runbook/actors/command-exec-actor.ts` returns `kind: 'policy_denied'` for policy denial.
- `packages/core/src/runbook/compiler.ts` writes `POLICY_DENIED` and `COMMAND_EXECUTION_FAILED` last actions.
- `packages/core/src/runbook/actor-service.ts` clears `lastResult` for those command infrastructure stops.

The remaining defect is projection and recovery:

- `packages/core/src/runbook/completion-service.ts` still maps any stopped child to delegated `fail` through `lifecycleToDelegationOutcome`.
- CLI call sites still pass `child.lifecycle === 'completed' ? 'pass' : 'fail'` into `propagateChildTerminal`.
- `delegate --retry` still refuses linked children unless the machine retry hook sets `allowLinkedChildRun`.
- `abort --force` still refuses already-resolved linked children before it can clean up.

## Files

Core:

- Modify: `packages/core/src/runbook/completion-service.ts`
- Modify: `packages/core/src/runbook/collection-service.ts`
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts`
- Modify: `packages/core/src/runbook/delegation-service.ts`
- Modify: `packages/core/src/runbook/index.ts` if new helpers need public package export

Core tests:

- Modify: `packages/core/__tests__/runbook/completion-service.test.ts`
- Create: `packages/core/__tests__/runbook/completion-service.properties.test.ts`
- Modify: `packages/core/__tests__/runbook/collection-service.test.ts`
- Modify: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`
- Modify: `packages/core/__tests__/runbook/delegation-service.test.ts`
- Modify: `packages/core/__tests__/runbook/compiler-command-exec.test.ts`
- Modify: `packages/core/__tests__/runbook/actor-service.test.ts`

CLI:

- Modify: `packages/cli/src/helpers/delegation-completion.ts`
- Modify: `packages/cli/src/helpers/transition-command.ts`
- Modify: `packages/cli/src/commands/claim.ts`
- Modify: `packages/cli/src/commands/run.ts`
- Modify: `packages/cli/src/commands/collect.ts`
- Modify: `packages/cli/src/services/execution.ts`
- Modify: `packages/cli/src/commands/abort.ts`

CLI tests:

- Modify: `packages/cli/__tests__/helpers/delegation-completion.test.ts`
- Modify: `packages/cli/__tests__/services/execution-loop.test.ts`
- Modify: `packages/cli/__tests__/integration/delegate-workflow.test.ts`
- Modify: `packages/cli/__tests__/integration/delegation-abort.test.ts`
- Create: `packages/cli/__tests__/integration/recovery-semantics.test.ts`

Docs:

- Modify: `docs/internal/architecture.md`
- Modify: `docs/reference/cli.md` only where retry/abort text contradicts the new behavior

---

### Task 1: Core Terminal Projection

**Files:**

- Modify: `packages/core/src/runbook/completion-service.ts`
- Modify: `packages/core/src/runbook/collection-service.ts`
- Modify: `packages/core/src/runbook/index.ts`
- Modify: `packages/core/__tests__/runbook/completion-service.test.ts`
- Modify: `packages/core/__tests__/runbook/collection-service.test.ts`
- Create: `packages/core/__tests__/runbook/completion-service.properties.test.ts`

- [ ] **Step 1: Add failing projection tests**

Append these tests near the existing `lifecycleToDelegationOutcome` test in `packages/core/__tests__/runbook/completion-service.test.ts`.

```typescript
import {
  assertDelegationTokenHash,
  lifecycleToDelegationOutcome,
  projectDelegationTerminalOutcome,
  RunbookActorService,
  RunbookCompletionService,
  RunbookStateManager,
  type RunbookState,
  type ResolvedStep,
} from '../../src/runbook/index.js';

describe('projectDelegationTerminalOutcome', () => {
  it('projects completed children as delegated pass', () => {
    expect(projectDelegationTerminalOutcome(state({ lifecycle: 'completed' }))).toEqual({
      kind: 'outcome',
      result: 'pass',
    });
  });

  it('projects ordinary stopped children as delegated fail', () => {
    expect(
      projectDelegationTerminalOutcome(
        state({
          lifecycle: 'stopped',
          lastAction: { type: 'STOP', origin: 'direct' },
        }),
      ),
    ).toEqual({ kind: 'outcome', result: 'fail' });
  });

  it('does not project POLICY_DENIED as delegated fail', () => {
    expect(
      projectDelegationTerminalOutcome(
        state({
          lifecycle: 'stopped',
          lastAction: {
            type: 'POLICY_DENIED',
            origin: 'direct',
            message: 'blocked by policy',
          },
        }),
      ),
    ).toEqual({
      kind: 'command_infrastructure',
      reason: 'policy_denied',
      message: 'blocked by policy',
    });
  });

  it('does not project COMMAND_EXECUTION_FAILED as delegated fail', () => {
    expect(
      projectDelegationTerminalOutcome(
        state({
          lifecycle: 'stopped',
          lastAction: {
            type: 'COMMAND_EXECUTION_FAILED',
            origin: 'direct',
            message: 'Timeout of 30000 ms exceeded',
          },
        }),
      ),
    ).toEqual({
      kind: 'command_infrastructure',
      reason: 'command_execution_failed',
      message: 'Timeout of 30000 ms exceeded',
    });
  });

  it('lets explicit operator results override infrastructure projection', () => {
    expect(
      projectDelegationTerminalOutcome(
        state({
          lifecycle: 'stopped',
          lastAction: {
            type: 'POLICY_DENIED',
            origin: 'direct',
            message: 'blocked by policy',
          },
        }),
        'fail',
      ),
    ).toEqual({ kind: 'outcome', result: 'fail' });
  });
});
```

- [ ] **Step 2: Add failing child-recording tests**

Add these cases inside `describe('child recording', ...)`.

```typescript
it('does not record delegated fail for an inferred policy-denied terminal child', async () => {
  const parent = makeParentWithDelegation();
  await manager.save(parent);
  const child = makeChildWithDelegationLinkage();

  const result = await service.recordChildCompletion({
    childState: {
      ...child,
      lifecycle: 'stopped',
      lastAction: {
        type: 'POLICY_DENIED',
        origin: 'direct',
        message: 'blocked by policy',
      },
    },
  });

  expect(result).toBe('blocked');
  const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
  await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toBeNull();
});

it('does not record delegated fail for an inferred command execution failure child', async () => {
  const parent = makeParentWithDelegation();
  await manager.save(parent);
  const child = makeChildWithDelegationLinkage();

  const result = await service.recordChildCompletion({
    childState: {
      ...child,
      lifecycle: 'stopped',
      lastAction: {
        type: 'COMMAND_EXECUTION_FAILED',
        origin: 'direct',
        message: 'Timeout of 30000 ms exceeded',
      },
    },
  });

  expect(result).toBe('blocked');
  const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
  await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toBeNull();
});

it('still records explicit fail for policy-denied children when a caller forces fail', async () => {
  const parent = makeParentWithDelegation();
  await manager.save(parent);
  const child = makeChildWithDelegationLinkage();

  const result = await service.recordChildCompletion({
    childState: {
      ...child,
      lifecycle: 'stopped',
      lastAction: {
        type: 'POLICY_DENIED',
        origin: 'direct',
        message: 'blocked by policy',
      },
    },
    result: 'fail',
  });

  expect(result).toBe('recorded');
  const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
  await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toEqual(
    expect.objectContaining({ result: 'fail', agentId: 'delegation' }),
  );
});
```

- [ ] **Step 3: Run the focused failing test**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --no-cache --runTestsByPath __tests__/runbook/completion-service.test.ts
```

Expected: fail because `projectDelegationTerminalOutcome` and `blocked` do not exist.

- [ ] **Step 4: Implement the projection helper**

In `packages/core/src/runbook/completion-service.ts`, import the existing
terminal classification helpers so this projection does not duplicate
`lastAction.type` classification.

```typescript
import {
  deriveStoppedReason,
  extractInternalFailureMessage,
} from './transition-kernel.js';
```

Then add this export near `lifecycleToDelegationOutcome`.

```typescript
export type DelegationTerminalProjection =
  | { readonly kind: 'outcome'; readonly result: DelegationOutcome }
  | {
      readonly kind: 'command_infrastructure';
      readonly reason: 'policy_denied' | 'command_execution_failed';
      readonly message: string;
    }
  | { readonly kind: 'not_terminal' };

export function projectDelegationTerminalOutcome(
  childState: RunbookState,
  explicitResult?: DelegationOutcome,
): DelegationTerminalProjection {
  if (explicitResult !== undefined) {
    return { kind: 'outcome', result: explicitResult };
  }
  if (childState.lifecycle === 'completed') {
    return { kind: 'outcome', result: 'pass' };
  }
  if (childState.lifecycle !== 'stopped') {
    return { kind: 'not_terminal' };
  }

  const stoppedReason = deriveStoppedReason(childState.lastAction);
  if (stoppedReason === 'policy_denied' || stoppedReason === 'command_execution_failed') {
    const message =
      extractInternalFailureMessage(childState.lastAction) ??
      (childState.lastAction && 'message' in childState.lastAction
        ? String(childState.lastAction.message)
        : stoppedReason);
    return {
      kind: 'command_infrastructure',
      reason: stoppedReason,
      message,
    };
  }

  return { kind: 'outcome', result: 'fail' };
}
```

Update the `recordChildCompletion` return type docs and union to include `'blocked'`.

```typescript
async recordChildCompletion(
  args: RecordChildCompletionArgs,
): Promise<'recorded' | 'duplicate' | 'not-applicable' | 'cancelled' | 'blocked'> {
```

Make the same return-type change on `recordChildCompletionUnlocked`.

- [ ] **Step 5: Use the projection helper in child recording**

Replace this line in `recordChildCompletionUnlocked`.

```typescript
const result = args.result ?? lifecycleToDelegationOutcome(args.childState.lifecycle);
if (!result) return 'not-applicable';
```

with:

```typescript
const projection = projectDelegationTerminalOutcome(args.childState, args.result);
if (projection.kind === 'not_terminal') return 'not-applicable';
if (projection.kind === 'command_infrastructure') return 'blocked';
const result = projection.result;
```

- [ ] **Step 6: Use inferred projection in collection reporting**

In `packages/core/src/runbook/collection-service.ts`, stop forcing a lifecycle
result before calling `recordChildCompletion`. Replace the body after the
delegation linkage guard.

```typescript
const recorded = await input.completionService.recordChildCompletion({
  childState: terminalState,
});
return recorded === 'recorded';
```

Do not pass `result` from `lifecycleToDelegationOutcome` in this path. Collection
is observing a terminal child, not recording an explicit operator result, so the
projection helper must decide whether the terminal is an authored outcome or a
command-infrastructure stop.

- [ ] **Step 7: Add core collection-path regression**

In `packages/core/__tests__/runbook/collection-service.test.ts`, add a test for
the collection path that terminally observes a delegation-linked child with:

```typescript
lastAction: {
  type: 'POLICY_DENIED',
  origin: 'direct',
  message: 'blocked by policy',
}
```

The assertions must prove that collection does not create a delegated `fail`
row:

```typescript
expect(recorded).toBe(false);
await expect(lifecycleService.getResolvedCompletion(parentRunId, expectedKey)).resolves.toBeNull();
```

Use the existing collection-service fixtures in that file to compute
`parentRunId`, `expectedKey`, and to call the helper that reports terminal
delegation outcomes; do not create a second state-manager abstraction.

- [ ] **Step 8: Add projection property tests**

Create `packages/core/__tests__/runbook/completion-service.properties.test.ts`.

```typescript
import fc from 'fast-check';
import {
  projectDelegationTerminalOutcome,
  type RunbookState,
} from '../../src/runbook/index.js';

const terminalInfrastructureAction = fc.constantFrom(
  {
    type: 'POLICY_DENIED' as const,
    origin: 'direct' as const,
    message: 'blocked by policy',
  },
  {
    type: 'COMMAND_EXECUTION_FAILED' as const,
    origin: 'direct' as const,
    message: 'Timeout of 30000 ms exceeded',
  },
);

function state(overrides: Partial<RunbookState>): RunbookState {
  return {
    id: 'rd_property000000000000000000000000' as RunbookState['id'],
    runbookPath: 'property.runbook.md',
    runbookSrc: '# Property\n\n## 1. Step\n',
    step: '1',
    lifecycle: 'running',
    variables: {} as RunbookState['variables'],
    startedAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  } as RunbookState;
}

describe('projectDelegationTerminalOutcome properties', () => {
  it('never infers delegated fail for command infrastructure stopped states', () => {
    fc.assert(
      fc.property(terminalInfrastructureAction, (lastAction) => {
        expect(
          projectDelegationTerminalOutcome(state({ lifecycle: 'stopped', lastAction })),
        ).toEqual(
          expect.objectContaining({
            kind: 'command_infrastructure',
          }),
        );
      }),
    );
  });

  it('always lets explicit operator results override inferred infrastructure state', () => {
    fc.assert(
      fc.property(
        terminalInfrastructureAction,
        fc.constantFrom<'pass' | 'fail'>('pass', 'fail'),
        (lastAction, explicitResult) => {
          expect(
            projectDelegationTerminalOutcome(
              state({ lifecycle: 'stopped', lastAction }),
              explicitResult,
            ),
          ).toEqual({ kind: 'outcome', result: explicitResult });
        },
      ),
    );
  });
});
```

- [ ] **Step 9: Export the helper**

In `packages/core/src/runbook/index.ts`, export the new type and function from `completion-service.ts` beside the existing completion exports.

- [ ] **Step 10: Run the focused passing tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --no-cache --runTestsByPath __tests__/runbook/completion-service.test.ts __tests__/runbook/collection-service.test.ts
pnpm --filter @rundown-org/core test:property -- --runTestsByPath __tests__/runbook/completion-service.properties.test.ts
```

Expected: pass.

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/runbook/completion-service.ts packages/core/src/runbook/collection-service.ts packages/core/src/runbook/index.ts packages/core/__tests__/runbook/completion-service.test.ts packages/core/__tests__/runbook/collection-service.test.ts packages/core/__tests__/runbook/completion-service.properties.test.ts
git commit -m "fix(core): project command infrastructure child terminals"
```

### Task 2: Shared Delegation Outcome Supersession

**Files:**

- Modify: `packages/core/src/runbook/completion-service.ts`
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts`
- Modify: `packages/core/__tests__/runbook/completion-service.test.ts`
- Modify: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`

- [ ] **Step 1: Add a focused completion-service test**

Add this under `describe('child recording', ...)` or a new `describe('delegation outcome supersession', ...)` in `packages/core/__tests__/runbook/completion-service.test.ts`.

```typescript
it('supersedes a pending delegation outcome for one substep without touching siblings', async () => {
  const current = state();
  const frameKey = buildFrameKey('1');
  const key1 = buildCompletionKey(activeFrame(frameKey, 1), '1');
  const key2 = buildCompletionKey(activeFrame(frameKey, 1), '2');
  await manager.save({
    ...current,
    resolvedCompletions: {
      [key1]: buildResolvedCompletion({
        agentId: 'delegation',
        result: 'fail',
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(frameKey, 1),
      }),
      [key2]: buildResolvedCompletion({
        agentId: 'delegation',
        result: 'pass',
        targetStep: '1',
        targetSubstep: '2',
        targetFrame: activeFrame(frameKey, 1),
      }),
    },
  });

  const removed = await service.supersedeDelegationOutcomeUnlocked({
    runbookId,
    frameKey,
    substepId: '1',
  });

  expect(removed).toBe(1);
  await expect(lifecycleService.getResolvedCompletion(runbookId, key1)).resolves.toBeNull();
  await expect(lifecycleService.getResolvedCompletion(runbookId, key2)).resolves.not.toBeNull();
});
```

- [ ] **Step 2: Run the focused failing test**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --no-cache --runTestsByPath __tests__/runbook/completion-service.test.ts
```

Expected: fail because `supersedeDelegationOutcomeUnlocked` does not exist.

- [ ] **Step 3: Implement `supersedeDelegationOutcomeUnlocked`**

Add this method to `RunbookCompletionService`. The `Unlocked` suffix is part of
the API contract: this helper performs list-then-consume writes and must only be
called by code that already owns the parent run's `DelegationLock`, or by tests
that do not run concurrent collection.

```typescript
/**
 * Consume stale delegated outcome rows for a substep.
 *
 * Caller must already hold the parent run's DelegationLock. This method is
 * intentionally unlocked because retry and force-abort cleanup already execute
 * inside that lock and a second acquisition would deadlock.
 *
 * @param args - Parent run id, frame, and substep whose delegated rows are stale.
 * @returns Number of rows consumed.
 */
async supersedeDelegationOutcomeUnlocked(args: {
  readonly runbookId: RunId;
  readonly frameKey: FrameKey;
  readonly substepId: string;
}): Promise<number> {
  const rows = await this.lifecycleService.listResolvedCompletionsForFrameObservation(
    args.runbookId,
    args.frameKey,
  );
  let removed = 0;
  for (const { key, completion } of rows) {
    if (completion.targetSubstep === args.substepId && completion.agentId === 'delegation') {
      const consumed = await this.lifecycleService.consumeResolvedCompletion(args.runbookId, key);
      if (consumed) removed += 1;
    }
  }
  return removed;
}
```

Use the class's actual private field names. In the current file, the constructor
stores `lifecycleService`, so do not invent a new dependency. Do not export a
locking wrapper unless a later task needs one.

- [ ] **Step 4: Replace lifecycle-command-service's private duplicate**

In `packages/core/src/runbook/lifecycle-command-service.ts`, replace `#supersedePendingOutcome` internals with a call to the completion service.

```typescript
async #supersedePendingOutcome(
  runId: RunId,
  frameKey: FrameKey,
  substepId: string,
): Promise<void> {
  await this.#deps.completionService.supersedeDelegationOutcomeUnlocked({
    runbookId: runId,
    frameKey,
    substepId,
  });
}
```

- [ ] **Step 5: Run lifecycle seam tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --no-cache --runTestsByPath __tests__/runbook/completion-service.test.ts __tests__/runbook/lifecycle-command-service.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/completion-service.ts packages/core/src/runbook/lifecycle-command-service.ts packages/core/__tests__/runbook/completion-service.test.ts packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "refactor(core): share delegation outcome supersession"
```

### Task 3: CLI Propagation Uses Core Projection

**Files:**

- Modify: `packages/cli/src/helpers/delegation-completion.ts`
- Modify: `packages/cli/src/helpers/transition-command.ts`
- Modify: `packages/cli/src/commands/claim.ts`
- Modify: `packages/cli/src/commands/run.ts`
- Modify: `packages/cli/src/commands/collect.ts`
- Modify: `packages/cli/src/services/execution.ts`
- Modify: `packages/cli/__tests__/helpers/delegation-completion.test.ts`

- [ ] **Step 1: Add a controllable mocked core projection export**

In `packages/cli/__tests__/helpers/delegation-completion.test.ts`, add this to the `jest.unstable_mockModule('@rundown-org/core', ...)` object.

```typescript
projectDelegationTerminalOutcome: mockProjectDelegationTerminalOutcome,
```

Define the mock beside the other top-level helper mocks, and set it explicitly in
each test rather than reimplementing core's `lastAction.type` classifier in the
CLI test file.

```typescript
const mockProjectDelegationTerminalOutcome = jest.fn(
  (_childState: RunbookState, explicitResult?: 'pass' | 'fail') =>
    explicitResult === undefined
      ? { kind: 'not_terminal' as const }
      : { kind: 'outcome' as const, result: explicitResult },
);
```

- [ ] **Step 2: Add failing helper tests**

Add these tests under `describe('reportTerminalToDelegatingRun', ...)`.

```typescript
it('blocks report-only propagation for policy-denied child terminals', async () => {
  const childState = makeState(CHILD_RUN_ID, {
    lifecycle: 'stopped',
    parentLinkage: makeDelegationLinkage(),
    lastAction: {
      type: 'POLICY_DENIED',
      origin: 'direct',
      message: 'blocked by policy',
    },
  });
  const manager = makeManager(new Map());
  const output = makeOutput();
  const recordChildCompletion = wireMocks(manager, makeLifecycleService());
  mockProjectDelegationTerminalOutcome.mockReturnValueOnce({
    kind: 'command_infrastructure',
    reason: 'policy_denied',
    message: 'blocked by policy',
  });

  const result = await reportTerminalToDelegatingRun(childState, undefined, '/test', output);

  expect(result).toBe('blocked');
  expect(recordChildCompletion).not.toHaveBeenCalled();
  expect(output.flush).toHaveBeenCalled();
});

it('blocks report-only propagation for command execution failures', async () => {
  const childState = makeState(CHILD_RUN_ID, {
    lifecycle: 'stopped',
    parentLinkage: makeDelegationLinkage(),
    lastAction: {
      type: 'COMMAND_EXECUTION_FAILED',
      origin: 'direct',
      message: 'Timeout of 30000 ms exceeded',
    },
  });
  const manager = makeManager(new Map());
  const output = makeOutput();
  const recordChildCompletion = wireMocks(manager, makeLifecycleService());
  mockProjectDelegationTerminalOutcome.mockReturnValueOnce({
    kind: 'command_infrastructure',
    reason: 'command_execution_failed',
    message: 'Timeout of 30000 ms exceeded',
  });

  const result = await reportTerminalToDelegatingRun(childState, undefined, '/test', output);

  expect(result).toBe('blocked');
  expect(recordChildCompletion).not.toHaveBeenCalled();
  expect(output.flush).toHaveBeenCalled();
});

it('still records explicit fail when the caller supplies fail', async () => {
  const childState = makeState(CHILD_RUN_ID, {
    lifecycle: 'stopped',
    parentLinkage: makeDelegationLinkage(),
    lastAction: {
      type: 'POLICY_DENIED',
      origin: 'direct',
      message: 'blocked by policy',
    },
  });
  const manager = makeManager(new Map());
  const output = makeOutput();
  const recordChildCompletion = wireMocks(manager, makeLifecycleService());
  mockProjectDelegationTerminalOutcome.mockReturnValueOnce({ kind: 'outcome', result: 'fail' });

  const result = await reportTerminalToDelegatingRun(childState, 'fail', '/test', output);

  expect(result).toBe('reported');
  expect(recordChildCompletion).toHaveBeenCalledWith({ childState, result: 'fail' });
});
```

- [ ] **Step 3: Run the focused failing helper test**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- --no-cache --runTestsByPath __tests__/helpers/delegation-completion.test.ts
```

Expected: fail because helper signatures require `result` and do not return `blocked`.

- [ ] **Step 4: Update helper signatures and projection logic**

In `packages/cli/src/helpers/delegation-completion.ts`, import the core helper.

```typescript
import {
  RunbookStateManager,
  ExecutionLifecycleService,
  RunbookCompletionService,
  projectDelegationTerminalOutcome,
  type RunbookState,
  type ParentLinkage,
} from '@rundown-org/core';
```

Add a shared result type.

```typescript
export type TerminalPropagationResult =
  | 'reported'
  | 'handled'
  | 'stopped'
  | 'blocked'
  | 'not-applicable';
```

Change the result parameter in `reportTerminalToDelegatingRun`, `advanceParentForInlineChild`, and `propagateChildTerminal` to optional.

```typescript
result?: 'pass' | 'fail'
```

At the top of `reportTerminalToDelegatingRun`, after the linkage guard, add:

```typescript
const projection = projectDelegationTerminalOutcome(childState, result);
if (projection.kind === 'not_terminal') return 'not-applicable';
if (projection.kind === 'command_infrastructure') {
  output.flush();
  return 'blocked';
}
```

Then change the record call to:

```typescript
const recorded = await completionService.recordChildCompletion({
  childState,
  result: projection.result,
});
if (recorded === 'blocked') {
  output.flush();
  return 'blocked';
}
```

Apply the same projection guard in `advanceParentForInlineChild` before recording. Use `projection.result` for transition config selection and all downstream parent propagation.

- [ ] **Step 5: Remove inferred stopped-to-fail mappings from lifecycle callers**

Make these call-site edits:

```typescript
// packages/cli/src/commands/claim.ts
await propagateChildTerminal(childState, undefined, cwd, output);

// packages/cli/src/commands/run.ts
const propOutcome = await propagateChildTerminal(childState, undefined, cwd, output);

// packages/cli/src/commands/collect.ts
const propagation = await propagateChildTerminal(terminal, undefined, cwd, output);

// packages/cli/src/services/execution.ts
const propagated = await propagateChildTerminal(childState, undefined, cwd, output);
```

In `packages/cli/src/helpers/transition-command.ts`, keep explicit user result
paths explicit. Replace the lifecycle-derived propagation result:

```typescript
const propResult = freshState.lifecycle === 'completed' ? 'pass' : 'fail';
const propagation = await propagateChildTerminal(freshState, propResult, cwd, output);
```

with the command result selected by the user:

```typescript
const propagation = await propagateChildTerminal(freshState, def.name, cwd, output);
```

This preserves the RESULT / HANDLER / ACTION split: an explicit `rundown pass`
still reports delegated `pass` even when the PASS handler stops the child.

- [ ] **Step 6: Handle `blocked` at call sites**

Where call sites branch on `propagation === 'stopped'`, leave `blocked` as a terminal child failure for the child command's exit code, but do not treat it as parent STOP:

```typescript
if (linkage.kind === 'inline') {
  shouldExitWithError = propagation === 'stopped' || propagation === 'blocked';
} else if (propagation === 'stopped') {
  shouldExitWithError = true;
}
```

For delegation report-only paths, `blocked` should leave the parent unadvanced and without a resolved completion row.

- [ ] **Step 7: Run helper tests**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- --no-cache --runTestsByPath __tests__/helpers/delegation-completion.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/helpers/delegation-completion.ts packages/cli/src/helpers/transition-command.ts packages/cli/src/commands/claim.ts packages/cli/src/commands/run.ts packages/cli/src/commands/collect.ts packages/cli/src/services/execution.ts packages/cli/__tests__/helpers/delegation-completion.test.ts
git commit -m "fix(cli): do not infer delegated fail from command infrastructure stops"
```

### Task 4: Retry Over Terminal Linked Children

**Files:**

- Modify: `packages/core/src/runbook/lifecycle-command-service.ts`
- Modify: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`
- Modify: `packages/cli/__tests__/integration/delegate-workflow.test.ts`

- [ ] **Step 1: Add core retry tests**

Add these tests under `describe('issueDelegation (retry)', ...)` in `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`.

```typescript
it('retries a linked terminal child without orphaning an active child', async () => {
  const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
  const first = await localSeam.issueDelegation({
    mode: 'fresh',
    callerEvidence: { kind: 'run_controller', runId },
  });
  if (first.kind !== 'delegated') throw new Error('expected delegated');

  const childRunId = assertRunId('rd_33333333333333333333333333333333');
  await mgr.updateWithState(state.id, (current) => ({
    substepStates: (current.substepStates ?? []).map((entry) =>
      entry.delegation?.token === first.token
        ? {
            ...entry,
            status: 'done',
            result: 'fail',
            delegation: { ...entry.delegation, token: undefined, childRunId },
          }
        : entry,
    ),
  }));
  await mgr.save(
    baseState({
      id: childRunId,
      lifecycle: 'stopped',
      parentLinkage: linkageFor(state.id, '1'),
      lastAction: {
        type: 'POLICY_DENIED',
        origin: 'direct',
        message: 'blocked by policy',
      },
    }),
  );
  await mgr.update(state.id, {
    resolvedCompletions: {
      [keyForSubstep('1')]: buildResolvedCompletion({
        agentId: 'delegation',
        result: 'fail',
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        completedAt: '2026-07-05T00:00:00.000Z',
      }),
      [keyForSubstep('2')]: buildResolvedCompletion({
        agentId: 'delegation',
        result: 'pass',
        targetStep: '1',
        targetSubstep: '2',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        completedAt: '2026-07-05T00:00:00.000Z',
      }),
    },
  });
  const releaseSpy = jest.spyOn(deps.sessionService, 'releaseRunbook');

  const retried = await localSeam.issueDelegation({
    mode: 'retry',
    callerEvidence: { kind: 'run_controller', runId },
    locator: { kind: 'step', step: first.stepId },
  });

  expect(retried.kind).toBe('retried');
  expect(releaseSpy).toHaveBeenCalledWith(childRunId);
  const persisted = await mgr.load(state.id);
  const entry = persisted?.substepStates?.find((s) => s.id === '1');
  expect(entry?.delegation?.childRunId).toBeNull();
  expect(entry?.delegation?.tokenHash).not.toBe(first.tokenHash);
  await expect(deps.lifecycleService.getResolvedCompletion(state.id, keyForSubstep('1'))).resolves.toBeNull();
  await expect(deps.lifecycleService.getResolvedCompletion(state.id, keyForSubstep('2'))).resolves.not.toBeNull();
});

it('continues to refuse retry over a running linked child', async () => {
  const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
  const first = await localSeam.issueDelegation({
    mode: 'fresh',
    callerEvidence: { kind: 'run_controller', runId },
  });
  if (first.kind !== 'delegated') throw new Error('expected delegated');

  const childRunId = assertRunId('rd_44444444444444444444444444444444');
  deps.delegationLock = {
    acquire: async () => {
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation?.token === first.token
            ? {
                ...entry,
                delegation: { ...entry.delegation, token: undefined, childRunId },
              }
            : entry,
        ),
      }));
      await mgr.save(baseState({ id: childRunId, lifecycle: 'running' }));
    },
    release: async () => {},
  };

  const outcome = await localSeam.issueDelegation({
    mode: 'retry',
    callerEvidence: { kind: 'run_controller', runId },
    locator: { kind: 'step', step: first.stepId },
  });

  expect(outcome.kind).toBe('error');
  if (outcome.kind !== 'error') throw new Error('expected error');
  expect(outcome.error.code).toBe('RD-823');
});
```

`baseState()` is already defined in `lifecycle-command-service.test.ts`, and
`linkageFor()` is already imported from `claim-test-helpers.ts`; use those
fixtures exactly as shown. Define `keyForSubstep(substepId)` in the test from
`buildCompletionKey(activeFrame(buildFrameKey('1'), 1), substepId)` if the file
does not already expose that fixture. The test intent is fixed: terminal linked
child succeeds, stale outcome for the retried substep is removed, sibling
outcomes remain, and running linked child still returns RD-823.

- [ ] **Step 2: Run the focused failing core test**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --no-cache --runTestsByPath __tests__/runbook/lifecycle-command-service.test.ts
```

Expected: the terminal-linked retry still fails with RD-823.

- [ ] **Step 3: Implement terminal linked-child classification**

In `#issueRetry()` in `packages/core/src/runbook/lifecycle-command-service.ts`, after the locked re-read and before `retryDelegation`, classify the linked child on the fresh target substep.

```typescript
const targetSubstep = freshState.substepStates?.find(
  (entry) => entry.id === substepId && entry.frameKey === frameKey,
);
const linkedChildRunId = targetSubstep?.delegation?.childRunId ?? null;
const linkedChild = linkedChildRunId ? await this.#deps.loadRun(linkedChildRunId) : undefined;
const linkedChildActive = linkedChild?.lifecycle === 'running';
const linkedChildTerminal =
  linkedChild?.lifecycle === 'completed' || linkedChild?.lifecycle === 'stopped';
const allowLinkedChildRun = linkedChildTerminal;
```

Do not allow retry merely because a resolved delegation outcome exists while
the linked child state is missing. A missing linked child state remains
fail-closed/corrupt unless a later task adds an explicit, tested recovery path.

Add a private helper using the completion service's observation list for
supersession only; it must not be part of the `allowLinkedChildRun` predicate.

```typescript
async #hasDelegationOutcome(
  runId: RunId,
  frameKey: FrameKey,
  substepId: string,
): Promise<boolean> {
  const rows =
    await this.#deps.lifecycleService.listResolvedCompletionsForFrameObservation(runId, frameKey);
  return rows.some(
    ({ completion }) =>
      completion.agentId === 'delegation' && completion.targetSubstep === substepId,
  );
}
```

Pass the flag into `retryDelegation`.

```typescript
const result = retryDelegation(
  {
    state: freshState,
    substepId,
    frameKey,
    allowLinkedChildRun,
    ...(overrides ? { overrides } : {}),
  },
  steps,
);
```

After a successful retry, remove the stale claim record for the old child without deleting the diagnostic child run state.

```typescript
if (result.status === 'retried' && linkedChildRunId && allowLinkedChildRun) {
  await this.#deps.sessionService.releaseRunbook(linkedChildRunId);
}
```

Do not pass `{ retainClaimsAsTerminal: true }` here. Retry supersedes the old claim.

- [ ] **Step 4: Update integration expectations**

In `packages/cli/__tests__/integration/delegate-workflow.test.ts`, update the existing "PASSED but still linked" block that currently expects RD-823. It should now expect:

```typescript
expect(retry.exitCode).toBe(0);
const out = parseCliJsonObject(retry.stdout);
expect(out).toEqual(expect.objectContaining({ kind: 'delegate', action: 'retried' }));
expect(String(out.token)).toMatch(/^rdtk_/);
```

Keep the "CLAIMED/running" block expecting RD-823.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --no-cache --runTestsByPath __tests__/runbook/lifecycle-command-service.test.ts __tests__/runbook/delegation-service.test.ts
pnpm --filter @rundown-org/cli test:integration -- --no-cache --runTestsByPath __tests__/integration/delegate-workflow.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts packages/core/__tests__/runbook/lifecycle-command-service.test.ts packages/cli/__tests__/integration/delegate-workflow.test.ts
git commit -m "fix(core): retry terminal linked delegations"
```

### Task 5: `abort --force` Cleans Up Resolved Linked Children

**Files:**

- Modify: `packages/core/src/runbook/lifecycle-command-service.ts`
- Modify: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`
- Modify: `packages/cli/src/commands/abort.ts`
- Modify: `packages/cli/__tests__/integration/delegation-abort.test.ts`

- [ ] **Step 1: Add failing abort integration tests**

Add these tests to `packages/cli/__tests__/integration/delegation-abort.test.ts`.

```typescript
it('force-aborts a resolved failed linked child without RD-812', async () => {
  const token = await setupDelegation();
  const parentId = (await getActiveState(workspace))!.id;

  const claim = runCli(`claim ${token}`, workspace);
  expect(claim.exitCode).toBe(0);
  const claimPayload = parseCliJsonObject(claim.stdout);
  const claimId = String(claimPayload.claim_id);

  const failed = runCli(`fail --claim-id ${claimId}`, workspace);
  expect(failed.exitCode).toBe(0);

  const result = runCli(`abort ${token} --force`, workspace);
  expect(result.exitCode).toBe(0);
  expect(`${result.stdout}${result.stderr}`).not.toContain('RD-812');

  const parent = await readRunbookState(workspace, parentId);
  const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
    (row) => row.agentId === 'delegation',
  );
  expect(rows).toHaveLength(0);
  const entry = parent!.substepStates?.find((state) => state.id === '1');
  expect(entry?.delegation?.cancelledAt).not.toBeNull();
});
```

- [ ] **Step 2: Run the focused failing abort test**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- --no-cache --runTestsByPath __tests__/integration/delegation-abort.test.ts
```

Expected: fail with RD-812 in the new test.

- [ ] **Step 3: Add a core force-abort cleanup seam**

In `packages/core/src/runbook/lifecycle-command-service.ts`, extend
`RunbookLifecycleCommandServiceDependencies` with this narrow capability:

```typescript
/** Delete a persisted run state by id. Used only for active-child force abort cleanup. */
readonly deleteRun: (runId: RunId) => Promise<void>;
```

Update the CLI seam factory and tests to pass `manager.delete(runId)` for this
dependency. Then add this public method to `RunbookLifecycleCommandService`.

```typescript
export type ForceAbortLinkedChildCleanupResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'active_child_failed'; readonly childRunId: RunId }
  | { readonly kind: 'terminal_child_cleaned'; readonly childRunId: RunId }
  | { readonly kind: 'missing_child_cleaned'; readonly childRunId: RunId };

async cleanupForceAbortedLinkedChild(args: {
  readonly parentState: RunbookState;
  readonly childRunId: RunId | null;
  readonly frameKey: FrameKey;
  readonly substepId: string;
}): Promise<ForceAbortLinkedChildCleanupResult> {
  if (!args.childRunId) return { kind: 'none' };

  const childState = await this.#deps.loadRun(args.childRunId);
  const childIsActive = childState?.lifecycle === 'running';
  const childIsTerminal =
    childState?.lifecycle === 'completed' || childState?.lifecycle === 'stopped';

  if (childIsActive) {
    await this.#deps.deleteRun(args.childRunId);
    await this.#deps.sessionService.releaseRunbook(args.childRunId);
    await this.#deps.completionService.recordChildCompletionUnlocked({
      childState,
      result: 'fail',
      ignoreCancellation: true,
    });
    return { kind: 'active_child_failed', childRunId: args.childRunId };
  }

  if (childIsTerminal) {
    await this.#deps.sessionService.releaseRunbook(args.childRunId);
    await this.#deps.completionService.supersedeDelegationOutcomeUnlocked({
      runbookId: args.parentState.id,
      frameKey: args.frameKey,
      substepId: args.substepId,
    });
    return { kind: 'terminal_child_cleaned', childRunId: args.childRunId };
  }

  await this.#deps.sessionService.releaseRunbook(args.childRunId);
  await this.#deps.completionService.supersedeDelegationOutcomeUnlocked({
    runbookId: args.parentState.id,
    frameKey: args.frameKey,
    substepId: args.substepId,
  });
  return { kind: 'missing_child_cleaned', childRunId: args.childRunId };
}
```

This method must be called only while the caller already owns the parent run's
`DelegationLock`, matching `recordChildCompletionUnlocked` and
`supersedeDelegationOutcomeUnlocked`.

- [ ] **Step 4: Add core cleanup seam tests**

In `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`, add tests
for all three cleanup branches:

```typescript
it('force-abort cleanup records explicit fail for running linked child', async () => {
  const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
  const childRunId = assertRunId('rd_abort_active000000000000000000000');
  await mgr.save(baseState({ id: childRunId, lifecycle: 'running', parentLinkage: linkageFor(state.id, '1') }));
  const deleteSpy = jest.spyOn(deps, 'deleteRun');

  const result = await localSeam.cleanupForceAbortedLinkedChild({
    parentState: state,
    childRunId,
    frameKey: buildFrameKey('1'),
    substepId: '1',
  });

  expect(result).toEqual({ kind: 'active_child_failed', childRunId });
  expect(deleteSpy).toHaveBeenCalledWith(childRunId);
});

it('force-abort cleanup supersedes terminal linked child outcome without deleting diagnostics', async () => {
  const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
  const childRunId = assertRunId('rd_abort_terminal000000000000000000');
  const frameKey = buildFrameKey('1');
  const key = buildCompletionKey(activeFrame(frameKey, 1), '1');
  await mgr.save(baseState({ id: childRunId, lifecycle: 'stopped', parentLinkage: linkageFor(state.id, '1') }));
  await mgr.update(state.id, {
    resolvedCompletions: {
      [key]: buildResolvedCompletion({
        agentId: 'delegation',
        result: 'fail',
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(frameKey, 1),
      }),
    },
  });

  const result = await localSeam.cleanupForceAbortedLinkedChild({
    parentState: state,
    childRunId,
    frameKey,
    substepId: '1',
  });

  expect(result).toEqual({ kind: 'terminal_child_cleaned', childRunId });
  await expect(mgr.load(childRunId)).resolves.not.toBeNull();
  await expect(deps.lifecycleService.getResolvedCompletion(state.id, key)).resolves.toBeNull();
});

it('force-abort cleanup supersedes stale outcome for missing linked child', async () => {
  const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
  const childRunId = assertRunId('rd_abort_missing0000000000000000000');
  const frameKey = buildFrameKey('1');
  const key = buildCompletionKey(activeFrame(frameKey, 1), '1');
  await mgr.update(state.id, {
    resolvedCompletions: {
      [key]: buildResolvedCompletion({
        agentId: 'delegation',
        result: 'fail',
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(frameKey, 1),
      }),
    },
  });

  const result = await localSeam.cleanupForceAbortedLinkedChild({
    parentState: state,
    childRunId,
    frameKey,
    substepId: '1',
  });

  expect(result).toEqual({ kind: 'missing_child_cleaned', childRunId });
  await expect(deps.lifecycleService.getResolvedCompletion(state.id, key)).resolves.toBeNull();
});
```

- [ ] **Step 5: Remove the already-resolved force-abort refusal**

In `packages/cli/src/commands/abort.ts`, remove this behavior:

```typescript
if (
  await hasResolvedCompletion(
    lifecycleService,
    freshParent.id,
    freshParent,
    scanFrameKey,
    targetSubstepId,
  )
) {
  throw Errors.delegationAlreadyResolved(targetSubstepId);
}
```

Keep the helper if another branch still needs it. If no branch uses it after this edit, delete the helper.

- [ ] **Step 6: Route linked-child cleanup through the core seam**

After `abortDelegation()` returns `cancelled` and the parent state is persisted:

```typescript
if (options.force) {
  await lifecycleCommandService.cleanupForceAbortedLinkedChild({
    parentState: freshParent,
    childRunId,
    frameKey: scanFrameKey,
    substepId: targetSubstepId,
  });
}
```

Construct `lifecycleCommandService` through the existing CLI lifecycle seam
factory so `abort.ts` does not manually classify child lifecycle, release
sessions, delete active child state, or supersede completion rows.

- [ ] **Step 7: Run abort tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --no-cache --runTestsByPath __tests__/runbook/lifecycle-command-service.test.ts
pnpm --filter @rundown-org/cli test:integration -- --no-cache --runTestsByPath __tests__/integration/delegation-abort.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts packages/core/__tests__/runbook/lifecycle-command-service.test.ts packages/cli/src/commands/abort.ts packages/cli/__tests__/integration/delegation-abort.test.ts
git commit -m "fix(core): force abort resolved linked delegations"
```

### Task 6: End-to-End Recovery Regressions For #545 And #520

**Files:**

- Create: `packages/cli/__tests__/integration/recovery-semantics.test.ts`
- Modify: `packages/cli/__tests__/services/execution-loop.test.ts`
- Modify: `packages/core/__tests__/runbook/compiler-command-exec.test.ts`
- Modify: `packages/core/__tests__/runbook/actor-service.test.ts`

- [ ] **Step 1: Create the policy-denied delegation integration file**

Create `packages/cli/__tests__/integration/recovery-semantics.test.ts` with this scaffold.

```typescript
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createRunbook,
  createTestWorkspace,
  findActionOutput,
  getActiveState,
  parseCliJsonObject,
  readRunbookState,
  runCli,
  runCliInProcess,
  type TestWorkspace,
  withRunTarget,
} from '../helpers/test-utils.js';

describe('recovery semantics for delegated command infrastructure stops', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function writePolicyDeniedParentAndChild(): Promise<void> {
    await writeFile(
      join(workspace.cwd, 'parent.runbook.md'),
      createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Delegate work',
            pass: 'CONTINUE',
            fail: 'STOP',
            substeps: [
              {
                title: 'Child',
                delegate: true,
                runbooks: ['child.runbook.md'],
                content: 'Child should be recoverable.',
              },
            ],
          },
          { title: 'Done', pass: 'COMPLETE', content: 'Done.' },
        ],
      }),
    );
    const child = [
      '# Child',
      '',
      '## 1. Denied command',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      '```bash',
      'node -e "console.log(42)"',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'child.runbook.md'), child);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), child);
  }
```

- [ ] **Step 2: Add the #545 regression**

Append this test to the new file.

```typescript
it('does not report delegated fail when a child command is policy denied', async () => {
  await writePolicyDeniedParentAndChild();

  const start = runCli('run --prompted parent.runbook.md', workspace);
  expect(start.exitCode).toBe(0);
  const parentId = (await getActiveState(workspace))!.id;
  const token = (await getActiveState(workspace))!.substepStates?.[0]?.delegation?.token;
  expect(token).toMatch(/^rdtk_/);

  const claim = await runCliInProcess(['claim', String(token)], workspace);
  expect(claim.exitCode).toBe(0);
  const claimPayload = findActionOutput(claim.stdout);
  const claimId = String(claimPayload!.claim_id);
  const childRunId = String(claimPayload!.run_id);

  const childRun = await runCliInProcess(
    ['run', '--claim-id', claimId, '--deny-all'],
    workspace,
  );
  expect(childRun.exitCode).toBe(1);

  const child = await readRunbookState(workspace, childRunId);
  expect(child?.lifecycle).toBe('stopped');
  expect(child?.lastAction).toEqual(
    expect.objectContaining({ type: 'POLICY_DENIED' }),
  );

  const parent = await readRunbookState(workspace, parentId);
  const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
    (row) => row.agentId === 'delegation',
  );
  expect(rows).toHaveLength(0);
  const entry = parent!.substepStates?.find((state) => state.id === '1');
  expect(entry?.delegation?.childRunId).toBe(childRunId);
  expect(entry?.result).toBeUndefined();
});
```

Adjust the exact claim/run invocation if this repo's helper already auto-runs the child during `claim`. The assertion shape stays fixed: child has `POLICY_DENIED`, parent has no delegated fail row.

- [ ] **Step 3: Add retry recovery to the same integration**

Append:

```typescript
it('retries after policy-denied child terminal without full parent restart', async () => {
  await writePolicyDeniedParentAndChild();

  const start = runCli('run --prompted parent.runbook.md', workspace);
  expect(start.exitCode).toBe(0);
  const parentId = (await getActiveState(workspace))!.id;
  const token = String((await getActiveState(workspace))!.substepStates?.[0]?.delegation?.token);

  const claim = await runCliInProcess(['claim', token], workspace);
  const claimPayload = findActionOutput(claim.stdout)!;
  const claimId = String(claimPayload.claim_id);
  await runCliInProcess(['run', '--claim-id', claimId, '--deny-all'], workspace);

  const retry = await runCliInProcess(
    await withRunTarget(['delegate', '--retry', token], workspace),
    workspace,
  );

  expect(retry.exitCode).toBe(0);
  const retryPayload = parseCliJsonObject(retry.stdout);
  expect(retryPayload).toEqual(expect.objectContaining({ action: 'retried' }));
  expect(String(retryPayload.token)).toMatch(/^rdtk_/);
  const parent = await readRunbookState(workspace, parentId);
  const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
    (row) => row.agentId === 'delegation',
  );
  expect(rows).toHaveLength(0);
});
```

- [ ] **Step 4: Add policy-denied force-abort cleanup regression**

Append this test to `packages/cli/__tests__/integration/recovery-semantics.test.ts`.

```typescript
it('force-aborts a policy-denied linked child without recording delegated fail', async () => {
  await writePolicyDeniedParentAndChild();

  const start = runCli('run --prompted parent.runbook.md', workspace);
  expect(start.exitCode).toBe(0);
  const parentId = (await getActiveState(workspace))!.id;
  const token = String((await getActiveState(workspace))!.substepStates?.[0]?.delegation?.token);

  const claim = await runCliInProcess(['claim', token], workspace);
  expect(claim.exitCode).toBe(0);
  const claimPayload = findActionOutput(claim.stdout)!;
  const claimId = String(claimPayload.claim_id);
  const childRunId = String(claimPayload.run_id);

  const childRun = await runCliInProcess(
    ['run', '--claim-id', claimId, '--deny-all'],
    workspace,
  );
  expect(childRun.exitCode).toBe(1);
  const child = await readRunbookState(workspace, childRunId);
  expect(child?.lastAction).toEqual(expect.objectContaining({ type: 'POLICY_DENIED' }));

  const abort = await runCliInProcess(
    await withRunTarget(['abort', token, '--force'], workspace),
    workspace,
  );
  expect(abort.exitCode).toBe(0);
  expect(`${abort.stdout}${abort.stderr}`).not.toContain('RD-812');

  const parent = await readRunbookState(workspace, parentId);
  const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
    (row) => row.agentId === 'delegation',
  );
  expect(rows).toHaveLength(0);
  const entry = parent!.substepStates?.find((state) => state.id === '1');
  expect(entry?.delegation?.cancelledAt).not.toBeNull();
});
```

After this test, close the file's top-level `describe` block.

```typescript
});
```

- [ ] **Step 5: Add the #520 helper-path unit regression**

In `packages/cli/__tests__/services/execution-loop.test.ts`, add a test that
drives a delegation-linked child with a `COMMAND_EXECUTION_FAILED` last action
through `propagateChildTerminal(childState, undefined, cwd, output)` or through
the execution-loop branch that calls that helper. Do not assert against
`mockCompletionService.recordChildCompletion`; that fixture does not currently
expose the method and a shallow mock would not prove persisted behavior.

The important assertions:

```typescript
expect(result).toBe('stopped');
expect(mockEmitter.emit).toHaveBeenCalledWith({
  type: 'RUNBOOK_STOPPED',
  payload: expect.objectContaining({
    reason: 'command_execution_failed',
    message: 'Timeout of 30000 ms exceeded',
  }),
});
expect(await lifecycleService.getResolvedCompletion(parentRunId, expectedCompletionKey)).toBeNull();
```

Use the existing execution-loop fixture helpers in that file instead of creating
a second manager abstraction. If the fixture does not expose
`expectedCompletionKey`, compute it with the same `activeFrame` /
`buildCompletionKey` helpers used by the delegation-completion tests. The
assertion must prove no parent resolved-completion row was written, not merely
that the CLI avoided one explicit mock call shape.

- [ ] **Step 6: Add command-execution-failure integration coverage**

In `packages/cli/__tests__/integration/recovery-semantics.test.ts`, add a second
child runbook fixture whose command reliably triggers `COMMAND_EXECUTION_FAILED`
through the real command actor path. Prefer an existing repo helper for injecting
a throwing command executor if one exists; otherwise add the integration as an
in-process CLI test that constructs the run with the real
`RunbookActorService` and a command callable that throws:

```typescript
throw new Error('Timeout of 30000 ms exceeded');
```

The test must assert the same persisted behavior as the policy-denied case:

```typescript
expect(child?.lifecycle).toBe('stopped');
expect(child?.lastAction).toEqual(
  expect.objectContaining({
    type: 'COMMAND_EXECUTION_FAILED',
    message: 'Timeout of 30000 ms exceeded',
  }),
);
const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
  (row) => row.agentId === 'delegation',
);
expect(rows).toHaveLength(0);
```

If the test uses a DI'd throwing command callable rather than a subprocess, keep
it in this integration file and name it as an integration regression for the
CLI/core propagation path, not as a unit test.

- [ ] **Step 7: Keep existing core command error tests green**

Do not remove the existing tests in:

- `packages/core/__tests__/runbook/compiler-command-exec.test.ts`
- `packages/core/__tests__/runbook/actor-service.test.ts`

Add this assertion where those tests already check `COMMAND_EXECUTION_FAILED`:

```typescript
expect(snapshot.context.lastResult).toBeUndefined();
```

- [ ] **Step 8: Run focused recovery tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --no-cache --runTestsByPath __tests__/runbook/compiler-command-exec.test.ts __tests__/runbook/actor-service.test.ts
pnpm --filter @rundown-org/cli test:unit -- --no-cache --runTestsByPath __tests__/services/execution-loop.test.ts
pnpm --filter @rundown-org/cli test:integration -- --no-cache --runTestsByPath __tests__/integration/recovery-semantics.test.ts
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/__tests__/integration/recovery-semantics.test.ts packages/cli/__tests__/services/execution-loop.test.ts packages/core/__tests__/runbook/compiler-command-exec.test.ts packages/core/__tests__/runbook/actor-service.test.ts
git commit -m "test: pin recovery semantics for command infrastructure stops"
```

### Task 7: Documentation

**Files:**

- Modify: `docs/internal/architecture.md`
- Modify: `docs/reference/cli.md`

- [ ] **Step 1: Update internal architecture docs**

Add a short subsection under the command execution or delegation lifecycle section in `docs/internal/architecture.md`.

```markdown
### Delegated Command Infrastructure Terminals

Command execution is a machine-owned Category C side effect. The command actor
can produce authored runbook outcomes (`pass` and `fail`) or command
infrastructure terminal reasons such as `POLICY_DENIED` and
`COMMAND_EXECUTION_FAILED`. Delegation propagation projects terminal children
through `projectDelegationTerminalOutcome`; it must not infer delegated `fail`
from `lifecycle: stopped` alone.

Policy denial and command execution failure leave the linked child terminal for
operator recovery. A retry over that terminal linked child supersedes stale
delegation outcomes and removes the stale claim record without deleting the
child state file. `abort --force` can also cancel the resolved linked delegation
without recording a fresh delegated fail.
```

- [ ] **Step 2: Update CLI reference only for changed operator behavior**

In `docs/reference/cli.md`, update the `delegate --retry` and `abort --force` descriptions so they say:

```markdown
- `rundown delegate --retry <token>` refuses a live claimed child, but can
  supersede a terminal linked child and mint a fresh token.
- `rundown abort <token> --force` cancels an active claimed child as fail. When
  the linked child is already terminal or already reported, it performs cleanup
  without recording a duplicate fail.
```

- [ ] **Step 3: Run docs checks**

Run:

```bash
pnpm run check:md
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add docs/internal/architecture.md docs/reference/cli.md
git commit -m "docs: describe recovery semantics for delegated command stops"
```

### Task 8: Final Verification

**Files:**

- No new edits unless verification exposes defects.

- [ ] **Step 1: Run focused suites**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- --no-cache --runTestsByPath __tests__/runbook/completion-service.test.ts __tests__/runbook/collection-service.test.ts __tests__/runbook/lifecycle-command-service.test.ts __tests__/runbook/delegation-service.test.ts __tests__/runbook/compiler-command-exec.test.ts __tests__/runbook/actor-service.test.ts
pnpm --filter @rundown-org/core test:property -- --runTestsByPath __tests__/runbook/completion-service.properties.test.ts
pnpm --filter @rundown-org/cli test:unit -- --no-cache --runTestsByPath __tests__/helpers/delegation-completion.test.ts __tests__/services/execution-loop.test.ts
pnpm --filter @rundown-org/cli test:integration -- --no-cache --runTestsByPath __tests__/integration/recovery-semantics.test.ts __tests__/integration/delegate-workflow.test.ts __tests__/integration/delegation-abort.test.ts
```

Expected: pass.

- [ ] **Step 2: Run type checks and build**

Run:

```bash
pnpm run build
pnpm run check:types
```

Expected: pass.

- [ ] **Step 3: Run full pre-PR verification**

Run:

```bash
pnpm run verify
pnpm run test:property
```

Expected: pass.

- [ ] **Step 4: Commit verification-only fixes**

Only if Step 1, Step 2, or Step 3 required small fixes:

```bash
git add <changed-files>
git commit -m "fix: address recovery semantics verification findings"
```

## Acceptance Criteria

- Policy-denied delegated command steps no longer create a delegated `fail` resolved completion.
- Command execution failure and timeout-shaped command runner errors no longer create delegated `fail` resolved completions.
- Explicit operator `fail` still records delegated fail.
- `delegate --retry` refuses active linked children and succeeds for terminal linked children.
- `delegate --retry` removes stale reported delegation outcomes for the superseded attempt.
- `abort --force` no longer catch-22s on resolved linked children.
- `abort --force` keeps active-child behavior: stop active child and report explicit fail.
- No persisted state migration is introduced.
- CLI tests use default JSON output unless the test is explicitly about text rendering.

## Self-Review

- Spec coverage: #545 is covered by Tasks 1, 3, 4, and 6. #547 is covered by Tasks 2, 4, and 5. #520 is covered by Tasks 1, 3, and 6.
- Red-flag scan: this plan does not contain deferred work.
- Type consistency: the new projection discriminants are `outcome`, `command_infrastructure`, and `not_terminal`; propagation adds `blocked`; child completion adds `blocked`.
