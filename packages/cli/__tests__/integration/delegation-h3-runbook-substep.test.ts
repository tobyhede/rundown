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
import {
  createTestWorkspace,
  parseCliJsonObject,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';
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

  function extractFirstToken(stdout: string): string {
    const tokenMatch = /"token":\s*"(rdtk_[^"]+)"/.exec(stdout);
    expect(tokenMatch).not.toBeNull();
    return tokenMatch![1];
  }

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

  /**
   * Parse CLI JSON event output and return tokens from delegate frontier entries.
   *
   * @param stdout - Raw stdout emitted by the CLI command.
   * @returns Delegation tokens found in `delegateFrontier` event entries.
   */
  function extractTokens(stdout: string): string[] {
    const tokens: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event: { delegateFrontier?: Array<{ token?: unknown }> };
      try {
        event = JSON.parse(line) as { delegateFrontier?: Array<{ token?: unknown }> };
      } catch {
        continue;
      }
      for (const entry of event.delegateFrontier ?? []) {
        if (typeof entry.token === 'string') tokens.push(entry.token);
      }
    }
    return tokens;
  }

  function parseJsonEvents(stdout: string): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          events.push(parsed as Record<string, unknown>);
        }
      } catch {
        continue;
      }
    }
    return events;
  }

  function findSubstepEntered(
    stdout: string,
    current: string,
    substep: string,
  ): Record<string, unknown> {
    const event = parseJsonEvents(stdout).find((candidate) => {
      const position = candidate.position as
        | { readonly current?: unknown; readonly substep?: unknown }
        | undefined;
      return (
        candidate.type === 'step_entered' &&
        position?.current === current &&
        position.substep === substep
      );
    });
    if (!event) {
      throw new Error(`No step_entered event for ${current}.${substep} in stdout:\n${stdout}`);
    }
    return event;
  }

  it('extracts delegate tokens from JSON event lines while ignoring diagnostics', () => {
    const stdout = [
      'diagnostic: command emitted before JSON events',
      JSON.stringify({
        delegateFrontier: [{ token: 'rdtk_one' }, { token: 42 }, { token: 'rdtk_two' }],
      }),
      JSON.stringify({ delegateFrontier: [{ token: null }] }),
      JSON.stringify({ event: 'unrelated' }),
    ].join('\n');

    expect(extractTokens(stdout)).toEqual(['rdtk_one', 'rdtk_two']);
  });

  it('does not start a runbook with an empty DELEGATE substep', async () => {
    await writeFile(
      join(workspace.cwd, 'invalid-empty-delegate.runbook.md'),
      `## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Empty delegate
- DELEGATE
- PASS CONTINUE
- FAIL STOP
`,
    );

    const result = runCli('run --prompted invalid-empty-delegate.runbook.md', workspace);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'DELEGATE requires a runbook reference.',
    );
  });

  it('does not start a runbook with a prompt-only DELEGATE substep', async () => {
    await writeFile(
      join(workspace.cwd, 'invalid-prompt-only-delegate.runbook.md'),
      `## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Prompt delegate
- DELEGATE
- PASS CONTINUE
- FAIL STOP

Review the deployment notes.
`,
    );

    const result = runCli('run --prompted invalid-prompt-only-delegate.runbook.md', workspace);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'DELEGATE requires a runbook reference.',
    );
  });

  it('does not infer a delegation target from an explicit runbook argument alone', async () => {
    await writeFile(
      join(workspace.cwd, 'parent-no-delegate-target.runbook.md'),
      `## 1. Parent

### 1.1 Manual work
- PASS CONTINUE
- FAIL STOP

Review the deployment notes.
`,
    );
    await writeFile(
      join(workspace.cwd, 'child.runbook.md'),
      `## 1. Child
Done.
`,
    );

    let result = runCli('run --prompted parent-no-delegate-target.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('delegate child.runbook.md', workspace);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('RD-813');
  });

  it('creates a delegate frontier for an H3 runbook-list substep', async () => {
    await writeChildRunbook();
    await writeParentSingle();

    const result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"delegateFrontier"');
    expect(result.stdout).toContain('"id":"1.1"');
    expect(result.stdout).toContain('"runbook":"child.runbook.md"');
    const tokens = extractTokens(result.stdout);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].startsWith('rdtk_')).toBe(true);
  });

  it('emits inlineLaunch for non-DELEGATE runbook refs', async () => {
    await writeChildRunbook();
    await writeFile(
      join(workspace.cwd, 'inline-parent.runbook.md'),
      `## 1. Execute workflow
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task
- child.runbook.md
`,
    );

    const result = runCli('run --prompted inline-parent.runbook.md', workspace);

    expect(result.exitCode).toBe(0);
    const event = findSubstepEntered(result.stdout, '1', '1');
    expect(event.description).toBe('Child task');
    expect(event.delegateFrontier).toBeUndefined();
    expect(event.inlineLaunch).toEqual(
      expect.objectContaining({
        childRunbookRef: expect.objectContaining({
          source: 'project',
          path: expect.stringMatching(/child\.runbook\.md$/),
        }),
        parentStep: '1',
        parentStepId: '1',
      }),
    );
  });

  it('emits delegateFrontier instead of inlineLaunch for DELEGATE runbook refs', async () => {
    await writeChildRunbook();
    await writeParentSingle();

    const result = runCli('run --prompted parent.runbook.md', workspace);

    expect(result.exitCode).toBe(0);
    const event = findSubstepEntered(result.stdout, '1', '1');
    expect(event.inlineLaunch).toBeUndefined();
    expect(event.delegateFrontier).toEqual([
      expect.objectContaining({
        id: '1.1',
        runbook: 'child.runbook.md',
        token: expect.stringMatching(/^rdtk_/),
      }),
    ]);
  });

  it('does not issue a duplicate manual delegation after frontier creation', async () => {
    await writeChildRunbook();
    await writeParentSingle();

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('delegate', workspace);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('RD-813');

    result = runCli('delegate --step 1.1', workspace);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/RD-804|active delegation exists|already/i);
    expect(result.stdout + result.stderr).not.toMatch(/rdtk_/);
  });

  it('completes parent after frontier token claim for single H3 runbook-list substep', async () => {
    await writeChildRunbook();
    await writeParentSingle();

    const result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const [token] = extractTokens(result.stdout);
    expect(token).toBeDefined();

    const claim = runCli(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
  });

  it('claims two H3 runbook-list delegate frontier entries', async () => {
    await writeChildRunbook('child1.runbook.md');
    await writeChildRunbook('child2.runbook.md');
    await writeParentTwo();

    // Run WITHOUT --prompted so children also run without --prompted and auto-complete
    let result = runCli('run parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const tokens = extractTokens(result.stdout);
    expect(tokens).toHaveLength(2);

    // Child1 auto-executes rd echo and completes; propagates pass to parent substep 1.1
    result = runCli(`claim ${tokens[0]}`, workspace);
    expect(result.exitCode).toBe(0);

    result = runCli(`claim ${tokens[1]}`, workspace);
    expect(result.exitCode).toBe(0);
  });

  it('rejects explicit runbook override after auto-issue without exposing the raw token', async () => {
    await writeChildRunbook();
    await writeChildRunbook('explicit-child.runbook.md');
    await writeParentSingle();

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('delegate explicit-child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).not.toBe(0);
    const envelope = parseCliJsonObject(result.stdout || result.stderr);
    expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-804' }));
    expect(JSON.stringify(envelope)).not.toMatch(/rdtk_/);
  });

  it('rejects explicit runbook delegation when a prose substep lacks DELEGATE', async () => {
    await writeChildRunbook();
    await writeChildRunbook('explicit-child.runbook.md');
    await writeFile(
      join(workspace.cwd, 'parent.runbook.md'),
      `## 1. Execute workflow

### 1.1 Manual step
- PASS CONTINUE
- FAIL STOP

Do some manual work here.
`,
    );

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('delegate explicit-child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).not.toBe(0);
    const envelope = parseCliJsonObject(result.stdout || result.stderr);
    expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-813' }));
    expect(JSON.stringify(envelope)).not.toMatch(/rdtk_/);
  });

  it('explicit runbook delegation succeeds for an authored DELEGATE substep', async () => {
    await writeChildRunbook();
    await writeParentSingle();

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    const [autoToken] = extractTokens(result.stdout);
    expect(autoToken).toBeDefined();

    result = runCli(`abort ${autoToken}`, workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('delegate child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).action).toBe('delegated');

    const token = extractFirstToken(result.stdout);

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
