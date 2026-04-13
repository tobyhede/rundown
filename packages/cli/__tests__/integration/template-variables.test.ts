import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RUNDOWN_DIR } from '@rundown-org/core';
import {
  createTestWorkspace,
  runCli,
  createRunbook,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * Parse JSONL output from `run --json`, filtering out non-JSON lines (command output).
 */
function parseJsonlEvents(stdout: string): Record<string, unknown>[] {
  return stdout
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('Template Variables Integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('variable precedence', () => {
    const runbookContent = createRunbook({
      steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo {{message}}' }],
    });

    beforeEach(async () => {
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);
    });

    it('--var overrides --var-file', async () => {
      await writeFile(join(workspace.cwd, 'vars.yaml'), 'message: from-file');

      const result = runCli(
        'run test.runbook.md --var-file vars.yaml --var message=from-flag --json',
        workspace,
      );

      expect(result.exitCode).toBe(0);

      // Parse JSON events and verify the command used the correct variable value
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');

      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo from-flag');
      expect(commandStartedEvent.command).not.toContain('from-file');
    });

    it('--var with empty value overrides --var-file', async () => {
      await writeFile(join(workspace.cwd, 'vars.yaml'), 'message: from-file');
      const result = runCli(
        'run test.runbook.md --var-file vars.yaml --var message= --json',
        workspace,
      );
      expect(result.exitCode).toBe(0);

      // Parse JSON events and verify empty value was used
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');

      expect(commandStartedEvent).toBeDefined();
      // Empty value is shell-escaped to '' (single-quoted empty string)
      expect(commandStartedEvent.command).toBe("rd echo ''");
      expect(commandStartedEvent.command).not.toContain('from-file');
    });

    it('--var-file overrides auto-discovered config', async () => {
      // Create auto-discovered config
      await mkdir(join(workspace.cwd, RUNDOWN_DIR), { recursive: true });
      await writeFile(join(workspace.cwd, RUNDOWN_DIR, 'config.yaml'), 'message: auto-discovered');

      // Create explicit var file
      await writeFile(join(workspace.cwd, 'custom.yaml'), 'message: explicit');

      const result = runCli('run test.runbook.md --var-file custom.yaml --json', workspace);

      expect(result.exitCode).toBe(0);

      // Parse JSON events and verify explicit var file value was used
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');

      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo explicit');
      expect(commandStartedEvent.command).not.toContain('auto-discovered');
    });

    it('uses auto-discovered config when no flags provided', async () => {
      await mkdir(join(workspace.cwd, RUNDOWN_DIR), { recursive: true });
      await writeFile(join(workspace.cwd, RUNDOWN_DIR, 'config.yaml'), 'message: auto-discovered');

      const result = runCli('run test.runbook.md --json', workspace);

      expect(result.exitCode).toBe(0);

      // Parse JSON events and verify auto-discovered value was used
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');

      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo auto-discovered');
    });
  });

  describe('frontmatter vars precedence', () => {
    it('uses frontmatter vars when no other source provides value', async () => {
      const runbookContent = createRunbook({
        name: 'test-runbook',
        vars: { message: 'from-frontmatter' },
        steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo {{message}}' }],
      });
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

      const result = runCli('run test.runbook.md --json', workspace);

      expect(result.exitCode).toBe(0);

      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');

      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo from-frontmatter');
    });

    it('--var overrides frontmatter vars', async () => {
      const runbookContent = createRunbook({
        name: 'test-runbook',
        vars: { message: 'from-frontmatter' },
        steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo {{message}}' }],
      });
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

      const result = runCli('run test.runbook.md --var message=from-flag --json', workspace);

      expect(result.exitCode).toBe(0);

      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');

      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo from-flag');
    });

    it('--var-file overrides frontmatter vars', async () => {
      const runbookContent = createRunbook({
        name: 'test-runbook',
        vars: { message: 'from-frontmatter' },
        steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo {{message}}' }],
      });
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);
      await writeFile(join(workspace.cwd, 'vars.yaml'), 'message: from-file');

      const result = runCli('run test.runbook.md --var-file vars.yaml --json', workspace);

      expect(result.exitCode).toBe(0);

      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');

      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo from-file');
    });

    it('config.yaml overrides frontmatter vars', async () => {
      const runbookContent = createRunbook({
        name: 'test-runbook',
        vars: { message: 'from-frontmatter' },
        steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo {{message}}' }],
      });
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

      // Create auto-discovered config
      await mkdir(join(workspace.cwd, RUNDOWN_DIR), { recursive: true });
      await writeFile(join(workspace.cwd, RUNDOWN_DIR, 'config.yaml'), 'message: from-config');

      const result = runCli('run test.runbook.md --json', workspace);

      expect(result.exitCode).toBe(0);

      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');

      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo from-config');
    });

    it('frontmatter vars work with multiple variables', async () => {
      const runbookContent = createRunbook({
        name: 'test-runbook',
        vars: { greeting: 'Hello', name: 'World', count: 42 },
        steps: [
          { title: 'Echo', pass: 'COMPLETE', command: 'rd echo "{{greeting}} {{name}} {{count}}"' },
        ],
      });
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

      const result = runCli('run test.runbook.md --json', workspace);

      expect(result.exitCode).toBe(0);

      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');

      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo "Hello World 42"');
    });

    it('--var partially overrides frontmatter vars (other vars use defaults)', async () => {
      const runbookContent = createRunbook({
        name: 'test-runbook',
        vars: { greeting: 'Hello', count: 42 },
        steps: [
          {
            title: 'Echo',
            pass: 'COMPLETE',
            command: 'rd echo "{{greeting}}, count is {{count}}"',
          },
        ],
      });
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

      const result = runCli('run test.runbook.md --var greeting=Hi --json', workspace);

      expect(result.exitCode).toBe(0);

      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');

      expect(commandStartedEvent).toBeDefined();
      // greeting overridden to "Hi", count stays at frontmatter default "42"
      expect(commandStartedEvent.command).toBe('rd echo "Hi, count is 42"');
    });

    it('frontmatter vars work in child runbooks', async () => {
      // Test frontmatter vars by running child runbook directly (not via Mode 3)
      // This verifies the vars are extracted and applied during run
      const childRunbook = createRunbook({
        name: 'child-runbook',
        vars: { task_name: 'DefaultTask' },
        title: 'Child Runbook',
        steps: [{ title: 'Execute task', pass: 'COMPLETE', command: 'rd echo {{task_name}}' }],
      });

      await writeFile(join(workspace.cwd, 'child.runbook.md'), childRunbook);

      // Run child runbook directly with --json to capture JSONL events
      const result = runCli('run child.runbook.md --json', workspace);
      expect(result.exitCode).toBe(0);

      // Verify the command was expanded with the frontmatter default variable
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');
      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent!.command).toBe('rd echo DefaultTask');
    });
  });

  describe('--var-json integration', () => {
    it('scalar number renders in template', async () => {
      const runbookContent = createRunbook({
        steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo {{count}}' }],
      });
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

      const result = runCli('run test.runbook.md --var-json count=42 --json', workspace);

      expect(result.exitCode).toBe(0);
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');
      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo 42');
    });

    it('boolean value stringified in template', async () => {
      const runbookContent = createRunbook({
        steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo {{debug}}' }],
      });
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

      const result = runCli('run test.runbook.md --var-json debug=true --json', workspace);

      expect(result.exitCode).toBe(0);
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');
      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo true');
    });

    it('null value stringified in template', async () => {
      const runbookContent = createRunbook({
        steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo {{val}}' }],
      });
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

      const result = runCli('run test.runbook.md --var-json val=null --json', workspace);

      expect(result.exitCode).toBe(0);
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');
      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo null');
    });

    it('object with dotted field access in template', async () => {
      await writeFile(
        join(workspace.cwd, 'test.runbook.md'),
        `---
name: dotted-access
---
# Dotted Access

## 1. Echo config
- PASS COMPLETE

\`\`\`bash
rd echo host={{config.host}} port={{config.port}}
\`\`\`
`,
      );

      const result = runCli(
        'run test.runbook.md --var-json config={"host":"localhost","port":3000} --json',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');
      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toContain('host=localhost');
      expect(commandStartedEvent.command).toContain('port=3000');
    });

    it('object renders as serialized JSON when used directly', async () => {
      const runbookContent = createRunbook({
        steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo {{config}}' }],
      });
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

      const result = runCli(
        'run test.runbook.md --var-json config={"host":"localhost"} --json',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');
      expect(commandStartedEvent).toBeDefined();
      // Object is JSON-stringified and shell-escaped
      expect(commandStartedEvent.command).toContain('"host":"localhost"');
    });

    it('--var-json overrides --var for same key', async () => {
      const runbookContent = createRunbook({
        steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo {{count}}' }],
      });
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

      const result = runCli(
        'run test.runbook.md --var count=10 --var-json count=99 --json',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');
      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo 99');
    });

    it('--var-json overrides --var-file for same key', async () => {
      const runbookContent = createRunbook({
        steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo {{count}}' }],
      });
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);
      await writeFile(join(workspace.cwd, 'vars.yaml'), 'count: 10');

      const result = runCli(
        'run test.runbook.md --var-file vars.yaml --var-json count=99 --json',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');
      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo 99');
    });

    it('multiple --var-json flags', async () => {
      await writeFile(
        join(workspace.cwd, 'test.runbook.md'),
        `---
name: multi-json
---
# Multi JSON

## 1. Echo values
- PASS COMPLETE

\`\`\`bash
rd echo a={{a}} b={{b}}
\`\`\`
`,
      );

      const result = runCli('run test.runbook.md --var-json a=1 --var-json b=2 --json', workspace);

      expect(result.exitCode).toBe(0);
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');
      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toContain('a=1');
      expect(commandStartedEvent.command).toContain('b=2');
    });
  });

  describe('missing variables', () => {
    it('preserves undefined variables as literal text', async () => {
      const runbookContent = createRunbook({
        steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo "{{undefined_var}}"' }],
      });
      await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

      const result = runCli('run test.runbook.md --json', workspace);

      expect(result.exitCode).toBe(0);

      // Parse JSON events and verify undefined variable was preserved
      const events = parseJsonlEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');

      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo "{{undefined_var}}"');
    });
  });

  describe('resume with frozen runbookSrc', () => {
    it('should use stored runbookSrc in pass command', async () => {
      const runbookContent = createRunbook({
        title: 'Test Runbook',
        steps: [
          { title: 'First Step', pass: 'CONTINUE', command: 'rd echo {{message}}' },
          { title: 'Second Step', pass: 'COMPLETE', command: 'rd echo done' },
        ],
      });
      const runbookPath = join(workspace.cwd, 'test.runbook.md');
      await writeFile(runbookPath, runbookContent);

      // Run with variable to store expanded content
      runCli('run test.runbook.md --var message=original --prompted', workspace);

      // Delete source file to confirm we're using runbookSrc
      await rm(runbookPath);

      // Pass should work with stored runbookSrc
      const result = runCli('pass --json', workspace);
      expect(result.exitCode).toBe(0);

      // Parse JSONL output - the last line contains the final state
      const lines = result.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      const output = JSON.parse(lines[lines.length - 1]);
      expect(output.action).toBe('CONTINUE');
      expect(output.from).toBe('1');
      expect(output.at).toBe('2');
    });

    it('should use stored runbookSrc in fail command', async () => {
      const runbookContent = createRunbook({
        title: 'Test Runbook',
        steps: [
          {
            title: 'First Step',
            pass: 'CONTINUE',
            fail: 'RETRY 1 STOP',
            command: 'rd echo {{message}}',
          },
          { title: 'Second Step', pass: 'COMPLETE', command: 'rd echo done' },
        ],
      });
      const runbookPath = join(workspace.cwd, 'test.runbook.md');
      await writeFile(runbookPath, runbookContent);

      runCli('run test.runbook.md --var message=original --prompted', workspace);
      await rm(runbookPath);

      const result = runCli('fail --json', workspace);
      expect(result.exitCode).toBe(0);

      // Parse JSONL output - the last line contains the final state
      const lines = result.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      const output = JSON.parse(lines[lines.length - 1]);
      expect(output.action).toContain('RETRY');
      expect(output.from).toBe('1');
      expect(output.at).toBe('1');
    });

    it('should use stored runbookSrc in goto command', async () => {
      const runbookContent = createRunbook({
        title: 'Test Runbook',
        steps: [
          { title: 'First Step', pass: 'CONTINUE', command: 'rd echo {{message}}' },
          { title: 'Second Step', pass: 'COMPLETE', command: 'rd echo done' },
        ],
      });
      const runbookPath = join(workspace.cwd, 'test.runbook.md');
      await writeFile(runbookPath, runbookContent);

      runCli('run test.runbook.md --var message=original --prompted', workspace);
      await rm(runbookPath);

      const result = runCli('goto 2 --json', workspace);
      expect(result.exitCode).toBe(0);

      // Parse JSONL output - the last line contains the final state
      const lines = result.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      const output = JSON.parse(lines[lines.length - 1]);
      expect(output.action).toContain('GOTO');
      expect(output.from).toBe('1');
      expect(output.at).toBe('2');
    });

    it('should use stored runbookSrc in complete command', async () => {
      const runbookContent = createRunbook({
        title: 'Test Runbook',
        steps: [
          { title: 'First Step', pass: 'CONTINUE', command: 'rd echo {{message}}' },
          { title: 'Second Step', pass: 'COMPLETE', command: 'rd echo done' },
        ],
      });
      const runbookPath = join(workspace.cwd, 'test.runbook.md');
      await writeFile(runbookPath, runbookContent);

      runCli('run test.runbook.md --var message=original --prompted', workspace);
      await rm(runbookPath);

      const result = runCli('complete --json', workspace);
      expect(result.exitCode).toBe(0);

      // Complete outputs a single pretty-printed JSON object
      const output = JSON.parse(result.stdout);
      expect(output.action).toBe('complete');
    });

    it('should use stored runbookSrc in status command', async () => {
      const runbookContent = createRunbook({
        title: 'Test Runbook',
        steps: [
          { title: 'First Step', pass: 'CONTINUE', command: 'rd echo {{message}}' },
          { title: 'Second Step', pass: 'COMPLETE', command: 'rd echo done' },
        ],
      });
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
      const runbookContent = createRunbook({
        title: 'Test Runbook',
        steps: [
          { title: 'First Step', pass: 'CONTINUE', command: 'rd echo {{message}}' },
          { title: 'Second Step', pass: 'COMPLETE', command: 'rd echo done' },
        ],
      });
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

      // Parse JSON output and verify runbook was restored
      const output = JSON.parse(result.stdout);
      expect(output.action).toBe('pop');
      expect(output.position.current).toBe('1');
      expect(output.position.total).toBe(2);
    });
  });
});
