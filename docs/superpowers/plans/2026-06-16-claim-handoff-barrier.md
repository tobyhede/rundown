# Claim Hand-off Barrier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a delegated claimed child from silently driving the parent pipeline after it closes its claim (GitHub issue #460), by stamping a one-shot "claim hand-off pending" barrier on the default stack that refuses *bare* mutating commands until an actor deliberately resumes.

**Architecture:** When a claim closes and the parent auto-advances, the CLI stamps a `handoffPending` marker into `.rundown/session.json` against the runbook that just became default-active. The core resolvers refuse bare `pass`/`fail` (`resolveTransitionTarget`) and bare `delegate`/`collect` (a new `resolveGuardedCommandTarget`) while the marker matches the active runbook. The marker is one-shot: `--resume`, `rd goto`, and a top-level `rd run` **clear** it; an explicit `--step`/`--claim-id` target **bypasses** it (the marker stays until a clearing command runs). Recovery/inspection (`status`, `stop`, `stash`) is never blocked. This is **isolation-against-accident**, mirroring the removed `RD_AGENT_ID` ownership model's own threat model — not an adversarial boundary. All decision logic lives in `@rundown-org/core`; the CLI only stamps/clears via core calls and renders the typed refusal.

**Tech Stack:** TypeScript, XState (core state machine), Zod (session schema), Jest (`packages/core/__tests__`, `packages/cli/__tests__`), pnpm workspaces.

---

## Background: why a session-state marker, and where the parent actually advances

Every `rd` invocation is a fresh OS process; the orchestrator's calls and the child subagent's calls share the same `cwd` and `.rundown/session.json` and are indistinguishable at the process level. `RD_CLAIM_TOKEN=` is a marker string in prompt/output (`packages/core/src/runbook/delegation-token.ts:27`), not a durable env var in the child's shell. So the discriminator **must** live in `session.json`.

**Critical wiring fact (verified):** for `rd pass/fail --claim-id`, `executeTransition` completes the *child*. The parent advance — the behaviour the barrier guards — happens afterward inside `handleParentCompletion` (`packages/cli/src/helpers/delegation-completion.ts:68`), invoked from `transition-command.ts:178` **after** `executeTransition` returns. The same propagation path is reached by `complete --claim-id` (`commands/complete.ts:158`), `stop --claim-id` (`commands/stop.ts:157`), and claim-time auto-completion (`commands/claim.ts:201`). Every one of these closes a claim and advances the parent, so the marker is stamped after `handleParentCompletion` returns in **all four** sites. The existing `OPEN_DELEGATED_CHILDREN` guard (`resolveTransitionTarget`, `command-target-resolver.ts:289`) only fires *while a claim is open*; this plan covers the gap *after* it closes.

### Test ID convention (use everywhere)

Run ids must match `RUN_ID_PATTERN` = `/^rd_[a-f0-9]{32}$/` (`run-id.ts:10`) and claim ids `/^rdclm_[A-Za-z0-9_-]{22}$/`. Never hand-write near-miss literals. In every test snippet below, build ids with:

```typescript
const rid = (c: string) => `rd_${c.repeat(32)}` as RunId;       // rid('a') => valid 32-hex
const cid = (c: string) => `rdclm_${c.repeat(22)}` as ClaimId;  // cid('A') => valid claim id
```

## File Structure

**Core (`packages/core/src`):**
- `runbook/state.ts` — add `ClaimHandoff` type + `handoffPending?` to `SessionData`.
- `schemas.ts` — add `ClaimHandoffSchema` (branded `fromClaimId`), wire into `SessionDataSchema`.
- `output/zod-schemas.ts` — register `CLAIM_HANDOFF_PENDING` in `CLISymbolicErrorCodeValues` + `CLIErrorCodes`. **(F4)**
- `runbook/session-service.ts` — add `markClaimHandoff` (parent-chain constrained), `readClaimHandoff`, `clearClaimHandoff`.
- `runbook/command-target-resolver.ts` — extend `CommandTargetReader`; add `claim_handoff_pending` to `TransitionTargetResolution` only; add `GuardedCommandTargetResolution` + `resolveGuardedCommandTarget` **with `targeted` exemption**; fire the refusal in `resolveTransitionTarget`.
- `runbook/index.ts` — export `ClaimHandoff`, `GuardedCommandTargetResolution`, `resolveGuardedCommandTarget`.

**CLI (`packages/cli/src`):**
- `helpers/transitions.ts` — `emitClaimHandoffPendingError`; `claim_handoff_pending` variants on `BuildTransitionContextResult` and `BaseBuildTransitionContextResult`; `resume`/`guardHandoff`/`step` params on `buildTransitionContext`.
- `helpers/transition-command.ts` — `--resume`; route the refusal; stamp the marker after `handleParentCompletion`.
- `commands/claim.ts`, `commands/complete.ts`, `commands/stop.ts` — stamp after their `handleParentCompletion`. **(F6)**
- `commands/delegate.ts` — route bare-inference target through `resolveGuardedCommandTarget` (with `--step` exemption); `--resume`.
- `commands/collect.ts` — `guardHandoff: true` + forward `--step` via `buildTransitionContext`; `--resume`.
- `commands/goto.ts` (action) + `commands/run.ts` (top-level) — clear on deliberate resume.

**Docs / fixtures:**
- `docs/reference/cli.md` — document `CLAIM_HANDOFF_PENDING` + `--resume`.
- `runbooks/delegation/claim-handoff-barrier.runbook.md` (+ leaf) — scenario coverage.

**Tests:**
- `packages/core/__tests__/schemas.test.ts`, `output/zod-schemas.test.ts` (or nearest error-schema test), `runbook/session-service.test.ts`, `runbook/command-target-resolver.test.ts`, `runbook/claim-handoff.properties.test.ts` (new)
- `packages/cli/__tests__/integration/claim-handoff-barrier.test.ts` (new)

> **Provenance:** this revision folds in an external review verified against source on 2026-06-17. Blockers fixed: error-code registration (F4), `--step` exemption for delegate/collect (F3), complete/stop claim-close stamping (F6), test-fixture correctness (F8). Should-fixes: unrelated-top mis-stamp constraint (F1), pass/fail coverage symmetry (F5). Doc fix: `--step`/`--claim-id` *bypass*, not *clear* (F2). Documented limitation: stamp-after-advance non-atomicity (F7, Self-Review).

---

## Task 1: Data model, branded schema, and error-code registration

**Files:**
- Modify: `packages/core/src/runbook/state.ts:167`
- Modify: `packages/core/src/schemas.ts` (before `SessionDataSchema`, ~line 548)
- Modify: `packages/core/src/output/zod-schemas.ts` (`CLISymbolicErrorCodeValues` ~line 34; `CLIErrorCodes` ~line 77)
- Modify: `packages/core/src/runbook/index.ts` (~line 61)
- Test: `packages/core/__tests__/schemas.test.ts` (SessionData schema); `packages/core/__tests__/output/schema.test.ts` (error-code registry — the live home of `ErrorCodeSchema`)

- [ ] **Step 1: Write the failing SessionData schema test**

Append to `packages/core/__tests__/schemas.test.ts`:

```typescript
import { SessionDataSchema } from '../src/schemas.js';

describe('SessionDataSchema handoffPending', () => {
  const PARENT = `rd_${'a'.repeat(32)}`;
  const CLAIM = `rdclm_${'A'.repeat(22)}`;

  it('accepts and brands a valid handoffPending marker', () => {
    const parsed = SessionDataSchema.parse({
      defaultStack: [PARENT],
      claims: {},
      handoffPending: { handedOffAt: '2026-06-16T00:00:00.000Z', fromClaimId: CLAIM, toRunId: PARENT },
    });
    expect(parsed.handoffPending?.fromClaimId).toBe(CLAIM);
  });

  it('accepts a session with no handoffPending (optional)', () => {
    expect(SessionDataSchema.parse({ defaultStack: [], claims: {} }).handoffPending).toBeUndefined();
  });

  it('rejects a handoffPending with a non-canonical claim id', () => {
    expect(() =>
      SessionDataSchema.parse({
        defaultStack: [],
        claims: {},
        handoffPending: { handedOffAt: '2026-06-16T00:00:00.000Z', fromClaimId: 'not-a-claim-id', toRunId: PARENT },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Write the failing error-code registry test**

`ErrorCodeSchema` lives in `packages/core/src/output/zod-schemas.ts` (re-exported via `output/index.ts`), and its registry test is `packages/core/__tests__/output/schema.test.ts` — see the existing `describe('ErrorCodeSchema code registry')` (~line 214) and the `OPEN_DELEGATED_CHILDREN` block (~line 257). Add the analogous block there, mirroring that precedent:

```typescript
// packages/core/__tests__/output/schema.test.ts — beside the OPEN_DELEGATED_CHILDREN case (~line 257)
it('accepts the CLAIM_HANDOFF_PENDING refusal emitted by the hand-off barrier', () => {
  expect(ErrorCodeSchema.safeParse('CLAIM_HANDOFF_PENDING').success).toBe(true);
  expect(
    ErrorResponseSchema.safeParse({ kind: 'error', message: 'refused', code: 'CLAIM_HANDOFF_PENDING' }).success,
  ).toBe(true);
  expect(CLIErrorCodes.CLAIM_HANDOFF_PENDING).toBe('CLAIM_HANDOFF_PENDING');
});
```

`ErrorResponseSchema` / `CLIErrorCodes` are already imported by that test file (used by the OPEN_DELEGATED_CHILDREN case); add `CLIErrorCodes` to the import if absent.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/core test -- schemas.test.ts -t handoffPending && pnpm --filter @rundown-org/core test -- output/schema.test.ts -t CLAIM_HANDOFF_PENDING`
Expected: FAIL — `handoffPending` stripped; `ErrorCodeSchema.safeParse('CLAIM_HANDOFF_PENDING')` / `CLIErrorCodes.CLAIM_HANDOFF_PENDING` not present.

- [ ] **Step 4: Add `ClaimHandoff` to the `SessionData` interface**

In `packages/core/src/runbook/state.ts`, add `ClaimId` to the existing `./claim-id.js` import, then replace the `SessionData` interface (line 167):

```typescript
/**
 * One-shot barrier recorded when a claim closes and auto-advances the parent, so
 * the runbook that just became default-active cannot be driven by a bare command
 * until an actor deliberately resumes (issue #460). Isolation-against-accident,
 * not an adversarial boundary.
 */
export interface ClaimHandoff {
  /** ISO timestamp when the hand-off was recorded. */
  readonly handedOffAt: string;
  /** Claim id whose closure produced this parent advance. */
  readonly fromClaimId: ClaimId;
  /** Default-active runbook id this marker guards (the claim parent or its descendant). */
  readonly toRunId: RunId;
}

export interface SessionData {
  /** Active runbook stack for default targeting. */
  defaultStack: RunId[];
  /** ID of a temporarily stashed runbook, if any. */
  stashedRunbookId?: RunId;
  /** Explicit claim-id records for delegated child runbook targeting. */
  claims: Record<string, ClaimRecord>;
  /** One-shot claim hand-off barrier guarding the default stack (issue #460). */
  handoffPending?: ClaimHandoff;
}
```

- [ ] **Step 5: Add the branded Zod schema**

In `packages/core/src/schemas.ts`, immediately before `export const SessionDataSchema` (~line 548), reusing the branded `ClaimIdSchema` (`schemas.ts:527`) so `fromClaimId` round-trips as `ClaimId`:

```typescript
/** Zod schema for the one-shot claim hand-off barrier (issue #460). */
export const ClaimHandoffSchema = z.object({
  handedOffAt: z.string().min(1),
  fromClaimId: ClaimIdSchema,
  toRunId: RunIdSchema,
});
```

Add to the `SessionDataSchema` object body, after `claims`:

```typescript
    claims: z.record(z.string(), ClaimRecordSchema).default({}),
    handoffPending: ClaimHandoffSchema.optional(),
```

- [ ] **Step 6: Register the error code (F4)**

In `packages/core/src/output/zod-schemas.ts`, add `'CLAIM_HANDOFF_PENDING',` to the `CLISymbolicErrorCodeValues` array (after `'OPEN_DELEGATED_CHILDREN',` ~line 44) — this is what makes the closed `ErrorCodeSchema` enum accept it. Also add the entry to the explicit `CLIErrorCodes` doc object (after the `OPEN_DELEGATED_CHILDREN` entry ~line 99):

```typescript
  OPEN_DELEGATED_CHILDREN: 'OPEN_DELEGATED_CHILDREN',
  CLAIM_HANDOFF_PENDING: 'CLAIM_HANDOFF_PENDING',
```

- [ ] **Step 7: Export `ClaimHandoff` from core**

In `packages/core/src/runbook/index.ts`, beside the `type SessionData,` export (~line 61), add `type ClaimHandoff,`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @rundown-org/core test -- schemas.test.ts -t handoffPending && pnpm --filter @rundown-org/core test -- output/schema.test.ts -t CLAIM_HANDOFF_PENDING`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/runbook/state.ts packages/core/src/schemas.ts packages/core/src/output/zod-schemas.ts packages/core/src/runbook/index.ts packages/core/__tests__/schemas.test.ts packages/core/__tests__/output/schema.test.ts
git commit -m "feat(core): ClaimHandoff type/schema + register CLAIM_HANDOFF_PENDING (#460)"
```

---

## Task 2: `SessionService.markClaimHandoff` — stamp on claim close, parent-chain constrained

**Files:**
- Modify: `packages/core/src/runbook/session-service.ts` (after `runGuardedParentAdvance`, ~line 456)
- Modify: `packages/core/__tests__/runbook/session-service.test.ts` (extend `setupClaimedChild`; add tests)

**Contract (F1):** self-validating — callers invoke it unconditionally on any claim-targeted transition. It stamps only when **all** hold: the claim's child is terminal (claim genuinely closed); the default-active top is some runbook other than that child; AND the top is the claim's `parentRunId` **or descends from it** via `parentLinkage`. The chain check prevents mis-stamping an unrelated runbook the orchestrator switched to (e.g. after a stash). A missing child state counts as terminal.

- [ ] **Step 1: Extend the `setupClaimedChild` fixture (F8)**

The real helper (`session-service.test.ts:467`) is positional `setupClaimedChild(fill, 'completed'|'stopped')` and returns `{ claimId, childRunId }` — no parent, no `'running'`. Extend it in place so the new tests can express a non-terminal child and assert against the parent:

```typescript
async function setupClaimedChild(
  fill: string,
  childLifecycle: 'completed' | 'stopped' | 'running',
): Promise<{ claimId: ReturnType<typeof assertClaimId>; childRunId: RunId; parentRunId: RunId }> {
  const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, { runbookPath: 'parent.md' });
  const linkage = linkageFor(parent.id, fill);
  const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
    runbookPath: 'child.md',
    parentLinkage: linkage,
  });
  const claimed = assertClaimed(await sessionService.claimRunbook(child.id, linkage));
  await manager.update(child.id, { lifecycle: childLifecycle });
  return { claimId: claimed.claim.claimId, childRunId: child.id, parentRunId: parent.id };
}
```

This is additive (`'running'` and `parentRunId` are new; existing callers passing `'completed'|'stopped'` and destructuring `{ claimId, childRunId }` are unaffected).

- [ ] **Step 2: Write the failing tests**

```typescript
describe('SessionService.markClaimHandoff', () => {
  it('stamps against the default-active top when the child is terminal and the top is the parent', async () => {
    const { parentRunId, claimId } = await setupClaimedChild('h', 'completed');
    await sessionService.pushRunbook(parentRunId);
    await sessionService.markClaimHandoff(claimId);
    expect((await manager.loadSession()).handoffPending).toEqual({
      handedOffAt: expect.any(String),
      fromClaimId: claimId,
      toRunId: parentRunId,
    });
  });

  it('stamps when the top descends from the parent via parentLinkage', async () => {
    const { parentRunId, claimId } = await setupClaimedChild('i', 'completed');
    const inlineChild = await manager.create({ source: 'project', path: 'stage.md' }, mockRunbook, {
      runbookPath: 'stage.md',
      parentLinkage: linkageFor(parentRunId, 'i2'),
    });
    await sessionService.pushRunbook(inlineChild.id);
    await sessionService.markClaimHandoff(claimId);
    expect((await manager.loadSession()).handoffPending?.toRunId).toBe(inlineChild.id);
  });

  it('does NOT stamp an unrelated runbook on top (F1 negative)', async () => {
    const { claimId } = await setupClaimedChild('j', 'completed');
    const unrelated = await manager.create({ source: 'project', path: 'other.md' }, mockRunbook, { runbookPath: 'other.md' });
    await sessionService.pushRunbook(unrelated.id);
    await sessionService.markClaimHandoff(claimId);
    expect((await manager.loadSession()).handoffPending).toBeUndefined();
  });

  it('no-ops when the child is still active (claim not closed)', async () => {
    const { parentRunId, claimId } = await setupClaimedChild('k', 'running');
    await sessionService.pushRunbook(parentRunId);
    await sessionService.markClaimHandoff(claimId);
    expect((await manager.loadSession()).handoffPending).toBeUndefined();
  });

  it('no-ops when the default-active top is the claim child itself', async () => {
    const { childRunId, claimId } = await setupClaimedChild('l', 'completed');
    await sessionService.pushRunbook(childRunId);
    await sessionService.markClaimHandoff(claimId);
    expect((await manager.loadSession()).handoffPending).toBeUndefined();
  });

  it('no-ops when the claim record was already pruned', async () => {
    await sessionService.markClaimHandoff(`rdclm_${'Z'.repeat(22)}` as ClaimId);
    expect((await manager.loadSession()).handoffPending).toBeUndefined();
  });

  it('treats a missing child state as terminal and stamps the parent top', async () => {
    const { parentRunId, childRunId, claimId } = await setupClaimedChild('m', 'completed');
    await sessionService.pushRunbook(parentRunId);
    await manager.delete(childRunId);
    await sessionService.markClaimHandoff(claimId);
    expect((await manager.loadSession()).handoffPending?.toRunId).toBe(parentRunId);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/core test -- session-service.test.ts -t markClaimHandoff`
Expected: FAIL — `sessionService.markClaimHandoff is not a function`.

- [ ] **Step 4: Implement `markClaimHandoff` + the chain check**

Add `ClaimHandoff` to this file's `./state.js` import. Insert after `runGuardedParentAdvance`:

```typescript
  /**
   * Stamp a one-shot claim hand-off barrier when a claim closes and the parent
   * auto-advances (issue #460). Self-validating: a no-op unless the claim's child
   * is terminal, the current default-active top is a runbook other than that
   * child, AND the top is the claim's parent or descends from it via parent
   * linkage. The chain check ensures the barrier guards the parent's pipeline,
   * never an unrelated runbook the orchestrator switched to. Callers may invoke
   * this unconditionally after a claim-targeted transition propagates.
   *
   * @param closedClaimId - Claim id whose child transition may have closed it
   */
  async markClaimHandoff(closedClaimId: ClaimId): Promise<void> {
    await this.withLock(async () => {
      const session = await this.manager.loadSession();
      const claim = session.claims[closedClaimId];
      if (!claim) {
        return; // claim already pruned — nothing to attribute the hand-off to
      }
      const child = await this.manager.load(claim.childRunId);
      // A missing child state counts as terminal: the claim cannot still be open.
      const childTerminal =
        child === null || child.lifecycle === 'completed' || child.lifecycle === 'stopped';
      if (!childTerminal) {
        return; // claim still open; the OPEN_DELEGATED_CHILDREN guard covers this window
      }
      const top = session.defaultStack[session.defaultStack.length - 1];
      if (!top || top === claim.childRunId) {
        return; // no active runbook to guard, or the child is still the active top
      }
      if (!(await this.topDescendsFromParent(top, claim.parentRunId))) {
        return; // unrelated runbook on top — do not guard it (F1)
      }
      session.handoffPending = {
        handedOffAt: new Date().toISOString(),
        fromClaimId: closedClaimId,
        toRunId: top,
      };
      await this.manager.saveSession(session);
    });
  }

  /**
   * True when `top` is `parentRunId` or reaches it by walking parent linkage
   * (bounded). Used by {@link markClaimHandoff} to scope the barrier to the
   * claim's own pipeline.
   *
   * @param top - Default-active top runbook id
   * @param parentRunId - The claim's parent run id
   * @returns Whether `top` is or descends from `parentRunId`
   */
  private async topDescendsFromParent(top: RunId, parentRunId: RunId): Promise<boolean> {
    let current: RunId | undefined = top;
    for (let depth = 0; current !== undefined && depth < 64; depth += 1) {
      if (current === parentRunId) {
        return true;
      }
      const state = await this.manager.load(current);
      current = state?.parentLinkage?.parentRunId;
    }
    return false;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rundown-org/core test -- session-service.test.ts -t markClaimHandoff`
Expected: PASS (7 tests).

> Execution note: the integration test in Task 8 exercises the *real* inline advance. If it reveals that the inline-advanced stage does not carry `parentLinkage.parentRunId` back to the claim parent, the chain walk will (correctly) refuse to stamp and Task 8 will go red — at which point relax the constraint to match the real linkage topology, not the unit fixtures. The unit fixtures here assert the contract; Task 8 validates it against production wiring.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/session-service.ts packages/core/__tests__/runbook/session-service.test.ts
git commit -m "feat(core): markClaimHandoff stamps the hand-off barrier, parent-chain scoped (#460)"
```

---

## Task 3: `SessionService.readClaimHandoff` + `clearClaimHandoff`

**Files:**
- Modify: `packages/core/src/runbook/session-service.ts` (after `markClaimHandoff`)
- Test: `packages/core/__tests__/runbook/session-service.test.ts`

Read-only (no lock, consistent with `getActiveForClaimId`/`listOpenClaimsForParent`); returns the marker only when it matches the queried run. `clearClaimHandoff` removes it under the lock, idempotently.

- [ ] **Step 1: Write the failing test**

```typescript
describe('SessionService.readClaimHandoff / clearClaimHandoff', () => {
  const PARENT = `rd_${'a'.repeat(32)}` as RunId;
  const marker = { handedOffAt: '2026-06-16T00:00:00.000Z', fromClaimId: `rdclm_${'A'.repeat(22)}` as ClaimId, toRunId: PARENT };
  async function seedMarker(): Promise<void> {
    const session = await manager.loadSession();
    session.handoffPending = marker;
    await manager.saveSession(session);
  }

  it('returns the marker when it matches the queried active run', async () => {
    await seedMarker();
    expect((await sessionService.readClaimHandoff(PARENT))?.fromClaimId).toBe(marker.fromClaimId);
  });
  it('returns null when the marker points at a different run (stale)', async () => {
    await seedMarker();
    expect(await sessionService.readClaimHandoff(`rd_${'b'.repeat(32)}` as RunId)).toBeNull();
  });
  it('returns null when there is no marker', async () => {
    expect(await sessionService.readClaimHandoff(PARENT)).toBeNull();
  });
  it('clears the marker', async () => {
    await seedMarker();
    await sessionService.clearClaimHandoff();
    expect((await manager.loadSession()).handoffPending).toBeUndefined();
  });
  it('clearClaimHandoff is idempotent when no marker is present', async () => {
    await sessionService.clearClaimHandoff();
    expect((await manager.loadSession()).handoffPending).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rundown-org/core test -- session-service.test.ts -t readClaimHandoff`
Expected: FAIL — not a function.

- [ ] **Step 3: Implement both methods**

```typescript
  /**
   * Read the claim hand-off barrier for a candidate active runbook (issue #460).
   * Read-only (bypasses the session lock, consistent with {@link getActiveForClaimId}).
   * Returns the marker only when it guards `activeRunId`; a stale marker reads null.
   *
   * @param activeRunId - Default-active runbook the caller intends to act on
   * @returns The matching hand-off marker, or `null` when none applies
   */
  async readClaimHandoff(activeRunId: RunId): Promise<ClaimHandoff | null> {
    const session = await this.manager.loadSession();
    const marker = session.handoffPending;
    return marker && marker.toRunId === activeRunId ? marker : null;
  }

  /**
   * Clear the claim hand-off barrier (#460). Idempotent. Called from the
   * deliberate-resume sites (`--resume`, `goto`, top-level `run`).
   */
  async clearClaimHandoff(): Promise<void> {
    await this.withLock(async () => {
      const session = await this.manager.loadSession();
      if (session.handoffPending === undefined) {
        return;
      }
      delete session.handoffPending;
      await this.manager.saveSession(session);
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rundown-org/core test -- session-service.test.ts -t readClaimHandoff`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runbook/session-service.ts packages/core/__tests__/runbook/session-service.test.ts
git commit -m "feat(core): SessionService.readClaimHandoff/clearClaimHandoff (#460)"
```

---

## Task 4: Resolver — `claim_handoff_pending` in `resolveTransitionTarget`

Add the refusal to `TransitionTargetResolution` **only** (NOT the shared `CommandTargetResolution`, consumed by six exhaustive `default: never` switches).

**Files:**
- Modify: `packages/core/src/runbook/command-target-resolver.ts`
- Test: `packages/core/__tests__/runbook/command-target-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Extend the `fakeReader` factory (line 63) to accept `handoff` and supply `readClaimHandoff: async () => options.handoff ?? null`. Then:

```typescript
const ACTIVE = { id: `rd_${'a'.repeat(32)}` } as never;
const HANDOFF = { handedOffAt: '2026-06-16T00:00:00.000Z', fromClaimId: `rdclm_${'A'.repeat(22)}`, toRunId: `rd_${'a'.repeat(32)}` } as never;

describe('resolveTransitionTarget claim_handoff_pending', () => {
  it('refuses a bare transition when a hand-off marker guards the active run', async () => {
    expect((await resolveTransitionTarget(fakeReader({ active: ACTIVE, handoff: HANDOFF }), { command: 'pass' })).kind).toBe('claim_handoff_pending');
  });
  it('refuses a bare fail too (result-agnostic)', async () => {
    expect((await resolveTransitionTarget(fakeReader({ active: ACTIVE, handoff: HANDOFF }), { command: 'fail' })).kind).toBe('claim_handoff_pending');
  });
  it('exempts a targeted (--step) transition', async () => {
    expect((await resolveTransitionTarget(fakeReader({ active: ACTIVE, handoff: HANDOFF }), { command: 'pass', targeted: true })).kind).toBe('default');
  });
  it('exempts a claim-targeted transition', async () => {
    const reader = fakeReader({ claim: { status: 'claimed', claim: {}, state: ACTIVE }, handoff: HANDOFF });
    expect((await resolveTransitionTarget(reader, { command: 'pass', claimId: `rdclm_${'B'.repeat(22)}` as never })).kind).toBe('claim');
  });
  it('takes priority over the open-children refusal (checked first)', async () => {
    const reader = fakeReader({ active: ACTIVE, handoff: HANDOFF, openClaims: [{ claimId: 'x' }] as never });
    expect((await resolveTransitionTarget(reader, { command: 'pass' })).kind).toBe('claim_handoff_pending');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rundown-org/core test -- command-target-resolver.test.ts -t claim_handoff_pending`
Expected: FAIL.

- [ ] **Step 3: Add the import, reader method, and union variant**

In `command-target-resolver.ts`:

```typescript
// after line 3:
import type { ClaimHandoff } from './state.js';
```

Add to `CommandTargetReader` (after `listOpenClaimsForParent`, ~line 143):

```typescript
  /**
   * Read the one-shot claim hand-off barrier guarding a candidate active run.
   * @param activeRunId - Default-active runbook the command intends to act on
   * @returns The matching hand-off marker, or `null` when none applies
   */
  readClaimHandoff(activeRunId: RunId): Promise<ClaimHandoff | null>;
```

Add the variant to `TransitionTargetResolution` only (after `open_delegated_children`, ~line 78):

```typescript
  | { readonly kind: 'claim_handoff_pending'; readonly handoff: ClaimHandoff; readonly state: RunbookState };
```

- [ ] **Step 4: Fire the refusal in `resolveTransitionTarget`**

Replace the bare-only block (currently lines 287–296):

```typescript
  // `--step`-targeted transitions are deliberate and exempt from both bare-only
  // refusals (claim-targeted transitions already returned above).
  if (!options.targeted) {
    // Hand-off is checked before open-children: once a claim closes the parent
    // has advanced, so the open-children window is already past — the hand-off
    // refusal is the correct, more specific diagnostic.
    const handoff = await targetReader.readClaimHandoff(active.id);
    if (handoff) {
      return { kind: 'claim_handoff_pending', handoff, state: active };
    }
    const openClaims = await targetReader.listOpenClaimsForParent(active.id);
    if (openClaims.length > 0) {
      return { kind: 'open_delegated_children', parentRunId: active.id, claims: openClaims };
    }
  }

  return { kind: 'default', state: active };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @rundown-org/core test -- command-target-resolver.test.ts -t claim_handoff_pending`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/command-target-resolver.ts packages/core/__tests__/runbook/command-target-resolver.test.ts
git commit -m "feat(core): claim_handoff_pending refusal in resolveTransitionTarget (#460)"
```

---

## Task 5: Resolver — `resolveGuardedCommandTarget` (with `targeted` exemption)

`resolveCommandTarget` and its six callers stay untouched. The wrapper widens only for guarded callers AND honours a `targeted` flag so explicit `--step` deliberate commands are exempt (F3).

**Files:**
- Modify: `packages/core/src/runbook/command-target-resolver.ts`
- Modify: `packages/core/src/runbook/index.ts`
- Test: `packages/core/__tests__/runbook/command-target-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { resolveGuardedCommandTarget } from '../../src/runbook/command-target-resolver.js';

describe('resolveGuardedCommandTarget', () => {
  it('refuses when a marker guards the default-active run', async () => {
    expect((await resolveGuardedCommandTarget(fakeReader({ active: ACTIVE, handoff: HANDOFF }))).kind).toBe('claim_handoff_pending');
  });
  it('exempts a targeted (--step) command even under a barrier', async () => {
    expect((await resolveGuardedCommandTarget(fakeReader({ active: ACTIVE, handoff: HANDOFF }), { targeted: true })).kind).toBe('default');
  });
  it('resolves default when no marker is present', async () => {
    expect((await resolveGuardedCommandTarget(fakeReader({ active: ACTIVE }))).kind).toBe('default');
  });
  it('passes claim-id targeting straight through (exempt)', async () => {
    const reader = fakeReader({ claim: { status: 'claimed', claim: {}, state: ACTIVE }, handoff: HANDOFF });
    expect((await resolveGuardedCommandTarget(reader, { claimId: `rdclm_${'B'.repeat(22)}` as never })).kind).toBe('claim');
  });
  it('resolves none when there is no active runbook', async () => {
    expect((await resolveGuardedCommandTarget(fakeReader({ active: null }))).kind).toBe('none');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rundown-org/core test -- command-target-resolver.test.ts -t resolveGuardedCommandTarget`
Expected: FAIL — not exported.

- [ ] **Step 3: Add the option, type, and function**

Add `targeted` to `ResolveCommandTargetOptions` (~line 81):

```typescript
  /**
   * True when the caller supplied an explicit `--step` target. A deliberate,
   * targeted command is exempt from the claim hand-off refusal (#460).
   */
  readonly targeted?: boolean;
```

After `resolveCommandTarget` (~line 226):

```typescript
/**
 * Result of {@link resolveGuardedCommandTarget}: the base resolution widened with
 * the claim hand-off refusal. Only delegate/collect consume this; the six
 * unguarded `resolveCommandTarget` callers keep the narrow union.
 */
export type GuardedCommandTargetResolution =
  | CommandTargetResolution
  | { readonly kind: 'claim_handoff_pending'; readonly handoff: ClaimHandoff; readonly state: RunbookState };

/**
 * Resolve a command target, refusing with `claim_handoff_pending` when a one-shot
 * hand-off barrier guards the default-active run (issue #460). Used by the
 * overstep-prone mutating commands (`delegate`, `collect`). Explicit `--claim-id`
 * targeting, an explicit `--step` (`options.targeted`), and the non-default
 * outcomes pass through unguarded.
 *
 * @param targetReader - Read-side dependency used to read claim, default, and hand-off targets
 * @param options - Optional explicit claim id, stashed-visibility, and `targeted` flag
 * @returns The base resolution, or `claim_handoff_pending` when the barrier applies
 */
export async function resolveGuardedCommandTarget(
  targetReader: CommandTargetReader,
  options: ResolveCommandTargetOptions = {},
): Promise<GuardedCommandTargetResolution> {
  const base = await resolveCommandTarget(targetReader, options);
  if (base.kind !== 'default' || options.targeted === true) {
    return base; // non-default outcomes and deliberate --step targets pass through
  }
  const handoff = await targetReader.readClaimHandoff(base.state.id);
  return handoff ? { kind: 'claim_handoff_pending', handoff, state: base.state } : base;
}
```

- [ ] **Step 4: Export from core**

In `packages/core/src/runbook/index.ts`, beside `resolveCommandTarget` (~line 80):

```typescript
  resolveGuardedCommandTarget,
  type GuardedCommandTargetResolution,
```

- [ ] **Step 5: Run the test to verify it passes; verify core builds**

Run: `pnpm --filter @rundown-org/core test -- command-target-resolver.test.ts -t resolveGuardedCommandTarget && pnpm --filter @rundown-org/core build`
Expected: PASS; build clean (the six `default: never` switches over `CommandTargetResolution` untouched).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/command-target-resolver.ts packages/core/src/runbook/index.ts packages/core/__tests__/runbook/command-target-resolver.test.ts
git commit -m "feat(core): resolveGuardedCommandTarget with --step exemption (#460)"
```

---

## Task 6: Property test — the refusal-iff invariant

**Files:**
- Create: `packages/core/__tests__/runbook/claim-handoff.properties.test.ts`

- [ ] **Step 1: Write the property test**

```typescript
import fc from 'fast-check';
import {
  resolveTransitionTarget,
  resolveGuardedCommandTarget,
  type CommandTargetReader,
} from '../../src/runbook/command-target-resolver.js';

const rid = (c: string) => `rd_${c.repeat(32)}`;
const CLAIM = `rdclm_${'A'.repeat(22)}`;
function readerFor(handoffTo: string | null, activeId: string): CommandTargetReader {
  return {
    getActive: async () => ({ id: activeId }) as never,
    getActiveForClaimId: async () => ({ status: 'claimed', claim: {}, state: { id: activeId } }) as never,
    listOpenClaimsForParent: async () => [],
    readClaimHandoff: async (id) =>
      handoffTo && handoffTo === id
        ? ({ handedOffAt: '2026-06-16T00:00:00.000Z', fromClaimId: CLAIM, toRunId: handoffTo } as never)
        : null,
  };
}

describe('claim hand-off barrier — refusal-iff invariant (property)', () => {
  it('resolveTransitionTarget refuses iff matching marker AND not targeted AND no claimId', () => {
    fc.assert(
      fc.asyncProperty(
        fc.constantFrom('a', 'b'),
        fc.option(fc.constantFrom('a', 'b'), { nil: null }),
        fc.boolean(),
        fc.boolean(),
        async (activeKey, handoffKey, targeted, withClaim) => {
          const active = rid(activeKey);
          const result = await resolveTransitionTarget(readerFor(handoffKey ? rid(handoffKey) : null, active), {
            command: 'pass',
            targeted,
            ...(withClaim ? { claimId: `rdclm_${'B'.repeat(22)}` as never } : {}),
          });
          const shouldRefuse = handoffKey !== null && rid(handoffKey) === active && !targeted && !withClaim;
          expect(result.kind === 'claim_handoff_pending').toBe(shouldRefuse);
        },
      ),
    );
  });

  it('resolveGuardedCommandTarget refuses iff matching marker AND not targeted AND no claimId', () => {
    fc.assert(
      fc.asyncProperty(
        fc.constantFrom('a', 'b'),
        fc.option(fc.constantFrom('a', 'b'), { nil: null }),
        fc.boolean(),
        async (activeKey, handoffKey, targeted) => {
          const active = rid(activeKey);
          const result = await resolveGuardedCommandTarget(readerFor(handoffKey ? rid(handoffKey) : null, active), { targeted });
          const shouldRefuse = handoffKey !== null && rid(handoffKey) === active && !targeted;
          expect(result.kind === 'claim_handoff_pending').toBe(shouldRefuse);
        },
      ),
    );
  });
});
```

- [ ] **Step 2: Run the property test**

Run: `pnpm --filter @rundown-org/core test:property -- claim-handoff.properties.test.ts`
Expected: PASS. (Match the sibling command if property tests route differently, e.g. `claim-schema.properties.test.ts`.)

- [ ] **Step 3: Commit**

```bash
git add packages/core/__tests__/runbook/claim-handoff.properties.test.ts
git commit -m "test(core): property test for claim hand-off refusal-iff invariant (#460)"
```

---

## Task 7: CLI core wiring — emitter, result variants, `buildTransitionContext` params

**Files:**
- Modify: `packages/cli/src/helpers/transitions.ts`

- [ ] **Step 1: Add the error emitter**

After `emitOpenDelegatedChildrenError` (~line 471). Import `ClaimHandoff` from `@rundown-org/core`.

```typescript
/**
 * Emit the refusal for a command blocked by a claim hand-off barrier (#460). The
 * active runbook just became default-active because a claim closed; a bare
 * command would silently drive it. The actor must resume deliberately.
 *
 * @param output - Output emitter
 * @param command - The refused command name
 * @param handoff - The hand-off marker guarding the active run
 */
export function emitClaimHandoffPendingError(output: OutputEmitter, command: string, handoff: ClaimHandoff): void {
  output.error(
    `Cannot run bare rd ${command}: the active runbook was just handed off from closed claim ${handoff.fromClaimId}. If you are the claimed child, stop here. To act on a claimed child, use \`--claim-id <id>\`. To deliberately drive the parent, re-run with \`--resume\` or target a step with \`--step <id>\`.`,
    'CLAIM_HANDOFF_PENDING',
    { command, fromClaimId: handoff.fromClaimId, toRunId: handoff.toRunId },
  );
}
```

- [ ] **Step 2: Add the result variants**

Add to `BuildTransitionContextResult` (after `open_delegated_children`, ~line 187) and `BaseBuildTransitionContextResult` (~line 199):

```typescript
  | { readonly kind: 'claim_handoff_pending'; readonly handoff: ClaimHandoff };
```

- [ ] **Step 3: Thread `resume`, `guardHandoff`, and `step` (for `targeted`) through `buildTransitionContext`**

Add `readonly resume?: boolean;` to both overload option types + impl signature. Add `readonly guardHandoff?: boolean;` and (already present for pass/fail) ensure `step` is available on the **base** overload too, so collect can forward it.

After `const sessionService = new SessionService(manager);` (~line 249):

```typescript
  if (options.resume === true) {
    // Deliberate resume — drop the one-shot hand-off barrier before resolving (#460).
    await sessionService.clearClaimHandoff();
  }
```

In the pass/fail switch (line 263) add:

```typescript
      case 'claim_handoff_pending':
        return { kind: 'claim_handoff_pending', handoff: active.handoff };
```

In the base path (line 300), resolve via the guarded resolver when asked, forwarding `targeted`:

```typescript
    const active = options.guardHandoff
      ? await resolveGuardedCommandTarget(sessionService, {
          claimId: options.claimId,
          targeted: options.step !== undefined,
        })
      : await resolveCommandTarget(sessionService, { claimId: options.claimId });
    switch (active.kind) {
      case 'claim':
      case 'default':
        resolvedKind = active.kind;
        state = active.state;
        break;
      case 'claim_handoff_pending':
        return { kind: 'claim_handoff_pending', handoff: active.handoff };
      case 'none':
      case 'stale_claim':
      case 'terminal_claim':
        return active;
      default: {
        const _exhaustive: never = active;
        return _exhaustive;
      }
    }
```

Import `resolveGuardedCommandTarget` from `@rundown-org/core`.

- [ ] **Step 4: Verify the CLI typechecks**

Run: `pnpm --filter @rundown-org/cli build`
Expected: PASS (both switches exhaustive).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/helpers/transitions.ts
git commit -m "feat(cli): hand-off emitter, result variants, resume/guardHandoff/step plumbing (#460)"
```

---

## Task 8: CLI — stamp the marker after the parent advances (all four close paths)

**Files:**
- Modify: `packages/cli/src/helpers/transition-command.ts` (after `handleParentCompletion`, ~line 186)
- Modify: `packages/cli/src/commands/claim.ts` (~line 211), `commands/complete.ts` (~line 158), `commands/stop.ts` (~line 157) — **(F6)**
- Test: `packages/cli/__tests__/integration/claim-handoff-barrier.test.ts` (new)

- [ ] **Step 1: Write the failing integration tests**

Use the real harness (`createTestWorkspace`, synchronous `runCli`, raw session read). Implement `setupClaimedChildPipeline()` → `{ workspace, claimId }` with a two-stage parent (step 1 `- DELEGATE` leaf; step 2 normal) + leaf, parent default-active, leaf claimed. **Await every async assertion.**

```typescript
import { readFile } from 'node:fs/promises';
import { createTestWorkspace, runCli, parseCliJsonObject, type TestWorkspace } from '../helpers/test-utils.js';
import { ErrorResponseSchema } from '@rundown-org/core';

async function handoffMarker(ws: TestWorkspace): Promise<unknown> {
  const raw = JSON.parse(await readFile(ws.sessionPath(), 'utf-8')) as Record<string, unknown>;
  return raw.handoffPending;
}

describe('claim hand-off barrier (#460)', () => {
  it('stamps handoffPending after a claim-targeted PASS closes the child', async () => {
    const { workspace, claimId } = await setupClaimedChildPipeline();
    expect(runCli(['pass', '--claim-id', claimId], workspace).exitCode).toBe(0);
    expect(await handoffMarker(workspace)).toEqual(expect.objectContaining({ fromClaimId: claimId }));
  });

  it('stamps handoffPending after a claim-targeted FAIL closes the child', async () => {
    const { workspace, claimId } = await setupClaimedChildPipeline();
    runCli(['fail', '--claim-id', claimId], workspace);
    expect(await handoffMarker(workspace)).toEqual(expect.objectContaining({ fromClaimId: claimId }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/cli test -- claim-handoff-barrier.test.ts -t "stamps handoffPending"`
Expected: FAIL — marker `undefined`.

- [ ] **Step 3: Stamp after `handleParentCompletion` in `transition-command.ts`**

After the parent-propagation block (after line 186, before `if (shouldExitWithError)`):

```typescript
            // Claim closed and the parent (or its next inline stage) has now
            // advanced to become default-active. Stamp the one-shot hand-off
            // barrier so a still-running claimed child cannot silently drive that
            // stage (#460). Self-validating; only fires on a genuinely closed
            // claim with a parent-chain runbook on top. Runs only on the success
            // paths reached here — never after a thrown/failed transition.
            if (claimTarget.claimId !== undefined) {
              await ctx.sessionService.markClaimHandoff(claimTarget.claimId);
            }
```

- [ ] **Step 4: Stamp after `handleParentCompletion` in claim.ts, complete.ts, stop.ts (F6)**

In each, immediately after the `handleParentCompletion(...)` call, when the command targeted a claim (`claimId` in scope from the claim/`--claim-id` resolution), add:

```typescript
                // Claim closed and the parent advanced — stamp the hand-off barrier (#460).
                await sessionService.markClaimHandoff(<claimId>);
```

- `claim.ts:~211` — use the claim id from the successful `claim` result (auto-completion path).
- `complete.ts:~158` / `stop.ts:~157` — use `claimTarget.claimId` (guard `!== undefined`; bare `complete`/`stop` close the *active* runbook, not a claim, so they skip).

Use the `SessionService` already in scope in each command; construct `new SessionService(manager)` if none exists, consistent with surrounding code.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rundown-org/cli test -- claim-handoff-barrier.test.ts -t "stamps handoffPending"`
Expected: PASS (pass + fail). If the parent-chain constraint (Task 2) refuses to stamp here, the inline-advanced top lacks `parentLinkage` to the claim parent — relax the constraint to match the real topology (see Task 2 Step 5 note) and re-run.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/helpers/transition-command.ts packages/cli/src/commands/claim.ts packages/cli/src/commands/complete.ts packages/cli/src/commands/stop.ts packages/cli/__tests__/integration/claim-handoff-barrier.test.ts
git commit -m "feat(cli): stamp hand-off barrier on all four claim-close paths (#460)"
```

---

## Task 9: CLI — refuse bare pass/fail + `--resume`

**Files:**
- Modify: `packages/cli/src/helpers/transition-command.ts`
- Test: `packages/cli/__tests__/integration/claim-handoff-barrier.test.ts`

- [ ] **Step 1: Write the failing tests (pass AND fail; resume; non-blocking)**

```typescript
function expectHandoffRefusal(result: { stdout: string; stderr: string; exitCode: number }): void {
  expect(result.exitCode).toBe(1);
  const envelope = parseCliJsonObject(result.stdout || result.stderr);
  expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'CLAIM_HANDOFF_PENDING' }));
  expect(ErrorResponseSchema.safeParse(envelope).success).toBe(true);
}

it('refuses a bare pass against the auto-advanced parent after the claim closes', async () => {
  const { workspace, claimId } = await setupClaimedChildPipeline();
  runCli(['pass', '--claim-id', claimId], workspace);
  expectHandoffRefusal(runCli(['pass'], workspace));
});

it('refuses a bare fail against the auto-advanced parent after the claim closes', async () => {
  const { workspace, claimId } = await setupClaimedChildPipeline();
  runCli(['pass', '--claim-id', claimId], workspace);
  expectHandoffRefusal(runCli(['fail'], workspace));
});

it('lets the orchestrator resume deliberately with --resume (marker cleared)', async () => {
  const { workspace, claimId } = await setupClaimedChildPipeline();
  runCli(['pass', '--claim-id', claimId], workspace);
  expect(runCli(['pass', '--resume'], workspace).exitCode).toBe(0);
  expect(await handoffMarker(workspace)).toBeUndefined();
});

it('does not block rd status, rd stop, or rd stash under the barrier', async () => {
  const { workspace, claimId } = await setupClaimedChildPipeline();
  runCli(['pass', '--claim-id', claimId], workspace);
  expect(runCli(['status'], workspace).exitCode).toBe(0);
  expect(runCli(['stash'], workspace).exitCode).toBe(0);
  expect(runCli(['stop'], workspace).exitCode).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/cli test -- claim-handoff-barrier.test.ts -t "bare pass|bare fail"`
Expected: FAIL — bare pass/fail exit 0.

- [ ] **Step 3: Register `--resume`, pass it through, render the refusal**

In `registerTransitionCommand` (`transition-command.ts:53`):

```typescript
    .option('--resume', 'Clear a one-shot claim hand-off barrier and drive the parent')
```

Add `resume?: boolean` to the action options (line 63); pass `resume: options.resume` into `buildTransitionContext` (line 79). Add the refusal arm after `open_delegated_children` (~line 133):

```typescript
              case 'claim_handoff_pending':
                emitClaimHandoffPendingError(output, def.name, contextResult.handoff);
                output.flush();
                process.exitCode = 1;
                return;
```

Import `emitClaimHandoffPendingError` beside `emitOpenDelegatedChildrenError`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rundown-org/cli test -- claim-handoff-barrier.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/helpers/transition-command.ts packages/cli/__tests__/integration/claim-handoff-barrier.test.ts
git commit -m "feat(cli): refuse bare pass/fail under hand-off barrier; --resume clears (#460)"
```

---

## Task 10: CLI — guard delegate & collect (with `--step` exemption); clear on goto & run

**Files:**
- Modify: `packages/cli/src/commands/delegate.ts` (bare-inference path, line 116 only)
- Modify: `packages/cli/src/commands/collect.ts`
- Modify: `packages/cli/src/commands/run.ts`, `packages/cli/src/commands/goto.ts`
- Test: `packages/cli/__tests__/integration/claim-handoff-barrier.test.ts`

- [ ] **Step 1: Write the failing tests (incl. `--step` exemption, F3, and `--resume`, F5)**

```typescript
// "Not refused by the barrier" — the command may still fail for an unrelated
// reason (e.g. RD-813 not_delegatable when --step targets a non-delegate step),
// so assert only that the failure is NOT the hand-off refusal.
function expectNotHandoffRefusal(result: { stdout: string; stderr: string; exitCode: number }): void {
  if (result.exitCode === 0) return;
  const envelope = parseCliJsonObject(result.stdout || result.stderr);
  expect(envelope.code).not.toBe('CLAIM_HANDOFF_PENDING');
}

it('refuses bare rd delegate under the barrier; --resume bypasses the refusal', async () => {
  const { workspace, claimId } = await setupClaimedChildPipeline();
  runCli(['pass', '--claim-id', claimId], workspace);
  expectHandoffRefusal(runCli(['delegate'], workspace));
  expect(await handoffMarker(workspace)).toBeDefined();
  // --resume clears the barrier; delegate then resolves normally (it may still
  // fail downstream for non-barrier reasons, which is not what we assert here).
  expectNotHandoffRefusal(runCli(['delegate', '--resume'], workspace));
  expect(await handoffMarker(workspace)).toBeUndefined();
});

it('refuses bare rd collect under the barrier; --resume clears it', async () => {
  const { workspace, claimId } = await setupClaimedChildPipeline();
  runCli(['pass', '--claim-id', claimId], workspace);
  expectHandoffRefusal(runCli(['collect'], workspace));
  expectNotHandoffRefusal(runCli(['collect', '--resume'], workspace));
  expect(await handoffMarker(workspace)).toBeUndefined();
});

it('does NOT block delegate --step or collect --step under the barrier (F3)', async () => {
  const { workspace, claimId } = await setupClaimedChildPipeline();
  runCli(['pass', '--claim-id', claimId], workspace);
  // --step is a deliberate target → exempt from the barrier. These may error for
  // unrelated reasons (the fixture's step 2 is not a delegate substep), but they
  // must NOT be refused with CLAIM_HANDOFF_PENDING.
  expectNotHandoffRefusal(runCli(['delegate', '--step', '2'], workspace));
  expectNotHandoffRefusal(runCli(['collect', '--step', '2'], workspace));
});

it('rd goto clears the barrier', async () => {
  const { workspace, claimId } = await setupClaimedChildPipeline();
  runCli(['pass', '--claim-id', claimId], workspace);
  runCli(['goto', '2'], workspace);
  expect(await handoffMarker(workspace)).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/cli test -- claim-handoff-barrier.test.ts -t "delegate|collect|goto clears"`
Expected: FAIL.

- [ ] **Step 3: Guard the bare-inference path in `delegate.ts` (line 116 only)**

Replace the bare-inference `const state = await sessionService.getActive();` at `delegate.ts:116` with the guarded resolver, forwarding `targeted` from the command's `--step`; leave the `--retry` calls (507/563) untouched. Import `resolveGuardedCommandTarget` + `emitClaimHandoffPendingError`:

```typescript
const resolved = await resolveGuardedCommandTarget(sessionService, { targeted: options.step !== undefined });
if (resolved.kind === 'claim_handoff_pending') {
  emitClaimHandoffPendingError(output, 'delegate', resolved.handoff);
  output.flush();
  process.exitCode = 1;
  return;
}
const state = resolved.kind === 'default' || resolved.kind === 'claim' ? resolved.state : null;
// existing no-active handling below uses `state` exactly as before
```

Add `--resume` to the delegate builder (`.option('--resume', 'Clear a one-shot claim hand-off barrier and drive the parent')`); after `sessionService` is constructed, `if (options.resume) await sessionService.clearClaimHandoff();`.

- [ ] **Step 4: Guard `collect.ts` via `buildTransitionContext` (forward `--step`)**

`collect.ts:63` resolves through `buildTransitionContext(output, cwd, { claimId })`. Change to:

```typescript
const contextResult = await buildTransitionContext(output, cwd, {
  claimId,
  guardHandoff: true,
  step: options.step,        // forwards `targeted` inside buildTransitionContext (F3)
  resume: options.resume,
});
// in the switch:
case 'claim_handoff_pending':
  emitClaimHandoffPendingError(output, 'collect', contextResult.handoff);
  output.flush();
  process.exitCode = 1;
  return;
```

Add `--resume` to the collect builder.

- [ ] **Step 5: Clear on `goto` (command action) and top-level `run`**

In the `goto` command action (caller of `buildGotoContext`, `commands/goto.ts`), before building context:

```typescript
// A goto is an explicit, deliberate resume — clear any one-shot hand-off barrier (#460).
await sessionService.clearClaimHandoff();
```

Keep `buildGotoContext` read-only. In `commands/run.ts`, clear only on a top-level `rd run` (guard against the `--step` inline-child push):

```typescript
if (options.step === undefined) {
  // Starting a top-level runbook is an explicit hand-off — clear any stale barrier (#460).
  await sessionService.clearClaimHandoff();
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @rundown-org/cli test -- claim-handoff-barrier.test.ts`
Expected: PASS (all cases, incl. `--step` exemption).

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/delegate.ts packages/cli/src/commands/collect.ts packages/cli/src/commands/goto.ts packages/cli/src/commands/run.ts packages/cli/__tests__/integration/claim-handoff-barrier.test.ts
git commit -m "feat(cli): guard delegate/collect with --step exemption; clear on goto/run (#460)"
```

---

## Task 11: Concurrency test — mark vs clear under the session lock

**Files:**
- Modify: `packages/core/__tests__/runbook/session-service.test.ts`

`markClaimHandoff`/`clearClaimHandoff` both take `withLock`. Unlike `runGuardedParentAdvance` (which exposes an `advance` callback the line-983 test parks inside), these mutators have no injection seam, so a fully deterministic interleave isn't available without adding a test-only hook. Assert mutual exclusion via the observable invariant: concurrent mark+clear leave a **coherent, schema-valid** session (marker present XOR absent), never a torn write.

- [ ] **Step 1: Write the concurrency test**

```typescript
it('serializes concurrent markClaimHandoff and clearClaimHandoff (no torn session write)', async () => {
  const { parentRunId, claimId } = await setupClaimedChild('z', 'completed');
  await sessionService.pushRunbook(parentRunId);
  const other = new SessionService(new RunbookStateManager(testDir));

  // Race the two mutators repeatedly; the session lock must serialize each pair,
  // so loadSession always parses (no torn write) and the marker is present xor absent.
  for (let i = 0; i < 20; i += 1) {
    await Promise.all([sessionService.markClaimHandoff(claimId), other.clearClaimHandoff()]);
    const session = await manager.loadSession(); // throws if the file is torn / invalid
    expect(session.handoffPending === undefined || session.handoffPending.toRunId === parentRunId).toBe(true);
  }
});
```

> Honest limitation: this coherence loop catches a *torn/corrupt* write (`loadSession`'s schema parse would throw), but it does **not** reliably kill a dropped-`withLock` mutant — two un-serialized writes can still land last-writer-wins and leave a schema-valid session. For a guaranteed kill, add a test-only park hook to `withLock` mirroring the `releaseAdvance` seam at `session-service.test.ts:983` and assert the order log. Decide at execution time whether the determinism is worth the production-code test seam; the coherence loop is the floor.

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @rundown-org/core test -- session-service.test.ts -t "serializes concurrent"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/__tests__/runbook/session-service.test.ts
git commit -m "test(core): concurrency coverage for mark/clear hand-off under session lock (#460)"
```

---

## Task 12: Scenario test — delegation runbook fixture

**Files:**
- Create: `runbooks/delegation/claim-handoff-barrier.runbook.md` (+ leaf if needed)

- [ ] **Step 1: Write the scenario runbook**

Model on a sibling that asserts an error code (e.g. `runbooks/delegation/delegate-claim-explicit-close.runbook.md`). Confirm the `scenarios:` schema, the leaf reference convention, and that the expected-failure prefix is `"! rd ..."`.

```markdown
---
name: claim-handoff-barrier
description: A claimed child cannot drive the parent after its claim closes (#460)
tags: [delegation, regression]
scenarios:
  refuses-bare-pass-after-pass-close:
    description: Bare rd pass is refused after a PASS-closed claim auto-advances the parent
    commands:
      - rd run claim-handoff-barrier
      - rd claim ${TOKEN}
      - rd pass --claim-id ${CLAIM_ID}
      - "! rd pass"
    expect:
      errors:
        - code: CLAIM_HANDOFF_PENDING
          command: pass
  refuses-bare-after-fail-close:
    description: Bare commands are refused after a FAIL-closed claim advances the parent
    commands:
      - rd run claim-handoff-barrier
      - rd claim ${TOKEN}
      - rd fail --claim-id ${CLAIM_ID}
      - "! rd pass"
    expect:
      errors:
        - code: CLAIM_HANDOFF_PENDING
          command: pass
  refuses-bare-delegate-after-claim-close:
    description: Bare rd delegate is refused under the barrier (refusal precedes inference)
    commands:
      - rd run claim-handoff-barrier
      - rd claim ${TOKEN}
      - rd pass --claim-id ${CLAIM_ID}
      - "! rd delegate"
    expect:
      errors:
        - code: CLAIM_HANDOFF_PENDING
          command: delegate
  step-target-bypasses-barrier:
    description: An explicit --step target is exempt; it drives the parent to completion
    commands:
      - rd run claim-handoff-barrier
      - rd claim ${TOKEN}
      - rd pass --claim-id ${CLAIM_ID}
      - rd pass --step 2
    expect:
      result: COMPLETE
  resume-drives-parent:
    description: --resume clears the barrier and the parent proceeds
    commands:
      - rd run claim-handoff-barrier
      - rd claim ${TOKEN}
      - rd pass --claim-id ${CLAIM_ID}
      - rd pass --resume
    expect:
      result: COMPLETE
---

# Claim Hand-off Barrier

## 1. Delegate the leaf
- DELEGATE leaf
- FAIL CONTINUE

## 2. Parent stage
A normal step the child must not drive after its claim closes.
```

> Execution notes: (1) the `FAIL CONTINUE` handler on step 1 is what lets `refuses-bare-after-fail-close` advance the parent on a child failure — confirm the exact handler syntax against a sibling delegation fixture; without it a child FAIL would STOP the parent and there would be no active runbook to refuse. (2) `refuses-bare-delegate-after-claim-close` relies on the barrier firing in `resolveGuardedCommandTarget` *before* delegate inference, so the error is `CLAIM_HANDOFF_PENDING`, not `NOT_DELEGATE_STEP`. (3) Claim-time auto-completion (the `claim.ts` stamp path) is exercised by the integration suite rather than a scenario, because forcing a leaf to auto-complete on `rd claim` requires a zero-interaction leaf fixture; note this so the gap is intentional, not overlooked.

- [ ] **Step 2: Run the scenario suite**

Run the repo's scenario entry (confirm via a sibling delegation scenario test), or directly after a build:
`node packages/cli/dist/index.js scenario run runbooks/delegation/claim-handoff-barrier.runbook.md refuses-bare-pass-after-pass-close`
Expected: PASS — all five scenarios (run each, or `scenario-suite` if the fixture is wired as a suite).

- [ ] **Step 3: Commit**

```bash
git add runbooks/delegation/claim-handoff-barrier.runbook.md
git commit -m "test(runbooks): scenario coverage for claim hand-off barrier (#460)"
```

---

## Task 13: Docs + full verification

**Files:**
- Modify: `docs/reference/cli.md`

- [ ] **Step 1: Document the refusal and `--resume`**

In `docs/reference/cli.md`, near the `OPEN_DELEGATED_CHILDREN` / delegation section:

```markdown
### Claim hand-off barrier (`CLAIM_HANDOFF_PENDING`)

When a delegated claimed child closes its claim (`rd pass`/`fail`/`complete`/`stop --claim-id`),
the parent auto-advances and the next stage becomes default-active. To prevent a
still-running child from silently driving that stage, a one-shot barrier refuses
*bare* mutating commands (`pass`, `fail`, `delegate`, `collect`) against it:

- If you are the claimed child: stop — your claim is closed.
- To act on a claimed child (not the parent): use `--claim-id <id>` — it targets
  the child and is exempt from the barrier (the marker is left in place).
- To deliberately drive the parent: re-run with `--resume` (which **clears** the
  barrier), or target a step with `--step <id>` (which **bypasses** the refusal
  without clearing). `rd goto` and a top-level `rd run` also clear it.

`rd status`, `rd stop`, and `rd stash` are never blocked. This is
isolation-against-accident, not an adversarial boundary: an explicit `--step`
still drives the parent.
```

- [ ] **Step 2: Format / spell / fast lint**

Run: `pnpm run check:format && pnpm run check:spell && pnpm run check:lint:fast`
Expected: PASS.

- [ ] **Step 3: Full unit + property suites**

Run: `pnpm --filter @rundown-org/core test && pnpm --filter @rundown-org/core test:property && pnpm --filter @rundown-org/cli test`
Expected: PASS.

- [ ] **Step 4: Pre-PR verification**

Run: `pnpm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/reference/cli.md
git commit -m "docs(cli): document CLAIM_HANDOFF_PENDING barrier and --resume (#460)"
```

---

## Self-Review Notes

- **Spec coverage:** SET on all four claim-close paths — `pass`/`fail --claim-id` (transition-command), `complete`/`stop --claim-id`, claim-time auto-completion (Task 8) ↔ refuse bare pass/fail (Tasks 4, 9) ↔ refuse bare delegate/collect with `--step` exemption (Tasks 5, 7, 10) ↔ CLEAR on `--resume`/goto/top-level run (Tasks 3, 7, 10) ↔ property invariant (Task 6) ↔ concurrency (Task 11) ↔ scenario (Task 12) ↔ end-to-end acceptance (Tasks 8–10).
- **Type consistency:** `ClaimHandoff` (`handedOffAt`/`fromClaimId`/`toRunId`, all `readonly`) used identically; `fromClaimId` branded via `ClaimIdSchema`. Refusal kind `claim_handoff_pending`; error code `CLAIM_HANDOFF_PENDING` (registered in `zod-schemas.ts`, Task 1). Guarded resolver `resolveGuardedCommandTarget` → `GuardedCommandTargetResolution`.
- **No de-exhaustion:** refusal variant added to `TransitionTargetResolution` + `GuardedCommandTargetResolution` only, never the shared `CommandTargetResolution`; the six `default: never` switches are untouched; the two `buildTransitionContext` switches get matching arms (Task 7).
- **No-migration rule:** `handoffPending` optional on `session.json`; existing sessions parse unchanged.
- **Clear vs bypass semantics (F2):** `--resume`/`goto`/top-level `run` **clear** the marker; explicit `--step`/`--claim-id` **bypass** it (the marker persists, continuing to guard later bare commands — the safer behaviour). Docs and the walkthrough state diagram state this precisely; they do not claim explicit targets "clear."
- **Mis-stamp scope (F1):** `markClaimHandoff` stamps only a runbook that is the claim's parent or descends from it via `parentLinkage` (`topDescendsFromParent`), so an unrelated runbook the orchestrator switched to (e.g. after a stash) is never barred. Pinned by the Task 2 negative test.
- **Known limitation — stamp/advance non-atomicity (F7):** the parent advance (`handleParentCompletion`) and the marker stamp (`markClaimHandoff`) are separate lock acquisitions, not one critical section. For the #460 scenario — one child process acting sequentially — there is no race. A second process firing a bare command in the sub-millisecond window between the two is covered by `OPEN_DELEGATED_CHILDREN` while the claim is open; afterward the residual window is accepted, consistent with the isolation-against-accident (non-adversarial) threat model. Not closed by this plan.
- **Threat-model caveat:** isolation-against-accident — an actor that deliberately passes `--step`/`--resume` can still drive the parent. Intended, matching the removed `RD_AGENT_ID` model's documented stance.
- **Execution-time confirmations:** the `setupClaimedChild`/`setupClaimedChildPipeline` shapes (Tasks 2, 8), the `claim.ts`/`complete.ts`/`stop.ts` stamp scope and in-scope claim-id variable (Task 8 Step 4), the `goto.ts`/`run.ts` action structure (Task 10 Step 5), the real inline-advance linkage topology (Task 2 Step 5 / Task 8 Step 5), and the scenario schema/runner entry (Task 12) must be matched to live code; each step states its fixed contract so a mismatch is caught by the red/green gate.
```
