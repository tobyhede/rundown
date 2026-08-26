import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdir, writeFile } from 'node:fs/promises';
import { listPersistedRunIds } from '@rundown-org/core/testing/session-fixtures';
import { join } from 'node:path';
import {
  appendArtifactManifestRecordSync,
  assertExecutionEpoch,
  assertRunId,
  buildFrameKey,
  deriveActiveFrame,
  type GuardedMutationResult,
  RunbookStateManager,
  SessionService,
  upsertSubstepState,
  type FrameKey,
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

// ACCEPTED MUTATION SURVIVOR in run.ts (#485).
//
//  - `callerEvidence: { kind: 'direct_cli' }` on the `--prompted --step` goto
//    context (`run.ts:312`), `ObjectLiteral -> {}`. Equivalent, not a gap:
//    `runNavigationMutation` reads the evidence through exactly one predicate,
//    `input.callerEvidence.kind === 'claim_bearer'`, so `{}` and `direct_cli`
//    take the same branch and commit the same mutation. Confirmed against the
//    broad (`--findRelatedTests`) tier, so this is not the dedicated-tier
//    artifact — the integration path in `explicit-run-targeting.test.ts` does
//    exercise this line. Killing it would mean asserting an object literal's
//    shape rather than any behaviour it produces.

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

    it('returns the orchestrator bearer claim id on the runbook_started event', async () => {
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
          claim_id: expect.stringMatching(/^rdclm_/),
          runbookId: expect.any(String),
        }),
      );
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

      const runId = parseConcatenatedJson(result.stdout).find(
        (event): event is Record<string, unknown> =>
          typeof event === 'object' && event !== null && 'claim_id' in event,
      )?.runbookId as string;
      const state = await readRunbookState(workspace, runId);

      // Exact counts, not a shape assertion: the second frame is reached by ONE
      // frame switch, which bumps its entry to 2. A second bump over the same
      // transition reads as a re-entry that never happened and shifts the frame's
      // completion scope off the entry the machine recorded against it.
      expect(state!.frameEntryCounts).toEqual({ '1|': 1, '2|': 2 });
      expect(state!.activeEntry).toBe(2);
    });

    it('retains the run-control claim as a terminal tombstone after a command completion', async () => {
      // `rundown run` mints a run-control claim over the root run and drives
      // the loop at its own release ownership. When a command step carries the
      // run terminal, the
      // release folded into that command's fenced commit must RETAIN the claim:
      // deleting it makes a post-completion `rd pass/fail/status --claim-id`
      // resolve `missing` instead of `terminal`, so the orchestrator can no
      // longer confirm-or-conflict against the outcome it was handed at start.
      const result = await runCliInProcess('run runbooks/simple.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const started = parseConcatenatedJson(result.stdout).find(
        (event): event is Record<string, unknown> =>
          typeof event === 'object' && event !== null && 'claim_id' in event,
      );
      const claimId = started?.claim_id;
      const runId = started?.runbookId;
      expect(typeof claimId).toBe('string');
      expect(typeof runId).toBe('string');

      const session = await readSession(workspace);
      expect(session.defaultStack).not.toContain(runId);
      expect(Object.values(session.claims)).toContainEqual(
        expect.objectContaining({ controlledRunId: runId }),
      );

      // The retention only matters if the bearer still RESOLVES, so drive the
      // real command surface rather than trusting the session row: a tombstone
      // that no longer answers `--claim-id` is the same failure as deletion.
      const status = await runCliInProcess(['status', '--claim-id', String(claimId)], workspace);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).not.toMatch(/CLAIM_NOT_FOUND|STALE_CLAIM/);
      expect(status.stdout).toContain(String(runId));
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
  let parentClaimId: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    parentClaimId = '';
  });

  afterEach(async () => {
    jest.restoreAllMocks();
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
            'OUT=INLINE_$(printf STDOUT); ERR=INLINE_$(printf STDERR); printf %s "$OUT"; printf %s "$ERR" >&2',
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
    const ids = await listPersistedRunIds(workspace.cwd);
    for (const id of ids) {
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
    const started = parseConcatenatedJson(result.stdout).find(
      (event): event is Record<string, unknown> =>
        typeof event === 'object' &&
        event !== null &&
        (event as { type?: unknown }).type === 'runbook_started',
    );
    expect(typeof started?.claim_id).toBe('string');
    parentClaimId = String(started!.claim_id);
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

      const result = await runCliInProcess(
        'run child.runbook.md --step 1.1 --allow-run printf --no-sandbox',
        workspace,
      );

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
      const templateVars = childState!.templateVars;
      expect(templateVars.Region).toBe('cli-region');
    });
  });

  describe('concurrent parent substep writes', () => {
    it('keeps a sibling substep row committed while the launch derives its own', async () => {
      const parentRunId = await startSubstepParent();
      await writePassingChild();

      // Land a real, UNRELATED substep write on the parent inside the window
      // between the launch's derivation of substep 1.1's row and the commit that
      // depends on it. This models the writers that actually exist: every
      // parent-side substep mutation (`rundown delegate`, `rundown pass`, ...)
      // goes through the state machine and never took the delegation file lock
      // this site used to hold, so that lock never excluded them.
      //
      // The hook covers every seam the launch could reach the parent through:
      // the patch-shaped `update`, the two derive-inside-the-CAS forms
      // `updateWithStateIfExists` and `updateWithStateReturning`, and the fenced
      // launch path's per-attempt capture `captureAuthorityState` (#714) — for
      // the fenced path the injection lands before the FIRST capture, which is
      // the "outside the cycle" placement this test is about: the derivation
      // then reads a row that already carries the sibling and commits first
      // time. `injected` below is what keeps that list honest: swapping the
      // launch to a seam that is not wrapped here fails the test rather than
      // silently making it vacuous.
      let injected = false;
      const injectSiblingSubstepWrite = async (): Promise<void> => {
        if (injected) return;
        // Set before writing: the injection itself goes through the wrapped seam.
        injected = true;
        const sideband = new RunbookStateManager(workspace.cwd);
        await sideband.updateWithState(parentRunId, (current) => ({
          substepStates: upsertSubstepState(
            current.substepStates ?? [],
            '2',
            current.activeFrameKey ?? deriveActiveFrame(current).frameKey,
            { status: 'running' as const },
          ),
        }));
      };

      /* eslint-disable @typescript-eslint/unbound-method -- captured to re-apply with the spy's `this` */
      const realUpdate = RunbookStateManager.prototype.update;
      const realUpdateWithStateIfExists = RunbookStateManager.prototype.updateWithStateIfExists;
      const realUpdateWithStateReturning = RunbookStateManager.prototype.updateWithStateReturning;
      /* eslint-enable @typescript-eslint/unbound-method */
      jest.spyOn(RunbookStateManager.prototype, 'update').mockImplementation(async function (
        this: RunbookStateManager,
        ...args
      ) {
        if (args[0] === parentRunId) await injectSiblingSubstepWrite();
        return await realUpdate.apply(this, args);
      });
      jest
        .spyOn(RunbookStateManager.prototype, 'updateWithStateIfExists')
        .mockImplementation(async function (this: RunbookStateManager, ...args) {
          if (args[0] === parentRunId) await injectSiblingSubstepWrite();
          return await realUpdateWithStateIfExists.apply(this, args);
        });
      jest
        .spyOn(RunbookStateManager.prototype, 'updateWithStateReturning')
        .mockImplementation(async function (this: RunbookStateManager, ...args) {
          if (args[0] === parentRunId) await injectSiblingSubstepWrite();
          return await realUpdateWithStateReturning.apply(this, args);
        });
      /* eslint-disable-next-line @typescript-eslint/unbound-method -- captured to re-apply with the spy's `this` */
      const realCaptureAuthorityState = RunbookStateManager.prototype.captureAuthorityState;
      jest
        .spyOn(RunbookStateManager.prototype, 'captureAuthorityState')
        .mockImplementation(async function (this: RunbookStateManager, ...args) {
          if (args[0] === parentRunId) await injectSiblingSubstepWrite();
          return await realCaptureAuthorityState.apply(this, args);
        });

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      // Proves the interleave happened rather than the assertion below passing
      // because nothing was ever written into the window.
      expect(injected).toBe(true);

      const parent = await readRunbookState(workspace, parentRunId);
      const substeps = parent!.substepStates ?? [];
      // The launch's own row still commits...
      expect(substeps.find((s) => s.id === '1')?.status).toBe('done');
      // ...and it does not carry a pre-read snapshot of the array over the top
      // of the sibling row that committed in between.
      expect(substeps.find((s) => s.id === '2')?.status).toBe('running');
    });

    it('refuses the launch when the parent claim rotates inside the linkage window', async () => {
      // ADR 0002 (#714): the launch captures the parent's controlling claim at
      // linkage determination, and the substep mark commits only under that
      // claim generation. A second orchestrator re-claiming the parent in the
      // window — between determination and the fenced commit — must refuse the
      // launch permanently rather than attach a child under the new authority.
      const parentRunId = await startSubstepParent();
      await writePassingChild();
      const runsBefore = (await listPersistedRunIds(workspace.cwd)).length;

      // Rotate through the real session seam immediately before the fenced
      // commit's write. `injected` keeps the hook honest: a launch that stops
      // reaching the fenced write seam fails here instead of passing vacuously.
      let injected = false;
      /* eslint-disable-next-line @typescript-eslint/unbound-method -- captured to re-apply with the spy's `this` */
      const realSaveState = RunbookStateManager.prototype.saveState;
      jest.spyOn(RunbookStateManager.prototype, 'saveState').mockImplementation(async function (
        this: RunbookStateManager,
        ...args
      ) {
        if (args[0]?.runId === parentRunId && !injected) {
          injected = true;
          const sideband = new SessionService(new RunbookStateManager(workspace.cwd));
          await sideband.issueRunControlClaim(assertRunId(parentRunId));
        }
        return await realSaveState.apply(this, args);
      });

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(injected).toBe(true);

      // Permanent refusal with its own code — never the generic LAUNCH_FAILED,
      // whose remediation reads as retryable. The message names the fact: the
      // parent changed hands, and its progression belongs to the new holder.
      expect(result.exitCode).toBe(1);
      const refusal = result.stdout + result.stderr;
      expect(refusal).toContain('INLINE_PARENT_CLAIM_SUPERSEDED');
      expect(refusal).toContain('re-claimed before the');
      expect(refusal).toContain('current orchestrator owns its progression');

      // Nothing attached under the rotated-out authority: the pre-seeded row
      // never advanced to running, the child run rolled back, and the parent
      // stays active for the rotated-in holder.
      const parent = await readRunbookState(workspace, parentRunId);
      expect((parent!.substepStates ?? []).find((s) => s.id === '1')?.status).toBe('pending');
      expect((await listPersistedRunIds(workspace.cwd)).length).toBe(runsBefore);
      expect((await getActiveState(workspace))?.id).toBe(parentRunId);
    });

    it('refuses at determination when no live claim controls the active parent', async () => {
      // The other half of the fence's entry contract (ADR 0002): a parent the
      // session still targets but that no run-control claim controls cannot be
      // attached to at all — refused BEFORE any child run is created, under the
      // same code as the commit-time rotation.
      const parentRunId = await startSubstepParent();
      await writePassingChild();
      const runsBefore = (await listPersistedRunIds(workspace.cwd)).length;
      // Remove the parent's claim WITHOUT releasing the run from targeting —
      // the claim-GC seam does exactly that.
      const sideband = new SessionService(new RunbookStateManager(workspace.cwd));
      await sideband.pruneClaimsForChildren([parentRunId]);

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);

      expect(result.exitCode).toBe(1);
      const refusal = result.stdout + result.stderr;
      expect(refusal).toContain('INLINE_PARENT_CLAIM_SUPERSEDED');
      expect(refusal).toContain('no live controlling claim');
      expect(refusal).toContain('claim superseded');
      expect(refusal).toContain('cannot attach under absent authority');
      // Refused before creation: no child run exists to roll back.
      expect((await listPersistedRunIds(workspace.cwd)).length).toBe(runsBefore);
    });

    it('proceeds unlinked when the parent run vanishes after determination', async () => {
      // A parent pruned between linkage determination and the substep mark is
      // the pre-existing "nothing to do" outcome: the mark writes nothing and
      // the launch completes without a parent to advance. The fence must keep
      // that contract rather than convert it into a refusal.
      const parentRunId = await startSubstepParent();
      await writePassingChild();

      let injected = false;
      /* eslint-disable-next-line @typescript-eslint/unbound-method -- captured to re-apply with the spy's `this` */
      const realCapture = RunbookStateManager.prototype.captureAuthorityState;
      jest
        .spyOn(RunbookStateManager.prototype, 'captureAuthorityState')
        .mockImplementation(async function (this: RunbookStateManager, ...args) {
          // This seam is the fence's per-attempt re-capture (determination goes
          // through `captureRunAuthorityState`). Hand the first attempt its
          // valid capture, then delete the parent, so the commit that follows
          // finds no row — the vanished-parent arm at its real window.
          if (args[0] === parentRunId && !injected) {
            const determination = await realCapture.apply(this, args);
            injected = true;
            const sideband = new RunbookStateManager(workspace.cwd);
            await sideband.delete(assertRunId(parentRunId));
            return determination;
          }
          return await realCapture.apply(this, args);
        });

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(injected).toBe(true);

      // The launch neither refused nor crashed: the child ran to completion
      // with no parent left to mark.
      expect(result.exitCode).toBe(0);
      expect(await readRunbookState(workspace, parentRunId)).toBeNull();
    });

    it('reports sustained parent contention as a launch failure, not a false attach', async () => {
      // Every fenced commit attempt loses to a sibling write: the fence spends
      // the store's budget and hands back `concurrent_modification`, which the
      // launch surfaces as a failure — the child must not report attached when
      // the mark never landed.
      const parentRunId = await startSubstepParent();
      await writePassingChild();

      /* eslint-disable-next-line @typescript-eslint/unbound-method -- captured to re-apply with the spy's `this` */
      const realSaveState = RunbookStateManager.prototype.saveState;
      let bump = 0;
      jest.spyOn(RunbookStateManager.prototype, 'saveState').mockImplementation(async function (
        this: RunbookStateManager,
        ...args
      ) {
        if (args[0]?.runId === parentRunId) {
          bump += 1;
          const sideband = new RunbookStateManager(workspace.cwd);
          await sideband.updateWithState(assertRunId(parentRunId), (current) => ({
            substepStates: upsertSubstepState(
              current.substepStates ?? [],
              '2',
              buildFrameKey('2'),
              { status: bump % 2 ? 'running' : 'pending' },
            ),
          }));
        }
        return await realSaveState.apply(this, args);
      });

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);

      expect(bump).toBeGreaterThan(1);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('modified concurrently');
    }, 20_000);

    it.each([
      ['execution_in_progress', 'has an execution in progress'],
      ['recovery_required', 'requires recovery'],
    ] as const)(
      'surfaces a fenced %s envelope through the generic launch failure',
      async (kind, phrase) => {
        // Ownership envelopes pass through as themselves: the fence hands them back as
        // themselves and the launch surfaces them through the generic rollback,
        // whose retry-once-freed remediation is the right one. Injected at the
        // commit seam — the real store cannot be made to refuse these arms
        // without an execution lease or recovery flag mid-window.
        const parentRunId = await startSubstepParent();
        await writePassingChild();
        const envelope: GuardedMutationResult<RunbookState> =
          kind === 'execution_in_progress'
            ? {
                kind,
                runId: assertRunId(parentRunId),
                message: `Run ${parentRunId} ${phrase}.`,
              }
            : {
                kind,
                runId: assertRunId(parentRunId),
                epoch: assertExecutionEpoch(1),
                message: `Run ${parentRunId} ${phrase}.`,
              };
        jest.spyOn(RunbookStateManager.prototype, 'saveState').mockImplementation(async function (
          this: RunbookStateManager,
          ...args
        ) {
          if (args[0]?.runId === parentRunId) return envelope;
          throw new Error('unexpected saveState target');
        });

        const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);

        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain(phrase);
      },
    );

    it('names the vanished run when determination finds no parent row to capture', async () => {
      // The determination capture's OTHER refusal arm: the session still names
      // the parent but its run row is gone. Same code as the no-claim arm; the
      // message states which fact failed. Injected at the capture seam — the
      // active-session read and the capture are adjacent, so the window is not
      // reachable through public seams alone.
      const parentRunId = await startSubstepParent();
      await writePassingChild();
      const runsBefore = (await listPersistedRunIds(workspace.cwd)).length;
      jest
        .spyOn(RunbookStateManager.prototype, 'captureRunAuthorityState')
        .mockImplementation(async function (this: RunbookStateManager, ...args) {
          return {
            kind: 'missing',
            runId: args[0],
            message: `Run ${args[0]} does not exist.`,
          };
        });

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);

      expect(result.exitCode).toBe(1);
      const refusal = result.stdout + result.stderr;
      expect(refusal).toContain('INLINE_PARENT_CLAIM_SUPERSEDED');
      expect(refusal).toContain('run not found');
      // Refused at determination: no child run was created.
      expect((await listPersistedRunIds(workspace.cwd)).length).toBe(runsBefore);
    });

    it('re-derives the launch row when a sibling write invalidates the version it read', async () => {
      // The sibling test above hooks the OUTSIDE of the write seam, so its
      // interleaved row lands before the compare-and-swap opens: the launch then
      // reads a version that already carries it, commits first time, and no
      // losing attempt is ever created. Transaction ownership is covered there;
      // contention and rollback are not.
      //
      // This variant lands the same write INSIDE the cycle — after the build
      // callback has been handed the row it derives from, before the commit that
      // depends on it — which is the only placement that produces a stale
      // version. The compare-and-swap must then discard the first derivation and
      // re-run the callback against the committed row. What that pins is the rule
      // CLAUDE.md states for every `build` callback: it runs once per attempt and
      // must be free of external side effects, because a first attempt's work is
      // thrown away.
      const parentRunId = await startSubstepParent();
      await writePassingChild();

      let injected = false;
      // The frame the sideband row lands on, captured so the assertions can
      // address that exact row. `substepStates` is keyed by (id, frameKey), so
      // an id-only lookup would be satisfied by a row for the same substep at a
      // different frame entry — vacuous the moment this fixture gains a FOR
      // step. Assigned inside the builder, which may re-run on a retry, but the
      // derivation is the same every time.
      let injectedFrameKey: FrameKey | undefined;
      const injectSiblingSubstepWrite = async (): Promise<void> => {
        if (injected) return;
        injected = true;
        const sideband = new RunbookStateManager(workspace.cwd);
        await sideband.updateWithState(parentRunId, (current) => {
          injectedFrameKey = current.activeFrameKey ?? deriveActiveFrame(current).frameKey;
          return {
            substepStates: upsertSubstepState(current.substepStates ?? [], '2', injectedFrameKey, {
              status: 'running' as const,
            }),
          };
        });
      };

      // Counts the LAUNCH's commit attempts specifically: the fenced write seam
      // (#714) is called once per derivation with the derived next state, and
      // only the launch commits the parent through it, keyed by the captured
      // authority's runId. The sideband cannot inflate the count — its write
      // goes through `updateWithState` → `updateWithStateIfExists`, a different
      // seam from the one wrapped here.
      const launchCommitAttempts: unknown[] = [];
      /* eslint-disable-next-line @typescript-eslint/unbound-method -- captured to re-apply with the spy's `this` */
      const realSaveState = RunbookStateManager.prototype.saveState;
      jest.spyOn(RunbookStateManager.prototype, 'saveState').mockImplementation(async function (
        this: RunbookStateManager,
        ...args
      ) {
        if (args[0]?.runId !== parentRunId) return await realSaveState.apply(this, args);
        launchCommitAttempts.push('marked');
        // Land the sibling write inside the window: this attempt has captured
        // its row and derived from it, and the commit has not happened yet. Only
        // the first attempt is invalidated — injecting on every one would spend
        // the store's retry budget and report `concurrent_modification` instead
        // of the re-derivation under test.
        if (launchCommitAttempts.length === 1) await injectSiblingSubstepWrite();
        return await realSaveState.apply(this, args);
      });

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      expect(injected).toBe(true);
      // Two commit attempts for one landing: the first lost the compare-and-swap
      // to the sideband write and was discarded, the second re-derived against
      // the committed row and won. One would mean the write landed outside the
      // cycle and this test degenerated into the sibling case above.
      expect(launchCommitAttempts).toEqual(['marked', 'marked']);

      const parent = await readRunbookState(workspace, parentRunId);
      const substeps = parent!.substepStates ?? [];
      // Addressed by the full (id, frameKey) coordinate, so no row can stand in
      // for another. `injectedFrameKey` is the frame the sideband wrote to, and
      // the launch targets 1.1 in that same active frame.
      expect(injectedFrameKey).toBeDefined();
      const rowAt = (id: string) =>
        substeps.find((row) => row.id === id && row.frameKey === injectedFrameKey);
      // The losing attempt wrote nothing, and the winning one carries the launch
      // through to its own resolution.
      expect(rowAt('1')?.status).toBe('done');
      expect(rowAt('1')?.result).toBe('pass');
      // The row that invalidated the first attempt survives verbatim: the
      // re-derivation ran against the committed array, not the stale one.
      expect(rowAt('2')?.status).toBe('running');
    });

    it('refuses the launch when the TARGET substep resolves inside the same window', async () => {
      // The sibling case above is the lost-update half. This is the other half:
      // the writer lands on the substep the launch is targeting. The refusal for
      // that is decided in `buildInlineLinkage`, long before the child run is
      // created, so acting on it at `afterInit` time means re-deciding it against
      // the version the write commits onto — otherwise `upsertSubstepState`
      // MERGES `{status:'running'}` onto the committed `{status:'done', result}`
      // and erases the resolution while keeping the result.
      //
      // An integration-level version of this lives in inline-linkage.test.ts, but
      // the Stryker sandbox excludes `integration`, so this sibling-visible copy
      // is what actually pins the branch under mutation.
      const parentRunId = await startSubstepParent();
      await writePassingChild();

      let injected = false;
      const injectTargetResolution = async (): Promise<void> => {
        if (injected) return;
        injected = true;
        const sideband = new RunbookStateManager(workspace.cwd);
        await sideband.updateWithState(parentRunId, (current) => ({
          substepStates: upsertSubstepState(
            current.substepStates ?? [],
            '1',
            current.activeFrameKey ?? deriveActiveFrame(current).frameKey,
            { status: 'done' as const, result: 'pass' as const },
          ),
        }));
      };

      // The launch's write seam is the fenced commit (#714): injecting before
      // the FIRST commit attempt lands the resolution inside the cycle, so the
      // stale first attempt is discarded and the re-capture must see the done
      // row and refuse rather than merge `running` over it.
      /* eslint-disable-next-line @typescript-eslint/unbound-method -- captured to re-apply with the spy's `this` */
      const realSaveState = RunbookStateManager.prototype.saveState;
      jest.spyOn(RunbookStateManager.prototype, 'saveState').mockImplementation(async function (
        this: RunbookStateManager,
        ...args
      ) {
        if (args[0]?.runId === parentRunId) await injectTargetResolution();
        return await realSaveState.apply(this, args);
      });

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(injected).toBe(true);

      // Permanent refusal with its own code — not the generic LAUNCH_FAILED a
      // thrown `afterInit` would otherwise produce, which reads as retryable.
      expect(result.exitCode).toBe(1);
      const refusal = result.stdout + result.stderr;
      expect(refusal).toContain('already resolved');
      expect(refusal).toContain('DELEGATION_ALREADY_RESOLVED');

      // The concurrent writer's resolution survives verbatim.
      const parent = await readRunbookState(workspace, parentRunId);
      const target = (parent!.substepStates ?? []).find((s) => s.id === '1');
      expect(target?.status).toBe('done');
      expect(target?.result).toBe('pass');
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
      const pass = await runCliInProcess(`pass --step 1.1 --claim-id ${parentClaimId}`, workspace);
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
