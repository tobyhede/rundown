/**
 * Commands run from a subdirectory of a project act on the project.
 *
 * The project root is the nearest directory above the working directory that
 * holds `.rundown/` (`resolveProjectRoot` in core). A sub-agent that `cd`s
 * into a subdirectory and runs `rundown claim` must find the Claim Ticket its
 * parent's run issued; a `rundown run` there must start a run the rest of the
 * project sees, from the project's runbooks. Where no `.rundown/` exists yet,
 * see `../integration/project-root-fresh.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  requireOwnerToken,
  requireRunId,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

const PARENT = [
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

const CHILD = ['# Child', '', '## Check', '', '- PASS COMPLETE', '', 'Check.', ''].join('\n');

const MANUAL = ['# Manual', '', '## 1. Only', '', '- PASS COMPLETE', '', 'Do it.', ''].join('\n');

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

describe('project root: commands from a subdirectory act on the project', () => {
  let workspace: TestWorkspace;
  let sub: string;
  let pluginEnv: { env: Record<string, string> };

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), PARENT);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD);
    sub = join(workspace.cwd, 'packages', 'app');
    await mkdir(sub, { recursive: true });
    // Keep the plugin root where the workspace put it, not under `sub`.
    pluginEnv = { env: { CLAUDE_PLUGIN_ROOT: join(workspace.cwd, 'plugin') } };
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function startParent(): Promise<{ runId: string; ticket: string }> {
    const result = await runCliInProcess('run parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    const entered = envelopes(result.stdout).filter((event) => event.type === 'step_entered');
    const [child] = (entered.at(-1)?.children ?? []) as Envelope[];
    return { runId: requireRunId(result.stdout), ticket: String(child.ticket) };
  }

  it('claim from a subdirectory finds the ticket in the root store', async () => {
    const { runId, ticket } = await startParent();

    const claim = await runCliInProcess(
      ['claim', ticket, '--agent-id', 'agent-sub'],
      from(workspace, sub),
      pluginEnv,
    );

    expect(envelopes(claim.stdout).find((e) => e.kind === 'error')).toBeUndefined();
    expect(claim.exitCode).toBe(0);
    const [started] = envelopes(claim.stdout).filter((e) => e.type === 'runbook_started');
    expect(started).toMatchObject({ parent: { runId, step: '1.1' } });
    expect(existsSync(join(sub, '.rundown'))).toBe(false);
  });

  it('status from a subdirectory reads the root store', async () => {
    const { runId } = await startParent();

    const status = await runCliInProcess(
      ['status', '--run', runId],
      from(workspace, sub),
      pluginEnv,
    );

    expect(status.exitCode).toBe(0);
    expect(envelopes(status.stdout)[0]).toMatchObject({ runId });
  });

  it('run from a subdirectory uses the root store and the project runbooks', async () => {
    await writeFile(join(workspace.runbooksDir(), 'root-only.runbook.md'), MANUAL);

    const run = await runCliInProcess(['run', 'root-only'], from(workspace, sub), pluginEnv);

    expect(run.exitCode).toBe(0);
    const runId = requireRunId(run.stdout);
    expect(existsSync(join(sub, '.rundown'))).toBe(false);
    const status = await runCliInProcess(['status', '--run', runId], workspace);
    expect(status.exitCode).toBe(0);
    expect(envelopes(status.stdout)[0]).toMatchObject({ runId });
  });

  it('run of a path relative to the subdirectory resolves there and is driven from the root', async () => {
    await writeFile(join(sub, 'local.runbook.md'), MANUAL);

    const run = await runCliInProcess(['run', 'local.runbook.md'], from(workspace, sub), pluginEnv);

    expect(run.exitCode).toBe(0);
    const runId = requireRunId(run.stdout);
    const token = requireOwnerToken(run.stdout);
    expect(existsSync(join(sub, '.rundown'))).toBe(false);
    // The run's runbook is recorded relative to the project root, so the run
    // is driven from the root as well as from where it started.
    const pass = await runCliInProcess(['pass', '--token', token, '--step', '1'], workspace);
    expect(pass.exitCode).toBe(0);
    expect(envelopes(pass.stdout)[0]).toMatchObject({ action: 'complete', complete: true });
    const status = await runCliInProcess(['status', '--run', runId], workspace);
    expect(status.exitCode).toBe(0);
  });
});
