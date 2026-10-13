import { describe, expect, it } from '@jest/globals';
import {
  CURRENT_CHILD_PROTECTED_CODE,
  planPrune,
  protectingParentOf,
  type PrunePlan,
  type PrunePlanInput,
} from '../../src/runbook/run-pruning.js';
import type { ChildLinkage, RunLinkage } from '../../src/runbook/child-linkage.js';
import type { ExecutionLease } from '../../src/runbook/execution-lease.js';
import { createProcessIdentity } from '../../src/runbook/process-identity.js';
import { assertRunId, type RunId } from '../../src/runbook/run-id.js';
import type { StateVersion } from '../../src/runbook/storage/mutation-result.js';
import type { VersionedRunState } from '../../src/runbook/storage/runbook-store.js';
import type { FrameKey } from '../../src/runbook/targeting.js';
import type { ChildReservation, Lifecycle, RunbookState } from '../../src/runbook/types.js';
import { createRunbook } from './fixtures.js';

/**
 * Core's one prune rule (#906): which selected runs a prune deletes, and why
 * it keeps the rest. Pure over one listing, so the runs are built by hand; the
 * CLI suite (`prune-protection.test.ts`) drives the same rule through real
 * reservations, claims and Collects.
 */

const PARENT = assertRunId(`rd_${'a'.repeat(32)}`);
const CHILD = assertRunId(`rd_${'c'.repeat(32)}`);
const OTHER = assertRunId(`rd_${'d'.repeat(32)}`);
const FRAME = '1|' as FrameKey;

// Step 1 composes an Inline Child at 1.1 and a Delegation at 1.2.
const STEPS = createRunbook(`## 1. Compose
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Inline
- child.runbook.md

### 1.2 Delegated
- DELEGATE
- other.runbook.md

## 2. Plain
- PASS COMPLETE

Done.
`);

const identity = createProcessIdentity(() => 'self-start');

/** A lease held by another live process: In Progress. */
const LIVE_LEASE: ExecutionLease = {
  attempt: 4,
  pid: process.ppid,
  startId: 'self-start',
  startedAt: '2026-10-14T00:00:00.000Z',
};

function run(
  id: RunId,
  options: {
    readonly lifecycle?: Lifecycle;
    readonly linkage?: RunLinkage | null;
    readonly substep?: string;
    readonly reserved?: { readonly substep: string; readonly child: ChildReservation };
    readonly lease?: ExecutionLease | null;
  } = {},
): VersionedRunState {
  const state = {
    id,
    runbook: { source: 'project', path: `${id}.runbook.md` },
    step: '1',
    substep: options.substep ?? '1',
    activeFrameKey: FRAME,
    activeEntry: 1,
    forStack: [],
    lifecycle: options.lifecycle ?? 'running',
    substepStates:
      options.reserved === undefined
        ? []
        : [
            {
              id: options.reserved.substep,
              frameKey: FRAME,
              status: 'running',
              child: options.reserved.child,
            },
          ],
  } as unknown as RunbookState;
  return {
    state,
    stateVersion: 1 as StateVersion,
    lease: options.lease ?? null,
    linkage: options.linkage ?? null,
  };
}

function linkage(kind: ChildLinkage['kind'], parentStep: string): ChildLinkage {
  return { kind, parentRunId: PARENT, parentStep, parentFrameKey: FRAME, parentEntry: 1 };
}

/** A parent resting on 1.1 whose reservation there names `CHILD`. */
function inlineParent(
  overrides: { readonly lifecycle?: Lifecycle; readonly lease?: ExecutionLease } = {},
) {
  return run(PARENT, {
    ...overrides,
    substep: '1',
    reserved: {
      substep: '1',
      child: { kind: 'inline', runId: CHILD, entry: 1, runbook: 'child.runbook.md' },
    },
  });
}

/** A parent resting on 1.2 whose Delegation there is `CHILD`. */
function delegatingParent(collected?: 'pass' | 'fail') {
  return run(PARENT, {
    substep: '2',
    reserved: {
      substep: '2',
      child: {
        kind: 'delegation',
        runId: CHILD,
        entry: 1,
        runbook: 'other.runbook.md',
        contextSnapshot: { vars: {}, ancestors: [] },
        ticketHash: null,
        ...(collected !== undefined ? { collected } : {}),
      } as unknown as ChildReservation,
    },
  });
}

const loadSteps = () => STEPS;

const ALL = { running: true, completed: true, stopped: true, abandoned: true } as const;
const FINISHED = { running: false, completed: true, stopped: true, abandoned: false } as const;

function plan(input: Partial<PrunePlanInput> & Pick<PrunePlanInput, 'runs'>): Promise<PrunePlan> {
  return planPrune({ select: ALL, owned: null, loadSteps, processIdentity: identity, ...input });
}

function planned(result: PrunePlan) {
  if (result.kind !== 'planned') throw new Error(`refused: ${result.refusal.message}`);
  return {
    deleted: result.deletions.flatMap((deletion) =>
      [deletion.root, ...deletion.inlineDescendants].map((listed) => listed.state.id),
    ),
    retained: result.retained.map(({ run: listed, reason }) => [listed.state.id, reason]),
  };
}

describe('protectingParentOf', () => {
  it('protects an Inline Child while its running parent’s cursor names it', async () => {
    const parent = inlineParent();
    const child = run(CHILD, { lifecycle: 'completed', linkage: linkage('inline', '1.1') });

    expect(await protectingParentOf(child, [parent, child], loadSteps)).toBe(parent);
  });

  it('ends an Inline Child’s protection when the parent finishes, or names another child', async () => {
    const child = run(CHILD, { lifecycle: 'completed', linkage: linkage('inline', '1.1') });
    const finished = inlineParent({ lifecycle: 'stopped' });
    const moved = run(PARENT, {
      substep: '1',
      reserved: {
        substep: '1',
        child: { kind: 'inline', runId: OTHER, entry: 1, runbook: 'child.runbook.md' },
      },
    });

    expect(await protectingParentOf(child, [finished, child], loadSteps)).toBeUndefined();
    expect(await protectingParentOf(child, [moved, child], loadSteps)).toBeUndefined();
    expect(await protectingParentOf(child, [child], loadSteps)).toBeUndefined();
  });

  it('protects a Delegation its parent would still Collect, and not once Collected', async () => {
    const child = run(CHILD, { lifecycle: 'completed', linkage: linkage('delegation', '1.2') });
    const counting = delegatingParent();

    expect(await protectingParentOf(child, [counting, child], loadSteps)).toBe(counting);
    expect(
      await protectingParentOf(child, [delegatingParent('pass'), child], loadSteps),
    ).toBeUndefined();
  });

  it('never protects a top-level run or a Delegation whose parent was pruned', async () => {
    const orphan = run(CHILD, {
      lifecycle: 'completed',
      linkage: {
        kind: 'orphaned_delegation',
        parentStep: '1.2',
        parentFrameKey: FRAME,
        parentEntry: 1,
      },
    });

    expect(await protectingParentOf(run(OTHER), [run(OTHER)], loadSteps)).toBeUndefined();
    expect(await protectingParentOf(orphan, [orphan], loadSteps)).toBeUndefined();
  });
});

describe('planPrune', () => {
  it('refuses the owned run CURRENT_CHILD_PROTECTED when its parent still counts it', async () => {
    const parent = delegatingParent();
    const child = run(CHILD, { lifecycle: 'completed', linkage: linkage('delegation', '1.2') });

    const result = await plan({ runs: [parent, child], owned: child });

    expect(result).toEqual({
      kind: 'refused',
      refusal: expect.objectContaining({
        kind: 'current_child_protected',
        code: CURRENT_CHILD_PROTECTED_CODE,
        runId: CHILD,
        parentRunId: PARENT,
        parentStep: '1.2',
      }),
    });
  });

  it('retains a terminal Current Child "uncollected" and a running one "current child"', async () => {
    const parent = inlineParent();
    for (const [lifecycle, reason] of [
      ['completed', 'uncollected'],
      ['running', 'current child'],
    ] as const) {
      const child = run(CHILD, { lifecycle, linkage: linkage('inline', '1.1') });
      expect(planned(await plan({ runs: [parent, child] })).retained).toEqual([
        [PARENT, 'token required'],
        [CHILD, reason],
      ]);
    }
  });

  it('deletes a protected child with the owned parent, reporting it deleted, not retained', async () => {
    const parent = inlineParent();
    const child = run(CHILD, { lifecycle: 'completed', linkage: linkage('inline', '1.1') });

    expect(planned(await plan({ runs: [parent, child], owned: parent }))).toEqual({
      deleted: [PARENT, CHILD],
      retained: [],
    });
  });

  it('asks about a running top-level run, but never a running Inline Child, which goes with its root', async () => {
    const parent = run(PARENT, { lifecycle: 'stopped' });
    const strayChild = run(CHILD, { linkage: linkage('inline', '1.1') });
    const other = run(OTHER);
    const asked: RunId[] = [];

    const result = planned(
      await plan({
        runs: [parent, strayChild, other],
        confirmRunning: (listed) => {
          asked.push(listed.state.id);
          return Promise.resolve(true);
        },
      }),
    );

    expect(asked).toEqual([OTHER]);
    expect(result).toEqual({ deleted: [PARENT, CHILD, OTHER], retained: [] });
  });

  it('keeps a running run "token required" with no human, and "not confirmed" when declined', async () => {
    const other = run(OTHER);

    expect(planned(await plan({ runs: [other] })).retained).toEqual([[OTHER, 'token required']]);
    expect(
      planned(await plan({ runs: [other], confirmRunning: () => Promise.resolve(false) })).retained,
    ).toEqual([[OTHER, 'not confirmed']]);
  });

  it('does not ask about a running run whose chain holds an attempt In Progress', async () => {
    const leased = run(OTHER, { lease: LIVE_LEASE });
    const asked: RunId[] = [];

    const result = planned(
      await plan({
        runs: [leased],
        confirmRunning: (listed) => {
          asked.push(listed.state.id);
          return Promise.resolve(true);
        },
      }),
    );

    expect(asked).toEqual([]);
    expect(result.retained).toEqual([[OTHER, 'execution in progress']]);
  });

  it('selects only the lifecycles the filter names', async () => {
    const completed = run(OTHER, { lifecycle: 'completed' });
    const abandoned = run(CHILD, { lifecycle: 'abandoned' });
    const running = run(PARENT);

    expect(
      planned(await plan({ runs: [completed, abandoned, running], select: FINISHED })),
    ).toEqual({ deleted: [OTHER], retained: [] });
  });
});
