import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
  readSession,
  getActiveState,
  listRunbookStates,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { textModeAgentAdvisory } from '../../src/commands/run.js';

describe('textModeAgentAdvisory', () => {
  it('warns when --text is captured (non-terminal stdout — the agent case)', () => {
    const advisory = textModeAgentAdvisory({ text: true }, undefined);
    expect(advisory).not.toBeNull();
    // Steers toward dropping --text for JSON without implying the run failed or
    // must be re-run (the advisory fires after the run has already started).
    expect(advisory).toContain('--text');
    expect(advisory).toContain('omit it');
    expect(advisory).toContain('JSON');
    expect(advisory).not.toMatch(/re-?run/i);
  });

  it('warns for any falsy isTTY — locks `!isTTY`, not `=== undefined`', () => {
    // Node reports `undefined` for a pipe, but the gate is `!isTTY`: a host that
    // ever surfaces `false` must still warn. Pins the contract so a refactor to
    // `isTTY === undefined` can't silently stop emitting on a `false` stdout.
    expect(textModeAgentAdvisory({ text: true }, false)).not.toBeNull();
  });

  it('stays silent for an interactive terminal (a human watching execution)', () => {
    expect(textModeAgentAdvisory({ text: true }, true)).toBeNull();
  });

  it('stays silent in JSON mode regardless of stdout (the agent default)', () => {
    expect(textModeAgentAdvisory({ text: false }, undefined)).toBeNull();
    expect(textModeAgentAdvisory({}, undefined)).toBeNull();
    expect(textModeAgentAdvisory({ text: false }, true)).toBeNull();
  });
});

describe('start command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('--text agent advisory (wired)', () => {
    it('writes the advisory to stderr without contaminating the --text stdout stream', async () => {
      const result = await runCliInProcess(
        'run --prompted runbooks/simple.runbook.md --text',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      // Goes to stderr (the captured-output / agent case: in-process stdout is
      // non-TTY), and never leaks into the human-readable stdout event stream.
      expect(result.stderr).toContain('--text is human-readable output');
      expect(result.stdout).not.toContain('--text is human-readable output');
    });

    it('stays silent in JSON mode (the agent default — no --text)', async () => {
      const result = await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('--text is human-readable output');
    });
  });

  describe('file mode', () => {
    it('creates runbook state from valid runbook file', async () => {
      const result = await runCliInProcess(
        'run --prompted runbooks/simple.runbook.md --text',
        workspace,
      );

      if (result.exitCode !== 0) {
        console.log('Run failed:', result.stdout, result.stderr);
      }

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Action:   START');
      expect(result.stdout).toContain('simple.runbook.md');
    });

    it('sets runbook as active', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const session = await readSession(workspace);
      expect(session.active).toBeTruthy();
    });

    it('stores relative path in state', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const state = await getActiveState(workspace);
      expect(state).not.toBeNull();
      expect(state?.runbook).toEqual({
        source: 'project',
        path: 'runbooks/simple.runbook.md',
      });
    });

    it('initializes step=1 and retryCount=0', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const state = await getActiveState(workspace);
      expect(state?.step).toBe('1');
      expect(state?.retryCount).toBe(0);
    });

    it('outputs first step description', async () => {
      const result = await runCliInProcess(
        'run --prompted runbooks/simple.runbook.md --text',
        workspace,
      );

      expect(result.stdout).toContain('## 1.');
      expect(result.stdout).toContain('First step');
    });

    it('evaluates helpers in prompted step prompt text', async () => {
      await writeFile(
        workspace.runbookPath('helper-prompt.runbook.md'),
        `# Helper Prompt Test

## 1. Show path
- PASS COMPLETE

Resolved path: {{ path "review.json" }}
`,
      );

      const result = await runCliInProcess(
        'run --prompted runbooks/helper-prompt.runbook.md --text',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('{{ path "review.json" }}');
      expect(result.stdout).toMatch(
        /\.rundown\/work\/\.rd-[A-Za-z0-9._-]+\/rd_[A-Za-z0-9._-]+\/review\.json/,
      );
    });

    it('stores plugin runbook refs relative to the plugin runbooks root for absolute paths', async () => {
      const pluginRunbookDir = join(workspace.pluginRunbooksDir(), 'planning/review');
      const runbookPath = join(pluginRunbookDir, 'plugin-child.runbook.md');
      await mkdir(pluginRunbookDir, { recursive: true });
      await writeFile(
        runbookPath,
        `# Plugin Child

## 1. Execute
- PASS COMPLETE

Plugin task.
`,
      );

      const result = await runCliInProcess(['run', '--prompted', runbookPath, '--text'], workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.runbook).toEqual({
        source: 'plugin',
        path: 'planning/review/plugin-child.runbook.md',
      });
      expect(Object.hasOwn(state ?? {}, 'runbookRef')).toBe(false);
    });

    it('stores bundled runbook refs relative to the bundled runbooks root for absolute paths', async () => {
      const bundledDir = join(workspace.cwd, 'bundled-runbooks');
      const bundledRunbookDir = join(bundledDir, 'delegation');
      const runbookPath = join(bundledRunbookDir, 'bundled-child.runbook.md');
      await mkdir(bundledRunbookDir, { recursive: true });
      await writeFile(
        runbookPath,
        `# Bundled Child

## 1. Execute
- PASS COMPLETE

Bundled task.
`,
      );

      const result = await runCliInProcess(
        ['run', '--prompted', runbookPath, '--text'],
        workspace,
        {
          env: { BUNDLED_RUNBOOKS_PATH: bundledDir },
        },
      );

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.runbook).toEqual({
        source: 'bundled',
        path: 'delegation/bundled-child.runbook.md',
      });
      expect(Object.hasOwn(state ?? {}, 'runbookRef')).toBe(false);
    });

    it('fails if file does not exist', async () => {
      const result = await runCliInProcess('run runbooks/nonexistent.md --text', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('fails if no file argument provided', async () => {
      const result = await runCliInProcess('run --text', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('required');
    });

    it('creates state file on disk', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const stateFiles = await listRunbookStates(workspace);
      expect(stateFiles.length).toBe(1);
    });
  });

  describe('auto-execution mode', () => {
    it('executes commands and advances through runbook', async () => {
      const result = await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('$ rd echo --result pass');
      expect(result.stdout).toContain('Runbook:  COMPLETE');
    });

    it('completes runbook when all commands pass', async () => {
      await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);

      // Runbook completed, so active runbook is null
      const session = await readSession(workspace);
      expect(session.active).toBeNull();
    });
  });

  describe('option validation', () => {
    it('rejects --step without active parent runbook', async () => {
      const result = await runCliInProcess(
        'run runbooks/simple.runbook.md --step 1 --text',
        workspace,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--step requires an active parent runbook');
    });

    it('rejects --index without --step', async () => {
      const result = await runCliInProcess(
        'run runbooks/simple.runbook.md --prompted --index 1 --text',
        workspace,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--index requires --step');
    });
  });
});
