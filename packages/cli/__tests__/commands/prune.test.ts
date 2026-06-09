import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
});
