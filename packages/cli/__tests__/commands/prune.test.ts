import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { RunbookStateManager, SessionService, type Runbook, type RunId } from '@rundown-org/core';
import {
  createTestWorkspace,
  runCliInProcess,
  readSession,
  listRunbookStates,
  readRunbookState,
  getActiveState,
  findActionOutput,
  parseConcatenatedJson,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/prune.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess). See collect.test.ts.
import { registerPruneCommand } from '../../src/commands/prune.js';
import { parseRunbookDocument } from '@rundown-org/parser';

describe('prune command wiring', () => {
  it('registers the prune command with its documented flags and descriptions', () => {
    const program = new Command();
    registerPruneCommand(program);

    const prune = program.commands.find((c) => c.name() === 'prune');
    expect(prune).toBeDefined();
    expect(prune?.description()).toBe('Remove runbook state (does not delete runbook files)');

    const byLong = new Map(prune!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(
      expect.arrayContaining([
        '--dry-run',
        '--completed',
        '--stopped',
        '--active',
        '--inactive',
        '--all',
        '--text',
      ]),
    );
    expect(byLong.get('--dry-run')?.description).toBe(
      'Show what would be removed without deleting',
    );
    expect(byLong.get('--completed')?.description).toBe(
      'Prune successfully completed runbook state',
    );
    expect(byLong.get('--stopped')?.description).toBe(
      'Prune stopped (aborted/failed) runbook state',
    );
    expect(byLong.get('--active')?.description).toBe('Prune active runbook state');
    expect(byLong.get('--inactive')?.description).toBe('Prune inactive (orphaned) runbook state');
    expect(byLong.get('--all')?.description).toBe('Prune all runbook state');
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
  });
});

describe('prune command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('empty workspace', () => {
    it('outputs empty message when no state exists', async () => {
      const result = await runCliInProcess('prune --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No runbook state to prune.');
    });

    it('outputs empty array in JSON mode when no state exists', async () => {
      const result = await runCliInProcess('prune', workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });
  });

  describe('default behavior (--completed + --stopped)', () => {
    it('prunes completed runbook state by default', async () => {
      // Auto-run completes the runbook (both steps pass), leaving state with completed=true
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(1);

      const result = await runCliInProcess('prune --text', workspace);

      expect(result.exitCode).toBe(0);
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(0);
    });

    it('emits only the documented ActiveRunbookEntry fields in JSON, not raw RunbookState', async () => {
      // prune JSON uses PruneResponseSchema (= ActiveRunbookListSchema), so
      // entries must not leak internal RunbookState fields.
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('prune', workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.length).toBeGreaterThan(0);
      const allowed = ['id', 'runbook', 'step', 'status', 'total', 'title'];
      const leakedKeys = Object.keys(output[0]).filter((k) => !allowed.includes(k));
      expect(leakedKeys).toEqual([]);
      expect(output[0]).not.toHaveProperty('snapshot');
      expect(output[0]).not.toHaveProperty('variables');
    });

    it('removes artifact-bearing variables when pruning a completed run', async () => {
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);
      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore).toHaveLength(1);

      const stateFile = statesBefore[0];
      const stateId = stateFile.replace('.json', '');
      const state = await readRunbookState(workspace, stateId);
      expect(state).not.toBeNull();
      const artifact = {
        kind: 'artifact-record' as const,
        uri: `rd://artifacts/ctx1/${stateId}/plan.json`,
        runId: stateId,
        contextId: 'ctx1',
        runbook: state!.runbook,
        key: 'plan.json',
        timestamp: '2026-05-07T00:00:00.000Z',
      };
      // Persist an ArtifactRecord inside the unified `variables` bucket
      // alongside a string OUTPUTS value, mirroring the post-Phase-1 shape.
      await writeFile(
        join(workspace.statePath(), stateFile),
        JSON.stringify(
          {
            ...state,
            variables: {
              ...state!.variables,
              PlanPath: artifact,
              Note: 'string-output',
            },
          },
          null,
          2,
        ),
      );

      // Sanity-check: the artifact-shaped value really is on disk before prune.
      const before = await readRunbookState(workspace, stateId);
      expect(before?.variables.PlanPath).toMatchObject({
        uri: artifact.uri,
        key: 'plan.json',
      });
      expect(before?.variables.Note).toBe('string-output');

      await runCliInProcess('prune --completed --text', workspace);

      const loaded = await readRunbookState(workspace, stateId);
      expect(loaded).toBeNull();
      // Pruning the run removes the entire state file, including any
      // artifact-shaped entries inside `variables`.
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter).toHaveLength(0);
    });

    it('prunes stopped runbook state by default', async () => {
      // Start runbook then stop it — leaves state with lifecycle=stopped
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      await runCliInProcess('stop --text', workspace);

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(1);

      const result = await runCliInProcess('prune --text', workspace);

      expect(result.exitCode).toBe(0);
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(0);
    });

    it('prunes both completed and stopped runbook state by default', async () => {
      // Create completed state
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);
      // Create stopped state
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      await runCliInProcess('stop --text', workspace);

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(2);

      const result = await runCliInProcess('prune --text', workspace);

      expect(result.exitCode).toBe(0);
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(0);
    });

    it('does not prune active runbook state by default', async () => {
      // Start prompted — runbook stays active
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(1);

      await runCliInProcess('prune --text', workspace);

      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(1);
    });

    it('shows pruned runbook info in output', async () => {
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('prune --text', workspace);

      expect(result.stdout).toContain('simple.runbook.md');
      expect(result.stdout).toContain('complete');
    });
  });

  describe('--completed flag', () => {
    it('prunes only completed runbook state', async () => {
      // Create completed state
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);
      // Create active state
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(2);

      await runCliInProcess('prune --completed --text', workspace);

      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(1);

      // Remaining state should be the active one
      const session = await readSession(workspace);
      expect(session.active).not.toBeNull();
    });
  });

  describe('--stopped flag', () => {
    it('prunes only stopped runbook state', async () => {
      // Create stopped state
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      await runCliInProcess('stop --text', workspace);

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(1);

      const result = await runCliInProcess('prune --stopped --text', workspace);

      expect(result.exitCode).toBe(0);
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(0);
    });

    it('does not prune completed state when only --stopped specified', async () => {
      // Create completed state
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);
      // Create stopped state
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      await runCliInProcess('stop --text', workspace);

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(2);

      await runCliInProcess('prune --stopped --text', workspace);

      // Only the completed state should remain
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(1);
      const remainingState = await readRunbookState(workspace, statesAfter[0].replace('.json', ''));
      expect(remainingState?.lifecycle).toBe('completed');
    });
  });

  describe('--active flag', () => {
    it('prunes active runbook state', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const session = await readSession(workspace);
      expect(session.active).not.toBeNull();

      const result = await runCliInProcess('prune --active --text', workspace);

      expect(result.exitCode).toBe(0);
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(0);
    });

    it('does not prune completed state when only --active specified', async () => {
      // Create completed state
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);
      // Create active state
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      await runCliInProcess('prune --active --text', workspace);

      // Only completed state should remain
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(1);
    });
  });

  describe('--inactive flag', () => {
    it('prunes inactive runbook state', async () => {
      // Start runbook A (will become inactive when B starts)
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const sessionA = await readSession(workspace);
      const runbookAId = sessionA.active;
      expect(runbookAId).not.toBeNull();

      // Start runbook B (makes A inactive — pushed down in stack, B on top)
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const sessionB = await readSession(workspace);
      const runbookBId = sessionB.active;
      expect(runbookBId).not.toBeNull();
      expect(runbookBId).not.toBe(runbookAId);

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(2);

      await runCliInProcess('prune --inactive --text', workspace);

      // Only the active runbook (B) should remain
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(1);
    });

    it('does not prune active or completed state when only --inactive specified', async () => {
      // Create completed state
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);
      // Create active state
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(2);

      const result = await runCliInProcess('prune --inactive --text', workspace);

      // Both completed and active should remain (neither is inactive)
      expect(result.exitCode).toBe(0);
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(2);
    });
  });

  describe('--all flag', () => {
    it('prunes all runbook state regardless of status', async () => {
      // Create completed state
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);
      // Create active state
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(2);

      await runCliInProcess('prune --all --text', workspace);

      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(0);
    });

    it('prunes inactive state when --all is specified', async () => {
      // Start runbook A (becomes inactive)
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      // Start runbook B (active, makes A inactive)
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      await runCliInProcess('prune --all --text', workspace);

      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(0);
    });
  });

  describe('--dry-run flag', () => {
    it('shows what would be removed without deleting', async () => {
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(1);

      const result = await runCliInProcess('prune --dry-run --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('simple.runbook.md');

      // State should still exist
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(1);
    });

    it('shows empty message when nothing matches in dry-run', async () => {
      const result = await runCliInProcess('prune --dry-run --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No runbook state to prune.');
    });
  });

  describe('output', () => {
    it('outputs pruned items as JSON array', async () => {
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('prune', workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>[];
      expect(Array.isArray(output)).toBe(true);
      expect(output.length).toBe(1);
      expect(output[0].runbook).toBe('runbooks/simple.runbook.md');
      expect(output[0].status).toBe('complete');
    });

    it('includes id, runbook, and status fields in JSON output', async () => {
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('prune', workspace);

      const output = JSON.parse(result.stdout) as Record<string, unknown>[];
      expect(output[0]).toHaveProperty('id');
      expect(output[0]).toHaveProperty('runbook');
      expect(output[0]).toHaveProperty('status');
    });

    it('does not include internal _status field in JSON output', async () => {
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('prune', workspace);

      const output = JSON.parse(result.stdout) as Record<string, unknown>[];
      expect(output[0]).not.toHaveProperty('_status');
    });
  });

  describe('--dry-run combined', () => {
    it('outputs items as JSON without deleting state', async () => {
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('prune --dry-run', workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>[];
      expect(output.length).toBe(1);
      expect(output[0].runbook).toBe('runbooks/simple.runbook.md');

      // State should still exist (dry-run)
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(1);
    });

    it('outputs empty array when nothing matches', async () => {
      const result = await runCliInProcess('prune --dry-run', workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });
  });

  describe('text output format', () => {
    it('displays column headers in text output', async () => {
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('prune --text', workspace);

      expect(result.stdout).toContain('ID');
      expect(result.stdout).toContain('STATUS');
      expect(result.stdout).toContain('RUNBOOK');
    });

    it('displays title in brackets when runbook has a title', async () => {
      const runbookContent = `# My Titled Runbook

## 1. Only step
- PASS COMPLETE

\`\`\`bash
rd echo --result pass
\`\`\`
`;
      await writeFile(join(workspace.cwd, 'titled.runbook.md'), runbookContent);
      await runCliInProcess('run titled.runbook.md --text', workspace);

      const result = await runCliInProcess('prune --text', workspace);

      expect(result.stdout).toContain('[My Titled Runbook]');
    });
  });

  describe('tombstone claim GC', () => {
    /**
     * Drive a delegated child to completion, leaving a retained terminal claim
     * tombstone and a completed child run on disk.
     *
     * @returns The claim id of the completed child.
     */
    async function completeDelegatedChild(): Promise<string> {
      const childRunbook = [
        '# Child',
        '',
        '## 1. Work',
        '',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        'Do child work.',
        '',
      ].join('\n');
      const parentRunbook = [
        '# Parent',
        '',
        '## 1. Fan out',
        '',
        '- DELEGATE',
        '- PASS ALL CONTINUE',
        '- FAIL ANY STOP',
        '',
        '### 1.1 First child',
        '',
        '- child.runbook.md',
        '',
        '## 2. Done',
        '',
        '- PASS COMPLETE',
        '',
        'Finished.',
        '',
      ].join('\n');

      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentRunbook);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childRunbook);

      const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      const token = state?.substepStates?.find((substep) => substep.id === '1')?.delegation?.token;
      if (!token) throw new Error('expected auto-issued frontier token for 1.1');

      const claimResult = await runCliInProcess(`claim ${token}`, workspace);
      expect(claimResult.exitCode).toBe(0);
      const claimOutput = findActionOutput(claimResult.stdout);
      const claimId = claimOutput?.claim_id;
      if (typeof claimId !== 'string') throw new Error('expected claim_id from claim output');

      const finish = await runCliInProcess(['pass', '--claim-id', claimId], workspace);
      expect(finish.exitCode).toBe(0);
      const runId = claimOutput?.run_id;
      if (typeof runId !== 'string') throw new Error('expected run_id from claim output');
      const child = await readRunbookState(workspace, runId);
      expect(child?.lifecycle).toBe('completed');

      return claimId;
    }

    it('rd prune --completed removes tombstone claims for pruned children', async () => {
      const claimId = await completeDelegatedChild();

      // Sanity: the terminal tombstone claim is retained before prune.
      const before = await readSession(workspace);
      expect(before.claims[claimId]).toBeDefined();

      const result = await runCliInProcess(['prune', '--completed'], workspace);
      expect(result.exitCode).toBe(0);

      // The tombstone claim is dropped alongside its pruned child run.
      const after = await readSession(workspace);
      expect(after.claims[claimId]).toBeUndefined();

      // A follow-up claim-targeted command no longer finds the tombstone.
      const status = await runCliInProcess(['status', '--claim-id', claimId], workspace);
      expect(status.exitCode).toBe(1);
      const json = parseConcatenatedJson(status.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'error', code: 'CLAIMED_RUNBOOK_UNAVAILABLE' });
    }, 30_000);
  });

  describe('defaultStack hygiene (#534)', () => {
    // Parsed from real source so the fixture satisfies Runbook without casts.
    const HYGIENE_RUNBOOK: Runbook = parseRunbookDocument(`# Hygiene Test Runbook

A test

## 1. Initial step
- PASS CONTINUE
- FAIL STOP

Do the thing.
`).runbook;

    /**
     * Persist a state file with the given lifecycle WITHOUT driving terminal
     * flows. RunbookStateManager.create always persists lifecycle 'running'
     * and takes no lifecycle option, so the helper is create-then-update, not
     * a one-liner over create() (both calls append attribution records, which
     * these tests tolerate). The id is deliberately NOT released from the
     * session — this constructs the #534 leak precondition directly (the
     * #536-style writer persists lifecycle with no session release; driving
     * runs to completion via the CLI would release the stack en route and the
     * tests would pass vacuously).
     */
    async function createStateFile(
      manager: RunbookStateManager,
      { lifecycle }: { lifecycle: 'running' | 'completed' | 'stopped' },
    ): Promise<RunId> {
      const state = await manager.create(
        { source: 'project', path: 'hygiene-test.runbook.md' },
        HYGIENE_RUNBOOK,
        { runbookPath: 'hygiene-test.runbook.md' },
      );
      if (lifecycle !== 'running') {
        await manager.update(state.id, { lifecycle });
      }
      return state.id;
    }

    it('pops pruned terminal ids from the defaultStack so the running run resolves', async () => {
      // The exact 3-entry stack from issue #534's repro: running bottom,
      // completed + stopped above, all still stacked.
      const manager = new RunbookStateManager(workspace.cwd);
      const sessionService = new SessionService(manager);
      const runningId = await createStateFile(manager, { lifecycle: 'running' });
      const completedId = await createStateFile(manager, { lifecycle: 'completed' });
      const stoppedId = await createStateFile(manager, { lifecycle: 'stopped' });
      await sessionService.pushRunbook(runningId);
      await sessionService.pushRunbook(completedId);
      await sessionService.pushRunbook(stoppedId);

      const result = await runCliInProcess('prune', workspace);
      expect(result.exitCode).toBe(0);

      const session = await readSession(workspace);
      expect(session.defaultStack).toEqual([runningId]);
      expect(await readRunbookState(workspace, completedId)).toBeNull();
      expect(await readRunbookState(workspace, stoppedId)).toBeNull();
      const active = await new SessionService(new RunbookStateManager(workspace.cwd)).getActive();
      expect(active?.id).toBe(runningId);
    });

    it('prune --all empties the defaultStack and clears a pruned stash reference', async () => {
      const manager = new RunbookStateManager(workspace.cwd);
      const sessionService = new SessionService(manager);
      const stackedId = await createStateFile(manager, { lifecycle: 'completed' });
      const stashedId = await createStateFile(manager, { lifecycle: 'stopped' });
      await sessionService.pushRunbook(stackedId);
      await sessionService.pushRunbook(stashedId);
      await expect(sessionService.stash()).resolves.toBe(stashedId);

      const result = await runCliInProcess('prune --all', workspace);
      expect(result.exitCode).toBe(0);

      const session = await readSession(workspace);
      expect(session.defaultStack).toEqual([]);
      expect(session.stashed).toBeNull();
    });

    it('removes claim records whose childRunId was pruned', async () => {
      const manager = new RunbookStateManager(workspace.cwd);
      const sessionService = new SessionService(manager);
      const parentId = await createStateFile(manager, { lifecycle: 'running' });
      const childId = await createStateFile(manager, { lifecycle: 'completed' });
      await sessionService.pushRunbook(parentId);
      await sessionService.pushRunbook(childId);

      // Write the claim record directly — the leak precondition is a claim
      // whose child went terminal without the terminal flow's release.
      const claimId = 'rdclm_AAAAAAAAAAAAAAAAAAAAAA';
      const sessionPath = join(workspace.cwd, '.rundown', 'session.json');
      const raw = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>;
      await writeFile(
        sessionPath,
        JSON.stringify({
          ...raw,
          claims: {
            [claimId]: {
              kind: 'claim-record',
              claimId,
              childRunId: childId,
              tokenHash: `sha256:${'a'.repeat(64)}`,
              parentRunId: parentId,
              parentStepId: '1.1',
              parentStep: 'Child',
              parentFrameKey: '1|',
              parentEntry: 1,
              claimedAt: '2026-07-03T00:00:00.000Z',
              updatedAt: '2026-07-03T00:00:00.000Z',
            },
          },
        }),
        'utf8',
      );

      const result = await runCliInProcess('prune', workspace);
      expect(result.exitCode).toBe(0);

      const session = await readSession(workspace);
      expect(session.claims[claimId]).toBeUndefined();
      expect(session.defaultStack).toEqual([parentId]);
    });

    it('releases a stacked invalid state file id when pruned via --all', async () => {
      const manager = new RunbookStateManager(workspace.cwd);
      const sessionService = new SessionService(manager);
      const invalidId = await createStateFile(manager, { lifecycle: 'running' });
      await sessionService.pushRunbook(invalidId);
      // Corrupt to an invalid-but-parseable state file: wrong schemaVersion,
      // so list() skips it and it flows through the invalid-file prune path.
      const stateFile = join(workspace.statePath(), `${invalidId}.json`);
      const rawState = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>;
      await writeFile(stateFile, JSON.stringify({ ...rawState, schemaVersion: 99 }), 'utf8');

      const result = await runCliInProcess('prune --all', workspace);
      expect(result.exitCode).toBe(0);

      const session = await readSession(workspace);
      expect(session.defaultStack).not.toContain(invalidId);
      expect(await readRunbookState(workspace, invalidId)).toBeNull();
    });

    describe('interrupted prune convergence (#534 review)', () => {
      it('converges when a prior prune released ids but crashed before deleting state files', async () => {
        // Simulate: release succeeded, delete failed. Terminal state files
        // exist but their ids are already off the stack (as after a crash
        // mid-prune).
        const manager = new RunbookStateManager(workspace.cwd);
        const sessionService = new SessionService(manager);
        const runningId = await createStateFile(manager, { lifecycle: 'running' });
        const completedId = await createStateFile(manager, { lifecycle: 'completed' });
        await sessionService.pushRunbook(runningId); // only the live run is stacked

        const rerun = await runCliInProcess('prune', workspace);
        expect(rerun.exitCode).toBe(0);

        // The re-run finishes the job: terminal state file deleted, session intact.
        const session = await readSession(workspace);
        expect(session.defaultStack).toEqual([runningId]);
        expect(await readRunbookState(workspace, completedId)).toBeNull();
      });

      it('tolerates the inverse interruption (deleted but still stacked) without worsening it', async () => {
        // Simulate: delete succeeded, release failed — the #534 leak shape.
        // The new release-first ordering can no longer produce this from
        // prune, but a pre-fix binary or crash elsewhere can. Prune must exit
        // 0 and leave the session as-is; recovery for the dangling id is the
        // #518 cleanup path (bare rd stop / rd complete), not prune.
        const manager = new RunbookStateManager(workspace.cwd);
        const sessionService = new SessionService(manager);
        const danglingId = await createStateFile(manager, { lifecycle: 'stopped' });
        await sessionService.pushRunbook(danglingId);
        await unlink(join(workspace.statePath(), `${danglingId}.json`));

        const result = await runCliInProcess('prune', workspace);

        expect(result.exitCode).toBe(0);
        const session = await readSession(workspace);
        expect(session.defaultStack).toEqual([danglingId]); // untouched, not worsened
      });
    });
  });
});
