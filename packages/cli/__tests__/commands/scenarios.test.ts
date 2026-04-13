import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

describe('scenario command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();

    // Create a runbook with scenarios
    const runbook = `---
name: test-runbook
scenarios:
  success:
    description: Happy path
    commands:
      - rd run --prompted test-runbook.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  failure:
    commands:
      - rd run --prompted test-runbook.runbook.md
      - rd fail
    result: STOP
---

# Test Runbook

## 1. First Step

- PASS CONTINUE
- FAIL STOP

## 2. Second Step

- PASS COMPLETE
- FAIL STOP
`;

    const runbooksDirPath = workspace.runbooksDir();
    await mkdir(runbooksDirPath, { recursive: true });
    await writeFile(join(runbooksDirPath, 'test-runbook.runbook.md'), runbook);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('list subcommand', () => {
    it('lists available scenarios', async () => {
      const result = await runCliInProcess('scenario ls test-runbook.runbook.md', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('NAME');
      expect(result.stdout).toContain('EXPECTED');
      expect(result.stdout).toContain('success');
      expect(result.stdout).toContain('COMPLETE');
      expect(result.stdout).toContain('failure');
      expect(result.stdout).toContain('STOP');
      expect(result.stdout).toContain('Happy path');
    });

    it('shows error for file without scenarios', async () => {
      const noScenarios = `---
name: no-scenarios
---

# No Scenarios

## 1. Step

- PASS COMPLETE
`;
      await writeFile(join(workspace.runbooksDir(), 'no-scenarios.runbook.md'), noScenarios);

      const result = await runCliInProcess('scenario ls no-scenarios.runbook.md', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No scenarios');
    });
  });

  describe('show subcommand', () => {
    it('shows details for a specific scenario', async () => {
      const result = await runCliInProcess(
        'scenario show test-runbook.runbook.md success',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Name:        success');
      expect(result.stdout).toContain('Description: Happy path');
      expect(result.stdout).toContain('Expected:    COMPLETE');
      expect(result.stdout).toContain('Commands:');
      expect(result.stdout).toContain('  $ rd run --prompted');
    });

    it('shows error for non-existent scenario', async () => {
      const result = await runCliInProcess(
        'scenario show test-runbook.runbook.md nonexistent',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
      expect(result.stderr).toContain('SCENARIO_NOT_FOUND');
    });
  });
});
