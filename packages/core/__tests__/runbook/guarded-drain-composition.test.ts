import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CompletionLock,
  DelegationLock,
  RunbookActorService,
  RunbookCompletionService,
  RunbookLifecycleCommandService,
  RunbookStateManager,
  SessionService,
  createEffectfulActorMutationRunner,
  type LifecycleTerminalReleasePolicy,
  type CallerEvidence,
  type ResolvedStep,
  type RunbookState,
} from '../../src/runbook/index.js';
import { ExecutionLifecycleService } from '../../src/runbook/execution-lifecycle-service.js';
import { merge } from '../../src/runbook/state-update-ops.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
} from '../../src/runbook/targeting.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { assertClaimId } from '../../src/runbook/claim-id.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import { createRunbook } from './fixtures.js';
import { assertClaimed, linkageFor, seedLiveDelegation } from './claim-test-helpers.js';

/**
 * End-to-end composition pin for the guarded drain.
 *
 * Every other guarded-drain test stubs a drain or mocks `sendAndSync`, so the
 * store's open-delegated-children predicate never actually runs. This suite runs
 * the whole path for real — a real machine snapshot, real applies, a real claim
 * committed between them, and the real predicate deciding — so it asserts the
 * CONSEQUENCE (a mid-drain claim does not swallow a committed advance) rather
 * than the mechanism (which argument each loop passes).
 *
 * That distinction is the point: the per-loop tests in `completion-service.test.ts`
 * and `lifecycle-command-service.test.ts` each pin one expression at its own
 * boundary. Neither would notice if follow-on writes started being guarded by some
 * other route. This one would, because it never inspects a guard value.
 */

const RELEASE_POLICY: LifecycleTerminalReleasePolicy = {
  onComplete: { releaseRunbook: true },
  onStopped: { releaseRunbook: true },
};

// Substeps 1.1/1.2 are drained; 1.3 carries the delegation and stays pending, so
// the child counts as open for the whole drain. The parser ids these '1','2','3'.
const PARENT_MARKDOWN = `## 1. Parent
- PASS CONTINUE
- FAIL STOP

### 1.1 First
- PASS CONTINUE
- FAIL STOP

### 1.2 Second
- PASS CONTINUE
- FAIL STOP

### 1.3 Delegated
- PASS CONTINUE
- FAIL STOP

## 2. Done
- PASS COMPLETE
- FAIL STOP
`;

const DELEGATED_SUBSTEP_ID = '3';

describe('guarded drain composition (real store, real predicate)', () => {
  let tmp: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
  let lifecycleService: ExecutionLifecycleService;
  let completionService: RunbookCompletionService;
  let sessionService: SessionService;
  let seam: RunbookLifecycleCommandService;
  let steps: ResolvedStep[];

  const parentRunId = assertRunId(`rd_${'1'.repeat(32)}`);
  const childRunId = assertRunId(`rd_${'2'.repeat(32)}`);

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'guarded-drain-composition-'));
    manager = new RunbookStateManager(tmp);
    actorService = new RunbookActorService(manager);
    lifecycleService = new ExecutionLifecycleService(manager);
    completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
    sessionService = new SessionService(manager);
    steps = createRunbook(PARENT_MARKDOWN);
    seam = new RunbookLifecycleCommandService({
      sessionService,
      actorService,
      lifecycleService,
      completionService,
      actorMutationRunner: createEffectfulActorMutationRunner(tmp),
      loadRun: async (id) => (await manager.load(id)) ?? undefined,
      deleteRun: async (id) => {
        await manager.delete(id);
      },
      loadSteps: () => steps,
      resolveChildRunbook: async () => undefined,
      persistIssuedSubstep: async () => {},
      findDelegationByToken: async () => undefined,
      delegationLock: new DelegationLock(tmp),
      completionLock: new CompletionLock(tmp),
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  /** Queue a manual completion for `substep` on the parent's active frame. */
  async function queueCompletion(substep: string): Promise<string> {
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), substep);
    await manager.update(parentRunId, {
      resolvedCompletions: merge({
        [key]: buildResolvedCompletion({
          // `manual` is load-bearing: a 'delegation' row trips
          // runGuardedParentAdvance's collection-pending refusal before the
          // callback ever runs, which would hide the branch under test.
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: substep,
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      }),
    });
    return key;
  }

  it('commits no partial advance when a delegated child claims during preparation', async () => {
    // A real initialised state: the machine snapshot is what lets the applies below
    // run for real instead of dying inside sendAndSync.
    const created = await manager.create(
      { source: 'project', path: 'parent.runbook.md' },
      { title: 'Parent', description: '', steps },
      { runId: parentRunId, runbookPath: 'parent.runbook.md', frontmatterOutputs: [] },
    );
    await actorService.initializeState(created.id, steps);
    await sessionService.pushRunbook(created.id);
    const { claimId: runControl } = unwrapSessionMutation(
      await sessionService.issueRunControlClaim(created.id),
    );
    const evidence: CallerEvidence = { kind: 'claim_bearer', claimId: runControl };

    // Two undrained completions: the state a process leaves by dying between the
    // separately-locked record and drain. The first makes the record short-circuit
    // `duplicate`, which is what moves the decisive write into the drain.
    const firstKey = await queueCompletion('1');
    const secondKey = await queueCompletion('2');

    // A delegated child on substep 1.3, live for the whole drain.
    const linkage = linkageFor(parentRunId, 'a', DELEGATED_SUBSTEP_ID);
    const childBase = await manager.create(
      { source: 'project', path: 'child.runbook.md' },
      { title: 'Child', description: '', steps },
      { runId: childRunId, runbookPath: 'child.runbook.md', frontmatterOutputs: [] },
    );
    await manager.update(childBase.id, { parentLinkage: linkage });
    await seedLiveDelegation(manager, linkage);

    // Commit the claim after the first pure actor preparation and before the one
    // owned commit. The execution guard must refuse the whole prepared mutation.
    const realPrepare = actorService.prepareActorMutation.bind(actorService);
    let applies = 0;
    let claimedId: string | undefined;
    jest
      .spyOn(actorService, 'prepareActorMutation')
      .mockImplementation(
        async (...args: Parameters<RunbookActorService['prepareActorMutation']>) => {
          const result = await realPrepare(...args);
          applies += 1;
          if (applies === 1) {
            claimedId = assertClaimed(
              unwrapSessionMutation(await sessionService.claimRunbook(childRunId, linkage)),
            ).claimId;
          }
          return result;
        },
      );

    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: evidence,
      targetSelector: { kind: 'run', runId: parentRunId },
      terminalPolicy: RELEASE_POLICY,
    });

    // The claim really is live, so the predicate WOULD refuse any guarded write
    // issued after it landed. Without this the test could pass by never racing.
    expect(claimedId).toBeDefined();
    expect((await sessionService.verifyClaimId(assertClaimId(claimedId!))).status).toBe('verified');

    expect(outcome.kind).toBe('recovery_required');

    // Neither prepared completion was consumed: record + drain is all-or-none.
    await expect(
      lifecycleService.getResolvedCompletion(parentRunId, firstKey),
    ).resolves.not.toBeNull();
    await expect(
      lifecycleService.getResolvedCompletion(parentRunId, secondKey),
    ).resolves.not.toBeNull();

    // ...and the persisted cursor remains at the pre-mutation substep.
    const parentAfter: RunbookState | null = await manager.load(parentRunId);
    expect(parentAfter?.substep).toBe('1');
  });
});
