// packages/cli/__tests__/commands/ls.test.ts

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { createTestWorkspace, runCliInProcess } from '../helpers/test-utils.js';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/ls.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess). See collect.test.ts.
import { registerLsCommand } from '../../src/commands/ls.js';

describe('ls command wiring', () => {
  it('registers the ls command with its documented flags and descriptions', () => {
    const program = new Command();
    registerLsCommand(program);

    const ls = program.commands.find((c) => c.name() === 'ls');
    expect(ls).toBeDefined();
    expect(ls?.description()).toBe('List runbooks (active by default, --all for available)');

    const byLong = new Map(ls!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(expect.arrayContaining(['--all', '--text', '--tags']));
    expect(byLong.get('--all')?.description).toBe('List all available runbook files');
    expect(byLong.get('--all')?.short).toBe('-a');
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
    expect(byLong.get('--tags')?.description).toBe(
      'Filter available runbooks by comma-separated tags',
    );
  });
});

describe('rd ls', () => {
  let workspace: Awaited<ReturnType<typeof createTestWorkspace>>;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('shows correct step count for naturally completed runbook', async () => {
    // Run in prompted mode to manually step through
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('pass --text', workspace); // Step 1 -> 2
    await runCliInProcess('pass --text', workspace); // Step 2 -> DONE

    // Now, run `ls --text` for human-readable output
    const result = await runCliInProcess('ls --text', workspace);

    // It should show 2/2
    expect(result.stdout).toContain('complete');
    expect(result.stdout).toContain('2/2');
  });

  it('shows available runbooks with --all flag', async () => {
    const result = await runCliInProcess('ls --all --text', workspace);
    expect(result.stdout).toContain('NAME');
    expect(result.stdout).toContain('DESCRIPTION');
    expect(result.stdout).toContain('simple');
  });

  it('uses persisted source identity when counting active runbook steps', async () => {
    await writeFile(
      join(workspace.runbooksDir(), 'shadow.runbook.md'),
      '# Project Shadow\n\n## 1. Project Only\n\nProject step.\n',
    );
    await writeFile(
      join(workspace.pluginRunbooksDir(), 'shadow.runbook.md'),
      [
        '# Plugin Shadow',
        '',
        '## 1. Plugin First',
        '',
        'First.',
        '',
        '## 2. Plugin Second',
        '',
        'Second.',
        '',
        '## 3. Plugin Third',
        '',
        'Third.',
        '',
      ].join('\n'),
    );

    await runCliInProcess('run --prompted rundown:shadow --text', workspace);

    const result = await runCliInProcess('ls --text', workspace);

    expect(result.stdout).toContain('1/3');
    expect(result.stdout).not.toContain('1/1');
  });
});
