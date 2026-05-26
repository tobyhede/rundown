import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookStateSchema } from '../../src/schemas.js';
import { InvalidRunbookStateError, RunbookStateManager } from '../../src/runbook/index.js';

const BASE_RUN_ID = `rd_${'1'.repeat(32)}`;
const INVALID_RUN_ID = `rd_${'2'.repeat(32)}`;

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

describe('RunbookStateSchema — schema version 1 and lifecycle fields', () => {
  it('accepts state with schemaVersion 1 and lifecycle field', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 1,
    });
    expect(parsed.lifecycle).toBe('running');
    expect(parsed.schemaVersion).toBe(1);
  });

  it('accepts all lifecycle enum values', () => {
    for (const lc of ['running', 'completed', 'stopped']) {
      const parsed = RunbookStateSchema.parse({
        ...BASE_SCHEMA_STATE,
        variables: {},
        lifecycle: lc,
        schemaVersion: 1,
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
        schemaVersion: 1,
      }),
    ).toThrow();
  });

  it('accepts number values inside variables', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: { count: 42 },
      lifecycle: 'running',
      schemaVersion: 1,
    });

    expect(parsed.variables).toEqual({ count: 42 });
  });

  it('accepts empty variables map', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 1,
    });
    expect(parsed.variables).toEqual({});
  });

  it('accepts string-only variables map', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: { env: 'staging', version: '1.2.3' },
      lifecycle: 'running',
      schemaVersion: 1,
    });
    expect(parsed.variables).toEqual({ env: 'staging', version: '1.2.3' });
  });

  it('preserves aggregation origin on persisted lastAction', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 1,
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
      schemaVersion: 1,
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
        schemaVersion: 1,
      }),
    ).toThrow(/artifactVars/);
  });

  it('rejects artifact-shaped objects persisted under templateVars without migrating them', () => {
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
        templateVars: { Plan: artifact },
        lifecycle: 'running',
        schemaVersion: 1,
      }),
    ).toThrow(
      /artifact-record-shaped objects must be validated by ArtifactRecordSchema, not the generic JsonObject branch/,
    );
  });
});

describe('RunbookStateManager.load() — invalid state enforcement', () => {
  let tmpDir: string;
  let manager: RunbookStateManager;

  const VALID_V1_STATE = {
    id: INVALID_RUN_ID,
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
    schemaVersion: 1,
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
    manager = new RunbookStateManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('throws InvalidRunbookStateError when loading non-v1 state', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const invalidState = { ...VALID_V1_STATE, schemaVersion: 2 };
    await fs.writeFile(
      path.join(runsDir, `${invalidState.id}.json`),
      JSON.stringify(invalidState, null, 2),
    );

    await expect(manager.load(invalidState.id)).rejects.toBeInstanceOf(InvalidRunbookStateError);
  });

  it('throws InvalidRunbookStateError with helpful message', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const invalidState = { ...VALID_V1_STATE, schemaVersion: 2 };
    await fs.writeFile(
      path.join(runsDir, `${invalidState.id}.json`),
      JSON.stringify(invalidState, null, 2),
    );

    await expect(manager.load(invalidState.id)).rejects.toThrow('expected schema version 1');
  });

  it('returns null for missing state file', async () => {
    const result = await manager.load('wf-does-not-exist');
    expect(result).toBeNull();
  });

  it('loads valid v1 state successfully', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const v1State = {
      ...VALID_V1_STATE,
      runbook: { source: 'project', path: 'x.md' },
      schemaVersion: 1,
    };
    await fs.writeFile(path.join(runsDir, `${v1State.id}.json`), JSON.stringify(v1State, null, 2));

    const result = await manager.load(v1State.id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(v1State.id);
  });

  it('rejects v1 state carrying removed artifactVars instead of silently dropping it', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const v1StateWithArtifactVars = {
      ...VALID_V1_STATE,
      id,
      runbook: { source: 'project', path: 'x.md' },
      schemaVersion: 1,
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
      JSON.stringify(v1StateWithArtifactVars, null, 2),
    );

    await expect(manager.load(id)).rejects.toThrow(
      /Invalid runbook state.*schema validation failed/,
    );
  });

  it('rejects state with missing schemaVersion', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const { schemaVersion: _omit, ...rest } = VALID_V1_STATE;
    await fs.writeFile(path.join(runsDir, `${id}.json`), JSON.stringify({ ...rest, id }, null, 2));
    await expect(manager.load(id)).rejects.toBeInstanceOf(InvalidRunbookStateError);
  });

  it('rejects state with future schemaVersion', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_ffffffffffffffffffffffffffffffff';
    await fs.writeFile(
      path.join(runsDir, `${id}.json`),
      JSON.stringify({ ...VALID_V1_STATE, id, schemaVersion: 2 }, null, 2),
    );
    await expect(manager.load(id)).rejects.toBeInstanceOf(InvalidRunbookStateError);
  });

  it('rejects state with non-numeric schemaVersion', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_99999999999999999999999999999999';
    await fs.writeFile(
      path.join(runsDir, `${id}.json`),
      JSON.stringify({ ...VALID_V1_STATE, id, schemaVersion: 'v2' }, null, 2),
    );
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
          schemaVersion: 1,
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
