import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { runCliInProcess } from '../../src/services/in-process-cli-runner.js';
import { createTestWorkspace } from '../helpers/test-utils.js';

describe('in-process CLI runner', () => {
  it('runs CLI commands in the requested cwd and captures stdout', async () => {
    const workspace = await createTestWorkspace();
    try {
      const runbook = `---
name: smoke
---

# Smoke

## 1. Done
- PASS COMPLETE
`;
      await mkdir(workspace.runbooksDir(), { recursive: true });
      await writeFile(join(workspace.runbooksDir(), 'smoke.runbook.md'), runbook);

      const result = await runCliInProcess({
        args: ['run', '--prompted', 'smoke.runbook.md'],
        cwd: workspace.cwd,
        env: {
          PATH: `${workspace.binPath()}:${process.env.PATH ?? ''}`,
          CLAUDE_PLUGIN_ROOT: `${join(workspace.cwd, 'plugin')}/`,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('smoke');
    } finally {
      await workspace.cleanup();
    }
  });

  it('captures process.exit codes without leaking ExitSignal artifacts', async () => {
    const workspace = await createTestWorkspace();
    try {
      const result = await runCliInProcess({
        args: ['scenario', 'ls', 'missing.runbook.md'],
        cwd: workspace.cwd,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).not.toContain('process.exit');
      expect(result.stdout + result.stderr).toContain('RUNBOOK_NOT_FOUND');
    } finally {
      await workspace.cleanup();
    }
  });

  it('restores cwd and environment after invocation', async () => {
    const workspace = await createTestWorkspace();
    const originalCwd = process.cwd();
    const originalValue = process.env.RD_IN_PROCESS_TEST_VALUE;
    try {
      const result = await runCliInProcess({
        args: ['prompt', 'ok'],
        cwd: workspace.cwd,
        env: { RD_IN_PROCESS_TEST_VALUE: 'set-inside-runner' },
      });

      expect(result.exitCode).toBe(0);
      expect(process.cwd()).toBe(originalCwd);
      expect(process.env.RD_IN_PROCESS_TEST_VALUE).toBe(originalValue);
    } finally {
      if (originalValue === undefined) {
        delete process.env.RD_IN_PROCESS_TEST_VALUE;
      } else {
        process.env.RD_IN_PROCESS_TEST_VALUE = originalValue;
      }
      await workspace.cleanup();
    }
  });

  it('does not leak env overrides between sequential invocations', async () => {
    const workspace = await createTestWorkspace();
    try {
      await runCliInProcess({
        args: ['prompt', 'first'],
        cwd: workspace.cwd,
        env: { RD_INPUT_marker: 'first' },
      });

      const markerFile = join(workspace.cwd, 'marker.runbook.md');
      await writeFile(
        markerFile,
        `---
name: marker
---

# Marker

## 1. Echo
- PASS COMPLETE

\`\`\`bash
rd echo "{{ marker }}"
\`\`\`
`,
      );

      const result = await runCliInProcess({
        args: ['run', markerFile, '--allow-all'],
        cwd: workspace.cwd,
        env: {
          PATH: `${workspace.binPath()}:${process.env.PATH ?? ''}`,
          CLAUDE_PLUGIN_ROOT: `${join(workspace.cwd, 'plugin')}/`,
        },
      });

      expect(result.exitCode).toBe(0);
      const stateFiles = await readFile(join(workspace.cwd, '.rundown/session.json'), 'utf-8');
      expect(stateFiles).not.toContain('first');
    } finally {
      await workspace.cleanup();
    }
  });
});
