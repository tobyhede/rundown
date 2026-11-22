// packages/cli/__tests__/integration/invocation-dir-policy.test.ts
//
// Policy discovery and `--helpers` paths key on the invocation directory,
// not the project root: a command run from a subdirectory of a project
// honours a stricter policy file that sits between it and the root, and a
// helper path the user typed resolves against where they typed it.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  parseJsonEvents,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

const HELPER_RUNBOOK = `---
name: helper-demo
---
# Helper Demo

## 1. Greet
- PASS COMPLETE
- FAIL STOP

Hello, {{ upper Name }}!
`;

/** Runs a workspace command from `dir` instead of the project root. */
function from(workspace: TestWorkspace, dir: string): TestWorkspace {
  return { ...workspace, cwd: dir };
}

describe('policy discovery starts at the invocation directory', () => {
  let workspace: TestWorkspace;
  let svcDir: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    svcDir = join(workspace.cwd, 'packages', 'svc');
    await mkdir(svcDir, { recursive: true });
    // The sub-package policy denies the very command the runbook runs. The
    // project root (the workspace, holding `.rundown/`) has no policy file.
    await writeFile(
      join(svcDir, '.rundownrc.json'),
      JSON.stringify({
        version: 1,
        default: { mode: 'execute', run: { allow: [], deny: ['node'] } },
      }),
    );
    await writeFile(
      join(svcDir, 'r.runbook.md'),
      [
        '# Policy',
        '',
        '## 1. Run node',
        '- PASS COMPLETE',
        '',
        '```bash',
        'node -e 0',
        '```',
        '',
      ].join('\n'),
    );
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('honours a .rundownrc between the invocation dir and the project root', async () => {
    const result = await runCliInProcess(
      ['run', 'r.runbook.md', '--yes', '--no-sandbox'],
      from(workspace, svcDir),
    );

    const denied = parseJsonEvents(result.stdout).find((e) => e.type === 'policy_denied');
    expect(denied).toEqual(expect.objectContaining({ command: 'node -e 0' }));
  });
});

describe('--helpers resolves against the invocation directory', () => {
  let workspace: TestWorkspace;
  let subDir: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    subDir = join(workspace.cwd, 'sub');
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, 'fmt.mjs'),
      'export function upper(value) {\n  return String(value).toUpperCase();\n}\n',
    );
    await writeFile(join(subDir, 'demo.runbook.md'), HELPER_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('loads sub/fmt.mjs for --helpers ./fmt.mjs typed from sub/', async () => {
    const result = await runCliInProcess(
      ['run', '--prompted', 'demo.runbook.md', '--input', 'Name=world', '--helpers', './fmt.mjs'],
      from(workspace, subDir),
    );

    expect(result.exitCode).toBe(0);
    const stepEntered = parseJsonEvents(result.stdout).find((e) => e.type === 'step_entered');
    expect(stepEntered?.prompt).toContain('WORLD');
  });
});

describe('policy-configured helpers resolve against the policy file', () => {
  let workspace: TestWorkspace;
  let subDir: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    subDir = join(workspace.cwd, 'sub');
    await mkdir(join(workspace.cwd, 'helpers'), { recursive: true });
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(workspace.cwd, 'helpers', 'fmt.mjs'),
      'export function upper(value) {\n  return String(value).toUpperCase();\n}\n',
    );
    // The policy file lives at the root; its helper path is relative to it.
    await writeFile(
      join(workspace.cwd, '.rundownrc.json'),
      JSON.stringify({ helpers: ['helpers/fmt.mjs'] }),
    );
    await writeFile(join(subDir, 'demo.runbook.md'), HELPER_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('loads a policy file helper when invoked from a subdirectory', async () => {
    const result = await runCliInProcess(
      ['run', '--prompted', 'demo.runbook.md', '--input', 'Name=world', '--trust-js-policy'],
      from(workspace, subDir),
    );

    expect(result.exitCode).toBe(0);
    const stepEntered = parseJsonEvents(result.stdout).find((e) => e.type === 'step_entered');
    expect(stepEntered?.prompt).toContain('WORLD');
  });
});
