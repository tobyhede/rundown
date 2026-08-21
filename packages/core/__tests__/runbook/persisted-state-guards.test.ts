import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookStateSchema } from '../../src/schemas.js';
import { getRunbookStore } from '../../src/runbook/storage/store-registry.js';
import {
  InvalidRunbookStateError,
  LegacySnapshotError,
  RunbookStateManager,
} from '../../src/runbook/index.js';
import { CURRENT_SCHEMA_VERSION, applyRunbookStateUpdate } from '../../src/runbook/state.js';
import type { RunbookState } from '../../src/runbook/types.js';
import {
  brandInitialTemplateVarsForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';
import { logger } from '../../src/logger.js';
import { seedRawRunState } from '../../src/testing/state-fixtures.js';
import {
  FOREIGN_SCHEMA_VERSION,
  readPersistedRunState,
  writeRawRunJson,
} from '../../src/testing/session-fixtures.js';

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
  templateVars: {},
  prompted: false,
};

describe('RunbookStateSchema — schema version and lifecycle fields', () => {
  it('rejects state without templateVars — persistable state always carries it', () => {
    const { templateVars: _omit, ...withoutTemplateVars } = BASE_SCHEMA_STATE;

    const result = RunbookStateSchema.safeParse({
      ...withoutTemplateVars,
      variables: {},
      lifecycle: 'running',
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });

    expect(result.success).toBe(false);
  });

  // Required on the same terms, and refused at the same seam. This is what
  // extends the refusal past `RunbookStateManager.load` — which names the field
  // explicitly — to the in-transaction reader `RunbookStore.readRun`, whose only
  // structural gate is this parse.
  it('rejects state without prompted — persistable state always carries it', () => {
    const { prompted: _omit, ...withoutPrompted } = BASE_SCHEMA_STATE;

    const result = RunbookStateSchema.safeParse({
      ...withoutPrompted,
      variables: {},
      lifecycle: 'running',
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });

    expect(result.success).toBe(false);
  });

  it('accepts state with the current schemaVersion and a lifecycle field', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });
    expect(parsed.lifecycle).toBe('running');
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('accepts all lifecycle enum values', () => {
    for (const lc of ['running', 'completed', 'stopped']) {
      const parsed = RunbookStateSchema.parse({
        ...BASE_SCHEMA_STATE,
        variables: {},
        lifecycle: lc,
        schemaVersion: CURRENT_SCHEMA_VERSION,
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
        schemaVersion: CURRENT_SCHEMA_VERSION,
      }),
    ).toThrow();
  });

  it('accepts number values inside variables', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: { count: 42 },
      lifecycle: 'running',
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });

    expect(parsed.variables).toEqual({ count: 42 });
  });

  it('accepts empty variables map', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });
    expect(parsed.variables).toEqual({});
  });

  it('accepts string-only variables map', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: { env: 'staging', version: '1.2.3' },
      lifecycle: 'running',
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });
    expect(parsed.variables).toEqual({ env: 'staging', version: '1.2.3' });
  });

  it('preserves aggregation origin on persisted lastAction', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: CURRENT_SCHEMA_VERSION,
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
      schemaVersion: CURRENT_SCHEMA_VERSION,
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
        schemaVersion: CURRENT_SCHEMA_VERSION,
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
        schemaVersion: CURRENT_SCHEMA_VERSION,
      }),
    ).toThrow(
      /artifact-record-shaped objects must be validated by ArtifactRecordSchema, not the generic JsonObject branch/,
    );
  });
});

describe('RunbookStateManager.load() — invalid state enforcement', () => {
  let tmpDir: string;
  let manager: RunbookStateManager;

  const VALID_CURRENT_STATE = {
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
    templateVars: {},
    prompted: false,
    lifecycle: 'running',
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
    manager = new RunbookStateManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('throws InvalidRunbookStateError when loading foreign-version state', async () => {
    const invalidState = { ...VALID_CURRENT_STATE, schemaVersion: FOREIGN_SCHEMA_VERSION };
    await seedRawRunState(tmpDir, invalidState);

    await expect(manager.load(invalidState.id)).rejects.toBeInstanceOf(InvalidRunbookStateError);
  });

  it('throws InvalidRunbookStateError with helpful message', async () => {
    const invalidState = { ...VALID_CURRENT_STATE, schemaVersion: FOREIGN_SCHEMA_VERSION };
    await seedRawRunState(tmpDir, invalidState);

    await expect(manager.load(invalidState.id)).rejects.toThrow(
      `expected schema version ${String(CURRENT_SCHEMA_VERSION)}`,
    );
  });

  it('returns null for missing state file', async () => {
    const result = await manager.load('wf-does-not-exist');
    expect(result).toBeNull();
  });

  it('loads valid current-version state successfully', async () => {
    const currentState = {
      ...VALID_CURRENT_STATE,
      runbook: { source: 'project', path: 'x.md' },
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };
    await seedRawRunState(tmpDir, currentState);

    const result = await manager.load(currentState.id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(currentState.id);
  });

  it('rejects current-version state carrying removed artifactVars instead of silently dropping it', async () => {
    const id = 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const stateWithArtifactVars = {
      ...VALID_CURRENT_STATE,
      id,
      runbook: { source: 'project', path: 'x.md' },
      schemaVersion: CURRENT_SCHEMA_VERSION,
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
    await seedRawRunState(tmpDir, stateWithArtifactVars);

    await expect(manager.load(id)).rejects.toThrow(
      /Invalid runbook state.*schema validation failed/,
    );
    await expect(manager.load(id)).rejects.not.toThrow(/prune|clear invalid state/i);
  });

  it('rejects state with missing schemaVersion', async () => {
    const id = 'rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const { schemaVersion: _omit, ...rest } = VALID_CURRENT_STATE;
    await seedRawRunState(tmpDir, { ...rest, id });
    await expect(manager.load(id)).rejects.toBeInstanceOf(InvalidRunbookStateError);
    await expect(manager.load(id)).rejects.toThrow(/Invalid runbook state/);
    await expect(manager.load(id)).rejects.not.toThrow(/prune|clear invalid state/i);
  });

  it('rejects current-schema state missing templateVars instead of reconstructing it', async () => {
    // A current-version row without templateVars is incompatible state, not a shape to
    // rebuild by re-parsing runbookSrc. The recovery path is prune and restart.
    const id = 'rd_cccccccccccccccccccccccccccccccc';
    const { templateVars: _omit, ...withoutTemplateVars } = VALID_CURRENT_STATE;
    await seedRawRunState(tmpDir, {
      ...withoutTemplateVars,
      id,
      runbook: { source: 'project', path: 'x.md' },
    });

    // One load, three assertions against the same rejection: re-invoking would
    // assert about three separate calls, so a refusal that only held on the
    // first would still pass.
    const load = manager.load(id);

    await expect(load).rejects.toBeInstanceOf(InvalidRunbookStateError);
    await expect(load).rejects.toThrow(/missing templateVars/);
    await expect(load).rejects.toThrow(/prune/i);
    // The RD-309 defect too, not only the prose. It is what names the run in
    // the error envelope's FIELDS, and the reason is what separates this gate
    // from the other four that share the class.
    await expect(load).rejects.toMatchObject({
      defect: { runId: id, reason: 'missing_template_vars' },
    });
  });

  it('rejects current-schema state missing prompted instead of defaulting it', async () => {
    // A current-version row without `prompted` is incompatible state, not a run to guess a
    // mode for. Defaulting it would decide whether the run announces its
    // commands or executes them, which is the whole content of the field.
    const id = 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab';
    const { prompted: _omit, ...withoutPrompted } = VALID_CURRENT_STATE;
    await seedRawRunState(tmpDir, {
      ...withoutPrompted,
      id,
      runbook: { source: 'project', path: 'x.md' },
    });

    const load = manager.load(id);

    await expect(load).rejects.toBeInstanceOf(InvalidRunbookStateError);
    await expect(load).rejects.toThrow(/missing prompted/);
    await expect(load).rejects.toThrow(/prune/i);
    await expect(load).rejects.toMatchObject({
      defect: { runId: id, reason: 'missing_prompted' },
    });
  });

  it('rejects state with future schemaVersion', async () => {
    const id = 'rd_ffffffffffffffffffffffffffffffff';
    await seedRawRunState(tmpDir, {
      ...VALID_CURRENT_STATE,
      id,
      schemaVersion: FOREIGN_SCHEMA_VERSION,
    });
    await expect(manager.load(id)).rejects.toBeInstanceOf(InvalidRunbookStateError);
    await expect(manager.load(id)).rejects.toThrow(/Invalid runbook state/);
    await expect(manager.load(id)).rejects.not.toThrow(/prune|clear invalid state/i);
  });

  it('rejects state with non-numeric schemaVersion', async () => {
    const id = 'rd_99999999999999999999999999999999';
    await seedRawRunState(tmpDir, { ...VALID_CURRENT_STATE, id, schemaVersion: 'v2' });
    await expect(manager.load(id)).rejects.toThrow(/Invalid runbook state/);
    await expect(manager.load(id)).rejects.not.toThrow(/prune|clear invalid state/i);
  });

  it('rejects a GOTO_NEXT lastAction as a legacy snapshot', async () => {
    // The gate's headline behaviour, and until now exercised only through the
    // other caller (`RunbookStore.readRun`, in runbook-store.test.ts) — so the
    // module's own tests never pinned it, and mutation testing could delete the
    // whole branch with this file still green. `LegacySnapshotError` is a
    // distinct class, not a flavour of InvalidRunbookStateError: the CLI's
    // recoverable-state taxonomy routes the two to different advice.
    const id = `rd_${'b'.repeat(32)}`;
    await seedRawRunState(tmpDir, {
      ...VALID_CURRENT_STATE,
      id,
      lastAction: { type: 'GOTO_NEXT', target: '2' },
    });

    const load = manager.load(id);

    await expect(load).rejects.toBeInstanceOf(LegacySnapshotError);
    await expect(load).rejects.toThrow(/GOTO_NEXT/);
    await expect(load).rejects.toThrow(/restart execution from the runbook entrypoint/i);
    // The RD-309 half. It exists so a consumer reads the run id and the reason
    // as fields instead of pattern-matching the prose above, which makes it the
    // half no message assertion can stand in for — and mutation testing found
    // the whole literal could be emptied with the message tests still green.
    await expect(load).rejects.toMatchObject({
      defect: { runId: id, reason: 'legacy_dynamic_step_snapshot' },
    });
  });

  it('rejects a top-level instance field as a legacy snapshot', async () => {
    // The second dynamic-step shape. Kept separate from the GOTO_NEXT test
    // rather than merged into a table: they are independent gates over
    // independent fields, and one test covering both would let either gate be
    // deleted while the other kept the assertion passing.
    const id = `rd_${'c'.repeat(32)}`;
    await seedRawRunState(tmpDir, { ...VALID_CURRENT_STATE, id, instance: { stepId: '1' } });

    const load = manager.load(id);

    await expect(load).rejects.toBeInstanceOf(LegacySnapshotError);
    await expect(load).rejects.toThrow(/instance field/);
    // Both halves of the message, and the defect, for the reason above: this
    // gate carries its own copy of each, so an assertion on the sibling gate
    // proves nothing about this one.
    await expect(load).rejects.toThrow(/restart execution from the runbook entrypoint/i);
    await expect(load).rejects.toMatchObject({
      defect: { runId: id, reason: 'legacy_dynamic_step_snapshot' },
    });
  });

  it('reports a legacy snapshot ahead of the foreign schema version it also carries', async () => {
    // Gate order is contract, not accident, and this is the only case that can
    // tell: a pre-v1 row fails the version check too, so whichever gate runs
    // first decides what the user is told. The legacy message is the actionable
    // one — "restart from the entrypoint" — where the version message only
    // names the run. Reversing the gates would silently downgrade that, and no
    // single-defect row would notice.
    const id = `rd_${'d'.repeat(32)}`;
    await seedRawRunState(tmpDir, {
      ...VALID_CURRENT_STATE,
      id,
      schemaVersion: 0,
      lastAction: { type: 'GOTO_NEXT', target: '2' },
    });

    const load = manager.load(id);

    await expect(load).rejects.toBeInstanceOf(LegacySnapshotError);
    await expect(load).rejects.not.toThrow(/schema version/);
  });

  it('rejects a persisted null lastAction as invalid state, not a bare TypeError', async () => {
    // The legacy-snapshot gate reads `lastAction.type` before any schema parse,
    // and `typeof null === 'object'` — so the `lastAction !== null` conjunct is
    // the only thing standing between a null here and a TypeError thrown from
    // inside the gate. That matters because of what the gate exists to
    // guarantee: `load` wraps only a SyntaxError out of `readRunJson`, so an
    // unguarded dereference escapes untyped, surfaces as RD-999 / "Unknown
    // error", and misses the InvalidRunbookStateError arm the CLI's
    // recoverable-state taxonomy classifies on. Persisted null is reachable
    // precisely because it is not schema-legal — `lastAction` is `.optional()`,
    // never `.nullable()`, so nothing this codebase writes produces it and only
    // a corrupted row does. Mutation testing found the conjunct survived
    // `→ true`: every other test seeds `lastAction` absent or well-formed.
    const id = `rd_${'a'.repeat(32)}`;
    await seedRawRunState(tmpDir, { ...VALID_CURRENT_STATE, id, lastAction: null });

    // One load, both assertions: the class is what proves the gate did not
    // throw raw, the message is what proves it fell through to the schema parse
    // rather than being caught by a legacy arm that never inspected the value.
    const load = manager.load(id);

    await expect(load).rejects.toBeInstanceOf(InvalidRunbookStateError);
    await expect(load).rejects.toThrow(/schema validation failed/);
  });

  it('rejects unparseable persisted state_json as invalid state, not a bare SyntaxError', async () => {
    // A raw SyntaxError escaping `load` surfaces to users as RD-999 / "Unknown
    // error" instead of a typed invalid-state refusal, and bypasses the
    // InvalidRunbookStateError arm of the CLI's recoverable-state taxonomy.
    const id = 'rd_dddddddddddddddddddddddddddddddd';
    await seedRawRunState(tmpDir, { ...VALID_CURRENT_STATE, id });
    await writeRawRunJson(tmpDir, id, '{ not valid json');

    await expect(manager.load(id)).rejects.toBeInstanceOf(InvalidRunbookStateError);
    await expect(manager.load(id)).rejects.toThrow(/not valid JSON/);
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
    await seedRawRunState(tmpDir, {
      ...BASE_SCHEMA_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      lastAction: { type: 'COMPLETE', origin: 'aggregation' },
    });

    await manager.update(BASE_RUN_ID, { stepName: 'updated' });
    const reloaded = await manager.load(BASE_RUN_ID);

    expect(reloaded?.lastAction).toEqual({ type: 'COMPLETE', origin: 'aggregation' });
  });
});

describe('applyRunbookStateUpdate — stamps, never migrates', () => {
  // Fully typed rather than cast: `schemaVersion` is optional on RunbookState, so
  // the "carries none" case below is expressible without escaping the type. A
  // blanket `as unknown as RunbookState` would also suppress the compile error a
  // future RunbookState field ought to raise here. Only the three branded fields
  // (`id`, `variables`, `templateVars`) need helpers, and those exist for tests.
  const derivable: RunbookState = {
    ...BASE_SCHEMA_STATE,
    id: brandRunIdForTest(BASE_SCHEMA_STATE.id),
    runbook: { source: 'project', path: 'x.md' },
    variables: brandStoredOutputsForTest({}),
    templateVars: brandInitialTemplateVarsForTest({}),
    lifecycle: 'running',
  };

  it('stamps the current version on the derived state', () => {
    const current = { ...derivable, schemaVersion: CURRENT_SCHEMA_VERSION };

    const patched = applyRunbookStateUpdate(current, { stepName: 'x' }, '2026-04-19T00:00:01Z');

    expect(patched.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('refuses a state carrying no schema version rather than stamping one on', () => {
    // `load` rejects an absent version exactly as it rejects a wrong one, so
    // exempting absent here would make this derivation MORE permissive than the
    // loader it exists to keep faith with: a state `load` refuses would be
    // laundered into one it accepts. Absent is the more degraded shape, and the
    // only one the store can hand over unvalidated — its zod schema leaves the
    // field optional so `load` can parse far enough to reach its own check.
    expect(() =>
      applyRunbookStateUpdate(derivable, { stepName: 'x' }, '2026-04-19T00:00:01Z'),
    ).toThrow(InvalidRunbookStateError);
  });

  it('refuses a state carrying a different schema version instead of rewriting it', () => {
    // Persisted state has no compatibility contract: the recovery path is
    // explicit user action (finish/stop/prune/restart), never a silent rewrite.
    // Stamping unconditionally would turn the fenced path into exactly the
    // migration CLAUDE.md forbids, and would erase the only signal that says so.
    const stale = { ...derivable, schemaVersion: CURRENT_SCHEMA_VERSION + 1 };

    expect(() => applyRunbookStateUpdate(stale, { stepName: 'x' }, '2026-04-19T00:00:01Z')).toThrow(
      InvalidRunbookStateError,
    );
  });
});

describe('pre-#772 inline shape — refused by the structural parse, not the version gate', () => {
  // The regression #775 names. Three PRs added a required field to the persisted
  // run state without moving CURRENT_SCHEMA_VERSION: #746 introduced
  // `StepInlineChild.startedAt`, #772 replaced it with a required `started`, and
  // #827 made `prompted` required. Per CLAUDE.md § Active Development Stance and
  // § State Persistence, the constant was deliberately left at `1` rather than
  // moved to cover this: no persisted state outside a local clone or CI run is
  // worth protecting with the nicer classification, and the structural parse
  // already refuses this shape on its own. This block pins what that refusal
  // actually looks like at each reader, not what it would look like if the
  // constant had moved.
  //
  // The shape below is what a run persisted mid-inline-launch on a pre-#772 build
  // carries: `inline.startedAt`, no `inline.started`. Everything else about it is
  // current and valid, so the missing field is the only thing that can
  // legitimately refuse it.
  const PRE_STARTED_RUN_ID = `rd_${'7'.repeat(32)}`;
  const PRE_STARTED_CHILD_ID = `rd_${'8'.repeat(32)}`;
  const PRE_STARTED_SCHEMA_VERSION = 1;

  const preStartedInlineState = {
    id: PRE_STARTED_RUN_ID,
    runbook: { source: 'project', path: 'parent.md' },
    runbookPath: 'parent.md',
    step: '1',
    stepName: 'Parent',
    retryCount: 0,
    variables: {},
    steps: [],
    substepStates: [
      {
        id: '1',
        frameKey: '1|',
        status: 'running',
        inline: {
          childRunbookPath: 'child.md',
          childRunbookRef: { source: 'project', path: 'child.md' },
          contextSnapshot: { vars: {}, ancestors: [] },
          childRunId: PRE_STARTED_CHILD_ID,
          createdAt: '2026-08-13T00:00:00.000Z',
          // The pre-#772 latch field. `started` — required since #772 — is absent.
          startedAt: null,
        },
      },
    ],
    startedAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    templateVars: {},
    prompted: false,
    lifecycle: 'running',
    schemaVersion: PRE_STARTED_SCHEMA_VERSION,
  };

  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
    await seedRawRunState(tmpDir, preStartedInlineState);
  });

  afterEach(async () => {
    // `logger` is a module singleton; a spy leaked by a failing assertion would
    // silence every suite that runs after this one.
    jest.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('carries the version the current build also writes', () => {
    // The premise both tests below rest on, asserted rather than assumed. If the
    // constant ever moves away from the version that shape was written under,
    // the gate would start firing first and these assertions would be pinning a
    // refusal the version gate produces, under names that say the parse does.
    expect(CURRENT_SCHEMA_VERSION).toBe(PRE_STARTED_SCHEMA_VERSION);
  });

  it('clears the version gate and is refused by the structural parse through RunbookStateManager.load', async () => {
    const manager = new RunbookStateManager(tmpDir);

    const load = manager.load(PRE_STARTED_RUN_ID);

    await expect(load).rejects.toBeInstanceOf(InvalidRunbookStateError);
    // The reason, not only the class. `invalid_schema_version` and
    // `schema_validation_failed` share one error class, so the class alone
    // cannot tell the version gate from the parse — only the reason can, and
    // only the parse's reason is correct here, since the version matches.
    await expect(load).rejects.toMatchObject({
      defect: {
        runId: PRE_STARTED_RUN_ID,
        reason: 'schema_validation_failed',
      },
    });
  });

  it('clears the version gate and is refused as invalid state on both store read seams', async () => {
    const store = await getRunbookStore(tmpDir);
    const runId = brandRunIdForTest(PRE_STARTED_RUN_ID);

    // `loadRun` and the in-transaction `ctx.readState` share one validating
    // read, and this is the shape that reaches its parse: the version check
    // passes (both are `1`), so nothing before the parse can refuse the row.
    // Until #828 the parse threw a bare `ZodError` here — outside the taxonomy
    // `isRecoverableActiveStackError` classifies on, so it surfaced as RD-999
    // "Unknown error" and left a `--claim-id` bearer unable to finish, stop or
    // prune the run. Both seams, because pinning only `loadRun` would leave the
    // transactional read — the one `rundown stash` / `pop` go through on all
    // four of their paths — unpinned.
    const seams: readonly (() => Promise<unknown>)[] = [
      () => store.loadRun(runId),
      () => store.mutateSession((ctx) => ctx.readState(runId)),
    ];

    for (const read of seams) {
      await expect(read()).rejects.toBeInstanceOf(InvalidRunbookStateError);
      // The reason, not only the class. `invalid_schema_version` and
      // `schema_validation_failed` share one error class, so the class alone
      // cannot tell the version gate from the parse — and this row's version
      // matches, so only the parse's reason is correct. It is the same reason
      // `RunbookStateManager.load` reports for the same row above, which is the
      // whole point: one taxonomy across both readers, past the gates as well
      // as before them.
      await expect(read()).rejects.toMatchObject({
        defect: { runId: PRE_STARTED_RUN_ID, reason: 'schema_validation_failed' },
      });
    }
  });

  it('logs which fields failed, at debug, carrying no rejected values', async () => {
    // The refusal message names the run and nothing else, because it is an
    // operator instruction rather than a schema report. That leaves nowhere for
    // the one useful thing the old bare `ZodError` did carry — which field
    // failed — so it goes to the debug trail instead.
    const debug = jest.spyOn(logger, 'debug').mockResolvedValue(undefined);

    await expect(new RunbookStateManager(tmpDir).load(PRE_STARTED_RUN_ID)).rejects.toBeInstanceOf(
      InvalidRunbookStateError,
    );

    const entry = debug.mock.calls.find(([message]) => message === 'invalid-run-state');
    expect(entry).toBeDefined();
    const data = entry?.[1] as { runId: string; issues: Record<string, unknown>[] };
    expect(data.runId).toBe(PRE_STARTED_RUN_ID);
    // The whole array, exactly. The dotted path is the diagnosis — the drift
    // this fixture carries is inside the inline latch, so a trail that stopped
    // at the top-level field would name the wrong thing — and comparing the
    // entries whole is also the redaction guarantee: a Zod issue can quote the
    // value it rejected, persisted run state holds delegation tokens, and a
    // third key appearing here would fail this assertion rather than ship.
    expect(data.issues).toEqual([{ path: 'substepStates.0.inline.started', code: 'invalid_type' }]);
  });

  it('leaves the refused row exactly as persisted', async () => {
    // Refusing is only half the no-migration rule; the other half is that the
    // refusal writes nothing. A gate that rejected the row and then re-stamped
    // it with the current version would satisfy a schemaVersion-only assertion
    // while performing the silent migration CLAUDE.md forbids — and would
    // destroy the evidence a user needs to understand why the run cannot be
    // resumed. Comparing the whole row before and after, not just the two
    // fields the shape drift touches, is what actually pins "exactly as
    // persisted" rather than "the fields we happened to check".
    const before = await readPersistedRunState(tmpDir, PRE_STARTED_RUN_ID);

    await expect(new RunbookStateManager(tmpDir).load(PRE_STARTED_RUN_ID)).rejects.toBeInstanceOf(
      InvalidRunbookStateError,
    );

    const after = await readPersistedRunState(tmpDir, PRE_STARTED_RUN_ID);

    expect(after).toEqual(before);
    // Named explicitly too, so a failure here says which field regressed
    // instead of only "the row changed".
    expect(after?.schemaVersion).toBe(PRE_STARTED_SCHEMA_VERSION);
    // The pre-#772 latch field survives too: the row is untouched, not merely
    // un-renumbered.
    expect(after?.substepStates).toEqual(preStartedInlineState.substepStates);
  });
});
