import { describe, expect, it } from '@jest/globals';
import { createActor, waitFor } from 'xstate';

import { compileRunbookToMachine, PENDING_MACHINE_EFFECT_TAG } from '../../src/runbook/compiler.js';
import type { RunbookContext } from '../../src/runbook/compiler.js';
import type { ResolveInlineRunbook } from '../../src/runbook/actors/inline-launch-intent-actor.js';
import { assertRunId, type RunId } from '../../src/runbook/run-id.js';
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
