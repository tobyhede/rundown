import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
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
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import { linkageFor, seedLiveDelegation, assertClaimed } from './claim-test-helpers.js';
import type { ChildOp, ChildResult } from './storage/fixtures/child-protocol.js';

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
 * DETERMINISM. Children use a two-stage barrier: each warms its driver and parks;
 * after the parent releases them, each signals that it is ready to mutate. Only
 * once every child has reached that second barrier does the parent release the
 * mutations. The DOMAIN assertions make no timing assumptions — each property
 * holds for every possible interleaving.
 *
 * SENSITIVITY WITNESS. A correct-but-serialized implementation would pass every
 * domain assertion while proving nothing, so every contention race additionally
 * asserts `expectEveryWorkerStagedBeforeAnyMutation`: every child was ready to
 * mutate before any child started. Unlike interval overlap after release, this
 * property is established by protocol rather than scheduler luck.
 */

const CHILD = fileURLToPath(new URL('./storage/fixtures/session-writer-child.ts', import.meta.url));
// Resolved, never traversed. `../../../../node_modules/tsx/…` is correct in the
// normal tree but lands on `packages/core/node_modules/tsx` inside Stryker's
// sandbox (the copy adds two path segments), and tsx is a ROOT-only
// devDependency that pnpm never links there — so every child died with
// ERR_MODULE_NOT_FOUND and aborted the whole core mutation run at the dry run.
// Node's resolver walks `node_modules` up the directory chain, which reaches the
// repo root from either location, and tsx's `exports` maps `.` to the same
// `dist/loader.mjs` this used to name by hand.
const TSX = createRequire(import.meta.url).resolve('tsx');

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = {
  title: 'Test',
  description: 'A test',
  steps: mockSteps,
};

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
  readonly enteredFile: string;
  readonly resultFile: string;
}

/**
 * Spawn one child and resolve once it has warmed its driver and parked at the
 * barrier. Resolving on readiness — not on a timer — is what makes the release
 * simultaneous.
 *
 * @param goFile - Barrier file every child in this cohort spins on.
 * @param op - The single session mutation this child will perform.
 * @param options - Optional executable override and second-stage barrier.
 * @returns The parked child handle.
 * @throws {Error} When the child never signals readiness within the timeout.
 */
async function park(
  goFile: string,
  op: ChildOp,
  options: { readonly executable?: string; readonly mutationGoFile?: string } = {},
): Promise<ParkedChild> {
  opSeq += 1;
  const tag = String(opSeq);
  const readyFile = path.join(dir, `ready-${tag}`);
  const enteredFile = path.join(dir, `entered-${tag}`);
  const resultFile = path.join(dir, `result-${tag}`);
  const child = spawn(
    options.executable ?? process.execPath,
    [
      '--import',
      TSX,
      CHILD,
      dir,
      readyFile,
      goFile,
      enteredFile,
      options.mutationGoFile ?? goFile,
      resultFile,
      JSON.stringify(op),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  // A spawn failure emits 'error' and never 'exit'. This listener must be attached
  // HERE, at spawn, because nothing else is listening yet: `childExit` attaches its
  // own only after `park` resolves, which a failed spawn never does — so the cohort
  // path is not covered by that listener at all.
  //
  // Two measured facts make recording it necessary. An 'error' with no listener is
  // fatal in plain Node (`throw er` out of EventEmitter), and `child.exitCode` is
  // still null when it fires, so the liveness check below cannot see the failure
  // either — leaving the loop to spin to its 60s deadline and report a readiness
  // timeout that names nothing about the real cause.
  let spawnError: Error | undefined;
  child.on('error', (error: Error) => {
    spawnError = error;
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  children.push(child);

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fs.access(readyFile);
      return { child, enteredFile, resultFile };
    } catch {
      if (spawnError) throw new Error(`child failed to spawn: ${spawnError.message}`);
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
 * Run a cohort through the two-stage barrier: park and release them, wait until
 * every child is ready to mutate, release the mutations, and collect.
 *
 * @param ops - One mutation per child.
 * @returns Each child's result, in the order the ops were given.
 * @throws {Error} When a child exits without writing a result.
 */
async function race(ops: readonly ChildOp[]): Promise<readonly ChildResult[]> {
  const goFile = path.join(dir, `go-${String(children.length)}`);
  const mutationGoFile = path.join(dir, `mutation-go-${String(children.length)}`);
  const parked = await Promise.all(ops.map((op) => park(goFile, op, { mutationGoFile })));

  // Attach exit listeners BEFORE releasing the barrier. A child released first
  // could exit before its listener was attached, and `exit` does not replay —
  // the await below would then hang until the test timeout.
  //
  // `childExit` rather than a hand-rolled promise: this used to be a second copy of
  // it that had drifted, omitting the 'error' listener. One definition removes that
  // divergence by construction — and it already marks itself handled, which matters
  // here because `Promise.all` settles on the FIRST rejection and a second failing
  // child would otherwise reject with nobody watching.
  //
  // Note this is a dedup, NOT the cohort's spawn-failure guard. By the time these
  // listeners are attached every child has already signalled readiness, so it has
  // demonstrably spawned. Spawn failure is `park`'s to catch, and it does — see the
  // 'error' listener there. Do not remove that one believing this covers it.
  const exits = parked.map(({ child }) => childExit(child));

  // Release every warmed child toward the mutation staging barrier.
  await fs.writeFile(goFile, 'go');

  // No mutation may run until every sibling has entered. Unlike a
  // scheduler-sensitive simultaneous release, this establishes a concurrent
  // cohort by protocol even when the host is heavily loaded.
  await Promise.all(parked.map(({ enteredFile, child }) => waitForFile(enteredFile, child)));
  await fs.writeFile(mutationGoFile, 'go');

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
 * Sensitivity witness: assert every child reached the mutation staging barrier
 * before any child began its service call. The parent releases the second
 * barrier only after observing every entry file, so this is deterministic under
 * scheduler load while still excluding artificial barrier time from `t0`/`t1`.
 *
 * @param results - Child outcomes collected from a staged race.
 */
function expectEveryWorkerStagedBeforeAnyMutation(results: readonly ChildResult[]): void {
  const lastStagingEntry = Math.max(...results.map(({ tEntered }) => tEntered));
  const firstMutationStart = Math.min(...results.map(({ t0 }) => t0));
  expect(lastStagingEntry).toBeLessThanOrEqual(firstMutationStart);
}

/**
 * Resolve when the child exits cleanly; reject on a non-zero exit. Attach BEFORE
 * releasing the worker so a fast exit is not missed (`exit` does not replay).
 *
 * @param child - The spawned worker.
 * @returns A promise settling on the worker's exit.
 */
function childExit(child: ChildProcess): Promise<void> {
  const exit = new Promise<void>((resolve, reject) => {
    // A spawn failure emits 'error' and never 'exit', so without this the promise
    // would hang until the suite timeout and report nothing about the real cause.
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      code === 0
        ? resolve()
        : reject(new Error(`child exited code=${String(code)} signal=${String(signal)}`));
    });
  });
  // Mark it handled. Both callers can leave this promise unawaited at the moment it
  // rejects: the single-child path creates it before the barrier protocol and awaits
  // it only at `collect`, so an assertion throwing in between leaves it unwatched
  // while teardown kills the worker; and `race` awaits a whole cohort through
  // `Promise.all`, which settles on the FIRST rejection, leaving any second failing
  // child rejecting with nobody watching. Either way Jest reports an unhandled
  // rejection ON TOP OF — or instead of — the assertion that actually failed, which
  // on a cross-process race test destroys exactly the signal being sought. The no-op
  // handler suppresses only that report; the returned promise still rejects for the
  // caller that awaits it.
  exit.catch(() => {});
  return exit;
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
    expectEveryWorkerStagedBeforeAnyMutation(results);

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
    // Four contenders rather than two: the property is the same, but the larger
    // cohort exercises more mutually exclusive outcomes in one staged race.
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
    expectEveryWorkerStagedBeforeAnyMutation(results);

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
    expectEveryWorkerStagedBeforeAnyMutation(results);

    const session = await manager.loadSession();
    expect([...session.defaultStack].sort()).toEqual([...runIds].sort());
  }, 120_000);

  it('does not clobber a #519 lastSeenAt refresh with concurrent unrelated mutations', async () => {
    // `recordClaimSeen` rewrites one claim record inside the session; each
    // concurrent push rewrites the stack. All four mutate the same session row,
    // so an unserialized writer would roll one of them back. Three pushes prove
    // the refresh survives against a whole cohort, not a single racer.
    const seenRunId = await newRun();
    const pushRunIds = await Promise.all([newRun(), newRun(), newRun()]);
    const { claimId, claim } = unwrapSessionMutation(
      await sessionService.issueRunControlClaim(seenRunId),
    );
    const before = claim.lastSeenAt;

    const results = await race([
      { kind: 'recordClaimSeen', claimId },
      ...pushRunIds.map((runId) => ({ kind: 'pushRunbook' as const, runId })),
    ]);
    expectEveryWorkerStagedBeforeAnyMutation(results);
    // `recordClaimSeen` is the first op, so its result is the first value.
    const [seen] = values(results);
    expect((seen as { kind: string }).kind).toBe('recorded');

    const session = await manager.loadSession();
    const refreshed = Object.values(session.claims).find((c) => c.controlledRunId === seenRunId);
    // The refresh survived: it was neither rolled back nor overwritten by any
    // concurrent push's snapshot of the claims map.
    expect(refreshed?.lastSeenAt).toBe((seen as { lastSeenAt: string }).lastSeenAt);
    expect(Date.parse(refreshed?.lastSeenAt ?? '')).toBeGreaterThanOrEqual(Date.parse(before));
    // ...and every concurrent push survived the refresh, none rolled back.
    expect([...session.defaultStack].sort()).toEqual([...pushRunIds].sort());
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
    expectEveryWorkerStagedBeforeAnyMutation(results);

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
    const claimed = assertClaimed(
      unwrapSessionMutation(await sessionService.claimRunbook(childRunId, linkage)),
    );
    expect((await sessionService.verifyClaimId(assertClaimId(claimed.claimId))).status).toBe(
      'verified',
    );

    // Only now permit the worker's guarded decisive write.
    await fs.writeFile(callbackGoFile, 'go');
    // The real union, not a hand-written structural stand-in: a cast that invents
    // the shape cannot catch the production type drifting away from it.
    const advance = values([await collect(parked, exit)])[0] as Awaited<
      ReturnType<SessionService['runGuardedParentAdvance']>
    >;

    expect(advance.kind).toBe('open_delegated_children');
    if (advance.kind !== 'open_delegated_children') throw new Error('expected a guard refusal');
    expect(advance.claims.map((claim) => claim.controlledRunId)).toEqual([childRunId]);
    // The claimant's bearer survives the refused advance.
    expect((await sessionService.verifyClaimId(assertClaimId(claimed.claimId))).status).toBe(
      'verified',
    );
    // The parent did not advance: the decisive write rolled back. Exact value, not
    // `not.toBe('done')` — that negative also passes when the parent fails to load.
    const parentAfter = await manager.load(parentId);
    expect(parentAfter).toBeDefined();
    expect(
      findSubstepState(
        parentAfter?.substepStates ?? [],
        linkage.parentStepId,
        linkage.parentFrameKey,
      )?.status,
    ).toBe('running');
  }, 120_000);

  it('reports an unhandled op kind instead of succeeding with no value', async () => {
    // `ChildOp` is shared by both halves, so the PARENT cannot construct an
    // unhandled kind — but the wire is JSON across a process boundary, and the
    // child re-parses it as `ChildOp` without checking. The cast is the point: it
    // stands in for the real failure mode, which is a variant added to the union
    // and handled on one side only. With no `default:` arm the child's switch
    // falls through, `run` returns `undefined`, and the child reports `ok: true` —
    // a silent success for work it never performed.
    const unhandledOperation = { kind: 'unhandledFutureOp' } as unknown as ChildOp;

    const [result] = await race([unhandledOperation]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unhandledFutureOp');
  }, 120_000);

  it('stages every worker before any immediately failing mutation starts', async () => {
    const unhandledOperation = { kind: 'unhandledFutureOp' } as unknown as ChildOp;

    const results = await race([unhandledOperation, unhandledOperation, unhandledOperation]);

    expectEveryWorkerStagedBeforeAnyMutation(results);
    expect(results.every((result) => !result.ok)).toBe(true);
  }, 120_000);

  it('reports a spawn failure from park instead of taking the worker down', async () => {
    // The cohort path spawns inside `park`, and until `park` resolves NOTHING is
    // listening for 'error'. A spawn failure emits 'error' with no listener, which
    // Node escalates to an uncaught exception — killing the whole Jest worker
    // before `child.exitCode` is ever set, so park's liveness check never sees it.
    // `childExit`'s own 'error' listener cannot close this window: `race` attaches
    // it only after `park` resolves, which a failed spawn never does.
    await expect(
      park(
        path.join(dir, 'unused-go'),
        { kind: 'popRunbook' },
        {
          executable: path.join(dir, 'no-such-node-binary'),
        },
      ),
    ).rejects.toThrow(/ENOENT/);
  }, 15_000);

  it('rejects rather than hanging when a worker fails to spawn', async () => {
    // A spawn failure emits 'error' and never 'exit'. Without an 'error' listener
    // the exit promise never settles and the cohort await hangs to the 120s suite
    // timeout, reporting nothing about the cause. `race` used to hand-roll its own
    // exit promise without this listener; it now shares `childExit`, so this pins
    // the single definition both paths depend on.
    const child = spawn(path.join(dir, 'no-such-binary-should-not-exist'), [], {
      stdio: 'ignore',
    });

    await expect(childExit(child)).rejects.toThrow(/ENOENT/);
    // Short on purpose: the guarded regression (deleting childExit's 'error'
    // listener) makes this promise never settle, and a 120s ceiling would turn a
    // clear failure into a two-minute stall in a suite that otherwise runs in ~3s.
  }, 15_000);
});
