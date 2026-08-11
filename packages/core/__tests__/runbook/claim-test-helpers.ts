import { jest } from '@jest/globals';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import type { RunbookActorService } from '../../src/runbook/actor-service.js';
import type { SessionService } from '../../src/runbook/session-service.js';
import type { RunbookStateManager } from '../../src/runbook/state.js';
import type { RunbookStore } from '../../src/runbook/storage/runbook-store.js';
import type { ClaimRunbookResult } from '../../src/runbook/claim-id.js';
import type { DelegationLinkage, RunId, SubstepState } from '../../src/runbook/types.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import { makeStepDelegation } from '../helpers/step-factories.js';

/**
 * Build a delegation linkage for a parent run id, used for both child creation
 * and claiming. `fill` fills the delegation token hash (the char repeated 64
 * times); reuse the same `fill` for create + claim to keep the child's
 * persisted linkage matching the claim record, and vary it to diverge them.
 *
 * @param parentId - Parent run id the child is delegated from.
 * @param fill - Single character repeated to form the token hash.
 * @param parentStepId - Substep id the delegation occupies in the parent frame.
 *   Defaults to `'1.1'`; sibling delegations under one parent must pass distinct
 *   ids so each occupies its own live substep slot.
 * @returns Delegation linkage accepted by SessionService.claimRunbook.
 */
export const linkageFor = (
  parentId: RunId,
  fill: string,
  parentStepId = '1.1',
): Parameters<SessionService['claimRunbook']>[1] => ({
  kind: 'delegation' as const,
  parentRunId: parentId,
  parentStepId,
  parentStep: '1',
  parentFrameKey: buildFrameKey('1'),
  parentEntry: 1,
  tokenHash: assertDelegationTokenHash(`sha256:${fill.repeat(64)}`),
});

/**
 * Seed the parent so the delegation described by `linkage` is live.
 *
 * The R2 claim-side latch refuses a claim unless the parent carries a live
 * delegation substep matching the incoming linkage — exactly what a real
 * delegation writes. Synthetic-linkage fixtures never set that up, so this
 * upserts the matching substep (merging with any siblings already seeded) with
 * the linkage's token. A parent that does not exist is left untouched, so a
 * test can still exercise the parent-unreadable path.
 *
 * @param manager - State manager owning the parent run.
 * @param linkage - Delegation linkage whose parent-side substep to seed.
 */
export async function seedLiveDelegation(
  manager: RunbookStateManager,
  linkage: DelegationLinkage,
): Promise<void> {
  const parent = await manager.load(linkage.parentRunId);
  if (!parent) {
    return;
  }
  const existing = parent.substepStates ?? [];
  const substep: SubstepState = {
    id: linkage.parentStepId,
    frameKey: linkage.parentFrameKey,
    status: 'running',
    delegation: makeStepDelegation({ tokenHash: linkage.tokenHash }),
  };
  const merged = [
    ...existing.filter(
      (s) => !(s.id === linkage.parentStepId && s.frameKey === linkage.parentFrameKey),
    ),
    substep,
  ];
  await manager.update(linkage.parentRunId, { substepStates: merged });
}

/**
 * Seed a live delegation on the parent, then claim it — the faithful fixture
 * equivalent of a real delegate-then-claim flow. Intended refusals downstream
 * of the parent-liveness gate (terminal child, linkage mismatch, missing child)
 * still surface, because the gate passes for a live parent.
 *
 * @param sessionService - Service under test.
 * @param manager - State manager owning the parent run.
 * @param childRunId - Child run being claimed.
 * @param linkage - Delegation linkage to seed and claim.
 * @returns The claim result.
 */
export async function claimLiveDelegation(
  sessionService: SessionService,
  manager: RunbookStateManager,
  childRunId: RunId,
  linkage: DelegationLinkage,
): Promise<ClaimRunbookResult> {
  await seedLiveDelegation(manager, linkage);
  return unwrapSessionMutation(await sessionService.claimRunbook(childRunId, linkage));
}

/**
 * Run one test-controlled interleave when actor preparation is first reached.
 *
 * `prepareActorMutation` is the deterministic barrier point after transition
 * policy and guarded-parent fast checks but before the decisive actor-derived
 * write. The callback is awaited before real preparation continues, so callers
 * can commit a competing mutation without relying on scheduler timing. This is
 * synchronization machinery only: callers assert behavior through the public
 * lifecycle-command outcome.
 *
 * Restored by the caller's `jest.restoreAllMocks()`. The callback runs at most
 * once however many times the seam is entered.
 *
 * @param actorService - Service whose preparation seam is synchronized.
 * @param interleave - Competing operation to complete before preparation resumes.
 * @returns Getter for the operation's result, or `undefined` before the seam runs.
 */
export function interleaveOnceDuringActorPrepare<T>(
  actorService: RunbookActorService,
  interleave: () => Promise<T>,
): () => T | undefined {
  const realPrepare = actorService.prepareActorMutation.bind(actorService);
  let interleavePromise: Promise<T> | undefined;
  let interleaveResult: T | undefined;
  jest.spyOn(actorService, 'prepareActorMutation').mockImplementation(async (...args) => {
    interleavePromise ??= interleave();
    interleaveResult = await interleavePromise;
    return realPrepare(...args);
  });
  return () => interleaveResult;
}

/**
 * Land a child claim inside the parent's decisive write, after the resolver's
 * cheap pre-check has already passed.
 *
 * This is the interleaving that only the in-transaction open-children guard can
 * catch: the claim commits during `prepareActorMutation` — inside the fenced
 * preparation, past every pre-check — so a parent advance that consults only the
 * pre-check will commit straight over it. Spying that seam is the whole fixture,
 * and it is shared so the fence point is stated once: every arm that must reach
 * the guard races the claim at the same instant, and moving the fence moves it
 * for all of them.
 *
 * WITNESSES ROUTING, NOT ISOLATION. `claimant` resolves its store through the
 * process-level, path-keyed registry, so on the same cwd it shares one driver
 * and one connection with the run under test and the two writes serialize on
 * that driver — see the header of `session-service.process.test.ts`, which is
 * why every genuine contention race there runs in real child processes. What
 * this fixture proves is that the arm reaches `runGuardedParentAdvance` at all
 * and that the guard's in-transaction read sees a claim the pre-checks missed;
 * that seam's behaviour under true multi-connection contention is pinned
 * cross-process by `session-service.process.test.ts`'s "refuses after a claim
 * commits between the fast check and guarded parent write". A test built here
 * would still pass if SQLite offered no isolation whatsoever, so do not read it
 * as evidence of the transactional property.
 *
 * Restored by the caller's `jest.restoreAllMocks()`; the claim fires at most
 * once however many times the seam is entered.
 *
 * @param actorService - Service whose `prepareActorMutation` seam is spied.
 * @param claimant - Independent session service standing in for the racing process.
 * @param childRunId - Child run the racing process claims.
 * @param linkage - Delegation linkage the racing claim presents.
 * @returns Getter for the racing claim's result, `undefined` if the seam never ran.
 */
export function raceChildClaimDuringActorPrepare(
  actorService: RunbookActorService,
  claimant: SessionService,
  childRunId: RunId,
  linkage: DelegationLinkage,
): () => Awaited<ReturnType<SessionService['claimRunbook']>> | undefined {
  return interleaveOnceDuringActorPrepare(actorService, () =>
    claimant.claimRunbook(childRunId, linkage),
  );
}

/**
 * Retire the run's controlling claim from inside the keyed authority capture.
 *
 * `captureAuthorityState` is reached ONLY when the fenced mutation carries the
 * presented bearer's capture key — without it the runner falls back to
 * `captureRunAuthorityState`, which resolves whatever claim CURRENTLY controls
 * the run and would silently upgrade a stale bearer. Releasing from inside the
 * keyed capture therefore does two jobs at once: it opens the stale-bearer race
 * the fence must lose, and it witnesses that the keyed arm ran at all. Drop the
 * key and the returned list stays empty.
 *
 * The retirement lands on the FIRST capture only, so a multi-member cascade
 * retires once; every capture's run id is still collected in call order, which
 * is what lets a cascade test prove the key landed on the bearer's own run and
 * nowhere else.
 *
 * Restored by the caller's `jest.restoreAllMocks()`.
 *
 * @param store - Store whose keyed capture seam is spied.
 * @param retiring - Independent session service standing in for the retiring holder.
 * @param retiredRunId - Run whose controlling claim is released mid-capture.
 * @returns Getter for the run ids captured through the keyed seam, in call order.
 */
export function retireDuringCapture(
  store: RunbookStore,
  retiring: SessionService,
  retiredRunId: RunId,
): () => readonly RunId[] {
  const realCapture = store.captureAuthorityState.bind(store);
  const capturedRunIds: RunId[] = [];
  let retired = false;
  jest.spyOn(store, 'captureAuthorityState').mockImplementation(async (...args) => {
    const captured = await realCapture(...args);
    if (!retired) {
      retired = true;
      await retiring.releaseRunbook(retiredRunId);
    }
    capturedRunIds.push(args[0]);
    return captured;
  });
  return () => capturedRunIds;
}

const isClaimed = <T extends { status: string }>(
  result: T,
): result is Extract<T, { status: 'claimed' }> => result.status === 'claimed';

/**
 * Narrow a claim result to the `claimed` variant or throw.
 *
 * @param result - Result returned by SessionService.claimRunbook.
 * @returns The same result narrowed to `status: 'claimed'`.
 * @throws {Error} when the result is not a successful claim.
 */
export const assertClaimed = <T extends { status: string }>(
  result: T,
): Extract<T, { status: 'claimed' }> => {
  if (!isClaimed(result)) {
    throw new Error(`Expected claim result, got status=${result.status}`);
  }
  return result;
};
