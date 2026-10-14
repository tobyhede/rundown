/**
 * The SubagentStop gate holds a sub-agent that claimed a child from a
 * subdirectory of the project.
 *
 * The CLI keeps a project's runs under its project root: the nearest
 * directory holding `.rundown/` (`resolveProjectRoot` in core). A sub-agent
 * that `cd`s into a subdirectory and claims a child there claims it in the
 * root's store; when it stops in that subdirectory the gate must find the
 * claim, even with no `CLAUDE_PROJECT_DIR` to point it at the root.
 *
 * Drives the real CLI, resolved from node_modules like the hook does.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRundownCliPath } from '../../../src/workflow/hooks/rundown.js';
import { handleSubagentStop } from '../../../src/workflow/hooks/subagent-stop.js';

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

/** Run the CLI in `cwd` as from a plain shell, returning stdout. */
function cli(args: string[], cwd: string): string {
  return execFileSync('node', [getRundownCliPath(), ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      CLAUDE_CODE_ENTRYPOINT: undefined,
      CLAUDE_PROJECT_DIR: undefined,
      RUNDOWN_LOG: '0',
      NO_COLOR: '1',
    },
  });
}

/** The ticket of the first child the run's last `step_entered` lists. */
function ticketOf(stdout: string): string {
  const entered = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { type?: string; children?: { ticket?: string }[] })
    .filter((event) => event.type === 'step_entered');
  const ticket = entered.at(-1)?.children?.[0]?.ticket;
  if (ticket === undefined) throw new Error(`no ticket in run output:\n${stdout}`);
  return ticket;
}

describe('SubagentStop gate from a subdirectory of the project', () => {
  let root: string;
  let sub: string;
  let savedProjectDir: string | undefined;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'rd-stop-root-')));
    // A git boundary keeps the project-root walk inside the temp project.
    await writeFile(join(root, '.git'), 'gitdir: /dev/null\n');
    await mkdir(join(root, '.rundown'));
    await writeFile(join(root, 'parent.runbook.md'), PARENT);
    await writeFile(join(root, 'child.runbook.md'), CHILD);
    sub = join(root, 'packages', 'app');
    await mkdir(sub, { recursive: true });
    savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(async () => {
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    await rm(root, { recursive: true, force: true });
  });

  it('blocks the stop while the child claimed in the root store is running', async () => {
    const ticket = ticketOf(cli(['run', 'parent.runbook.md'], root));
    cli(['claim', ticket, '--agent-id', 'agent-sub'], root);

    const result = await handleSubagentStop({
      hook_event_name: 'SubagentStop',
      cwd: sub,
      agent_id: 'agent-sub',
    });

    expect(result.violation).toMatch(/You claimed a delegated Rundown child/);
    expect(existsSync(join(sub, '.rundown'))).toBe(false);
  });

  it('allows the stop of an agent that holds nothing', async () => {
    const ticket = ticketOf(cli(['run', 'parent.runbook.md'], root));
    cli(['claim', ticket, '--agent-id', 'agent-other'], root);

    const result = await handleSubagentStop({
      hook_event_name: 'SubagentStop',
      cwd: sub,
      agent_id: 'agent-sub',
    });

    expect(result).toStrictEqual({});
  });
});
