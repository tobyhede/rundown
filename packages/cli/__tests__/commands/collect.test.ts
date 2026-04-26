import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildFrameKey, buildCompletionKey, type FrameKey } from '@rundown-org/core';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
  type TestWorkspace,
} from '../helpers/test-utils.js';

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

  const substepStates: SubstepState[] = results.map((result, i) => ({
    id: String(i + 1),
    frameKey,
    status: 'done',
    result,
  }));

  const resolvedCompletions: Record<string, ResolvedCompletion> = {};
  for (let i = 0; i < results.length; i++) {
    const substepId = String(i + 1);
    const key = buildCompletionKey(frameKey, entry, substepId);
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

      // Second collect on step 2 — step 2 is NOT a DELEGATE step, so the
      // NOT_DELEGATE_STEP error surfaces instead; this still demonstrates the
      // user sees a clear outcome rather than a silent exit 0.
      const second = await runCliInProcess(['collect', '--text'], workspace);
      expect(second.exitCode).not.toBe(0);
      expect(second.stdout + second.stderr).toMatch(/not a DELEGATE step/i);
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

      // Run output may contain multiple concatenated JSON documents
      // (pretty-printed). Walk the string and extract each top-level JSON
      // value so we can locate the step_entered event with delegateFrontier.
      function parseConcatenatedJson(raw: string): unknown[] {
        const results: unknown[] = [];
        let i = 0;
        while (i < raw.length) {
          while (i < raw.length && /\s/.test(raw[i])) i++;
          if (i >= raw.length) break;
          const start = i;
          let depth = 0;
          let inString = false;
          let escaped = false;
          for (; i < raw.length; i++) {
            const ch = raw[i];
            if (inString) {
              if (escaped) {
                escaped = false;
              } else if (ch === '\\') {
                escaped = true;
              } else if (ch === '"') {
                inString = false;
              }
            } else if (ch === '"') {
              inString = true;
            } else if (ch === '{' || ch === '[') {
              depth++;
            } else if (ch === '}' || ch === ']') {
              depth--;
              if (depth === 0) {
                i++;
                break;
              }
            }
          }
          const chunk = raw.slice(start, i);
          try {
            results.push(JSON.parse(chunk));
          } catch {
            // skip malformed chunk
          }
        }
        return results;
      }

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

      // Claim + pass first child. Auto-propagation records completion for 1.1.
      let r = await runCliInProcess(`claim ${token1!}`, workspace);
      expect(r.exitCode).toBe(0);
      r = await runCliInProcess(['pass'], workspace);
      expect(r.exitCode).toBe(0);

      // Claim + pass second child. Auto-propagation records completion for
      // 1.2 and drains — because both substeps are now resolved, aggregation
      // fires immediately and the parent advances to step 2.
      r = await runCliInProcess(`claim ${token2!}`, workspace);
      expect(r.exitCode).toBe(0);
      r = await runCliInProcess(['pass'], workspace);
      expect(r.exitCode).toBe(0);

      // By now the parent has advanced past step 1 via auto-aggregation.
      const afterParent = JSON.parse(
        await readFile(join(workspace.statePath(), `${parentRunId}.json`), 'utf-8'),
      ) as Record<string, unknown>;
      expect(afterParent.step).not.toBe('1');

      // Running `rd collect` now should not silently succeed — the parent is
      // no longer on a DELEGATE step, so the guard fires.
      const collectResult = await runCliInProcess(['collect', '--text'], workspace);
      expect(collectResult.exitCode).not.toBe(0);
      expect(collectResult.stdout + collectResult.stderr).toMatch(/not a DELEGATE step/i);
    }, 20_000);
  });

  describe('error cases', () => {
    it('errors when called on a step that is not a DELEGATE step', async () => {
      // Start a non-DELEGATE runbook (simple.runbook.md has no DELEGATE substeps)
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess(['collect', '--text'], workspace);

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
