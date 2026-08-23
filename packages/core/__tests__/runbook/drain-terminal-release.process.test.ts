import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RunbookActorService,
  RunbookStateManager,
  SessionService,
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  assertRunId,
  type RunId,
} from '../../src/runbook/index.js';
import { claimKeyFromBearer } from '../../src/runbook/claim-id.js';
import { merge } from '../../src/runbook/state-update-ops.js';
import { closeRunbookStores } from '../../src/runbook/storage/store-registry.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import { createRunbook } from './fixtures.js';
import type { ChildOp, ChildReport } from './storage/fixtures/drain-terminal-release-child.js';

/**
 * CROSS-PROCESS process-death witness for the drain's terminal Run Release (#794).
 *
 * WHAT IS UNDER TEST. `applyNextResolvedCompletion` now folds the terminal Run
 * Release into the very transaction that commits the terminal state
 * (`RunbookStore.mutateState`'s `updateSession` projection). Before that fold the
 * drain committed the state in one transaction and called
 * `SessionService.releaseRuns` in a SECOND one, so the two were separately
 * observable. The invariant asserted here is the consequence, and it is stated as
 * an implication because that is the only form a killed process can be judged
 * against: IF the run's persisted lifecycle is terminal, THEN the session no
 * longer targets it — not on `defaultStack`, not `stashedRunbookId` — while its
 * run-control claim survives, because `addressed` retains claims as terminal
 * evidence.
 *
 * WHY THIS IS A RED-FIRST WITNESS AND NOT A RESTATEMENT OF THE UNIT TESTS. The
 * unit tests observe the fold from a process that lives to make the assertion,
 * so a second, separate release transaction would satisfy them just as well: the
 * drain would simply have run both. The gap only exists for a process that stops
 * running between them. Here the worker is SIGKILLed the instant the apply
 * returns — before any further work — so the second transaction provably never
 * happens. Under the pre-#794 shape the terminal run would still be sitting on
 * `defaultStack` when the parent looks, and this suite fails. Verified by
 * reverting the fold: with the `updateSession` block removed from
 * `RunbookStore.mutateState`, the terminal case fails on
 * `expect(session.defaultStack).not.toContain(runId)`.
 *
 * WHY SEPARATE OS PROCESSES. Process death is the subject, so nothing in-process
 * can stand in for it: choosing not to call `releaseRuns` is an assertion about
 * code the test declined to run, not about what a dead `rundown pass` leaves
 * behind. The store registry makes it necessary a second time —
 * `RunbookStateManager` resolves its store through a process-level, path-keyed
 * registry (`storage/store-registry.ts`), so a "death" simulated in this process
 * would leave the surviving assertions reading through the dead writer's own
 * driver and connection, which is exactly what a killed process never leaves
 * behind. The worker therefore runs the real completion service against its own
 * SQLite connection (see `storage/fixtures/drain-terminal-release-child.ts`).
 *
 * DETERMINISM. The kill is fired on a file the worker publishes as its first act
 * after the apply returns, by atomic rename, so its mere existence means both
 * that the apply has committed and that the report is complete. No sleep decides
 * anything, and the worker's death is confirmed rather than assumed: every kill
 * asserts the process exited on `SIGKILL` with a null exit code, which is what
 * separates "died in the gap" from "finished and tidied up".
 *
 * SENSITIVITY WITNESS. "The stack no longer contains the run" is a negative, and
 * a negative passes for free if the harness never put the run on the stack, or if
 * some unrelated path empties it. The second test is the control: the SAME seed,
 * the SAME worker, and the SAME kill point, differing only in that its persisted
 * completion drives a CONTINUE rather than a COMPLETE. The run is still running
 * when the worker dies, and the parent observes it still targeted — so the
 * terminal case's absence is a release that happened, not a stack that was never
 * populated.
 */

const CHILD = fileURLToPath(
  new URL('./storage/fixtures/drain-terminal-release-child.ts', import.meta.url),
);
// Resolved, never traversed. `../../../../node_modules/tsx/…` is correct in the
// normal tree but lands on `packages/core/node_modules/tsx` inside Stryker's
// sandbox (the copy adds two path segments), and tsx is a ROOT-only
// devDependency that pnpm never links there. Node's resolver walks `node_modules`
// up the directory chain, which reaches the repo root from either location.
const TSX = createRequire(import.meta.url).resolve('tsx');

/**
 * One substep whose PASS carries the whole run to COMPLETE, so a single drain
 * apply commits a terminal state — the transaction the release must ride inside.
 */
const TERMINAL_MARKDOWN = `# Terminal

## 1. Finish

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Only

- PASS COMPLETE
- FAIL STOP
`;

/**
 * The same runbook with a second substep, so the first substep's PASS CONTINUEs
 * instead of completing. One drain apply against it commits a RUNNING state,
 * which is the control the terminal assertion is measured against.
 */
const RUNNING_MARKDOWN = `# Running

## 1. Finish

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First

- PASS CONTINUE
- FAIL STOP

### 1.2 Second

- PASS COMPLETE
- FAIL STOP
`;

let dir: string;
let manager: RunbookStateManager;
let actorService: RunbookActorService;
let sessionService: SessionService;
let children: ChildProcess[] = [];
let opSeq = 0;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-drain-release-proc-'));
  manager = new RunbookStateManager(dir);
  actorService = new RunbookActorService(manager);
  sessionService = new SessionService(manager);
  children = [];
  opSeq = 0;
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await closeRunbookStores();
  await fs.rm(dir, { recursive: true, force: true });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A run the session targets, plus the claim key its run-control bearer is filed under. */
interface SeededRun {
  readonly runId: RunId;
  readonly claimKey: string;
}

/**
 * Stand up a real run the session targets, carrying one persisted resolved
 * completion for substep `1` of its first step.
 *
 * Both session structures matter and both are written by the production seam:
 * `pushRunbookWithRunControlClaim` is what a real `rundown run` uses, so the
 * stack entry the release must remove and the claim it must NOT revoke are
 * created together, atomically, the way the product creates them.
 *
 * @param markdown - Runbook source, which decides whether the drain's single
 *   apply lands terminal or merely advances.
 * @returns The run's id and the claim key of its run-control bearer.
 */
async function seedTargetedRun(markdown: string): Promise<SeededRun> {
  opSeq += 1;
  const runbookPath = `run-${String(opSeq)}.runbook.md`;
  await fs.writeFile(path.join(dir, runbookPath), markdown);
  const steps = createRunbook(markdown);
  // Zero-padded rather than a repeated digit: the id must stay 32 hex characters
  // however many runs a test seeds, and a repeated two-digit counter would not.
  const runId = assertRunId(`rd_${String(opSeq).padStart(32, '0')}`);
  await manager.create(
    { source: 'project', path: runbookPath },
    { title: 'Drain', description: '', steps },
    {
      runId,
      runbookPath,
      frontmatterOutputs: [],
      // The machine reads `RunId` off the compiled context and brands it; a run
      // created without it dies inside `createActor`.
      templateVars: { RunId: runId },
    },
  );
  await actorService.initializeState(runId, steps);
  const { claimId } = unwrapSessionMutation(
    await sessionService.pushRunbookWithRunControlClaim(runId),
  );
  // The drain's input: one resolved completion already persisted on the run,
  // exactly as `rundown pass` records before it drains.
  const frame = activeFrame(buildFrameKey('1'), 1);
  await manager.update(runId, {
    resolvedCompletions: merge({
      [buildCompletionKey(frame, '1')]: buildResolvedCompletion({
        agentId: 'manual',
        result: 'pass',
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: frame,
        completedAt: '2026-01-01T00:00:00.000Z',
      }),
    }),
  });
  return { runId, claimKey: claimKeyFromBearer(claimId) };
}

/**
 * Probe for a file without letting a missing path throw.
 *
 * @param file - Path to test.
 * @returns Whether the path exists right now.
 */
async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll for a protocol file the worker publishes, failing fast if it dies first.
 * The wait only OBSERVES a file; it never establishes ordering by elapsed time.
 *
 * @param file - Path the worker writes to signal a stage.
 * @param child - The worker, so a premature exit fails the wait promptly.
 * @throws {Error} When the worker exits without writing the file, or on timeout.
 */
async function waitForFile(file: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (await exists(file)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      // Re-probe before calling it a premature exit: a worker can publish the
      // file and exit between the probe above and this check, and that ordering
      // is a success, not a death.
      if (await exists(file)) return;
      throw new Error(`worker exited before writing ${path.basename(file)}`);
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(file)}`);
    await wait(5);
  }
}

/** How a worker's process ended, as reported by its `exit` event. */
interface ChildDeath {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Resolve when the worker's process ends, however it ends.
 *
 * Deliberately NOT the sibling suites' `childExit`, which rejects a non-zero
 * exit: here a signalled death is the expected outcome and the thing being
 * asserted, so the manner of death is returned as a value rather than thrown.
 * Attach BEFORE releasing the worker — `exit` does not replay.
 *
 * @param child - The spawned worker.
 * @returns A promise settling on how the worker's process ended.
 */
function childDeath(child: ChildProcess): Promise<ChildDeath> {
  const death = new Promise<ChildDeath>((resolve, reject) => {
    // A spawn failure emits 'error' and never 'exit', so without this the promise
    // would hang until the suite timeout and report nothing about the cause.
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  // Mark it handled. An assertion that throws between attaching this and awaiting
  // it would otherwise leave a rejection with nobody watching, and Jest would
  // report that instead of the assertion that actually failed. The returned
  // promise still rejects for the caller that awaits it.
  death.catch(() => {});
  return death;
}

/**
 * Spawn one worker, release it into a single armed drain apply, and SIGKILL it
 * the instant that apply returns.
 *
 * The kill fires on the worker's published report rather than on a timer, so it
 * lands in the former release gap by causality: the report exists only after the
 * apply's transaction has committed, and the worker performs no other work
 * between publishing it and dying.
 *
 * @param op - The run to drain and the release role to arm.
 * @returns The worker's report, read from the file that triggered the kill.
 * @throws {Error} When the worker never signals readiness, or does not die by
 *   SIGKILL — a worker that exited on its own was not killed in the gap, and its
 *   result would be evidence about a different experiment.
 */
async function killAtGap(op: ChildOp): Promise<ChildReport> {
  opSeq += 1;
  const tag = String(opSeq);
  const readyFile = path.join(dir, `ready-${tag}`);
  const goFile = path.join(dir, `go-${tag}`);
  const appliedFile = path.join(dir, `applied-${tag}`);
  const child = spawn(
    process.execPath,
    ['--import', TSX, CHILD, dir, readyFile, goFile, appliedFile, JSON.stringify(op)],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  // A spawn failure emits 'error' and never 'exit'. This listener must be attached
  // HERE, at spawn, because nothing else is listening yet: `childDeath` attaches
  // its own only after readiness, which a failed spawn never reaches. An 'error'
  // with no listener is fatal in plain Node, and `child.exitCode` is still null
  // when it fires, so the liveness check below cannot see the failure either.
  let spawnError: Error | undefined;
  child.on('error', (error: Error) => {
    spawnError = error;
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  children.push(child);

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (await exists(readyFile)) break;
    if (spawnError) throw new Error(`worker failed to spawn: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker exited before readiness (code=${String(child.exitCode)}): ${stderr}`);
    }
    if (Date.now() >= deadline) throw new Error(`worker never signalled readiness: ${stderr}`);
    await wait(5);
  }

  // Attach BEFORE releasing the worker: a worker released first could end before
  // its listener existed, and `exit` does not replay.
  const death = childDeath(child);
  await fs.writeFile(goFile, 'go');

  // The apply has returned and its transaction has committed. Everything the
  // pre-#794 shape did next lived in a second transaction, and this is where the
  // process stops running.
  await waitForFile(appliedFile, child);
  child.kill('SIGKILL');

  const { code, signal } = await death;
  // Proof the experiment happened: a signal no handler can intercept, not a clean
  // exit. A worker that finished and tore itself down would be evidence about an
  // orderly shutdown, which is the case this suite exists to exclude.
  expect(signal).toBe('SIGKILL');
  expect(code).toBeNull();

  return JSON.parse(await fs.readFile(appliedFile, 'utf8')) as ChildReport;
}

/**
 * Assert the worker committed the apply it was asked to, from a real other process.
 *
 * @param report - The worker's published report.
 * @param terminal - Terminal status the apply must have carried, or null.
 * @throws {Error} When the worker threw instead of applying.
 */
function expectApplied(report: ChildReport, terminal: string | null): void {
  if (!report.ok) throw new Error(`worker threw instead of applying: ${report.error}`);
  // Not this process: an in-process "death" would leave the assertions below
  // reading through the dead writer's own driver and connection.
  expect(report.pid).not.toBe(process.pid);
  expect(report.kind).toBe('applied');
  expect(report.terminal).toBe(terminal);
}

describe("process death in the drain's former release gap (#794)", () => {
  it('leaves no targeting behind a run it committed terminal', async () => {
    const { runId, claimKey } = await seedTargetedRun(TERMINAL_MARKDOWN);
    // The seed really did target the run, so the absence asserted below is a
    // release that happened rather than an entry that was never written.
    expect((await manager.loadSession()).defaultStack).toContain(runId);

    const report = await killAtGap({ runId, role: 'addressed' });
    expectApplied(report, 'done');

    // The implication, read off disk after the writer stopped existing. The
    // antecedent first: this run really is committed terminal.
    const after = await manager.load(runId);
    expect(after?.lifecycle).toBe('completed');
    const session = await manager.loadSession();
    // ...and therefore the session does not target it, through either structure.
    // Under a second, separate release transaction the worker died before that
    // transaction ran and this entry would still be here.
    expect(session.defaultStack).not.toContain(runId);
    expect(session.stashedRunbookId).toBeUndefined();
    // `addressed` retains, so the orchestrator still holding the run-control
    // bearer can resolve the outcome as terminal evidence. A release that revoked
    // here would destroy the authority the survivor needs.
    expect(session.claims[claimKey]).toEqual(
      expect.objectContaining({ claimKey, controlledRunId: runId }),
    );
  }, 120_000);

  it('still targets a run the same death leaves running', async () => {
    const { runId, claimKey } = await seedTargetedRun(RUNNING_MARKDOWN);
    expect((await manager.loadSession()).defaultStack).toContain(runId);

    // Same worker, same kill point; only the runbook differs, so the single apply
    // CONTINUEs instead of completing.
    const report = await killAtGap({ runId, role: 'addressed' });
    expectApplied(report, null);

    const after = await manager.load(runId);
    expect(after?.lifecycle).toBe('running');
    const session = await manager.loadSession();
    // The armed release is inert on a non-terminal apply: a live run must survive
    // its own drain, and the harness can plainly still see a stack entry — which
    // is what makes the terminal case's missing entry meaningful.
    expect(session.defaultStack).toContain(runId);
    expect(session.claims[claimKey]).toEqual(
      expect.objectContaining({ claimKey, controlledRunId: runId }),
    );
  }, 120_000);
});
