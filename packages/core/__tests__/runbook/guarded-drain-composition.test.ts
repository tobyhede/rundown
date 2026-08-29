import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
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
import { getRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import { createRunbook } from './fixtures.js';
import { assertClaimed, linkageFor, seedLiveDelegation } from './claim-test-helpers.js';

/**
 * Composition pin for the manual-ingress / Run Progression boundary.
 *
 * A manual pass/fail records one completion under the lifecycle seam's guard;
 * it never prepares or batch-applies previously queued completions in that same
 * commit. The returned activation directive is the only authority to apply
 * those rows later, one CAS/observation turn at a time.
 */

const RELEASE_POLICY: LifecycleTerminalReleasePolicy = {
  releaseOnTerminal: true,
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

describe('guarded manual-completion ingress', () => {
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
    completionService = new RunbookCompletionService(manager, actorService);
    sessionService = new SessionService(manager);
    steps = createRunbook(PARENT_MARKDOWN);
    seam = new RunbookLifecycleCommandService({
      sessionService,
      actorService,
      completionService,
      actorMutationRunner: createEffectfulActorMutationRunner(tmp),
      loadRun: async (id) => (await manager.load(id)) ?? undefined,
      loadSteps: () => steps,
      resolveChildRunbook: async () => undefined,
      findDelegationsByTokenHash: async () => ({ current: undefined, superseding: [] }),
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

  it('records ingress without batch-applying queued completions', async () => {
    // A real initialized state: activation may later restore this exact machine
    // snapshot, but the recording seam must not restore or drive it.
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

    // Two queued completions. The first makes this manual ingress idempotent;
    // neither row may be applied inside the record-only mutation.
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

    // If the recording seam accidentally prepares even one completion, this
    // hook makes that hidden batch work observable by claiming the child.
    const realPrepare = actorService.prepareActorMutation.bind(actorService);
    let applies = 0;
    let claimedId: string | undefined;
    const prepare = jest
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

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') throw new Error(`expected applied, got ${outcome.kind}`);
    expect(outcome.progression.kind).toBe('activate');
    expect(prepare).not.toHaveBeenCalled();
    expect(claimedId).toBeUndefined();
    await expect((await getRunbookStore(tmp)).readPendingRecovery(parentRunId)).resolves.toBeNull();

    // Neither queued completion was consumed: applying them belongs to the
    // returned Run Progression activation, not this lifecycle mutation.
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
