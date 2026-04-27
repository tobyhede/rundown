// packages/cli/__tests__/integration/frontmatter-outputs.test.ts

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

/**
 * Runbook that auto-passes and completes; has a naked-form frontmatter OUTPUTS
 * declaration. SomeVar is expected to be passed via --input.
 */
const NAKED_FORM_RUNBOOK = `---
name: fm-naked-test
outputs:
  - SomeVar
---
# Frontmatter Naked Output Test

## 1. Complete
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`
`;

describe('frontmatter outputs — naked form', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'test.runbook.md'), NAKED_FORM_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('stores naked-form frontmatter output to state.finalVars on successful run', async () => {
    const result = runCli('run test.runbook.md --input SomeVar=hello', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as { finalVars?: Record<string, unknown> };
    expect(state.finalVars).toEqual({ SomeVar: 'hello' });
  });

  it('stores frontmatter outputs when run stops on FAIL', async () => {
    const FAIL_RUNBOOK = `---
name: fm-fail-test
outputs:
  - SomeVar
---
# Frontmatter Fail Test

## 1. Fail
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
rd echo --result fail
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'fail.runbook.md'), FAIL_RUNBOOK);

    const result = runCli('run fail.runbook.md --input SomeVar=hello', workspace);
    expect(result.exitCode).not.toBe(0);

    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { finalVars?: Record<string, unknown> };
    expect(state.finalVars).toEqual({ SomeVar: 'hello' });
  });
});

describe('frontmatter outputs — with-value (quoted literal) form', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('stores with-value quoted-literal form to state.finalVars on completion', async () => {
    const LITERAL_RUNBOOK = `---
name: fm-literal-test
outputs:
  - OutVar "literal-value"
---
# Frontmatter Literal-Value Test

## 1. Complete
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'literal.runbook.md'), LITERAL_RUNBOOK);

    const result = runCli('run literal.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { finalVars?: Record<string, unknown> };
    expect(state.finalVars).toEqual({ OutVar: 'literal-value' });
  });
});

describe('frontmatter outputs — case-insensitive OUTPUTS: key', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('OUTPUTS: (uppercase) key in frontmatter stores identically to outputs:', async () => {
    const UPPERCASE_RUNBOOK = `---
name: fm-uppercase-test
OUTPUTS:
  - SomeVar
---
# Frontmatter Uppercase Key Test

## 1. Complete
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'uppercase.runbook.md'), UPPERCASE_RUNBOOK);

    const result = runCli('run uppercase.runbook.md --input SomeVar=hello-upper', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { finalVars?: Record<string, unknown> };
    expect(state.finalVars).toEqual({ SomeVar: 'hello-upper' });
  });
});

describe('frontmatter outputs — prompted (manual pass) completion', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('stores frontmatter outputs when run completes via rd pass', async () => {
    const PROMPTED_RUNBOOK = `---
name: fm-prompted-test
outputs:
  - SomeVar
---
# Frontmatter Prompted Test

## 1. Complete
- PASS COMPLETE
- FAIL STOP

Waiting for manual pass.
`;
    await writeFile(join(workspace.cwd, 'prompted.runbook.md'), PROMPTED_RUNBOOK);

    // Start the runbook — execution pauses (no command block).
    const startResult = runCli('run prompted.runbook.md --input SomeVar=manual-value', workspace);
    expect(startResult.exitCode).toBe(0);

    // Verify runbook is paused/waiting before issuing pass.
    const statusResult = runCli('status', workspace);
    expect(statusResult.exitCode).toBe(0);
    const statusEvents = parseJsonOutput(statusResult.stdout);
    const statusOutput = statusEvents[0] as { active?: boolean };
    expect(statusOutput.active).toBe(true);

    // Manually pass to complete — this goes through the transitions.ts path.
    const passResult = runCli('pass', workspace);
    expect(passResult.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    const state = states[0] as { finalVars?: Record<string, unknown> };
    expect(state.finalVars).toEqual({ SomeVar: 'manual-value' });
  });
});

describe('frontmatter outputs — rd status includes vars field', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('rd status --json includes vars with template variables while runbook is active', async () => {
    const RUNBOOK = `---
name: fm-status-vars-test
inputs:
  - environment
---
# Status Vars Test

## 1. Step one
Waiting for manual pass.
`;
    await writeFile(join(workspace.cwd, 'status-vars.runbook.md'), RUNBOOK);

    // Start runbook — pauses at step 1 (no command block).
    const startResult = runCli('run status-vars.runbook.md --input environment=staging', workspace);
    expect(startResult.exitCode).toBe(0);

    // Check that rd status includes vars field with resolved inputs.
    const statusResult = runCli('status', workspace);
    expect(statusResult.exitCode).toBe(0);

    const events = parseJsonOutput(statusResult.stdout);
    const statusOutput = events[0];
    expect(statusOutput).toBeDefined();
    expect(statusOutput.vars).toBeDefined();
    expect((statusOutput.vars as Record<string, string>).environment).toBe('staging');

    // Cleanup: pass to complete the runbook.
    runCli('pass', workspace);
  });
});

describe('frontmatter outputs — delegation chain', () => {
  let workspace: TestWorkspace;

  /**
   * Parent runbook: auto-passes via rd echo, has frontmatter outputs: [Message].
   * Message is expected to be passed via --input and stored to finalVars on completion.
   */
  const PARENT_RUNBOOK = `---
name: fm-chain-parent
outputs:
  - Message
---
# Chain Parent

## 1. Complete
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`
`;

  /**
   * Child runbook: uses {{Message}} in step prompt.
   * Caller injects --input Message=value (simulating what delegation-dispatch plugin does).
   */
  const CHILD_RUNBOOK = `---
name: fm-chain-child
---
# Chain Child

## 1. Receive message
- PASS COMPLETE
- FAIL STOP

Received: {{Message}}
`;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), PARENT_RUNBOOK);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('parent frontmatter outputs are stored to state.finalVars on completion', async () => {
    const parentResult = runCli(
      'run parent.runbook.md --input Message=hello-from-parent',
      workspace,
    );
    expect(parentResult.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    const parentState = states[0] as { finalVars?: Record<string, unknown> };
    expect(parentState.finalVars).toEqual({ Message: 'hello-from-parent' });
  });

  it('child receives Message via --input injection (simulating delegation-dispatch plugin)', async () => {
    // Simulate the plugin reading parent finalVars and injecting as --input flags.
    const childResult = runCli('run child.runbook.md --input Message=hello-from-parent', workspace);
    expect(childResult.exitCode).toBe(0);

    // Step_entered event should have {{Message}} substituted.
    const events = parseJsonOutput(childResult.stdout);
    const stepEntered = events.find((e) => e.type === 'step_entered');
    expect(stepEntered).toBeDefined();
    expect(stepEntered?.prompt).toContain('hello-from-parent');
    expect(stepEntered?.prompt).not.toContain('{{Message}}');
  });
});

describe('frontmatter outputs — references final-step OUTPUTS via manual pass', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('frontmatter outputs see variables written by the final step OUTPUTS', async () => {
    const RUNBOOK = `---
name: fm-refs-final-step-outputs
outputs:
  - Final {{BuiltVar}}
---
# Final-Step OUTPUTS Test

## 1. Produce then complete
- OUTPUTS
  - BuiltVar "step-value"
- PASS COMPLETE
- FAIL STOP

Waiting for manual pass.
`;
    await writeFile(join(workspace.cwd, 'final-step.runbook.md'), RUNBOOK);

    // Start — pauses at step 1 (no command block, prose only).
    const startResult = runCli('run final-step.runbook.md', workspace);
    expect(startResult.exitCode).toBe(0);

    // Manual pass drives the transitions.ts path. Step OUTPUTS writes BuiltVar
    // during the transition; frontmatter outputs must then see it when computing
    // finalVars at completion.
    const passResult = runCli('pass', workspace);
    expect(passResult.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    const state = states[0] as {
      variables?: Record<string, unknown>;
      finalVars?: Record<string, unknown>;
    };
    expect(state.variables?.BuiltVar).toBe('step-value');
    expect(state.finalVars).toEqual({ Final: 'step-value' });
  });
});
