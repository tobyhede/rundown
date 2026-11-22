/**
 * Step commands run in the run's launch directory.
 *
 * A run records the directory `rundown run` was invoked from — its launch
 * directory — and every step command of that run executes there, whoever
 * continues the run and wherever they continue it from. The project root
 * (the nearest `.rundown/` above) owns the store; it does not move a step
 * command. A Delegation claimed from elsewhere runs its commands in its
 * parent run's launch directory.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  requireOwnerToken,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

const MARKER = 'step-ran-here.txt';

const TWO_STEP = [
  '# Service',
  '',
  '## 1. Start',
  '',
  '- PASS CONTINUE',
  '',
  'Begin by hand.',
  '',
  '## 2. Mark',
  '',
  '- PASS COMPLETE',
  '- FAIL STOP',
  '',
  '```sh',
  `pwd > ${MARKER}`,
  '```',
  '',
].join('\n');

const DELEGATING_PARENT = [
  '# Parent',
  '',
  '## 1. Delegate',
  '',
  '- DELEGATE',
  '- PASS ALL CONTINUE',
  '- FAIL ANY STOP',
  '',
  '- child.runbook.md',
  '',
  '## 2. After',
  '',
  '- PASS COMPLETE',
  '',
  'Finish.',
  '',
].join('\n');

const MARKING_CHILD = [
  '# Child',
  '',
  '## 1. Mark',
  '',
  '- PASS COMPLETE',
  '- FAIL STOP',
  '',
  '```sh',
  `pwd > ${MARKER}`,
  '```',
  '',
].join('\n');

/** A one-step runbook whose command is `command`. */
function oneStep(command: string): string {
  return [
    '# Work',
    '',
    '## 1. Write',
    '',
    '- PASS COMPLETE',
    '- FAIL STOP',
    '',
    '```sh',
    command,
    '```',
    '',
  ].join('\n');
}

/** Every file under `dir`, recursively, as paths relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));
}

type Envelope = Record<string, unknown>;

function envelopes(stdout: string): Envelope[] {
  return parseConcatenatedJson(stdout).filter(
    (value): value is Envelope =>
      typeof value === 'object' && value !== null && !Array.isArray(value),
  );
}

/** The same workspace, with the CLI run from `dir` instead of its root. */
function from(workspace: TestWorkspace, dir: string): TestWorkspace {
  return { ...workspace, cwd: dir };
}

describe('step commands run in the launch directory', () => {
  let workspace: TestWorkspace;
  let sub: string;
  let other: string;
  let pluginEnv: { env: Record<string, string> };

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    sub = join(workspace.cwd, 'packages', 'svc');
    other = join(workspace.cwd, 'packages', 'other');
    await mkdir(sub, { recursive: true });
    await mkdir(other, { recursive: true });
    pluginEnv = { env: { CLAUDE_PLUGIN_ROOT: join(workspace.cwd, 'plugin') } };
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('a run started in a sub-package and passed from the root runs its command in the sub-package', async () => {
    await writeFile(join(sub, 'test.runbook.md'), TWO_STEP);

    const run = await runCliInProcess(
      ['run', './test.runbook.md', '--allow-all'],
      from(workspace, sub),
      pluginEnv,
    );
    expect(run.exitCode).toBe(0);
    const token = requireOwnerToken(run.stdout);

    const pass = await runCliInProcess(
      ['pass', '--token', token, '--step', '1', '--allow-all'],
      workspace,
    );

    expect(envelopes(pass.stdout).find((e) => e.kind === 'error')).toBeUndefined();
    expect(pass.exitCode).toBe(0);
    expect(existsSync(join(workspace.cwd, MARKER))).toBe(false);
    expect((await readFile(join(sub, MARKER), 'utf8')).trim()).toBe(await realpath(sub));
  });

  it('a delegated child claimed from elsewhere runs its command in the parent run’s launch directory', async () => {
    await writeFile(join(sub, 'parent.runbook.md'), DELEGATING_PARENT);
    await writeFile(join(sub, 'child.runbook.md'), MARKING_CHILD);

    const run = await runCliInProcess(
      ['run', 'parent.runbook.md', '--allow-all'],
      from(workspace, sub),
      pluginEnv,
    );
    expect(run.exitCode).toBe(0);
    const entered = envelopes(run.stdout).filter((e) => e.type === 'step_entered');
    const [child] = (entered.at(-1)?.children ?? []) as Envelope[];

    const claim = await runCliInProcess(
      ['claim', String(child.ticket), '--agent-id', 'agent-other', '--allow-all'],
      from(workspace, other),
      pluginEnv,
    );

    expect(envelopes(claim.stdout).find((e) => e.kind === 'error')).toBeUndefined();
    expect(claim.exitCode).toBe(0);
    expect(existsSync(join(other, MARKER))).toBe(false);
    expect((await readFile(join(sub, MARKER), 'utf8')).trim()).toBe(await realpath(sub));
  });

  describe('Rundown-owned locations a command receives name the project root, not the launch directory', () => {
    async function runFromSub(command: string): Promise<void> {
      await writeFile(join(sub, 'work.runbook.md'), oneStep(command));
      const run = await runCliInProcess(
        ['run', './work.runbook.md', '--allow-all'],
        from(workspace, sub),
        pluginEnv,
      );
      expect(envelopes(run.stdout).find((e) => e.kind === 'error')).toBeUndefined();
      expect(run.exitCode).toBe(0);
    }

    it('$RD_WORK_PATH is the project root’s work directory', async () => {
      await runFromSub('mkdir -p "$RD_WORK_PATH" && echo env > "$RD_WORK_PATH/env-marker.txt"');

      expect(existsSync(join(workspace.cwd, '.rundown', 'work', 'env-marker.txt'))).toBe(true);
      expect(existsSync(join(sub, '.rundown'))).toBe(false);
    });

    it('{{ WorkPath }} in a command is the project root’s work directory', async () => {
      await runFromSub('mkdir -p "{{ WorkPath }}" && echo var > "{{ WorkPath }}/var-marker.txt"');

      expect(existsSync(join(workspace.cwd, '.rundown', 'work', 'var-marker.txt'))).toBe(true);
      expect(existsSync(join(sub, '.rundown'))).toBe(false);
    });

    it('{{ path "key" }} in a command lands under the project root’s work directory', async () => {
      await runFromSub(
        'mkdir -p "$(dirname "{{ path "path-marker.txt" }}")" && echo p > "{{ path "path-marker.txt" }}"',
      );

      const written = (await filesUnder(join(workspace.cwd, '.rundown', 'work'))).filter((file) =>
        file.endsWith('path-marker.txt'),
      );
      expect(written).toHaveLength(1);
      expect(existsSync(join(sub, '.rundown'))).toBe(false);
    });
  });
});
