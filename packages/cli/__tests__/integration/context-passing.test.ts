// packages/cli/__tests__/integration/context-passing.test.ts

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestWorkspace, runCli, type TestWorkspace } from '../helpers/test-utils.js';

/**
 * Parse JSON output from CLI commands, handling both:
 * - Compact JSONL (one JSON object per line) from streaming execution events
 * - Pretty-printed single JSON object (from flushed summary when no JSONL events were emitted)
 *
 * The `pass` command on the final step that completes a runbook outputs a pretty-printed
 * JSON object (since no streaming events are emitted, isJsonlMode stays false). We fall
 * back to parsing the entire stdout as a single JSON object in that case.
 */
function parseJsonOutput(stdout: string): Record<string, unknown>[] {
  // Try compact JSONL: parse each line starting with `{`
  const results: Record<string, unknown>[] = [];
  for (const line of stdout.trim().split('\n')) {
    if (line.startsWith('{')) {
      try {
        results.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Skip lines that fail (e.g., opening `{` of a pretty-printed multi-line object)
      }
    }
  }
  // Fall back to parsing entire stdout as a single JSON object (pretty-printed case)
  if (results.length === 0) {
    try {
      const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
      results.push(obj);
    } catch {
      // Not valid JSON at all
    }
  }
  return results;
}

/**
 * Two-step runbook: step 1 produces OUTPUTS, step 2 declares INPUTS.
 * Step 1 description includes nothing special.
 * Step 2 description includes {{Message}} so we can verify substitution.
 */
const CONTEXT_PASSING_RUNBOOK = `---
name: context-passing-test
---
# Context Passing Test

## 1. Produce output
- PASS CONTINUE
- FAIL CONTINUE
- OUTPUTS
  - Message "hello from step 1"

## 2. Consume input
- PASS COMPLETE
- FAIL STOP
- INPUTS
  - Message

The message is: {{Message}}
`;

describe('OUTPUTS→INPUTS round-trip', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'test.runbook.md'), CONTEXT_PASSING_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('step 1 PASS stores OUTPUTS; step 2 INPUTS injected into templateVars → description substituted', async () => {
    const contextId = 'testctx-pass';

    // Start runbook (prompted mode)
    const start = runCli(
      `run --prompted test.runbook.md --var ContextId=${contextId} --json`,
      workspace,
    );
    expect(start.exitCode).toBe(0);

    // Pass step 1 — triggers storeContextOutputs with { Message: "hello from step 1" }
    const pass1 = runCli('pass --json', workspace);
    expect(pass1.exitCode).toBe(0);

    // Parse events from the pass1 response — should include STEP_ENTERED for step 2
    const events1 = parseJsonOutput(pass1.stdout);
    const step2Entered = events1.find((e) => e.type === 'step_entered' && e.position != null);

    // Step 2's prompt (prose body) should have {{Message}} substituted with "hello from step 1"
    expect(step2Entered).toBeDefined();
    expect(step2Entered?.prompt).toContain('hello from step 1');
    expect(step2Entered?.prompt).not.toContain('{{Message}}');

    // Pass step 2 — should COMPLETE
    const pass2 = runCli('pass --json', workspace);
    expect(pass2.exitCode).toBe(0);

    const events2 = parseJsonOutput(pass2.stdout);
    const completed = events2.find((e) => e.complete === true);
    expect(completed).toBeDefined();
  });

  it('step 1 FAIL does not store OUTPUTS; step 2 INPUTS missing → {{Message}} renders literally', async () => {
    const contextId = 'testctx-fail';

    // Start runbook (prompted mode)
    const start = runCli(
      `run --prompted test.runbook.md --var ContextId=${contextId} --json`,
      workspace,
    );
    expect(start.exitCode).toBe(0);

    // Fail step 1 — FAIL CONTINUE, so execution continues; no outputs stored
    const fail1 = runCli('fail --json', workspace);
    expect(fail1.exitCode).toBe(0);

    // Parse events — step 2 STEP_ENTERED should show {{Message}} literally
    const events1 = parseJsonOutput(fail1.stdout);
    const step2Entered = events1.find((e) => e.type === 'step_entered' && e.position != null);

    expect(step2Entered).toBeDefined();
    // Missing input renders literally — not substituted
    expect(step2Entered?.prompt).toContain('{{Message}}');
    expect(step2Entered?.prompt).not.toContain('hello from step 1');

    // Pass step 2 — still completes (missing inputs are not errors)
    const pass2 = runCli('pass --json', workspace);
    expect(pass2.exitCode).toBe(0);

    const events2 = parseJsonOutput(pass2.stdout);
    const completed = events2.find((e) => e.complete === true);
    expect(completed).toBeDefined();
  });

  it('verifies context outputs file is written with correct content after step 1 PASS', async () => {
    const contextId = 'testctx-file';

    const start = runCli(
      `run --prompted test.runbook.md --var ContextId=${contextId} --json`,
      workspace,
    );
    expect(start.exitCode).toBe(0);

    // Pass step 1
    const pass1 = runCli('pass --json', workspace);
    expect(pass1.exitCode).toBe(0);

    // Read context outputs file directly
    const outputsPath = join(workspace.cwd, '.rundown', 'contexts', contextId, 'outputs.json');
    const raw = await readFile(outputsPath, 'utf-8');
    const outputs = JSON.parse(raw) as Record<string, unknown>;

    expect(outputs).toEqual({ Message: 'hello from step 1' });
  });
});
