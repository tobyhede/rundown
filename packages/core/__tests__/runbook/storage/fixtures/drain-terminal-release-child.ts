// Test-only worker: a REAL separate OS process that drives ONE real drain apply
// — `RunbookCompletionService.applyNextResolvedCompletion` with the terminal Run
// Release armed — and then parks in the gap that used to sit between the state
// commit and the release, waiting to be SIGKILLed by the parent suite.
//
// Why a child process at all: process death is the subject. A parent that
// "simulates" the gap by not calling `SessionService.releaseRuns` is asserting
// about code it chose not to run, which proves nothing about what a killed
// `rundown pass` leaves on disk. Only a real process really dying at a real
// point in a real transaction sequence is evidence. The registry makes it
// necessary for a second reason too: `RunbookStateManager` resolves its store
// through a process-level, path-keyed registry (`storage/store-registry.ts`), so
// an in-process "death" would leave the surviving suite sharing the dead
// worker's driver and connection — the one thing a killed process never does.
//
// Why the real service and not hand-written SQL: the property under test is that
// the state commit and the session release are ONE transaction (#794). Imitating
// either half here would pin the imitation rather than the production path, so
// this worker builds the same core services the CLI's drain builds and calls
// `applyNextResolvedCompletion` itself.
//
// WHERE THE KILL LANDS, and why it is that point. Before #794 the drain wrote
// the terminal state in one transaction and then called
// `SessionService.releaseRuns` in a SECOND one. A process that died between them
// left a run committed terminal while the session still targeted it — a finished
// run that every bare `rundown` command kept resolving to. This worker publishes
// `appliedFile` as the FIRST thing after the apply returns and parks
// immediately, so the parent's SIGKILL lands in exactly that window. Nothing
// between the apply and the park touches the store or the session: one atomic
// rename of a small report file, and then a barrier wait.
//
// Protocol (barrier-synchronized, no sleeps):
//   1. Construct the services and WARM the store (open the driver, ensure schema,
//      read the session) so the post-barrier work is the apply and nothing else,
//      and so the process dies holding an open connection the way a real one does.
//   2. Write `readyFile` — "I am warm and parked at the release barrier".
//   3. Wait on `goFile` until the parent releases this worker.
//   4. Run exactly one `applyNextResolvedCompletion` with `terminalRelease` armed.
//   5. Publish the outcome to `appliedFile` by atomic rename, then park. The
//      parent kills the process here.
//
// Invoked as:
//   node --import tsx drain-terminal-release-child.ts \
//     <cwd> <readyFile> <goFile> <appliedFile> <opJson>

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { RunbookStateManager } from '../../../../src/runbook/state.js';
import { RunbookActorService } from '../../../../src/runbook/actor-service.js';
import { RunbookCompletionService } from '../../../../src/runbook/completion-service.js';
import type { ApplyNextResolvedCompletionResult } from '../../../../src/runbook/completion-service.js';
import { assertRunId } from '../../../../src/runbook/run-id.js';
import type { ReleaseRole } from '../../../../src/runbook/session-release.js';
import { getErrorMessage } from '../../../../src/errors.js';
import { createRunbook } from '../../fixtures.js';

/**
 * The single armed drain this worker performs before the parent kills it.
 *
 * Shared with the parent suite by `import type`, which erases at compile time, so
 * importing it cannot execute this module's top-level script. One definition is
 * what makes the JSON wire contract checkable from the parent side, where the op
 * is constructed; this side re-parses it off argv, where no static guarantee
 * survives.
 */
export interface ChildOp {
  /** Run whose persisted resolved completion this worker drains. */
  readonly runId: string;
  /**
   * Release role armed on the apply.
   *
   * Carried over the wire rather than hard-coded here so the suite's assertion
   * about claim retention names the role that produced it. `addressed` retains
   * the run-control claim as terminal evidence; the other roles revoke.
   */
  readonly role: ReleaseRole;
}

/**
 * Discriminant of an apply outcome, derived from the service's own union.
 *
 * Derived rather than restated: this is the wire contract the parent asserts
 * against, so a spelling only this file knows would let `expectApplied(report,
 * 'complete')` compile and assert nothing. Deriving makes a new arm on the
 * service a compile error here instead.
 */
type DrainKind = ApplyNextResolvedCompletionResult['kind'];

/**
 * Terminal status an apply carried, or null when it stayed running.
 *
 * `null` rather than `undefined` because it crosses JSON, which drops an
 * absent key but preserves an explicit null.
 */
type DrainTerminal = NonNullable<
  Extract<ApplyNextResolvedCompletionResult, { kind: 'applied' }>['terminal']
> | null;

/**
 * What this worker reports from inside the gap, as written to `appliedFile`.
 *
 * The report is the parent's proof that the apply really did commit — and, on
 * the terminal case, really did reach terminal — BEFORE the process died. A
 * parent that only inspected the database afterwards could not tell a committed
 * terminal apply from an apply that never ran.
 */
export type ChildReport =
  | {
      readonly ok: true;
      /** Discriminant of the apply outcome, for example `applied`. */
      readonly kind: DrainKind;
      /** Terminal status the apply carried, or null when it stayed running. */
      readonly terminal: DrainTerminal;
      /** The writer, so the parent can confirm this was not its own process. */
      readonly pid: number;
    }
  | {
      readonly ok: false;
      /** Message from an apply that threw, so the parent reports the cause. */
      readonly error: string;
      /** The writer, so the parent can confirm this was not its own process. */
      readonly pid: number;
    };

/** Upper bound on any barrier wait, so a lost signal fails loudly, not silently. */
const BARRIER_TIMEOUT_MS = 60_000;

const [cwd, readyFile, goFile, appliedFile, opJson] = process.argv.slice(2);
const op = JSON.parse(opJson) as ChildOp;

/**
 * Wait for the release barrier, YIELDING between polls.
 *
 * @param file - Barrier file the parent writes to release this worker.
 * @throws {Error} When the barrier is not signalled within the timeout.
 */
async function awaitBarrier(file: string): Promise<void> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for barrier ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Publish this worker's report and park in the gap until the parent kills it.
 *
 * The rename is what makes the parent's kill safe to fire on the file's mere
 * existence: a plain `writeFileSync` creates the path before it writes the bytes,
 * so a SIGKILL between those two syscalls would leave the parent reading an empty
 * file. Renaming a fully written temp file over the published path means the path
 * appears only once its contents are complete.
 *
 * @param report - The outcome to publish before dying.
 * @throws {Error} When the parent never kills this worker, which means the
 *   experiment did not happen and its result must not be trusted.
 */
async function publishAndParkInTheGap(report: ChildReport): Promise<void> {
  const staging = `${appliedFile}.partial`;
  writeFileSync(staging, JSON.stringify(report));
  renameSync(staging, appliedFile);

  // THE GAP. Before #794 the drain's next act was a SEPARATE
  // `SessionService.releaseRuns` transaction; this park is the window between the
  // two, and the parent's SIGKILL is the process death inside it. Nothing is
  // executed here on purpose — no store call, no session call, no teardown — so
  // whatever the parent finds on disk was committed by the apply alone.
  //
  // Bounded rather than infinite: a SIGKILL that never arrives means the parent's
  // protocol broke, and that must surface as a timeout with a name rather than a
  // worker quietly hanging until the suite deadline.
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('drain-terminal-release-child: parent never killed this worker at the gap');
}

const manager = new RunbookStateManager(cwd);
const actorService = new RunbookActorService(manager);
const completionService = new RunbookCompletionService(manager, actorService);

/**
 * Apply exactly one persisted resolved completion with the terminal release armed.
 *
 * The steps are re-parsed from the run's own source document, exactly as the
 * CLI's `loadSteps` does, so nothing about the runbook crosses the process
 * boundary as data.
 *
 * @returns The apply outcome.
 * @throws {Error} When the target run has disappeared.
 */
async function drain(): Promise<{ readonly kind: DrainKind; readonly terminal: DrainTerminal }> {
  const runId = assertRunId(op.runId);
  const state = await manager.load(runId);
  if (!state) throw new Error(`drain target ${op.runId} is missing`);
  const steps = createRunbook(readFileSync(path.join(cwd, state.runbookPath), 'utf8'));
  const applied = await completionService.applyNextResolvedCompletion({
    runbookId: runId,
    steps,
    terminalRelease: { role: op.role },
  });
  return {
    kind: applied.kind,
    terminal: applied.kind === 'applied' ? (applied.terminal ?? null) : null,
  };
}

// Warm the driver: open the connection and ensure the schema before the barrier,
// so the only work left after it is the apply. This also puts the process in the
// state a real `rundown pass` dies in — holding an open SQLite connection — which
// a worker that opened the store lazily inside the measured window would not.
await manager.loadSession();

writeFileSync(readyFile, String(process.pid));
await awaitBarrier(goFile);

let report: ChildReport;
try {
  const { kind, terminal } = await drain();
  // Annotated, not inferred: this literal IS the wire format the parent parses as
  // ChildReport, so it must be checked against that type rather than merely
  // resembling it.
  report = { ok: true, kind, terminal, pid: process.pid };
} catch (error: unknown) {
  // A throwing apply is never expected here, but it must still reach the parent:
  // publishing it keeps the failure diagnosable instead of surfacing as a kill
  // that never happened.
  report = { ok: false, error: getErrorMessage(error), pid: process.pid };
}

await publishAndParkInTheGap(report);
