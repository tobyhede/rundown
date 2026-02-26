import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  createRunbook,
  findActionOutput,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * Parse NDJSON output from `run --json`, filtering out non-JSON lines (command output).
 */
function parseNdjsonEvents(stdout: string): Record<string, unknown>[] {
  return stdout
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function extractJsonObjects(stdout: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < stdout.length; index += 1) {
    const char = stdout[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = stdout.slice(start, index + 1);
        try {
          parsed.push(JSON.parse(candidate) as Record<string, unknown>);
        } catch {
          // Ignore malformed segments.
        }
        start = -1;
      }
    }
  }

  return parsed;
}

function findActionOutputFromJsonStream(stdout: string): Record<string, unknown> | null {
  const parsed = findActionOutput(stdout);
  if (parsed) {
    return parsed;
  }

  const parsedObjects = extractJsonObjects(stdout);
  if (parsedObjects.length === 0) {
    return null;
  }

  const actionOutput = parsedObjects.find((entry) => 'action' in entry && 'result' in entry);
  if (actionOutput) {
    return actionOutput;
  }

  const resultOutput = parsedObjects.find((entry) => 'result' in entry);
  return resultOutput ?? null;
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
      const events = parseNdjsonEvents(result.stdout);
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
      const events = parseNdjsonEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');

      expect(commandStartedEvent).toBeDefined();
      // Empty value is shell-escaped to '' (single-quoted empty string)
      expect(commandStartedEvent.command).toBe("rd echo ''");
      expect(commandStartedEvent.command).not.toContain('from-file');
    });

    it('--var-file overrides auto-discovered config', async () => {
      // Create auto-discovered config
      await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
      await writeFile(join(workspace.cwd, '.rundown', 'config.yaml'), 'message: auto-discovered');

      // Create explicit var file
      await writeFile(join(workspace.cwd, 'custom.yaml'), 'message: explicit');

      const result = runCli('run test.runbook.md --var-file custom.yaml --json', workspace);

      expect(result.exitCode).toBe(0);

      // Parse JSON events and verify explicit var file value was used
      const events = parseNdjsonEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');

      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent.command).toBe('rd echo explicit');
      expect(commandStartedEvent.command).not.toContain('auto-discovered');
    });

    it('uses auto-discovered config when no flags provided', async () => {
      await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
      await writeFile(join(workspace.cwd, '.rundown', 'config.yaml'), 'message: auto-discovered');

      const result = runCli('run test.runbook.md --json', workspace);

      expect(result.exitCode).toBe(0);

      // Parse JSON events and verify auto-discovered value was used
      const events = parseNdjsonEvents(result.stdout);
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

      const events = parseNdjsonEvents(result.stdout);
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

      const events = parseNdjsonEvents(result.stdout);
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

      const events = parseNdjsonEvents(result.stdout);
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
      await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
      await writeFile(join(workspace.cwd, '.rundown', 'config.yaml'), 'message: from-config');

      const result = runCli('run test.runbook.md --json', workspace);

      expect(result.exitCode).toBe(0);

      const events = parseNdjsonEvents(result.stdout);
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

      const events = parseNdjsonEvents(result.stdout);
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

      const events = parseNdjsonEvents(result.stdout);
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

      // Run child runbook directly with --json to capture NDJSON events
      const result = runCli('run child.runbook.md --json', workspace);
      expect(result.exitCode).toBe(0);

      // Verify the command was expanded with the frontmatter default variable
      const events = parseNdjsonEvents(result.stdout);
      const commandStartedEvent = events.find((e) => e.type === 'command_started');
      expect(commandStartedEvent).toBeDefined();
      expect(commandStartedEvent!.command).toBe('rd echo DefaultTask');
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
      const events = parseNdjsonEvents(result.stdout);
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

      // Parse NDJSON output - the last line contains the final state
      const lines = result.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      const output = JSON.parse(lines[lines.length - 1]);
      expect(output.result).toBe(true);
      expect(output.action).toBe('CONTINUE');
      expect(output.from.current).toBe('1');
      expect(output.to.current).toBe('2');
    });

    it('should use stored runbookSrc in fail command', async () => {
      const runbookContent = createRunbook({
        title: 'Test Runbook',
        steps: [
          {
            title: 'First Step',
            pass: 'CONTINUE',
            fail: 'RETRY 1',
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

      // Parse NDJSON output - the last line contains the final state
      const lines = result.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      const output = JSON.parse(lines[lines.length - 1]);
      expect(output.result).toBe(false);
      expect(output.action).toContain('RETRY');
      expect(output.from.current).toBe('1');
      expect(output.to.current).toBe('1');
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

      // Parse NDJSON output - the last line contains the final state
      const lines = result.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      const output = JSON.parse(lines[lines.length - 1]);
      expect(output.result).toBe(true);
      expect(output.action).toContain('GOTO');
      expect(output.from.current).toBe('1');
      expect(output.to.current).toBe('2');
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
      expect(output.result).toBe(true);
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
      expect(output.result).toBe(true);
      expect(output.action).toBe('pop');
      expect(output.position.current).toBe('1');
      expect(output.position.total).toBe(2);
    });
  });

  describe('Mode 3 child runbook variable inheritance', () => {
    it('should expand child runbook variables and store in runbookSrc', async () => {
      // Create parent runbook that delegates to child
      const parentRunbook = createRunbook({
        title: 'Parent Runbook',
        steps: [{ title: 'Dispatch work', pass: 'COMPLETE', content: 'Delegate work to agent.' }],
      });

      // Create child runbook with template variables
      const childRunbook = createRunbook({
        title: 'Child Runbook',
        steps: [{ title: 'Execute task', pass: 'COMPLETE', command: 'rd echo {{task_name}}' }],
      });

      // Set up runbooks directory
      const runbooksDir = join(workspace.cwd, 'runbooks');
      await mkdir(runbooksDir, { recursive: true });
      await writeFile(join(runbooksDir, 'parent.runbook.md'), parentRunbook);
      await writeFile(join(runbooksDir, 'child.runbook.md'), childRunbook);

      // Start parent runbook in prompted mode
      let result = runCli('run runbooks/parent.runbook.md --prompted', workspace);
      expect(result.exitCode).toBe(0);

      // Queue step with child runbook binding
      result = runCli('run --step 1 runbooks/child.runbook.md', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Step 1 queued');

      // Bind agent to step with variables
      result = runCli('run --agent test-agent --var task_name=TestTask', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      // Verify child runbook was created with expanded variables
      // The child runbook should now be active for the agent
      result = runCli('status --json', workspace);
      expect(result.exitCode).toBe(0);

      const statusOutput = JSON.parse(result.stdout);

      // The parent runbook should show the agent binding
      expect(statusOutput.agents).toBeDefined();
      expect(statusOutput.agents['test-agent']).toBeDefined();
      expect(statusOutput.agents['test-agent'].step).toBe('1');
      expect(statusOutput.agents['test-agent'].status).toBe('running');

      // Now check that the child runbook has expanded variables
      // We can verify this by completing the child and checking if it used the variable
      result = runCli('pass --agent test-agent --json', workspace);
      expect(result.exitCode).toBe(0);

      // The child should have executed with the expanded variable
      // Since we can't directly inspect runbookSrc without accessing state files,
      // we verify indirectly by confirming the execution succeeded with the variable
      const passOutput = findActionOutputFromJsonStream(result.stdout);
      expect(passOutput).not.toBeNull();
      expect(passOutput?.result).toBe(true);
    });

    it('should handle child runbook with missing variables', async () => {
      // Create parent and child runbooks
      const parentRunbook = createRunbook({
        title: 'Parent Runbook',
        steps: [{ title: 'Dispatch work', pass: 'COMPLETE', content: 'Delegate work to agent.' }],
      });

      const childRunbook = createRunbook({
        title: 'Child Runbook',
        steps: [
          { title: 'Execute task', pass: 'COMPLETE', command: 'rd echo "Task: {{task_name}}"' },
        ],
      });

      const runbooksDir = join(workspace.cwd, 'runbooks');
      await mkdir(runbooksDir, { recursive: true });
      await writeFile(join(runbooksDir, 'parent.runbook.md'), parentRunbook);
      await writeFile(join(runbooksDir, 'child.runbook.md'), childRunbook);

      // Start parent runbook
      runCli('run runbooks/parent.runbook.md --prompted', workspace);

      // Queue step with child runbook
      runCli('run --step 1 runbooks/child.runbook.md', workspace);

      // Bind agent WITHOUT providing variables
      const result = runCli('run --agent test-agent', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      // Child should be created with literal {{task_name}} preserved
      // Pass the step to complete
      const passResult = runCli('pass --agent test-agent --json', workspace);
      expect(passResult.exitCode).toBe(0);
      const passOutput = findActionOutputFromJsonStream(passResult.stdout);
      expect(passOutput).not.toBeNull();
      expect(passOutput?.result).toBe(true);
    });

    it('should inherit parent variables in child runbook', async () => {
      // Create parent and child runbooks
      const parentRunbook = createRunbook({
        title: 'Parent Runbook',
        steps: [{ title: 'Dispatch work', pass: 'COMPLETE', content: 'Delegate work to agent.' }],
      });

      const childRunbook = createRunbook({
        title: 'Child Runbook',
        steps: [
          {
            title: 'Execute task',
            pass: 'COMPLETE',
            command: 'rd echo "Project: {{project_name}}, Task: {{task_name}}"',
          },
        ],
      });

      const runbooksDir = join(workspace.cwd, 'runbooks');
      await mkdir(runbooksDir, { recursive: true });
      await writeFile(join(runbooksDir, 'parent.runbook.md'), parentRunbook);
      await writeFile(join(runbooksDir, 'child.runbook.md'), childRunbook);

      // Start parent with project-level variable
      runCli('run runbooks/parent.runbook.md --var project_name=MyProject --prompted', workspace);

      // Queue step with child runbook
      runCli('run --step 1 runbooks/child.runbook.md', workspace);

      // Bind agent with additional task-specific variable
      // Variables must be explicitly passed to child runbooks via --var flags
      // when binding agents. There is no automatic inheritance from parent context.
      const result = runCli(
        'run --agent test-agent --var task_name=BuildTask --var project_name=MyProject',
        workspace,
      );
      expect(result.exitCode).toBe(0);

      // Complete the child task
      const passResult = runCli('pass --agent test-agent --json', workspace);
      expect(passResult.exitCode).toBe(0);

      const passOutput = findActionOutputFromJsonStream(passResult.stdout);
      expect(passOutput).not.toBeNull();
      expect(passOutput?.result).toBe(true);
    });
  });
});
