import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fc from 'fast-check';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRunbookDriver } from '../../../src/runbook/storage/driver-factory.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import { RunbookStore } from '../../../src/runbook/storage/runbook-store.js';
import { assertStateVersion } from '../../../src/runbook/storage/mutation-result.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
import { generateOwnerToken, hashRunSecret } from '../../../src/runbook/run-secrets.js';
import { brandStoredOutputsForTest } from '../../../src/testing/effective-vars.js';
import type { RunbookState, Runbook, Step } from '../../../src/runbook/types.js';
import { makeBaseStep } from '../../helpers/step-factories.js';

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = { title: 'Test', description: 'A test', steps: mockSteps };

let dir: string;
let driver: SqlDriver;
let store: RunbookStore;
let manager: RunbookStateManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-store-prop-'));
  driver = await openRunbookDriver(path.join(dir, 'rundown.db'), { runtime: 'native' });
  store = new RunbookStore(driver, dir);
  manager = new RunbookStateManager(dir);
});

afterEach(async () => {
  await driver[Symbol.asyncDispose]();
  await fs.rm(dir, { recursive: true, force: true });
});

function baseState(): Promise<RunbookState> {
  return manager.create({ source: 'project', path: 'test.runbook.md' }, mockRunbook, {
    launchDir: '.',
    runbookPath: 'test.runbook.md',
    ownerTokenHash: hashRunSecret(generateOwnerToken()),
  });
}

// Variable names must match /^[a-zA-Z_][a-zA-Z0-9_]*$/; use a curated valid pool.
const varName = fc.constantFrom('a', 'b', 'foo', 'Bar', 'x1', '_k', 'count', 'Total');

describe('generative schema round-trip', () => {
  it('round-trips arbitrary valid state field variations through store and load', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          stepName: fc.string(),
          retryCount: fc.nat(9),
          step: fc.constantFrom('1', '2', 'ErrorHandler'),
          prompted: fc.boolean(),
          lifecycle: fc.constantFrom('running', 'completed', 'stopped', 'abandoned'),
          // StoredOutputs values are string OUTPUTS (or artifact records); use strings.
          variables: fc.dictionary(varName, fc.string()),
        }),
        async (v) => {
          const base = await baseState();
          const state: RunbookState = {
            ...base,
            stepName: v.stepName,
            retryCount: v.retryCount,
            step: v.step,
            prompted: v.prompted,
            lifecycle: v.lifecycle,
            variables: brandStoredOutputsForTest(v.variables),
          };
          await store.createRun(state, hashRunSecret(generateOwnerToken()));
          const loaded = await store.loadRun(state.id);
          expect(loaded).toEqual(state);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('conditional write properties', () => {
  it('exactly one of N writers holding the same version commits; the rest are refused', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (writers) => {
        const state = await baseState();
        await store.createRun(state, hashRunSecret(generateOwnerToken()));
        const read = await store.loadRunWithVersion(state.id);
        const results = [];
        for (let i = 0; i < writers; i += 1) {
          results.push(
            await store.saveRun(state.id, read!.stateVersion, {
              ...read!.state,
              stepName: `writer-${String(i)}`,
            }),
          );
        }
        const committed = results.filter((r) => r.kind === 'committed');
        const refused = results.filter((r) => r.kind === 'concurrent_modification');
        expect(committed).toHaveLength(1);
        expect(refused).toHaveLength(writers - 1);
        // The first writer in program order is the one that landed.
        expect((await store.loadRun(state.id))?.stepName).toBe('writer-0');
        const versioned = await store.loadRunWithVersion(state.id);
        expect(versioned?.stateVersion).toBe(1);
      }),
      { numRuns: 10 },
    );
  });

  it('state_version advances by exactly one per committed save', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (saves) => {
        const state = await baseState();
        await store.createRun(state, hashRunSecret(generateOwnerToken()));
        for (let i = 0; i < saves; i += 1) {
          const result = await store.saveRun(state.id, assertStateVersion(i), {
            ...state,
            retryCount: i + 1,
          });
          expect(result.kind).toBe('committed');
        }
        const versioned = await store.loadRunWithVersion(state.id);
        expect(versioned?.stateVersion).toBe(saves);
        expect(versioned?.state.retryCount).toBe(saves);
      }),
      { numRuns: 10 },
    );
  });
});
