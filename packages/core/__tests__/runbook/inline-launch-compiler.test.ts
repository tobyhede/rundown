import { describe, expect, it } from '@jest/globals';
import { createActor, waitFor } from 'xstate';

import { compileRunbookToMachine, PENDING_MACHINE_EFFECT_TAG } from '../../src/runbook/compiler.js';
import type { RunbookContext } from '../../src/runbook/compiler.js';
import type { ResolveInlineRunbook } from '../../src/runbook/actors/inline-launch-intent-actor.js';
import { assertRunId, type RunId } from '../../src/runbook/run-id.js';
import type { SubstepState } from '../../src/runbook/types.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { brandFlattenedTemplateVarsForTest } from '../../src/testing/effective-vars.js';
import { makeDelegationCredentialIssuer } from '../../src/testing/delegation-fixtures.js';
import { createRunbook } from './fixtures.js';

type InlineLaunchCompilerOptions = NonNullable<Parameters<typeof compileRunbookToMachine>[1]> & {
  readonly resolveInlineRunbook: ResolveInlineRunbook;
  readonly generateChildRunId: () => RunId;
  readonly now: () => string;
};

/**
 * The latch an inline launcher commits: the instant and the owning process.
 *
 * One value rather than two fields, because a start with no owner cannot be
 * checked for liveness — which is the whole basis on which a later observer
 * decides whether the launch may be taken over.
 */
const LATCHED = {
  at: '2026-05-30T00:00:01.000Z',
  ownerPid: 4242,
  ownerStartId: 'start-id-4242',
} as const;

function childResolver(): ResolveInlineRunbook {
  return async (runbookRef) => ({
    path: 'runbooks/child.runbook.md',
    runbookRef,
    childRunbookRef: { source: 'project', path: 'runbooks/child.runbook.md' },
  });
}

describe('inline launch compiler integration', () => {
  it('prepares inline launch intent for non-DELEGATE runbook-list substeps', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    expect(steps[0]).toMatchObject({
      kind: 'substeps',
      substeps: [expect.objectContaining({ description: 'Runbook: child.runbook.md' })],
    });
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const options: InlineLaunchCompilerOptions = {
      templateVars: brandFlattenedTemplateVarsForTest({
        RunId: 'rd_cccccccccccccccccccccccccccccccc',
      }),
      resolveInlineRunbook: childResolver(),
      generateChildRunId: () => childRunId,
      now: () => '2026-05-30T00:00:00.000Z',
    };

    const actor = createActor(compileRunbookToMachine(steps, options));
    actor.start();

    const snapshot = await waitFor(
      actor,
      (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG),
      { timeout: 500 },
    );
    const context = snapshot.context as RunbookContext & {
      readonly inlineLaunchIntent?: unknown;
    };

    expect(context.inlineLaunchIntent).toMatchObject({
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      childRunId: 'rd_dddddddddddddddddddddddddddddddd',
      childRunbookPath: 'runbooks/child.runbook.md',
    });
    expect(context.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        frameKey: '1|',
        status: 'running',
        inline: expect.objectContaining({
          childRunId: 'rd_dddddddddddddddddddddddddddddddd',
        }),
      }),
    );

    actor.stop();
  });

  it('fails closed when an inline child runbook leaf has no resolver', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);

    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
      }),
    );
    actor.start();

    const snapshot = await waitFor(
      actor,
      (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG),
      { timeout: 500 },
    );

    expect(snapshot.context.lifecycle).toBe('stopped');
    expect(snapshot.context.lastAction).toMatchObject({
      type: 'INLINE_LAUNCH_FAILED',
      reason: 'inline_launch_failed',
      message: expect.stringContaining('Inline child runbook resolver is not configured'),
    });
    expect(snapshot.context.inlineLaunchIntent).toBeUndefined();

    actor.stop();
  });

  it('marks inline child start and keeps launch intent until consumed', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    actor.send({
      type: 'INLINE_CHILD_STARTED',
      parentStepId: '1',
      parentFrameKey: buildFrameKey('1'),
      childRunId,
      started: LATCHED,
    });

    const context = actor.getSnapshot().context;
    expect(context.inlineLaunchIntent).toMatchObject({
      parentStepId: '1',
      parentFrameKey: '1|',
      childRunId,
    });
    expect(context.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        frameKey: '1|',
        inline: expect.objectContaining({
          childRunId,
          started: LATCHED,
        }),
      }),
    );

    actor.send({ type: 'INLINE_LAUNCH_CONSUMED' });

    // Consuming the intent RELEASES the latch: it is held for the launch span
    // and no longer. Left in place, a completed launch would read as one still
    // in progress — a re-entry in the same process would find its own live pid
    // on it and stand down forever, and one in a later process would report
    // reclaiming a launch nobody crashed out of.
    const consumedContext = actor.getSnapshot().context;
    expect(consumedContext.inlineLaunchIntent).toBeUndefined();
    expect(consumedContext.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        frameKey: '1|',
        // Everything else about the launch survives — the child id is what a
        // later re-entry matches against, so releasing must not erase it.
        inline: expect.objectContaining({
          childRunId,
          started: null,
        }),
      }),
    );

    actor.stop();
  });

  // The failure counterpart of the event above, and the asymmetry is the whole
  // reason it is a separate event rather than a second caller of the same one.
  //
  // `INLINE_LAUNCH_CONSUMED` drops both the latch and the intent, because the
  // launch is over. A span that took the latch and then FAILED out of it must
  // drop only the latch: the launch is not over, and the surviving intent is
  // exactly what makes it re-observable. Clearing the intent here would trade a
  // permanently-latched launch for a permanently-lost one.
  it('releases the latch without clearing the intent when a launch span is abandoned', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    actor.send({
      type: 'INLINE_CHILD_STARTED',
      parentStepId: '1',
      parentFrameKey: buildFrameKey('1'),
      childRunId,
      started: LATCHED,
    });

    actor.send({ type: 'INLINE_LAUNCH_ABANDONED' });

    const abandoned = actor.getSnapshot().context;
    // The intent stays, still naming the same child, so the next observer reads
    // an unlatched launch it can win and finish.
    expect(abandoned.inlineLaunchIntent).toMatchObject({
      parentStepId: '1',
      parentFrameKey: '1|',
      childRunId,
    });
    expect(abandoned.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        frameKey: '1|',
        inline: expect.objectContaining({ childRunId, started: null }),
      }),
    );

    actor.stop();
  });

  // Root-level and idempotent, like every other latch event: the CLI releases
  // through a scope disposer, and a disposer that fires against a launch which
  // has already been consumed — or abandoned twice by a retried send — must not
  // corrupt the row it lands on.
  it('is a no-op when the launch it abandons holds no latch', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    const before = actor.getSnapshot().context;

    // Never latched, so there is nothing to release.
    actor.send({ type: 'INLINE_LAUNCH_ABANDONED' });

    const after = actor.getSnapshot().context;
    expect(after.substepStates).toEqual(before.substepStates);
    expect(after.inlineLaunchIntent).toEqual(before.inlineLaunchIntent);

    actor.stop();
  });

  // The release is scoped to the launch the consumed intent names, not to
  // "whatever inline row is at that coordinate". A row that has moved on to a
  // different child belongs to a different launch, whose latch is not this
  // event's to clear.
  it('leaves a latch belonging to a different child run untouched on consume', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    actor.send({
      type: 'INLINE_CHILD_STARTED',
      parentStepId: '1',
      parentFrameKey: buildFrameKey('1'),
      childRunId,
      started: LATCHED,
    });
    // The row moves to a different launch between the latch and the consume.
    actor.send({
      type: 'MANUAL_DELEGATION_ABORT_PREPARED',
      substepStates: (actor.getSnapshot().context.substepStates ?? []).map((substepState) =>
        substepState.inline
          ? {
              ...substepState,
              inline: {
                ...substepState.inline,
                childRunId: assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
              },
            }
          : substepState,
      ),
    });

    actor.send({ type: 'INLINE_LAUNCH_CONSUMED' });

    const consumedContext = actor.getSnapshot().context;
    expect(consumedContext.inlineLaunchIntent).toBeUndefined();
    expect(consumedContext.substepStates?.[0]?.inline?.started).toEqual(LATCHED);

    actor.stop();
  });

  // The rows the release must not touch, and the states it must survive. Each
  // case replaces the substep array between the latch and the consume, which is
  // the only way a row can diverge from the intent that named it — and the
  // release reads the row, so every divergence is a way it could clear the wrong
  // latch or throw on a row that is not there.
  it.each<{
    readonly name: string;
    readonly rows: (row: SubstepState) => readonly SubstepState[];
    readonly assert: (rows: readonly SubstepState[] | undefined) => void;
  }>([
    {
      // The mapping is per-row, and a sibling's latch belongs to a sibling's
      // launch. Two rows are what makes "clear the target" distinguishable from
      // "clear everything".
      name: 'a sibling substep keeps its own latch',
      rows: (row) => [
        row,
        {
          ...row,
          id: '2',
          inline: row.inline
            ? { ...row.inline, childRunId: assertRunId('rd_ffffffffffffffffffffffffffffffff') }
            : undefined,
        },
      ],
      assert: (rows) => {
        expect(rows?.[0]?.inline?.started).toBeNull();
        expect(rows?.[1]?.inline?.started).toEqual(LATCHED);
      },
    },
    {
      // No row at the intent's coordinate at all: the lookup answers undefined,
      // and reading `.inline` off it would throw inside an assign.
      name: 'no row sits at the consumed intent coordinate',
      rows: (row) => [{ ...row, id: '9' }],
      assert: (rows) => {
        expect(rows?.[0]?.inline?.started).toEqual(LATCHED);
      },
    },
    {
      // The row is there but carries no inline metadata, so there is no latch to
      // release and nothing to read it from.
      name: 'the row carries no inline metadata',
      rows: (row) => [{ id: row.id, frameKey: row.frameKey, status: row.status }],
      assert: (rows) => {
        expect(rows?.[0]?.inline).toBeUndefined();
      },
    },
  ])('releases nothing when $name', async ({ rows, assert }) => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    const errors: unknown[] = [];
    const subscription = actor.subscribe({ error: (error) => errors.push(error) });
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    actor.send({
      type: 'INLINE_CHILD_STARTED',
      parentStepId: '1',
      parentFrameKey: buildFrameKey('1'),
      childRunId,
      started: LATCHED,
    });
    const latched = actor.getSnapshot().context.substepStates?.[0];
    if (!latched) throw new Error('expected a latched substep row');
    actor.send({ type: 'MANUAL_DELEGATION_ABORT_PREPARED', substepStates: rows(latched) });

    actor.send({ type: 'INLINE_LAUNCH_CONSUMED' });

    expect(errors).toEqual([]);
    expect(actor.getSnapshot().context.inlineLaunchIntent).toBeUndefined();
    assert(actor.getSnapshot().context.substepStates);

    subscription.unsubscribe();
    actor.stop();
  });

  // Consuming an intent whose launch was never latched — the row is this
  // launch's, and its latch is already null. Releasing must recognise there is
  // nothing to release and return the rows it was given, not rebuild them: an
  // unchanged state that arrives as a new array reads as a write to every
  // version-comparing writer above it. Identity is the only assertion that sees
  // the difference, and a second consume cannot substitute for this case — the
  // intent is gone by then, so the release returns before it ever reads the row.
  it('returns the same substep rows when the launch was never latched', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    // No INLINE_CHILD_STARTED: the intent is prepared and its row carries the
    // inline metadata, with `started` still null.
    const beforeConsume = actor.getSnapshot().context.substepStates;
    expect(beforeConsume?.[0]?.inline?.started).toBeNull();

    actor.send({ type: 'INLINE_LAUNCH_CONSUMED' });

    expect(actor.getSnapshot().context.substepStates).toBe(beforeConsume);

    actor.stop();
  });

  it('leaves state unchanged when inline child start has no substep states', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Local
- PASS CONTINUE
- FAIL STOP
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(compileRunbookToMachine(steps));
    actor.start();
    const before = actor.getSnapshot().context;

    actor.send({
      type: 'INLINE_CHILD_STARTED',
      parentStepId: '1',
      parentFrameKey: buildFrameKey('1'),
      childRunId,
      started: LATCHED,
    });

    const after = actor.getSnapshot().context;
    expect(after.substepStates).toBeUndefined();
    expect(after.inlineLaunchIntent).toBeUndefined();
    expect(after).toEqual(before);

    actor.stop();
  });

  it('leaves state unchanged when inline child start finds no inline metadata', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Local
- PASS CONTINUE
- FAIL STOP
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const substepStates = [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' as const }];
    const actor = createActor(
      compileRunbookToMachine(steps, {
        substepStates,
      }),
    );
    actor.start();

    actor.send({
      type: 'INLINE_CHILD_STARTED',
      parentStepId: '1',
      parentFrameKey: buildFrameKey('1'),
      childRunId,
      started: LATCHED,
    });

    const context = actor.getSnapshot().context;
    expect(context.substepStates).toEqual(substepStates);

    actor.stop();
  });

  it('rejects inline child start when target metadata belongs to another child run', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });

    const error = new Promise<unknown>((resolve) => {
      const subscription = actor.subscribe({
        error: (received) => {
          subscription.unsubscribe();
          resolve(received);
        },
      });
      actor.send({
        type: 'INLINE_CHILD_STARTED',
        parentStepId: '1',
        parentFrameKey: buildFrameKey('1'),
        childRunId: assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
        started: LATCHED,
      });
    });

    await expect(error).resolves.toMatchObject({
      message: 'Inline child run mismatch for 1',
    });

    actor.stop();
  });

  it('preserves inline launch intent when child start mismatches the stored child run', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    const before = actor.getSnapshot().context;

    const error = new Promise<unknown>((resolve) => {
      const subscription = actor.subscribe({
        error: (received) => {
          subscription.unsubscribe();
          resolve(received);
        },
      });
      actor.send({
        type: 'INLINE_CHILD_STARTED',
        parentStepId: '1',
        parentFrameKey: buildFrameKey('1'),
        childRunId: assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
        started: LATCHED,
      });
    });

    await expect(error).resolves.toMatchObject({
      message: 'Inline child run mismatch for 1',
    });

    const after = actor.getSnapshot().context;
    expect(after.inlineLaunchIntent).toEqual(before.inlineLaunchIntent);
    expect(after.substepStates).toEqual(before.substepStates);

    actor.stop();
  });

  it('keeps DELEGATE runbook-list substeps on the delegation frontier path', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
  - DELEGATE
`);
    const machine = compileRunbookToMachine(steps, {
      templateVars: brandFlattenedTemplateVarsForTest({
        RunId: 'rd_cccccccccccccccccccccccccccccccc',
      }),
      resolveDelegationRunbook: async (runbookRef) => ({
        path: 'runbooks/child.runbook.md',
        runbookRef,
        childRunbookRef: { source: 'project', path: 'runbooks/child.runbook.md' },
      }),
      issueDelegationCredential: makeDelegationCredentialIssuer(),
    });
    const actor = createActor(machine);
    actor.start();

    const snapshot = await waitFor(
      actor,
      (candidate) =>
        !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG) &&
        candidate.context.delegateFrontier !== undefined,
      { timeout: 500 },
    );
    const context = snapshot.context as RunbookContext & {
      readonly inlineLaunchIntent?: unknown;
    };

    expect(context.delegateFrontier).toBeDefined();
    expect(context.inlineLaunchIntent).toBeUndefined();

    actor.stop();
  });
});
