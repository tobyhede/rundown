import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/scenarios.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess). See collect.test.ts.
import { registerScenariosCommand } from '../../src/commands/scenarios.js';

describe('scenario command wiring', () => {
  it('registers the scenario command with its subcommands and descriptions', () => {
    const program = new Command();
    registerScenariosCommand(program);

    const scenario = program.commands.find((c) => c.name() === 'scenario');
    expect(scenario).toBeDefined();
    expect(scenario?.description()).toBe('List, show, or run scenarios from a runbook');

    const byName = new Map(scenario!.commands.map((c) => [c.name(), c]));
    expect([...byName.keys()].sort()).toEqual(['ls', 'run', 'show']);
    expect(byName.get('ls')?.description()).toBe('List all scenarios in a runbook');
    expect(byName.get('show')?.description()).toBe('Show details for a specific scenario');
    expect(byName.get('run')?.description()).toBe('Execute a scenario and verify the result');

    const runQuiet = byName.get('run')?.options.find((o) => o.long === '--quiet');
    expect(runQuiet?.description).toBe('Suppress command output');
    expect(runQuiet?.short).toBe('-q');
  });
});

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
      const result = await runCliInProcess('scenario ls test-runbook.runbook.md --text', workspace);

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

      const result = await runCliInProcess('scenario ls no-scenarios.runbook.md --text', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No scenarios');
    });
  });

  describe('show subcommand', () => {
    it('shows details for a specific scenario', async () => {
      const result = await runCliInProcess(
        'scenario show test-runbook.runbook.md success --text',
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
        'scenario show test-runbook.runbook.md nonexistent --text',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
      expect(result.stderr).toContain('SCENARIO_NOT_FOUND');
    });
  });

  describe('run subcommand timings', () => {
    it('emits command timings to stderr when enabled', async () => {
      const result = await runCliInProcess(
        'scenario run test-runbook.runbook.md success',
        workspace,
        {
          env: { RUNDOWN_SCENARIO_COMMAND_TIMINGS: '1' },
        },
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(true);
      expect(result.stderr).toContain('SCENARIO_TIMING');
      expect(result.stderr).toContain('"scope":"command"');
      expect(result.stderr).toContain('"command":"rd run --prompted test-runbook.runbook.md"');
    }, 30000);

    it('runs scenario commands in-process when enabled', async () => {
      const result = await runCliInProcess(
        'scenario run test-runbook.runbook.md success',
        workspace,
        {
          env: {
            RUNDOWN_SCENARIO_IN_PROCESS: '1',
            RUNDOWN_SCENARIO_COMMAND_TIMINGS: '1',
          },
        },
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(true);
      const timingLines = result.stderr
        .split('\n')
        .filter((line) => line.startsWith('SCENARIO_TIMING '))
        .map(
          (line) =>
            JSON.parse(line.slice('SCENARIO_TIMING '.length)) as {
              kind: string;
              exitCode: number;
            },
        );
      expect(timingLines).toHaveLength(3);
      expect(timingLines).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'rd', exitCode: 0 })]),
      );
    }, 30000);
  });
});
