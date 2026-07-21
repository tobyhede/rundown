import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { closeRunbookStores } from '../../src/runbook/storage/store-registry.js';
import { assertClaimId } from '../../src/runbook/claim-id.js';
import { findSubstepState } from '../../src/runbook/targeting.js';
import type { RunId, Runbook, Step, DelegationLinkage } from '../../src/runbook/types.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import { linkageFor, seedLiveDelegation, assertClaimed } from './claim-test-helpers.js';

/**
 * CROSS-PROCESS session-write contention.
 *
 * `SessionService` used to serialize its load-modify-save cycle with the
 * `SessionLock` file lock; it now runs the whole cycle inside one
 * `RunbookStore.mutateSession` (`BEGIN IMMEDIATE`) transaction. These tests are
 * the evidence that the transaction actually delivers the guarantee the lock
 * provided: concurrent writers do not lose each other's updates, and mutually
 * exclusive outcomes stay mutually exclusive.
 *
 * WHY SEPARATE OS PROCESSES. `RunbookStateManager` resolves its store through a
 * process-level, path-keyed registry (`storage/store-registry.ts`), so two
 * managers on the same cwd in the SAME process share one driver and one
 * connection. Their writes serialize on that shared driver regardless of whether
 * the transaction is correct, so an in-process "race" is not evidence of
 * anything. Every race below therefore runs in real child processes holding
 * their own SQLite connections, driven through the real `SessionService` (see
 * `storage/fixtures/session-writer-child.ts`).
 *
 * DETERMINISM. Children are barrier-synchronized, never slept: each warms its
 * driver, signals readiness, and spins on a `go` file that the parent creates
 * once, after every child is parked. There are no timing assumptions in any
 * assertion — each property holds for every possible interleaving, so a lost
 * overlap costs sensitivity, never correctness.
 */

const CHILD = fileURLToPath(new URL('./storage/fixtures/session-writer-child.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../../../node_modules/tsx/dist/loader.mjs', import.meta.url));

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = {
  title: 'Test',
  description: 'A test',
  steps: mockSteps,
};

/** One session mutation for a child process to perform after the barrier. */
type ChildOp =
  | { readonly kind: 'issueRunControlClaim'; readonly runId: string }
  | {
      readonly kind: 'claimRunbook';
      readonly childRunId: string;
      readonly linkage: DelegationLinkage;
    }
  | { readonly kind: 'pushRunbook'; readonly runId: string }
  | { readonly kind: 'recordClaimSeen'; readonly claimId: string }
  | { readonly kind: 'releaseRunbook'; readonly runId: string }
  | { readonly kind: 'popRunbook' }
  | {
      readonly kind: 'guardedParentAdvance';
      readonly parentRunId: string;
      readonly linkage: DelegationLinkage;
      readonly callbackReadyFile: string;
      readonly callbackGoFile: string;
    };

/** A child's reported outcome, as written to its result file. */
type ChildResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

let dir: string;
let manager: RunbookStateManager;
let sessionService: SessionService;
let children: ChildProcess[] = [];
let opSeq = 0;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-session-proc-'));
  manager = new RunbookStateManager(dir);
  sessionService = new SessionService(manager);
  children = [];
  opSeq = 0;
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await closeRunbookStores();
  await fs.rm(dir, { recursive: true, force: true });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create and persist a run the children can target.
 *
 * @param options - Optional explicit parent linkage for delegated children.
 * @returns The persisted run's id.
 */
async function newRun(
  options: { readonly parentLinkage?: DelegationLinkage } = {},
): Promise<RunId> {
  const state = await manager.create({ source: 'project', path: 'test.runbook.md' }, mockRunbook, {
    runbookPath: 'test.runbook.md',
    ...(options.parentLinkage ? { parentLinkage: options.parentLinkage } : {}),
  });
  return state.id;
}

/** A spawned child parked at the barrier, with the files it will read/write. */
interface ParkedChild {
  readonly child: ChildProcess;
  readonly resultFile: string;
}

/**
 * Spawn one child and resolve once it has warmed its driver and parked at the
 * barrier. Resolving on readiness — not on a timer — is what makes the release
 * simultaneous.
 *
 * @param goFile - Barrier file every child in this cohort spins on.
 * @param op - The single session mutation this child will perform.
 * @returns The parked child handle.
 * @throws {Error} When the child never signals readiness within the timeout.
 */
async function park(goFile: string, op: ChildOp): Promise<ParkedChild> {
  opSeq += 1;
  const tag = String(opSeq);
  const readyFile = path.join(dir, `ready-${tag}`);
  const resultFile = path.join(dir, `result-${tag}`);
  const child = spawn(
    process.execPath,
    ['--import', TSX, CHILD, dir, readyFile, goFile, resultFile, JSON.stringify(op)],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  children.push(child);

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fs.access(readyFile);
      return { child, resultFile };
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `child exited before readiness (code=${String(child.exitCode)}): ${stderr}`,
        );
      }
      if (Date.now() >= deadline) throw new Error(`child never signalled readiness: ${stderr}`);
      await wait(10);
    }
  }
}

/**
 * Run a cohort of children concurrently: park them all, release them together,
 * and collect their results.
 *
 * @param ops - One mutation per child.
 * @returns Each child's result, in the order the ops were given.
 * @throws {Error} When a child exits without writing a result.
 */
async function race(ops: readonly ChildOp[]): Promise<readonly ChildResult[]> {
  const goFile = path.join(dir, `go-${String(children.length)}`);
  const parked = await Promise.all(ops.map((op) => park(goFile, op)));

  // Attach exit listeners BEFORE releasing the barrier. A child released first
  // could exit before its listener was attached, and `exit` does not replay —
  // the await below would then hang until the test timeout.
  const exits = parked.map(
    ({ child }) =>
      new Promise<void>((resolve, reject) => {
        child.on('exit', (code, signal) => {
          code === 0
            ? resolve()
            : reject(new Error(`child exited code=${String(code)} signal=${String(signal)}`));
        });
      }),
  );

  // Release every child at once. This is the only synchronization point.
  await fs.writeFile(goFile, 'go');

  await Promise.all(exits);

  return Promise.all(
    parked.map(
      async ({ resultFile }) => JSON.parse(await fs.readFile(resultFile, 'utf8')) as ChildResult,
    ),
  );
}

/**
 * Assert every child succeeded and return their values.
 *
 * @param results - Results collected from a cohort.
 * @returns The success values.
 * @throws {Error} When any child reported a failure.
 */
function values(results: readonly ChildResult[]): readonly unknown[] {
  return results.map((r) => {
    if (!r.ok) throw new Error(`child mutation failed: ${r.error}`);
    return r.value;
  });
}

/**
 * Resolve when the child exits cleanly; reject on a non-zero exit. Attach BEFORE
 * releasing the worker so a fast exit is not missed (`exit` does not replay).
 *
 * @param child - The spawned worker.
 * @returns A promise settling on the worker's exit.
 */
function childExit(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.on('exit', (code, signal) => {
      code === 0
        ? resolve()
        : reject(new Error(`child exited code=${String(code)} signal=${String(signal)}`));
    });
  });
}

/**
 * Await the worker's exit, then read its result file.
 *
 * @param parked - The parked worker handle.
 * @param exit - The exit promise attached before release.
 * @returns The worker's reported result.
 */
async function collect(parked: ParkedChild, exit: Promise<void>): Promise<ChildResult> {
  await exit;
  return JSON.parse(await fs.readFile(parked.resultFile, 'utf8')) as ChildResult;
}

/**
 * Poll for a protocol file the worker writes, failing fast if the worker exits
 * first. The wait only OBSERVES a barrier file; it never establishes ordering by
 * elapsed time.
 *
 * @param file - Path the worker writes to signal a stage.
 * @param child - The worker, so a premature exit fails the wait promptly.
 * @throws {Error} When the worker exits before writing the file, or on timeout.
 */
async function waitForFile(file: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fs.access(file);
      return;
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`worker exited before writing ${path.basename(file)}`);
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(file)}`);
      await wait(10);
    }
  }
}

describe('cross-process session write contention (transaction replaces SessionLock)', () => {
  it('does not lose any claim when N processes mint run-control claims for N different runs', async () => {
    // The canonical lost update: each writer reads the session, adds its claim,
    // writes it back. Unserialized, the last writer's snapshot (taken before the
    // others committed) would silently drop every claim minted after it.
    const runIds = await Promise.all([newRun(), newRun(), newRun(), newRun(), newRun()]);

    const results = await race(runIds.map((runId) => ({ kind: 'issueRunControlClaim', runId })));
    values(results);

    const session = await manager.loadSession();
    const controlled = Object.values(session.claims).map((c) => c.controlledRunId);
    expect([...controlled].sort()).toEqual([...runIds].sort());
  }, 120_000);

  it('lets exactly one of N processes claim the same delegated child', async () => {
    // SessionDataSchema carries a controlledRunId-uniqueness invariant: a child
    // has at most one claim. Processes presenting identical linkage must resolve
    // to exactly one `claimed` and the rest `already-claimed` — never two claims
    // for one child, which would render the session unreadable.
    //
    // Four contenders rather than two: the property is the same, but more
    // writers widen the odds that at least two mutation windows genuinely
    // overlap on any given run.
    const parentId = await newRun();
    const linkage = linkageFor(parentId, 'a');
    const childRunId = await newRun({ parentLinkage: linkage });
    // Seed the parent's live delegation so the racing claims pass the R2
    // claim-side latch; the contention property is unaffected.
    await seedLiveDelegation(manager, linkage);

    const results = await race(
      Array.from({ length: 4 }, () => ({
        kind: 'claimRunbook' as const,
        childRunId,
        linkage,
      })),
    );
    const statuses = values(results).map((v) => (v as { status: string }).status);

    expect([...statuses].sort()).toEqual([
      'already-claimed',
      'already-claimed',
      'already-claimed',
      'claimed',
    ]);

    const session = await manager.loadSession();
    const forChild = Object.values(session.claims).filter((c) => c.controlledRunId === childRunId);
    expect(forChild).toHaveLength(1);
  }, 120_000);

  it('keeps every pushed run id exactly once when N processes push concurrently', async () => {
    // `pushRunbook` is read-array/append/write-array — the array-shaped lost
    // update. A dropped push would leave a run started but untargetable.
    const runIds = await Promise.all([newRun(), newRun(), newRun(), newRun(), newRun()]);

    const results = await race(runIds.map((runId) => ({ kind: 'pushRunbook', runId })));
    values(results);

    const session = await manager.loadSession();
    expect([...session.defaultStack].sort()).toEqual([...runIds].sort());
  }, 120_000);

  it('does not clobber a #519 lastSeenAt refresh with a concurrent unrelated mutation', async () => {
    // `recordClaimSeen` rewrites one claim record inside the session; a
    // concurrent push rewrites the stack. Both mutate the same session row, so
    // an unserialized writer would roll one of them back.
    const seenRunId = await newRun();
    const pushRunId = await newRun();
    const { claimId, claim } = await sessionService.issueRunControlClaim(seenRunId);
    const before = claim.lastSeenAt;

    const results = await race([
      { kind: 'recordClaimSeen', claimId: claimId },
      { kind: 'pushRunbook', runId: pushRunId },
    ]);
    const [seen] = values(results);
    expect((seen as { kind: string }).kind).toBe('recorded');

    const session = await manager.loadSession();
    const refreshed = Object.values(session.claims).find((c) => c.controlledRunId === seenRunId);
    // The refresh survived: it was neither rolled back nor overwritten by the
    // concurrent push's snapshot of the claims map.
    expect(refreshed?.lastSeenAt).toBe((seen as { lastSeenAt: string }).lastSeenAt);
    expect(Date.parse(refreshed?.lastSeenAt ?? '')).toBeGreaterThanOrEqual(Date.parse(before));
    // ...and the concurrent push was not rolled back by the refresh either.
    expect(session.defaultStack).toContain(pushRunId);
  }, 120_000);

  it('converges with no duplicate or resurrected entries when releases and pops race', async () => {
    // Stack teardown from several processes at once. Each `releaseRunbook`
    // filters one id out; each `popRunbook` removes the current top. Whatever
    // the interleaving, the survivors must be a subset of the originals with no
    // duplicates, and exactly (initial - removals) entries must remain: a lost
    // update would resurrect a removed id.
    const runIds = await Promise.all([newRun(), newRun(), newRun(), newRun()]);
    for (const runId of runIds) await sessionService.pushRunbook(runId);

    // Two targeted releases plus two pops: four removals against four entries.
    const results = await race([
      { kind: 'releaseRunbook', runId: runIds[0] },
      { kind: 'releaseRunbook', runId: runIds[1] },
      { kind: 'popRunbook' },
      { kind: 'popRunbook' },
    ]);
    values(results);

    const session = await manager.loadSession();
    const { defaultStack } = session;
    expect(new Set(defaultStack).size).toBe(defaultStack.length);
    expect(defaultStack.every((id) => runIds.includes(id))).toBe(true);
    // Four independent removals from a four-entry stack must empty it. Any
    // survivor is an entry a losing writer's stale snapshot put back.
    expect(defaultStack).toEqual([]);
  }, 120_000);

  it('refuses after a claim commits between the fast check and guarded parent write', async () => {
    // Forces the exact defective ordering across TWO OS processes: the advance
    // worker completes its fast pre-check ([] open children) and parks inside its
    // advance callback; while it is parked, THIS process commits the racing claim
    // from a separate SQLite connection; only then is the worker released to
    // attempt the guarded decisive write. No timing luck: the callback-ready ->
    // claim-commit -> callback-go protocol makes it deterministic.
    const parentId = await newRun();
    const linkage = linkageFor(parentId, 'a');
    const childRunId = await newRun({ parentLinkage: linkage });
    await seedLiveDelegation(manager, linkage);

    const goFile = path.join(dir, 'advance-go');
    const callbackReadyFile = path.join(dir, 'advance-callback-ready');
    const callbackGoFile = path.join(dir, 'advance-callback-go');
    const parked = await park(goFile, {
      kind: 'guardedParentAdvance',
      parentRunId: parentId,
      linkage,
      callbackReadyFile,
      callbackGoFile,
    });
    const exit = childExit(parked.child); // attach before releasing the worker
    await fs.writeFile(goFile, 'go');

    // The worker's fast pre-check returned [] and its advance callback is parked.
    await waitForFile(callbackReadyFile, parked.child);

    // Commit the claim from this process/SQLite connection while the worker waits.
    const claimed = assertClaimed(await sessionService.claimRunbook(childRunId, linkage));
    expect((await sessionService.verifyClaimId(assertClaimId(claimed.claimId))).status).toBe(
      'verified',
    );

    // Only now permit the worker's guarded decisive write.
    await fs.writeFile(callbackGoFile, 'go');
    const advance = values([await collect(parked, exit)])[0] as {
      readonly kind: string;
      readonly claims?: readonly { readonly controlledRunId: string }[];
    };

    expect(advance.kind).toBe('open_delegated_children');
    expect(advance.claims?.map((claim) => claim.controlledRunId)).toEqual([childRunId]);
    // The claimant's bearer survives the refused advance.
    expect((await sessionService.verifyClaimId(assertClaimId(claimed.claimId))).status).toBe(
      'verified',
    );
    // The parent did not advance: the decisive write rolled back.
    expect(
      findSubstepState(
        (await manager.load(parentId))?.substepStates ?? [],
        linkage.parentStepId,
        linkage.parentFrameKey,
      )?.status,
    ).not.toBe('done');
  }, 120_000);
});
