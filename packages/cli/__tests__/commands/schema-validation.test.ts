/**
 * Schema validation tests for CLI JSON output.
 *
 * These tests verify that all commands produce default JSON output
 * that conforms to the standardized JSON output schema.
 *
 * @module tests/commands/schema-validation
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createRunbook,
  createTestWorkspace,
  getActiveState,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import {
  validateActionOutput,
  validateStatusOutput,
  validateLsOutput,
  validateCheckOutput,
  validateCollectOutput,
  validateScenarioLsOutput,
  validateScenarioShowOutput,
  validateScenarioRunOutput,
  validatePruneOutput,
  validateStashOutput,
  validatePopOutput,
  validateEchoOutput,
  validatePromptOutput,
  validateErrorOutput,
  validateWarningOutput,
} from '../helpers/schema-validator.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('CLI JSON Output Schema Validation', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /**
   * Helper to parse and validate JSON output.
   *
   * Some commands output JSONL (multiple JSON objects separated by newlines).
   * This function returns the last valid JSON object.
   */
  function parseJsonOutput(stdout: string): unknown {
    try {
      return JSON.parse(stdout);
    } catch {
      // Try JSONL format - split on newlines that start a new JSON object
      const jsonBlocks = stdout.trim().split(/\n(?=\{)/);
      // Prefer first block with 'kind' (accumulated CLI response discriminant).
      // Streaming events use 'type', not 'kind', so the first 'kind' block is
      // the real CLI response — any later 'kind' block may be a process.exit artifact.
      for (const block of jsonBlocks) {
        try {
          const parsed = JSON.parse(block);
          if (typeof parsed === 'object' && parsed !== null && 'kind' in parsed) {
            return parsed;
          }
        } catch {}
      }
      // Fallback: last parseable block
      let lastParsed: unknown;
      for (const block of jsonBlocks) {
        try {
          lastParsed = JSON.parse(block);
        } catch {}
      }
      if (lastParsed !== undefined) return lastParsed;
      // Fallback: try to find any JSON object in the output
      const jsonMatch = stdout.match(/\{[\s\S]*?\n\}|\[[\s\S]*?\n\]/g);
      if (jsonMatch && jsonMatch.length > 0) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error(`Failed to parse JSON output: ${stdout}`);
    }
  }

  /**
   * Parse JSONL output as an array of events.
   * Used for execution commands that stream events.
   */
  function parseJsonlOutput(stdout: string): unknown[] {
    const lines = stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim());
    const events: unknown[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip non-JSON lines
      }
    }
    return events;
  }

  /**
   * Drive a single-step runbook to a terminal lifecycle while leaving it as the
   * active session entry, so the next `stop`/`complete` hits the
   * already-terminal short-circuit that emits a `RUNBOOK_NOT_RUNNING` warning.
   *
   * Mirrors the resurrection setup in complete.test.ts / stop.test.ts.
   *
   * @param name - Runbook file basename (without extension).
   * @returns The completed runbook state id.
   */
  async function driveToTerminalActive(name: string): Promise<string> {
    const runbook = `# Terminal ${name}\n\n## 1. Work\n- PASS COMPLETE\n- FAIL STOP\n`;
    fs.writeFileSync(path.join(workspace.cwd, `${name}.runbook.md`), runbook);
    await runCliInProcess(`run --prompted ${name}.runbook.md --text`, workspace);
    const state = await getActiveState(workspace);
    if (!state) throw new Error('expected active runbook');
    await runCliInProcess('pass --text', workspace);

    // Resurrect the session entry so the terminal state is still active.
    const fsp = await import('node:fs/promises');
    const sessionFile = path.join(workspace.statePath(), '..', 'session.json');
    const session = JSON.parse(await fsp.readFile(sessionFile, 'utf8')) as Record<string, unknown>;
    await fsp.writeFile(
      sessionFile,
      JSON.stringify({ ...session, active: state.id, defaultStack: [state.id] }),
      'utf8',
    );
    return state.id;
  }

  /**
   * Find an event of a specific type in JSONL output.
   */
  function findEventByType(events: unknown[], type: string): Record<string, unknown> | undefined {
    return events.find(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && (e as Record<string, unknown>).type === type,
    );
  }

  // ==========================================================================
  // Status Command
  // ==========================================================================

  describe('collect', () => {
    it('validates collect response variants', () => {
      const alreadyAggregated = {
        kind: 'collect',
        action: 'collect',
        status: 'already-aggregated',
        step: '1',
        parentRunId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      };
      const alreadyAggregatedWithCode = {
        kind: 'collect',
        action: 'collect',
        status: 'already-aggregated',
        step: '1',
        parentRunId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        code: 'COLLECT_ALREADY_APPLIED',
      };
      const notActive = {
        kind: 'collect',
        action: 'collect',
        status: 'not-active',
        step: '1',
        parentRunId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        frameKey: '1|99',
        activeFrameKey: '1|',
        unresolved: 1,
      };
      const applied = {
        kind: 'collect',
        action: 'collect',
        status: 'applied',
        parentRunId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        applied: 2,
        unresolved: 0,
        lifecycle: 'running',
        reportedTerminalOutcome: false,
      };

      expect(validateCollectOutput(alreadyAggregated)).toEqual({ valid: true, errors: [] });
      expect(validateCollectOutput(alreadyAggregatedWithCode)).toEqual({ valid: true, errors: [] });
      expect(validateCollectOutput(notActive)).toEqual({ valid: true, errors: [] });
      expect(validateCollectOutput(applied)).toEqual({ valid: true, errors: [] });
    });
  });

  describe('status', () => {
    it('validates inactive status output', async () => {
      const result = await runCliInProcess('status', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateStatusOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
    });

    it('validates active status output', async () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
---
## Step 1
prompt: Wait
`,
      );
      await runCliInProcess('run --prompted test.runbook.md --text', workspace);

      const result = await runCliInProcess('status', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateStatusOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify required fields
      expect(output).toHaveProperty('active', true);
      expect(output).toHaveProperty('stashed', false);
    });
  });

  // ==========================================================================
  // List Commands
  // ==========================================================================

  describe('ls', () => {
    it('validates empty list output', async () => {
      const result = await runCliInProcess('ls', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateLsOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
      expect(output).toEqual([]);
    });

    it('validates active runbooks list output', async () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
---
## Step 1
prompt: Wait
`,
      );
      await runCliInProcess('run --prompted test.runbook.md --text', workspace);

      const result = await runCliInProcess('ls', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateLsOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify structure
      expect(Array.isArray(output)).toBe(true);
      expect((output as unknown[])[0]).toHaveProperty('id');
      expect((output as unknown[])[0]).toHaveProperty('runbook');
      expect((output as unknown[])[0]).toHaveProperty('step');
    });

    it('validates available runbooks list output (--all)', async () => {
      const runbooksDirPath = workspace.runbooksDir();
      fs.mkdirSync(runbooksDirPath, { recursive: true });

      const runbookPath = path.join(runbooksDirPath, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
description: A test runbook
---
## Step 1
echo hello
`,
      );

      const result = await runCliInProcess('ls --all', workspace);
      expect(result.exitCode).toBe(0);
      const output = parseJsonOutput(result.stdout);

      const validation = validateLsOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify structure
      expect(Array.isArray(output)).toBe(true);
      const runbook = (output as { name: string }[]).find((r) => r.name === 'test-runbook');
      expect(runbook).toHaveProperty('name');
      expect(runbook).toHaveProperty('path');
    });
  });

  // ==========================================================================
  // Check Command
  // ==========================================================================

  describe('check', () => {
    it('validates successful check output', async () => {
      const runbookPath = path.join(workspace.cwd, 'valid.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `## Step 1
echo hello
`,
      );

      const result = await runCliInProcess(`check ${runbookPath}`, workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateCheckOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify structure
      expect(output).toHaveProperty('valid', true);
      expect(output).toHaveProperty('errors', []);
      expect(output).toHaveProperty('stats');
    });

    it('validates check output with errors', async () => {
      const runbookPath = path.join(workspace.cwd, 'invalid.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `## Step 1
- PASS GOTO 99
echo hello
`,
      );

      const result = await runCliInProcess(`check ${runbookPath}`, workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateCheckOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify structure
      expect(output).toHaveProperty('valid', false);
      expect((output as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
    });

    it('validates check output for missing file', async () => {
      const result = await runCliInProcess('check non-existent.md', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateCheckOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify error structure
      expect(output).toHaveProperty('valid', false);
      expect((output as { errors: { message: string }[] }).errors[0]).toHaveProperty('message');
    });
  });

  // ==========================================================================
  // Action Commands (pass, fail, goto)
  // ==========================================================================

  describe('pass', () => {
    it('validates pass command output', async () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
---
## 1 First Step
prompt: First step

## 2 Second Step
echo done
`,
      );
      await runCliInProcess('run --prompted test.runbook.md --text', workspace);

      const result = await runCliInProcess('pass', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateActionOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify structure
      expect(output).toHaveProperty('action');
    });

    it('validates pass warning when no active runbook', async () => {
      const result = await runCliInProcess('pass', workspace);
      const output = parseJsonOutput(result.stdout);

      // Should still be valid JSON
      expect(typeof output).toBe('object');
      // No-active-runbook is a warning (not an error) — exit 0, message field
      expect(output).toHaveProperty('kind', 'warning');
      expect(output).toHaveProperty('message', 'No active runbook');
      expect(output).toHaveProperty('code', 'NO_ACTIVE_RUNBOOK');

      const validation = validateWarningOutput(output);
      expect(validation.valid).toBe(true);
    });

    it('validates already-resolved substep output', async () => {
      const runbookPath = path.join(workspace.cwd, 'substeps.runbook.md');
      fs.writeFileSync(
        runbookPath,
        createRunbook({
          name: 'substeps',
          steps: [
            {
              title: 'Parent Step',
              pass: 'CONTINUE',
              substeps: [
                { title: 'First', content: 'Resolve once.' },
                { title: 'Second', content: 'Keep parent unresolved.' },
              ],
            },
            { title: 'Done', pass: 'COMPLETE', content: 'Finished.' },
          ],
        }),
      );
      await runCliInProcess('run --prompted substeps.runbook.md --text', workspace);
      await runCliInProcess('pass --step 1.1', workspace);

      const result = await runCliInProcess('pass --step 1.1', workspace);
      expect(result).toMatchObject({ exitCode: 0 });
      const output = parseJsonOutput(result.stdout);

      expect(output).toMatchObject({
        kind: 'action',
        action: 'pass',
        status: 'already-resolved',
      });
      const validation = validateActionOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
    });
  });

  describe('fail', () => {
    it('validates fail command output', async () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
---
## 1 First Step
prompt: First step

## 2 Second Step
echo done
`,
      );
      await runCliInProcess('run --prompted test.runbook.md --text', workspace);

      const result = await runCliInProcess('fail', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateActionOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
    });
  });

  describe('goto', () => {
    it('validates goto command JSONL output', async () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      // Use numeric step names (## 1, ## 2, ## 3) for goto to work
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
---
## 1 First Step
prompt: First step

## 2 Second Step
prompt: Second step

## 3 Third Step
echo done
`,
      );
      await runCliInProcess('run --prompted test.runbook.md --text', workspace);

      const result = await runCliInProcess('goto 2', workspace);
      const events = parseJsonlOutput(result.stdout);

      // Goto command now streams JSONL events plus a final JSON object
      // Execution events stream first, then accumulated output on flush
      expect(events.length).toBeGreaterThan(0);

      // Check for step_entered event (execution resumed after goto)
      const stepEntered = findEventByType(events, 'step_entered');
      expect(stepEntered).toBeDefined();
      if (stepEntered) {
        const event = stepEntered;
        expect(event).toHaveProperty('position');
        expect(event).toHaveProperty('stepName');
      }

      // The action output (from output.action()) is flushed as the final JSON object
      // Find an event with 'action' property (the accumulated output)
      const actionOutput = events.find(
        (e): e is Record<string, unknown> =>
          typeof e === 'object' &&
          e !== null &&
          'action' in e &&
          typeof (e as Record<string, unknown>).action === 'string',
      );
      if (actionOutput) {
        expect(String(actionOutput.action).startsWith('GOTO')).toBe(true);
      }
    });
  });

  // ==========================================================================
  // Stash/Pop Commands
  // ==========================================================================

  describe('stash', () => {
    it('validates stash command output', async () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
---
## Step 1
prompt: Wait
`,
      );
      await runCliInProcess('run --prompted test.runbook.md --text', workspace);

      const result = await runCliInProcess('stash', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateStashOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      expect(output).toHaveProperty('action', 'stash');
    });

    it('validates stash warning when no active runbook', async () => {
      const result = await runCliInProcess('stash', workspace);
      const output = parseJsonOutput(result.stdout);

      // No-active-runbook is a warning (not an error) — exit 0, message field
      expect(output).toHaveProperty('kind', 'warning');
      expect(output).toHaveProperty('message', 'No active runbook');
      expect(output).toHaveProperty('code', 'NO_ACTIVE_RUNBOOK');

      const validation = validateWarningOutput(output);
      expect(validation.valid).toBe(true);
    });
  });

  describe('pop', () => {
    it('validates pop command output', async () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
---
## Step 1
prompt: Wait
`,
      );
      await runCliInProcess('run --prompted test.runbook.md --text', workspace);
      await runCliInProcess('stash --text', workspace);

      const result = await runCliInProcess('pop', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validatePopOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      expect(output).toHaveProperty('action', 'pop');
    });

    it('validates pop error when no stashed runbook', async () => {
      const result = await runCliInProcess('pop', workspace);
      const output = parseJsonOutput(result.stdout);

      // Should indicate error via error field
      expect(output).toHaveProperty('error');
      expect(output).toHaveProperty('code', 'NO_STASHED_RUNBOOK');
    });
  });

  // ==========================================================================
  // Prune Command
  // ==========================================================================

  describe('prune', () => {
    it('validates empty prune output', async () => {
      const result = await runCliInProcess('prune --dry-run', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validatePruneOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
      expect(output).toEqual([]);
    });
  });

  // ==========================================================================
  // Scenario Commands
  // ==========================================================================

  describe('scenario ls', () => {
    it('validates scenario list output', async () => {
      const runbookPath = path.join(workspace.cwd, 'scenarios.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: scenarios-test
scenarios:
  test-scenario:
    description: A test scenario
    commands:
      - echo hello
    result: COMPLETE
---
## Step 1
echo hello
`,
      );

      const result = await runCliInProcess(`scenario ls ${runbookPath}`, workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateScenarioLsOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify structure
      expect(Array.isArray(output)).toBe(true);
      expect((output as unknown[])[0]).toHaveProperty('name');
      expect((output as unknown[])[0]).toHaveProperty('expected');
    });
  });

  describe('scenario show', () => {
    it('validates scenario show success output', async () => {
      const runbookPath = path.join(workspace.cwd, 'show-success.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: show-success
scenarios:
  test-scenario:
    description: A test scenario
    commands:
      - echo hello
    result: COMPLETE
---
## Step 1
echo hello
`,
      );

      const result = await runCliInProcess(`scenario show ${runbookPath} test-scenario`, workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateScenarioShowOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify success structure
      expect(output).toHaveProperty('name', 'test-scenario');
      expect(output).toHaveProperty('expected', 'COMPLETE');
      expect(output).toHaveProperty('description', 'A test scenario');
      expect(output).toHaveProperty('commands');
      expect((output as { commands: string[] }).commands).toContain('echo hello');
    });

    it('validates scenario show error output', async () => {
      const runbookPath = path.join(workspace.cwd, 'scenarios.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: scenarios-test
scenarios:
  test-scenario:
    description: A test scenario
    commands:
      - echo hello
    result: COMPLETE
---
## Step 1
echo hello
`,
      );

      const result = await runCliInProcess(`scenario show ${runbookPath} non-existent`, workspace);
      const output = parseJsonOutput(result.stdout);

      // Error responses use the standard ErrorResponse schema
      const validation = validateErrorOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify error structure per docs/spec/cli-output.md
      expect(output).toHaveProperty('error', 'Scenario "non-existent" not found');
      expect(output).toHaveProperty('code', 'SCENARIO_NOT_FOUND');
    });
  });

  // ==========================================================================
  // Echo Command
  // ==========================================================================

  describe('echo', () => {
    it('validates echo command output', async () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
---
## Step 1
prompt: Wait
`,
      );
      await runCliInProcess('run --prompted test.runbook.md --text', workspace);

      const result = await runCliInProcess('echo hello world', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateEchoOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Uses `output` for echoed text per docs/spec/cli-output.md
      expect(output).toHaveProperty('output', 'hello world');
      expect(output).toHaveProperty('exitCode', 0);
      // Echo without --result should have result as boolean
      if ('result' in (output as Record<string, unknown>)) {
        expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
      }
    });

    it('validates echo with result flag', async () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
---
## Step 1
prompt: Wait
`,
      );
      await runCliInProcess('run --prompted test.runbook.md --text', workspace);

      const result = await runCliInProcess('echo --result PASS test', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateEchoOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Uses `output` for echoed text, `result` is boolean per docs/spec/cli-output.md
      expect(output).toHaveProperty('output', 'test');
      expect(output).toHaveProperty('result', true);
      // Explicit type check: result must be boolean, not string
      expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
    });
  });

  // ==========================================================================
  // Prompt Command
  // ==========================================================================

  describe('prompt', () => {
    it('validates prompt command output', async () => {
      // Use array form to preserve quoted content as single argument
      const result = await runCliInProcess(['prompt', 'Hello World'], workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validatePromptOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Uses `output` for content per docs/spec/cli-output.md
      expect(output).toHaveProperty('output', 'Hello World');
    });

    it('validates prompt with special characters', async () => {
      // Use array form to preserve content with spaces as single argument
      const result = await runCliInProcess(['prompt', 'Test with spaces and chars'], workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validatePromptOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      expect(output).toHaveProperty('output', 'Test with spaces and chars');
    });
  });

  // ==========================================================================
  // Run Command
  // ==========================================================================

  describe('run', () => {
    it('validates run command JSONL completion output', async () => {
      const runbookPath = path.join(workspace.cwd, 'simple.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: simple-test
---
## Step 1
echo hello
`,
      );

      const result = await runCliInProcess('run simple.runbook.md', workspace);
      const events = parseJsonlOutput(result.stdout);

      // Run command now streams JSONL events
      expect(events.length).toBeGreaterThan(0);

      // Should have runbook_started event
      const startedEvent = findEventByType(events, 'runbook_started');
      expect(startedEvent).toBeDefined();
      if (startedEvent) {
        const event = startedEvent;
        expect(event).toHaveProperty('prompted');
        expect(event).toHaveProperty('statePath');
        expect(event).toMatchObject({
          runbookId: expect.stringMatching(/^rd_[a-f0-9]{32}$/),
          runCapability: expect.stringMatching(/^rdrc_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/),
        });
        expect(
          fs.readFileSync(path.join(workspace.cwd, '.rundown', 'session.json'), 'utf-8'),
        ).not.toContain(String(event.runCapability));
      }

      // Should have runbook_completed event for successful run
      const completedEvent = findEventByType(events, 'runbook_completed');
      expect(completedEvent).toBeDefined();
      if (completedEvent) {
        const event = completedEvent;
        expect(event).toHaveProperty('finalPosition');
      }
    });

    it('validates run command with prompted runbook JSONL output', async () => {
      const runbookPath = path.join(workspace.cwd, 'prompted.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: prompted-test
---
## Step 1
prompt: Wait for user
`,
      );

      const result = await runCliInProcess('run --prompted prompted.runbook.md', workspace);
      const events = parseJsonlOutput(result.stdout);

      // Run command with prompted flag streams JSONL events
      expect(events.length).toBeGreaterThan(0);

      // Should have runbook_started event with prompted=true
      const startedEvent = findEventByType(events, 'runbook_started');
      expect(startedEvent).toBeDefined();
      if (startedEvent) {
        const event = startedEvent;
        expect(event).toHaveProperty('prompted', true);
      }

      // Running with prompted flag should pause, so no completion event
      const completedEvent = findEventByType(events, 'runbook_completed');
      expect(completedEvent).toBeUndefined();
    });
  });

  // ==========================================================================
  // Scenario Run Command
  // ==========================================================================

  describe('scenario run', () => {
    it('validates scenario run success output', async () => {
      const runbookPath = path.join(workspace.cwd, 'test-scenarios.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: scenario-test
scenarios:
  simple:
    result: COMPLETE
    commands:
      - echo "test"
---
## Step 1
echo hello
`,
      );

      const result = await runCliInProcess(`scenario run ${runbookPath} simple`, workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateScenarioRunOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      expect(output).toHaveProperty('result');
      expect(output).toHaveProperty('scenario', 'simple');
      expect(output).toHaveProperty('expected', 'COMPLETE');
      expect(output).toHaveProperty('actual');
    });
  });

  // ==========================================================================
  // Stop/Complete Commands
  // ==========================================================================

  describe('stop', () => {
    it('validates stop command output', async () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
---
## Step 1
prompt: Wait
`,
      );
      await runCliInProcess('run --prompted test.runbook.md --text', workspace);

      const result = await runCliInProcess('stop', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateActionOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Per docs/spec/cli-output.md: action='stop' (command name)
      expect(output).toHaveProperty('action', 'stop');
    });

    it('validates already-terminal warning (RUNBOOK_NOT_RUNNING)', async () => {
      await driveToTerminalActive('terminal-stop');

      const result = await runCliInProcess('stop', workspace);
      const output = parseJsonOutput(result.stdout);

      expect(output).toHaveProperty('kind', 'warning');
      expect(output).toHaveProperty('code', 'RUNBOOK_NOT_RUNNING');

      const validation = validateWarningOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
    });
  });

  describe('complete', () => {
    it('validates complete command output', async () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
---
## Step 1
prompt: Wait
`,
      );
      await runCliInProcess('run --prompted test.runbook.md --text', workspace);

      const result = await runCliInProcess('complete', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateActionOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Current format: action='complete'
      expect(output).toHaveProperty('action', 'complete');
    });

    it('validates already-terminal warning (RUNBOOK_NOT_RUNNING)', async () => {
      await driveToTerminalActive('terminal-complete');

      const result = await runCliInProcess('complete', workspace);
      const output = parseJsonOutput(result.stdout);

      expect(output).toHaveProperty('kind', 'warning');
      expect(output).toHaveProperty('code', 'RUNBOOK_NOT_RUNNING');

      const validation = validateWarningOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
    });
  });

  // ==========================================================================
  // Error Response Validation
  // ==========================================================================

  describe('error responses', () => {
    it('validates no active runbook warning format', async () => {
      const result = await runCliInProcess('pass', workspace);
      const output = parseJsonOutput(result.stdout);

      // No-active-runbook emits a warning (not an error): exit 0, kind: 'warning', message field
      expect(output).toHaveProperty('kind', 'warning');
      expect(output).toHaveProperty('message', 'No active runbook');
      expect(output).toHaveProperty('code', 'NO_ACTIVE_RUNBOOK');

      const validation = validateWarningOutput(output);
      expect(validation.valid).toBe(true);
    });
  });

  // ==========================================================================
  // Exit Code Verification
  // ==========================================================================

  describe('exit codes', () => {
    it('returns 0 for successful commands', async () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `## Step 1
echo hello
`,
      );

      const result = await runCliInProcess(`check ${runbookPath} --text`, workspace);
      expect(result.exitCode).toBe(0);
    });

    it('returns non-zero for validation errors', async () => {
      const runbookPath = path.join(workspace.cwd, 'invalid.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `## Step 1
- PASS GOTO 99
echo hello
`,
      );

      const result = await runCliInProcess(`check ${runbookPath} --text`, workspace);
      expect(result.exitCode).toBe(1);
    });

    it('returns 0 for text mode even when result is false', async () => {
      // ls with no runbooks still exits 0 (empty list is valid)
      const result = await runCliInProcess('ls --text', workspace);
      expect(result.exitCode).toBe(0);
    });
  });
});
