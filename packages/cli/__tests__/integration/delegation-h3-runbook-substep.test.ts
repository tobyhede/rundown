/**
 * Integration tests for delegation from H3 substeps defined as runbook lists.
 *
 * Tests the form:
 * ```markdown
 * ### 1.1 Child task
 * - child.runbook.md
 * ```
 *
 * Where the substep body IS the runbook reference — no prose. Delegation
 * can then infer the runbook path from the substep's `runbooks` field.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli, type TestWorkspace } from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('H3 runbook-list substep delegation integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Simple auto-completing child runbook. */
  async function writeChildRunbook(name = 'child.runbook.md'): Promise<void> {
    await writeFile(
      join(workspace.cwd, name),
      `## 1. Execute
- PASS COMPLETE

\`\`\`bash
rd echo "child completed"
\`\`\`
`,
    );
  }

  /** Parent runbook: aggregating step with one H3 runbook-list substep (no prose). */
  async function writeParentSingle(): Promise<void> {
    await writeFile(
      join(workspace.cwd, 'parent.runbook.md'),
      `## 1. Execute workflow
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task
- child.runbook.md
`,
    );
  }

  /** Parent runbook: aggregating step with two H3 runbook-list substeps. */
  async function writeParentTwo(): Promise<void> {
    await writeFile(
      join(workspace.cwd, 'parent.runbook.md'),
      `## 1. Execute workflow
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First task
- child1.runbook.md

### 1.2 Second task
- child2.runbook.md
`,
    );
  }

  it('delegates substep using runbook inferred from H3 runbook list (--step only)', async () => {
    await writeChildRunbook();
    await writeParentSingle();

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    // Provide --step but omit runbook path — inferred from substep.runbooks[0]
    result = runCli('delegate --step 1.1', workspace);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).action).toBe('delegated');

    const tokenMatch = /"token":\s*"(rdtk_[^"]+)"/.exec(result.stdout);
    expect(tokenMatch).not.toBeNull();
  });

  it('delegates substep using fully inferred step and runbook (no args)', async () => {
    await writeChildRunbook();
    await writeParentSingle();

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    // No args — infers step (1.1) and runbook (child.runbook.md) from state
    result = runCli('delegate', workspace);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).action).toBe('delegated');

    const tokenMatch = /"token":\s*"(rdtk_[^"]+)"/.exec(result.stdout);
    expect(tokenMatch).not.toBeNull();
  });

  it('completes parent after delegate → claim for single H3 runbook-list substep', async () => {
    await writeChildRunbook();
    await writeParentSingle();

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('delegate', workspace);
    expect(result.exitCode).toBe(0);

    const tokenMatch = /"token":\s*"(rdtk_[^"]+)"/.exec(result.stdout);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1];

    result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
  });

  it('sequential delegation of two H3 runbook-list substeps completes parent', async () => {
    await writeChildRunbook('child1.runbook.md');
    await writeChildRunbook('child2.runbook.md');
    await writeParentTwo();

    // Run WITHOUT --prompted so children also run without --prompted and auto-complete
    let result = runCli('run parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    // Delegate first substep (inferred → child1.runbook.md)
    result = runCli('delegate', workspace);
    expect(result.exitCode).toBe(0);
    const token1Match = /"token":\s*"(rdtk_[^"]+)"/.exec(result.stdout);
    expect(token1Match).not.toBeNull();
    const token1 = token1Match![1];

    // Child1 auto-executes rd echo and completes; propagates pass to parent substep 1.1
    result = runCli(`claim ${token1}`, workspace);
    expect(result.exitCode).toBe(0);

    // Delegate second substep (inferred → child2.runbook.md); parent is now active again
    result = runCli('delegate', workspace);
    expect(result.exitCode).toBe(0);
    const token2Match = /"token":\s*"(rdtk_[^"]+)"/.exec(result.stdout);
    expect(token2Match).not.toBeNull();
    const token2 = token2Match![1];

    result = runCli(`claim ${token2}`, workspace);
    expect(result.exitCode).toBe(0);
  });

  it('delegate --step 1.1 with explicit runbook overrides inferred runbook', async () => {
    await writeChildRunbook();
    await writeChildRunbook('explicit-child.runbook.md');
    await writeParentSingle();

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    // Pass explicit runbook path even though substep has one — explicit wins
    result = runCli('delegate explicit-child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).action).toBe('delegated');

    const tokenMatch = /"token":\s*"(rdtk_[^"]+)"/.exec(result.stdout);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1];

    result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
  });

  it('mixed H3 substeps: prose substep passed manually, runbook substep delegated', async () => {
    await writeChildRunbook();
    await writeFile(
      join(workspace.cwd, 'parent.runbook.md'),
      `## 1. Execute workflow
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Manual step
Do some manual work here.

### 1.2 Automated step
- child.runbook.md
`,
    );

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    // Step 1.1 is prose — pass it directly
    result = runCli('pass --step 1.1', workspace);
    expect(result.exitCode).toBe(0);

    // Step 1.2 is runbook list — delegate and claim
    result = runCli('delegate', workspace);
    expect(result.exitCode).toBe(0);
    const tokenMatch = /"token":\s*"(rdtk_[^"]+)"/.exec(result.stdout);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1];

    result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
  });
});
