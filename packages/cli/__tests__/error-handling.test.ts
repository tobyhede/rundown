import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listPersistedRunIds, writeRawRunJson } from '@rundown-org/core/testing/session-fixtures';
import { createTestWorkspace, runCli, type TestWorkspace } from './helpers/test-utils.js';

describe('error handling', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('RunbookSyntaxError', () => {
    it('displays parsing errors clearly', async () => {
      // Create invalid runbook — no ## step headers
      const invalidRunbook = `
# Not a valid runbook
This doesn't have proper ## headers
`;
      await writeFile(join(workspace.cwd, 'invalid.md'), invalidRunbook);

      const result = runCli('run invalid.md --text', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/(no steps|at least one step)/i);
    });

    it('handles empty runbook file', async () => {
      await writeFile(join(workspace.cwd, 'empty.md'), '');

      const result = runCli('run empty.md --text', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/(no steps|at least one step)/i);
    });
  });

  describe('file not found', () => {
    it('handles missing runbook file', async () => {
      const result = runCli('run nonexistent.md --text', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('invalid state', () => {
    it('handles corrupted state file', async () => {
      // Start a runbook
      runCli('run --prompted runbooks/simple.runbook.md --text', workspace);

      // Corrupt the persisted state
      const runIds = await listPersistedRunIds(workspace.cwd);
      const runId = runIds[0];
      if (runId) {
        await writeRawRunJson(workspace.cwd, runId, 'not valid json');
      }

      // Try to use the runbook
      const result = runCli('pass --text', workspace);

      // Corrupted state files now fail fast with an error
      expect(result.exitCode).toBe(1);
    });
  });

  describe('invalid arguments', () => {
    it('shows help on unknown command', async () => {
      const result = runCli('unknowncommand --text', workspace);

      expect(result.stderr.length).toBeGreaterThan(0);
    });
  });
});
