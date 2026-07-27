import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assign, fromPromise, setup } from 'xstate';
import type { ResolvedRunbook, ResolvedStep } from '../../src/runbook/types.js';
import { makeBaseStep } from '../helpers/step-factories.js';

const pendingTag = 'pending-machine-effect';
const pendingCommandTag = 'pending-command-execution';
let effectStarted = 0;
let releaseEffect: (() => void) | undefined;
let compileMode: 'initialize' | 'transition' = 'transition';

function waitForRelease(): Promise<void> {
  effectStarted += 1;
  return new Promise((resolve) => {
    releaseEffect = resolve;
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for synthetic pending effect to start');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

jest.unstable_mockModule('../../src/runbook/compiler.js', () => ({
  PENDING_MACHINE_EFFECT_TAG: pendingTag,
  PENDING_COMMAND_EXECUTION_TAG: pendingCommandTag,
  RECOVERY_REQUIRED_STATE_NAME: 'recoveryRequired',
  isCompoundLeafValue: (value: unknown) =>
    value === 'idle' ||
    value === '__capture' ||
    value === '__execute-command' ||
    value === '__resolve-artifacts',
  compileRunbookToMachine: () =>
    setup({
      actors: {
        pendingEffect: fromPromise(waitForRelease),
      },
      actions: {
        markPass: assign({
          lastAction: () => ({ type: 'CONTINUE' as const, origin: 'direct' as const }),
        }),
        markFail: assign({
          lastAction: () => ({ type: 'STOP' as const, origin: 'direct' as const }),
        }),
        markGoto: assign({
          lastAction: () => ({ type: 'GOTO' as const, origin: 'direct' as const, target: '4' }),
        }),
        markStart: assign({
          lastAction: () => ({ type: 'START' as const, origin: 'direct' as const }),
        }),
      },
    }).createMachine({
      id: 'runbook',
      initial: compileMode === 'initialize' ? 'bootEffect' : 'step::1',
      context: {
        retryCount: 0,
        variables: {},
        forStack: [],
        lifecycle: 'running',
        frontmatterOutputs: [],
        finalVars: {},
      },
      states: {
        bootEffect: {
          tags: [pendingTag],
          invoke: { src: 'pendingEffect', onDone: { target: 'step::1', actions: 'markStart' } },
        },
        'step::1': {
          on: {
            PASS: 'passEffect',
            FAIL: 'failEffect',
            GOTO: 'gotoEffect',
            EXECUTE_COMMAND: 'commandEffect',
          },
        },
        commandEffect: {
          // Simulated command execution carries the command-execution tag —
          // sendAndSync waits for it without the machine-effect budget (#536).
          tags: [pendingCommandTag],
          invoke: { src: 'pendingEffect', onDone: { target: 'step::2', actions: 'markPass' } },
        },
        passEffect: {
          tags: [pendingTag],
          invoke: { src: 'pendingEffect', onDone: { target: 'step::2', actions: 'markPass' } },
        },
        failEffect: {
          tags: [pendingTag],
          invoke: { src: 'pendingEffect', onDone: { target: 'step::3', actions: 'markFail' } },
        },
        gotoEffect: {
          tags: [pendingTag],
          invoke: { src: 'pendingEffect', onDone: { target: 'step::4', actions: 'markGoto' } },
        },
        'step::2': {},
        'step::3': {},
        'step::4': {},
      },
    }),
}));

const { RunbookStateManager } = await import('../../src/runbook/state.js');
const { RunbookActorService } = await import('../../src/runbook/actor-service.js');

function steps(): ResolvedStep[] {
  return ['1', '2', '3', '4'].map((name) =>
    makeBaseStep({
      name,
      description: `Step ${name}`,
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
    }),
  );
}

describe('RunbookActorService pending machine effects', () => {
  let testDir: string;
  let manager: InstanceType<typeof RunbookStateManager>;
  let service: InstanceType<typeof RunbookActorService>;
  let runbook: ResolvedRunbook;

  beforeEach(async () => {
    effectStarted = 0;
    releaseEffect = undefined;
    compileMode = 'transition';
    testDir = await mkdtemp(join(tmpdir(), 'actor-pending-effects-'));
    manager = new RunbookStateManager(testDir);
    service = new RunbookActorService(manager);
    runbook = { title: 'Pending effects', description: 'Synthetic wait tests', steps: steps() };
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('initializeState waits for a tagged startup effect before persisting', async () => {
    compileMode = 'initialize';
    const state = await manager.create({ source: 'project', path: 'pending.md' }, runbook, {
      runbookPath: 'pending.md',
      frontmatterOutputs: [],
    });

    const pending = service.initializeState(state.id, [...runbook.steps]);
    await waitUntil(() => effectStarted === 1);
    expect((await manager.load(state.id))?.snapshot).toBeUndefined();

    releaseEffect?.();
    const initialized = await pending;

    expect(initialized?.step).toBe('1');
    expect(initialized?.lastAction).toEqual({ type: 'START', origin: 'direct' });
    expect(JSON.stringify(initialized?.snapshot)).not.toContain('bootEffect');
  });

  it.each([
    ['PASS', { type: 'PASS' as const }, '2'],
    ['FAIL', { type: 'FAIL' as const }, '3'],
    ['GOTO', { type: 'GOTO' as const, target: { step: '4' } }, '4'],
  ])('sendAndSync waits for a tagged %s effect before persisting', async (_name, event, expectedStep) => {
    const state = await manager.create({ source: 'project', path: 'pending.md' }, runbook, {
      runbookPath: 'pending.md',
      frontmatterOutputs: [],
    });
    await service.initializeState(state.id, [...runbook.steps]);

    const pending = service.sendAndSync(state.id, [...runbook.steps], event);
    await waitUntil(() => effectStarted === 1);
    expect((await manager.load(state.id))?.step).toBe('1');

    releaseEffect?.();
    const synced = await pending;

    expect(synced?.state.step).toBe(expectedStep);
    expect(JSON.stringify(synced?.state.snapshot)).not.toMatch(/passEffect|failEffect|gotoEffect/);
  });

  it('sendAndSync waits for a tagged command execution effect before persisting', async () => {
    const state = await manager.create({ source: 'project', path: 'pending.md' }, runbook, {
      runbookPath: 'pending.md',
      frontmatterOutputs: [],
    });
    await service.initializeState(state.id, [...runbook.steps]);

    const pending = service.sendAndSync(state.id, [...runbook.steps], {
      type: 'EXECUTE_COMMAND',
      command: 'true',
      displayCommand: 'true',
      outputScope: { stepId: '1' },
      nakedOutputs: [],
      rdInjected: { RD_RUN_ID: state.id },
    });
    await waitUntil(() => effectStarted === 1);
    expect((await manager.load(state.id))?.step).toBe('1');

    releaseEffect?.();
    const synced = await pending;

    expect(synced?.state.step).toBe('2');
    expect(JSON.stringify(synced?.state.snapshot)).not.toContain('commandEffect');
  });
});
