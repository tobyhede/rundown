/**
 * Integration tests for delegation from H3 substeps defined as runbook lists.
 *
 * Tests the form:
 * ```markdown
 * ### 1.1 Child task
 * - DELEGATE
 * - child.runbook.md
 * ```
 *
 * Where the substep body IS the runbook reference — no prose. Delegation
 * can then infer the runbook path from the DELEGATE substep's `runbooks` field.
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
- DELEGATE
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
- DELEGATE
- child1.runbook.md

### 1.2 Second task
- DELEGATE
- child2.runbook.md
`,
    );
  }

  function extractTokens(stdout: string): string[] {
    return [...stdout.matchAll(/"token":\s*"(rdtk_[^"]+)"/g)].map((match) => match[1]);
  }

  it('auto-issues a token for a DELEGATE H3 runbook-list substep', async () => {
    await writeChildRunbook();
    await writeParentSingle();

    const result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const tokens = extractTokens(result.stdout);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].startsWith('rdtk_')).toBe(true);
  });

  it('rejects manual delegation after the DELEGATE substep has already auto-issued', async () => {
    await writeChildRunbook();
    await writeParentSingle();

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('delegate --step 1.1', workspace);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/active delegation exists|already/i);

    result = runCli('delegate', workspace);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/RD-813|no delegatable substep/i);
  });

  it('completes parent after auto-issue → claim for single H3 runbook-list substep', async () => {
    await writeChildRunbook();
    await writeParentSingle();

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const [token] = extractTokens(result.stdout);
    expect(token).toBeDefined();

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

    const [token1, token2] = extractTokens(result.stdout);
    expect(token1).toBeDefined();
    expect(token2).toBeDefined();

    // Child1 auto-executes rd echo and completes; propagates pass to parent substep 1.1
    result = runCli(`claim ${token1}`, workspace);
    expect(result.exitCode).toBe(0);

    result = runCli(`claim ${token2}`, workspace);
    expect(result.exitCode).toBe(0);
  });

  it('rejects explicit runbook override after auto-issue has already minted the token', async () => {
    await writeChildRunbook();
    await writeChildRunbook('explicit-child.runbook.md');
    await writeParentSingle();

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('delegate explicit-child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/active delegation exists|already/i);
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
- DELEGATE
- child.runbook.md
`,
    );

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    // Step 1.1 is prose — pass it directly
    result = runCli('pass --step 1.1', workspace);
    expect(result.exitCode).toBe(0);

    const [token] = extractTokens(result.stdout);
    expect(token).toBeDefined();

    result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
  });
});
