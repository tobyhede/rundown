import { describe, expect, it } from '@jest/globals';
import { createActor, waitFor } from 'xstate';

import { compileRunbookToMachine, PENDING_MACHINE_EFFECT_TAG } from '../../src/runbook/compiler.js';
import type { RunbookContext } from '../../src/runbook/compiler.js';
import type { ResolveInlineRunbook } from '../../src/runbook/actors/inline-launch-intent-actor.js';
import { assertRunId, type RunId } from '../../src/runbook/run-id.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { brandFlattenedTemplateVarsForTest } from '../../src/testing/effective-vars.js';
import { createRunbook } from './fixtures.js';

type InlineLaunchCompilerOptions = NonNullable<Parameters<typeof compileRunbookToMachine>[1]> & {
  readonly resolveInlineRunbook: ResolveInlineRunbook;
  readonly generateChildRunId: () => RunId;
  readonly now: () => string;
};

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
      startedAt: '2026-05-30T00:00:01.000Z',
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
          startedAt: '2026-05-30T00:00:01.000Z',
        }),
      }),
    );

    actor.send({ type: 'INLINE_LAUNCH_CONSUMED' });

    const consumedContext = actor.getSnapshot().context;
    expect(consumedContext.inlineLaunchIntent).toBeUndefined();
    expect(consumedContext.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        frameKey: '1|',
        inline: expect.objectContaining({
          childRunId,
          startedAt: '2026-05-30T00:00:01.000Z',
        }),
      }),
    );

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
      startedAt: '2026-05-30T00:00:01.000Z',
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
      startedAt: '2026-05-30T00:00:01.000Z',
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
        startedAt: '2026-05-30T00:00:01.000Z',
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
        startedAt: '2026-05-30T00:00:01.000Z',
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
