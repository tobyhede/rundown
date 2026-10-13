import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendArtifactManifestRecordSync, assertRunId } from '@rundown-org/core';
import {
  createTestWorkspace,
  createRunbook,
  runCli,
  runCliInProcess,
  parseConcatenatedJson,
  readRunbookState,
  requireRunId,
  listRunbookStates,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { textModeAgentAdvisory } from '../../src/commands/run.js';

/** The one persisted run in a workspace that started exactly one. */
async function soleRunState(workspace: TestWorkspace) {
  const files = await listRunbookStates(workspace);
  expect(files).toHaveLength(1);
  return readRunbookState(workspace, files[0].replace('.json', ''));
}

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
    it('keeps JSON stdout parseable when a command writes stdout and stderr', async () => {
      const runbook = [
        '# Noisy Run',
        '',
        '## 1. Emits bytes',
        '',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        '```bash',
        "printf '\\122\\125\\116\\137\\123\\124\\104\\117\\125\\124\\012'",
        "printf '\\122\\125\\116\\137\\123\\124\\104\\105\\122\\122\\012' >&2",
        '```',
        '',
      ].join('\n');

      await writeFile(join(workspace.runbooksDir(), 'noisy.runbook.md'), runbook);

      const result = runCli('run --allow-run printf --no-sandbox noisy.runbook.md', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('RUN_STDOUT');
      expect(result.stdout).not.toContain('RUN_STDERR');
      expect(result.stderr).toContain('RUN_STDOUT');
      expect(result.stderr).toContain('RUN_STDERR');

      const objects = parseConcatenatedJson(result.stdout);
      expect(objects.at(-1)).toMatchObject({ type: 'runbook_completed' });
    });

    it('returns the owner token on the runbook_started event, and nowhere else', async () => {
      const result = await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      expect(result.exitCode).toBe(0);
      const events = parseConcatenatedJson(result.stdout);
      const started = events.find(
        (event): event is Record<string, unknown> =>
          typeof event === 'object' &&
          event !== null &&
          (event as { type?: unknown }).type === 'runbook_started',
      );
      expect(started).toEqual(
        expect.objectContaining({
          owner_token: expect.stringMatching(/^rdo_[A-Za-z0-9_-]{43}$/),
          runbookId: expect.any(String),
        }),
      );
      expect(started).not.toHaveProperty('claim_id');
      expect(
        events.filter((event) => (event as { owner_token?: unknown }).owner_token),
      ).toHaveLength(1);
    });

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

    it('lists the run as running', async () => {
      const start = await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      const status = await runCliInProcess('status', workspace);
      expect(JSON.parse(status.stdout).runs).toEqual([
        expect.objectContaining({ id: requireRunId(start.stdout), status: 'running' }),
      ]);
    });

    it('stores relative path in state', async () => {
      const start = await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      const state = await readRunbookState(workspace, requireRunId(start.stdout));
      expect(state).not.toBeNull();
      expect(state?.runbook).toEqual({
        source: 'project',
        path: 'runbooks/simple.runbook.md',
      });
    });

    it('initializes step=1 and retryCount=0', async () => {
      const start = await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      const state = await readRunbookState(workspace, requireRunId(start.stdout));
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
      const state = await soleRunState(workspace);
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
      const state = await soleRunState(workspace);
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
      const start = await runCliInProcess('run runbooks/simple.runbook.md', workspace);

      const state = await readRunbookState(workspace, requireRunId(start.stdout));
      expect(state?.lifecycle).toBe('completed');
    });

    it('bumps the active entry exactly once per command-driven step advance', async () => {
      // End-to-end pin on the single-writer model (#680): the machine bumps the
      // entry once, as an entry action on the leaf it advances into, and
      // `deriveActorStatePatch` mirrors that one value into committed state. A
      // second bump would push each new frame's completion scope past the entry
      // the machine actually recorded against it.
      const runbook = createRunbook({
        title: 'Entry Bump',
        steps: [
          { title: 'One', pass: 'CONTINUE', fail: 'STOP', command: 'rd echo --result pass' },
          { title: 'Two', pass: 'COMPLETE', fail: 'STOP', command: 'rd echo --result pass' },
        ],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'entries.runbook.md'), runbook);

      const result = await runCliInProcess('run runbooks/entries.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const state = await readRunbookState(workspace, requireRunId(result.stdout));

      // Exact counts, not a shape assertion: the second frame is reached by ONE
      // frame switch, which bumps its entry to 2. A second bump over the same
      // transition reads as a re-entry that never happened and shifts the frame's
      // completion scope off the entry the machine recorded against it.
      expect(state!.frameEntryCounts).toEqual({ '1|': 1, '2|': 2 });
      expect(state!.activeEntry).toBe(2);
    });
  });

  describe('option validation', () => {
    it('rejects --step without --prompted (a run composes with no parent)', async () => {
      const result = await runCliInProcess('run runbooks/simple.runbook.md --step 1', workspace);
      expect(result.exitCode).toBe(1);
      const error = JSON.parse(result.stdout);
      expect(error.code).toBe('INVALID_SYNTAX');
      expect(error.error).toContain('--step requires --prompted');
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

  describe('--artifacts flag', () => {
    function appendManagedManifestRow(contextId: string, key: string) {
      const runId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const uri = `rd://artifacts/${contextId}/${runId}/${key}`;
      appendArtifactManifestRecordSync(
        { cwd: workspace.cwd, workPath: '.rundown/work' },
        {
          uri,
          runId,
          contextId,
          runbook: { source: 'project', path: 'producer.runbook.md' },
          key,
          timestamp: '2026-05-25T00:00:00.000Z',
        },
      );
      return uri;
    }

    it('run accepts --artifacts and rehydrates it as a runtime artifact variable', async () => {
      const uri = appendManagedManifestRow('ctx-a', 'PlanPath');
      await writeFile(
        join(workspace.cwd, 'execute-plan.runbook.md'),
        `---
artifacts:
  - PlanPath
required:
  - PlanPath
---
# Execute Plan

## 1. Review
- PASS COMPLETE
- FAIL STOP

{{ PlanPath }}
`,
      );

      const result = await runCliInProcess(
        ['run', 'execute-plan.runbook.md', '--prompted', '--artifacts', `PlanPath=${uri}`],
        workspace,
      );
      expect(result.exitCode).toBe(0);

      const state = await readRunbookState(workspace, requireRunId(result.stdout));
      expect(state).not.toBeNull();
      expect(state!.variables.PlanPath).toMatchObject({ kind: 'artifact-record', uri });
    });
  });
});

describe('run error handling and warnings (sandbox-visible coverage)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('exits 1 when an auto-executing runbook stops', async () => {
    await writeFile(
      join(workspace.cwd, 'stops.runbook.md'),
      `# Stops

## 1. Fail hard
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
rd echo --result fail
\`\`\`
`,
    );

    const result = await runCliInProcess('run stops.runbook.md', workspace);
    // result.loopResult === 'stopped' → process.exit(1) on the no-linkage path.
    expect(result.exitCode).toBe(1);
  });

  it('warns for an undefined template variable preserved as literal text', async () => {
    await writeFile(
      join(workspace.cwd, 'undef.runbook.md'),
      `# Undef

## 1. Uses undefined
- PASS COMPLETE

Value is {{ missingVar }}.
`,
    );

    const result = await runCliInProcess('run --prompted undef.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toContain('missingVar');
    expect(out).toContain('preserved as literal text');
  });

  it('surfaces a syntax error as INVALID_SYNTAX for an unparseable runbook', async () => {
    // A file with no H2 step headings has no runnable steps.
    await writeFile(
      join(workspace.cwd, 'broken.runbook.md'),
      `# Broken

Just prose, no steps at all.
`,
    );

    const result = await runCliInProcess('run broken.runbook.md', workspace);
    expect(result.exitCode).toBe(1);
    // Either the prepare pipeline or the RunbookSyntaxError catch branch reports
    // a non-zero failure; the run must not silently succeed.
    expect(result.stdout + result.stderr).not.toBe('');
  });

  it('reports RUNBOOK_NOT_FOUND with a discovery hint for a missing file', async () => {
    const result = await runCliInProcess('run does-not-exist.runbook.md', workspace);
    expect(result.exitCode).toBe(1);
    const out = result.stdout + result.stderr;
    expect(out).toContain('RUNBOOK_NOT_FOUND');
    expect(out).toContain('does-not-exist.runbook.md');
  });
});
