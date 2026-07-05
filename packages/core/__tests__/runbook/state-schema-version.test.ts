import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookStateSchema } from '../../src/schemas.js';
import { InvalidRunbookStateError, RunbookStateManager } from '../../src/runbook/index.js';

const BASE_RUN_ID = `rd_${'1'.repeat(32)}`;
const INVALID_RUN_ID = `rd_${'2'.repeat(32)}`;
const ORCHESTRATOR_CAPABILITY_HASH = `sha256:${'a'.repeat(64)}`;
const ORCHESTRATOR_CAPABILITY_ISSUED_AT = '2026-07-05T00:00:00.000Z';

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
  orchestratorCapabilityHash: ORCHESTRATOR_CAPABILITY_HASH,
  orchestratorCapabilityIssuedAt: ORCHESTRATOR_CAPABILITY_ISSUED_AT,
};

describe('RunbookStateSchema — schema version 2 and lifecycle fields', () => {
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

  it('accepts number values inside variables', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: { count: 42 },
      lifecycle: 'running',
      schemaVersion: 2,
    });

    expect(parsed.variables).toEqual({ count: 42 });
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

  it('preserves aggregation origin on persisted lastAction', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 2,
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
      schemaVersion: 2,
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
        schemaVersion: 2,
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
        schemaVersion: 2,
      }),
    ).toThrow(
      /artifact-record-shaped objects must be validated by ArtifactRecordSchema, not the generic JsonObject branch/,
    );
  });

  it('rejects version 2 state without an orchestrator capability hash', () => {
    const invalid = {
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 2,
    };
    delete (invalid as Record<string, unknown>).orchestratorCapabilityHash;

    expect(() => RunbookStateSchema.parse(invalid)).toThrow();
  });

  it('accepts version 2 state with an orchestrator capability hash', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 2,
      orchestratorCapabilityHash: ORCHESTRATOR_CAPABILITY_HASH,
      orchestratorCapabilityIssuedAt: ORCHESTRATOR_CAPABILITY_ISSUED_AT,
    });

    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.orchestratorCapabilityHash).toBe(ORCHESTRATOR_CAPABILITY_HASH);
  });
});

describe('RunbookStateManager.load() — invalid state enforcement', () => {
  let tmpDir: string;
  let manager: RunbookStateManager;

  const VALID_V2_STATE = {
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
    orchestratorCapabilityHash: ORCHESTRATOR_CAPABILITY_HASH,
    orchestratorCapabilityIssuedAt: ORCHESTRATOR_CAPABILITY_ISSUED_AT,
    lifecycle: 'running',
    schemaVersion: 2,
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
    manager = new RunbookStateManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('throws InvalidRunbookStateError when loading non-v2 state', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const invalidState = { ...VALID_V2_STATE, schemaVersion: 1 };
    await fs.writeFile(
      path.join(runsDir, `${invalidState.id}.json`),
      JSON.stringify(invalidState, null, 2),
    );

    await expect(manager.load(invalidState.id)).rejects.toBeInstanceOf(InvalidRunbookStateError);
  });

  it('throws InvalidRunbookStateError with helpful message', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const invalidState = { ...VALID_V2_STATE, schemaVersion: 1 };
    await fs.writeFile(
      path.join(runsDir, `${invalidState.id}.json`),
      JSON.stringify(invalidState, null, 2),
    );

    await expect(manager.load(invalidState.id)).rejects.toThrow('expected schema version 2');
  });

  it('returns null for missing state file', async () => {
    const result = await manager.load('wf-does-not-exist');
    expect(result).toBeNull();
  });

  it('loads valid v2 state successfully', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const v2State = {
      ...VALID_V2_STATE,
      runbook: { source: 'project', path: 'x.md' },
      schemaVersion: 2,
    };
    await fs.writeFile(path.join(runsDir, `${v2State.id}.json`), JSON.stringify(v2State, null, 2));

    const result = await manager.load(v2State.id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(v2State.id);
  });

  it('rejects v2 state carrying removed artifactVars instead of silently dropping it', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const v2StateWithArtifactVars = {
      ...VALID_V2_STATE,
      id,
      runbook: { source: 'project', path: 'x.md' },
      schemaVersion: 2,
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
      JSON.stringify(v2StateWithArtifactVars, null, 2),
    );

    await expect(manager.load(id)).rejects.toThrow(
      /Invalid runbook state.*schema validation failed/,
    );
    await expect(manager.load(id)).rejects.not.toThrow(/prune|clear invalid state/i);
  });

  it('rejects state with missing schemaVersion', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const { schemaVersion: _omit, ...rest } = VALID_V2_STATE;
    await fs.writeFile(path.join(runsDir, `${id}.json`), JSON.stringify({ ...rest, id }, null, 2));
    await expect(manager.load(id)).rejects.toBeInstanceOf(InvalidRunbookStateError);
    await expect(manager.load(id)).rejects.toThrow(/Invalid runbook state/);
    await expect(manager.load(id)).rejects.not.toThrow(/prune|clear invalid state/i);
  });

  it('rejects state with future schemaVersion', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_ffffffffffffffffffffffffffffffff';
    await fs.writeFile(
      path.join(runsDir, `${id}.json`),
      JSON.stringify({ ...VALID_V2_STATE, id, schemaVersion: 3 }, null, 2),
    );
    await expect(manager.load(id)).rejects.toBeInstanceOf(InvalidRunbookStateError);
    await expect(manager.load(id)).rejects.toThrow(/Invalid runbook state/);
    await expect(manager.load(id)).rejects.not.toThrow(/prune|clear invalid state/i);
  });

  it('rejects state with non-numeric schemaVersion', async () => {
    const runsDir = path.join(tmpDir, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const id = 'rd_99999999999999999999999999999999';
    await fs.writeFile(
      path.join(runsDir, `${id}.json`),
      JSON.stringify({ ...VALID_V2_STATE, id, schemaVersion: 'v2' }, null, 2),
    );
    await expect(manager.load(id)).rejects.toThrow(/Invalid runbook state/);
    await expect(manager.load(id)).rejects.not.toThrow(/prune|clear invalid state/i);
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
          schemaVersion: 2,
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
