import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookStateSchema } from '../../src/schemas.js';
import { RunbookStateManager, StaleRunbookStateError } from '../../src/runbook/index.js';

const BASE_RUN_ID = `rd_${'1'.repeat(32)}`;
const STALE_RUN_ID = `rd_${'2'.repeat(32)}`;

const BASE_SCHEMA_STATE = {
  id: BASE_RUN_ID,
  runbook: { source: 'project', path: 'x.md' },
  runbookPath: 'x.md',
  step: '1',
  stepName: 'x',
  retryCount: 0,
  steps: [],
  startedAt: '2026-04-19T00:00:00.000Z',
  updatedAt: '2026-04-19T00:00:00.000Z',
};

describe('RunbookStateSchema — schema version 5 and lifecycle fields', () => {
  it('accepts state with schemaVersion 5 and lifecycle field', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 5,
    });
    expect(parsed.lifecycle).toBe('running');
    expect(parsed.schemaVersion).toBe(5);
  });

  it('accepts all lifecycle enum values', () => {
    for (const lc of ['running', 'completed', 'stopped']) {
      const parsed = RunbookStateSchema.parse({
        ...BASE_SCHEMA_STATE,
        variables: {},
        lifecycle: lc,
        schemaVersion: 5,
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
        schemaVersion: 5,
      }),
    ).toThrow();
  });

  it('accepts number values inside variables', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: { count: 42 },
      lifecycle: 'running',
      schemaVersion: 5,
    });

    expect(parsed.variables).toEqual({ count: 42 });
  });

  it('accepts empty variables map', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 5,
    });
    expect(parsed.variables).toEqual({});
  });

  it('accepts string-only variables map', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: { env: 'staging', version: '1.2.3' },
      lifecycle: 'running',
      schemaVersion: 5,
    });
    expect(parsed.variables).toEqual({ env: 'staging', version: '1.2.3' });
  });

  it('preserves aggregation origin on persisted lastAction', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 5,
      lastAction: { type: 'COMPLETE', origin: 'aggregation' },
    });

    expect(parsed.lastAction).toEqual({ type: 'COMPLETE', origin: 'aggregation' });
  });

  it('accepts variables carrying exact and wildcard artifact records alongside strings', () => {
    const artifact = {
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contextId: 'ctx1',
      runbook: { source: 'project', path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    };

    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {
        PlanPath: artifact,
        Reviews: [artifact],
        Note: 'string-output',
      },
      lifecycle: 'running',
      schemaVersion: 5,
    });

    expect(parsed.variables).toEqual({
      PlanPath: artifact,
      Reviews: [artifact],
      Note: 'string-output',
    });
  });

  it('rejects removed artifactVars field structurally', () => {
    const artifact = {
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contextId: 'ctx1',
      runbook: { source: 'project', path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    };

    expect(() =>
      RunbookStateSchema.parse({
        ...BASE_SCHEMA_STATE,
        variables: {},
        artifactVars: { PlanPath: artifact },
        lifecycle: 'running',
        schemaVersion: 5,
      }),
    ).toThrow(/artifactVars/);
  });
});

describe('RunbookStateManager.load() — stale state enforcement', () => {
  let tmpDir: string;
  let manager: RunbookStateManager;

  const STALE_V3_STATE = {
    id: STALE_RUN_ID,
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
    schemaVersion: 3, // old version (v3 is now stale; current is v4)
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
    manager = new RunbookStateManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('throws StaleRunbookStateError when loading v3 state', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(
      path.join(runsDir, `${STALE_V3_STATE.id}.json`),
      JSON.stringify(STALE_V3_STATE, null, 2),
    );

    await expect(manager.load(STALE_V3_STATE.id)).rejects.toBeInstanceOf(StaleRunbookStateError);
  });

  it('throws StaleRunbookStateError with helpful message', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(
      path.join(runsDir, `${STALE_V3_STATE.id}.json`),
      JSON.stringify(STALE_V3_STATE, null, 2),
    );

    await expect(manager.load(STALE_V3_STATE.id)).rejects.toThrow('rd prune --all');
  });

  it('still rejects state with schemaVersion 2 (older than the previously-current version)', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_cccccccccccccccccccccccccccccccc';
    await fs.writeFile(
      path.join(runsDir, `${id}.json`),
      JSON.stringify({ ...STALE_V3_STATE, id, schemaVersion: 2 }, null, 2),
    );
    await expect(manager.load(id)).rejects.toBeInstanceOf(StaleRunbookStateError);
  });

  it('returns null for missing state file', async () => {
    const result = await manager.load('wf-does-not-exist');
    expect(result).toBeNull();
  });

  it('loads valid v5 state successfully', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const v5State = {
      ...STALE_V3_STATE,
      runbook: { source: 'project', path: 'x.md' },
      schemaVersion: 5,
    };
    await fs.writeFile(path.join(runsDir, `${v5State.id}.json`), JSON.stringify(v5State, null, 2));

    const result = await manager.load(v5State.id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(v5State.id);
  });

  it('rejects v5 state carrying removed artifactVars instead of silently dropping it', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const v5StateWithArtifactVars = {
      ...STALE_V3_STATE,
      id,
      runbook: { source: 'project', path: 'x.md' },
      schemaVersion: 5,
      artifactVars: {
        PlanPath: {
          kind: 'artifact-record',
          uri: `rd://artifacts/ctx1/${id}/plan.json`,
          runId: id,
          contextId: 'ctx1',
          runbook: { source: 'project', path: 'x.md' },
          key: 'plan.json',
          timestamp: '2026-05-07T00:00:00.000Z',
        },
      },
    };
    await fs.writeFile(
      path.join(runsDir, `${id}.json`),
      JSON.stringify(v5StateWithArtifactVars, null, 2),
    );

    await expect(manager.load(id)).rejects.toThrow(/Stale runbook state.*schema validation failed/);
  });

  it('rejects state with missing schemaVersion', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const { schemaVersion: _omit, ...rest } = STALE_V3_STATE;
    await fs.writeFile(path.join(runsDir, `${id}.json`), JSON.stringify({ ...rest, id }, null, 2));
    await expect(manager.load(id)).rejects.toBeInstanceOf(StaleRunbookStateError);
  });

  it('rejects state with future schemaVersion', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_ffffffffffffffffffffffffffffffff';
    await fs.writeFile(
      path.join(runsDir, `${id}.json`),
      JSON.stringify({ ...STALE_V3_STATE, id, schemaVersion: 6 }, null, 2),
    );
    await expect(manager.load(id)).rejects.toBeInstanceOf(StaleRunbookStateError);
  });

  it('rejects state with non-numeric schemaVersion', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_99999999999999999999999999999999';
    await fs.writeFile(
      path.join(runsDir, `${id}.json`),
      JSON.stringify({ ...STALE_V3_STATE, id, schemaVersion: 'v3' }, null, 2),
    );
    // Either the version guard or the schema parse rejects this — both are acceptable
    // as long as the loader does NOT silently coerce or migrate.
    await expect(manager.load(id)).rejects.toThrow();
  });

  // Not applicable: snapshot version travels with the wrapper schemaVersion.
});

describe('RunbookStateManager.update() — lastAction origin persistence', () => {
  let tmpDir: string;
  let manager: RunbookStateManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
    manager = new RunbookStateManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('preserves aggregation origin across unrelated updates', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(
      path.join(runsDir, `${BASE_RUN_ID}.json`),
      JSON.stringify(
        {
          ...BASE_SCHEMA_STATE,
          variables: {},
          lifecycle: 'running',
          schemaVersion: 5,
          lastAction: { type: 'COMPLETE', origin: 'aggregation' },
        },
        null,
        2,
      ),
    );

    await manager.update(BASE_RUN_ID, { stepName: 'updated' });
    const reloaded = await manager.load(BASE_RUN_ID);

    expect(reloaded?.lastAction).toEqual({ type: 'COMPLETE', origin: 'aggregation' });
  });
});
