// packages/cli/__tests__/integration/frontmatter-outputs.test.ts

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestWorkspace, runCli, type TestWorkspace } from '../helpers/test-utils.js';

/**
 * Parse JSON output from CLI commands, handling both:
 * - Compact JSONL (one JSON object per line) from streaming execution events
 * - Pretty-printed single JSON object (from flushed summary when no JSONL events were emitted)
 */
function parseJsonOutput(stdout: string): Record<string, unknown>[] {
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
 * Runbook that auto-passes and completes; has a naked-form frontmatter OUTPUTS
 * declaration. SomeVar is expected to be passed via --var.
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

  it('stores naked-form frontmatter output to context on successful run', async () => {
    const contextId = 'fm-basic';
    const result = runCli(
      `run test.runbook.md --var ContextId=${contextId} --var SomeVar=hello`,
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const outputsPath = join(workspace.cwd, '.rundown', 'contexts', contextId, 'outputs.json');
    const raw = await readFile(outputsPath, 'utf-8');
    const outputs = JSON.parse(raw) as Record<string, unknown>;
    expect(outputs).toEqual({ SomeVar: 'hello' });
  });

  it('does NOT store frontmatter outputs when run stops on FAIL', async () => {
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

    const contextId = 'fm-fail';
    runCli(`run fail.runbook.md --var ContextId=${contextId} --var SomeVar=hello`, workspace);

    const outputsPath = join(workspace.cwd, '.rundown', 'contexts', contextId, 'outputs.json');
    await expect(readFile(outputsPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('stores with-value quoted-literal form to context on completion', async () => {
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

    const contextId = 'fm-literal';
    const result = runCli(`run literal.runbook.md --var ContextId=${contextId}`, workspace);
    expect(result.exitCode).toBe(0);

    const outputsPath = join(workspace.cwd, '.rundown', 'contexts', contextId, 'outputs.json');
    const raw = await readFile(outputsPath, 'utf-8');
    const outputs = JSON.parse(raw) as Record<string, unknown>;
    expect(outputs).toEqual({ OutVar: 'literal-value' });
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

    const contextId = 'fm-uppercase';
    const result = runCli(
      `run uppercase.runbook.md --var ContextId=${contextId} --var SomeVar=hello-upper`,
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const outputsPath = join(workspace.cwd, '.rundown', 'contexts', contextId, 'outputs.json');
    const raw = await readFile(outputsPath, 'utf-8');
    const outputs = JSON.parse(raw) as Record<string, unknown>;
    expect(outputs).toEqual({ SomeVar: 'hello-upper' });
  });
});

describe('frontmatter outputs — delegation chain', () => {
  let workspace: TestWorkspace;

  /**
   * Parent runbook: auto-passes via rd echo, has frontmatter outputs: [Message].
   * Message is expected to be passed via --var and stored to context on completion.
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
   * Child runbook: declares frontmatter inputs: [Message].
   * Step description uses {{Message}} which should be substituted from context.
   * No command — execution pauses at step 1, allowing us to inspect step_entered events.
   */
  const CHILD_RUNBOOK = `---
name: fm-chain-child
inputs:
  - Message
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

  it('parent frontmatter outputs flow into child frontmatter inputs via context', async () => {
    const contextId = 'fm-chain-ctx';

    // Run parent — auto-executes rd echo, completes, stores Message to context
    const parentResult = runCli(
      `run parent.runbook.md --var ContextId=${contextId} --var Message=hello-from-parent`,
      workspace,
    );
    expect(parentResult.exitCode).toBe(0);

    // Verify parent stored outputs
    const outputsPath = join(workspace.cwd, '.rundown', 'contexts', contextId, 'outputs.json');
    const raw = await readFile(outputsPath, 'utf-8');
    const outputs = JSON.parse(raw) as Record<string, unknown>;
    expect(outputs).toEqual({ Message: 'hello-from-parent' });

    // Run child — no command on step 1, so execution pauses after step_entered.
    // Frontmatter inputs: [Message] causes Message to be loaded from context outputs.
    const childResult = runCli(`run child.runbook.md --var ContextId=${contextId}`, workspace);
    expect(childResult.exitCode).toBe(0);

    // Step 1's step_entered event should have {{Message}} substituted from context
    const events = parseJsonOutput(childResult.stdout);
    const stepEntered = events.find((e) => e.type === 'step_entered' && e.position != null);
    expect(stepEntered).toBeDefined();
    expect(stepEntered?.prompt).toContain('hello-from-parent');
    expect(stepEntered?.prompt).not.toContain('{{Message}}');
  });
});
