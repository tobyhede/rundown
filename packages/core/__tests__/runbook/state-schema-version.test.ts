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

describe('RunbookStateSchema — schema version 3 and lifecycle fields', () => {
  it('accepts state with schemaVersion 3 and lifecycle field', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 3,
    });
    expect(parsed.lifecycle).toBe('running');
    expect(parsed.schemaVersion).toBe(3);
  });

  it('accepts all lifecycle enum values', () => {
    for (const lc of ['running', 'completed', 'stopped']) {
      const parsed = RunbookStateSchema.parse({
        ...BASE_SCHEMA_STATE,
        variables: {},
        lifecycle: lc,
        schemaVersion: 3,
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
        schemaVersion: 3,
      }),
    ).toThrow();
  });

  it('rejects number values inside variables', () => {
    expect(() =>
      RunbookStateSchema.parse({
        ...BASE_SCHEMA_STATE,
        variables: { count: 42 },
        lifecycle: 'running',
        schemaVersion: 3,
      }),
    ).toThrow();
  });

  it('accepts empty variables map', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 3,
    });
    expect(parsed.variables).toEqual({});
  });

  it('accepts string-only variables map', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: { env: 'staging', version: '1.2.3' },
      lifecycle: 'running',
      schemaVersion: 3,
    });
    expect(parsed.variables).toEqual({ env: 'staging', version: '1.2.3' });
  });

  it('accepts variables carrying exact and wildcard artifact records alongside strings', () => {
    const artifact = {
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
      schemaVersion: 3,
    });

    expect(parsed.variables).toEqual({
      PlanPath: artifact,
      Reviews: [artifact],
      Note: 'string-output',
    });
  });
});

describe('RunbookStateManager.load() — stale state enforcement', () => {
  let tmpDir: string;
  let manager: RunbookStateManager;

  const STALE_V2_STATE = {
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
    schemaVersion: 2, // old version
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
    manager = new RunbookStateManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('throws StaleRunbookStateError when loading v2 state', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(
      path.join(runsDir, `${STALE_V2_STATE.id}.json`),
      JSON.stringify(STALE_V2_STATE, null, 2),
    );

    await expect(manager.load(STALE_V2_STATE.id)).rejects.toBeInstanceOf(StaleRunbookStateError);
  });

  it('throws StaleRunbookStateError with helpful message', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(
      path.join(runsDir, `${STALE_V2_STATE.id}.json`),
      JSON.stringify(STALE_V2_STATE, null, 2),
    );

    await expect(manager.load(STALE_V2_STATE.id)).rejects.toThrow('rd prune --all');
  });

  it('returns null for missing state file', async () => {
    const result = await manager.load('wf-does-not-exist');
    expect(result).toBeNull();
  });

  it('loads valid v3 state successfully', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const v3State = {
      ...STALE_V2_STATE,
      runbook: { source: 'project', path: 'x.md' },
      schemaVersion: 3,
    };
    await fs.writeFile(path.join(runsDir, `${v3State.id}.json`), JSON.stringify(v3State, null, 2));

    const result = await manager.load(v3State.id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(v3State.id);
  });

  it('rejects state with missing schemaVersion', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const { schemaVersion: _omit, ...rest } = STALE_V2_STATE;
    await fs.writeFile(path.join(runsDir, `${id}.json`), JSON.stringify({ ...rest, id }, null, 2));
    await expect(manager.load(id)).rejects.toBeInstanceOf(StaleRunbookStateError);
  });

  it('rejects state with future schemaVersion', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_ffffffffffffffffffffffffffffffff';
    await fs.writeFile(
      path.join(runsDir, `${id}.json`),
      JSON.stringify({ ...STALE_V2_STATE, id, schemaVersion: 4 }, null, 2),
    );
    await expect(manager.load(id)).rejects.toBeInstanceOf(StaleRunbookStateError);
  });

  it('rejects state with non-numeric schemaVersion', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_99999999999999999999999999999999';
    await fs.writeFile(
      path.join(runsDir, `${id}.json`),
      JSON.stringify({ ...STALE_V2_STATE, id, schemaVersion: 'v3' }, null, 2),
    );
    // Either the version guard or the schema parse rejects this — both are acceptable
    // as long as the loader does NOT silently coerce or migrate.
    await expect(manager.load(id)).rejects.toThrow();
  });

  // Not applicable: snapshot version travels with the wrapper schemaVersion.
});
