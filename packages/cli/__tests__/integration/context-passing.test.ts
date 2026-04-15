// packages/cli/__tests__/integration/context-passing.test.ts

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
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

describe('substep INPUTS/OUTPUTS round-trip', () => {
  let workspace: TestWorkspace;

  const SUBSTEP_CONTEXT_RUNBOOK = `---
name: substep-context-test
---
# Substep Context Test

## 1. Parent step
- PASS CONTINUE
- FAIL STOP
- INPUTS
  - PlanPath
- OUTPUTS
  - ParentValue "parent-complete"

### 1.fetch Produce child output
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - ChildValue "substep-fetch"

Plan path: {{PlanPath}}

### 1.use Consume child output
- PASS CONTINUE
- FAIL STOP
- INPUTS
  - ChildValue

Child value: {{ChildValue}}

## 2. Consume parent output
- PASS COMPLETE
- FAIL STOP
- INPUTS
  - ParentValue

Parent value: {{ParentValue}}
`;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'substep-context.runbook.md'), SUBSTEP_CONTEXT_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('inherits parent inputs into substeps and publishes substep then parent outputs', async () => {
    const contextId = 'substep-roundtrip';
    const contextDir = join(workspace.cwd, '.rundown', 'contexts', contextId);
    await mkdir(contextDir, { recursive: true });
    await writeFile(
      join(contextDir, 'outputs.json'),
      JSON.stringify({ PlanPath: '/seeded/path/plan.json' }),
      'utf-8',
    );

    const start = runCli(
      `run --prompted substep-context.runbook.md --var ContextId=${contextId} --json`,
      workspace,
    );
    expect(start.exitCode).toBe(0);

    const startEvents = parseJsonOutput(start.stdout);
    const fetchEntered = startEvents.find(
      (e) => e.type === 'step_entered' && e.stepName === 'fetch',
    );
    expect(fetchEntered).toBeDefined();
    expect(fetchEntered?.prompt).toContain('/seeded/path/plan.json');
    expect(fetchEntered?.prompt).not.toContain('{{PlanPath}}');

    const passFetch = runCli('pass --json', workspace);
    expect(passFetch.exitCode).toBe(0);

    const afterFetchRaw = await readFile(join(contextDir, 'outputs.json'), 'utf-8');
    const afterFetch = JSON.parse(afterFetchRaw) as Record<string, unknown>;
    expect(afterFetch).toEqual({
      PlanPath: '/seeded/path/plan.json',
      ChildValue: 'substep-fetch',
    });

    const fetchEvents = parseJsonOutput(passFetch.stdout);
    const useEntered = fetchEvents.find((e) => e.type === 'step_entered' && e.stepName === 'use');
    expect(useEntered).toBeDefined();
    expect(useEntered?.prompt).toContain('substep-fetch');
    expect(useEntered?.prompt).not.toContain('{{ChildValue}}');

    const passUse = runCli('pass --json', workspace);
    expect(passUse.exitCode).toBe(0);

    const afterUseRaw = await readFile(join(contextDir, 'outputs.json'), 'utf-8');
    const afterUse = JSON.parse(afterUseRaw) as Record<string, unknown>;
    expect(afterUse).toEqual({
      PlanPath: '/seeded/path/plan.json',
      ChildValue: 'substep-fetch',
      ParentValue: 'parent-complete',
    });

    const useEvents = parseJsonOutput(passUse.stdout);
    const step2Entered = useEvents.find(
      (e) => e.type === 'step_entered' && (e.position as { current?: string }).current === '2',
    );
    expect(step2Entered).toBeDefined();
    expect(step2Entered?.prompt).toContain('parent-complete');
    expect(step2Entered?.prompt).not.toContain('{{ParentValue}}');
  });
});

describe('OUTPUTS→INPUTS via auto-execution (no --prompted)', () => {
  let workspace: TestWorkspace;

  const AUTO_EXEC_RUNBOOK = `---
name: auto-exec-context-test
---
# Auto Exec Context Test

## 1. Produce output
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - Message "hello-auto"

\`\`\`sh
rd echo --result pass
\`\`\`

## 2. Consume input
- PASS COMPLETE
- FAIL STOP
- INPUTS
  - Message

The message is: {{Message}}
`;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'auto-exec.runbook.md'), AUTO_EXEC_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('auto-executed step 1 stores OUTPUTS; step 2 INPUTS injected into description', async () => {
    const contextId = 'auto-exec-ctx';

    // Run without --prompted: step 1 auto-executes (rd echo --result pass)
    // Step 2 has no command, so execution pauses waiting for prompt
    const result = runCli(
      `run auto-exec.runbook.md --var ContextId=${contextId} --json`,
      workspace,
    );
    expect(result.exitCode).toBe(0);

    // Context outputs file should have been written by step 1's auto-execution
    const outputsPath = join(workspace.cwd, '.rundown', 'contexts', contextId, 'outputs.json');
    const raw = await readFile(outputsPath, 'utf-8');
    const outputs = JSON.parse(raw) as Record<string, unknown>;
    expect(outputs).toEqual({ Message: 'hello-auto' });

    // Step 2's STEP_ENTERED event should have {{Message}} substituted
    const events = parseJsonOutput(result.stdout);
    const step2Entered = events.find(
      (e) => e.type === 'step_entered' && (e.position as { current?: string }).current === '2',
    );
    expect(step2Entered).toBeDefined();
    expect(step2Entered?.prompt).toContain('hello-auto');
    expect(step2Entered?.prompt).not.toContain('{{Message}}');
  });

  it('auto-executed step 1 FAIL does NOT store OUTPUTS', async () => {
    const FAIL_RUNBOOK = `---
name: auto-fail-test
---
# Auto Fail Test

## 1. Produce output (fails)
- PASS CONTINUE
- FAIL CONTINUE
- OUTPUTS
  - Tag "should-not-appear"

\`\`\`sh
rd echo --result fail
\`\`\`

## 2. No command
- PASS COMPLETE
- FAIL STOP
- INPUTS
  - Tag

Value: {{Tag}}
`;
    await writeFile(join(workspace.cwd, 'auto-fail.runbook.md'), FAIL_RUNBOOK);

    const contextId = 'auto-fail-ctx';
    runCli(`run auto-fail.runbook.md --var ContextId=${contextId} --json`, workspace);

    // Context outputs file should NOT exist (no PASS → no OUTPUTS stored)
    const outputsPath = join(workspace.cwd, '.rundown', 'contexts', contextId, 'outputs.json');
    await expect(readFile(outputsPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('INPUTS injection precedence and fault tolerance', () => {
  let workspace: TestWorkspace;

  const INPUTS_RUNBOOK = `---
name: inputs-precedence-test
---
# Inputs Precedence Test

## 1. Consume input
- PASS COMPLETE
- FAIL STOP
- INPUTS
  - Message

Value: {{Message}}
`;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'inputs.runbook.md'), INPUTS_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('CLI --var wins over context outputs for same-name INPUTS var', async () => {
    const contextId = 'precedence-ctx';
    // Seed context outputs with a value that must NOT override CLI flag
    const outputsDir = join(workspace.cwd, '.rundown', 'contexts', contextId);
    await mkdir(outputsDir, { recursive: true });
    await writeFile(
      join(outputsDir, 'outputs.json'),
      JSON.stringify({ Message: 'from-context' }),
      'utf-8',
    );

    // CLI flag provides Message=from-cli — higher precedence than context outputs
    const result = runCli(
      `run --prompted inputs.runbook.md --var ContextId=${contextId} --var Message=from-cli --json`,
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const events = parseJsonOutput(result.stdout);
    const stepEntered = events.find((e) => e.type === 'step_entered');
    expect(stepEntered).toBeDefined();
    // CLI-provided value wins; context value is ignored for that key
    expect(stepEntered?.prompt).toContain('from-cli');
    expect(stepEntered?.prompt).not.toContain('from-context');
  });

  it('malformed outputs.json does not abort the run; INPUTS skipped with literal fallback', async () => {
    const contextId = 'malformed-ctx';
    const outputsDir = join(workspace.cwd, '.rundown', 'contexts', contextId);
    await mkdir(outputsDir, { recursive: true });
    // Write invalid JSON — loadContextOutputs will throw during parse
    await writeFile(join(outputsDir, 'outputs.json'), '{not valid json', 'utf-8');

    const result = runCli(
      `run --prompted inputs.runbook.md --var ContextId=${contextId} --json`,
      workspace,
    );
    // Run should start successfully; step 1 renders with {{Message}} as literal
    expect(result.exitCode).toBe(0);

    const events = parseJsonOutput(result.stdout);
    const stepEntered = events.find((e) => e.type === 'step_entered');
    expect(stepEntered).toBeDefined();
    expect(stepEntered?.prompt).toContain('{{Message}}');
  });
});

describe('OUTPUTS expression evaluation — per-step runtime frame', () => {
  let workspace: TestWorkspace;

  // Runbook where step 1's OUTPUTS references {{Step}} — a per-step runtime
  // variable that must be available when the OUTPUTS expression is evaluated.
  const STEP_FRAME_RUNBOOK = `---
name: step-frame-test
---
# Step frame test

## 1. Produce output
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - Tag {{ Step }}
  - At {{ context.current.step }}

\`\`\`sh
rd echo --result pass
\`\`\`

## 2. Sink
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`
`;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'step-frame.runbook.md'), STEP_FRAME_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('OUTPUTS expression resolves {{Step}} using the per-step runtime frame', async () => {
    const contextId = 'step-frame-ctx';
    const result = runCli(
      `run step-frame.runbook.md --var ContextId=${contextId} --json`,
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const outputsPath = join(workspace.cwd, '.rundown', 'contexts', contextId, 'outputs.json');
    const raw = await readFile(outputsPath, 'utf-8');
    const outputs = JSON.parse(raw) as Record<string, unknown>;
    // Bug: {{ Step }} and {{ context.current.step }} won't resolve unless the
    // per-step runtime frame (Step, Index, context.current.*) is merged into the
    // templateVars passed to storeStepOutputs.
    expect(outputs).toEqual({ Tag: '1', At: '1' });
  });
});

describe('OUTPUTS scenario test (auto-execution via rd scenario run)', () => {
  let workspace: TestWorkspace;

  // Both steps auto-execute via rd echo so the scenario completes (result: COMPLETE).
  // Step 1 publishes OUTPUTS; step 2 reads INPUTS and uses {{Tag}} in its description.
  // The scenario runner uses an isolated tmpDir — we can't check the outputs file directly.
  // The COMPLETE terminal result proves both steps executed (OUTPUTS stored → INPUTS
  // injected → step 2 description substituted → step 2 PASS COMPLETE).
  const SCENARIO_RUNBOOK = `---
name: auto-outputs-scenario
scenarios:
  outputs-flow:
    description: Auto-executed OUTPUTS stored and INPUTS injected across steps
    commands:
      - rd run --var ContextId=scene-ctx auto-outputs-scenario.runbook.md
    result: COMPLETE
---
# Auto Outputs Scenario

## 1. Publish output
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - Tag "v1.0"

\`\`\`sh
rd echo --result pass
\`\`\`

## 2. Complete
- PASS COMPLETE
- FAIL STOP
- INPUTS
  - Tag

Release: {{Tag}}

\`\`\`sh
rd echo --result pass
\`\`\`
`;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'auto-outputs-scenario.runbook.md'), SCENARIO_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('scenario: auto-executed OUTPUTS→INPUTS pipeline completes successfully', async () => {
    const result = runCli('scenario run auto-outputs-scenario.runbook.md outputs-flow', workspace);
    // Exit 0 + COMPLETE terminal result proves both steps auto-executed.
    // OUTPUTS must be stored after step 1 for step 2's INPUTS injection to work
    // (missing INPUTS would not prevent COMPLETE here, but the pipeline is validated
    // by the standalone auto-execution integration tests above that check the file).
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS');
  });
});
