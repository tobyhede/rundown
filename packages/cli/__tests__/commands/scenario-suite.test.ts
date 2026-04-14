import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('scenario-suite command', () => {
  let workspace: TestWorkspace;

  const RUNBOOK_CONTENT = `---
name: suite-test
---

# Suite Test

## 1. First Step

- PASS CONTINUE
- FAIL STOP

\`\`\`bash
rd echo --result pass
\`\`\`

## 2. Second Step

- PASS COMPLETE
- FAIL STOP

\`\`\`bash
rd echo --result pass
\`\`\`
`;

  const SUITE_YAML = `version: 1
name: Test Suite
description: Suite for testing
tags:
  - test
cases:
  happy-path:
    description: All steps pass
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
    tags:
      - happy
  stop-path:
    description: First step fails and stops
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd fail
    result: STOP
  wrong-expectation:
    description: Expects COMPLETE but stops
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd fail
    result: COMPLETE
`;

  const EXPECT_SUITE_YAML = `version: 1
name: Expect Suite
cases:
  with-expect:
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd pass
      - rd pass
    expect:
      result: COMPLETE
`;

  beforeEach(async () => {
    workspace = await createTestWorkspace();

    // Write runbook to workspace root (suite resolves file: paths relative to suite dir)
    await writeFile(join(workspace.cwd, 'suite-test.runbook.md'), RUNBOOK_CONTENT);

    // Write suite files in workspace root
    await writeFile(join(workspace.cwd, 'test.scenario-suite.yaml'), SUITE_YAML);
    await writeFile(join(workspace.cwd, 'expect.scenario-suite.yaml'), EXPECT_SUITE_YAML);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('ls subcommand', () => {
    it('lists cases with table headers', async () => {
      const result = await runCliInProcess('scenario-suite ls test.scenario-suite.yaml --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('NAME');
      expect(result.stdout).toContain('FILE');
      expect(result.stdout).toContain('EXPECTED');
      expect(result.stdout).toContain('DESCRIPTION');
      expect(result.stdout).toContain('TAGS');
      expect(result.stdout).toContain('happy-path');
      expect(result.stdout).toContain('stop-path');
      expect(result.stdout).toContain('wrong-expectation');
      expect(result.stdout).toContain('COMPLETE');
      expect(result.stdout).toContain('STOP');
      expect(result.stdout).toMatch(/NAME\s{2,}FILE\s{2,}EXPECTED/);
    });

    it('outputs JSON with flag', async () => {
      const result = await runCliInProcess('scenario-suite ls test.scenario-suite.yaml',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(3);
      expect(parsed.map((item: { name: string }) => item.name)).toEqual(
        expect.arrayContaining(['happy-path', 'stop-path', 'wrong-expectation']),
      );
    });

    it('shows VALIDATION_ERROR for invalid suite file', async () => {
      await writeFile(join(workspace.cwd, 'bad.scenario-suite.yaml'), 'version: 99\nname: Bad\n');

      const result = await runCliInProcess('scenario-suite ls bad.scenario-suite.yaml --text', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('VALIDATION_ERROR');
    });

    it('shows error for missing file', async () => {
      const result = await runCliInProcess('scenario-suite ls nonexistent.yaml --text', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('shows expect.result when result is omitted', async () => {
      const result = await runCliInProcess('scenario-suite ls expect.scenario-suite.yaml --text',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('with-expect');
      expect(result.stdout).toContain('COMPLETE');
    });
  });

  describe('show subcommand', () => {
    it('shows case details', async () => {
      const result = await runCliInProcess('scenario-suite show test.scenario-suite.yaml happy-path',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('happy-path');
      expect(result.stdout).toContain('COMPLETE');
      expect(result.stdout).toContain('suite-test.runbook.md');
    });

    it('outputs JSON with flag', async () => {
      const result = await runCliInProcess('scenario-suite show test.scenario-suite.yaml happy-path',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.name).toBe('happy-path');
      expect(parsed.expected).toBe('COMPLETE');
      expect(parsed.commands).toHaveLength(3);
    });

    it('includes expect block when present', async () => {
      const result = await runCliInProcess('scenario-suite show expect.scenario-suite.yaml with-expect',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.expect).toBeDefined();
      expect(parsed.expect.result).toBe('COMPLETE');
    });

    it('shows SCENARIO_NOT_FOUND for non-existent case', async () => {
      const result = await runCliInProcess('scenario-suite show test.scenario-suite.yaml nonexistent',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      // Error is emitted as JSON to stdout (JSON is the default output mode)
      expect(result.stdout + result.stderr).toContain('SCENARIO_NOT_FOUND');
    });
  });

  describe('run subcommand', () => {
    it('runs single passing case successfully', async () => {
      const result = await runCliInProcess('scenario-suite run test.scenario-suite.yaml happy-path',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(true);
      expect(parsed.expected).toBe('COMPLETE');
      expect(parsed.actual).toBe('COMPLETE');
    }, 30000);

    it('runs case where actual differs from expected with exit code 1', async () => {
      const result = await runCliInProcess('scenario-suite run test.scenario-suite.yaml wrong-expectation',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(false);
      expect(parsed.expected).toBe('COMPLETE');
      expect(parsed.actual).toBe('STOP');
    }, 30000);

    it('outputs JSON for single case with', async () => {
      const result = await runCliInProcess('scenario-suite run test.scenario-suite.yaml happy-path',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const jsonLines = result.stdout.trim().split(/\n(?=\{)/);
      const parsed = JSON.parse(jsonLines[0]);
      expect(parsed.result).toBe(true);
      expect(parsed.scenario).toBe('happy-path');
      expect(parsed.expected).toBe('COMPLETE');
      expect(parsed.actual).toBe('COMPLETE');
    }, 30000);

    it('runs all cases with --all and verifies results', async () => {
      const result = await runCliInProcess('scenario-suite run test.scenario-suite.yaml --all',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.passed).toBe(2);
      expect(parsed.failed).toBe(1);
      const failedCase = parsed.cases.find((c: { result: boolean }) => !c.result);
      expect(failedCase.scenario).toBe('wrong-expectation');
      expect(failedCase.expected).toBe('COMPLETE');
      expect(failedCase.actual).toBe('STOP');
    }, 60000);

    it('outputs summary JSON with --all', async () => {
      const result = await runCliInProcess('scenario-suite run test.scenario-suite.yaml --all',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const jsonLines = result.stdout.trim().split(/\n(?=\{)/);
      const parsed = JSON.parse(jsonLines[0]);
      expect(parsed.total).toBe(3);
      expect(parsed.passed).toBe(2);
      expect(parsed.failed).toBe(1);
      expect(parsed.cases).toHaveLength(3);
    }, 60000);

    it('errors without case name or --all', async () => {
      const result = await runCliInProcess('scenario-suite run test.scenario-suite.yaml --text',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('VALIDATION_ERROR');
    });

    it('errors for non-existent case', async () => {
      const result = await runCliInProcess('scenario-suite run test.scenario-suite.yaml nonexistent -q --text',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('SCENARIO_NOT_FOUND');
    });

    it('reports error when child runbook referenced in commands is not found', async () => {
      const suiteWithChild = `version: 1
name: Child Test
cases:
  needs-child:
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd delegate nonexistent-child.runbook.md --step 1
    result: COMPLETE
`;
      await writeFile(join(workspace.cwd, 'child-ref.scenario-suite.yaml'), suiteWithChild);

      const result = await runCliInProcess('scenario-suite run child-ref.scenario-suite.yaml needs-child -q --text',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('CHILD_RUNBOOK_NOT_FOUND');
    }, 30000);

    it('reports child runbook error with ERROR prefix in --all mode', async () => {
      const suiteWithChild = `version: 1
name: Child Test All
cases:
  needs-child:
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd delegate nonexistent-child.runbook.md --step 1
    result: COMPLETE
`;
      await writeFile(join(workspace.cwd, 'child-all.scenario-suite.yaml'), suiteWithChild);

      const result = await runCliInProcess('scenario-suite run child-all.scenario-suite.yaml --all',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.failed).toBe(1);
      const failedCase = parsed.cases[0];
      expect(failedCase.result).toBe(false);
      expect(failedCase.actual).toContain('ERROR:');
      expect(failedCase.actual).toContain('CHILD_RUNBOOK_NOT_FOUND');
    }, 30000);

    it('reports child runbook error with ERROR prefix in single-case mode', async () => {
      const suiteWithChild = `version: 1
name: Child Test Single
cases:
  needs-child:
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd delegate nonexistent-child.runbook.md --step 1
    result: COMPLETE
`;
      await writeFile(join(workspace.cwd, 'child-single.scenario-suite.yaml'), suiteWithChild);

      const result = await runCliInProcess('scenario-suite run child-single.scenario-suite.yaml needs-child',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(false);
      expect(parsed.actual).toContain('ERROR:');
      expect(parsed.actual).toContain('CHILD_RUNBOOK_NOT_FOUND');
    }, 30000);

    it('errors for invalid suite file', async () => {
      await writeFile(join(workspace.cwd, 'bad.scenario-suite.yaml'), 'not: valid\n');

      const result = await runCliInProcess('scenario-suite run bad.scenario-suite.yaml --all -q --text',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('VALIDATION_ERROR');
    });
  });
});
