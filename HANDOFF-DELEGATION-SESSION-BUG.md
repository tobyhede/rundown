# Handoff: Delegation Session Restoration Bug

## Problem

After `rd claim` completes a child runbook and propagates the result back to the parent, the **parent runbook is dropped from the active session stack**. A subsequent `rd delegate --step 1.2` fails with `"No active runbook"`.

This blocks the `delegate-hierarchy / all-pass` scenario (the only failing test: 232/233 pass).

## Reproduction

```bash
# Build and run the failing test
npm run build
npm run test:integration -w @rundown-org/cli -- --testPathPattern "scenario-runner" --testNamePattern "delegate-hierarchy"
```

The scenario commands (`runbooks/patterns/delegation/delegate-hierarchy.runbook.md`):

```yaml
commands:
  - rd run delegate-hierarchy.runbook.md
  - rd delegate delegation-child-pass.runbook.md --step 1.1
  - rd claim ${TOKEN}
  - rd delegate delegation-child-pass.runbook.md --step 1.2   # ← FAILS: "No active runbook"
  - rd claim ${TOKEN_2}
```

## Root Cause

Session stack trace through the flow:

| Checkpoint | Session Stack |
|---|---|
| Parent started | `[parentId]` |
| Delegation created (step 1.1) | `[parentId]` |
| Child launched via `rd claim` | `[parentId, childId]` |
| Child completes, popped in `runExecutionLoop` | `[parentId]` — parent active again |
| `handleDelegationCompletion` starts | `[parentId]` |
| `drainResolvedCompletions` → `orchestrateTransition` → `applyTerminalSideEffects` | `[]` — **parent popped** |
| `handleDelegationCompletion` returns | `[]` |
| Next `rd delegate` | ERROR: No active runbook |

The parent is popped because `drainResolvedCompletions` uses transition policies with `onComplete: { popRunbook: true }`. This policy is correct for normal user transitions (when the entire runbook completes), but in delegation propagation, completing **one substep** doesn't mean the parent runbook is finished — it may have more substeps.

## Key Code Locations

| File | Line(s) | Role |
|------|---------|------|
| `packages/cli/src/commands/claim.ts` | 67-81 | Calls `handleDelegationCompletion` after child finishes |
| `packages/cli/src/helpers/delegation-completion.ts` | ~134 | Creates new `SessionService`, calls `drainResolvedCompletions` |
| `packages/core/src/execution/transition-orchestrator.ts` | 140-147 | `applyTerminalSideEffects` pops runbook on complete/stop |
| `packages/core/src/execution/execution.ts` | 326-399 | `drainResolvedCompletions` applies transitions with popRunbook policy |
| `packages/core/src/runbook/session-service.ts` | 51, 65 | `pushRunbook()` / `popRunbook()` manage session stack |

## Suggested Fix

After `handleDelegationCompletion` returns in `claim.ts`, check if the parent is still in a non-terminal state and restore it to the session:

```typescript
// After handleDelegationCompletion in claim.ts
if (result.loopResult === 'done' || result.loopResult === 'stopped') {
  const childState = await manager.load(result.childRunId);
  if (childState?.delegation) {
    const propResult = childState.variables.completed ? 'pass' : 'fail';
    const propagation = await handleDelegationCompletion(
      childState, propResult, cwd, output,
    );
    // ... existing shouldExitWithError logic ...

    // FIX: Restore parent to session if it's not terminal
    const parentRunId = childState.delegation.parentRunId;
    const parentState = await manager.load(parentRunId);
    if (parentState && !parentState.variables.completed && !parentState.variables.stopped) {
      await sessionService.pushRunbook(parentRunId);
    }
  }
}
```

Alternative: Fix inside `handleDelegationCompletion` itself, or adjust the transition policy used during delegation propagation to not pop the parent (`onComplete: { popRunbook: false }`).

## Verification

After fix, these should all pass:

```bash
npm run test:unit -w @rundown-org/cli -- --testPathPattern "command-sequence"
npm run test:integration -w @rundown-org/cli -- --testPathPattern "scenario-runner"
npm test
```

## Context

- Parts 1-5 of the delegation fix are already implemented and merged
- The `scenario-runner.test.ts` now uses `executeCommandSequence` (token substitution + capture works)
- This is the last remaining delegation test failure
