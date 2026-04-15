import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
  readSession,
  listRunbookStates,
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

  describe('default behavior (--completed)', () => {
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
});
