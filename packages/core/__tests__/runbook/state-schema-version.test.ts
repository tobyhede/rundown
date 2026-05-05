import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookStateSchema } from '../../src/schemas.js';
import { RunbookStateManager, StaleRunbookStateError } from '../../src/runbook/index.js';

const BASE_SCHEMA_STATE = {
  id: 'r1',
  runbook: { source: 'project', path: 'x.md' },
  runbookPath: 'x.md',
  step: '1',
  stepName: 'x',
  retryCount: 0,
  steps: [],
  startedAt: '2026-04-19T00:00:00.000Z',
  updatedAt: '2026-04-19T00:00:00.000Z',
};

describe('RunbookStateSchema — schema version and lifecycle fields', () => {
  it('accepts state with schemaVersion 2 and lifecycle field', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 2,
    });
    expect(parsed.lifecycle).toBe('running');
    expect(parsed.schemaVersion).toBe(2);
  });

  it('accepts all lifecycle enum values', () => {
    for (const lc of ['running', 'completed', 'stopped']) {
      const parsed = RunbookStateSchema.parse({
        ...BASE_SCHEMA_STATE,
        variables: {},
        lifecycle: lc,
        schemaVersion: 2,
      });
      expect(parsed.lifecycle).toBe(lc);
    }
  });

  it('rejects boolean values inside variables (narrow shape enforced)', () => {
    expect(() =>
      RunbookStateSchema.parse({
        ...BASE_SCHEMA_STATE,
        variables: { completed: true },
        lifecycle: 'running',
        schemaVersion: 2,
      }),
    ).toThrow();
  });

  it('rejects number values inside variables', () => {
    expect(() =>
      RunbookStateSchema.parse({
        ...BASE_SCHEMA_STATE,
        variables: { count: 42 },
        lifecycle: 'running',
        schemaVersion: 2,
      }),
    ).toThrow();
  });

  it('accepts empty variables map', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 2,
    });
    expect(parsed.variables).toEqual({});
  });

  it('accepts string-only variables map', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: { env: 'staging', version: '1.2.3' },
      lifecycle: 'running',
      schemaVersion: 2,
    });
    expect(parsed.variables).toEqual({ env: 'staging', version: '1.2.3' });
  });
});

describe('RunbookStateManager.load() — stale state enforcement', () => {
  let tmpDir: string;
  let manager: RunbookStateManager;

  const V1_STATE = {
    id: 'wf-stale-test',
    runbook: 'x.md',
    runbookPath: 'x.md',
    step: '1',
    stepName: 'x',
    retryCount: 0,
    variables: {},
    steps: [],
    startedAt: '2026-04-19T00:00:00.000Z',
    updatedAt: '2026-04-19T00:00:00.000Z',
    lifecycle: 'running',
    schemaVersion: 1, // old version
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
    manager = new RunbookStateManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('throws StaleRunbookStateError when loading v1 state', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(
      path.join(runsDir, `${V1_STATE.id}.json`),
      JSON.stringify(V1_STATE, null, 2),
    );

    await expect(manager.load(V1_STATE.id)).rejects.toBeInstanceOf(StaleRunbookStateError);
  });

  it('throws StaleRunbookStateError with helpful message', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(
      path.join(runsDir, `${V1_STATE.id}.json`),
      JSON.stringify(V1_STATE, null, 2),
    );

    await expect(manager.load(V1_STATE.id)).rejects.toThrow('rd prune --all');
  });

  it('returns null for missing state file', async () => {
    const result = await manager.load('wf-does-not-exist');
    expect(result).toBeNull();
  });

  it('loads valid v2 state successfully', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const v2State = {
      ...V1_STATE,
      runbook: { source: 'project', path: 'x.md' },
      schemaVersion: 2,
    };
    await fs.writeFile(path.join(runsDir, `${v2State.id}.json`), JSON.stringify(v2State, null, 2));

    const result = await manager.load(v2State.id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(v2State.id);
  });
});
