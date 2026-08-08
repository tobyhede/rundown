import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DelegationScanService,
  ExecutionLifecycleService,
  RunbookActorService,
  RunbookCompletionService,
  RunbookLifecycleCommandService,
  RunbookStateManager,
  SessionService,
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  createEffectfulActorMutationRunner,
  findSubstepState,
  assertRunId,
  type ClaimId,
  type RunId,
  type StepDelegation,
} from '../../src/runbook/index.js';
import { claimKeyFromBearer } from '../../src/runbook/claim-id.js';
import { createDelegationCredentialIssuer } from '../../src/runbook/delegation-credential.js';
import { merge } from '../../src/runbook/state-update-ops.js';
import { getRunbookStore, closeRunbookStores } from '../../src/runbook/storage/store-registry.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import { createRunbook } from './fixtures.js';
import type { ChildOp, ChildResult } from './storage/fixtures/multi-record-workflow-child.js';

/**
 * CROSS-PROCESS all-or-none boundaries for the three multi-record delegation
 * workflows: delegate retry, collect, and abort.
 *
 * WHAT IS UNDER TEST. All three now derive in memory from state captured under
 * one aggregate lease and commit once through
 * `EffectfulActorMutationRunner.runAll` → `RunbookStore.commitOwnedRunSet`, which
 * re-checks the captured `state_version` / `claim_generation`. The property these
 * races assert is the consequence: when two processes reach the same workflow
 * from the same captured version, exactly ONE commits, the other is refused with
 * a typed transaction arm, and nothing partial survives — no half-written run
 * state, no orphan session release, no leaked claim, and no execution lease or
 * unfinished attempt row.
 *
 * WHY SEPARATE OS PROCESSES. `RunbookStateManager` and
 * `createEffectfulActorMutationRunner` both resolve their store through a
 * process-level, path-keyed registry (`storage/store-registry.ts`), so two
 * service graphs on the same cwd in the SAME process share one driver and one
 * connection. Their transactions serialize on that shared driver regardless of
 * whether the aggregate transaction is correct, so an in-process "race" is not
 * evidence of anything. Every race below therefore runs in real child processes
 * holding their own SQLite connections, driven through the real seams (see
 * `storage/fixtures/multi-record-workflow-child.ts`).
 *
 * DETERMINISM. Workers are barrier-synchronized, never slept, across TWO stages.
 * The first releases every warmed worker together. The second is the decisive
 * one: each worker parks INSIDE the aggregate fence, after its capture and
 * preparation and before it acquires an execution lease, and the parent releases
 * that barrier only once every worker has parked. So each worker provably holds a
 * capture of the same `state_version` when the first commit lands — which is
 * exactly the interleaving a lost-update defect needs, and exactly the one a
 * timing-luck race almost never produces.
 *
 * SENSITIVITY WITNESS. A correct-but-serialized implementation would satisfy
 * "one winner" while proving nothing, so each race additionally asserts
 * `expectCapturedBeforeAnyReturn`: every worker's capture stamp precedes every
 * worker's return stamp. Overlap is MEASURED, not assumed — workers stamp an
 * epoch clock at capture and at return on both the success and failure arms — and
 * a failure means the two-stage barrier degenerated to serial execution (lost
 * sensitivity), never a correctness regression.
 */

const CHILD = fileURLToPath(
  new URL('./storage/fixtures/multi-record-workflow-child.ts', import.meta.url),
);
// Resolved, never traversed. `../../../../node_modules/tsx/…` is correct in the
// normal tree but lands on `packages/core/node_modules/tsx` inside Stryker's
// sandbox (the copy adds two path segments), and tsx is a ROOT-only
// devDependency that pnpm never links there. Node's resolver walks `node_modules`
// up the directory chain, which reaches the repo root from either location.
const TSX = createRequire(import.meta.url).resolve('tsx');

/**
 * Parent runbook whose step 1 owns one authored DELEGATE substep.
 *
 * `PASS ALL CONTINUE` keeps the run `running` after a full drain, so the retry
 * and abort races assert against a live run. The collect race swaps the step
 * action for `COMPLETE` (see `TERMINAL_PARENT_MARKDOWN`) so its winning
 * transaction also carries the terminal session release.
 */
const PARENT_MARKDOWN = `# Parent

## 1. Delegate work

- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child task

- DELEGATE
- child.runbook.md

## 2. Done

- PASS COMPLETE
- FAIL STOP
`;

/** Same parent, but a full drain completes the run and fires the terminal release. */
const TERMINAL_PARENT_MARKDOWN = PARENT_MARKDOWN.replace(
  '- PASS ALL CONTINUE',
  '- PASS ALL COMPLETE',
);

/** The refusal arms a losing worker may legitimately return. */
const REFUSAL_KINDS = [
  'claim_superseded',
  'concurrent_modification',
  'execution_in_progress',
  'recovery_required',
  'aggregate_recovery_required',
  'missing',
] as const;

let dir: string;
let manager: RunbookStateManager;
let actorService: RunbookActorService;
let lifecycleService: ExecutionLifecycleService;
let completionService: RunbookCompletionService;
let sessionService: SessionService;
let children: ChildProcess[] = [];
let opSeq = 0;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-multi-record-proc-'));
  manager = new RunbookStateManager(dir);
  actorService = new RunbookActorService(manager, {
    // The DELEGATE substep names `child.runbook.md`; a service with no resolver
    // returns null and the machine force-stops the run at start-up. Resolving by
    // name is enough — no worker ever runs the child.
    resolveDelegationRunbook: async (runbookRef: string) => ({
      path: runbookRef,
      runbookRef,
      childRunbookRef: { source: 'project' as const, path: runbookRef },
    }),
  });
  lifecycleService = new ExecutionLifecycleService(manager);
  completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
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

/** A spawned worker parked at the release barrier, with its protocol files. */
interface ParkedChild {
  readonly child: ChildProcess;
  readonly capturedFile: string;
  readonly resultFile: string;
}

/**
 * Spawn one worker and resolve once it has warmed its driver and parked at the
 * release barrier. Resolving on readiness — not on a timer — is what makes the
 * release simultaneous.
 *
 * @param goFile - Release barrier every worker in this cohort spins on.
 * @param captureGoFile - Second-stage barrier released after every worker captured.
 * @param op - The single delegation workflow this worker will run.
 * @returns The parked worker handle.
 * @throws {Error} When the worker never signals readiness within the timeout.
 */
async function park(goFile: string, captureGoFile: string, op: ChildOp): Promise<ParkedChild> {
  opSeq += 1;
  const tag = String(opSeq);
  const readyFile = path.join(dir, `ready-${tag}`);
  const capturedFile = path.join(dir, `captured-${tag}`);
  const resultFile = path.join(dir, `result-${tag}`);
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX,
      CHILD,
      dir,
      readyFile,
      goFile,
      capturedFile,
      captureGoFile,
      resultFile,
      JSON.stringify(op),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  // A spawn failure emits 'error' and never 'exit'. This listener must be attached
  // HERE, at spawn, because nothing else is listening yet: `childExit` attaches its
  // own only after `park` resolves, which a failed spawn never does. An 'error'
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
    try {
      await fs.access(readyFile);
      return { child, capturedFile, resultFile };
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
 * Resolve when the worker exits cleanly; reject on a non-zero exit. Attach BEFORE
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
  // Mark it handled: `Promise.all` settles on the FIRST rejection, so a second
  // failing worker would otherwise reject with nobody watching and Jest would
  // report an unhandled rejection ON TOP OF — or instead of — the assertion that
  // actually failed. The returned promise still rejects for the caller awaiting it.
  exit.catch(() => {});
  return exit;
}

/**
 * Poll for a protocol file a worker writes, failing fast if it exits first. The
 * wait only OBSERVES a barrier file; it never establishes ordering by elapsed time.
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
      await wait(5);
    }
  }
}

/**
 * Run a cohort concurrently through the two-stage barrier: park them, release
 * them together, wait until EVERY one has captured and prepared inside its
 * aggregate fence, then let them all race to commit.
 *
 * @param ops - One delegation workflow per worker.
 * @returns Each worker's result, in the order the ops were given.
 * @throws {Error} When a worker exits without writing a result.
 */
async function race(ops: readonly ChildOp[]): Promise<readonly ChildResult[]> {
  const goFile = path.join(dir, `go-${String(children.length)}`);
  const captureGoFile = path.join(dir, `capture-go-${String(children.length)}`);
  const parked = await Promise.all(ops.map((op) => park(goFile, captureGoFile, op)));

  // Attach exit listeners BEFORE releasing the barrier. A worker released first
  // could exit before its listener was attached, and `exit` does not replay —
  // the await below would then hang until the test timeout.
  const exits = parked.map(({ child }) => childExit(child));

  await fs.writeFile(goFile, 'go');

  // Stage two. Every worker has now captured its targets' authority and state and
  // prepared its mutation, and none holds an execution lease. Releasing them from
  // here is what guarantees each committer is racing against a sibling holding an
  // equally fresh capture.
  await Promise.all(parked.map(({ capturedFile, child }) => waitForFile(capturedFile, child)));
  await fs.writeFile(captureGoFile, 'go');

  await Promise.all(exits);

  return Promise.all(
    parked.map(
      async ({ resultFile }) => JSON.parse(await fs.readFile(resultFile, 'utf8')) as ChildResult,
    ),
  );
}

/**
 * One workflow outcome as it survives the JSON wire.
 *
 * The producing unions (`DelegationIssuanceOutcome`, `DelegationAbortOutcome`,
 * `CollectionWorkflowResult`) are re-parsed from JSON here, where no static
 * guarantee survives, so the parent asserts on `kind` and reads the arm-specific
 * fields as `unknown` rather than re-declaring shapes the wire cannot enforce.
 */
type ChildOutcome = { readonly kind: string } & Readonly<Record<string, unknown>>;

/**
 * Assert every worker completed without throwing and return their outcomes.
 *
 * A workflow refusal is a VALUE on the `ok: true` arm; `ok: false` means the
 * worker threw, which is never an expected outcome here.
 *
 * @param results - Results collected from a cohort.
 * @returns The workflow outcomes, discriminated on `kind`.
 * @throws {Error} When any worker threw.
 */
function outcomes(results: readonly ChildResult[]): readonly ChildOutcome[] {
  return results.map((r) => {
    if (!r.ok) throw new Error(`worker threw: ${r.error}`);
    return r.value as ChildOutcome;
  });
}

/**
 * Sensitivity witness: assert the workers were genuinely in flight together.
 *
 * The claim is stronger than interval overlap, and it is the one the race
 * actually depends on: EVERY worker had finished capturing (and preparing) before
 * ANY worker returned, so every commit attempt was made against a capture taken
 * before the first commit landed. A failure means the two-stage barrier
 * degenerated to serial execution and the race proved no concurrency — lost
 * sensitivity, not a correctness bug.
 *
 * @param results - Worker outcomes; each carries `tCaptured` and `t1`.
 * @throws {Error} Via `expect` when a worker never captured, or when some worker
 *   returned before another had captured.
 */
function expectCapturedBeforeAnyReturn(results: readonly ChildResult[]): void {
  const captures = results.map(({ tCaptured }) => tCaptured);
  expect(captures.every((stamp) => stamp !== null)).toBe(true);
  const lastCapture = Math.max(...captures.map((stamp) => stamp ?? Number.POSITIVE_INFINITY));
  const firstReturn = Math.min(...results.map(({ t1 }) => t1));
  expect(lastCapture).toBeLessThan(firstReturn);
}

/**
 * Partition a cohort's outcomes into the committed winners and the refused losers.
 *
 * @param results - Results collected from a cohort.
 * @param committedKinds - Outcome kinds that mean "this worker committed".
 * @returns The winners and losers, preserving cohort order within each group.
 */
function split(
  results: readonly ChildResult[],
  committedKinds: readonly string[],
): {
  readonly winners: readonly ChildOutcome[];
  readonly losers: readonly ChildOutcome[];
} {
  const all = outcomes(results);
  return {
    winners: all.filter(({ kind }) => committedKinds.includes(kind)),
    losers: all.filter(({ kind }) => !committedKinds.includes(kind)),
  };
}

/** The concurrency counters and execution-attempt rows persisted for one run. */
interface RunFence {
  readonly stateVersion: number;
  readonly execToken: string | null;
  readonly execPid: number | null;
  readonly execEpoch: number | null;
  readonly attemptPhases: readonly string[];
}

/**
 * Read a run's lost-update counter and every execution-attempt row it owns.
 *
 * @param runId - Run to inspect.
 * @returns The persisted fence state.
 * @throws {Error} When the run row is absent.
 */
async function readRunFence(runId: RunId): Promise<RunFence> {
  const store = await getRunbookStore(dir);
  return await store.read((txn) => {
    const row = txn.tx
      .prepare('SELECT state_version, exec_token, exec_pid, exec_epoch FROM runs WHERE id = :id')
      .get<{
        readonly state_version: number;
        readonly exec_token: string | null;
        readonly exec_pid: number | null;
        readonly exec_epoch: number | null;
      }>({ id: runId });
    if (row === undefined) throw new Error(`run ${runId} is missing`);
    const attempts = txn.tx
      .prepare('SELECT phase FROM execution_attempts WHERE run_id = :id ORDER BY exec_epoch ASC')
      .all<{ readonly phase: string }>({ id: runId });
    return {
      stateVersion: row.state_version,
      execToken: row.exec_token,
      execPid: row.exec_pid,
      execEpoch: row.exec_epoch,
      attemptPhases: attempts.map(({ phase }) => phase),
    };
  });
}

/**
 * Assert the run carries no execution lease and no unfinished attempt.
 *
 * "No partial lease" is exactly this: ownership fully cleared on `runs`, every
 * attempt row closed (`committed` or `released`), and no `recovery_pending`
 * attempt left for a later pass to reconcile.
 *
 * @param runId - Run to inspect.
 * @param expectedCommits - How many attempts must have durably written state.
 */
async function expectNoPartialLease(runId: RunId, expectedCommits: number): Promise<void> {
  const fence = await readRunFence(runId);
  expect(fence.execToken).toBeNull();
  expect(fence.execPid).toBeNull();
  expect(fence.execEpoch).toBeNull();
  // `committed` and `released` are the two CLOSED phases; anything else names an
  // attempt that still owns, or still needs, work on this run.
  expect(
    fence.attemptPhases.filter((phase) => phase !== 'committed' && phase !== 'released'),
  ).toEqual([]);
  expect(fence.attemptPhases.filter((phase) => phase === 'committed')).toHaveLength(
    expectedCommits,
  );
  const store = await getRunbookStore(dir);
  await expect(store.readPendingRecovery(runId)).resolves.toBeNull();
}

/** A parent run stood up on its DELEGATE step, with its run-control bearer. */
interface StartedParent {
  readonly runId: RunId;
  readonly claimId: ClaimId;
  readonly seam: RunbookLifecycleCommandService;
}

/**
 * Stand up a real active parent run whose step 1 owns one authored DELEGATE
 * substep, with a run-control claim on the session default stack.
 *
 * The runbook source is written into the project so the workers' `loadSteps`
 * reads the same document off disk, exactly as the CLI's does.
 *
 * @param markdown - Runbook source for the parent run.
 * @returns The run id, its run-control bearer, and a seam bound to this process
 *   for setup issuance.
 */
async function startParent(markdown: string): Promise<StartedParent> {
  const runbookPath = 'parent.runbook.md';
  await fs.writeFile(path.join(dir, runbookPath), markdown);
  const steps = createRunbook(markdown);
  const runId = assertRunId('rd_11111111111111111111111111111111');
  await manager.create(
    { source: 'project', path: runbookPath },
    { title: 'Parent', description: '', steps },
    {
      runId,
      runbookPath,
      frontmatterOutputs: [],
      // The machine's auto-issuance actor reads `RunId` off the compiled context
      // and brands it; a run created without it dies inside `createActor`.
      templateVars: { RunId: runId },
    },
  );
  await sessionService.pushRunbook(runId);
  const { claimId } = unwrapSessionMutation(await sessionService.issueRunControlClaim(runId));
  // Initialise AFTER the run-control claim exists: entering the DELEGATE substep
  // invokes the machine's issuance actor, which refuses without a verified issuer
  // and force-stops the run. Handing it the claim's issuer mints the delegation
  // the way a real `rundown run` does, rather than seeding one by hand.
  await actorService.initializeState(runId, steps, {
    issueDelegationCredential: createDelegationCredentialIssuer({
      kind: 'bearer',
      claimId,
      claimKey: claimKeyFromBearer(claimId),
    }),
  });
  const seam = new RunbookLifecycleCommandService({
    sessionService,
    actorService,
    completionService,
    actorMutationRunner: createEffectfulActorMutationRunner(dir),
    loadRun: async (id) => (await manager.load(id)) ?? undefined,
    loadSteps: () => steps,
    resolveChildRunbook: async (name: string) => ({
      path: name,
      ref: { source: 'project', path: name },
    }),
    findDelegationsByTokenHash: (tokenHash) =>
      new DelegationScanService(manager).scanByTokenHash(tokenHash),
  });
  return { runId, claimId, seam };
}

/**
 * Echo the bearer token for the delegation the machine auto-issued at start-up.
 *
 * The token is only reachable through a real disclosure boundary, so the suite
 * asks the seam for it rather than reconstructing one: a bare `delegate` on an
 * already-issued substep verifies the persisted credential and echoes its token.
 *
 * @param parent - The started parent run.
 * @returns The delegation's bearer token and its persisted hash.
 */
async function echoDelegation(
  parent: StartedParent,
): Promise<{ readonly token: string; readonly tokenHash: string }> {
  const echoed = await parent.seam.issueDelegation({
    mode: 'fresh',
    callerEvidence: { kind: 'claim_bearer', claimId: parent.claimId },
  });
  if (echoed.kind !== 'already-delegated') {
    throw new Error(`expected the auto-issued delegation to echo, got ${echoed.kind}`);
  }
  const delegation = await readDelegation(parent.runId);
  if (!delegation) throw new Error('expected an auto-issued delegation on the DELEGATE substep');
  return { token: echoed.token, tokenHash: delegation.tokenHash };
}

/**
 * Read the delegation persisted on the parent's authored DELEGATE substep.
 *
 * @param runId - Parent run to read.
 * @returns The persisted delegation, or undefined when the substep carries none.
 */
async function readDelegation(runId: RunId): Promise<StepDelegation | undefined> {
  const state = await manager.load(runId);
  expect(state).not.toBeNull();
  return findSubstepState(state?.substepStates ?? [], '1', buildFrameKey('1'))?.delegation;
}

describe('cross-process all-or-none delegation workflows', () => {
  it('commits exactly one of two concurrent delegate retries', async () => {
    const parent = await startParent(PARENT_MARKDOWN);
    const first = await echoDelegation(parent);
    const before = await readRunFence(parent.runId);

    const results = await race([
      { kind: 'retryDelegation', parentRunId: parent.runId, claimId: parent.claimId, step: '1.1' },
      { kind: 'retryDelegation', parentRunId: parent.runId, claimId: parent.claimId, step: '1.1' },
    ]);
    expectCapturedBeforeAnyReturn(results);

    const { winners, losers } = split(results, ['retried']);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(REFUSAL_KINDS).toContain(losers[0].kind);

    // Exactly one replacement landed: the persisted delegation carries the
    // winner's fresh token, and the run's lost-update counter moved by one. A
    // second retry committing on top would have minted a THIRD hash, which no
    // worker reported.
    const winner = winners[0];
    const delegation = await readDelegation(parent.runId);
    expect(delegation?.tokenHash).toBe(winner.tokenHash);
    expect(delegation?.tokenHash).not.toBe(first.tokenHash);
    expect(delegation?.cancelledAt).toBeNull();
    const after = await readRunFence(parent.runId);
    expect(after.stateVersion).toBe(before.stateVersion + 1);

    // No partial state anywhere else: the run stays live on the session stack, the
    // run-control claim is untouched, and no lease or open attempt survives.
    const session = await manager.loadSession();
    expect(session.defaultStack).toEqual([parent.runId]);
    expect(Object.values(session.claims).map((claim) => claim.controlledRunId)).toEqual([
      parent.runId,
    ]);
    await expectNoPartialLease(parent.runId, 1);
  }, 120_000);

  it('commits exactly one of two concurrent aborts', async () => {
    const parent = await startParent(PARENT_MARKDOWN);
    const issued = await echoDelegation(parent);
    const before = await readRunFence(parent.runId);

    const results = await race([
      { kind: 'abortDelegation', token: issued.token, claimId: parent.claimId },
      { kind: 'abortDelegation', token: issued.token, claimId: parent.claimId },
    ]);
    expectCapturedBeforeAnyReturn(results);

    const { winners, losers } = split(results, ['cancelled']);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(REFUSAL_KINDS).toContain(losers[0].kind);
    // The loser is a TRANSACTION refusal, not the idempotent `already_cancelled`
    // no-op: it captured before the winner committed, so its refusal has to come
    // from the commit-time authority re-check.
    expect(losers[0].kind).not.toBe('already_cancelled');

    const delegation = await readDelegation(parent.runId);
    expect(delegation?.cancelledAt).not.toBeNull();
    expect(delegation?.tokenHash).toBe(issued.tokenHash);
    const after = await readRunFence(parent.runId);
    expect(after.stateVersion).toBe(before.stateVersion + 1);

    const session = await manager.loadSession();
    expect(session.defaultStack).toEqual([parent.runId]);
    expect(Object.values(session.claims).map((claim) => claim.controlledRunId)).toEqual([
      parent.runId,
    ]);
    await expectNoPartialLease(parent.runId, 1);
  }, 120_000);

  it('commits exactly one of two concurrent collects, with one terminal release', async () => {
    const parent = await startParent(TERMINAL_PARENT_MARKDOWN);
    // The reported-but-uncollected delegation outcome the race drains. Seeded
    // directly because what is under test is the collect transaction, not how the
    // row got there.
    const completionKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    await manager.update(parent.runId, {
      resolvedCompletions: merge({
        [completionKey]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-07-23T00:00:00.000Z',
        }),
      }),
    });
    const before = await readRunFence(parent.runId);

    const results = await race([
      { kind: 'collect', targetRunId: parent.runId, claimId: parent.claimId },
      { kind: 'collect', targetRunId: parent.runId, claimId: parent.claimId },
    ]);
    expectCapturedBeforeAnyReturn(results);

    const { winners, losers } = split(results, ['collection_applied']);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(REFUSAL_KINDS).toContain(losers[0].kind);
    // Not the idempotent no-op either: both workers prepared a real drain from the
    // same capture, so the loser must be refused by the transaction rather than
    // answering `already_collected` from a stale read.
    expect(losers[0].kind).not.toBe('already_collected');

    const winner = winners[0];
    expect(winner.applied).toBe(1);
    expect(winner.lifecycle).toBe('completed');

    // The drain, the terminal lifecycle, and the session release all landed once,
    // together. A partial commit would show as a consumed outcome on a still
    // running run, or a completed run still on the default stack.
    const state = await manager.load(parent.runId);
    expect(state?.lifecycle).toBe('completed');
    await expect(
      lifecycleService.getResolvedCompletion(parent.runId, completionKey),
    ).resolves.toBeNull();
    const after = await readRunFence(parent.runId);
    expect(after.stateVersion).toBe(before.stateVersion + 1);

    const session = await manager.loadSession();
    expect(session.defaultStack).toEqual([]);
    // `retainClaimsAsTerminal` keeps the bearer resolvable as terminal evidence,
    // so the claim survives the release rather than being dropped by it.
    expect(Object.values(session.claims).map((claim) => claim.controlledRunId)).toEqual([
      parent.runId,
    ]);
    await expectNoPartialLease(parent.runId, 1);
  }, 120_000);
});
