import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  activeFrame,
  buildFrameKey,
  buildCompletionKey,
  COLLECT_REQUIRES_ORCHESTRATOR_MESSAGE,
  type FrameKey,
} from '@rundown-org/core';
// Static import of the command module under test. The behavioural tests below
// drive the command through `runCliInProcess`, which reaches it via a *dynamic*
// `import('../cli.js')` — an edge Stryker's `enableFindRelatedTests` (Jest's
// static inverse-module graph) cannot see. Without a static import here, a
// per-mutant `jest --findRelatedTests src/commands/collect.ts` matches no test
// file, so Stryker runs zero tests per mutant and every mutant falsely survives
// (0.00% score). This static edge links the file into the graph so the covering
// tests actually run against each mutant.
import { registerCollectCommand } from '../../src/commands/collect.js';
import {
  createTestWorkspace,
  createRunbook,
  runCli,
  runCliInProcess,
  getActiveState,
  withRunTarget,
  getAllStates,
  readRunbookState,
  parseConcatenatedJson,
  findActionOutput,
  readSession,
  writeSession,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import type { RunbookState } from '@rundown-org/core';
import { CollectResponseSchema } from '../../src/schemas/output-schemas.js';

interface SubstepState {
  id: string;
  frameKey: string;
  status: 'pending' | 'running' | 'done';
  result?: 'pass' | 'fail';
  delegation?: Record<string, unknown>;
}

interface ResolvedCompletion {
  agentId: string;
  result: 'pass' | 'fail';
  targetStep: string;
  targetSubstep?: string;
  targetFrameKey: string;
  targetEntry: number;
  completedAt: string;
}

interface MutableRunbookState {
  id: string;
  step: string;
  substep?: string;
  activeFrameKey?: string;
  activeEntry?: number;
  substepStates?: SubstepState[];
  resolvedCompletions?: Record<string, ResolvedCompletion>;
  [key: string]: unknown;
}

function findCollectOutput(stdout: string, status?: string): Record<string, unknown> {
  const output = parseConcatenatedJson(stdout).find((event) => {
    if (!event || typeof event !== 'object') return false;
    const record = event as Record<string, unknown>;
    return record.kind === 'collect' && (status === undefined || record.status === status);
  });
  if (!output || typeof output !== 'object') {
    throw new Error(`Expected collect${status ? ` ${status}` : ''} output.`);
  }
  return output as Record<string, unknown>;
}

/**
 * Hand-write `substepStates` and `resolvedCompletions` directly onto persisted
 * run state to simulate the "children have finished but the parent hasn't
 * aggregated yet" scenario.
 *
 * WARNING — schema-coupled helper:
 *   This bypasses `rd claim` + `rd pass`/`rd fail` and writes to the
 *   persisted state schema directly. Frame and completion keys are built
 *   via the canonical `buildFrameKey` / `buildCompletionKey` helpers from
 *   `@rundown-org/core` so the shape stays aligned with the runtime. The
 *   project's "never migrate state" rule means any refactor to the
 *   `substepStates` / `resolvedCompletions` shape will silently break
 *   these tests. Prefer the CLI-driven flow (see the `end-to-end CLI flow`
 *   describe block below) whenever possible.
 *
 *   This shortcut sets up the "outcomes resolved but not yet collected"
 *   precondition by writing state directly, so the aggregation code path can be
 *   exercised in isolation without driving the full `rd claim` + `rd pass`
 *   pipeline. Under report-then-collect the delegated close path is report-only
 *   (it never drains/aggregates), so the end-to-end flow also reaches this
 *   collection-pending state — see the `end-to-end CLI flow` describe block,
 *   which drives it through the CLI as the schema-coupling canary.
 *
 * @param workspace - Test workspace (used to locate state files)
 * @param runbookId - Parent run identifier
 * @param results - Ordered substep results; writes substeps 1..N
 */
async function markSubstepsResolved(
  workspace: TestWorkspace,
  runbookId: string,
  results: ('pass' | 'fail')[],
): Promise<void> {
  const statePath = join(workspace.statePath(), `${runbookId}.json`);
  const raw = JSON.parse(await readFile(statePath, 'utf-8')) as MutableRunbookState;

  const frameKey = (raw.activeFrameKey ?? buildFrameKey(raw.step)) as FrameKey;
  const entry = raw.activeEntry ?? 1;

  // Preserve the delegation records that `run --prompted` auto-issued onto the
  // DELEGATE substeps. A real resolved DELEGATE substep retains its delegation;
  // dropping it here would produce state a real run never has and would mask the
  // signal `rd collect` uses to distinguish idempotent re-collect from misuse.
  const priorSubsteps = raw.substepStates ?? [];
  const substepStates: SubstepState[] = results.map((result, i) => {
    const id = String(i + 1);
    const prior = priorSubsteps.find((ss) => ss.id === id);
    return {
      id,
      frameKey,
      status: 'done',
      result,
      ...(prior?.delegation !== undefined ? { delegation: prior.delegation } : {}),
    };
  });

  const resolvedCompletions: Record<string, ResolvedCompletion> = {};
  for (let i = 0; i < results.length; i++) {
    const substepId = String(i + 1);
    const key = buildCompletionKey(activeFrame(frameKey, entry), substepId);
    resolvedCompletions[key] = {
      agentId: 'manual',
      result: results[i],
      targetStep: raw.step,
      targetSubstep: substepId,
      targetFrameKey: frameKey,
      targetEntry: entry,
      completedAt: new Date().toISOString(),
    };
  }

  raw.substepStates = substepStates;
  raw.resolvedCompletions = resolvedCompletions;
  await writeFile(statePath, JSON.stringify(raw, null, 2));
}

describe('collect command wiring', () => {
  it('registers the collect command with its documented flags and descriptions', () => {
    const program = new Command();
    registerCollectCommand(program);

    const collect = program.commands.find((c) => c.name() === 'collect');
    expect(collect).toBeDefined();
    expect(collect?.description()).toBe(
      'Collect delegation results and fire aggregation transition',
    );

    const byLong = new Map(collect!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(
      expect.arrayContaining(['--step', '--index', '--claim-id', '--text']),
    );

    // Pin each option's help text so a mutated description string is killed.
    expect(byLong.get('--step')?.description).toBe(
      'Target specific DELEGATE step scope (e.g., "1" or "1.2")',
    );
    expect(byLong.get('--index')?.description).toBe(
      'FOR loop iteration to target (requires --step on a FOR step)',
    );
    expect(byLong.get('--claim-id')?.description).toBe('Target a claimed delegated child runbook');
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
  });
});

describe('collect command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /**
   * Build a parent runbook with a step containing DELEGATE substeps.
   *
   * The parent has:
   *  - step 1 with two DELEGATE substeps (1.1, 1.2), PASS ALL CONTINUE / FAIL ANY STOP
   *  - step 2 as the next step after step 1
   */
  function buildParentDelegateMarkdown(): string {
    return [
      '# Parent',
      '',
      '## 1. Fan-out',
      '',
      '- DELEGATE',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Task A',
      '',
      '- child.runbook.md',
      '',
      '### 1.2 Task B',
      '',
      '- child.runbook.md',
      '',
      '## 2. Done',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      'Finished.',
      '',
      '```bash',
      'rd echo --result pass',
      '```',
      '',
    ].join('\n');
  }

  /**
   * Set up a DELEGATE parent runbook started in prompted mode, then hand-write
   * its substeps resolved in persisted state so `rd collect` has all the
   * information it needs to fire the aggregation — bypassing the
   * auto-propagation path that `rd claim` + `rd pass` would trigger.
   */
  async function setupReadyToCollect(results: ('pass' | 'fail')[]): Promise<string> {
    // Child runbook (referenced by both DELEGATE substeps)
    const childContent = createRunbook({
      title: 'Child',
      steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

    // Parent runbook with DELEGATE substeps
    const parentContent = buildParentDelegateMarkdown();
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    // Start parent in prompted mode — enters step 1, auto-issues tokens,
    // waits at substep 1.1.
    const startResult = await runCliInProcess(
      'run --prompted runbooks/parent.runbook.md --text',
      workspace,
    );
    expect(startResult.exitCode).toBe(0);

    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    const runbookId = state!.id;

    // Mark substeps resolved without going through rd claim / rd pass.
    await markSubstepsResolved(workspace, runbookId, results);

    return runbookId;
  }

  describe('command policy', () => {
    it('accepts rd collect --claim-id and routes it through the orchestrator gate', async () => {
      const parentContent = createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Delegate child',
            pass: 'CONTINUE',
            substeps: [
              { title: 'Child work', delegate: true, runbooks: ['runbooks/child.runbook.md'] },
            ],
          },
        ],
      });
      const childContent = createRunbook({
        title: 'Child',
        steps: [{ title: 'Work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

      const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const frontier = parseConcatenatedJson(start.stdout).flatMap((event) => {
        if (event && typeof event === 'object' && 'delegateFrontier' in event) {
          return (event as { delegateFrontier?: Array<{ token?: string }> }).delegateFrontier ?? [];
        }
        return [];
      });
      const token = frontier[0]?.token;
      expect(token).toBeDefined();
      const claim = await runCliInProcess(['claim', token!], workspace);
      expect(claim.exitCode).toBe(0);
      const claimPayload = findActionOutput(claim.stdout);
      const claimId = String(claimPayload?.claim_id);
      expect(claimId).toMatch(/^rdclm_/);

      // `rd collect --claim-id` must NOT be rejected by the orchestrator gate:
      // the direct-CLI adapter resolves the claim to its controlled run and is
      // the trusted controller of that run. The command therefore proceeds past
      // the policy gate (it must not emit ACTOR_CONTEXT_REQUIRED or
      // COLLECT_REQUIRES_ORCHESTRATOR). Whether outcomes exist to aggregate is
      // the collection operation's concern (Plan 4), so this test asserts only
      // that the policy gate did not refuse the command.
      const result = await runCliInProcess(['collect', '--claim-id', claimId], workspace);

      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).not.toBe('ACTOR_CONTEXT_REQUIRED');
      expect(payload.code).not.toBe('COLLECT_REQUIRES_ORCHESTRATOR');
    }, 30_000);

    it('allows collection on a run that itself delegates upward', async () => {
      const parentContent = createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Delegate child',
            pass: 'CONTINUE',
            substeps: [
              { title: 'Child work', delegate: true, runbooks: ['runbooks/child.runbook.md'] },
            ],
          },
        ],
      });
      const childContent = createRunbook({
        title: 'Child',
        steps: [{ title: 'Work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

      const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const frontier = parseConcatenatedJson(start.stdout).flatMap((event) => {
        if (event && typeof event === 'object' && 'delegateFrontier' in event) {
          return (event as { delegateFrontier?: Array<{ token?: string }> }).delegateFrontier ?? [];
        }
        return [];
      });
      const token = frontier[0]?.token;
      expect(token).toBeDefined();
      const claim = await runCliInProcess(['claim', token!], workspace);
      expect(claim.exitCode).toBe(0);
      const claimPayload = findActionOutput(claim.stdout);
      const childRunId = String(claimPayload?.run_id);
      // Make the claimed child the active run by hand: no CLI command promotes a
      // claimed child onto the default stack while leaving its parent claim
      // intact, so we cannot reach this "active run is itself delegated upward"
      // configuration through the CLI alone. We preserve the existing claims so
      // the upward delegation linkage the gate must tolerate stays in place.
      const session = await readSession(workspace);
      await writeSession(workspace, {
        defaultStack: [childRunId],
        claims: session.claims,
      });

      // The active run is itself delegated upward. Under the target-relative
      // model the orchestrator gate must NOT reject it as a collection target —
      // but post-R1 the orchestrator must NAME the run it collects: the child
      // is delegation-linked (clause e), so a bare collect is refused.
      const bare = await runCliInProcess(['collect'], workspace);
      const bareEnvelope = JSON.parse(bare.stdout) as { code?: string };
      expect(bareEnvelope.code).toBe('ACTOR_CONTEXT_REQUIRED');

      const result = await runCliInProcess(['collect', '--run', childRunId], workspace);

      const payload = JSON.parse(result.stdout) as { code?: string };
      // Pin the full outcome, not just the absence of the two gate refusals:
      // the named child has no delegations of its own to collect, so the only
      // acceptable result is the benign no-delegate-step error — any authority
      // refusal or unexpected failure must fail this test.
      expect(result.exitCode).not.toBe(0);
      expect(payload.code).toBe('NOT_DELEGATE_STEP');
    }, 30_000);
  });

  describe('--run explicit targeting', () => {
    it('collects the named delegating parent via collect --run <parentId>', async () => {
      const runbookId = await setupReadyToCollect(['pass', 'pass']);

      const result = await runCliInProcess(['collect', '--run', runbookId], workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('2');
    });

    it('refuses a well-formed but unknown --run id with RUN_TARGET_UNAVAILABLE', async () => {
      await setupReadyToCollect(['pass', 'pass']);
      const bogus = `rd_${'f'.repeat(32)}`;

      const result = await runCliInProcess(['collect', '--run', bogus], workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).toBe('RUN_TARGET_UNAVAILABLE');
      // The refusal collected nothing.
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('1');
    });

    it('names the --run remediation in the orchestrator-gate refusal message', () => {
      // The COLLECT_REQUIRES_ORCHESTRATOR envelope must point at BOTH explicit
      // authority lanes and never echo a run id (decision 4).
      expect(COLLECT_REQUIRES_ORCHESTRATOR_MESSAGE).toContain('--run');
      expect(COLLECT_REQUIRES_ORCHESTRATOR_MESSAGE).toContain('--claim-id');
      expect(COLLECT_REQUIRES_ORCHESTRATOR_MESSAGE).not.toMatch(/rd_[a-f0-9]{32}/);
    });
  });

  describe('successful aggregation', () => {
    it('fires CONTINUE and advances to next step when PASS ALL passes', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      const result = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);

      expect(result.exitCode).toBe(0);

      // After collect, parent should have advanced to step 2.
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('2');
    });

    it('fires STOP and halts when FAIL ANY and a substep failed', async () => {
      await setupReadyToCollect(['pass', 'fail']);

      const result = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);

      // Parent should have stopped (non-zero exit).
      expect(result.exitCode).not.toBe(0);

      // State should be marked as stopped.
      const statePath = join(workspace.statePath());
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(statePath);
      const stateFile = files.find((f) => f.endsWith('.json'));
      expect(stateFile).toBeDefined();
      const stateJson = JSON.parse(await readFile(join(statePath, stateFile!), 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(stateJson.lifecycle).toBe('stopped');
    });

    /**
     * Issue 4 coverage: prove the aggregation code path actually runs.
     *
     * With `FAIL ANY STOP` aggregation and mixed pass/fail results, the run must
     * reach a terminal `stopped` lifecycle — a per-substep DEFER would leave it
     * `running`. `rd collect` can stream transition observations around the
     * typed outcome, so aggregation is pinned via the `status: 'applied'`
     * envelope's `lifecycle: 'stopped'` and the non-zero exit.
     */
    it('drives the run to a stopped lifecycle when FAIL ANY aggregation fires', async () => {
      await setupReadyToCollect(['pass', 'fail']);

      const result = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);

      // FAIL ANY STOP aggregation on a mixed result stops the runbook.
      expect(result.exitCode).not.toBe(0);

      const parsed = findCollectOutput(result.stdout, 'applied');
      expect(parsed).toMatchObject({
        kind: 'collect',
        action: 'collect',
        status: 'applied',
        lifecycle: 'stopped',
      });
      expect(CollectResponseSchema.safeParse(parsed).success).toBe(true);

      // `streamAppliedObservations` must forward the aggregation's terminal
      // `RUNBOOK_STOPPED` observation onto the output stream as a
      // `runbook_stopped` execution event. Asserting it appears pins the
      // RUNBOOK_STOPPED case arm (a dropped/mislabelled case suppresses it).
      const streamedTypes = parseConcatenatedJson(result.stdout)
        .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
        .map((o) => o.type)
        .filter((t): t is string => typeof t === 'string');
      expect(streamedTypes).toContain('runbook_stopped');
    });
  });

  describe('applied JSON contract', () => {
    /**
     * Pin the explicit `status: 'applied'` success envelope emitted by a bare
     * `rd collect` (JSON default mode). With `PASS ALL CONTINUE` and two passing
     * substeps the aggregation fires CONTINUE and the run stays `running` on the
     * advanced step — observed values: applied 2, unresolved 0, lifecycle
     * 'running', reportedTerminalOutcome false, exit 0.
     */
    it('emits an applied JSON envelope for a successful bare collect', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      const result = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);
      expect(result.exitCode).toBe(0);

      const parsed = findCollectOutput(result.stdout, 'applied');
      expect(parsed).toMatchObject({
        kind: 'collect',
        action: 'collect',
        status: 'applied',
        applied: 2,
        unresolved: 0,
        lifecycle: 'running',
        reportedTerminalOutcome: false,
      });
      expect(parsed.parentRunId).toMatch(/^rd_[a-f0-9]{32}$/);
      expect(CollectResponseSchema.safeParse(parsed).success).toBe(true);
    });
  });

  describe('already-aggregated behavior', () => {
    /**
     * Additive contract: the second bare `collect` (JSON mode) reports the
     * idempotent no-op as `status: 'already-aggregated'` AND carries the new
     * `code: 'COLLECT_ALREADY_APPLIED'` annotation. Exit 0; schema accepts it.
     */
    it('emits already-aggregated JSON with COLLECT_ALREADY_APPLIED code on the second invocation', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      const first = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);
      expect(first.exitCode).toBe(0);
      expect((await getActiveState(workspace))?.step).toBe('2');

      const second = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);
      expect(second.exitCode).toBe(0);

      const json = parseConcatenatedJson(second.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({
        kind: 'collect',
        action: 'collect',
        status: 'already-aggregated',
        code: 'COLLECT_ALREADY_APPLIED',
      });
      expect(typeof json.parentRunId).toBe('string');
      expect(CollectResponseSchema.safeParse(json).success).toBe(true);
    });

    /**
     * Running `rd collect` twice must surface a visible, non-error outcome.
     * After the first collect succeeds (parent advances to step 2), the
     * second call has no unapplied completions — the command emits an
     * `already-aggregated` status and exits 0.
     */
    it('emits an already-aggregated status on the second invocation', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      // First collect: fires aggregation, advances to step 2.
      const first = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);
      expect(first.exitCode).toBe(0);

      const after = await getActiveState(workspace);
      expect(after?.step).toBe('2');

      // Second (bare) collect on step 2 — the cursor advanced past the
      // DELEGATE step, so aggregation already fired. Bare collect infers the
      // cursor and reports an idempotent already-aggregated no-op (exit 0)
      // rather than the NOT_DELEGATE_STEP error.
      const second = await runCliInProcess(
        await withRunTarget(['collect', '--text'], workspace),
        workspace,
      );
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toMatch(/already aggregated/i);
    });

    it('bare rd collect after auto-aggregation returns already-aggregated, not NOT_DELEGATE_STEP', async () => {
      await setupReadyToCollect(['pass', 'pass']);
      const first = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);
      expect(first.exitCode).toBe(0);
      expect((await getActiveState(workspace))?.step).toBe('2');

      const result = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);

      expect(result.exitCode).toBe(0);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'collect', status: 'already-aggregated' });
    });

    it('rd collect --step <non-delegate> still errors NOT_DELEGATE_STEP', async () => {
      await setupReadyToCollect(['pass', 'pass']);
      const first = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);
      expect(first.exitCode).toBe(0);
      expect((await getActiveState(workspace))?.step).toBe('2');

      const result = await runCliInProcess(
        await withRunTarget(['collect', '--step', '2'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'error', code: 'NOT_DELEGATE_STEP' });
    });

    it('bare rd collect on a runbook that never delegates errors NOT_DELEGATE_STEP', async () => {
      // Regression: the idempotent already-aggregated path must require evidence
      // of prior delegation. A runbook with no DELEGATE substeps has never
      // aggregated anything, so bare `rd collect` on its plain cursor is genuine
      // misuse and must still error — not be masked as already-aggregated.
      const content = createRunbook({
        title: 'No Delegation',
        steps: [
          { title: 'First', pass: 'CONTINUE', content: 'No delegation here.' },
          { title: 'Second', pass: 'COMPLETE', content: 'Still no delegation.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'plain.runbook.md'), content);
      const start = await runCliInProcess(
        'run --prompted runbooks/plain.runbook.md --text',
        workspace,
      );
      expect(start.exitCode).toBe(0);

      const result = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);

      expect(result.exitCode).toBe(1);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'error', code: 'NOT_DELEGATE_STEP' });
    });

    /**
     * Direct coverage for the `applied === 0` branch on a DELEGATE step:
     * if all completions have been drained (but the cursor is still on the
     * DELEGATE step for some reason), `rd collect` returns a visible
     * already-aggregated status with exit 0.
     */
    it('emits already-aggregated when no completions are pending on a DELEGATE step', async () => {
      const runbookId = await setupReadyToCollect(['pass', 'pass']);

      // Clear resolvedCompletions so drain has nothing to apply. Leave
      // substepStates[].status='done' so the resolved-substep precondition
      // still passes.
      const statePath = join(workspace.statePath(), `${runbookId}.json`);
      const raw = JSON.parse(await readFile(statePath, 'utf-8')) as MutableRunbookState;
      raw.resolvedCompletions = {};
      await writeFile(statePath, JSON.stringify(raw, null, 2));

      const result = await runCliInProcess(
        await withRunTarget(['collect', '--text'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/already aggregated/i);
    });

    /**
     * Same as above, but asserts the JSON shape for the default output mode.
     */
    it('emits already-aggregated JSON when no completions are pending', async () => {
      const runbookId = await setupReadyToCollect(['pass', 'pass']);

      const statePath = join(workspace.statePath(), `${runbookId}.json`);
      const raw = JSON.parse(await readFile(statePath, 'utf-8')) as MutableRunbookState;
      raw.resolvedCompletions = {};
      await writeFile(statePath, JSON.stringify(raw, null, 2));

      const result = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);

      expect(result.exitCode).toBe(0);
      // JSON output is pretty-printed; parse the whole payload.
      const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      expect(parsed.status).toBe('already-aggregated');
      expect(parsed.action).toBe('collect');
      expect(parsed.kind).toBe('collect');
      expect(CollectResponseSchema.safeParse(parsed).success).toBe(true);
    });

    /**
     * Issue #397 regression: the idempotent `already-aggregated` no-op must be
     * narrowed to the genuine post-aggregation successor (the step the cursor
     * advanced onto directly off the DELEGATE step). Once the cursor moves on
     * to an ordinary, unrelated non-DELEGATE step, a bare `rd collect` is
     * misuse and must error `NOT_DELEGATE_STEP` — not be masked as
     * already-aggregated merely because a delegation record exists somewhere
     * earlier in `substepStates`.
     */
    it('bare rd collect on an ordinary step further past the aggregated DELEGATE step errors NOT_DELEGATE_STEP', async () => {
      // Child runbook referenced by the DELEGATE substeps.
      const childContent = createRunbook({
        title: 'Child',
        steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

      // Parent: DELEGATE at step 1, then TWO ordinary steps (2 and 3).
      // Step 2 is the legitimate aggregation successor; step 3 is unrelated.
      const parentContent = [
        '# Parent',
        '',
        '## 1. Fan-out',
        '',
        '- DELEGATE',
        '- PASS ALL CONTINUE',
        '- FAIL ANY STOP',
        '',
        '### 1.1 Task A',
        '',
        '- child.runbook.md',
        '',
        '## 2. Middle',
        '',
        '- PASS CONTINUE',
        '- FAIL STOP',
        '',
        'Middle step.',
        '',
        '## 3. Done',
        '',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        'Finished.',
        '',
      ].join('\n');
      await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

      const start = await runCliInProcess(
        'run --prompted runbooks/parent.runbook.md --text',
        workspace,
      );
      expect(start.exitCode).toBe(0);
      const runbookId = (await getActiveState(workspace))!.id;

      // Mark the single DELEGATE substep resolved and aggregate to step 2.
      await markSubstepsResolved(workspace, runbookId, ['pass']);
      const collect1 = await runCliInProcess(
        await withRunTarget(['collect'], workspace),
        workspace,
      );
      expect(collect1.exitCode).toBe(0);
      expect((await getActiveState(workspace))?.step).toBe('2');

      // Advance the cursor off the aggregation successor to an unrelated step.
      const pass2 = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
      expect(pass2.exitCode).toBe(0);
      expect((await getActiveState(workspace))?.step).toBe('3');

      // Bare collect on step 3 — NOT the aggregation successor. Must error.
      const result = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);
      expect(result.exitCode).toBe(1);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'error', code: 'NOT_DELEGATE_STEP' });
    });
  });

  describe('missing-step / stale state', () => {
    /**
     * Regression: bare `rd collect` must NOT collapse a missing step into the
     * idempotent `already-aggregated` success path. When persisted `state.step`
     * names a step absent from the loaded runbook (stale/corrupted state), the
     * command must fail fast with `STEP_NOT_FOUND` rather than masking the
     * invalid state as a healthy no-op. See `pop.ts` for the same guard.
     */
    it('bare rd collect fails fast when state.step is missing from the runbook (not already-aggregated)', async () => {
      const runbookId = await setupReadyToCollect(['pass', 'pass']);

      const statePath = join(workspace.statePath(), `${runbookId}.json`);
      const raw = JSON.parse(await readFile(statePath, 'utf-8')) as MutableRunbookState;
      raw.step = '99'; // not present in the parent runbook (steps are '1' / '2')
      await writeFile(statePath, JSON.stringify(raw, null, 2));

      const result = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);

      expect(result.exitCode).toBe(1);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'error', code: 'STEP_NOT_FOUND' });
    });

    it('bare rd collect --text reports the missing step instead of "already aggregated"', async () => {
      const runbookId = await setupReadyToCollect(['pass', 'pass']);

      const statePath = join(workspace.statePath(), `${runbookId}.json`);
      const raw = JSON.parse(await readFile(statePath, 'utf-8')) as MutableRunbookState;
      raw.step = '99';
      await writeFile(statePath, JSON.stringify(raw, null, 2));

      const result = await runCliInProcess(
        await withRunTarget(['collect', '--text'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const out = result.stdout + result.stderr;
      expect(out).toMatch(/not found/i);
      expect(out).not.toMatch(/already aggregated/i);
    });

    it('rd collect --step <missing> reports STEP_NOT_FOUND, not NOT_DELEGATE_STEP', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      const result = await runCliInProcess(
        await withRunTarget(['collect', '--step', '99'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'error', code: 'STEP_NOT_FOUND' });
    });
  });

  describe('not-active behavior', () => {
    /**
     * When `--step` targets a frame other than the cursor's active frame, the
     * drain refuses to dispatch and returns `not_active`. `rd collect` must
     * surface this as a visible JSON payload with the requested and active
     * frame keys — never an empty silent success.
     */
    it('emits a not-active JSON payload when --step --index targets a non-active iteration', async () => {
      const runbookId = await setupReadyToCollect(['pass', 'pass']);

      // Rewrite substepStates to be in frame `1|99` (iteration 99) while the
      // cursor stays on the active step-1 frame. `--step 1.1 --index 99` then
      // resolves to scope.frameKey `1|99` which differs from the cursor's
      // active frame — drain returns `not_active`.
      const statePath = join(workspace.statePath(), `${runbookId}.json`);
      const raw = JSON.parse(await readFile(statePath, 'utf-8')) as MutableRunbookState;
      const overrideFrame = buildFrameKey('1', 99);
      if (raw.substepStates) {
        raw.substepStates = raw.substepStates.map((ss) => ({ ...ss, frameKey: overrideFrame }));
      }
      await writeFile(statePath, JSON.stringify(raw, null, 2));

      const result = await runCliInProcess(
        await withRunTarget(['collect', '--step', '1.1', '--index', '99'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      expect(parsed.kind).toBe('collect');
      expect(parsed.action).toBe('collect');
      expect(parsed.status).toBe('not-active');
      expect(parsed.step).toBe('1');
      expect(parsed.parentRunId).toBe(runbookId);
      expect(parsed.frameKey).toBe(overrideFrame);
      expect(typeof parsed.activeFrameKey).toBe('string');
      expect(parsed.activeFrameKey).not.toBe(overrideFrame);
      expect(typeof parsed.unresolved).toBe('number');
      expect(CollectResponseSchema.safeParse(parsed).success).toBe(true);
    });

    /**
     * The `--text` rendering of the not-active outcome: it must report the
     * requested vs active frame keys in the human-readable "Frame not active"
     * message rather than the JSON payload.
     */
    it('reports a frame-not-active message in --text mode', async () => {
      const runbookId = await setupReadyToCollect(['pass', 'pass']);

      const statePath = join(workspace.statePath(), `${runbookId}.json`);
      const raw = JSON.parse(await readFile(statePath, 'utf-8')) as MutableRunbookState;
      const overrideFrame = buildFrameKey('1', 99);
      if (raw.substepStates) {
        raw.substepStates = raw.substepStates.map((ss) => ({ ...ss, frameKey: overrideFrame }));
      }
      await writeFile(statePath, JSON.stringify(raw, null, 2));

      const result = await runCliInProcess(
        await withRunTarget(['collect', '--step', '1.1', '--index', '99', '--text'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const out = result.stdout + result.stderr;
      // Pin the full not-active message so both interpolated frame keys (the
      // requested override frame and the active cursor frame) are asserted and
      // the "Frame not active: step S requested frame X but cursor is on Y."
      // string literal is killed.
      const activeFrameKey = (await getActiveState(workspace))!.activeFrameKey!;
      expect(out).toContain(
        `Frame not active: step 1 requested frame ${overrideFrame} but cursor is on ${activeFrameKey}.`,
      );
    });
  });

  describe('end-to-end CLI flow', () => {
    /**
     * End-to-end smoke coverage that exercises the full
     * `rd run --prompted → rd claim → rd pass → rd collect` pipeline without
     * any direct state writes. Under report-then-collect the delegated close
     * path is report-only: each child's outcome is recorded but NOT drained, so
     * the parent stays on the DELEGATE step (collection pending) until the
     * parent agent invokes `rd collect`, which applies the aggregated outcomes
     * and advances the run.
     *
     * This test is the canary for schema coupling in the hand-written-state
     * helper above: if the end-to-end flow breaks due to a state-schema
     * change, this test will catch it even though the other tests bypass
     * `rd claim` / `rd pass`.
     */
    it('drives the DELEGATE pipeline through rd claim + rd pass without hand-writing state', async () => {
      const childContent = createRunbook({
        title: 'Child',
        steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

      await writeFile(
        join(workspace.cwd, 'runbooks', 'parent.runbook.md'),
        buildParentDelegateMarkdown(),
      );

      // JSON mode — we harvest the auto-issued tokens from the STEP_ENTERED
      // event's delegateFrontier payload (the only place the plain tokens
      // are emitted; only the hash is persisted in state).
      const startResult = await runCliInProcess(
        'run --prompted runbooks/parent.runbook.md',
        workspace,
      );
      expect(startResult.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id;

      type FrontierEntry = { id: string; runbook: string; token: string };
      type StepEnteredEvent = {
        type?: string;
        delegateFrontier?: FrontierEntry[];
      };

      function findFrontierInEvents(events: unknown[]): FrontierEntry[] | undefined {
        for (const ev of events) {
          if (Array.isArray(ev)) {
            const nested = findFrontierInEvents(ev);
            if (nested) return nested;
          } else if (ev && typeof ev === 'object') {
            const e = ev as StepEnteredEvent;
            if (e.type === 'step_entered' && e.delegateFrontier) {
              return e.delegateFrontier;
            }
          }
        }
        return undefined;
      }

      const runEvents = parseConcatenatedJson(startResult.stdout);
      const frontier = findFrontierInEvents(runEvents) ?? [];
      const token1 = frontier.find((f) => f.id === '1.1')?.token;
      const token2 = frontier.find((f) => f.id === '1.2')?.token;
      expect(token1).toBeDefined();
      expect(token2).toBeDefined();

      // Claim + pass first child. Bare `pass` is now refused while a claimed
      // delegated child is open (the open-delegated-children guard), so the
      // child is passed via its claim id — report-only records the 1.1 outcome.
      let r = await runCliInProcess(`claim ${token1!}`, workspace);
      expect(r.exitCode).toBe(0);
      const claim1 = findActionOutput(r.stdout);
      expect(claim1).not.toBeNull();
      r = await runCliInProcess(['pass', '--claim-id', String(claim1!.claim_id)], workspace);
      expect(r.exitCode).toBe(0);

      // Claim + pass second child. Report-only records the 1.2 outcome. Under
      // Plan 5 the close path NEVER drains/aggregates, so the parent does not
      // advance here even though both substeps are now resolved.
      r = await runCliInProcess(`claim ${token2!}`, workspace);
      expect(r.exitCode).toBe(0);
      const claim2 = findActionOutput(r.stdout);
      expect(claim2).not.toBeNull();
      r = await runCliInProcess(['pass', '--claim-id', String(claim2!.claim_id)], workspace);
      expect(r.exitCode).toBe(0);

      // Plan 5 (report-only): both outcomes are reported but uncollected, so the
      // parent is STILL on the DELEGATE step — collection pending.
      const afterParent = JSON.parse(
        await readFile(join(workspace.statePath(), `${parentRunId}.json`), 'utf-8'),
      ) as Record<string, unknown>;
      expect(afterParent.step).toBe('1');

      // `rd collect` is the only apply path: it drains the reported outcomes and
      // advances the parent past the DELEGATE step (PASS ALL → CONTINUE → step 2).
      const collectResult = await runCliInProcess(
        await withRunTarget(['collect', '--text'], workspace),
        workspace,
      );
      expect(collectResult.exitCode).toBe(0);

      const collectedParent = JSON.parse(
        await readFile(join(workspace.statePath(), `${parentRunId}.json`), 'utf-8'),
      ) as Record<string, unknown>;
      expect(collectedParent.step).toBe('2');
    }, 20_000);

    it('keeps JSON stdout parseable when collect advances into a command that writes stdout and stderr', async () => {
      const parent = [
        '# Parent',
        '',
        '## 1. Fan-out',
        '',
        '- PASS ALL CONTINUE',
        '- FAIL ANY STOP',
        '',
        '### 1.1 Child',
        '',
        '- DELEGATE',
        '',
        '- child.runbook.md',
        '',
        '## 2. Emits bytes',
        '',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        '```bash',
        "node -e \"process.stdout.write(Buffer.from('434f4d4d414e445f5354444f55540a', 'hex').toString()); process.stderr.write(Buffer.from('434f4d4d414e445f5354444552520a', 'hex').toString())\"",
        '```',
        '',
      ].join('\n');

      const child = ['# Child', '', '## 1. Done', '', '- PASS COMPLETE', '', 'Done.', ''].join(
        '\n',
      );

      await writeFile(join(workspace.runbooksDir(), 'parent.runbook.md'), parent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), child);

      const start = runCli('run parent.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const started = parseConcatenatedJson(start.stdout).find(
        (event): event is Record<string, unknown> =>
          typeof event === 'object' && event !== null && event.type === 'runbook_started',
      );
      const runId = String(started?.runbookId);
      expect(runId).toMatch(/^rd_/);

      type FrontierEntry = { token: string };
      type StepEnteredEvent = {
        type?: string;
        delegateFrontier?: FrontierEntry[];
      };

      function findFrontierInEvents(events: unknown[]): FrontierEntry[] | undefined {
        for (const ev of events) {
          if (Array.isArray(ev)) {
            const nested = findFrontierInEvents(ev);
            if (nested) return nested;
          } else if (ev && typeof ev === 'object') {
            const e = ev as StepEnteredEvent;
            if (e.type === 'step_entered' && e.delegateFrontier) {
              return e.delegateFrontier;
            }
          }
        }
        return undefined;
      }

      const token = String(findFrontierInEvents(parseConcatenatedJson(start.stdout))?.[0]?.token);
      expect(token).toMatch(/^rdtk_/);

      const claim = runCli(`claim ${token}`, workspace);
      expect(claim.exitCode).toBe(0);
      const claimId = String(findActionOutput(claim.stdout)?.claim_id);
      expect(claimId).toMatch(/^rdclm_/);

      const passed = runCli(`pass --claim-id ${claimId}`, workspace);
      expect(passed.exitCode).toBe(0);

      const collected = runCli(`collect --run ${runId}`, workspace);
      expect(collected.exitCode).toBe(0);
      expect(collected.stdout).not.toContain('COMMAND_STDOUT');
      expect(collected.stdout).not.toContain('COMMAND_STDERR');
      expect(collected.stderr).toContain('COMMAND_STDOUT');
      expect(collected.stderr).toContain('COMMAND_STDERR');

      const objects = parseConcatenatedJson(collected.stdout);
      expect(objects.at(-1)).toMatchObject({
        kind: 'collect',
        action: 'collect',
        status: 'applied',
      });
    });
  });

  describe('error cases', () => {
    it('errors when called on a step that is not a DELEGATE step', async () => {
      // Start a non-DELEGATE runbook (simple.runbook.md has no DELEGATE substeps)
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      // Explicit `--step` naming a non-DELEGATE step is a genuine misuse and
      // still errors NOT_DELEGATE_STEP (unlike bare collect, which infers the
      // cursor and reports an idempotent already-aggregated no-op).
      const result = await runCliInProcess(
        await withRunTarget(['collect', '--step', '1', '--text'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/not a DELEGATE step/i);
    });

    it('errors when substeps are not all resolved', async () => {
      // Set up DELEGATE runbook, but only mark ONE substep resolved.
      const childContent = createRunbook({
        title: 'Child',
        steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

      await writeFile(
        join(workspace.cwd, 'runbooks', 'parent.runbook.md'),
        buildParentDelegateMarkdown(),
      );

      const startResult = await runCliInProcess(
        'run --prompted runbooks/parent.runbook.md --text',
        workspace,
      );
      expect(startResult.exitCode).toBe(0);

      const state = await getActiveState(workspace);
      const runbookId = state!.id;

      // Mark only substep 1 done — leave substep 2 pending.
      const statePath = join(workspace.statePath(), `${runbookId}.json`);
      const raw = JSON.parse(await readFile(statePath, 'utf-8')) as MutableRunbookState;
      const frameKey = raw.activeFrameKey ?? `${raw.step}|`;
      raw.substepStates = [
        { id: '1', frameKey, status: 'done', result: 'pass' },
        { id: '2', frameKey, status: 'pending' },
      ];
      await writeFile(statePath, JSON.stringify(raw, null, 2));

      const result = await runCliInProcess(
        await withRunTarget(['collect', '--text'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/not all substeps/i);
    });

    it('emits a SUBSTEPS_NOT_RESOLVED error envelope (JSON) when substeps are not all resolved', async () => {
      // Set up DELEGATE runbook, but only mark ONE substep resolved (the other
      // stays pending), then collect in JSON default mode.
      const childContent = createRunbook({
        title: 'Child',
        steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

      await writeFile(
        join(workspace.cwd, 'runbooks', 'parent.runbook.md'),
        buildParentDelegateMarkdown(),
      );

      const startResult = await runCliInProcess(
        'run --prompted runbooks/parent.runbook.md --text',
        workspace,
      );
      expect(startResult.exitCode).toBe(0);

      const runbookId = (await getActiveState(workspace))!.id;
      const statePath = join(workspace.statePath(), `${runbookId}.json`);
      const raw = JSON.parse(await readFile(statePath, 'utf-8')) as MutableRunbookState;
      const frameKey = raw.activeFrameKey ?? `${raw.step}|`;
      raw.substepStates = [
        { id: '1', frameKey, status: 'done', result: 'pass' },
        { id: '2', frameKey, status: 'pending' },
      ];
      await writeFile(statePath, JSON.stringify(raw, null, 2));

      const result = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);

      expect(result.exitCode).not.toBe(0);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'error', code: 'SUBSTEPS_NOT_RESOLVED' });
      // Pin the exact human-readable message so the "Cannot collect: not all
      // substeps are resolved. Pending: N." string literal is killed, and the
      // pending substep (qualified id "1.2") is interpolated into it.
      expect(String(json.error)).toBe(
        'Cannot collect: not all substeps are resolved. Pending: 1.2.',
      );
      const details = json.details as Record<string, unknown> | undefined;
      expect(details?.missingSubsteps).toEqual(['1.2']);
    });

    it('errors when no active runbook', async () => {
      const result = await runCliInProcess(['collect'], workspace);

      // In JSON mode the no-active path renders as a warning envelope tagged with
      // the command context ('collect') the OutputEmitter was constructed with —
      // pinning both the emit and the 'collect' command literal.
      const json = parseConcatenatedJson(result.stdout).find(
        (o): o is Record<string, unknown> =>
          typeof o === 'object' &&
          o !== null &&
          (o as { code?: string }).code === 'NO_ACTIVE_RUNBOOK',
      );
      expect(json).toBeDefined();
      expect(json).toMatchObject({
        kind: 'warning',
        command: 'collect',
        code: 'NO_ACTIVE_RUNBOOK',
      });
      expect(String(json!.message)).toMatch(/no active runbook/i);
    });
  });

  describe('--step targeting', () => {
    /**
     * `rd collect --step 1.1` must scope the aggregation to step 1 the same
     * way the default (no-flag) invocation does when the cursor is on step 1.
     * The parsed substep segment ("1") is ignored — aggregation always operates
     * at step scope — and the resolved completions for frame "1|" are drained.
     */
    it('scopes collect to the requested step when --step is provided', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      const result = await runCliInProcess(
        await withRunTarget(['collect', '--step', '1.1'], workspace),
        workspace,
      );
      expect(result.exitCode).toBe(0);

      // After collect, the parent must have advanced to step 2 — identical
      // behaviour to the default invocation.
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('2');
    });

    /**
     * When `--step` targets a step that is not a DELEGATE step, the command
     * must surface the NOT_DELEGATE_STEP guard against the requested scope.
     */
    it('errors when --step targets a non-DELEGATE step', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      const result = await runCliInProcess(
        await withRunTarget(['collect', '--step', '2', '--text'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/step 2 is not a DELEGATE step/i);
    });

    /**
     * `--step` with an invalid step ID must fail cleanly with an INVALID_STEP
     * error code rather than falling through to scope derivation.
     */
    it('errors on an invalid --step value', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      const result = await runCliInProcess(
        ['collect', '--step', 'not-a-step', '--text'],
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/invalid --step value/i);
    });

    /**
     * `resolveCollectScope` forwards `--index` through `resolveIndexOption`,
     * which rejects a non-positive-integer value with an `IndexOptionError`.
     * The scope resolver must catch that typed error, emit its `INVALID_SYNTAX`
     * envelope, and abort with a non-zero exit — never rethrow or fall through
     * to scope derivation.
     */
    it('errors with INVALID_SYNTAX on a non-integer --index value', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      const result = await runCliInProcess(
        ['collect', '--step', '1.1', '--index', 'abc'],
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'error', code: 'INVALID_SYNTAX' });
      expect(String(json.error)).toMatch(/invalid --index value/i);
    });
  });

  describe('applied text output', () => {
    /**
     * Cover the human-readable `renderAppliedOutcome` branch: a bare
     * `rd collect --text` on a successful PASS ALL aggregation prints the
     * "Collected N delegation outcome(s) on step S" summary (applied 2,
     * unresolved 0, lifecycle running) instead of the JSON envelope.
     */
    it('prints the collected-N summary line on a successful --text collect', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      const result = await runCliInProcess(
        await withRunTarget(['collect', '--text'], workspace),
        workspace,
      );
      expect(result.exitCode).toBe(0);

      const out = result.stdout + result.stderr;
      // Pin the full summary string so the "Collected N delegation outcome(s) on
      // step S (M unresolved; lifecycle L)." literal and all interpolated values
      // are killed together.
      expect(out).toContain(
        'Collected 2 delegation outcome(s) on step 1 (0 unresolved; lifecycle running).',
      );
    });
  });

  describe('collect advances into an inline stage', () => {
    // Stage 1 is DELEGATE'd to a worker; stages 2 and 3 are INLINE-composed gate
    // children. When `rd collect` applies the delegated stage-1 outcome it drives
    // the parent PASS ALL -> CONTINUE into the inline stage-2 gate, which runs the
    // execution loop (advancesIntoLoop) to launch + activate the inline child and
    // streams its execution events through the shared emitter before the trailing
    // collect action object.
    const PIPELINE = [
      '# Pipeline',
      '',
      '## 1. Plan',
      '',
      '- DELEGATE',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Write plan',
      '',
      '- DELEGATE',
      '- worker.runbook.md',
      '',
      '## 2. Review',
      '',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '- gate.runbook.md',
      '',
      '## 3. Execute',
      '',
      '- PASS ALL COMPLETE',
      '- FAIL ANY STOP',
      '- gate.runbook.md',
      '',
    ].join('\n');

    const WORKER = [
      '# Worker',
      '',
      '## 1. Do work',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      'Do the delegated work.',
      '',
    ].join('\n');
    const GATE = [
      '# Gate',
      '',
      '## 1. Check',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      'Check the gate.',
      '',
    ].join('\n');

    function findInlineChild(
      states: RunbookState[],
      parentRunId: string,
    ): RunbookState | undefined {
      return states.find((s) => {
        const link = s.parentLinkage;
        return link?.kind === 'inline' && link.parentRunId === parentRunId;
      });
    }

    async function driveToPendingCollect(): Promise<string> {
      await writeFile(join(workspace.runbooksDir(), 'pipeline.runbook.md'), PIPELINE);
      await writeFile(join(workspace.runbooksDir(), 'worker.runbook.md'), WORKER);
      await writeFile(join(workspace.runbooksDir(), 'gate.runbook.md'), GATE);

      const start = await runCliInProcess('run --prompted pipeline.runbook.md', workspace);
      expect(start.exitCode).toBe(0);

      const parent = await getActiveState(workspace);
      expect(parent).not.toBeNull();
      const parentRunId = parent!.id;
      const token = parent!.substepStates!.find((s) => s.delegation?.token)!.delegation!.token!;

      // Claim + explicitly close the delegated worker -> reports the outcome.
      const claim = await runCliInProcess(`claim ${token}`, workspace);
      expect(claim.exitCode).toBe(0);
      const claimId = String(findActionOutput(claim.stdout)!.claim_id);
      const closed = await runCliInProcess(['complete', '--claim-id', claimId], workspace);
      expect(closed.exitCode).toBe(0);

      return parentRunId;
    }

    it('runs the execution loop to launch + activate the inline child, then emits the applied object last', async () => {
      const parentRunId = await driveToPendingCollect();

      const collected = await runCliInProcess(
        await withRunTarget(['collect'], workspace),
        workspace,
      );
      expect(collected.exitCode).toBe(0);

      // The parent advanced into stage 2 (the inline gate stage) and is running.
      const parentAfter = await readRunbookState(workspace, parentRunId);
      expect(parentAfter!.step).toBe('2');
      expect(parentAfter!.lifecycle).toBe('running');

      // The execution loop launched the inline gate child and made it active.
      const states = await getAllStates(workspace);
      const inlineChild = findInlineChild(states, parentRunId);
      expect(inlineChild).toBeDefined();
      const active = await getActiveState(workspace);
      expect(active!.id).toBe(inlineChild!.id);

      // Streamed execution events precede the trailing applied collect object.
      const objects = parseConcatenatedJson(collected.stdout).filter(
        (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
      );
      expect(objects.length).toBeGreaterThan(1);
      const last = objects.at(-1)!;
      expect(last).toMatchObject({ kind: 'collect', action: 'collect', status: 'applied' });
      // The applied object is the ONLY collect object and it is strictly last.
      const collectIndices = objects
        .map((object, index) => ({ object, index }))
        .filter(({ object }) => object.kind === 'collect')
        .map(({ index }) => index);
      expect(collectIndices).toEqual([objects.length - 1]);
      // At least one streamed execution event (step_entered / runbook_started)
      // landed before the applied object.
      const eventCount = objects.filter((o) => typeof o.type === 'string').length;
      expect(eventCount).toBeGreaterThan(0);

      // The aggregation's `STEP_TRANSITIONED` observation (stage 1 -> stage 2)
      // must be forwarded by `streamAppliedObservations` as a `step_transitioned`
      // event — pinning that case arm against a drop/mislabel mutation.
      const streamedTypes = objects
        .map((o) => o.type)
        .filter((t): t is string => typeof t === 'string');
      expect(streamedTypes).toContain('step_transitioned');
    }, 30_000);

    // A `collect` that drives the collected run itself to a terminal lifecycle
    // must propagate that terminal outcome to its parent. Here the inline gate
    // child G is ITSELF a delegating runbook whose DELEGATE step is `PASS ALL
    // COMPLETE`: collecting G's reported outcome completes G, and because G was
    // launched as an INLINE child of the pipeline P, the terminal-propagation
    // pass resolves P's stage-2 composite substep (inline branch) and advances P.
    const COLLECTING_PIPELINE = [
      '# Collecting Pipeline',
      '',
      '## 1. Plan',
      '',
      '- DELEGATE',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Write plan',
      '',
      '- DELEGATE',
      '- worker.runbook.md',
      '',
      '## 2. Review',
      '',
      '- PASS ALL COMPLETE',
      '- FAIL ANY STOP',
      '- collecting-gate.runbook.md',
      '',
    ].join('\n');

    const COLLECTING_GATE = [
      '# Collecting Gate',
      '',
      '## 1. Delegate check',
      '',
      '- DELEGATE',
      '- PASS ALL COMPLETE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Check',
      '',
      '- DELEGATE',
      '- worker.runbook.md',
      '',
    ].join('\n');

    /**
     * Claim the sole auto-issued delegation token of the active run and report
     * its terminal result. `result: 'pass'` closes via `complete`; `'fail'` via
     * `fail`, which lets the collecting run's FAIL ANY aggregation STOP it.
     */
    async function claimAndReportActiveDelegation(result: 'pass' | 'fail' = 'pass'): Promise<void> {
      const active = await getActiveState(workspace);
      const token = active!.substepStates!.find((s) => s.delegation?.token)!.delegation!.token!;
      const claim = await runCliInProcess(`claim ${token}`, workspace);
      expect(claim.exitCode).toBe(0);
      const claimId = String(findActionOutput(claim.stdout)!.claim_id);
      const cmd = result === 'pass' ? 'complete' : 'fail';
      const closed = await runCliInProcess([cmd, '--claim-id', claimId], workspace);
      // A reported pass records cleanly (exit 0); a reported fail may surface a
      // non-zero exit when the child's own FAIL handler stops it — either way the
      // outcome is recorded, which is what the collecting run later drains.
      if (result === 'pass') expect(closed.exitCode).toBe(0);
    }

    it('propagates a collected inline child terminal to its parent (inline linkage)', async () => {
      await writeFile(join(workspace.runbooksDir(), 'pipeline.runbook.md'), COLLECTING_PIPELINE);
      await writeFile(join(workspace.runbooksDir(), 'worker.runbook.md'), WORKER);
      await writeFile(join(workspace.runbooksDir(), 'collecting-gate.runbook.md'), COLLECTING_GATE);

      const start = await runCliInProcess('run --prompted pipeline.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const parentRunId = (await getActiveState(workspace))!.id;

      // Stage 1: report + collect -> parent CONTINUEs into the inline gate child.
      await claimAndReportActiveDelegation();
      const collect1 = await runCliInProcess(
        await withRunTarget(['collect'], workspace),
        workspace,
      );
      expect(collect1.exitCode).toBe(0);

      // The inline gate child G is now the active run (its own DELEGATE step).
      const gate = await getActiveState(workspace);
      expect(gate!.id).not.toBe(parentRunId);
      expect(gate!.parentLinkage?.kind).toBe('inline');

      // Report G's delegated worker, then collect on G. G's `PASS ALL COMPLETE`
      // drives G terminal (completed); the collect command's terminal-propagation
      // pass then resolves the parent's stage-2 substep and completes the parent.
      await claimAndReportActiveDelegation();
      const collect2 = await runCliInProcess(
        await withRunTarget(['collect'], workspace),
        workspace,
      );
      expect(collect2.exitCode).toBe(0);

      const gateAfter = await readRunbookState(workspace, gate!.id);
      expect(gateAfter!.lifecycle).toBe('completed');

      // Inline propagation advanced the parent to its terminal completed state.
      const parentAfter = await readRunbookState(workspace, parentRunId);
      expect(parentAfter!.lifecycle).toBe('completed');

      // The final JSON object is still the applied collect action object.
      const objects = parseConcatenatedJson(collect2.stdout).filter(
        (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
      );
      expect(objects.at(-1)).toMatchObject({
        kind: 'collect',
        action: 'collect',
        status: 'applied',
      });

      // Completing the gate child streams a `runbook_completed` observation via
      // `streamAppliedObservations` — pinning the RUNBOOK_COMPLETED case arm.
      const streamedTypes = objects
        .map((o) => o.type)
        .filter((t): t is string => typeof t === 'string');
      expect(streamedTypes).toContain('runbook_completed');
    }, 40_000);

    it('propagates a STOPPED inline child terminal to the parent and exits non-zero', async () => {
      await writeFile(join(workspace.runbooksDir(), 'pipeline.runbook.md'), COLLECTING_PIPELINE);
      await writeFile(join(workspace.runbooksDir(), 'worker.runbook.md'), WORKER);
      await writeFile(join(workspace.runbooksDir(), 'collecting-gate.runbook.md'), COLLECTING_GATE);

      const start = await runCliInProcess('run --prompted pipeline.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const parentRunId = (await getActiveState(workspace))!.id;

      // Stage 1 passes -> parent CONTINUEs into the inline gate child G.
      await claimAndReportActiveDelegation('pass');
      expect(
        (await runCliInProcess(await withRunTarget(['collect'], workspace), workspace)).exitCode,
      ).toBe(0);
      const gate = await getActiveState(workspace);
      expect(gate!.parentLinkage?.kind).toBe('inline');

      // FAIL G's delegated worker, then collect on G. G's `FAIL ANY STOP`
      // aggregation drives G to a STOPPED terminal; the terminal-propagation pass
      // then propagates that stop to the parent and the command exits non-zero.
      await claimAndReportActiveDelegation('fail');
      const collectStop = await runCliInProcess(
        await withRunTarget(['collect'], workspace),
        workspace,
      );
      expect(collectStop.exitCode).not.toBe(0);

      const gateAfter = await readRunbookState(workspace, gate!.id);
      expect(gateAfter!.lifecycle).toBe('stopped');
      const parentAfter = await readRunbookState(workspace, parentRunId);
      expect(parentAfter!.lifecycle).toBe('stopped');

      // The applied action object is still the last JSON object on the stop path.
      const objects = parseConcatenatedJson(collectStop.stdout).filter(
        (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
      );
      expect(objects.at(-1)).toMatchObject({
        kind: 'collect',
        action: 'collect',
        status: 'applied',
        lifecycle: 'stopped',
      });
    }, 40_000);
  });

  describe('claim-id validation', () => {
    /**
     * An invalid `--claim-id` must be rejected by `parseClaimIdOption` before any
     * transition context is built: the command emits the claim-id validation
     * error and bails (the `if (!claimTarget.ok) return` guard).
     */
    it('rejects a malformed --claim-id', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      const result = await runCliInProcess(['collect', '--claim-id', 'not-a-claim-id'], workspace);

      const json = parseConcatenatedJson(result.stdout).find(
        (o): o is Record<string, unknown> =>
          typeof o === 'object' && o !== null && (o as { kind?: string }).kind === 'error',
      );
      expect(json).toBeDefined();
      // The active runbook must NOT have advanced — the guard returned early.
      expect((await getActiveState(workspace))?.step).toBe('1');
    });
  });
});
