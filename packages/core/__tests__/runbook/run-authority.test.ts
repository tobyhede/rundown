// Owner Token resolution and the T1 composition gate (#901, ADR 0005).
//
// `resolveOwnedRun` is the sole authority lookup behind every mutating command:
// a token resolves to the run it owns (with the version a later save must
// name), tells a late caller that the run finished, or matches nothing. It is
// exercised against the real store so the hash-lookup contract is the one the
// CLI will rely on.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseRunbookDocument,
  type ResolvedStep,
  type Substep,
  type Transitions,
} from '@rundown-org/parser';
import {
  findUnsupportedComposition,
  resolveOwnedRun,
  RunbookCompositionUnsupportedError,
} from '../../src/runbook/run-authority.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { generateOwnerToken, hashRunSecret } from '../../src/runbook/run-secrets.js';
import { closeRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { seedRun } from '../../src/testing/run-fixtures.js';

describe('resolveOwnedRun', () => {
  let dir: string;
  let manager: RunbookStateManager;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rd-run-authority-'));
    manager = new RunbookStateManager(dir);
  });

  afterEach(async () => {
    await closeRunbookStore(dir);
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves the owning token to its running run and the version a save must name', async () => {
    const seeded = await seedRun(dir);

    const resolution = await resolveOwnedRun(manager, seeded.ownerToken);

    expect(resolution.kind).toBe('running');
    if (resolution.kind !== 'running') return;
    expect(resolution.run.state.id).toBe(seeded.runId);
    const versioned = await manager.loadWithVersion(seeded.runId);
    expect(resolution.run.stateVersion).toBe(versioned?.stateVersion);
  });

  it('reports a finished run with its lifecycle instead of handing it back as running', async () => {
    const seeded = await seedRun(dir);
    await manager.update(seeded.runId, { lifecycle: 'stopped' });

    const resolution = await resolveOwnedRun(manager, seeded.ownerToken);

    expect(resolution).toMatchObject({
      kind: 'finished',
      lifecycle: 'stopped',
      state: expect.objectContaining({ id: seeded.runId }),
    });
  });

  it.each(['completed', 'abandoned'] as const)(
    'reports a %s run as finished',
    async (lifecycle) => {
      const seeded = await seedRun(dir);
      await manager.update(seeded.runId, { lifecycle });

      expect(await resolveOwnedRun(manager, seeded.ownerToken)).toMatchObject({
        kind: 'finished',
        lifecycle,
      });
    },
  );

  it('matches nothing for a well-formed token no run carries', async () => {
    await seedRun(dir);

    expect(await resolveOwnedRun(manager, generateOwnerToken())).toEqual({
      kind: 'unknown_token',
    });
  });

  it('resolves each of two runs only by its own token', async () => {
    const first = await seedRun(dir);
    const second = await seedRun(dir);

    const a = await resolveOwnedRun(manager, first.ownerToken);
    const b = await resolveOwnedRun(manager, second.ownerToken);

    expect(a.kind === 'running' && a.run.state.id).toBe(first.runId);
    expect(b.kind === 'running' && b.run.state.id).toBe(second.runId);
  });
});

describe('findUnsupportedComposition', () => {
  const tx: Transitions = {
    pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
    fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
  };
  const plain: Substep = { id: '1', description: 'plain', transitions: tx };
  const delegated: Substep = {
    id: '2',
    description: 'delegated',
    delegate: true,
    runbooks: ['child.runbook.md'],
    transitions: tx,
  };
  const inline: Substep = {
    id: '3',
    description: 'inline',
    runbooks: ['child.runbook.md'],
    transitions: tx,
  };
  const emptyList: Substep = { id: '4', description: 'empty list', runbooks: [], transitions: tx };

  function substepStep(name: string, substeps: readonly Substep[]): ResolvedStep {
    return {
      kind: 'substeps',
      name,
      description: `Step ${name}`,
      aggregation: { strategy: 'ALL' },
      substeps,
      transitions: tx,
    };
  }

  it('returns nothing for a runbook that composes no other runbook', () => {
    const steps: readonly ResolvedStep[] = [
      { kind: 'base', name: '1', description: 'one', transitions: tx },
      substepStep('2', [plain, emptyList]),
    ];
    expect(findUnsupportedComposition(steps)).toEqual([]);
  });

  it('names a DELEGATE substep by its qualified id', () => {
    expect(findUnsupportedComposition([substepStep('1', [plain, delegated])])).toEqual(['1.2']);
  });

  it('names a runbook-list substep by its qualified id', () => {
    expect(findUnsupportedComposition([substepStep('1', [inline])])).toEqual(['1.3']);
  });

  it('lists every composing substep across steps, in document order', () => {
    const steps: readonly ResolvedStep[] = [
      substepStep('1', [delegated, plain]),
      { kind: 'base', name: '2', description: 'two', transitions: tx },
      {
        kind: 'for',
        name: '3',
        description: 'loop',
        forClause: { variable: 'i', start: 1, end: 2 },
        substeps: [inline, delegated],
        transitions: tx,
      },
    ];
    expect(findUnsupportedComposition(steps)).toEqual(['1.2', '3.3', '3.2']);
  });

  it('names the same substeps from a parsed runbook as from a resolved one', () => {
    // `rundown check` warns from parsed steps, `rundown run` refuses from
    // resolved ones; they must agree on which substeps compose.
    const parsed = parseRunbookDocument(
      [
        '# Compose',
        '## 1. Fan out',
        '- PASS ALL COMPLETE',
        '- FAIL ANY STOP',
        '',
        '### 1.1 Local',
        '- PASS CONTINUE',
        '',
        'do work',
        '',
        '### 1.2 Delegated',
        '- DELEGATE',
        '- child.runbook.md',
        '',
        '### 1.3 Inline',
        '- child.runbook.md',
        '',
      ].join('\n'),
    );
    expect(findUnsupportedComposition(parsed.runbook.steps)).toEqual(['1.2', '1.3']);
  });
});

describe('run creation refuses a composing runbook', () => {
  // The gate lives at `RunbookStateManager.create`, the seam every run passes
  // through, so no frontend can start a run whose substeps compose other
  // runbooks: the compiled machine has no state to drive them.
  let dir: string;
  let manager: RunbookStateManager;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rd-run-authority-'));
    manager = new RunbookStateManager(dir);
  });

  afterEach(async () => {
    await closeRunbookStore(dir);
    await rm(dir, { recursive: true, force: true });
  });

  const composing = parseRunbookDocument(
    [
      '# Compose',
      '## 1. Fan out',
      '- PASS ALL COMPLETE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Local',
      '- PASS CONTINUE',
      '',
      'do work',
      '',
      '### 1.2 Delegated',
      '- DELEGATE',
      '- child.runbook.md',
      '',
      '### 1.3 Inline',
      '- child.runbook.md',
      '',
    ].join('\n'),
  ).runbook;

  it('throws a typed refusal naming every composing substep and writes no run', async () => {
    const created = manager.create({ source: 'project', path: 'compose.runbook.md' }, composing, {
      runbookPath: 'compose.runbook.md',
      ownerTokenHash: hashRunSecret(generateOwnerToken()),
    });

    await expect(created).rejects.toBeInstanceOf(RunbookCompositionUnsupportedError);
    await expect(created).rejects.toMatchObject({ substeps: ['1.2', '1.3'] });
    expect(await manager.listRunIds()).toEqual([]);
  });

  it('still creates a run for a runbook that composes nothing', async () => {
    const seeded = await seedRun(dir);

    expect(await manager.listRunIds()).toEqual([seeded.runId]);
  });
});
