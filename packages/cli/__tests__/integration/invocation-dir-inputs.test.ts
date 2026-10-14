// packages/cli/__tests__/integration/invocation-dir-inputs.test.ts
//
// Paths the user types on the command line — `--input-file` and `file:`
// values in `--input` — resolve against the invocation directory, not the
// project root, while staying contained in the project root. `file:` values
// read from `.rundown/config.yaml` keep the project root as their base.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUNDOWN_DIR } from '@rundown-org/core';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';

const RUNBOOK = `---
name: inputs-demo
inputs:
  - message
  - items
---
# Inputs Demo

## 1. Echo
- PASS COMPLETE

Message: {{ message }}
`;

/** Runs a workspace command from `dir` instead of the project root. */
function from(workspace: TestWorkspace, dir: string): TestWorkspace {
  return { ...workspace, cwd: dir };
}

interface ResolveOutput {
  readonly valid: boolean;
  readonly errors?: ReadonlyArray<{ readonly message: string }>;
  readonly variables?: Record<string, unknown>;
}

function parseResolve(stdout: string): ResolveOutput {
  return JSON.parse(stdout) as ResolveOutput;
}

describe('user-typed input paths resolve against the invocation directory', () => {
  let workspace: TestWorkspace;
  let subDir: string;

  beforeEach(async () => {
    // The workspace root holds `.rundown/`, so it is the project root for a
    // command run from `packages/api`.
    workspace = await createTestWorkspace();
    subDir = join(workspace.cwd, 'packages', 'api');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'r.runbook.md'), RUNBOOK);
    await writeFile(join(workspace.cwd, 'env.yaml'), 'message: from-root\n');
    await writeFile(join(subDir, 'env.yaml'), 'message: from-sub\n');
    await writeFile(join(workspace.cwd, 'items.json'), '["root"]');
    await writeFile(join(subDir, 'items.json'), '["sub"]');
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('--input-file env.yaml from a subdirectory loads the subdirectory file', async () => {
    const result = await runCliInProcess(
      ['resolve', 'r.runbook.md', '--input-file', 'env.yaml'],
      from(workspace, subDir),
    );

    const out = parseResolve(result.stdout);
    expect(out.errors ?? []).toEqual([]);
    expect(out.variables?.message).toBe('from-sub');
  });

  it('--input-file ../shared.yaml from a subdirectory loads a file inside the project root', async () => {
    await writeFile(join(workspace.cwd, 'packages', 'shared.yaml'), 'message: from-shared\n');

    const result = await runCliInProcess(
      ['resolve', 'r.runbook.md', '--input-file', '../shared.yaml'],
      from(workspace, subDir),
    );

    const out = parseResolve(result.stdout);
    expect(out.errors ?? []).toEqual([]);
    expect(out.variables?.message).toBe('from-shared');
  });

  it('--input-file that escapes the project root from a subdirectory is refused', async () => {
    const result = await runCliInProcess(
      ['resolve', 'r.runbook.md', '--input-file', '../../../outside.yaml'],
      from(workspace, subDir),
    );

    const out = parseResolve(result.stdout);
    expect(out.valid).toBe(false);
    expect(out.errors?.[0]?.message).toMatch(/--input-file path escapes project directory/);
  });

  it('--input items=file:items.json from a subdirectory reads the subdirectory file', async () => {
    const result = await runCliInProcess(
      ['resolve', 'r.runbook.md', '--input', 'items=file:items.json'],
      from(workspace, subDir),
    );

    const out = parseResolve(result.stdout);
    expect(out.errors ?? []).toEqual([]);
    expect(out.variables?.items).toEqual(['sub']);
  });

  it('--input-json items="file:items.json" from a subdirectory reads the subdirectory file', async () => {
    const result = await runCliInProcess(
      ['resolve', 'r.runbook.md', '--input-json', 'items="file:items.json"'],
      from(workspace, subDir),
    );

    const out = parseResolve(result.stdout);
    expect(out.errors ?? []).toEqual([]);
    expect(out.variables?.items).toEqual(['sub']);
  });

  it('--input items=file:../../../outside.json from a subdirectory stays contained in the project root', async () => {
    const result = await runCliInProcess(
      ['resolve', 'r.runbook.md', '--input', 'items=file:../../../outside.json'],
      from(workspace, subDir),
    );

    expect(result.stdout).toContain('path escapes project directory');
  });

  it('a file: value in .rundown/config.yaml keeps the project root as its base', async () => {
    await writeFile(join(workspace.cwd, RUNDOWN_DIR, 'config.yaml'), 'items: file:items.json\n');

    const result = await runCliInProcess(['resolve', 'r.runbook.md'], from(workspace, subDir));

    const out = parseResolve(result.stdout);
    expect(out.errors ?? []).toEqual([]);
    expect(out.variables?.items).toEqual(['root']);
  });
});
