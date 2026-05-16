import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookStateSchema } from '../../src/schemas.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import {
  buildCompletionKey,
  buildFrameKey,
  deriveActiveFrame,
} from '../../src/runbook/targeting.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import type { DelegationLinkage, RunbookState } from '../../src/runbook/types.js';
import { brandRunIdForTest, brandStoredOutputsForTest } from '../helpers/effective-vars.js';

const CHILD_RUN_ID = brandRunIdForTest(`rd_${'1'.repeat(32)}`);
const PARENT_RUN_ID = brandRunIdForTest(`rd_${'2'.repeat(32)}`);
const LOCAL_RUN_ID = brandRunIdForTest(`rd_${'3'.repeat(32)}`);

describe('DelegationLinkage extended fields', () => {
  function makeSchemaState(parentLinkage: Record<string, unknown>): Record<string, unknown> {
    return {
      id: CHILD_RUN_ID,
      runbook: { source: 'project', path: 'child.md' },
      runbookPath: '/tmp/child.md',
      runbookSrc: '## 1. Do\n- PASS COMPLETE\n\nDo it.',
      step: '1',
      stepName: 'Do',
      retryCount: 0,
      variables: {},
      steps: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      parentLinkage,
    };
  }

  it('schema accepts delegation linkage with extended fields', () => {
    const state = makeSchemaState({
      kind: 'delegation',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1',
      tokenHash: `sha256:${'a'.repeat(64)}`,
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it('schema rejects delegation linkage without complete parent identity', () => {
    const state = makeSchemaState({
      kind: 'delegation',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1',
      tokenHash: `sha256:${'b'.repeat(64)}`,
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it.each([
    'parentStep',
    'parentFrameKey',
    'parentEntry',
  ])('schema rejects delegation linkage missing %s', (field) => {
    const parentLinkage: Record<string, unknown> = {
      kind: 'delegation',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1',
      tokenHash: `sha256:${'b'.repeat(64)}`,
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };
    delete parentLinkage[field];

    const result = RunbookStateSchema.safeParse(makeSchemaState(parentLinkage));

    expect(result.success).toBe(false);
  });

  it.each([
    'parentStep',
    'parentFrameKey',
    'parentEntry',
  ])('state load rejects delegation linkage missing %s', async (field) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parent-linkage-load-'));
    try {
      const manager = new RunbookStateManager(tmpDir);
      const runsDir = path.join(tmpDir, '.rundown', 'runs');
      await fs.mkdir(runsDir, { recursive: true });
      const parentLinkage: Record<string, unknown> = {
        kind: 'delegation',
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1',
        tokenHash: `sha256:${'b'.repeat(64)}`,
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      };
      delete parentLinkage[field];
      const state = {
        ...makeSchemaState(parentLinkage),
        schemaVersion: 4,
        lifecycle: 'running',
        frontmatterOutputs: [],
      };
      await fs.writeFile(path.join(runsDir, `${CHILD_RUN_ID}.json`), JSON.stringify(state));

      await expect(manager.load(CHILD_RUN_ID)).rejects.toThrow(/schema validation failed/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('schema rejects non-positive parentEntry', () => {
    const state = makeSchemaState({
      kind: 'delegation',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1',
      tokenHash: `sha256:${'c'.repeat(64)}`,
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 0,
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });
});

describe('DelegationLinkage type shape', () => {
  it('returns true when parentLinkage field is present', () => {
    const linkage: DelegationLinkage = {
      kind: 'delegation',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1',
      tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      parentStep: '1',
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
    };
    expect(linkage).toBeDefined();
    expect(linkage.parentRunId).toBe(PARENT_RUN_ID);
    expect(linkage.kind).toBe('delegation');
  });

  it('undefined parentLinkage means no linkage', () => {
    const state = { parentLinkage: undefined };
    expect(state.parentLinkage).toBeUndefined();
  });
});

describe('parentLinkage discriminated union schema', () => {
  function makeBaseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: CHILD_RUN_ID,
      runbook: { source: 'project', path: 'child.md' },
      runbookPath: '/tmp/child.md',
      runbookSrc: '## 1. Do\n- PASS COMPLETE\n\nDo it.',
      step: '1',
      stepName: 'Do',
      retryCount: 0,
      variables: {},
      steps: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('accepts parentLinkage with kind: delegation', () => {
    const state = makeBaseState({
      parentLinkage: {
        kind: 'delegation',
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1',
        tokenHash: `sha256:${'a'.repeat(64)}`,
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success) {
      const parsed = result.data as Record<string, unknown>;
      expect(parsed).toHaveProperty('parentLinkage');
      expect((parsed.parentLinkage as Record<string, unknown>).kind).toBe('delegation');
    }
  });

  it('accepts parentLinkage with kind: inline', () => {
    const state = makeBaseState({
      parentLinkage: {
        kind: 'inline',
        parentRunId: PARENT_RUN_ID,
        parentStepId: '2',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success) {
      const parsed = result.data as Record<string, unknown>;
      expect(parsed).toHaveProperty('parentLinkage');
      expect((parsed.parentLinkage as Record<string, unknown>).kind).toBe('inline');
    }
  });

  it.each([
    'parentStep',
    'parentFrameKey',
    'parentEntry',
  ])('schema rejects inline linkage missing %s', (field) => {
    const parentLinkage: Record<string, unknown> = {
      kind: 'inline',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '2',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };
    delete parentLinkage[field];

    const result = RunbookStateSchema.safeParse(makeBaseState({ parentLinkage }));

    expect(result.success).toBe(false);
  });

  it('rejects parentLinkage with unknown kind', () => {
    const state = makeBaseState({
      parentLinkage: {
        kind: 'bogus',
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1',
      },
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects old delegation field instead of treating it as parentLinkage', () => {
    const state = makeBaseState({
      delegation: {
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1',
        tokenHash: `sha256:${'a'.repeat(64)}`,
      },
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects old inlineLinkage field instead of treating it as parentLinkage', () => {
    const state = makeBaseState({
      inlineLinkage: {
        kind: 'inline',
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1',
      },
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });
});

describe('frame identity derivation for propagation', () => {
  function makeState(overrides: Partial<RunbookState>): RunbookState {
    return {
      id: LOCAL_RUN_ID,
      runbook: { source: 'project', path: 'test.md' },
      runbookPath: '/tmp/test.md',
      runbookSrc: '## 1. Step\n- PASS COMPLETE\n\nTest.',
      step: '1',
      stepName: 'Step',
      retryCount: 0,
      variables: brandStoredOutputsForTest({}),
      steps: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('derives frame key from step without FOR loop', () => {
    const state = makeState({ step: '2' });
    const frame = deriveActiveFrame(state);
    expect(frame.frameKey).toBe('2|');
    expect(frame.step).toBe('2');
    expect(frame.iteration).toBeUndefined();
  });

  it('derives frame key with FOR loop iteration', () => {
    const state = makeState({
      step: '1',
      forStack: [
        {
          stepId: '1',
          iteration: 3,
          start: 1,
          end: 5,
          implicit: false,
          source: { kind: 'range' },
        },
      ],
    });
    const frame = deriveActiveFrame(state);
    expect(frame.frameKey).toBe('1|3');
    expect(frame.iteration).toBe(3);
  });

  it('builds completion key with substep', () => {
    const frameKey = buildFrameKey('1');
    expect(frameKey).toBe('1|');

    const completionKey = buildCompletionKey(frameKey, 1, '2');
    expect(completionKey).toBe('1||1|2');
  });

  it('uses stored parentFrameKey when available', () => {
    const linkage: DelegationLinkage = {
      kind: 'delegation',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1',
      tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      parentStep: '1',
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
    };

    // When parentFrameKey is present, use it directly instead of deriving
    const frameKey = linkage.parentFrameKey;
    const entry = linkage.parentEntry;
    const completionKey = buildCompletionKey(frameKey, entry, linkage.parentStepId);

    expect(completionKey).toBe('1||1|1');
  });
});
