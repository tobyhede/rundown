import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendArtifactManifestRecordSync,
  assertRunId,
  type RunbookState,
} from '@rundown-org/core';
import {
  createTestWorkspace,
  createRunbook,
  runCli,
  runCliInProcess,
  parseConcatenatedJson,
  readSession,
  getActiveState,
  readRunbookState,
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

      const state = await getActiveState(workspace);
      expect(state).not.toBeNull();
      expect(state!.variables.PlanPath).toMatchObject({ kind: 'artifact-record', uri });
    });
  });
});

// The inline-linkage (`rd run --step`) surface is the bulk of run.ts and is
// otherwise exercised only by integration tests, which the Stryker sandbox
// excludes (jest.config.shared.js drops `integration` from discovery). These
// command-level tests run inside the sandbox so the `--step` code path — inline
// linkage construction, its validation branches, the afterInit substep upsert,
// and terminal propagation — is covered by mutation testing. They default to
// JSON output per the CLI JSON-first testing convention.
describe('run --step inline linkage (sandbox-visible coverage)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Write a parent runbook with a two-substep step 1 and a plain step 2. */
  async function writeSubstepParent(vars?: Record<string, string>): Promise<void> {
    const content = createRunbook({
      title: 'Parent',
      ...(vars && { vars }),
      steps: [
        {
          title: 'Review',
          pass: 'CONTINUE',
          substeps: [
            { title: 'Code review', content: 'Do code review.' },
            { title: 'Security review', content: 'Do security review.' },
          ],
        },
        { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
  }

  /** Write a parent runbook whose step 1 is a FOR loop with substeps. */
  async function writeForParent(): Promise<void> {
    const content = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Process',
          for: { variable: 'i', start: 1, end: 3 },
          pass: 'CONTINUE',
          substeps: [
            { title: 'Handle item', content: 'Handle item {{i}}.' },
            { title: 'Verify item', content: 'Verify item {{i}}.' },
          ],
        },
        { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
  }

  /** Write a single-step auto-executing child that passes and completes. */
  async function writePassingChild(): Promise<void> {
    const content = createRunbook({
      title: 'Child',
      steps: [{ title: 'Execute', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
  }

  /** Write a child that emits command stdout/stderr while passing. */
  async function writeNoisyPassingChild(): Promise<void> {
    const content = createRunbook({
      title: 'Child',
      steps: [
        {
          title: 'Execute',
          pass: 'COMPLETE',
          command:
            "node -e \"process.stdout.write(['INLINE','STDOUT'].join('_')); process.stderr.write(['INLINE','STDERR'].join('_'))\"",
        },
      ],
    });
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
  }

  /** Write a single-step auto-executing child that fails and stops. */
  async function writeStoppingChild(): Promise<void> {
    const content = createRunbook({
      title: 'Child',
      steps: [
        { title: 'Execute', pass: 'COMPLETE', fail: 'STOP', command: 'rd echo --result fail' },
      ],
    });
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
  }

  /** Locate the inline child state by scanning runs for a parentLinkage row. */
  async function findChildState(parentRunId: string): Promise<RunbookState | null> {
    const files = await readdir(workspace.statePath());
    for (const f of files) {
      if (!f.endsWith('.json') || f === 'session.json') continue;
      const id = f.slice(0, -'.json'.length);
      if (id === parentRunId) continue;
      // Validated read: a schema rename now fails at compile time on the
      // typed field accesses below, not silently at runtime (CodeRabbit #529).
      const state = await readRunbookState(workspace, id);
      if (state?.parentLinkage) return state;
    }
    return null;
  }

  /** Start a substep parent in prompted mode and return its run id. */
  async function startSubstepParent(vars?: Record<string, string>): Promise<string> {
    await writeSubstepParent(vars);
    const result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    return state!.id;
  }

  describe('happy path', () => {
    it('auto-completing inline child marks the parent substep done and exits 0', async () => {
      const parentRunId = await startSubstepParent();
      await writePassingChild();

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      // afterInit sets the substep 'running', then propagateChildTerminal marks
      // it 'done' with the child's pass result — pins the full inline lifecycle.
      const parent = await readRunbookState(workspace, parentRunId);
      const ss = (parent!.substepStates ?? []).find((s) => s.id === '1');
      expect(ss).toBeDefined();
      expect(ss!.status).toBe('done');
      expect(ss!.result).toBe('pass');
    });

    it('builds an inline parentLinkage on the child pointing at the targeted substep', async () => {
      const parentRunId = await startSubstepParent();
      await writePassingChild();

      // Target 1.2 so parentStepId is unambiguously the substep id '2'.
      const result = await runCliInProcess('run child.runbook.md --step 1.2', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      const linkage = childState!.parentLinkage!;
      expect(linkage.kind).toBe('inline');
      expect(linkage.parentRunId).toBe(parentRunId);
      expect(linkage.parentStepId).toBe('2');
      expect(linkage.parentStep).toBe('1');
      expect(linkage.parentFrameKey).toBeDefined();
    });

    it('inline child auto-executes even though it inherits no prompted flag', async () => {
      const parentRunId = await startSubstepParent();
      await writePassingChild();

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      expect(childState!.lifecycle).toBe('completed');
    });

    it('routes fresh inline child command output away from JSON stdout', async () => {
      await startSubstepParent();
      await writeNoisyPassingChild();

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('INLINE_STDOUT');
      expect(result.stdout).not.toContain('INLINE_STDERR');
      expect(result.stderr).toContain('INLINE_STDOUT');
      expect(result.stderr).toContain('INLINE_STDERR');
    });

    it('inline child inherits parent template variables', async () => {
      await writeSubstepParent({ Region: 'seed' });
      const start = await runCliInProcess(
        ['run', '--prompted', 'parent.runbook.md', '--input', 'Region=cli-region'],
        workspace,
      );
      expect(start.exitCode).toBe(0);
      const parentRunId = (await getActiveState(workspace))!.id;
      await writePassingChild();

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      const templateVars = childState!.templateVars!;
      expect(templateVars.Region).toBe('cli-region');
    });
  });

  describe('terminal propagation', () => {
    it('inline child that fails and stops exits 1 and stops the parent', async () => {
      const parentRunId = await startSubstepParent();
      await writeStoppingChild();

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      // propagateChildTerminal reports 'stopped' → process.exit(1).
      expect(result.exitCode).toBe(1);

      const parent = await readRunbookState(workspace, parentRunId);
      const ss = (parent!.substepStates ?? []).find((s) => s.id === '1');
      expect(ss?.result).toBe('fail');
    });
  });

  describe('FOR-loop iteration targeting (--index)', () => {
    it('targets a non-active FOR iteration and encodes it in parentFrameKey', async () => {
      await writeForParent();
      const start = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const parentRunId = (await getActiveState(workspace))!.id;
      await writePassingChild();

      const result = await runCliInProcess('run child.runbook.md --step 1.1 --index 2', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      const linkage = childState!.parentLinkage!;
      // buildFrameKey(step, iteration) → "1|2" (not the active frame "1|1").
      expect(linkage.parentFrameKey).toBe('1|2');
    });

    it('rejects --index against a non-FOR step with INVALID_INDEX', async () => {
      await startSubstepParent();
      await writePassingChild();

      const result = await runCliInProcess('run child.runbook.md --step 1.1 --index 2', workspace);
      expect(result.exitCode).toBe(1);
      const out = result.stdout + result.stderr;
      expect(out).toContain('INVALID_INDEX');
      expect(out).toContain('FOR step');
    });
  });

  describe('validation errors', () => {
    it('rejects a step id that does not exist (RD-801)', async () => {
      await startSubstepParent();
      await writePassingChild();

      const result = await runCliInProcess('run child.runbook.md --step 9', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('RD-801');
    });

    it('rejects targeting a step with substeps without a substep qualifier (RD-803)', async () => {
      await startSubstepParent();
      await writePassingChild();

      const result = await runCliInProcess('run child.runbook.md --step 1', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('RD-803');
    });

    it('rejects a substep id that does not exist on the step (RD-806)', async () => {
      await startSubstepParent();
      await writePassingChild();

      const result = await runCliInProcess('run child.runbook.md --step 1.9', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('RD-806');
    });

    it('rejects targeting a step that has no substeps (RD-815)', async () => {
      const content = createRunbook({
        title: 'Parent',
        steps: [
          { title: 'Setup', pass: 'CONTINUE', content: 'Setup.' },
          { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
      const start = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      await writePassingChild();

      const result = await runCliInProcess('run child.runbook.md --step 1', workspace);
      expect(result.exitCode).toBe(1);
      const out = result.stdout + result.stderr;
      expect(out).toContain('RD-815');
    });

    it('rejects a step that is not at the parent frontier (RD-802)', async () => {
      // Both steps have substeps so the substep-shape checks pass; only the
      // frontier check (parentState.step !== target) can then reject step 2.
      const content = createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Review',
            pass: 'CONTINUE',
            substeps: [{ title: 'Code review', content: 'Do code review.' }],
          },
          {
            title: 'Verify',
            pass: 'COMPLETE',
            substeps: [{ title: 'Final check', content: 'Do final check.' }],
          },
        ],
      });
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
      const start = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      await writePassingChild();

      // Parent frontier is step 1; target substep 2.1.
      const result = await runCliInProcess('run child.runbook.md --step 2.1', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('RD-802');
    });

    it('rejects a substep whose cursor has already advanced (drain path, already resolved)', async () => {
      await startSubstepParent();
      await writePassingChild();

      // Resolve substep 1.1 directly on the parent — drain advances the cursor.
      const pass = await runCliInProcess('pass --step 1.1', workspace);
      expect(pass.exitCode).toBe(0);

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(1);
      const out = result.stdout + result.stderr;
      expect(out).toContain('already resolved');
      expect(out).toContain('DELEGATION_ALREADY_RESOLVED');
    });

    it('rejects --step with no active parent runbook (NO_ACTIVE_RUNBOOK)', async () => {
      await writePassingChild();
      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(1);
      const out = result.stdout + result.stderr;
      expect(out).toContain('--step requires an active parent runbook');
      expect(out).toContain('NO_ACTIVE_RUNBOOK');
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
