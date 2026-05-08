import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { applyOp, merge, replace } from '../../src/runbook/state-update-ops.js';
import type { MergeOp, ReplaceOp } from '../../src/runbook/state-update-ops.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import type { Runbook, ResolvedCompletion } from '../../src/runbook/types.js';
import { makeBaseStep } from '../helpers/step-factories.js';

describe('RunbookStateManager.update() — per-field op semantics', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  const mockRunbook: Runbook = {
    title: 'Update ops',
    description: 'Tests update() merge/replace ops',
    steps: [makeBaseStep({ name: '1', description: 'Only' })],
  };

  const artifact = {
    uri: 'rd://artifacts/ctx1/runs/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
    runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    contextId: 'ctx1',
    runbook: { source: 'project' as const, path: 'planning/write-plan.runbook.md' },
    key: 'plan.json',
    timestamp: '2026-05-07T00:00:00.000Z',
  } satisfies ArtifactRecord;

  const otherArtifact = {
    ...artifact,
    uri: 'rd://artifacts/ctx1/runs/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/review.json',
    key: 'review.json',
  } satisfies ArtifactRecord;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'update-ops-test-'));
    manager = new RunbookStateManager(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function freshState() {
    return manager.create({ source: 'project', path: 'test.runbook.md' }, mockRunbook, {
      runbookPath: 'test.runbook.md',
    });
  }

  describe('variables — merge-only (MergeOp<string>)', () => {
    it('shallow-merges new keys into existing variables', async () => {
      const state = await freshState();
      await manager.update(state.id, { variables: merge({ a: '1' }) });
      await manager.update(state.id, { variables: merge({ b: '2' }) });

      const loaded = await manager.load(state.id);
      expect(loaded?.variables).toEqual({ a: '1', b: '2' });
    });

    it('caller-supplied keys overlay existing values', async () => {
      const state = await freshState();
      await manager.update(state.id, { variables: merge({ a: '1', b: '2' }) });
      await manager.update(state.id, { variables: merge({ b: 'updated' }) });

      const loaded = await manager.load(state.id);
      expect(loaded?.variables).toEqual({ a: '1', b: 'updated' });
    });

    it('omitting variables preserves existing entries', async () => {
      const state = await freshState();
      await manager.update(state.id, { variables: merge({ a: '1', b: '2' }) });
      await manager.update(state.id, { lifecycle: 'running' });

      const loaded = await manager.load(state.id);
      expect(loaded?.variables).toEqual({ a: '1', b: '2' });
    });
  });

  describe('templateVars — replace-only (ReplaceOp)', () => {
    it('wholesale-replaces existing templateVars', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'test.runbook.md',
          templateVars: { x: '1', y: '2' },
        },
      );
      await manager.update(state.id, { templateVars: replace({ x: '3' }) });

      const loaded = await manager.load(state.id);
      expect(loaded?.templateVars).toEqual({ x: '3' });
    });

    it('omitting templateVars preserves existing entries', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'test.runbook.md',
          templateVars: { x: '1', y: '2' },
        },
      );
      await manager.update(state.id, { lifecycle: 'running' });

      const loaded = await manager.load(state.id);
      expect(loaded?.templateVars).toEqual({ x: '1', y: '2' });
    });
  });

  describe('artifactVars — merge ∪ replace', () => {
    it('merge() adds entries without wiping existing', async () => {
      const state = await freshState();
      await manager.update(state.id, {
        artifactVars: merge({ A: artifact }),
      });
      await manager.update(state.id, {
        artifactVars: merge({ B: otherArtifact }),
      });

      const loaded = await manager.load(state.id);
      expect(loaded?.artifactVars).toEqual({ A: artifact, B: otherArtifact });
    });

    it('replace() wholesale-replaces existing artifactVars', async () => {
      const state = await freshState();
      await manager.update(state.id, {
        artifactVars: merge({ A: artifact, B: otherArtifact }),
      });
      await manager.update(state.id, {
        artifactVars: replace({ C: artifact }),
      });

      const loaded = await manager.load(state.id);
      expect(loaded?.artifactVars).toEqual({ C: artifact });
    });

    it('omitting artifactVars preserves existing entries', async () => {
      const state = await freshState();
      await manager.update(state.id, {
        artifactVars: merge({ A: artifact }),
      });
      await manager.update(state.id, { lifecycle: 'running' });

      const loaded = await manager.load(state.id);
      expect(loaded?.artifactVars).toEqual({ A: artifact });
    });
  });

  describe('resolvedCompletions — merge ∪ replace', () => {
    function makeCompletion(agentId: string): ResolvedCompletion {
      return {
        agentId,
        result: 'pass',
        targetStep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 1,
        completedAt: '2026-05-07T00:00:00.000Z',
      };
    }

    it('merge() adds one entry without wiping existing', async () => {
      const state = await freshState();
      const first = makeCompletion('agent-1');
      const second = makeCompletion('agent-2');

      await manager.update(state.id, {
        resolvedCompletions: merge({ 'k1|1|': first }),
      });
      await manager.update(state.id, {
        resolvedCompletions: merge({ 'k2|1|': second }),
      });

      const loaded = await manager.load(state.id);
      expect(loaded?.resolvedCompletions).toEqual({
        'k1|1|': first,
        'k2|1|': second,
      });
    });

    it('replace() wipes existing keys', async () => {
      const state = await freshState();
      const first = makeCompletion('agent-1');
      const second = makeCompletion('agent-2');

      await manager.update(state.id, {
        resolvedCompletions: merge({ 'k1|1|': first }),
      });
      await manager.update(state.id, {
        resolvedCompletions: replace({ 'k2|1|': second }),
      });

      const loaded = await manager.load(state.id);
      expect(loaded?.resolvedCompletions).toEqual({ 'k2|1|': second });
    });
  });

  describe('frameEntries — replace-only', () => {
    it('replace() wholesale-replaces existing frameEntries', async () => {
      const state = await freshState();
      const k1 = buildFrameKey('1');
      const k2 = buildFrameKey('2');

      await manager.update(state.id, {
        frameEntries: replace({ [k1]: 1 }),
      });
      await manager.update(state.id, {
        frameEntries: replace({ [k2]: 5 }),
      });

      const loaded = await manager.load(state.id);
      expect(loaded?.frameEntries).toEqual({ [k2]: 5 });
    });

    it('omitting frameEntries preserves existing entries', async () => {
      const state = await freshState();
      const k1 = buildFrameKey('1');

      await manager.update(state.id, {
        frameEntries: replace({ [k1]: 1 }),
      });
      await manager.update(state.id, { lifecycle: 'running' });

      const loaded = await manager.load(state.id);
      expect(loaded?.frameEntries).toEqual({ [k1]: 1 });
    });
  });

  // Compile-time-only checks: each function body is unreachable at runtime; the
  // `@ts-expect-error` directive is the assertion. tsc reports an unused
  // directive (TS2578) if the expected type error vanishes, failing the build.
  describe('compile-time footgun closure', () => {
    function _rejectsRawArtifactVars() {
      void manager.update('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        // @ts-expect-error - missing `op` discriminant; raw map is not assignable
        artifactVars: { A: artifact },
      });
    }

    function _rejectsMergeOnTemplateVars() {
      void manager.update('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        // @ts-expect-error - MergeOp is not assignable to TemplateVarsOp (replace-only)
        templateVars: merge({ x: '1' }),
      });
    }

    function _rejectsReplaceOnVariables() {
      void manager.update('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        // @ts-expect-error - ReplaceOp is not assignable to VariablesOp (merge-only)
        variables: replace({ x: '1' }),
      });
    }

    function _rejectsMergeOnFrameEntries() {
      const k1 = buildFrameKey('1');
      void manager.update('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        // @ts-expect-error - MergeOp is not assignable to FrameEntriesOp (replace-only)
        frameEntries: merge({ [k1]: 1 }),
      });
    }

    it('exposes type-only checks (compile-time assertions)', () => {
      expect(typeof _rejectsRawArtifactVars).toBe('function');
      expect(typeof _rejectsMergeOnTemplateVars).toBe('function');
      expect(typeof _rejectsReplaceOnVariables).toBe('function');
      expect(typeof _rejectsMergeOnFrameEntries).toBe('function');
    });
  });

  describe('applyOp dispatch contract', () => {
    it('throws on an unknown op tag (load-bearing for mutation testing)', () => {
      const malformed = { op: 'bogus', value: { x: 1 } } as unknown as
        | MergeOp<number>
        | ReplaceOp<Readonly<Record<string, number>>>;
      expect(() => applyOp({ a: 1 }, malformed)).toThrow(/unknown op tag/);
    });

    it('merges into an undefined existing record', () => {
      expect(applyOp(undefined, merge({ a: 1 }))).toEqual({ a: 1 });
    });

    it('replaces with the op value verbatim', () => {
      expect(applyOp({ a: 1, b: 2 }, replace({ c: 3 }))).toEqual({ c: 3 });
    });
  });
});
