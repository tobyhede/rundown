/**
 * The project root is resolved once per invocation.
 *
 * Policy initialisation (`preSubcommand`) and the command action both need the
 * project root. Each walk is a synchronous stat/realpath climb, and two walks
 * could disagree if the filesystem moved between them — the policy evaluator's
 * `{repo}` and the store would then name different projects. One walk per
 * invocation, re-walked on the next one (in-process tests change directory
 * between invocations).
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const actualCore = await import('@rundown-org/core');
const resolveProjectRoot = jest.fn(actualCore.resolveProjectRoot);
jest.unstable_mockModule('@rundown-org/core', () => ({ ...actualCore, resolveProjectRoot }));

const { createTestWorkspace, runCliInProcess } = await import('../helpers/test-utils.js');
type TestWorkspace = Awaited<ReturnType<typeof createTestWorkspace>>;

describe('project root: one walk per invocation', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    resolveProjectRoot.mockClear();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('a command resolves the project root once, for policy and for the command alike', async () => {
    const result = await runCliInProcess(['ls'], workspace);

    expect(result.exitCode).toBe(0);
    expect(resolveProjectRoot).toHaveBeenCalledTimes(1);
  });

  it('the next invocation from another directory walks again', async () => {
    const sub = join(workspace.cwd, 'packages', 'app');
    await mkdir(sub, { recursive: true });

    await runCliInProcess(['ls'], workspace);
    await runCliInProcess(['ls'], { ...workspace, cwd: sub });

    const starts = resolveProjectRoot.mock.calls.map(([start]) => start);
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatch(/packages\/app$/);
  });
});
