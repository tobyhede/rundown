import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
  readRunbookState,
  parseCliJsonObject,
  parseConcatenatedJson,
  findActionOutput,
  type TestWorkspace,
  issueRunControlClaim,
  withRunTarget,
} from '../helpers/test-utils.js';

/**
 * Integration tests for the DELEGATE keyword workflow.
 *
 * Covers the full lifecycle that spans parser, auto-delegation on step entry,
 * subagent claim/pass, and aggregation via `rd collect`. Complements the
 * unit-level tests in `__tests__/commands/delegate.test.ts` and
 * `__tests__/commands/collect.test.ts` by exercising the end-to-end CLI
 * pipeline rather than individual commands in isolation.
 */

/** Frontier entry emitted inside a STEP_ENTERED event for a DELEGATE step. */
interface FrontierEntry {
  id: string;
  runbook: string;
  token: string;
}

/** Subset of the `step_entered` event shape the tests care about. */
interface StepEnteredEvent {
  type?: string;
  delegateFrontier?: FrontierEntry[];
  stepName?: string;
  position?: unknown;
}

/**
 * Walk a possibly-nested list of parsed JSON values and find the first
 * `step_entered` event that carries a `delegateFrontier`.
 *
 * @param events - Parsed JSON values from stdout
 * @returns The frontier array if found, otherwise undefined
 */
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

function findAllFrontiersInEvents(events: unknown[]): FrontierEntry[][] {
  const frontiers: FrontierEntry[][] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const e = node as StepEnteredEvent;
    if (e.type === 'step_entered' && e.delegateFrontier) {
      frontiers.push(e.delegateFrontier);
    }
    // Recurse into object values too: a step_entered event can be nested inside
    // an object payload (not just an array), and an array-only walk would skip it.
    for (const value of Object.values(node)) walk(value);
  };
  walk(events);
  return frontiers;
}

/**
 * Flatten nested arrays of parsed JSON events into a single array of objects,
 * filtering out non-object entries.
 *
 * @param events - Raw parsed events (possibly nested)
 * @returns Flat list of plain objects
 */
function flattenEventObjects(events: unknown[]): Record<string, unknown>[] {
  const flat: Record<string, unknown>[] = [];
  const walk = (nodes: unknown[]): void => {
    for (const ev of nodes) {
      if (Array.isArray(ev)) {
        walk(ev);
      } else if (ev && typeof ev === 'object') {
        flat.push(ev as Record<string, unknown>);
      }
    }
  };
  walk(events);
  return flat;
}

describe('DELEGATE full workflow — rd run → auto-delegation → rd claim → rd collect', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /**
   * Build a parent runbook with one DELEGATE step (step 1) containing two
   * H3 substeps, both referencing a child runbook. Step 2 is a terminal
   * step used to assert that aggregation advanced the parent correctly.
   *
   * Step 1 uses `PASS ALL CONTINUE` / `FAIL ANY STOP` so individual-substep
   * outcomes cleanly drive aggregation behavior.
   */
  function buildParentDelegate(): string {
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
   * Write both a passing and a failing child runbook plus a parent DELEGATE
   * runbook to the workspace, then start the parent in prompted mode.
   *
   * Returns the parent run id and the two auto-issued tokens. The second
   * substep (1.2) references `childRef2` so callers can wire a failing child.
   */
  async function setupParentWithChildren(childRef2 = 'child.runbook.md'): Promise<{
    parentRunId: string;
    token1: string;
    token2: string;
    startStdout: string;
  }> {
    const passChild = createRunbook({
      title: 'Child Pass',
      steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    const failChild = createRunbook({
      title: 'Child Fail',
      steps: [
        { title: 'Do work', pass: 'COMPLETE', fail: 'STOP', command: 'rd echo --result fail' },
      ],
    });

    // Both child names need to resolve; write both to every discovery location.
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), passChild);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), passChild);
    await writeFile(join(workspace.cwd, 'runbooks', 'child-fail.runbook.md'), failChild);
    await writeFile(join(workspace.runbooksDir(), 'child-fail.runbook.md'), failChild);

    const parentContent = buildParentDelegate().replace(
      '### 1.2 Task B\n\n- child.runbook.md',
      `### 1.2 Task B\n\n- ${childRef2}`,
    );
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    const startResult = await runCliInProcess(
      'run --prompted runbooks/parent.runbook.md',
      workspace,
    );
    expect(startResult.exitCode).toBe(0);

    const parentState = await getActiveState(workspace);
    expect(parentState).not.toBeNull();
    const parentRunId = parentState!.id;

    const runEvents = parseConcatenatedJson(startResult.stdout);
    const frontier = findFrontierInEvents(runEvents) ?? [];
    const token1 = frontier.find((f) => f.id === '1.1')?.token;
    const token2 = frontier.find((f) => f.id === '1.2')?.token;
    expect(token1).toBeDefined();
    expect(token2).toBeDefined();

    return {
      parentRunId,
      token1: token1!,
      token2: token2!,
      startStdout: startResult.stdout,
    };
  }

  it('full happy path: run enters DELEGATE step, auto-issues tokens, claim+pass all substeps, collect fires CONTINUE', async () => {
    const { parentRunId, token1, token2, startStdout } = await setupParentWithChildren();

    // Verify STEP_ENTERED event carried delegateFrontier with exactly 2 entries.
    const runEvents = parseConcatenatedJson(startStdout);
    const frontier = findFrontierInEvents(runEvents) ?? [];
    expect(frontier).toHaveLength(2);
    expect(frontier.map((f) => f.id).sort()).toEqual(['1.1', '1.2']);
    for (const entry of frontier) {
      expect(entry.token.startsWith('rdtk_')).toBe(true);
    }

    // Claim + pass first subagent. Drop --text so the claim's JSON output is
    // parseable for claim_id extraction. Bare `pass` would target the parent
    // under reverted Route A — thread --claim-id to land on the child.
    let r = await runCliInProcess(`claim ${token1}`, workspace);
    expect(r.exitCode).toBe(0);
    const claim1 = findActionOutput(r.stdout);
    expect(claim1).not.toBeNull();
    const claimId1 = String(claim1!.claim_id);
    r = await runCliInProcess(['pass', '--claim-id', claimId1], workspace);
    expect(r.exitCode).toBe(0);

    // Claim + pass second subagent. Report-only (Plan 5): each pass REPORTS its
    // outcome; the parent does NOT aggregate or advance at close time.
    r = await runCliInProcess(`claim ${token2}`, workspace);
    expect(r.exitCode).toBe(0);
    const claim2 = findActionOutput(r.stdout);
    expect(claim2).not.toBeNull();
    const claimId2 = String(claim2!.claim_id);
    r = await runCliInProcess(['pass', '--claim-id', claimId2], workspace);
    expect(r.exitCode).toBe(0);

    // Both outcomes reported but uncollected — parent is still on the DELEGATE step.
    const afterParent = await readRunbookState(workspace, parentRunId);
    expect(afterParent).not.toBeNull();
    expect(afterParent!.step).toBe('1');

    // Explicit collect aggregates both reported outcomes: PASS ALL → CONTINUE → step 2.
    const collectResult = await runCliInProcess(
      await withRunTarget(['collect', '--text'], workspace),
      workspace,
    );
    expect(collectResult.exitCode).toBe(0);

    const advancedParent = await readRunbookState(workspace, parentRunId);
    expect(advancedParent).not.toBeNull();
    expect(advancedParent!.step).toBe('2');
  }, 20_000);

  it('run-targeted rd collect fails fast when persisted state.step no longer resolves to a runbook step', async () => {
    const { parentRunId } = await setupParentWithChildren();

    // Corrupt the persisted cursor so it names a step absent from the loaded
    // runbook — simulating stale state (e.g. the runbook edited out from under
    // an in-flight run). End-to-end this exercises the same state-load path as
    // a real `rd collect`, not just the command in isolation.
    const statePath = join(workspace.statePath(), `${parentRunId}.json`);
    const raw = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
    raw.step = '99';
    await writeFile(statePath, JSON.stringify(raw, null, 2));

    // The run-targeted collect must reject the stale state with STEP_NOT_FOUND rather than
    // collapsing it into an `already-aggregated` success.
    const result = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);
    expect(result.exitCode).toBe(1);
    const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
    expect(json).toMatchObject({ kind: 'error', code: 'STEP_NOT_FOUND' });
  }, 20_000);

  it('FAIL ANY: one substep fails, rd collect fires STOP transition', async () => {
    // Parent: step 1 has FAIL ANY STOP aggregation. Second substep is wired
    // to a failing child runbook, so after both claim+fail/pass complete the
    // parent aggregates to STOP.
    const { parentRunId, token1, token2 } = await setupParentWithChildren('child-fail.runbook.md');

    // First subagent passes. Bare `pass` would target the parent under
    // reverted Route A — thread --claim-id to land on the child.
    let r = await runCliInProcess(`claim ${token1}`, workspace);
    expect(r.exitCode).toBe(0);
    const claim1 = findActionOutput(r.stdout);
    expect(claim1).not.toBeNull();
    const claimId1 = String(claim1!.claim_id);
    r = await runCliInProcess(['pass', '--claim-id', claimId1], workspace);
    expect(r.exitCode).toBe(0);

    // Second subagent fails — auto-propagation on fail + aggregation → STOP.
    r = await runCliInProcess(`claim ${token2}`, workspace);
    // claim may fail exit because the child auto-fails; check state instead.
    const claim2 = findActionOutput(r.stdout);
    expect(claim2).not.toBeNull();
    const claimId2 = String(claim2!.claim_id);
    r = await runCliInProcess(['fail', '--claim-id', claimId2], workspace);
    // Exit-code narrowing (Plan 5): the child's own FAIL action is STOP, so the
    // child locally STOPs and `rd fail --claim-id` exits 1 on its own lifecycle.
    expect(r.exitCode).toBe(1);

    // Report-only: both outcomes are reported but uncollected — the parent has
    // NOT yet aggregated to STOP.
    let afterParent = await readRunbookState(workspace, parentRunId);
    expect(afterParent).not.toBeNull();
    expect(afterParent!.lifecycle).not.toBe('stopped');

    // Explicit collect aggregates the reported outcomes: FAIL ANY → STOP.
    const collectResult = await runCliInProcess(
      await withRunTarget(['collect', '--text'], workspace),
      workspace,
    );
    expect(collectResult.exitCode).toBe(1);

    afterParent = await readRunbookState(workspace, parentRunId);
    expect(afterParent).not.toBeNull();
    expect(afterParent!.lifecycle).toBe('stopped');
  }, 20_000);

  it('rd collect reports the applied aggregation summary and advances the parent', async () => {
    const { parentRunId, token1, token2 } = await setupParentWithChildren();

    // Claim + pass both subagents (report-only). `rd collect` is the command
    // that applies the parent aggregation, so it must emit the same transition
    // observation the non-collect path would emit for the final substep.
    let r = await runCliInProcess(`claim ${token1}`, workspace);
    expect(r.exitCode).toBe(0);
    const claim1 = findActionOutput(r.stdout);
    expect(claim1).not.toBeNull();
    const claimId1 = String(claim1!.claim_id);
    r = await runCliInProcess(['pass', '--claim-id', claimId1], workspace);
    expect(r.exitCode).toBe(0);

    r = await runCliInProcess(`claim ${token2}`, workspace);
    expect(r.exitCode).toBe(0);
    const claim2 = findActionOutput(r.stdout);
    expect(claim2).not.toBeNull();
    const claimId2 = String(claim2!.claim_id);
    const finalPass = await runCliInProcess(['pass', '--claim-id', claimId2], workspace);
    expect(finalPass.exitCode).toBe(0);

    const collectResult = await runCliInProcess(
      await withRunTarget(['collect'], workspace),
      workspace,
    );
    expect(collectResult.exitCode).toBe(0);
    const events = flattenEventObjects(parseConcatenatedJson(collectResult.stdout));
    const transition = events.find(
      (e) =>
        e.type === 'step_transitioned' &&
        e.action === 'CONTINUE' &&
        e.from === '1.2' &&
        e.at === '2' &&
        e.result === 'PASS',
    );
    expect(transition).toBeDefined();
    expect(transition?.aggregated).toBe(true);

    // The collect summary reports BOTH reported outcomes applied and the
    // PASS-ALL rule firing CONTINUE — a non-terminal advance (lifecycle running).
    const collect = events.find((e) => e.kind === 'collect');
    expect(collect).toBeDefined();
    expect(collect!.status).toBe('applied');
    expect(collect!.applied).toBe(2);
    expect(collect!.lifecycle).toBe('running');

    // The transition is complete: the parent cursor advanced to step 2.
    const afterParent = await readRunbookState(workspace, parentRunId);
    expect(afterParent?.step).toBe('2');
  }, 20_000);
});

describe('DELEGATE manual issuance requires authored DELEGATE annotation', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /**
   * Write a parent runbook whose H3 substeps intentionally lack DELEGATE so
   * manual issuance can prove the rejection path without entering inline child
   * scope.
   */
  async function writeDelegateRunbook(): Promise<void> {
    const childContent = createRunbook({
      title: 'Child',
      steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

    const parentContent = [
      '# Parent',
      '',
      '## 1. Fan-out',
      '',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Task A',
      '',
      'Manual delegation target.',
      '',
      '### 1.2 Task B',
      '',
      'Manual delegation target.',
      '',
      '## 2. Done',
      '',
      '- PASS COMPLETE',
      '',
      'Finished.',
      '',
      '```bash',
      'rd echo --result pass',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);
  }

  it('rejects manual rd delegate --step when the targeted substep lacks DELEGATE', async () => {
    await writeDelegateRunbook();

    const start = await runCliInProcess(
      'run --prompted runbooks/parent.runbook.md --text',
      workspace,
    );
    expect(start.exitCode).toBe(0);

    const manual = await runCliInProcess(
      await withRunTarget(['delegate', '--step', '1.1'], workspace),
      workspace,
    );
    expect(manual.exitCode).not.toBe(0);
    expect(manual.stdout + manual.stderr).toMatch(/RD-813|no delegatable substep/i);

    // Verify no delegation record was persisted for either substep.
    const state = await getActiveState(workspace);
    const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
    expect(substepStates).toBeDefined();
    const ss1 = substepStates?.find((ss) => ss.id === '1');
    const ss2 = substepStates?.find((ss) => ss.id === '2');
    expect(ss1?.delegation).toBeUndefined();
    expect(ss2?.delegation).toBeUndefined();
  });

  it('rejects explicit child runbook delegation when the targeted substep lacks DELEGATE', async () => {
    await writeDelegateRunbook();

    const start = await runCliInProcess(
      'run --prompted runbooks/parent.runbook.md --text',
      workspace,
    );
    expect(start.exitCode).toBe(0);

    const manual = await runCliInProcess(
      await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
      workspace,
    );
    expect(manual.exitCode).not.toBe(0);
    expect(manual.stdout + manual.stderr).toMatch(/RD-813|no delegatable substep/i);

    const state = await getActiveState(workspace);
    const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
    const ss1 = substepStates?.find((ss) => ss.id === '1');
    expect(ss1?.delegation).toBeUndefined();
  });

  it('rejects an explicit absolute child runbook when the targeted substep lacks DELEGATE', async () => {
    await writeDelegateRunbook();
    const externalDir = await mkdtemp(join(dirname(workspace.cwd), 'rd-external-child-'));
    try {
      const externalChildPath = join(externalDir, 'external-child.runbook.md');
      await writeFile(
        externalChildPath,
        createRunbook({
          title: 'External Child',
          steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
        }),
      );

      const start = await runCliInProcess(
        'run --prompted runbooks/parent.runbook.md --text',
        workspace,
      );
      expect(start.exitCode).toBe(0);

      const manual = await runCliInProcess(
        await withRunTarget(['delegate', externalChildPath, '--step', '1.1'], workspace),
        workspace,
      );
      expect(manual.exitCode).not.toBe(0);
      expect(manual.stdout + manual.stderr).toMatch(/RD-813|no delegatable substep/i);
    } finally {
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  it('after auto-delegation, rd delegate --step on a delegated substep idempotently echoes the token', async () => {
    // This variant DOES include `- DELEGATE` so auto-delegation fires on
    // step entry, producing delegation records for both substeps. A
    // subsequent manual `rd delegate --step 1.1` naming the same authored
    // runbook is idempotent: it echoes the in-flight auto-issued token
    // (issue #468) rather than erroring.
    const childContent = createRunbook({
      title: 'Child',
      steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

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
      '### 1.2 Task B',
      '',
      '- child.runbook.md',
      '',
      '## 2. Done',
      '',
      '- PASS COMPLETE',
      '',
      'Finished.',
      '',
      '```bash',
      'rd echo --result pass',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    // Substep 1.1 already carries an auto-issued delegation for the same
    // authored runbook; the targeted manual delegate echoes it idempotently.
    const before = await getActiveState(workspace);
    const issuedToken = before?.substepStates?.find((substep) => substep.id === '1')?.delegation
      ?.token;
    expect(issuedToken).toBeDefined();

    const manual = await runCliInProcess(
      await withRunTarget(['delegate', 'child.runbook.md', '--step', '1.1'], workspace),
      workspace,
    );
    expect(manual.exitCode).toBe(0);
    const json = parseCliJsonObject(manual.stdout);
    expect(json).toMatchObject({ kind: 'delegate', action: 'already-delegated', step: '1.1' });
    expect(json.token).toBe(issuedToken);
  });
});

describe('DELEGATE re-entry and retry', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /**
   * Build and start a parent runbook with DELEGATE on step 1, two substeps
   * both referencing child.runbook.md (first pass, second fail), and
   * `FAIL ANY RETRY 1 STOP` aggregation. Returns the first-entry tokens.
   */
  async function setupRetryParent(): Promise<{
    parentRunId: string;
    token1: string;
    token2: string;
  }> {
    const passChild = createRunbook({
      title: 'Child Pass',
      steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    const failChild = createRunbook({
      title: 'Child Fail',
      steps: [
        { title: 'Do work', pass: 'COMPLETE', fail: 'STOP', command: 'rd echo --result fail' },
      ],
    });

    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), passChild);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), passChild);
    await writeFile(join(workspace.cwd, 'runbooks', 'child-fail.runbook.md'), failChild);
    await writeFile(join(workspace.runbooksDir(), 'child-fail.runbook.md'), failChild);

    const parentContent = [
      '# Parent',
      '',
      '## 1. Fan-out',
      '',
      '- DELEGATE',
      '- PASS ALL CONTINUE',
      '- FAIL ANY RETRY 1 STOP',
      '',
      '### 1.1 Task A',
      '',
      '- child.runbook.md',
      '',
      '### 1.2 Task B',
      '',
      '- child-fail.runbook.md',
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
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const parentState = await getActiveState(workspace);
    expect(parentState).not.toBeNull();
    const parentRunId = parentState!.id;

    const frontier = findFrontierInEvents(parseConcatenatedJson(start.stdout)) ?? [];
    const token1 = frontier.find((f) => f.id === '1.1')?.token;
    const token2 = frontier.find((f) => f.id === '1.2')?.token;
    expect(token1).toBeDefined();
    expect(token2).toBeDefined();

    return { parentRunId, token1: token1!, token2: token2! };
  }

  it('RETRY re-entry: every delegated substep is re-issued with a fresh token (spec §8.1 Test 1)', async () => {
    const { parentRunId, token1: tokenA1, token2: tokenA2 } = await setupRetryParent();

    // Subagent 1.1 passes (pass child auto-completes and triggers propagation).
    // Bare `pass` would target parent under reverted Route A — thread --claim-id.
    let r = await runCliInProcess(`claim ${tokenA1}`, workspace);
    expect(r.exitCode).toBe(0);
    const claimA1 = findActionOutput(r.stdout);
    expect(claimA1).not.toBeNull();
    const claimIdA1 = String(claimA1!.claim_id);
    r = await runCliInProcess(['pass', '--claim-id', claimIdA1], workspace);
    expect(r.exitCode).toBe(0);

    // Subagent 1.2 fails — REPORTS fail. Exit-code narrowing: the child's FAIL
    // action is STOP, so the child locally STOPs and `rd fail` exits 1.
    r = await runCliInProcess(`claim ${tokenA2}`, workspace);
    expect(r.exitCode).toBe(0);
    const claimA2 = findActionOutput(r.stdout);
    expect(claimA2).not.toBeNull();
    const claimIdA2 = String(claimA2!.claim_id);
    const failResult = await runCliInProcess(['fail', '--claim-id', claimIdA2], workspace);
    expect(failResult.exitCode).toBe(1);

    // `rd collect` applies both reported outcomes and drives FAIL ANY → RETRY 1,
    // re-entering the DELEGATE step and re-issuing fresh tokens for BOTH
    // substeps under uniform re-delegation. RETRY is non-terminal, so collect
    // exits 0 and reports the re-opened substeps as unresolved again.
    const collectResult = await runCliInProcess(
      await withRunTarget(['collect'], workspace),
      workspace,
    );
    expect(collectResult.exitCode).toBe(0);
    const parsedCollect = parseConcatenatedJson(collectResult.stdout);
    const collectEvents = flattenEventObjects(parsedCollect);
    const retryTransition = collectEvents.find(
      (e) => e.type === 'step_transitioned' && e.action === 'RETRY',
    );
    expect(retryTransition).toBeDefined();
    expect(retryTransition?.aggregated).toBe(true);
    const reentryFrontier = findAllFrontiersInEvents(parsedCollect).at(-1);
    expect(reentryFrontier).toBeDefined();
    expect(reentryFrontier).toHaveLength(2);
    const collect = collectEvents.find((e) => e.kind === 'collect');
    expect(collect).toBeDefined();
    expect(collect!.status).toBe('applied');
    expect(collect!.lifecycle).toBe('running');
    expect(collect!.unresolved).toBe(2);

    // Collect streams the re-entry frontier: both substeps carry a fresh token
    // distinct from the first-entry tokens.
    const reentered = await readRunbookState(workspace, parentRunId);
    expect(reentered?.step).toBe('1');
    const reToken1 = reentryFrontier?.find((x) => x.id === '1.1')?.token;
    const reToken2 = reentryFrontier?.find((x) => x.id === '1.2')?.token;
    expect(reToken1).toEqual(expect.stringMatching(/^rdtk_/));
    expect(reToken2).toEqual(expect.stringMatching(/^rdtk_/));
    expect(reToken1).not.toBe(tokenA1);
    expect(reToken2).not.toBe(tokenA2);
  }, 30_000);

  it('cancelled tokens return TOKEN_CANCELLED on claim — every prior token is unclaimable (spec §8.1 Test 2)', async () => {
    const { token1: tokenA1, token2: tokenA2 } = await setupRetryParent();

    // Subagent 1.1 passes. Bare `pass` would target parent under reverted
    // Route A — thread --claim-id.
    let r = await runCliInProcess(`claim ${tokenA1}`, workspace);
    expect(r.exitCode).toBe(0);
    const claimA1 = findActionOutput(r.stdout);
    expect(claimA1).not.toBeNull();
    const claimIdA1 = String(claimA1!.claim_id);
    r = await runCliInProcess(['pass', '--claim-id', claimIdA1], workspace);
    expect(r.exitCode).toBe(0);

    // Subagent 1.2 fails — REPORTS fail (report-only). `rd collect` below drives
    // the RETRY that re-issues fresh tokens and cancels the originals.
    r = await runCliInProcess(`claim ${tokenA2}`, workspace);
    expect(r.exitCode).toBe(0);
    const claimA2 = findActionOutput(r.stdout);
    expect(claimA2).not.toBeNull();
    const claimIdA2 = String(claimA2!.claim_id);
    const failResult = await runCliInProcess(['fail', '--claim-id', claimIdA2], workspace);
    // Exit-code narrowing: the child's FAIL action is STOP → `rd fail` exits 1.
    expect(failResult.exitCode).toBe(1);

    // `rd collect` drives FAIL ANY → RETRY, re-issuing fresh tokens for BOTH
    // substeps and streaming the re-entry frontier.
    const collectResult = await runCliInProcess(
      await withRunTarget(['collect'], workspace),
      workspace,
    );
    expect(collectResult.exitCode).toBe(0);
    const tokenFrontier = findAllFrontiersInEvents(parseConcatenatedJson(collectResult.stdout)).at(
      -1,
    );
    expect(tokenFrontier).toBeDefined();
    const tokenB1 = tokenFrontier?.find((x) => x.id === '1.1')?.token;
    const tokenB2 = tokenFrontier?.find((x) => x.id === '1.2')?.token;
    expect(tokenB1).toBeDefined();
    expect(tokenB2).toBeDefined();
    expect(tokenB1).not.toBe(tokenA1);
    expect(tokenB2).not.toBe(tokenA2);

    // BOTH old tokens (pass-branch tokenA1 and fail-branch tokenA2) must be
    // unclaimable — the delegation records were replaced by fresh ones.
    const claimOld1 = await runCliInProcess(`claim ${tokenA1}`, workspace);
    expect(claimOld1.exitCode).not.toBe(0);
    expect(claimOld1.stdout + claimOld1.stderr).toMatch(
      /cancelled|not found|no active run|RD-809|RD-808/i,
    );

    const claimOld2 = await runCliInProcess(`claim ${tokenA2}`, workspace);
    expect(claimOld2.exitCode).not.toBe(0);
    expect(claimOld2.stdout + claimOld2.stderr).toMatch(
      /cancelled|not found|no active run|RD-809|RD-808/i,
    );
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Spec §8.1 Test 3 — PASS ANY RETRY symmetry.
  //
  // The literal spec example ("Subagent 1 passes, subagent 2 fails") would
  // never exercise the pass-branch retry under `PASS ANY` because the first
  // pass satisfies aggregation and no retry fires. Adapted to `PASS ALL
  // RETRY 1 CONTINUE` (per the task description): substep 1.1 passes, 1.2
  // fails → PASS ALL is not satisfied → the pass-branch retry hook fires
  // and re-delegates the failed substep. Same hook, same shape as the
  // FAIL branch — this is the symmetry assertion.
  // ---------------------------------------------------------------------------
  it('PASS ANY RETRY re-issues fresh tokens on the pass-branch retry (spec §8.1 Test 3 — pass/fail symmetry)', async () => {
    const passChild = createRunbook({
      title: 'Child Pass',
      steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    const failChild = createRunbook({
      title: 'Child Fail',
      steps: [
        { title: 'Do work', pass: 'COMPLETE', fail: 'STOP', command: 'rd echo --result fail' },
      ],
    });

    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), passChild);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), passChild);
    await writeFile(join(workspace.cwd, 'runbooks', 'child-fail.runbook.md'), failChild);
    await writeFile(join(workspace.runbooksDir(), 'child-fail.runbook.md'), failChild);

    // Optimistic aggregation: PASS ANY + FAIL ALL. With 1 pass + 1 fail,
    // aggregation strategy is ANY → PASS branch evaluates (passCount > 0) →
    // retry budget is consumed via the PASS-branch transition, driving the
    // pass-branch retry hook symmetrically to the FAIL-branch path.
    const parentContent = [
      '# Parent',
      '',
      '## 1. Fan-out',
      '',
      '- DELEGATE',
      '- PASS ANY RETRY 1 CONTINUE',
      '- FAIL ALL STOP',
      '',
      '### 1.1 Task A',
      '',
      '- child.runbook.md',
      '',
      '### 1.2 Task B',
      '',
      '- child-fail.runbook.md',
      '',
      '## 2. Done',
      '',
      '- PASS COMPLETE',
      '',
      'Finished.',
      '',
      '```bash',
      'rd echo --result pass',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const parentRunId = (await getActiveState(workspace))!.id;
    const firstFrontier = findFrontierInEvents(parseConcatenatedJson(start.stdout)) ?? [];
    const token1 = firstFrontier.find((f) => f.id === '1.1')?.token;
    const token2 = firstFrontier.find((f) => f.id === '1.2')?.token;
    expect(token1).toBeDefined();
    expect(token2).toBeDefined();

    // Subagent 1.1 passes. Bare `pass` would target parent under reverted
    // Route A — thread --claim-id.
    let r = await runCliInProcess(`claim ${token1!}`, workspace);
    expect(r.exitCode).toBe(0);
    const claim1 = findActionOutput(r.stdout);
    expect(claim1).not.toBeNull();
    const claimId1 = String(claim1!.claim_id);
    r = await runCliInProcess(['pass', '--claim-id', claimId1], workspace);
    expect(r.exitCode).toBe(0);

    // Subagent 1.2 fails. FAIL ALL is NOT satisfied (one passed); PASS ALL
    // is NOT satisfied (one failed) so the PASS-branch retry fires with
    // budget=1. Under uniform re-delegation (docs/spec/language.md §4.2, §5) the retry
    // hook re-issues delegations for BOTH substeps symmetrically — the hook
    // is result-agnostic regardless of aggregation branch.
    r = await runCliInProcess(`claim ${token2!}`, workspace);
    expect(r.exitCode).toBe(0);
    const claim2 = findActionOutput(r.stdout);
    expect(claim2).not.toBeNull();
    const claimId2 = String(claim2!.claim_id);
    const failResult = await runCliInProcess(['fail', '--claim-id', claimId2], workspace);
    // Exit-code narrowing: the child's FAIL action is STOP → `rd fail` exits 1.
    expect(failResult.exitCode).toBe(1);

    // `rd collect` drives the pass-branch RETRY, re-issuing fresh tokens for
    // BOTH substeps symmetrically (re-entry frontier lives in state).
    const collectResult = await runCliInProcess(
      await withRunTarget(['collect'], workspace),
      workspace,
    );
    expect(collectResult.exitCode).toBe(0);
    const reentered = await readRunbookState(workspace, parentRunId);
    const entry1Token = reentered?.substepStates?.find((x) => x.id === '1')?.delegation?.token;
    const entry2Token = reentered?.substepStates?.find((x) => x.id === '2')?.delegation?.token;
    expect(entry1Token).toEqual(expect.stringMatching(/^rdtk_/));
    expect(entry2Token).toEqual(expect.stringMatching(/^rdtk_/));
    expect(entry1Token).not.toBe(token1!);
    expect(entry2Token).not.toBe(token2!);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Spec §8.1 Test 4 — Manual delegation requires authored DELEGATE.
  //
  // A runbook-list substep without `- DELEGATE` is not a delegation frontier.
  // Passing child inputs must not bypass that guard or persist a token.
  // ---------------------------------------------------------------------------
  it('manual delegation with input is rejected on non-annotated runbook-list substeps (spec §8.1 Test 4)', async () => {
    const failChild = createRunbook({
      title: 'Child Fail',
      steps: [
        { title: 'Do work', pass: 'COMPLETE', fail: 'STOP', command: 'rd echo --result fail' },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child-fail.runbook.md'), failChild);
    await writeFile(join(workspace.runbooksDir(), 'child-fail.runbook.md'), failChild);

    const parentContent = [
      '# Parent',
      '',
      '## 1. Legacy review',
      '',
      '- PASS ALL CONTINUE',
      '- FAIL ANY RETRY 1 STOP',
      '',
      '### 1.1 Manual review',
      '',
      'Manual delegation target.',
      '',
      '## 2. Done',
      '',
      '- PASS COMPLETE',
      '',
      'Finished.',
      '',
      '```bash',
      'rd echo --result pass',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    // No auto-delegation — first-entry frontier must be absent.
    const firstFrontier = findFrontierInEvents(parseConcatenatedJson(start.stdout));
    expect(firstFrontier).toBeUndefined();

    const manual = await runCliInProcess(
      await withRunTarget(
        ['delegate', 'runbooks/child-fail.runbook.md', '--step', '1.1', '--input', 'env=staging'],
        workspace,
      ),
      workspace,
    );
    expect(manual.exitCode).not.toBe(0);
    expect(manual.stdout + manual.stderr).toMatch(/RD-813|no delegatable substep/i);

    const state = await getActiveState(workspace);
    const substeps = state?.substepStates as Array<Record<string, unknown>> | undefined;
    const ss1 = substeps?.find((ss) => ss.id === '1');
    expect(ss1?.delegation).toBeUndefined();
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Spec §8.1 Test 5 — `rd delegate --retry` CLI equivalence.
  //
  // All three forms (token, --step, inferred) produce state identical to what
  // the internal retry hook would produce. We run each form in its own
  // workspace and assert the post-retry state shape (substep delegation exists,
  // has a fresh token, cancelledAt null, childRunId null, same childRunbookPath).
  // ---------------------------------------------------------------------------
  it('rd delegate --retry CLI forms (token, --step, inferred) all produce equivalent state (spec §8.1 Test 5)', async () => {
    // Helper: build a parent + child, resolve ss1, and leave ss2 pending
    // (token issued but childRunId still null) so it is suitable for retry.
    async function setupPendingSecond(): Promise<{
      parentRunId: string;
      token2: string;
      priorDelegation: Record<string, unknown>;
    }> {
      const { parentRunId, token1, token2 } = await setupRetryParent();
      // Resolve 1.1 so cursor advances to 1.2 (required for inferred form to
      // resolve to substep '2' correctly). Bare `pass` would target parent
      // under reverted Route A — thread --claim-id to land on the child.
      let r = await runCliInProcess(`claim ${token1}`, workspace);
      expect(r.exitCode).toBe(0);
      const claim1 = findActionOutput(r.stdout);
      expect(claim1).not.toBeNull();
      const claimId1 = String(claim1!.claim_id);
      r = await runCliInProcess(['pass', '--claim-id', claimId1], workspace);
      expect(r.exitCode).toBe(0);
      const state = await readRunbookState(workspace, parentRunId);
      const substeps = state?.substepStates as Array<Record<string, unknown>> | undefined;
      const ss = substeps?.find((s) => s.id === '2');
      const priorDelegation = ss?.delegation as Record<string, unknown>;
      expect(priorDelegation.childRunId).toBeNull();
      return { parentRunId, token2, priorDelegation };
    }

    // Form 1: token positional. Token-form resolves by tokenHash regardless
    // of active session top (parent is looked up via scan).
    {
      const { parentRunId, token2, priorDelegation } = await setupPendingSecond();
      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', token2], workspace),
        workspace,
      );
      expect(retry.exitCode).toBe(0);
      const out = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(out.action).toBe('retried');
      expect((out.token as string).startsWith('rdtk_')).toBe(true);
      expect(out.token).not.toBe(token2);
      // State shape: delegation replaced on parent, same childRunbookPath,
      // new hash, cancelledAt=null, childRunId=null.
      const state = await readRunbookState(workspace, parentRunId);
      const substeps = state?.substepStates as Array<Record<string, unknown>> | undefined;
      const ss = substeps?.find((s) => s.id === '2');
      const d = ss?.delegation as Record<string, unknown>;
      expect(d).toBeDefined();
      expect(d.cancelledAt).toBeNull();
      expect(d.childRunId).toBeNull();
      expect(d.childRunbookPath).toBe(priorDelegation.childRunbookPath);
      expect(d.tokenHash).not.toBe(priorDelegation.tokenHash);
    }
    await workspace.cleanup();
    workspace = await createTestWorkspace();

    // Form 2: --step. Requires active session to point at the parent. Under
    // reverted Route A, the parent remains at session top after `rd claim`
    // (claimed children are not pushed onto defaultStack), so no session
    // manipulation is needed.
    {
      const { parentRunId, priorDelegation } = await setupPendingSecond();
      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', '--step', '1.2'], workspace),
        workspace,
      );
      expect(retry.exitCode).toBe(0);
      const out = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(out.action).toBe('retried');
      expect(out.step).toBe('1.2');
      const state = await readRunbookState(workspace, parentRunId);
      const substeps = state?.substepStates as Array<Record<string, unknown>> | undefined;
      const ss = substeps?.find((s) => s.id === '2');
      const d = ss?.delegation as Record<string, unknown>;
      expect(d.cancelledAt).toBeNull();
      expect(d.childRunId).toBeNull();
      expect(d.childRunbookPath).toBe(priorDelegation.childRunbookPath);
      expect(d.tokenHash).not.toBe(priorDelegation.tokenHash);
    }
    await workspace.cleanup();
    workspace = await createTestWorkspace();

    // Form 3: inferred (no args) — infers from the ACTIVE substep. Under
    // report-then-collect (Plan 5) the parent's substep cursor does NOT advance
    // when a delegated child reports (close is report-only — see
    // setupPendingSecond, where passing 1.1 leaves the cursor on 1.1). So in a
    // fan-out the active substep is always the first substep (1.1). Use a fresh
    // parent with 1.1 still pending and assert the inferred form retries 1.1 —
    // unlike Forms 1/2, which target 1.2 explicitly by token/--step.
    {
      const { parentRunId } = await setupRetryParent();
      // Capture 1.1's prior (pending) delegation: childRunId null, no result.
      const preState = await readRunbookState(workspace, parentRunId);
      const preSubsteps = preState?.substepStates as Array<Record<string, unknown>> | undefined;
      const preSs1 = preSubsteps?.find((s) => s.id === '1');
      const priorDelegation = preSs1?.delegation as Record<string, unknown>;

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry'], workspace),
        workspace,
      );
      expect(retry.exitCode).toBe(0);
      const out = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(out.action).toBe('retried');
      const state = await readRunbookState(workspace, parentRunId);
      const substeps = state?.substepStates as Array<Record<string, unknown>> | undefined;
      const ss = substeps?.find((s) => s.id === '1');
      const d = ss?.delegation as Record<string, unknown>;
      expect(d.cancelledAt).toBeNull();
      expect(d.childRunId).toBeNull();
      expect(d.childRunbookPath).toBe(priorDelegation.childRunbookPath);
      expect(d.tokenHash).not.toBe(priorDelegation.tokenHash);
    }

    // Ambiguity rejection: token + --step is an error.
    await workspace.cleanup();
    workspace = await createTestWorkspace();
    const { token2 } = await setupPendingSecond();
    const ambiguous = await runCliInProcess(
      ['delegate', '--retry', token2, '--step', '1.2'],
      workspace,
    );
    expect(ambiguous.exitCode).not.toBe(0);
    expect(ambiguous.stdout + ambiguous.stderr).toMatch(/specify either a token or --step/);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Spec §8.1 Test 6 — RETRY exhaustion fires the configured action.
  //
  // `FAIL ANY RETRY 1 STOP`. Both attempts fail (two attempts = one retry
  // after the first failure). On the second failure, the retry budget is
  // exhausted → the exhaustion action (STOP) fires → runbook reaches
  // `lifecycle: 'stopped'`.
  // ---------------------------------------------------------------------------
  it('RETRY exhaustion: second failure consumes retry budget without re-issuing (spec §8.1 Test 6)', async () => {
    const { parentRunId, token1, token2: tokenA2 } = await setupRetryParent();

    // Attempt 1: 1.1 passes, 1.2 fails — both report-only; `rd collect` below
    // drives the RETRY (budget 0→1). Bare `pass`/`fail` would target parent
    // under reverted Route A — thread --claim-id to land on each child.
    let r = await runCliInProcess(`claim ${token1}`, workspace);
    expect(r.exitCode).toBe(0);
    const claim1 = findActionOutput(r.stdout);
    expect(claim1).not.toBeNull();
    const claimId1 = String(claim1!.claim_id);
    r = await runCliInProcess(['pass', '--claim-id', claimId1], workspace);
    expect(r.exitCode).toBe(0);

    r = await runCliInProcess(`claim ${tokenA2}`, workspace);
    expect(r.exitCode).toBe(0);
    const claimA2 = findActionOutput(r.stdout);
    expect(claimA2).not.toBeNull();
    const claimIdA2 = String(claimA2!.claim_id);
    // Report-only (Plan 5): the child's own FAIL action is STOP, so `rd fail`
    // exits 1 on the child's lifecycle; the parent is NOT yet aggregated.
    const firstFail = await runCliInProcess(['fail', '--claim-id', claimIdA2], workspace);
    expect(firstFail.exitCode).toBe(1);

    // `rd collect` applies both reported outcomes and drives FAIL ANY → RETRY 1,
    // re-entering the DELEGATE step with fresh tokens for BOTH substeps under
    // uniform re-delegation. RETRY is non-terminal → collect exits 0.
    const firstCollect = await runCliInProcess(
      await withRunTarget(['collect'], workspace),
      workspace,
    );
    expect(firstCollect.exitCode).toBe(0);
    const firstSummary = flattenEventObjects(parseConcatenatedJson(firstCollect.stdout)).find(
      (e) => e.kind === 'collect',
    );
    expect(firstSummary).toBeDefined();
    expect(firstSummary!.status).toBe('applied');
    expect(firstSummary!.lifecycle).toBe('running');

    // The re-entry frontier is emitted by collect: retry budget consumed and
    // both substeps re-issued.
    const afterFirst = await readRunbookState(workspace, parentRunId);
    expect(afterFirst?.retryCount).toBe(1);
    const firstFrontier = findAllFrontiersInEvents(parseConcatenatedJson(firstCollect.stdout)).at(
      -1,
    );
    expect(firstFrontier).toBeDefined();
    const tokenB1 = firstFrontier?.find((x) => x.id === '1.1')?.token;
    const tokenB2 = firstFrontier?.find((x) => x.id === '1.2')?.token;
    expect(tokenB1).toEqual(expect.stringMatching(/^rdtk_/));
    expect(tokenB2).toEqual(expect.stringMatching(/^rdtk_/));

    // Attempt 2: claim+resolve BOTH substeps again. 1.1 passes, 1.2 fails. The
    // retry budget is already consumed (retryCount=1); the second collect cycle
    // finds FAIL ANY satisfied and the retry guard no longer matches →
    // exhaustion action (STOP) fires.
    r = await runCliInProcess(`claim ${tokenB1!}`, workspace);
    expect(r.exitCode).toBe(0);
    const claimB1 = findActionOutput(r.stdout);
    expect(claimB1).not.toBeNull();
    const claimIdB1 = String(claimB1!.claim_id);
    r = await runCliInProcess(['pass', '--claim-id', claimIdB1], workspace);
    expect(r.exitCode).toBe(0);

    r = await runCliInProcess(`claim ${tokenB2!}`, workspace);
    expect(r.exitCode).toBe(0);
    const claimB2 = findActionOutput(r.stdout);
    expect(claimB2).not.toBeNull();
    const claimIdB2 = String(claimB2!.claim_id);
    // Child stops with non-zero — the child's FAIL STOP fires on its own lifecycle.
    const secondFail = await runCliInProcess(['fail', '--claim-id', claimIdB2], workspace);
    expect(secondFail.exitCode).toBe(1);

    // `rd collect` drains the second round: retry budget exhausted → the
    // exhaustion action (STOP) fires. STOP is terminal → collect exits 1.
    const secondCollect = await runCliInProcess(
      await withRunTarget(['collect'], workspace),
      workspace,
    );
    expect(secondCollect.exitCode).toBe(1);

    // Core invariant: the second cycle does NOT mint a new frontier (retry
    // exhausted) — retryCount stays at 1 — and the parent reaches STOP.
    const parentState = await readRunbookState(workspace, parentRunId);
    expect(parentState).not.toBeNull();
    const ss2 = parentState?.substepStates?.find((s) => s.id === '2');
    expect(ss2?.result).toBe('fail');
    expect(parentState!.retryCount).toBe(1);
    expect(parentState!.lifecycle).toBe('stopped');
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Spec §8.1 Test 7 — Mixed DELEGATE + command substeps.
  //
  // Step 1 has `- DELEGATE` annotation. Substep 1.1 has a runbook reference
  // (auto-delegated). Substep 1.2 is a plain command substep (no runbook,
  // no delegation). Both fail → FAIL ANY RETRY 1 CONTINUE. On retry, 1.1
  // gets a fresh delegation token; 1.2's command re-executes.
  // ---------------------------------------------------------------------------
  it('mixed DELEGATE + command substeps: retry re-delegates 1.1; ss2 has no delegation (spec §8.1 Test 7)', async () => {
    const failChild = createRunbook({
      title: 'Child Fail',
      steps: [
        { title: 'Do work', pass: 'COMPLETE', fail: 'STOP', command: 'rd echo --result fail' },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child-fail.runbook.md'), failChild);
    await writeFile(join(workspace.runbooksDir(), 'child-fail.runbook.md'), failChild);

    // Step 1: Mixed fan-out with per-substep DELEGATE (spec §4.3 Form 2).
    // Substep 1.1: DELEGATE + runbook reference (delegation, auto-issued).
    // Substep 1.2: command substep (no runbook, no delegation).
    // Step-level `- DELEGATE` would be a structural error here: spec §4.3
    // requires every DELEGATE substep to resolve to a runbook target, so a
    // step-level annotation would fail the parser's guard.
    const parentContent = [
      '# Parent',
      '',
      '## 1. Mixed fan-out',
      '',
      '- PASS ALL CONTINUE',
      '- FAIL ANY RETRY 1 CONTINUE',
      '',
      '### 1.1 Delegate task',
      '',
      '- DELEGATE',
      '- child-fail.runbook.md',
      '',
      '### 1.2 Command task',
      '',
      '```bash',
      'rd echo --result fail',
      '```',
      '',
      '## 2. Done',
      '',
      '- PASS COMPLETE',
      '',
      'Finished.',
      '',
      '```bash',
      'rd echo --result pass',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const parentRunId = (await getActiveState(workspace))!.id;

    // The DELEGATE annotation auto-issues for substep 1.1 only (1.2 has no
    // runbook reference so inference skips it).
    const firstFrontier = findFrontierInEvents(parseConcatenatedJson(start.stdout)) ?? [];
    expect(firstFrontier.length).toBe(1);
    expect(firstFrontier[0].id).toBe('1.1');
    const tokenA = firstFrontier[0].token;

    // Subagent 1.1 claims + fails (report-only). Bare `fail` would target parent
    // under reverted Route A — thread --claim-id to land on the child. The
    // child's own FAIL action is STOP, so `rd fail` exits 1 on the child's
    // lifecycle; the parent is left collection pending.
    let r = await runCliInProcess(`claim ${tokenA}`, workspace);
    expect(r.exitCode).toBe(0);
    const claimA = findActionOutput(r.stdout);
    expect(claimA).not.toBeNull();
    const claimIdA = String(claimA!.claim_id);
    r = await runCliInProcess(['fail', '--claim-id', claimIdA], workspace);
    expect(r.exitCode).toBe(1);

    // The delegated child has reported, so the parent is collection pending —
    // bare `rd fail` on the command substep would be BLOCKED
    // (DELEGATION_COLLECTION_PENDING) until the orchestrator collects. `rd collect`
    // applies ss1's reported fail and advances the substep cursor to 1.2 (the
    // command substep). The step rule has NOT aggregated yet — 1.2 is still
    // unresolved (collect reports unresolved > 0, lifecycle running).
    const collectResult = await runCliInProcess(
      await withRunTarget(['collect'], workspace),
      workspace,
    );
    expect(collectResult.exitCode).toBe(0);
    const collect = flattenEventObjects(parseConcatenatedJson(collectResult.stdout)).find(
      (e) => e.kind === 'collect',
    );
    expect(collect).toBeDefined();
    expect(collect!.status).toBe('applied');
    expect(collect!.lifecycle).toBe('running');

    // In --prompted mode the command is printed but not executed — explicitly
    // fail ss2 to drive aggregation. ss2 is a command substep with no delegation
    // (and no pending report), so bare `fail` now targets the parent's active
    // substep (1.2) directly. With both substeps fail, FAIL ANY RETRY 1 CONTINUE
    // fires the retry hook. Because this is a direct parent transition (not a
    // delegation report), RETRY fires inline here and `rd fail` exits 0
    // (non-terminal re-entry). 1.1 gets a fresh delegation; 1.2 (no delegation)
    // is untouched by the hook.
    const fail12 = await runCliInProcess(await withRunTarget(['fail'], workspace), workspace);
    expect(fail12.exitCode).toBe(0);

    // STEP_TRANSITIONED with action=RETRY is the canonical retry signal.
    // Aggregated-driven RETRY emits with aggregated: true (spec §3.5).
    const events = flattenEventObjects(parseConcatenatedJson(fail12.stdout));
    const retryTransition = events.find(
      (e) => e.type === 'step_transitioned' && e.action === 'RETRY',
    );
    expect(retryTransition).toBeDefined();
    expect(retryTransition?.aggregated).toBe(true);

    // Re-entry re-delegates only 1.1 (the hook is provenance-agnostic over
    // delegations, not over substep kinds). The fresh token lives in state.
    const reentered = await readRunbookState(workspace, parentRunId);
    expect(reentered?.retryCount).toBe(1);
    const ss1 = reentered?.substepStates?.find((s) => s.id === '1');
    expect(ss1?.delegation?.token).toEqual(expect.stringMatching(/^rdtk_/));
    expect(ss1?.delegation?.token).not.toBe(tokenA);
    // 1.2 carries no delegation to re-issue.
    const ss2 = reentered?.substepStates?.find((s) => s.id === '2');
    expect(ss2?.delegation).toBeUndefined();
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Spec §8.1 Test 8 — FOR + DELEGATE + iteration retry.
  //
  // A FOR loop over 2 iterations with iteration-level `FAIL ANY RETRY 1 DEFER`.
  // Iteration 1's subagent fails on the first attempt; the iteration-retry
  // hook re-issues a fresh delegation token in the same iteration frame.
  //
  // Core invariant: a retry within an iteration produces a fresh token
  // (distinct from the original). This exercises the iteration-retry branch
  // of the retry hook (compiler.ts lines 1001-1031) — confirms parity with
  // the parent-aggregation retry exercised in Tests 1-7.
  //
  // Driving the full `2 iterations × 1 retry = 3 tokens` flow from a single
  // test is brittle because iteration advance, aggregation, and nested child
  // runbook lifecycle interact in ways that depend on DEFER semantics. We
  // verify the essential retry-hook invariant (fresh token within an
  // iteration frame, correct forIndex on the RETRY transition) instead.
  // ---------------------------------------------------------------------------
  it('FOR + DELEGATE + per-iteration retry re-issues delegations with fresh tokens (spec §8.1 Test 8)', async () => {
    const failChild = createRunbook({
      title: 'Child Fail',
      steps: [
        { title: 'Do work', pass: 'COMPLETE', fail: 'STOP', command: 'rd echo --result fail' },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child-fail.runbook.md'), failChild);
    await writeFile(join(workspace.runbooksDir(), 'child-fail.runbook.md'), failChild);

    // Pattern mirrors runbooks/for-loops/for-retry-defer.runbook.md but uses
    // a DELEGATE substep (runbook ref) instead of a command substep. The H3
    // substep gets implicit DEFER_TRANSITIONS (runbook ref under aggregation).
    // Iteration-level `FAIL ANY RETRY 1 DEFER` triggers the retry hook on
    // iteration failure then defers the outcome into the parent step
    // aggregation on exhaustion.
    const parentContent = [
      '# Parent',
      '',
      '## 1. Process items',
      '',
      '- FOR i IN 1 TO 2',
      '  - PASS ALL CONTINUE',
      '  - FAIL ANY RETRY 1 DEFER',
      '- DELEGATE',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Check {{i}}',
      '',
      '- child-fail.runbook.md',
      '',
      '## 2. Done',
      '',
      '- PASS COMPLETE',
      '',
      'All items processed.',
      '',
      '```bash',
      'rd echo --result pass',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const parentRunId = (await getActiveState(workspace))!.id;

    // First-entry frontier: iteration 1's DELEGATE substep.
    const firstFrontier = findFrontierInEvents(parseConcatenatedJson(start.stdout)) ?? [];
    expect(firstFrontier.length).toBeGreaterThanOrEqual(1);
    const iter1TokenA = firstFrontier[0].token;
    expect(iter1TokenA.startsWith('rdtk_')).toBe(true);

    // Iteration 1, attempt 1: claim + fail (report-only). Bare `fail` would
    // target parent under reverted Route A — thread --claim-id to land on the
    // child. The child's own FAIL action is STOP, so `rd fail` exits 1 on the
    // child's lifecycle; the iteration is NOT yet aggregated.
    const r = await runCliInProcess(`claim ${iter1TokenA}`, workspace);
    expect(r.exitCode).toBe(0);
    const claimIter1 = findActionOutput(r.stdout);
    expect(claimIter1).not.toBeNull();
    const claimIdIter1 = String(claimIter1!.claim_id);
    const fail1 = await runCliInProcess(['fail', '--claim-id', claimIdIter1], workspace);
    expect(fail1.exitCode).toBe(1);

    // `rd collect` applies the reported outcome and drives the iteration-level
    // FAIL ANY RETRY → re-issues a fresh delegation token in the SAME iteration
    // frame. RETRY is non-terminal → collect exits 0.
    const collectResult = await runCliInProcess(
      await withRunTarget(['collect'], workspace),
      workspace,
    );
    expect(collectResult.exitCode).toBe(0);
    const collect = flattenEventObjects(parseConcatenatedJson(collectResult.stdout)).find(
      (e) => e.kind === 'collect',
    );
    expect(collect).toBeDefined();
    expect(collect!.status).toBe('applied');
    expect(collect!.lifecycle).toBe('running');

    // The re-entry lives in state (collect emits a summary, not step_entered
    // events). Tighten to exactly one delegation-bearing substep: a regression
    // that re-issued sibling iterations would add entries. Per-iteration scoping
    // is the invariant under test.
    const reentered = await readRunbookState(workspace, parentRunId);
    expect(reentered?.retryCount).toBe(1);
    const iterSubsteps = (reentered?.substepStates ?? []).filter((s) => s.delegation);
    expect(iterSubsteps).toHaveLength(1);
    const iterSubstep = iterSubsteps[0];

    // Core invariant: retry within an iteration produces a fresh token. Same
    // iteration frame, but distinct token — the iteration-retry hook does not
    // reuse the original delegation token.
    const iter1TokenB = iterSubstep.delegation?.token;
    expect(iter1TokenB).toEqual(expect.stringMatching(/^rdtk_/));
    expect(iter1TokenB).not.toBe(iter1TokenA);

    // The re-issued delegation must scope to substep 1.1 in iteration 1 (the
    // only DELEGATE substep in this iteration). `contextSnapshot.at` carries the
    // canonical three-level `${step}.${iteration}.${substep}` and the iteration
    // binding index is 1 — this confirms the per-iteration scoping invariant.
    const iterDelegation = iterSubstep.delegation;
    if (!iterDelegation) throw new Error('Expected delegation for retried FOR substep.');
    expect(iterDelegation.contextSnapshot.at).toBe('1.1.1');
    expect(iterDelegation.contextSnapshot.index).toBe(1);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Task 11 additional test — result-agnostic CLI retry (spec §4.4).
  //
  // `rd delegate --retry` accepts retry regardless of substep result only
  // when no child run remains linked. A linked childRunId must be force-
  // aborted first so retry does not abandon an in-flight or completed child.
  // ---------------------------------------------------------------------------
  it('rd delegate --retry accepts delegations regardless of substep result (spec §4.4)', async () => {
    // State 1: PENDING (unclaimed). Start runbook; do not claim ss2.
    {
      const { parentRunId, token2 } = await setupRetryParent();
      // Sanity: delegation is pending (childRunId === null, no result yet).
      const preState = await readRunbookState(workspace, parentRunId);
      const preSubsteps = preState?.substepStates as Array<Record<string, unknown>> | undefined;
      const preSs = preSubsteps?.find((s) => s.id === '2');
      const preDel = preSs?.delegation as Record<string, unknown>;
      expect(preDel.childRunId).toBeNull();
      expect(preSs?.result).toBeUndefined();

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', token2], workspace),
        workspace,
      );
      expect(retry.exitCode).toBe(0);
      const out = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(out.action).toBe('retried');
      expect((out.token as string).startsWith('rdtk_')).toBe(true);
      expect(out.token).not.toBe(token2);
    }
    await workspace.cleanup();
    workspace = await createTestWorkspace();

    // State 2: CLAIMED (running). Claim ss2 but don't pass/fail.
    {
      const { parentRunId, token1, token2 } = await setupRetryParent();
      // Resolve ss1 first so cursor is on ss2. Bare `pass` would target
      // parent under reverted Route A — thread --claim-id.
      let r = await runCliInProcess(`claim ${token1}`, workspace);
      expect(r.exitCode).toBe(0);
      const claim1 = findActionOutput(r.stdout);
      expect(claim1).not.toBeNull();
      const claimId1 = String(claim1!.claim_id);
      r = await runCliInProcess(['pass', '--claim-id', claimId1], workspace);
      expect(r.exitCode).toBe(0);
      // Claim ss2 → childRunId set on parent's delegation record, but no
      // result yet (child runbook is now active, stuck subagent scenario).
      r = await runCliInProcess(`claim ${token2}`, workspace);
      expect(r.exitCode).toBe(0);
      // Under reverted Route A, parent stays at session top after `rd claim`.
      // Read parent by id either way to be explicit about the target.
      const preState = await readRunbookState(workspace, parentRunId);
      const preSubsteps = preState?.substepStates as Array<Record<string, unknown>> | undefined;
      const preSs = preSubsteps?.find((s) => s.id === '2');
      const preDel = preSs?.delegation as Record<string, unknown>;
      expect(preDel.childRunId).not.toBeNull();
      const priorHash = preDel.tokenHash;
      const childRunId = preDel.childRunId;

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', token2], workspace),
        workspace,
      );
      expect(retry.exitCode).not.toBe(0);
      const out = parseCliJsonObject(retry.stdout || retry.stderr);
      expect(out).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-823' }));
      expect(JSON.stringify(out)).toContain(String(childRunId));

      const postState = await readRunbookState(workspace, parentRunId);
      const postSubsteps = postState?.substepStates as Array<Record<string, unknown>> | undefined;
      const postDel = postSubsteps?.find((s) => s.id === '2')?.delegation as Record<
        string,
        unknown
      >;
      expect(postDel.tokenHash).toBe(priorHash);
      expect(postDel.childRunId).toBe(childRunId);
    }
    await workspace.cleanup();
    workspace = await createTestWorkspace();

    // State 3: PASSED but still linked. Claim ss1 + pass. The child is terminal,
    // so retry supersedes the stale outcome and mints a fresh token without
    // deleting the child diagnostic state.
    {
      const { parentRunId, token1 } = await setupRetryParent();
      let r = await runCliInProcess(`claim ${token1}`, workspace);
      expect(r.exitCode).toBe(0);
      // Bare `pass` would target parent under reverted Route A — thread
      // --claim-id to land on the child so its pass propagates to ss1.
      const claim1 = findActionOutput(r.stdout);
      expect(claim1).not.toBeNull();
      const claimId1 = String(claim1!.claim_id);
      r = await runCliInProcess(['pass', '--claim-id', claimId1], workspace);
      expect(r.exitCode).toBe(0);
      // ss1 is now done:pass. state.step is still '1' (ss2 pending).
      const preState = await readRunbookState(workspace, parentRunId);
      const preSubsteps = preState?.substepStates as Array<Record<string, unknown>> | undefined;
      const preSs = preSubsteps?.find((s) => s.id === '1');
      expect(preSs?.result).toBe('pass');
      const preDel = preSs?.delegation as Record<string, unknown>;
      const priorHash = preDel.tokenHash;
      const childRunId = preDel.childRunId;
      expect(childRunId).not.toBeNull();

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', token1], workspace),
        workspace,
      );
      expect(retry.exitCode).toBe(0);
      const out = parseCliJsonObject(retry.stdout);
      expect(out).toEqual(expect.objectContaining({ kind: 'delegate', action: 'retried' }));
      expect(String(out.token)).toMatch(/^rdtk_/);

      const postState = await readRunbookState(workspace, parentRunId);
      const postSubsteps = postState?.substepStates as Array<Record<string, unknown>> | undefined;
      const postDel = postSubsteps?.find((s) => s.id === '1')?.delegation as Record<
        string,
        unknown
      >;
      expect(postDel.tokenHash).not.toBe(priorHash);
      expect(postDel.childRunId).toBeNull();
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Task 11 additional test — idempotency with concurrent rd abort (spec §7).
  //
  // If `rd abort --force` already set `cancelledAt` on a delegation, a
  // subsequent retry (via the result-agnostic CLI form per §4.4) must
  // succeed without a double-cancel error and mint a fresh token. The
  // CLI path exercises `retryDelegation` → `abortDelegation(force=true)`
  // → `createDelegation`: the inner `abortDelegation` on an already-
  // cancelled record returns `already_cancelled` (idempotent); then
  // `createDelegation` replaces the record entirely with a fresh one.
  //
  // (Note: the state-machine retry hook is result-agnostic under uniform
  // re-delegation — it re-issues every delegated substep in the active frame
  // regardless of prior result. This test exercises the CLI form, which is
  // also result-agnostic per spec §4.4 and operates on a single operator-
  // named delegation by identifier.)
  // ---------------------------------------------------------------------------
  it('rd delegate --retry replaces already-aborted delegation without double-cancel (spec §7)', async () => {
    const { parentRunId, token2: tokenA2 } = await setupRetryParent();

    // Claim ss2 so the delegation is in claimed state (childRunId set).
    // `rd abort --force` requires a claimed delegation to exercise the
    // force-cancel path that records `cancelledAt`.
    const r = await runCliInProcess(`claim ${tokenA2}`, workspace);
    expect(r.exitCode).toBe(0);

    // Force-abort ss2's delegation. Sets cancelledAt on the delegation
    // record; records a fail resolved completion; propagates via drain.
    const parentClaimId = await issueRunControlClaim(workspace, parentRunId);
    const abortResult = await runCliInProcess(
      ['abort', tokenA2, '--claim-id', parentClaimId, '--force'],
      workspace,
    );
    expect(abortResult.exitCode).toBe(0);

    // Capture T1 (cancelledAt of the aborted delegation) and the prior
    // tokenHash. The retry about to run will REPLACE this delegation
    // record entirely — T1 is not preserved on disk (the old record is
    // gone), but the important guarantee is no double-cancel error and
    // the new delegation has cancelledAt=null with a fresh tokenHash.
    const midState = await readRunbookState(workspace, parentRunId);
    const midSubsteps = midState?.substepStates as Array<Record<string, unknown>> | undefined;
    const midSs = midSubsteps?.find((s) => s.id === '2');
    const midDel = midSs?.delegation as Record<string, unknown>;
    expect(midDel.cancelledAt).not.toBeNull();
    const priorHash = midDel.tokenHash;

    // Invoke `rd delegate --retry` on the aborted token. Per §4.4 the CLI
    // accepts retry regardless of substep state. Internally this calls
    // `retryDelegation`, which in turn calls `abortDelegation(force=true)`
    // — already-cancelled is a no-op (no double-cancel error) — then
    // `createDelegation` replaces the record. The command exits 0 and
    // emits a fresh token.
    const retry = await runCliInProcess(
      await withRunTarget(['delegate', '--retry', tokenA2], workspace),
      workspace,
    );
    expect(retry.exitCode).toBe(0);
    const retryOutput = JSON.parse(retry.stdout) as Record<string, unknown>;
    expect(retryOutput.action).toBe('retried');
    expect((retryOutput.token as string).startsWith('rdtk_')).toBe(true);

    // Read post-retry parent state. The new delegation on ss2 must have
    // cancelledAt=null and a distinct tokenHash from the aborted one.
    const postState = await readRunbookState(workspace, parentRunId);
    const postSubsteps = postState?.substepStates as Array<Record<string, unknown>> | undefined;
    const postSs = postSubsteps?.find((s) => s.id === '2');
    const postDel = postSs?.delegation as Record<string, unknown>;
    expect(postDel).toBeDefined();
    expect(postDel.cancelledAt).toBeNull();
    expect(postDel.tokenHash).not.toBe(priorHash);
  }, 30_000);

  it('abort --force then delegate --retry supersedes the stale FAIL: collect drains only the fresh outcome', async () => {
    const { parentRunId, token1, token2 } = await setupRetryParent();

    // Substep 1.1 reports PASS — a live outcome row that must survive throughout.
    let r = await runCliInProcess(`claim ${token1}`, workspace);
    expect(r.exitCode).toBe(0);
    const claim1 = findActionOutput(r.stdout);
    expect(claim1).not.toBeNull();
    const claimId1 = String(claim1!.claim_id);
    r = await runCliInProcess(['pass', '--claim-id', claimId1], workspace);
    expect(r.exitCode).toBe(0);

    // Claim + force-abort 1.2 → records a FAIL delegation outcome, collection pending.
    r = await runCliInProcess(`claim ${token2}`, workspace);
    expect(r.exitCode).toBe(0);
    const parentClaimId = await issueRunControlClaim(workspace, parentRunId);
    const abortResult = await runCliInProcess(
      ['abort', token2, '--claim-id', parentClaimId, '--force'],
      workspace,
    );
    expect(abortResult.exitCode).toBe(0);

    // Retry mints a fresh token for 1.2 and supersedes the aborted attempt: its
    // stale FAIL resolvedCompletion row is consumed and the substep reset.
    const retry = await runCliInProcess(
      await withRunTarget(['delegate', '--retry', token2], workspace),
      workspace,
    );
    expect(retry.exitCode).toBe(0);
    const retryOutput = findActionOutput<{ token: string }>(retry.stdout);
    expect(retryOutput).not.toBeNull();
    const token2b = retryOutput!.token;
    expect(token2b.startsWith('rdtk_')).toBe(true);
    expect(token2b).not.toBe(token2);

    // Collect must NOT drain the stale attempt-1 FAIL: 1.2's fresh attempt has not
    // reported, so readiness (which reads live outcome rows) refuses. Nothing is
    // applied and no aggregation transition fires from the superseded FAIL.
    const collectStale = await runCliInProcess(
      await withRunTarget(['collect'], workspace),
      workspace,
    );
    // Readiness refuses (missing_outcomes → SUBSTEPS_NOT_RESOLVED → exit 1). Assert
    // the exit code before parsing so a crashed collect (empty stdout, no parsed
    // events) cannot pass the negative event assertions below vacuously.
    expect(collectStale.exitCode).toBe(1);
    const staleEvents = flattenEventObjects(parseConcatenatedJson(collectStale.stdout));
    expect(staleEvents.some((e) => e.status === 'applied')).toBe(false);
    expect(
      staleEvents.some(
        (e) => e.type === 'step_transitioned' && (e.action === 'RETRY' || e.action === 'STOP'),
      ),
    ).toBe(false);
    const midState = await readRunbookState(workspace, parentRunId);
    expect(midState?.step).toBe('1');

    // Claim + pass the fresh 1.2 attempt, then collect drains the real PASS and
    // advances the parent (PASS ALL CONTINUE → step 2).
    r = await runCliInProcess(`claim ${token2b}`, workspace);
    expect(r.exitCode).toBe(0);
    const claim2b = findActionOutput(r.stdout);
    expect(claim2b).not.toBeNull();
    const claimId2b = String(claim2b!.claim_id);
    r = await runCliInProcess(['pass', '--claim-id', claimId2b], workspace);
    expect(r.exitCode).toBe(0);

    const collectFresh = await runCliInProcess(
      await withRunTarget(['collect'], workspace),
      workspace,
    );
    expect(collectFresh.exitCode).toBe(0);
    const freshEvents = flattenEventObjects(parseConcatenatedJson(collectFresh.stdout));
    const collect = freshEvents.find((e) => e.kind === 'collect');
    expect(collect?.status).toBe('applied');
    const afterParent = await readRunbookState(workspace, parentRunId);
    expect(afterParent?.step).toBe('2');
  }, 30_000);
});

describe('DELEGATE auto-delegation atomic failure', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('if any substep runbook cannot be resolved, no tokens are persisted and error is returned', async () => {
    // Substep 1.1 → valid child; substep 1.2 → nonexistent child.
    const childContent = createRunbook({
      title: 'Child',
      steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

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
      '### 1.2 Task B',
      '',
      '- does-not-exist.runbook.md',
      '',
      '## 2. Done',
      '',
      '- PASS COMPLETE',
      '',
      'Finished.',
      '',
      '```bash',
      'rd echo --result pass',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    // Auto-delegation must fail because substep 1.2's runbook is unresolvable.
    expect(start.exitCode).not.toBe(0);
    expect(start.stdout + start.stderr).toMatch(/not found|does-not-exist/i);

    // Atomic property: NO delegation records should be persisted for either
    // substep. The `await manager.update(...)` that writes tokens is outside
    // the resolve-loop, so a throw mid-loop means state is never updated.
    const state = await getActiveState(workspace);
    if (state) {
      const substepStates = state.substepStates as Array<Record<string, unknown>> | undefined;
      const ss1 = substepStates?.find((ss) => ss.id === '1');
      const ss2 = substepStates?.find((ss) => ss.id === '2');
      expect(ss1?.delegation).toBeUndefined();
      expect(ss2?.delegation).toBeUndefined();
    } else {
      // Null state is also proof of atomicity: the auto-delegation failure
      // aborted before any session/state was persisted. Make this explicit
      // rather than silently bypassing the delegation-record assertion.
      expect(state).toBeNull();
    }
  });
});

describe('DELEGATE with custom substep transitions', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('per-entry FAIL STOP on one substep: rd collect fires STOP even if aggregation rule would pass', async () => {
    // Step 1: `PASS ANY CONTINUE` / `FAIL ALL STOP` (aggregation would tolerate
    // a single failure). Substep 1.2 carries per-substep `- FAIL STOP` which
    // is a more specific stop-on-failure directive.
    const childContent = createRunbook({
      title: 'Child',
      steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

    const parentContent = [
      '# Parent',
      '',
      '## 1. Fan-out',
      '',
      '- DELEGATE',
      '- PASS ANY CONTINUE',
      '- FAIL ALL STOP',
      '',
      '### 1.1 Task A',
      '',
      '- child.runbook.md',
      '',
      '### 1.2 Task B',
      '',
      '- PASS CONTINUE',
      '- FAIL STOP',
      '',
      '- child.runbook.md',
      '',
      '## 2. Done',
      '',
      '- PASS COMPLETE',
      '',
      'Finished.',
      '',
      '```bash',
      'rd echo --result pass',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const parentState0 = await getActiveState(workspace);
    const parentRunId = parentState0!.id;

    const frontier = findFrontierInEvents(parseConcatenatedJson(start.stdout)) ?? [];
    const token1 = frontier.find((f) => f.id === '1.1')?.token;
    const token2 = frontier.find((f) => f.id === '1.2')?.token;
    expect(token1).toBeDefined();
    expect(token2).toBeDefined();

    // Subagent for 1.1 passes. Bare `pass` would target parent under reverted
    // Route A — thread --claim-id.
    let r = await runCliInProcess(`claim ${token1!}`, workspace);
    expect(r.exitCode).toBe(0);
    const claim1 = findActionOutput(r.stdout);
    expect(claim1).not.toBeNull();
    const claimId1 = String(claim1!.claim_id);
    r = await runCliInProcess(['pass', '--claim-id', claimId1], workspace);
    expect(r.exitCode).toBe(0);

    // Subagent for 1.2 fails — report-only (Plan 5): the per-substep `- FAIL STOP`
    // is applied at collect time, not at the child's close.
    r = await runCliInProcess(`claim ${token2!}`, workspace);
    const claim2 = findActionOutput(r.stdout);
    expect(claim2).not.toBeNull();
    const claimId2 = String(claim2!.claim_id);
    const failResult = await runCliInProcess(['fail', '--claim-id', claimId2], workspace);
    expect(failResult.exitCode).toBe(1);

    // Before collect the parent is collection pending — not yet stopped.
    let parentState = await readRunbookState(workspace, parentRunId);
    expect(parentState?.lifecycle).not.toBe('stopped');

    // Explicit collect applies outcomes; per-substep `- FAIL STOP` on 1.2 fires
    // STOP even though the step rule (PASS ANY CONTINUE) would otherwise pass.
    const collectResult = await runCliInProcess(
      await withRunTarget(['collect'], workspace),
      workspace,
    );
    expect(collectResult.exitCode).toBe(1);

    parentState = await readRunbookState(workspace, parentRunId);
    expect(parentState?.lifecycle).toBe('stopped');
  }, 20_000);

  it('PASS ANY CONTINUE: one substep passes, rd collect fires CONTINUE', async () => {
    const childContent = createRunbook({
      title: 'Child',
      steps: [{ title: 'Do work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

    // PASS ANY CONTINUE: a single substep passing satisfies the step; any
    // subsequent substep fail does not block aggregation (FAIL ALL STOP).
    const parentContent = [
      '# Parent',
      '',
      '## 1. Fan-out',
      '',
      '- DELEGATE',
      '- PASS ANY CONTINUE',
      '- FAIL ALL STOP',
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
      '',
      'Finished.',
      '',
      '```bash',
      'rd echo --result pass',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const parentState = await getActiveState(workspace);
    const parentRunId = parentState!.id;

    const frontier = findFrontierInEvents(parseConcatenatedJson(start.stdout)) ?? [];
    const token1 = frontier.find((f) => f.id === '1.1')?.token;
    const token2 = frontier.find((f) => f.id === '1.2')?.token;
    expect(token1).toBeDefined();
    expect(token2).toBeDefined();

    // Subagent 1.1 passes. Bare `pass` would target parent under reverted
    // Route A — thread --claim-id.
    let r = await runCliInProcess(`claim ${token1!}`, workspace);
    expect(r.exitCode).toBe(0);
    const claim1 = findActionOutput(r.stdout);
    expect(claim1).not.toBeNull();
    const claimId1 = String(claim1!.claim_id);
    r = await runCliInProcess(['pass', '--claim-id', claimId1], workspace);
    expect(r.exitCode).toBe(0);

    // Subagent 1.2 fails — but `PASS ANY` is already satisfied by 1.1.
    // The child runbook stops (its FAIL STOP fires), so `rd fail` exits 1
    // for the child; but the parent aggregation should fire CONTINUE and
    // advance to step 2. We focus on the parent's state to verify CONTINUE.
    r = await runCliInProcess(`claim ${token2!}`, workspace);
    const claim2 = findActionOutput(r.stdout);
    expect(claim2).not.toBeNull();
    const claimId2 = String(claim2!.claim_id);
    await runCliInProcess(['fail', '--claim-id', claimId2], workspace);

    // Report-only: both outcomes reported but uncollected — parent still on step 1.
    let afterParent = await readRunbookState(workspace, parentRunId);
    expect(afterParent?.step).toBe('1');

    // Explicit collect aggregates: PASS ANY (1.1 passed) → CONTINUE → step 2.
    const collectResult = await runCliInProcess(
      await withRunTarget(['collect'], workspace),
      workspace,
    );
    expect(collectResult.exitCode).toBe(0);

    afterParent = await readRunbookState(workspace, parentRunId);
    expect(afterParent?.step).toBe('2');
    // Parent must not be stopped — aggregation fired CONTINUE, not STOP.
    expect(afterParent?.lifecycle).not.toBe('stopped');
  }, 20_000);
});
