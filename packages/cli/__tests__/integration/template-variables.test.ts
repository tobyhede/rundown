import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import {
  createTestWorkspace,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('Template Variables Integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('variable precedence', () => {
    const runbookContent = `# Test

## 1. Echo
- PASS: COMPLETE

\`\`\`bash
rd echo {{message}}
\`\`\`
`;

    beforeEach(async () => {
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);
    });

    it('--var overrides --var-file', async () => {
      await writeFile(join(workspace.cwd, 'vars.yaml'), 'message: from-file');

      const result = runCli(
        'run test.runbook.md --var-file vars.yaml --var message=from-flag --json',
        workspace
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('from-flag');
      expect(result.stdout).not.toContain('from-file');
    });

    it('--var-file overrides auto-discovered config', async () => {
      // Create auto-discovered config
      await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
      await writeFile(
        join(workspace.cwd, '.rundown', 'config.yaml'),
        'message: auto-discovered'
      );

      // Create explicit var file
      await writeFile(join(workspace.cwd, 'custom.yaml'), 'message: explicit');

      const result = runCli(
        'run test.runbook.md --var-file custom.yaml --json',
        workspace
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('explicit');
      expect(result.stdout).not.toContain('auto-discovered');
    });

    it('uses auto-discovered config when no flags provided', async () => {
      await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
      await writeFile(
        join(workspace.cwd, '.rundown', 'config.yaml'),
        'message: auto-discovered'
      );

      const result = runCli('run test.runbook.md --json', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('auto-discovered');
    });
  });

  describe('missing variables', () => {
    it('preserves undefined variables as literal text', async () => {
      const runbookContent = `# Test

## 1. Echo
- PASS: COMPLETE

\`\`\`bash
rd echo "{{undefined_var}}"
\`\`\`
`;
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

      const result = runCli('run test.runbook.md --json', workspace);

      expect(result.exitCode).toBe(0);
      // The literal {{undefined_var}} should be preserved
      expect(result.stdout).toContain('undefined_var');
    });
  });

  describe('dynamic step syntax preservation', () => {
    it('does not affect {N} dynamic step syntax in status', async () => {
      // Dynamic runbooks use {N} syntax which must be preserved (not expanded by Handlebars)
      const runbookContent = `# Dynamic Test

## {N}. Dynamic Step
- PASS: GOTO NEXT

\`\`\`bash
rd echo "Instance {{command}}"
\`\`\`
`;
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

      // Run in prompted mode to keep it paused
      runCli('run test.runbook.md --var command=test --prompted', workspace);

      // Status should show the dynamic step syntax was preserved
      const result = runCli('status --json', workspace);

      expect(result.exitCode).toBe(0);
      // Should be dynamic runbook (unbounded total)
      const output = JSON.parse(result.stdout);
      expect(output.position.total).toBe('{N}');
    });
  });

  describe('resume with frozen runbookSrc', () => {
    it('should use stored runbookSrc in pass command', async () => {
      const runbookContent = `# Test Runbook

## 1. First Step
- PASS: CONTINUE

\`\`\`bash
rd echo {{message}}
\`\`\`

## 2. Second Step
- PASS: COMPLETE

\`\`\`bash
rd echo done
\`\`\`
`;
      const runbookPath = join(workspace.cwd, 'test.runbook.md');
      await writeFile(runbookPath, runbookContent);

      // Run with variable to store expanded content
      runCli('run test.runbook.md --var message=original --prompted', workspace);

      // Delete source file to confirm we're using runbookSrc
      await rm(runbookPath);

      // Pass should work with stored runbookSrc
      const result = runCli('pass --json', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('should use stored runbookSrc in fail command', async () => {
      const runbookContent = `# Test Runbook

## 1. First Step
- PASS: CONTINUE
- FAIL: RETRY 1

\`\`\`bash
rd echo {{message}}
\`\`\`

## 2. Second Step
- PASS: COMPLETE

\`\`\`bash
rd echo done
\`\`\`
`;
      const runbookPath = join(workspace.cwd, 'test.runbook.md');
      await writeFile(runbookPath, runbookContent);

      runCli('run test.runbook.md --var message=original --prompted', workspace);
      await rm(runbookPath);

      const result = runCli('fail --json', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('should use stored runbookSrc in goto command', async () => {
      const runbookContent = `# Test Runbook

## 1. First Step
- PASS: CONTINUE

\`\`\`bash
rd echo {{message}}
\`\`\`

## 2. Second Step
- PASS: COMPLETE

\`\`\`bash
rd echo done
\`\`\`
`;
      const runbookPath = join(workspace.cwd, 'test.runbook.md');
      await writeFile(runbookPath, runbookContent);

      runCli('run test.runbook.md --var message=original --prompted', workspace);
      await rm(runbookPath);

      const result = runCli('goto 2 --json', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('should use stored runbookSrc in complete command', async () => {
      const runbookContent = `# Test Runbook

## 1. First Step
- PASS: CONTINUE

\`\`\`bash
rd echo {{message}}
\`\`\`

## 2. Second Step
- PASS: COMPLETE

\`\`\`bash
rd echo done
\`\`\`
`;
      const runbookPath = join(workspace.cwd, 'test.runbook.md');
      await writeFile(runbookPath, runbookContent);

      runCli('run test.runbook.md --var message=original --prompted', workspace);
      await rm(runbookPath);

      const result = runCli('complete --json', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('should use stored runbookSrc in status command', async () => {
      const runbookContent = `# Test Runbook

## 1. First Step
- PASS: CONTINUE

\`\`\`bash
rd echo {{message}}
\`\`\`

## 2. Second Step
- PASS: COMPLETE

\`\`\`bash
rd echo done
\`\`\`
`;
      const runbookPath = join(workspace.cwd, 'test.runbook.md');
      await writeFile(runbookPath, runbookContent);

      runCli('run test.runbook.md --var message=original --prompted', workspace);
      await rm(runbookPath);

      const result = runCli('status --json', workspace);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.position.total).toBe(2);
    });

    it('should use stored runbookSrc in pop command', async () => {
      const runbookContent = `# Test Runbook

## 1. First Step
- PASS: CONTINUE

\`\`\`bash
rd echo {{message}}
\`\`\`

## 2. Second Step
- PASS: COMPLETE

\`\`\`bash
rd echo done
\`\`\`
`;
      const runbookPath = join(workspace.cwd, 'test.runbook.md');
      await writeFile(runbookPath, runbookContent);

      // Run with variable to store expanded content
      runCli('run test.runbook.md --var message=original --prompted', workspace);

      // Stash the runbook
      runCli('stash', workspace);

      // Delete source file to confirm we're using runbookSrc
      await rm(runbookPath);

      // Pop should work with stored runbookSrc
      const result = runCli('pop --json', workspace);
      expect(result.exitCode).toBe(0);
    });
  });
});
