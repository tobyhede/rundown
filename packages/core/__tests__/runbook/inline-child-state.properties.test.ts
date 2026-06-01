import { afterEach, describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActor } from 'xstate';

import { buildContextSnapshot } from '../../src/runbook/delegation-context.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import type { RunbookContext } from '../../src/runbook/compiler.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { Runbook, SubstepState } from '../../src/runbook/types.js';
import { brandEffectiveVarsForTest } from '../../src/testing/effective-vars.js';
import { makeBaseStep, makeSubstep } from '../helpers/step-factories.js';
import { createRunbook } from './fixtures.js';

const createdDirs: string[] = [];

const mockRunbook: Runbook = {
  title: 'Property Runbook',
  description: 'Property test runbook',
  steps: [makeBaseStep({ name: '1', description: 'Initial step' })],
};

const substepIdArb = fc.integer({ min: 1, max: 5 }).map(String);
const statusArb = fc.constantFrom<SubstepState['status']>('pending', 'running', 'done');
const resultArb = fc.option(fc.constantFrom<'pass' | 'fail'>('pass', 'fail'), {
  nil: undefined,
});

function runIdFromDigit(digit: number) {
  return assertRunId(`rd_${String(digit).repeat(32)}`);
}

async function makeManager(): Promise<RunbookStateManager> {
  const testDir = await mkdtemp(join(tmpdir(), 'rd-inline-state-prop-'));
  createdDirs.push(testDir);
  return new RunbookStateManager(testDir);
}

async function waitForActorError(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('inline child state properties', () => {
  afterEach(async () => {
    await Promise.all(
      createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('substep initialization is idempotent for existing authored frame entries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(substepIdArb, { minLength: 1, maxLength: 4 }),
        fc.array(statusArb, { minLength: 1, maxLength: 4 }),
        fc.array(resultArb, { minLength: 1, maxLength: 4 }),
        async (ids, statuses, results) => {
          const manager = await makeManager();
          const state = await manager.create(
            { source: 'project', path: 'property.runbook.md' },
            mockRunbook,
            { runbookPath: 'property.runbook.md' },
          );
          const frameKey = buildFrameKey('1');
          const otherFrameKey = buildFrameKey('1', 2);
          const existing = ids.map((id, index): SubstepState => {
            const result = results[index % results.length];
            const base = {
              id,
              frameKey,
              status: statuses[index % statuses.length] ?? 'pending',
              delegation: {
                tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
                childRunbookPath: 'runbooks/delegated.runbook.md',
                childRunbookRef: {
                  source: 'project' as const,
                  path: 'runbooks/delegated.runbook.md',
                },
                contextSnapshot: buildContextSnapshot(state, id),
                childRunId: null,
                createdAt: '2026-05-30T00:00:00.000Z',
                cancelledAt: null,
              },
              inline: {
                childRunbookPath: 'runbooks/child.runbook.md',
                childRunbookRef: { source: 'project' as const, path: 'runbooks/child.runbook.md' },
                contextSnapshot: buildContextSnapshot(state, id),
                childRunId: runIdFromDigit((index % 9) + 1),
                createdAt: '2026-05-30T00:00:00.000Z',
                startedAt: index % 2 === 0 ? null : '2026-05-30T00:00:01.000Z',
              },
              ...(result !== undefined ? { result } : {}),
            };
            return base;
          });
          const otherFrameEntry: SubstepState = {
            id: 'other',
            frameKey: otherFrameKey,
            status: 'done',
            result: 'pass',
          };

          await manager.update(state.id, { substepStates: [...existing, otherFrameEntry] });
          await manager.initializeSubsteps(
            state.id,
            ids.map((id) => makeSubstep({ id, description: `Substep ${id}` })),
            frameKey,
          );

          const reloaded = await manager.load(state.id);
          expect(reloaded?.substepStates).toEqual([...existing, otherFrameEntry]);
        },
      ),
      { numRuns: 50 },
    );
  }, 30_000);

  it('substep initialization appends missing authored entries as pending without duplicates', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(substepIdArb, { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 6, max: 9 }).map(String),
        async (ids, extraId) => {
          const authoredIds = ids.includes(extraId) ? ids : [...ids, extraId];
          const manager = await makeManager();
          const state = await manager.create(
            { source: 'project', path: 'property.runbook.md' },
            mockRunbook,
            { runbookPath: 'property.runbook.md' },
          );
          const frameKey = buildFrameKey('1');
          const existing = ids.map(
            (id): SubstepState => ({
              id,
              frameKey,
              status: 'done',
              result: 'pass',
            }),
          );

          await manager.update(state.id, { substepStates: existing });
          await manager.initializeSubsteps(
            state.id,
            authoredIds.map((id) => makeSubstep({ id, description: `Substep ${id}` })),
            frameKey,
          );

          const reloaded = await manager.load(state.id);
          expect(reloaded?.substepStates).toEqual([
            ...existing,
            ...(ids.includes(extraId) ? [] : [{ id: extraId, frameKey, status: 'pending' }]),
          ]);
          const keys = (reloaded?.substepStates ?? []).map(
            (entry) => `${entry.id}:${entry.frameKey}`,
          );
          expect(new Set(keys).size).toBe(keys.length);
        },
      ),
      { numRuns: 50 },
    );
  }, 30_000);

  it('INLINE_CHILD_STARTED is a no-op without inline metadata and updates matching metadata', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (withInline) => {
        const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
        const frameKey = buildFrameKey('1');
        const inline = {
          childRunbookPath: 'runbooks/child.runbook.md',
          childRunbookRef: { source: 'project' as const, path: 'runbooks/child.runbook.md' },
          contextSnapshot: {
            vars: brandEffectiveVarsForTest({}),
            ancestors: [],
            step: '1',
            substep: '1',
            at: '1.1',
          },
          childRunId,
          createdAt: '2026-05-30T00:00:00.000Z',
          startedAt: null,
        };
        const substepStates: readonly SubstepState[] = [
          {
            id: '1',
            frameKey,
            status: 'running',
            ...(withInline ? { inline } : {}),
          },
        ];
        const actor = createActor(
          compileRunbookToMachine(
            createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Local
- PASS CONTINUE
- FAIL STOP
`),
            { substepStates },
          ),
        );
        const errors: unknown[] = [];
        const subscription = actor.subscribe({ error: (error) => errors.push(error) });
        actor.start();

        actor.send({
          type: 'INLINE_CHILD_STARTED',
          parentStepId: '1',
          parentFrameKey: frameKey,
          childRunId,
          startedAt: '2026-05-30T00:00:01.000Z',
        });
        await waitForActorError();

        expect(errors).toEqual([]);
        const context = actor.getSnapshot().context as RunbookContext;
        if (withInline) {
          expect(context.substepStates?.[0]?.inline?.startedAt).toBe('2026-05-30T00:00:01.000Z');
        } else {
          expect(context.substepStates).toEqual(substepStates);
        }

        subscription.unsubscribe();
        actor.stop();
      }),
      { numRuns: 20 },
    );
  }, 30_000);
});
