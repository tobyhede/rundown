import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { closeRunbookStores } from '../../src/runbook/storage/store-registry.js';
import type { RunId, Runbook, Step, DelegationLinkage } from '../../src/runbook/types.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import { linkageFor } from './claim-test-helpers.js';

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
 * once, after every child is parked. The DOMAIN assertions make no timing
 * assumptions — each property holds for every possible interleaving, so a lost
 * overlap costs sensitivity, never correctness.
 *
 * SENSITIVITY WITNESS. A correct-but-serialized implementation would pass every
 * domain assertion while proving nothing, so each race additionally asserts
 * `expectOverlap`: at least two children's mutation windows were concurrently in
 * flight. Overlap is MEASURED, not assumed — children stamp an epoch clock
 * around the mutation on both the success and failure arms — and a failure means
 * the barrier release degenerated to serial execution (lost sensitivity), never
 * a correctness regression. The barrier makes overlap reliable in practice; this
 * witness is what fails loudly if that ever stops being true.
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
  | { readonly kind: 'popRunbook' };

/**
 * A child's reported outcome, as written to its result file. `t0`/`t1` bracket
 * the mutation window (epoch ms) and `pid` names the writer; they carry on BOTH
 * arms so the overlap witness can read them without narrowing on `ok`.
 */
type ChildResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly t0: number;
      readonly t1: number;
      readonly pid: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly t0: number;
      readonly t1: number;
      readonly pid: number;
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
 * Sensitivity witness: assert at least two children's mutation windows were
 * concurrently in flight. Two half-open intervals overlap iff each starts before
 * the other ends (`a.t0 < b.t1 && b.t0 < a.t1`). A failure means the barrier
 * release degenerated to serial execution, so the race proved no concurrency —
 * it flags lost sensitivity, not a correctness bug (the domain assertions hold
 * for every interleaving regardless).
 *
 * @param results - Child outcomes collected from the race; each carries `t0`/`t1`.
 * @throws {Error} Via `expect` when no interval pair overlaps.
 */
function expectOverlap(results: readonly ChildResult[]): void {
  const overlapping = results.some((a, i) =>
    results.some((b, j) => i !== j && a.t0 < b.t1 && b.t0 < a.t1),
  );
  expect(overlapping).toBe(true);
}

describe('cross-process session write contention (transaction replaces SessionLock)', () => {
  it('does not lose any claim when N processes mint run-control claims for N different runs', async () => {
    // The canonical lost update: each writer reads the session, adds its claim,
    // writes it back. Unserialized, the last writer's snapshot (taken before the
    // others committed) would silently drop every claim minted after it.
    const runIds = await Promise.all([newRun(), newRun(), newRun(), newRun(), newRun()]);

    const results = await race(runIds.map((runId) => ({ kind: 'issueRunControlClaim', runId })));
    values(results);
    expectOverlap(results);

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

    const results = await race(
      Array.from({ length: 4 }, () => ({
        kind: 'claimRunbook' as const,
        childRunId,
        linkage,
      })),
    );
    const statuses = values(results).map((v) => (v as { status: string }).status);
    expectOverlap(results);

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
    expectOverlap(results);

    const session = await manager.loadSession();
    expect([...session.defaultStack].sort()).toEqual([...runIds].sort());
  }, 120_000);

  it('does not clobber a #519 lastSeenAt refresh with concurrent unrelated mutations', async () => {
    // `recordClaimSeen` rewrites one claim record inside the session; each
    // concurrent push rewrites the stack. All four mutate the same session row,
    // so an unserialized writer would roll one of them back. Three pushes rather
    // than one both raises the odds of a genuine overlap and proves the refresh
    // survives against a whole cohort, not a single racer.
    const seenRunId = await newRun();
    const pushRunIds = await Promise.all([newRun(), newRun(), newRun()]);
    const { claimId, claim } = await sessionService.issueRunControlClaim(seenRunId);
    const before = claim.lastSeenAt;

    const results = await race([
      { kind: 'recordClaimSeen', claimId },
      ...pushRunIds.map((runId) => ({ kind: 'pushRunbook' as const, runId })),
    ]);
    expectOverlap(results);
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
    expectOverlap(results);

    const session = await manager.loadSession();
    const { defaultStack } = session;
    expect(new Set(defaultStack).size).toBe(defaultStack.length);
    expect(defaultStack.every((id) => runIds.includes(id))).toBe(true);
    // Four independent removals from a four-entry stack must empty it. Any
    // survivor is an entry a losing writer's stale snapshot put back.
    expect(defaultStack).toEqual([]);
  }, 120_000);
});
