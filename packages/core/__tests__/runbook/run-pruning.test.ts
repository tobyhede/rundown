import { describe, expect, it } from '@jest/globals';
import {
  CURRENT_CHILD_PROTECTED_CODE,
  childProtection,
  planPrune,
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

/** The parent protecting `run` within `runs`, or `undefined`. */
async function protectingParentOf(
  run: VersionedRunState,
  runs: readonly VersionedRunState[],
  load: PrunePlanInput['loadSteps'],
): Promise<VersionedRunState | undefined> {
  const protection = await childProtection(runs, load)(run);
  return protection.kind === 'protected' ? protection.parent : undefined;
}

/** The human who confirmed a delete, as the front end records them. */
const AUDIT = { at: '2026-10-14T00:00:00.000Z', user: 'ada', host: 'desk' } as const;

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

/** The `detail` of each retained run that carries one. */
function detailsOf(result: PrunePlan): string[] {
  if (result.kind !== 'planned') return [];
  return result.retained.flatMap((kept) => ('detail' in kept ? [kept.detail] : []));
}

describe('childProtection', () => {
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
        confirmRunning: (deletion) => {
          asked.push(deletion.root.state.id);
          return Promise.resolve(AUDIT);
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
      planned(await plan({ runs: [other], confirmRunning: () => Promise.resolve(undefined) }))
        .retained,
    ).toEqual([[OTHER, 'not confirmed']]);
  });

  it('does not ask about a running run whose chain holds an attempt In Progress', async () => {
    const leased = run(OTHER, { lease: LIVE_LEASE });
    const asked: RunId[] = [];

    const result = planned(
      await plan({
        runs: [leased],
        confirmRunning: (deletion) => {
          asked.push(deletion.root.state.id);
          return Promise.resolve(AUDIT);
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

  describe('when a prune deletes a Delegation’s parent (protection ends with it)', () => {
    const terminalChild = () =>
      run(CHILD, { lifecycle: 'completed', linkage: linkage('delegation', '1.2') });

    it('deletes a terminal child the selection picks with the parent its token names, never reporting it uncollected', async () => {
      const parent = delegatingParent();

      expect(planned(await plan({ runs: [parent, terminalChild()], owned: parent }))).toEqual({
        deleted: [PARENT, CHILD],
        retained: [],
      });
    });

    it('deletes it with a parent the human confirmed', async () => {
      const parent = delegatingParent();

      const result = planned(
        await plan({
          runs: [parent, terminalChild()],
          confirmRunning: () => Promise.resolve(AUDIT),
        }),
      );

      expect(result).toEqual({ deleted: [PARENT, CHILD], retained: [] });
    });

    it('leaves a terminal child the selection does not pick, unreported', async () => {
      const parent = delegatingParent();
      const none = { running: false, completed: false, stopped: false, abandoned: false };

      expect(
        planned(await plan({ runs: [parent, terminalChild()], owned: parent, select: none })),
      ).toEqual({ deleted: [PARENT], retained: [] });
    });

    it('never deletes a running child with its parent: it is kept as a child run, with the recoveries left to it', async () => {
      const parent = delegatingParent();
      const child = run(CHILD, { linkage: linkage('delegation', '1.2') });

      const result = await plan({ runs: [parent, child], owned: parent });

      expect(planned(result)).toEqual({ deleted: [PARENT], retained: [[CHILD, 'child run']] });
      const [detail] = detailsOf(result);
      expect(detail).toContain(`rundown release ${CHILD}`);
      expect(detail).not.toContain('retry');
    });

    it('keeps the child uncollected when the parent’s own delete is refused under the lease', async () => {
      const leasedParent = { ...delegatingParent(), lease: LIVE_LEASE };

      const result = planned(
        await plan({
          runs: [leasedParent, terminalChild()],
          confirmRunning: () => Promise.resolve(AUDIT),
        }),
      );

      expect(result).toEqual({
        deleted: [],
        retained: [
          [PARENT, 'execution in progress'],
          [CHILD, 'uncollected'],
        ],
      });
    });
  });

  describe('a running run without its token', () => {
    it('is confirmable only when top-level: a running child is kept as a child run, and nobody is asked', async () => {
      // The parent finished, so the Delegation is no longer its Current Child.
      const parent = run(PARENT, { lifecycle: 'stopped' });
      const child = run(CHILD, { linkage: linkage('delegation', '1.2') });
      const asked: RunId[] = [];

      const result = await plan({
        runs: [parent, child],
        select: { ...ALL, stopped: false },
        confirmRunning: (deletion) => {
          asked.push(deletion.root.state.id);
          return Promise.resolve(AUDIT);
        },
      });

      expect(asked).toEqual([]);
      expect(planned(result)).toEqual({ deleted: [], retained: [[CHILD, 'child run']] });
      const [detail] = detailsOf(result);
      expect(detail).toContain('rundown stop --token');
      // Its parent finished, so no `retry` of the parent reaches it.
      expect(detail).not.toContain('retry');
    });

    it('records who confirmed its delete, and when, on the planned delete', async () => {
      const other = run(OTHER);

      const result = await plan({ runs: [other], confirmRunning: () => Promise.resolve(AUDIT) });

      expect(result.kind === 'planned' ? result.deletions : []).toEqual([
        expect.objectContaining({ root: other, confirmedBy: AUDIT }),
      ]);
    });
  });

  describe('a parent whose runbook cannot be read', () => {
    const unreadable = () => {
      throw new Error('parse failed');
    };

    it('keeps its Delegations protected, with the reason, and still prunes everything else', async () => {
      const parent = delegatingParent();
      const child = run(CHILD, { lifecycle: 'completed', linkage: linkage('delegation', '1.2') });
      const finished = run(OTHER, { lifecycle: 'completed' });

      const result = await plan({ runs: [parent, child, finished], loadSteps: unreadable });

      expect(planned(result)).toEqual({
        deleted: [OTHER],
        retained: [
          [PARENT, 'token required'],
          [CHILD, 'parent unreadable'],
        ],
      });
      expect(detailsOf(result)).toEqual([expect.stringContaining('parse failed')]);
    });

    it('refuses --token naming such a child CURRENT_CHILD_PROTECTED, deleting nothing', async () => {
      const parent = delegatingParent();
      const child = run(CHILD, { lifecycle: 'completed', linkage: linkage('delegation', '1.2') });

      const result = await plan({ runs: [parent, child], owned: child, loadSteps: unreadable });

      expect(result).toEqual({
        kind: 'refused',
        refusal: expect.objectContaining({ code: CURRENT_CHILD_PROTECTED_CODE, runId: CHILD }),
      });
    });

    it('parses each parent once, however many children it has', async () => {
      const parent = delegatingParent();
      const child = run(CHILD, { lifecycle: 'completed', linkage: linkage('delegation', '1.2') });
      const sibling = run(OTHER, { lifecycle: 'completed', linkage: linkage('delegation', '1.2') });
      let parses = 0;

      await plan({
        runs: [parent, child, sibling],
        loadSteps: () => {
          parses += 1;
          return STEPS;
        },
      });

      expect(parses).toBe(1);
    });
  });
});
