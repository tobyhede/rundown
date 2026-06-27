import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  findActionOutput,
  getActiveState,
  getAllStates,
  parseConcatenatedJson,
  readRunbookState,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import type { RunbookState } from '@rundown-org/core';

// Stage 1 is DELEGATE'd to a worker; stages 2 and 3 are INLINE-composed gate
// children. The bug: when `rd collect` applies the delegated stage and advances
// the parent INTO the inline stage-2 gate, the gate child is never launched and
// never made default-active — so a bare `rd pass` rubber-stamps the gate.
const PIPELINE = `# Pipeline

## 1. Plan

- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Write plan

- DELEGATE
- worker.runbook.md

## 2. Review

- PASS ALL CONTINUE
- FAIL ANY STOP
- gate.runbook.md

## 3. Execute

- PASS ALL COMPLETE
- FAIL ANY STOP
- gate.runbook.md
`;

const WORKER = `# Worker

## 1. Do work

- PASS COMPLETE
- FAIL STOP

Do the delegated work.
`;

const GATE = `# Gate

## 1. Check

- PASS COMPLETE
- FAIL STOP

Check the gate.
`;

const COLLECTING_GATE = `# Collecting Gate

## 1. Delegate check

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Check

- DELEGATE
- worker.runbook.md
`;

/** Find a launched inline child run whose parent is the given run. */
function findInlineChild(states: RunbookState[], parentRunId: string): RunbookState | undefined {
  return states.find((s) => {
    const link = s.parentLinkage;
    return link?.kind === 'inline' && link.parentRunId === parentRunId;
  });
}

/** A streamed execution-event object (has a per-runbook monotonic `seq`). */
interface StreamedEventLine {
  type: string;
  seq: number;
  runbookId: string;
}

/**
 * Parse every JSON object from `rd` stdout in emission order.
 *
 * Handles the mixed stream this command produces: compact one-per-line JSONL
 * execution events followed by the pretty-printed (multi-line) collect action
 * object written via `output.json`.
 *
 * @param stdout - Raw command stdout
 * @returns Parsed JSON records in the order they appear in stdout
 */
function parseStdoutObjects(stdout: string): Record<string, unknown>[] {
  return parseConcatenatedJson(stdout).filter(
    (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
  );
}

describe('delegation -> collect -> inline handoff', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('launches and activates the inline child when collect advances into an inline stage', async () => {
    await writeFile(join(workspace.runbooksDir(), 'pipeline.runbook.md'), PIPELINE);
    await writeFile(join(workspace.runbooksDir(), 'worker.runbook.md'), WORKER);
    await writeFile(join(workspace.runbooksDir(), 'gate.runbook.md'), GATE);

    const start = await runCliInProcess('run --prompted pipeline.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const parent = await getActiveState(workspace);
    expect(parent).not.toBeNull();
    const parentRunId = parent!.id;
    const token = parent!.substepStates!.find((s) => s.delegation?.token)!.delegation!.token!;

    // Claim + explicitly close the delegated worker -> REPORTS the outcome (report-only).
    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);
    const closed = await runCliInProcess(['complete', '--claim-id', claimId], workspace);
    expect(closed.exitCode).toBe(0);

    // Collect applies the reported outcome -> stage 1 PASS ALL -> CONTINUE -> stage 2.
    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    // The parent advanced into stage 2 (the inline gate stage), still running.
    const parentAfter = await readRunbookState(workspace, parentRunId);
    expect(parentAfter!.step).toBe('2');
    expect(parentAfter!.lifecycle).toBe('running');

    // The inline gate CHILD was launched (THE BUG: currently it is not).
    const states = await getAllStates(workspace);
    const inlineChild = findInlineChild(states, parentRunId);
    expect(inlineChild).toBeDefined();

    // The inline child is DEFAULT-ACTIVE, not the parent (THE BUG: currently the parent is).
    const active = await getActiveState(workspace);
    expect(active!.id).toBe(inlineChild!.id);

    // So a bare `rd pass` resolves the inline child's step, not the parent's
    // stage-2 composite substep (no rubber-stamp).
    const pass = await runCliInProcess('pass', workspace);
    expect(pass.exitCode).toBe(0);
  }, 30_000);

  it('emits the collect action object AFTER follow-up execution events with a continuous seq', async () => {
    await writeFile(join(workspace.runbooksDir(), 'pipeline.runbook.md'), PIPELINE);
    await writeFile(join(workspace.runbooksDir(), 'worker.runbook.md'), WORKER);
    await writeFile(join(workspace.runbooksDir(), 'gate.runbook.md'), GATE);

    const start = await runCliInProcess('run --prompted pipeline.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const parent = await getActiveState(workspace);
    const token = parent!.substepStates!.find((s) => s.delegation?.token)!.delegation!.token!;

    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);
    const closed = await runCliInProcess(['complete', '--claim-id', claimId], workspace);
    expect(closed.exitCode).toBe(0);

    // JSON mode (no --text): collect applies the delegated outcome and advances
    // the parent into the inline gate stage, so the execution loop emits
    // step_entered / runbook_started for the launched inline child.
    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    const objects = parseStdoutObjects(collected.stdout);
    expect(objects.length).toBeGreaterThan(1);

    // The final JSON object is the collect action object.
    const last = objects.at(-1)!;
    expect(last).toMatchObject({ kind: 'collect', action: 'collect', status: 'applied' });

    // The collect action object appears exactly once, and it is the LAST object:
    // every execution event object precedes it.
    const collectIndices = objects
      .map((object, index) => ({ object, index }))
      .filter(({ object }) => object.kind === 'collect')
      .map(({ index }) => index);
    expect(collectIndices).toEqual([objects.length - 1]);

    // Execution-loop events (step_entered / runbook_started / step_transitioned)
    // all land BEFORE the trailing collect action object.
    const eventLines: StreamedEventLine[] = objects
      .filter(
        (object) =>
          typeof object.type === 'string' &&
          typeof object.seq === 'number' &&
          typeof object.runbookId === 'string',
      )
      .map((object) => ({
        type: object.type as string,
        seq: object.seq as number,
        runbookId: object.runbookId as string,
      }));
    expect(eventLines.length).toBeGreaterThan(0);

    // The parent stream carries BOTH the aggregation observation and the
    // execution-loop entry for the advanced stage — proof the loop ran and that
    // its events precede the collect action object.
    const parentEvents = eventLines.filter((line) => line.runbookId === parent!.id);
    expect(parentEvents.map((line) => line.type)).toEqual(
      expect.arrayContaining(['step_transitioned', 'step_entered']),
    );

    // seq is strictly monotonically increasing WITHIN each runbook execution
    // stream (the regression: a second parent emitter would restart parent seq
    // at 1, duplicating it). The inline child is a distinct execution with its
    // own seq stream, so group by runbookId before checking monotonicity.
    const byRunbook = new Map<string, number[]>();
    for (const line of eventLines) {
      const sequence = byRunbook.get(line.runbookId) ?? [];
      sequence.push(line.seq);
      byRunbook.set(line.runbookId, sequence);
    }
    for (const sequence of byRunbook.values()) {
      for (let i = 1; i < sequence.length; i++) {
        expect(sequence[i]).toBeGreaterThan(sequence[i - 1]);
      }
    }
  }, 30_000);

  it('propagates an inline child that reaches terminal through collect', async () => {
    await writeFile(join(workspace.runbooksDir(), 'pipeline.runbook.md'), PIPELINE);
    await writeFile(join(workspace.runbooksDir(), 'worker.runbook.md'), WORKER);
    await writeFile(join(workspace.runbooksDir(), 'gate.runbook.md'), COLLECTING_GATE);

    const start = await runCliInProcess('run --prompted pipeline.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const parent = await getActiveState(workspace);
    expect(parent).not.toBeNull();
    const parentRunId = parent!.id;
    const token = parent!.substepStates!.find((s) => s.delegation?.token)!.delegation!.token!;

    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);
    const closed = await runCliInProcess(['complete', '--claim-id', claimId], workspace);
    expect(closed.exitCode).toBe(0);

    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    const inlineChild = findInlineChild(await getAllStates(workspace), parentRunId);
    expect(inlineChild).toBeDefined();
    expect((await getActiveState(workspace))!.id).toBe(inlineChild!.id);

    const childToken = inlineChild!.substepStates!.find((s) => s.delegation?.token)!.delegation!
      .token!;
    const childClaim = await runCliInProcess(`claim ${childToken}`, workspace);
    expect(childClaim.exitCode).toBe(0);
    const childClaimId = String(findActionOutput(childClaim.stdout)!.claim_id);
    const childClosed = await runCliInProcess(['complete', '--claim-id', childClaimId], workspace);
    expect(childClosed.exitCode).toBe(0);

    const childCollected = await runCliInProcess('collect', workspace);
    expect(childCollected.exitCode).toBe(0);

    const parentAfter = await readRunbookState(workspace, parentRunId);
    expect(parentAfter!.step).toBe('3');
    expect(parentAfter!.lifecycle).toBe('running');
    expect((await getActiveState(workspace))!.id).not.toBe(inlineChild!.id);
  }, 30_000);

  it('emits the collect action object AFTER inline-terminal propagation events with a continuous seq', async () => {
    // Regression (P2): when `rd collect` drives the collected run (here the
    // inline gate child) to its OWN terminal, the inline terminal-propagation
    // pass synchronously drains and advances the gate's parent (pipeline) and
    // STREAMS the parent's step_transitioned / runbook_* events through the
    // shared emitter. Those streamed observations must precede the final collect
    // action object (docs/spec/cli-output.md: "the action object is the last
    // line"). The bug renders the collect action BEFORE that propagation pass.
    await writeFile(join(workspace.runbooksDir(), 'pipeline.runbook.md'), PIPELINE);
    await writeFile(join(workspace.runbooksDir(), 'worker.runbook.md'), WORKER);
    await writeFile(join(workspace.runbooksDir(), 'gate.runbook.md'), COLLECTING_GATE);

    const start = await runCliInProcess('run --prompted pipeline.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const parent = await getActiveState(workspace);
    expect(parent).not.toBeNull();
    const parentRunId = parent!.id;
    const token = parent!.substepStates!.find((s) => s.delegation?.token)!.delegation!.token!;

    // Drive the delegated worker, collect to advance the pipeline into the
    // inline gate stage, and activate the gate child.
    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);
    const closed = await runCliInProcess(['complete', '--claim-id', claimId], workspace);
    expect(closed.exitCode).toBe(0);
    const advanced = await runCliInProcess('collect', workspace);
    expect(advanced.exitCode).toBe(0);

    const inlineChild = findInlineChild(await getAllStates(workspace), parentRunId);
    expect(inlineChild).toBeDefined();
    expect((await getActiveState(workspace))!.id).toBe(inlineChild!.id);

    // Drive the gate's OWN delegated worker, then collect ON THE GATE. The gate's
    // step 1 is `PASS ALL COMPLETE`, so this aggregation drives the gate terminal
    // and propagates inline to the pipeline (advancing it to step 3) — streaming
    // the pipeline's transition/runbook events from inside collect.
    const childToken = inlineChild!.substepStates!.find((s) => s.delegation?.token)!.delegation!
      .token!;
    const childClaim = await runCliInProcess(`claim ${childToken}`, workspace);
    expect(childClaim.exitCode).toBe(0);
    const childClaimId = String(findActionOutput(childClaim.stdout)!.claim_id);
    const childClosed = await runCliInProcess(['complete', '--claim-id', childClaimId], workspace);
    expect(childClosed.exitCode).toBe(0);

    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    const objects = parseStdoutObjects(collected.stdout);

    // The collect action object appears exactly once and is the LAST object.
    const collectIndices = objects
      .map((object, index) => ({ object, index }))
      .filter(({ object }) => object.kind === 'collect')
      .map(({ index }) => index);
    expect(collectIndices).toEqual([objects.length - 1]);

    const last = objects.at(-1)!;
    expect(last).toMatchObject({ kind: 'collect', action: 'collect', status: 'applied' });

    // The inline propagation streamed the PARENT pipeline's advancement events.
    // Every such streamed event must land BEFORE the trailing collect action
    // object — i.e. the highest index of any pipeline event is strictly less than
    // the collect action object's index.
    const parentEventIndices = objects
      .map((object, index) => ({ object, index }))
      .filter(
        ({ object }) =>
          typeof object.type === 'string' &&
          typeof object.seq === 'number' &&
          object.runbookId === parentRunId,
      )
      .map(({ index }) => index);
    expect(parentEventIndices.length).toBeGreaterThan(0);
    const collectIndex = objects.length - 1;
    for (const index of parentEventIndices) {
      expect(index).toBeLessThan(collectIndex);
    }

    // The pipeline's step_transitioned (advancement to step 3) is among the
    // streamed events, proving the inline propagation actually ran and streamed.
    const parentEventTypes = parentEventIndices.map((index) => objects[index].type);
    expect(parentEventTypes).toEqual(expect.arrayContaining(['step_transitioned']));

    // The pipeline advanced to step 3 as a result.
    const parentAfter = await readRunbookState(workspace, parentRunId);
    expect(parentAfter!.step).toBe('3');
  }, 30_000);

  it('bare complete from the collected inline gate does not cross the prior delegation boundary', async () => {
    await writeFile(join(workspace.runbooksDir(), 'pipeline.runbook.md'), PIPELINE);
    await writeFile(join(workspace.runbooksDir(), 'worker.runbook.md'), WORKER);
    await writeFile(join(workspace.runbooksDir(), 'gate.runbook.md'), GATE);

    const start = await runCliInProcess('run --prompted pipeline.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const parent = await getActiveState(workspace);
    expect(parent).not.toBeNull();
    const parentRunId = parent!.id;
    const token = parent!.substepStates!.find((s) => s.delegation?.token)!.delegation!.token!;

    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);
    const closed = await runCliInProcess(['complete', '--claim-id', claimId], workspace);
    expect(closed.exitCode).toBe(0);

    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    const inlineChild = findInlineChild(await getAllStates(workspace), parentRunId);
    expect(inlineChild).toBeDefined();
    expect((await getActiveState(workspace))!.id).toBe(inlineChild!.id);

    const close = await runCliInProcess(['complete', 'inline gate done'], workspace);
    expect(close.exitCode).toBe(0);

    const inlineAfter = await readRunbookState(workspace, inlineChild!.id);
    const parentAfter = await readRunbookState(workspace, parentRunId);

    expect(inlineAfter!.lifecycle).toBe('completed');
    expect(parentAfter!.lifecycle).toBe('completed');
    expect(parentAfter!.step).toBe('2');
  }, 30_000);
});
