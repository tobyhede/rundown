import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activeFrame, buildFrameKey, buildCompletionKey, type FrameKey } from '@rundown-org/core';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
  parseConcatenatedJson,
  findActionOutput,
  readSession,
  writeSession,
  type TestWorkspace,
} from '../helpers/test-utils.js';
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
 *   This shortcut is kept because the end-to-end flow auto-propagates and
 *   auto-aggregates via `handleParentCompletion`, so it cannot produce the
 *   "collect has real work to do" state — only `rd collect` running BEFORE
 *   auto-aggregation lets us observe the aggregation code path in isolation.
 *
 * TODO: if/when auto-propagation becomes opt-out, migrate these tests to
 *       drive through the CLI and delete this helper.
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
      const session = await readSession(workspace);
      await writeSession(workspace, {
        defaultStack: [childRunId],
        claims: session.claims,
      });

      // The active run is itself delegated upward. Under the target-relative
      // model the orchestrator gate must NOT reject it as a collection target.
      const result = await runCliInProcess(['collect'], workspace);

      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).not.toBe('COLLECT_REQUIRES_ORCHESTRATOR');
      expect(payload.code).not.toBe('ACTOR_CONTEXT_REQUIRED');
    }, 30_000);
  });

  describe('successful aggregation', () => {
    it('fires CONTINUE and advances to next step when PASS ALL passes', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      const result = await runCliInProcess(['collect'], workspace);

      expect(result.exitCode).toBe(0);

      // After collect, parent should have advanced to step 2.
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('2');
    });

    it('fires STOP and halts when FAIL ANY and a substep failed', async () => {
      await setupReadyToCollect(['pass', 'fail']);

      const result = await runCliInProcess(['collect'], workspace);

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
     * With `FAIL ANY STOP` aggregation and mixed pass/fail results, the
     * emitted `STEP_TRANSITIONED` event must carry `aggregated: true`. The
     * compiler tags all actions produced by the parent-exit aggregation
     * state with this flag (see `packages/core/src/runbook/compiler.ts`,
     * lines ~808–852), so its presence is a direct proof that the
     * aggregation path fired — not just a per-substep DEFER.
     */
    it('emits aggregated=true on the transition event when aggregation fires', async () => {
      await setupReadyToCollect(['pass', 'fail']);

      const result = await runCliInProcess(['collect'], workspace);

      // FAIL ANY STOP aggregation on a mixed result stops the runbook.
      expect(result.exitCode).not.toBe(0);

      // Find the STEP_TRANSITIONED event in the JSON stream. The event's
      // `aggregated` field is only set to true by the aggregation code path.
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      const events = lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((e): e is Record<string, unknown> => e !== null);

      // Find the aggregated step_transitioned — there may be earlier
      // non-aggregated step_transitioned events for the deferred substeps.
      const aggregatedEvent = events.find(
        (e) => e.type === 'step_transitioned' && e.aggregated === true,
      );
      expect(aggregatedEvent).toBeDefined();
      expect(aggregatedEvent!.action).toBe('STOP');
      expect(aggregatedEvent!.result).toBe('FAIL');
    });
  });

  describe('already-aggregated behavior', () => {
    /**
     * Running `rd collect` twice must surface a visible, non-error outcome.
     * After the first collect succeeds (parent advances to step 2), the
     * second call has no unapplied completions — the command emits an
     * `already-aggregated` status and exits 0.
     */
    it('emits an already-aggregated status on the second invocation', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      // First collect: fires aggregation, advances to step 2.
      const first = await runCliInProcess(['collect'], workspace);
      expect(first.exitCode).toBe(0);

      const after = await getActiveState(workspace);
      expect(after?.step).toBe('2');

      // Second (bare) collect on step 2 — the cursor advanced past the
      // DELEGATE step, so aggregation already fired. Bare collect infers the
      // cursor and reports an idempotent already-aggregated no-op (exit 0)
      // rather than the NOT_DELEGATE_STEP error.
      const second = await runCliInProcess(['collect', '--text'], workspace);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toMatch(/already aggregated/i);
    });

    it('bare rd collect after auto-aggregation returns already-aggregated, not NOT_DELEGATE_STEP', async () => {
      await setupReadyToCollect(['pass', 'pass']);
      const first = await runCliInProcess(['collect'], workspace);
      expect(first.exitCode).toBe(0);
      expect((await getActiveState(workspace))?.step).toBe('2');

      const result = await runCliInProcess(['collect'], workspace);

      expect(result.exitCode).toBe(0);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'collect', status: 'already-aggregated' });
    });

    it('rd collect --step <non-delegate> still errors NOT_DELEGATE_STEP', async () => {
      await setupReadyToCollect(['pass', 'pass']);
      const first = await runCliInProcess(['collect'], workspace);
      expect(first.exitCode).toBe(0);
      expect((await getActiveState(workspace))?.step).toBe('2');

      const result = await runCliInProcess(['collect', '--step', '2'], workspace);

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

      const result = await runCliInProcess(['collect'], workspace);

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

      const result = await runCliInProcess(['collect', '--text'], workspace);

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

      const result = await runCliInProcess(['collect'], workspace);

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
      const collect1 = await runCliInProcess(['collect'], workspace);
      expect(collect1.exitCode).toBe(0);
      expect((await getActiveState(workspace))?.step).toBe('2');

      // Advance the cursor off the aggregation successor to an unrelated step.
      const pass2 = await runCliInProcess(['pass'], workspace);
      expect(pass2.exitCode).toBe(0);
      expect((await getActiveState(workspace))?.step).toBe('3');

      // Bare collect on step 3 — NOT the aggregation successor. Must error.
      const result = await runCliInProcess(['collect'], workspace);
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

      const result = await runCliInProcess(['collect'], workspace);

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

      const result = await runCliInProcess(['collect', '--text'], workspace);

      expect(result.exitCode).toBe(1);
      const out = result.stdout + result.stderr;
      expect(out).toMatch(/not found/i);
      expect(out).not.toMatch(/already aggregated/i);
    });

    it('rd collect --step <missing> reports STEP_NOT_FOUND, not NOT_DELEGATE_STEP', async () => {
      await setupReadyToCollect(['pass', 'pass']);

      const result = await runCliInProcess(['collect', '--step', '99'], workspace);

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
        ['collect', '--step', '1.1', '--index', '99'],
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
  });

  describe('end-to-end CLI flow', () => {
    /**
     * End-to-end smoke coverage that exercises the full
     * `rd run --prompted → rd claim → rd pass → rd collect` pipeline without
     * any direct state writes. In the happy path, `handleParentCompletion`
     * auto-aggregates as each child completes, so by the time the parent
     * agent invokes `rd collect` the runbook has already advanced — the
     * command reports the already-aggregated status (or a NOT_DELEGATE_STEP
     * error because the cursor moved on).
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
      // child is passed via its claim id — auto-propagation records completion
      // for 1.1.
      let r = await runCliInProcess(`claim ${token1!}`, workspace);
      expect(r.exitCode).toBe(0);
      const claim1 = findActionOutput(r.stdout);
      expect(claim1).not.toBeNull();
      r = await runCliInProcess(['pass', '--claim-id', String(claim1!.claim_id)], workspace);
      expect(r.exitCode).toBe(0);

      // Claim + pass second child. Auto-propagation records completion for
      // 1.2 and drains — because both substeps are now resolved, aggregation
      // fires immediately and the parent advances to step 2.
      r = await runCliInProcess(`claim ${token2!}`, workspace);
      expect(r.exitCode).toBe(0);
      const claim2 = findActionOutput(r.stdout);
      expect(claim2).not.toBeNull();
      r = await runCliInProcess(['pass', '--claim-id', String(claim2!.claim_id)], workspace);
      expect(r.exitCode).toBe(0);

      // By now the parent has advanced past step 1 via auto-aggregation.
      const afterParent = JSON.parse(
        await readFile(join(workspace.statePath(), `${parentRunId}.json`), 'utf-8'),
      ) as Record<string, unknown>;
      expect(afterParent.step).not.toBe('1');

      // Running bare `rd collect` now reports an idempotent already-aggregated
      // no-op — the parent advanced past the DELEGATE step via auto-aggregation,
      // so the postcondition already holds (exit 0, not an error).
      const collectResult = await runCliInProcess(['collect', '--text'], workspace);
      expect(collectResult.exitCode).toBe(0);
      expect(collectResult.stdout).toMatch(/already aggregated/i);
    }, 20_000);
  });

  describe('error cases', () => {
    it('errors when called on a step that is not a DELEGATE step', async () => {
      // Start a non-DELEGATE runbook (simple.runbook.md has no DELEGATE substeps)
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      // Explicit `--step` naming a non-DELEGATE step is a genuine misuse and
      // still errors NOT_DELEGATE_STEP (unlike bare collect, which infers the
      // cursor and reports an idempotent already-aggregated no-op).
      const result = await runCliInProcess(['collect', '--step', '1', '--text'], workspace);

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

      const result = await runCliInProcess(['collect', '--text'], workspace);

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/not all substeps/i);
    });

    it('errors when no active runbook', async () => {
      const result = await runCliInProcess(['collect', '--text'], workspace);

      expect(result.stdout + result.stderr).toMatch(/no active runbook/i);
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

      const result = await runCliInProcess(['collect', '--step', '1.1'], workspace);
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

      const result = await runCliInProcess(['collect', '--step', '2', '--text'], workspace);

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
  });
});
