/**
 * A Child Run's runbook found beside the runbook that composes it.
 *
 * A child reference resolves through the project, plugin, cwd and bundled
 * roots first; only when all of them miss is it tried relative to the parent
 * runbook's own directory. So a runbook run by path from outside
 * `.rundown/runbooks/` can compose its sibling, wherever the command runs from.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

const INLINE_PARENT = [
  '# Parent',
  '',
  '## 1. Compose',
  '',
  '- PASS ALL CONTINUE',
  '- FAIL ANY STOP',
  '',
  '- child.runbook.md',
  '',
  '## 2. After',
  '',
  '- PASS COMPLETE',
  '- FAIL STOP',
  '',
  'Finish.',
  '',
].join('\n');

const DELEGATING_PARENT = [
  '# Delegating parent',
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
  '- FAIL STOP',
  '',
  'Finish.',
  '',
].join('\n');

const CHILD = [
  '---',
  'name: flows-child',
  '---',
  '# Child',
  '',
  '## Check',
  '',
  '- PASS COMPLETE',
  '- FAIL STOP',
  '',
  'Check by hand.',
  '',
].join('\n');

function events(stdout: string): Record<string, unknown>[] {
  return parseConcatenatedJson(stdout).filter(
    (value): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value),
  );
}

describe('a child runbook beside its parent', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await mkdir(join(workspace.cwd, 'docs/flows'), { recursive: true });
    await writeFile(join(workspace.cwd, 'docs/flows/child.runbook.md'), CHILD);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('launches an inline child from the parent runbook directory', async () => {
    await writeFile(join(workspace.cwd, 'docs/flows/parent.runbook.md'), INLINE_PARENT);

    const result = await runCliInProcess('run docs/flows/parent.runbook.md', workspace);

    expect(events(result.stdout).filter((event) => event.type === 'error_occurred')).toEqual([]);
    expect(result.exitCode).toBe(0);
    const started = events(result.stdout).filter((event) => event.type === 'runbook_started');
    expect(started.map((event) => event.runbook)).toEqual([
      { source: 'project', path: 'docs/flows/parent.runbook.md' },
      { source: 'project', path: 'docs/flows/child.runbook.md' },
    ]);
  });

  it('claims a delegated child from the parent runbook directory', async () => {
    await writeFile(join(workspace.cwd, 'docs/flows/delegating.runbook.md'), DELEGATING_PARENT);
    const run = await runCliInProcess('run docs/flows/delegating.runbook.md', workspace);
    expect(run.exitCode).toBe(0);
    const entered = events(run.stdout).find((event) => Array.isArray(event.children));
    const [child] = (entered?.children ?? []) as { ticket?: unknown }[];

    const claim = await runCliInProcess(
      ['claim', String(child.ticket), '--agent-id', 'agent-1'],
      workspace,
    );

    expect(
      events(claim.stdout).filter(
        (event) => event.type === 'error_occurred' || event.kind === 'error',
      ),
    ).toEqual([]);
    expect(claim.exitCode).toBe(0);
    const [started] = events(claim.stdout).filter((event) => event.type === 'runbook_started');
    expect(started.runbook).toEqual({ source: 'project', path: 'docs/flows/child.runbook.md' });
  });
});
