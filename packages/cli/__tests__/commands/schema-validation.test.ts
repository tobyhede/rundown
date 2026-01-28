/**
 * Schema validation tests for CLI JSON output.
 *
 * These tests verify that all commands with --json flag produce output
 * that conforms to the standardized JSON output schema.
 *
 * @module tests/commands/schema-validation
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import {
  validateActionOutput,
  validateStatusOutput,
  validateLsOutput,
  validateCheckOutput,
  validateScenarioLsOutput,
  validateScenarioShowOutput,
  validateScenarioRunOutput,
  validatePruneOutput,
  validateStashOutput,
  validatePopOutput,
  validateEchoOutput,
  validatePromptOutput,
  validateStepQueuedOutput,
  validateAgentBoundOutput,
  validateErrorOutput,
} from '../helpers/schema-validator.js';
import * as fs from 'fs';
import * as path from 'path';

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
   * Some commands output NDJSON (multiple JSON objects separated by newlines).
   * This function returns the last valid JSON object.
   */
  function parseJsonOutput(stdout: string): unknown {
    try {
      return JSON.parse(stdout);
    } catch {
      // Try NDJSON format - split by newlines and parse last valid JSON
      const lines = stdout.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        // Try to find a complete JSON object by accumulating lines
        const potentialJson = lines.slice(i).join('\n');
        try {
          // Look for JSON that starts with { or [
          const jsonStart = potentialJson.indexOf('{');
          const arrayStart = potentialJson.indexOf('[');
          const start = jsonStart >= 0 && (arrayStart < 0 || jsonStart < arrayStart)
            ? jsonStart
            : arrayStart;
          if (start >= 0) {
            return JSON.parse(potentialJson.slice(start));
          }
        } catch {
          continue;
        }
      }
      // Try to find any JSON object in the output
      const jsonMatch = stdout.match(/\{[\s\S]*\}|\[[\s\S]*\]/g);
      if (jsonMatch && jsonMatch.length > 0) {
        // Return the last JSON object
        return JSON.parse(jsonMatch[jsonMatch.length - 1]);
      }
      throw new Error(`Failed to parse JSON output: ${stdout}`);
    }
  }

  /**
   * Parse NDJSON output as an array of events.
   * Used for execution commands that stream events.
   */
  function parseNdjsonOutput(stdout: string): unknown[] {
    const lines = stdout.trim().split('\n').filter(line => line.trim());
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
   * Find an event of a specific type in NDJSON output.
   */
  function findEventByType(events: unknown[], type: string): Record<string, unknown> | undefined {
    return events.find((e): e is Record<string, unknown> =>
      typeof e === 'object' && e !== null && (e as Record<string, unknown>).type === type
    );
  }

  // ==========================================================================
  // Status Command
  // ==========================================================================

  describe('status --json', () => {
    it('validates inactive status output', () => {
      const result = runCli('status --json', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateStatusOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
    });

    it('validates active status output', () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
---
## Step 1
prompt: Wait
`);
      runCli('run --prompted test.runbook.md', workspace);

      const result = runCli('status --json', workspace);
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

  describe('ls --json', () => {
    it('validates empty list output', () => {
      const result = runCli('ls --json', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateLsOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
      expect(output).toEqual([]);
    });

    it('validates active runbooks list output', () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
---
## Step 1
prompt: Wait
`);
      runCli('run --prompted test.runbook.md', workspace);

      const result = runCli('ls --json', workspace);
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

    it('validates available runbooks list output (--all)', () => {
      const runbooksDir = path.join(workspace.cwd, '.claude', 'rundown', 'runbooks');
      fs.mkdirSync(runbooksDir, { recursive: true });

      const runbookPath = path.join(runbooksDir, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
description: A test runbook
---
## Step 1
echo hello
`);

      const result = runCli('ls --all --json', workspace);
      expect(result.exitCode).toBe(0);
      const output = parseJsonOutput(result.stdout);

      const validation = validateLsOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify structure
      expect(Array.isArray(output)).toBe(true);
      const runbook = (output as { name: string }[]).find(r => r.name === 'test-runbook');
      expect(runbook).toHaveProperty('name');
      expect(runbook).toHaveProperty('path');
    });
  });

  // ==========================================================================
  // Check Command
  // ==========================================================================

  describe('check --json', () => {
    it('validates successful check output', () => {
      const runbookPath = path.join(workspace.cwd, 'valid.runbook.md');
      fs.writeFileSync(runbookPath, `## Step 1
echo hello
`);

      const result = runCli(`check ${runbookPath} --json`, workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateCheckOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify structure
      expect(output).toHaveProperty('valid', true);
      expect(output).toHaveProperty('errors', []);
      expect(output).toHaveProperty('stats');
    });

    it('validates check output with errors', () => {
      const runbookPath = path.join(workspace.cwd, 'invalid.runbook.md');
      fs.writeFileSync(runbookPath, `## Step 1
- PASS: GOTO 99
echo hello
`);

      const result = runCli(`check ${runbookPath} --json`, workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateCheckOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify structure
      expect(output).toHaveProperty('valid', false);
      expect((output as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
    });

    it('validates check output for missing file', () => {
      const result = runCli('check non-existent.md --json', workspace);
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

  describe('pass --json', () => {
    it('validates pass command output', () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
---
## Step 1
prompt: First step

## Step 2
echo done
`);
      runCli('run --prompted test.runbook.md', workspace);

      const result = runCli('pass --json', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateActionOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify structure
      expect(output).toHaveProperty('action');
      // Explicit type check: result must be boolean, not string
      if ('result' in (output as Record<string, unknown>)) {
        expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
        // Regression guard: ensure string literals are never used
        expect((output as Record<string, unknown>).result).not.toBe('PASS');
        expect((output as Record<string, unknown>).result).not.toBe('FAIL');
      }
    });

    it('validates pass error when no active runbook', () => {
      const result = runCli('pass --json', workspace);
      const output = parseJsonOutput(result.stdout);

      // Should still be valid JSON
      expect(typeof output).toBe('object');
      // Should indicate no active runbook
      expect(output).toHaveProperty('result', false);
      // Explicit type check: result must be boolean, not string
      expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
    });
  });

  describe('fail --json', () => {
    it('validates fail command output', () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
---
## Step 1
prompt: First step

## Step 2
echo done
`);
      runCli('run --prompted test.runbook.md', workspace);

      const result = runCli('fail --json', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateActionOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Explicit type check: result must be boolean, not string
      if ('result' in (output as Record<string, unknown>)) {
        expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
      }
    });
  });

  describe('goto --json', () => {
    it('validates goto command NDJSON output', () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      // Use numeric step names (## 1, ## 2, ## 3) for goto to work
      fs.writeFileSync(runbookPath, `---
name: test-runbook
---
## 1 First Step
prompt: First step

## 2 Second Step
prompt: Second step

## 3 Third Step
echo done
`);
      runCli('run --prompted test.runbook.md', workspace);

      const result = runCli('goto 2 --json', workspace);
      const events = parseNdjsonOutput(result.stdout);

      // Goto command now streams NDJSON events plus a final JSON object
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
      const actionOutput = events.find((e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && 'action' in e && typeof (e as Record<string, unknown>).action === 'string'
      );
      if (actionOutput) {
        expect(String(actionOutput.action).startsWith('GOTO')).toBe(true);
      }
    });
  });

  // ==========================================================================
  // Stash/Pop Commands
  // ==========================================================================

  describe('stash --json', () => {
    it('validates stash command output', () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
---
## Step 1
prompt: Wait
`);
      runCli('run --prompted test.runbook.md', workspace);

      const result = runCli('stash --json', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateStashOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Uses action='stash' (present tense verb), result=true
      expect(output).toHaveProperty('result', true);
      expect(output).toHaveProperty('action', 'stash');
      // Explicit type check: result must be boolean, not string
      expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
    });

    it('validates stash error when no active runbook', () => {
      const result = runCli('stash --json', workspace);
      const output = parseJsonOutput(result.stdout);

      // Should indicate error
      expect(output).toHaveProperty('result', false);
      // Explicit type check: result must be boolean, not string
      expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
    });
  });

  describe('pop --json', () => {
    it('validates pop command output', () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
---
## Step 1
prompt: Wait
`);
      runCli('run --prompted test.runbook.md', workspace);
      runCli('stash', workspace);

      const result = runCli('pop --json', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validatePopOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      expect(output).toHaveProperty('result', true);
      expect(output).toHaveProperty('action', 'pop');
      // Explicit type check: result must be boolean, not string
      expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
    });

    it('validates pop error when no stashed runbook', () => {
      const result = runCli('pop --json', workspace);
      const output = parseJsonOutput(result.stdout);

      // Should indicate error
      expect(output).toHaveProperty('result', false);
      // Explicit type check: result must be boolean, not string
      expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
    });
  });

  // ==========================================================================
  // Prune Command
  // ==========================================================================

  describe('prune --json', () => {
    it('validates empty prune output', () => {
      const result = runCli('prune --dry-run --json', workspace);
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

  describe('scenario ls --json', () => {
    it('validates scenario list output', () => {
      const runbookPath = path.join(workspace.cwd, 'scenarios.runbook.md');
      fs.writeFileSync(runbookPath, `---
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
`);

      const result = runCli(`scenario ls ${runbookPath} --json`, workspace);
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

  describe('scenario show --json', () => {
    it('validates scenario show success output', () => {
      const runbookPath = path.join(workspace.cwd, 'show-success.runbook.md');
      fs.writeFileSync(runbookPath, `---
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
`);

      const result = runCli(`scenario show ${runbookPath} test-scenario --json`, workspace);
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

    it('validates scenario show error output', () => {
      const runbookPath = path.join(workspace.cwd, 'scenarios.runbook.md');
      fs.writeFileSync(runbookPath, `---
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
`);

      const result = runCli(`scenario show ${runbookPath} non-existent --json`, workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateScenarioShowOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify error structure
      expect(output).toHaveProperty('error', true);
      expect(output).toHaveProperty('message');
    });
  });

  // ==========================================================================
  // Echo Command
  // ==========================================================================

  describe('echo --json', () => {
    it('validates echo command output', () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
---
## Step 1
prompt: Wait
`);
      runCli('run --prompted test.runbook.md', workspace);

      const result = runCli('echo --json hello world', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateEchoOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Uses `output` for echoed text per CLI-OUTPUT-SPEC
      expect(output).toHaveProperty('output', 'hello world');
      expect(output).toHaveProperty('exitCode', 0);
      // Echo without --result should have result as boolean
      if ('result' in (output as Record<string, unknown>)) {
        expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
      }
    });

    it('validates echo with result flag', () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
---
## Step 1
prompt: Wait
`);
      runCli('run --prompted test.runbook.md', workspace);

      const result = runCli('echo --json --result PASS test', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateEchoOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Uses `output` for echoed text, `result` is boolean per CLI-OUTPUT-SPEC
      expect(output).toHaveProperty('output', 'test');
      expect(output).toHaveProperty('result', true);
      // Explicit type check: result must be boolean, not string
      expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
    });
  });

  // ==========================================================================
  // Prompt Command
  // ==========================================================================

  describe('prompt --json', () => {
    it('validates prompt command output', () => {
      // Use array form to preserve quoted content as single argument
      const result = runCli(['prompt', 'Hello World', '--json'], workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validatePromptOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Uses `output` for content per CLI-OUTPUT-SPEC
      expect(output).toHaveProperty('output', 'Hello World');
    });

    it('validates prompt with special characters', () => {
      // Use array form to preserve content with spaces as single argument
      const result = runCli(['prompt', 'Test with spaces and chars', '--json'], workspace);
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

  describe('run --json', () => {
    it('validates run command NDJSON completion output', () => {
      const runbookPath = path.join(workspace.cwd, 'simple.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: simple-test
---
## Step 1
echo hello
`);

      const result = runCli('run --json simple.runbook.md', workspace);
      const events = parseNdjsonOutput(result.stdout);

      // Run command now streams NDJSON events
      expect(events.length).toBeGreaterThan(0);

      // Should have runbook_started event
      const startedEvent = findEventByType(events, 'runbook_started');
      expect(startedEvent).toBeDefined();
      if (startedEvent) {
        const event = startedEvent;
        expect(event).toHaveProperty('prompted');
        expect(event).toHaveProperty('statePath');
      }

      // Should have runbook_completed event for successful run
      const completedEvent = findEventByType(events, 'runbook_completed');
      expect(completedEvent).toBeDefined();
      if (completedEvent) {
        const event = completedEvent;
        expect(event).toHaveProperty('finalPosition');
      }
    });

    it('validates run command with prompted runbook NDJSON output', () => {
      const runbookPath = path.join(workspace.cwd, 'prompted.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: prompted-test
---
## Step 1
prompt: Wait for user
`);

      const result = runCli('run --json --prompted prompted.runbook.md', workspace);
      const events = parseNdjsonOutput(result.stdout);

      // Run command with prompted flag streams NDJSON events
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
  // Run --step Command
  // ==========================================================================

  describe('run --step --json', () => {
    it('validates step queued output', () => {
      const runbookPath = path.join(workspace.cwd, 'step-test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: step-test
---
## Step 1
prompt: Wait for agent
`);
      runCli('run --prompted step-test.runbook.md', workspace);

      const result = runCli('run --step 1 --json', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateStepQueuedOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify structure
      expect(output).toHaveProperty('action', 'step_queued');
      expect(output).toHaveProperty('stepId', '1');
    });

    it('validates step queued error when no active runbook', () => {
      const result = runCli('run --step 1 --json', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateErrorOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify error structure
      expect(output).toHaveProperty('result', false);
      expect(output).toHaveProperty('error');
      expect(output).toHaveProperty('code', 'NO_ACTIVE_RUNBOOK');
    });
  });

  // ==========================================================================
  // Run --agent Command
  // ==========================================================================

  describe('run --agent --json', () => {
    it('validates agent bound output', () => {
      const runbookPath = path.join(workspace.cwd, 'agent-test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: agent-test
---
## Step 1
prompt: Wait for agent
`);
      runCli('run --prompted agent-test.runbook.md', workspace);
      runCli('run --step 1', workspace);

      const result = runCli('run --agent test-agent --json', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateAgentBoundOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify structure
      expect(output).toHaveProperty('action', 'agent_bound');
      expect(output).toHaveProperty('agent', 'test-agent');
      expect(output).toHaveProperty('stepId', '1');
    });

    it('validates agent bound error when no active runbook', () => {
      const result = runCli('run --agent test-agent --json', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateErrorOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify error structure
      expect(output).toHaveProperty('result', false);
      expect(output).toHaveProperty('error');
      expect(output).toHaveProperty('code', 'NO_ACTIVE_RUNBOOK');
    });

    it('validates agent bound error when no pending step', () => {
      const runbookPath = path.join(workspace.cwd, 'no-pending.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: no-pending
---
## Step 1
prompt: Wait
`);
      runCli('run --prompted no-pending.runbook.md', workspace);

      // Try to bind agent without first queuing a step
      const result = runCli('run --agent test-agent --json', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateErrorOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Verify error structure
      expect(output).toHaveProperty('result', false);
      expect(output).toHaveProperty('error');
      expect(output).toHaveProperty('code', 'AGENT_BINDING_ERROR');
    });
  });

  // ==========================================================================
  // Scenario Run Command
  // ==========================================================================

  describe('scenario run --json', () => {
    it('validates scenario run success output', () => {
      const runbookPath = path.join(workspace.cwd, 'test-scenarios.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: scenario-test
scenarios:
  simple:
    result: COMPLETE
    commands:
      - echo "test"
---
## Step 1
echo hello
`);

      const result = runCli(`scenario run ${runbookPath} simple --json`, workspace);
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

  describe('stop --json', () => {
    it('validates stop command output', () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
---
## Step 1
prompt: Wait
`);
      runCli('run --prompted test.runbook.md', workspace);

      const result = runCli('stop --json', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateActionOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Per CLI-OUTPUT-SPEC: action='stop' (command name), result=false (stop = failure to continue)
      expect(output).toHaveProperty('action', 'stop');
      expect(output).toHaveProperty('result', false);
      // Explicit type check: result must be boolean, not string
      expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
    });
  });

  describe('complete --json', () => {
    it('validates complete command output', () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
---
## Step 1
prompt: Wait
`);
      runCli('run --prompted test.runbook.md', workspace);

      const result = runCli('complete --json', workspace);
      const output = parseJsonOutput(result.stdout);

      const validation = validateActionOutput(output);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      // Current format: action='complete', result=true (complete = success)
      expect(output).toHaveProperty('action', 'complete');
      expect(output).toHaveProperty('result', true);
      // Explicit type check: result must be boolean, not string
      expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
    });
  });

  // ==========================================================================
  // Error Response Validation
  // ==========================================================================

  describe('error responses', () => {
    it('validates no active runbook error format', () => {
      const result = runCli('pass --json', workspace);
      const output = parseJsonOutput(result.stdout);

      // Verify error structure
      expect(output).toHaveProperty('result', false);
      // Explicit type check: result must be boolean, not string
      expect(typeof (output as Record<string, unknown>).result).toBe('boolean');
      // The error message varies by command
      expect(typeof (output as { error?: string }).error === 'string' ||
             typeof (output as { message?: string }).message === 'string').toBe(true);
    });
  });

  // ==========================================================================
  // Exit Code Verification
  // ==========================================================================

  describe('exit codes', () => {
    it('returns 0 for successful commands', () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `## Step 1
echo hello
`);

      const result = runCli(`check ${runbookPath} --json`, workspace);
      expect(result.exitCode).toBe(0);
    });

    it('returns non-zero for validation errors', () => {
      const runbookPath = path.join(workspace.cwd, 'invalid.runbook.md');
      fs.writeFileSync(runbookPath, `## Step 1
- PASS: GOTO 99
echo hello
`);

      const result = runCli(`check ${runbookPath} --json`, workspace);
      expect(result.exitCode).toBe(1);
    });

    it('returns 0 for JSON mode even when result is false', () => {
      // ls with no runbooks still exits 0 (empty list is valid)
      const result = runCli('ls --json', workspace);
      expect(result.exitCode).toBe(0);
    });
  });
});
