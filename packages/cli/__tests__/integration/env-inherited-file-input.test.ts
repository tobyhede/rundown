// packages/cli/__tests__/integration/env-inherited-file-input.test.ts
//
// A `file:` value inherited from the environment through a bare `--input KEY`
// was set outside the command line, so it resolves against the project root,
// as an `RD_INPUT_*` value does. Only a value typed as `--input KEY=value` is
// relative to the directory the command was run from.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';

const RUNBOOK = `---
name: env-file-input
inputs:
  - items
---
# Env File Input

## 1. Only
- PASS COMPLETE

Do it.
`;

interface ResolveOutput {
  readonly errors?: ReadonlyArray<{ readonly message: string }>;
  readonly variables?: Record<string, unknown>;
}

describe('a file: value inherited with a bare --input KEY', () => {
  let workspace: TestWorkspace;
  let sub: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    const subDir = join(workspace.cwd, 'sub');
    await mkdir(subDir);
    await writeFile(join(subDir, 'r.runbook.md'), RUNBOOK);
    await writeFile(join(workspace.cwd, 'items.json'), '["root"]');
    await writeFile(join(subDir, 'items.json'), '["sub"]');
    sub = { ...workspace, cwd: subDir };
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('resolves against the project root, not the invocation directory', async () => {
    const result = await runCliInProcess(['resolve', 'r.runbook.md', '--input', 'items'], sub, {
      env: { items: 'file:items.json' },
    });

    const out = JSON.parse(result.stdout) as ResolveOutput;
    expect(out.errors ?? []).toEqual([]);
    expect(out.variables?.items).toEqual(['root']);
  });

  it('typed as --input KEY=value, the same value resolves against the invocation directory', async () => {
    const result = await runCliInProcess(
      ['resolve', 'r.runbook.md', '--input', 'items=file:items.json'],
      sub,
    );

    const out = JSON.parse(result.stdout) as ResolveOutput;
    expect(out.errors ?? []).toEqual([]);
    expect(out.variables?.items).toEqual(['sub']);
  });
});
