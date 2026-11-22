/**
 * Where `rundown run` creates `.rundown/` when no project exists yet.
 *
 * Inside a git repository the project root is the git root: the first run from
 * any subdirectory creates the store there, so a later command from the root
 * or from another subdirectory (a sub-agent's `rundown claim`, say) opens the
 * same store instead of a different, empty one. Outside git there is no
 * boundary to anchor to, so the run creates `.rundown/` in its own directory.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseConcatenatedJson,
  requireRunId,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

const MANUAL = ['# Manual', '', '## 1. Only', '', '- PASS COMPLETE', '', 'Do it.', ''].join('\n');

/** A bare workspace rooted at `dir`, with no `.rundown/` created for it. */
function bare(dir: string, base: string): TestWorkspace {
  return { cwd: dir, binPath: () => join(base, 'bin') } as unknown as TestWorkspace;
}

describe('project root: no .rundown/ exists yet', () => {
  let base: string;
  let sub: string;
  // Home sits below base, so base and everything above it are ancestors of
  // home: the walk never leaves base, whatever lies above the temp directory.
  let homeEnv: { env: Record<string, string> };

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'rd-fresh-')));
    sub = join(base, 'packages', 'svc');
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, 'manual.runbook.md'), MANUAL);
    const home = join(base, 'home');
    await mkdir(home);
    homeEnv = { env: { HOME: home } };
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('in a git repository, run from a subdirectory creates .rundown/ at the git root', async () => {
    const repo = join(base, 'packages');
    await writeFile(join(repo, '.git'), 'gitdir: /dev/null\n');

    const run = await runCliInProcess(['run', 'manual.runbook.md'], bare(sub, base), homeEnv);

    expect(run.exitCode).toBe(0);
    expect(existsSync(join(repo, '.rundown', 'rundown.db'))).toBe(true);
    expect(existsSync(join(sub, '.rundown'))).toBe(false);
    // The run is visible from the git root.
    const runId = requireRunId(run.stdout);
    const status = await runCliInProcess(['status', '--run', runId], bare(repo, base), homeEnv);
    expect(status.exitCode).toBe(0);
    expect(parseConcatenatedJson(status.stdout)[0]).toMatchObject({ runId });
  });

  it('outside git, run creates .rundown/ in the working directory', async () => {
    const run = await runCliInProcess(['run', 'manual.runbook.md'], bare(sub, base), homeEnv);

    expect(run.exitCode).toBe(0);
    expect(existsSync(join(sub, '.rundown', 'rundown.db'))).toBe(true);
    expect(existsSync(join(base, 'packages', '.rundown'))).toBe(false);
  });
});
