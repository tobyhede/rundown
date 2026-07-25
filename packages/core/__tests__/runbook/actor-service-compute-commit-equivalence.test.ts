import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  InvalidRunbookStateError,
  RunbookStateManager,
} from '../../src/runbook/state.js';
import {
  RunbookActorService,
  type RunbookActorServiceOptions,
} from '../../src/runbook/actor-service.js';
import type { RunbookEvent } from '../../src/runbook/compiler.js';
import type { ResolvedStep, RunbookState } from '../../src/runbook/types.js';
import type { ExecutionObservationEffect } from '../../src/events/execution-observation.js';
import { merge } from '../../src/runbook/state-update-ops.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
} from '../../src/runbook/targeting.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { createRunbook } from './fixtures.js';
import { seedRawRunState } from '../../src/testing/state-fixtures.js';

/**
 * Compute/commit equivalence for the fenced actor seam.
 *
 * `RunbookActorService.prepareActorMutation` (compute half) and
 * `RunbookActorService.sendAndSync` -> `updateFromActor` (persisting half) share
 * `deriveActorStatePatch` + `applyRunbookStateUpdate`. This suite is the regression pin
 * for that shared guarantee: from one seeded state and one event, the computed next
 * state and the state readable back through `RunbookStateManager.load` must agree
 * modulo `updatedAt`.
 */

const dirs: string[] = [];

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rd-equivalence-'));
  dirs.push(dir);
  return dir;
}

/**
 * Recursively canonicalise a value for comparison.
 *
 * JSON round-trips first so `undefined`-valued keys — which the compute half carries
 * in memory but serialisation drops — compare equal, then sorts keys at every depth so
 * field ordering is not load-bearing. `updatedAt` is dropped: each persistence layer
 * stamps its own (see the `applyRunbookStateUpdate` docblock).
 *
 * @param value - The value to canonicalise.
 * @returns The canonical form, safe to pass to `toEqual`.
 */
function canonicalise(value: unknown): unknown {
  const round: unknown = JSON.parse(JSON.stringify(value));
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>)
        .filter(([key]) => key !== 'updatedAt')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries.map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return walk(round);
}

const TWO_STEP_CONTINUE = `## 1. First
- PASS CONTINUE
- FAIL STOP

## 2. Second
- PASS COMPLETE
- FAIL STOP
`;

const ONE_STEP_COMPLETE = `## 1. Only
- PASS COMPLETE
- FAIL STOP
`;

const GOTO_RUNBOOK = `## 1. First
- PASS CONTINUE
- FAIL STOP

## 2. Second
- PASS COMPLETE
- FAIL STOP

## 3. Third
- PASS COMPLETE
- FAIL STOP
`;

const COMMAND_RUNBOOK = `## 1. Build
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
npm test
\`\`\`
`;

/**
 * Persist a state verbatim, bypassing the manager's `saveUnlocked` floor. Models
 * the fenced committer, which persists the computed `nextState` as-is with no
 * repair.
 *
 * Run state now lives in `.rundown/rundown.db`, so this writes the row through
 * the raw store fixture rather than hand-writing `.rundown/runs/<id>.json`.
 * `seedRawRunState` writes `state_json` without validating it, which preserves
 * exactly the "verbatim, no repair" property this helper exists for.
 *
 * @param dir - Project root whose store receives the run.
 * @param state - The state to persist verbatim.
 */
async function writeStateFileVerbatim(dir: string, state: RunbookState): Promise<void> {
  await seedRawRunState(dir, state as unknown as Record<string, unknown>);
}

interface Harness {
  readonly dir: string;
  readonly manager: RunbookStateManager;
  readonly service: RunbookActorService;
  readonly steps: ResolvedStep[];
  readonly seeded: RunbookState;
}

function commandTemplateVars(runId: string): Record<string, string | Record<string, string>> {
  return {
    RunId: runId,
    WorkPath: '.rundown/work',
    ContextId: 'ctx',
    RunbookRef: { source: 'project', path: 'workflow.runbook.md' },
  };
}

/**
 * Create a manager + service, initialise the run, and capture the seeded state S.
 *
 * @param options - Runbook markdown, service DI, and an optional post-init seed hook.
 * @param options.markdown - Runbook source compiled into the machine.
 * @param options.serviceOptions - Runtime dependencies for the actor service.
 * @param options.withCommandVars - Seed the template vars command execution requires.
 * @param options.afterInit - Extra persisted seeding applied before S is captured.
 * @returns The harness bound to a fresh temp project root.
 */
async function seed(options: {
  readonly markdown: string;
  readonly serviceOptions?: RunbookActorServiceOptions;
  readonly withCommandVars?: boolean;
  readonly afterInit?: (manager: RunbookStateManager, id: string) => Promise<void>;
}): Promise<Harness> {
  const dir = await makeDir();
  const manager = new RunbookStateManager(dir);
  const service = new RunbookActorService(manager, options.serviceOptions ?? {});
  const steps = createRunbook(options.markdown);
  const runId = assertRunId(`rd_${'1'.repeat(32)}`);
  const created = await manager.create(
    { source: 'project', path: 'workflow.runbook.md' },
    { title: 'Equivalence', description: '', steps },
    {
      runId,
      runbookPath: 'workflow.runbook.md',
      frontmatterOutputs: [],
      ...(options.withCommandVars ? { templateVars: commandTemplateVars(runId) } : {}),
    },
  );
  await service.initializeState(created.id, steps);
  await options.afterInit?.(manager, created.id);
  const seeded = await manager.load(created.id);
  if (!seeded) throw new Error('seed: state not found after initialisation');
  return { dir, manager, service, steps, seeded };
}

/**
 * Run both halves of the seam from the same seeded state and return their outputs.
 *
 * The compute half runs first (it never writes, which is asserted), then disk is reset
 * to S before the persisting half so the two observe identical inputs.
 *
 * @param harness - The seeded harness.
 * @param event - The event both halves receive.
 * @returns The computed next state, the reloaded persisted state, and both effect lists.
 */
async function bothHalves(
  harness: Harness,
  event: RunbookEvent,
): Promise<{
  readonly computed: RunbookState;
  readonly computedEffects: readonly ExecutionObservationEffect[];
  readonly persisted: RunbookState;
  readonly persistedEffects: readonly ExecutionObservationEffect[];
}> {
  const { manager, service, steps, seeded } = harness;
  const prepared = await service.prepareActorMutation(seeded.id, seeded, steps, event);
  // Nothing was persisted by the compute half.
  const untouched = await manager.load(seeded.id);
  expect(canonicalise(untouched)).toEqual(canonicalise(seeded));
  await manager.save(seeded);

  const sync = await service.sendAndSync(seeded.id, steps, event);
  if (!sync) throw new Error('sendAndSync returned null');
  const reloaded = await manager.load(seeded.id);
  if (!reloaded) throw new Error('state missing after sendAndSync');
  return {
    computed: prepared.nextState,
    computedEffects: prepared.effects,
    persisted: reloaded,
    persistedEffects: sync.effects,
  };
}

describe('prepareActorMutation / sendAndSync equivalence', () => {
  it('PASS (non-terminal) agrees modulo updatedAt', async () => {
    const harness = await seed({ markdown: TWO_STEP_CONTINUE });
    const { computed, persisted } = await bothHalves(harness, { type: 'PASS' });

    expect(computed.step).toBe('2');
    expect(computed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(canonicalise(computed)).toEqual(canonicalise(persisted));
  });

  it('PASS -> COMPLETE agrees modulo updatedAt', async () => {
    const harness = await seed({ markdown: ONE_STEP_COMPLETE });
    const { computed, persisted } = await bothHalves(harness, { type: 'PASS' });

    expect(computed.lifecycle).toBe('completed');
    expect(computed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(canonicalise(computed)).toEqual(canonicalise(persisted));
  });

  it('FAIL -> STOPPED agrees modulo updatedAt', async () => {
    const harness = await seed({ markdown: ONE_STEP_COMPLETE });
    const { computed, persisted } = await bothHalves(harness, { type: 'FAIL' });

    expect(computed.lifecycle).toBe('stopped');
    expect(computed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(canonicalise(computed)).toEqual(canonicalise(persisted));
  });

  it('GOTO agrees modulo updatedAt', async () => {
    const harness = await seed({ markdown: GOTO_RUNBOOK });
    const { computed, persisted } = await bothHalves(harness, {
      type: 'GOTO',
      target: { step: '3' },
    } as unknown as RunbookEvent);

    expect(computed.step).toBe('3');
    expect(computed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(canonicalise(computed)).toEqual(canonicalise(persisted));
  });

  it('EXECUTE_COMMAND (completed) agrees and emits started + completed effects', async () => {
    const runId = `rd_${'1'.repeat(32)}`;
    const harness = await seed({
      markdown: COMMAND_RUNBOOK,
      withCommandVars: true,
      serviceOptions: {
        commandServices: {
          runExternalCommand: async () => ({ success: true, exitCode: 0 }),
        },
      },
    });
    const event: RunbookEvent = {
      type: 'EXECUTE_COMMAND',
      command: 'true',
      displayCommand: 'true',
      runbookPath: 'workflow.runbook.md',
      outputScope: { stepId: '1' },
      nakedOutputs: [],
      rdInjected: { RD_RUN_ID: runId },
    };
    const { computed, computedEffects, persisted, persistedEffects } = await bothHalves(
      harness,
      event,
    );

    expect(computed.lifecycle).toBe('completed');
    expect(computed.lastResult).toBe('pass');
    expect(computed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(canonicalise(computed)).toEqual(canonicalise(persisted));
    // Both halves emit the same observation sequence: the fence must not drop the
    // pre-effect COMMAND_STARTED nor the post-effect COMMAND_COMPLETED.
    expect(computedEffects.map((e) => e.event.type)).toEqual([
      'COMMAND_STARTED',
      'COMMAND_COMPLETED',
    ]);
    expect(canonicalise(computedEffects)).toEqual(canonicalise(persistedEffects));
  });

  it('EXECUTE_COMMAND (policy denied) agrees and emits started + policy_denied effects', async () => {
    const runId = `rd_${'1'.repeat(32)}`;
    const harness = await seed({
      markdown: COMMAND_RUNBOOK,
      withCommandVars: true,
      serviceOptions: {
        commandServices: {
          runExternalCommand: async () => ({
            success: false,
            exitCode: 126,
            policyDenied: true,
            denialReason: 'blocked',
          }),
        },
      },
    });
    const event: RunbookEvent = {
      type: 'EXECUTE_COMMAND',
      command: 'curl https://example.test',
      displayCommand: 'curl https://example.test',
      runbookPath: 'workflow.runbook.md',
      outputScope: { stepId: '1' },
      nakedOutputs: [],
      rdInjected: { RD_RUN_ID: runId },
    };
    const { computed, computedEffects, persisted, persistedEffects } = await bothHalves(
      harness,
      event,
    );

    expect(computed.lifecycle).toBe('stopped');
    // A denial is not a result: `lastResult` is cleared, never mapped to fail.
    expect(computed.lastResult).toBeUndefined();
    expect(computed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(canonicalise(computed)).toEqual(canonicalise(persisted));
    expect(computedEffects.map((e) => e.event.type)).toEqual(['COMMAND_STARTED', 'POLICY_DENIED']);
    expect(canonicalise(computedEffects)).toEqual(canonicalise(persistedEffects));
  });

  it('APPLY_CURRENT_RESOLVED_COMPLETION agrees modulo updatedAt', async () => {
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const completion = buildResolvedCompletion({
      agentId: 'delegation',
      result: 'pass',
      targetStep: '1',
      targetSubstep: '1',
      targetFrame: activeFrame(buildFrameKey('1'), 1),
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    const harness = await seed({
      markdown: TWO_STEP_CONTINUE,
      afterInit: async (manager, id) => {
        await manager.update(id, { resolvedCompletions: merge({ [key]: completion }) });
      },
    });
    expect(harness.seeded.resolvedCompletions?.[key]).toBeDefined();

    const { computed, persisted } = await bothHalves(harness, {
      type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
      completionKey: key,
      completion: { ...completion, targetEntry: 1 },
    } as unknown as RunbookEvent);

    // The consumed key is gone from both halves: the fenced path reads the captured
    // state and the manager path re-reads disk, but here they agree.
    expect(computed.resolvedCompletions?.[key]).toBeUndefined();
    expect(persisted.resolvedCompletions?.[key]).toBeUndefined();
    expect(computed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(canonicalise(computed)).toEqual(canonicalise(persisted));
  });
});

describe('prepareActorMutation loadability and cleanup', () => {
  it('refuses to derive from a store-shaped previous state carrying no schemaVersion', async () => {
    // The store's zod schema treats `schemaVersion` as optional, so a run loaded
    // through `RunbookStore.loadRun` can reach the fence without one — the store
    // performs no version check of its own. Stamping one on would launder a state
    // `manager.load` hard-rejects into one it accepts, which is the silent
    // migration the no-migration rule forbids. Refusing surfaces it instead; the
    // sanctioned recovery is prune/restart.
    const harness = await seed({ markdown: TWO_STEP_CONTINUE });
    const storeShaped = { ...harness.seeded };
    delete (storeShaped as { schemaVersion?: number }).schemaVersion;

    await expect(
      harness.service.prepareActorMutation(harness.seeded.id, storeShaped, harness.steps, {
        type: 'PASS',
      }),
    ).rejects.toBeInstanceOf(InvalidRunbookStateError);
  });

  it('stamps the current schemaVersion on a manager-captured previous state', async () => {
    const harness = await seed({ markdown: TWO_STEP_CONTINUE });

    const prepared = await harness.service.prepareActorMutation(
      harness.seeded.id,
      harness.seeded,
      harness.steps,
      { type: 'PASS' },
    );

    expect(prepared.nextState.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    await writeStateFileVerbatim(harness.dir, prepared.nextState);
    await expect(harness.manager.load(harness.seeded.id)).resolves.toMatchObject({ step: '2' });
  });

  it('stops the actor on the success path', async () => {
    const harness = await seed({ markdown: TWO_STEP_CONTINUE });
    const stopActor = jest.spyOn(harness.service, 'stopActor');

    await harness.service.prepareActorMutation(harness.seeded.id, harness.seeded, harness.steps, {
      type: 'PASS',
    });

    // The compute half owns the actor's whole lifetime; the fence hands the caller
    // no handle to stop it with, so a leak here is one live interpreter per mutation.
    expect(stopActor).toHaveBeenCalledTimes(1);
  });

  it('stops the actor when the computation throws', async () => {
    const harness = await seed({ markdown: TWO_STEP_CONTINUE });
    const stopActor = jest.spyOn(harness.service, 'stopActor');
    const failure = new Error('machine effects failed');
    jest
      .spyOn(
        harness.service as unknown as { waitForMachineEffects: (actor: unknown) => Promise<void> },
        'waitForMachineEffects',
      )
      .mockRejectedValue(failure);

    await expect(
      harness.service.prepareActorMutation(harness.seeded.id, harness.seeded, harness.steps, {
        type: 'PASS',
      }),
    ).rejects.toBe(failure);

    expect(stopActor).toHaveBeenCalledTimes(1);
  });

  it('names the shared derivation, not one caller, when steps are empty', async () => {
    // `deriveActorStatePatch` is shared by `updateFromActor` and
    // `prepareActorMutation`, so the diagnostic must not name a single caller.
    const harness = await seed({ markdown: TWO_STEP_CONTINUE });
    const actor = {
      getPersistedSnapshot: () => ({ value: 'step::1', context: {} }),
    } as unknown as Parameters<RunbookActorService['updateFromActor']>[1];

    const rejection = harness.service.updateFromActor(harness.seeded.id, actor, []);

    // The diagnostic keeps the run id and the offending stateValue…
    await expect(rejection).rejects.toThrow(
      `empty steps array for runbook "${harness.seeded.id}" (stateValue: "step::1")`,
    );
    // …but no longer misattributes the failure to one of the two callers.
    await expect(rejection).rejects.not.toThrow(/updateFromActor/);
  });

  it('throws when the consumed resolved-completion key is absent from the captured state', async () => {
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const completion = buildResolvedCompletion({
      agentId: 'delegation',
      result: 'pass',
      targetStep: '1',
      targetSubstep: '1',
      targetFrame: activeFrame(buildFrameKey('1'), 1),
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    // Present on disk, absent from the captured state. The fenced path reads the
    // captured state by design (see the `applyRunbookStateUpdate` docblock), so it
    // must refuse rather than silently consuming what a concurrent writer left.
    const harness = await seed({
      markdown: TWO_STEP_CONTINUE,
      afterInit: async (manager, id) => {
        await manager.update(id, { resolvedCompletions: merge({ [key]: completion }) });
      },
    });
    const withoutKey: RunbookState = { ...harness.seeded, resolvedCompletions: {} };

    await expect(
      harness.service.prepareActorMutation(harness.seeded.id, withoutKey, harness.steps, {
        type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
        completionKey: key,
        completion: { ...completion, targetEntry: 1 },
      } as unknown as RunbookEvent),
    ).rejects.toThrow(`Resolved completion "${key}"`);
  });
});
