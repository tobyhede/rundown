// packages/cli/__tests__/integration/context-passing-outputs.test.ts

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  getAllRunbookStates,
  parseJsonOutput,
  type TestWorkspace,
} from '../helpers/test-utils.js';

const CONTEXT_PASSING_RUNBOOK = `---
name: context-passing-test
---
# Context Passing Test

## 1. Produce output
- PASS CONTINUE
- FAIL CONTINUE
- OUTPUTS
  - Message

\`\`\`sh
printf 'hello from step 1' > "$RD_OUTPUTS_Message"
\`\`\`

## 2. Consume input
- PASS COMPLETE
- FAIL STOP

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
    // Start runbook (prompted mode)
    const start = runCli('run test.runbook.md --allow-all', workspace);
    expect(start.exitCode).toBe(0);

    // Parse events from the run response — should include STEP_ENTERED for step 2
    const events1 = parseJsonOutput(start.stdout);
    const step2Entered = events1.find(
      (e) => e.type === 'step_entered' && (e.position as { current?: string }).current === '2',
    );

    // Step 2's prompt (prose body) should have {{Message}} substituted with "hello from step 1"
    expect(step2Entered).toBeDefined();
    expect(step2Entered?.prompt).toContain('hello from step 1');
    expect(step2Entered?.prompt).not.toContain('{{Message}}');

    // Pass step 2 — should COMPLETE
    const pass2 = runCli('pass', workspace);
    expect(pass2.exitCode).toBe(0);

    const events2 = parseJsonOutput(pass2.stdout);
    const completed = events2.find((e) => e.complete === true);
    expect(completed).toBeDefined();
  });

  it('step 1 FAIL stores OUTPUTS; step 2 prompt is substituted from state.variables', async () => {
    const FAIL_RUNBOOK = CONTEXT_PASSING_RUNBOOK.replace(
      'printf \'hello from step 1\' > "$RD_OUTPUTS_Message"',
      'printf \'hello from step 1\' > "$RD_OUTPUTS_Message"\nexit 1',
    );
    await writeFile(join(workspace.cwd, 'test.runbook.md'), FAIL_RUNBOOK);

    const fail1 = runCli('run test.runbook.md --allow-all', workspace);
    expect(fail1.exitCode).toBe(0);

    const events1 = parseJsonOutput(fail1.stdout);
    const step2Entered = events1.find(
      (e) => e.type === 'step_entered' && (e.position as { current?: string }).current === '2',
    );

    expect(step2Entered).toBeDefined();
    expect(step2Entered?.prompt).toContain('hello from step 1');
    expect(step2Entered?.prompt).not.toContain('{{Message}}');
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
  - Message

\`\`\`sh
printf 'hello-auto' > "$RD_OUTPUTS_Message"
\`\`\`

## 2. Consume input
- PASS COMPLETE
- FAIL STOP

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
    // Run without --prompted: step 1 auto-executes (rd echo --result pass)
    // Step 2 has no command, so execution pauses waiting for prompt
    const result = runCli('run auto-exec.runbook.md --allow-all', workspace);
    expect(result.exitCode).toBe(0);

    // OUTPUTS now go to state.variables (not outputs.json).
    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as { variables?: Record<string, unknown> };
    expect(state.variables?.Message).toBe('hello-auto');

    // Step 2's STEP_ENTERED event should have {{Message}} substituted
    const events = parseJsonOutput(result.stdout);
    const step2Entered = events.find(
      (e) => e.type === 'step_entered' && (e.position as { current?: string }).current === '2',
    );
    expect(step2Entered).toBeDefined();
    expect(step2Entered?.prompt).toContain('hello-auto');
    expect(step2Entered?.prompt).not.toContain('{{Message}}');
  });

  it('auto-executed step 1 FAIL still stores OUTPUTS', async () => {
    const FAIL_RUNBOOK = `---
name: auto-fail-test
---
# Auto Fail Test

## 1. Produce output (fails)
- PASS CONTINUE
- FAIL CONTINUE
- OUTPUTS
  - Tag

\`\`\`sh
printf 'should-appear-on-fail' > "$RD_OUTPUTS_Tag"
rd echo --result fail
\`\`\`

## 2. No command
- PASS COMPLETE
- FAIL STOP

Value: {{Tag}}
`;
    await writeFile(join(workspace.cwd, 'auto-fail.runbook.md'), FAIL_RUNBOOK);

    const result = runCli('run auto-fail.runbook.md --allow-all', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { variables?: Record<string, unknown> };
    expect(state.variables?.Tag).toBe('should-appear-on-fail');

    const events = parseJsonOutput(result.stdout);
    const step2Entered = events.find(
      (e) => e.type === 'step_entered' && (e.position as { current?: string }).current === '2',
    );
    expect(step2Entered?.prompt).toContain('should-appear-on-fail');
  });
});

describe('OUTPUTS capture — per-step rendered command frame', () => {
  let workspace: TestWorkspace;

  const STEP_FRAME_RUNBOOK = `---
name: step-frame-test
---
# Step frame test

## 1. Produce output
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - Tag
  - At

\`\`\`sh
printf '{{ Step }}' > "$RD_OUTPUTS_Tag"
printf '{{ context.current.step }}' > "$RD_OUTPUTS_At"
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

  it('OUTPUTS capture can use rendered {{Step}} values from the command frame', async () => {
    const result = runCli('run step-frame.runbook.md --allow-all', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as { variables?: Record<string, unknown> };
    expect(state.variables).toMatchObject({ Tag: 1, At: 1 });
  });
});

describe('frontmatter OUTPUTS path helper — ctx-scoped workspace path', () => {
  let workspace: TestWorkspace;

  const PATH_HELPER_RUNBOOK = `---
name: path-helper-test
outputs:
  - ArtifactPath {{ path "report.json" ctx=test123 }}
---
# Path Helper Test

## 1. Complete
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`
`;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'path-helper.runbook.md'), PATH_HELPER_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('resolves path helper to a ctx-scoped workspace path stored in state.finalVars', async () => {
    const result = runCli('run path-helper.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as { finalVars?: Record<string, unknown> };

    // Non-git workspaces: WorkPath = .rundown/work (no branch suffix)
    // ctx=test123 adds .rd-test123/ subdirectory; file gets YYYY-MM-DD prefix
    expect(state.finalVars?.ArtifactPath).toMatch(
      /^\.rundown\/work\/\.rd-test123\/\d{4}-\d{2}-\d{2}-report\.json$/,
    );
  });
});
