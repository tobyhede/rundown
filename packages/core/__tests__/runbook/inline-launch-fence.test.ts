import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import type { Runbook, RunbookState } from '../../src/runbook/types.js';
import { buildFrameKey, findSubstepState } from '../../src/runbook/targeting.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import type { CapturedAuthority } from '../../src/runbook/storage/mutation-result.js';
import {
  inlineTargetAlreadyResolved,
  markInlineSubstepLaunched,
} from '../../src/runbook/inline-launch-fence.js';
import { DEFAULT_MUTATE_ATTEMPTS } from '../../src/runbook/storage/runbook-store.js';
import { getRunbookStore } from '../../src/runbook/storage/store-registry.js';

describe('inline launch fence (#714)', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let sessionService: SessionService;

  const mockRunbook: Runbook = {
    title: 'Parent Runbook',
    description: 'Inline launch fence fixture',
    steps: [makeBaseStep({ name: '1', description: 'Composing step' })],
  };

  const FRAME = buildFrameKey('1');
  const SUBSTEP = '1.1';
  const ORDERED = ['1.1', '1.2'] as const;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'inline-fence-test-'));
    manager = new RunbookStateManager(testDir);
    sessionService = new SessionService(manager);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function makeClaimedParent(): Promise<{
    parentId: RunbookState['id'];
    authority: CapturedAuthority;
  }> {
    const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
      runbookPath: 'parent.md',
    });
    unwrapSessionMutation(await sessionService.issueRunControlClaim(parent.id));
    const captured = await manager.captureRunAuthorityState(parent.id);
    if (captured.kind !== 'captured') {
      throw new Error(`expected captured authority, got ${captured.kind}`);
    }
    return { parentId: parent.id, authority: captured.authority };
  }

  function markInput(authority: CapturedAuthority) {
    return {
      authority,
      parentStepId: SUBSTEP,
      parentFrameKey: FRAME,
      targetSubstepIds: ORDERED,
    };
  }

  it('marks the linkage-named substep running under the captured claim generation', async () => {
    const { parentId, authority } = await makeClaimedParent();

    const out = await markInlineSubstepLaunched(manager, markInput(authority));

    expect(out).toEqual({ kind: 'marked' });
    const state = await manager.load(parentId);
    expect(findSubstepState(state?.substepStates ?? [], SUBSTEP, FRAME)?.status).toBe('running');
  });

  it('reports already-resolved without writing when the target substep is done', async () => {
    const { parentId, authority } = await makeClaimedParent();
    await manager.update(parentId, {
      substepStates: [{ id: SUBSTEP, frameKey: FRAME, status: 'done', result: 'pass' }],
    });

    const out = await markInlineSubstepLaunched(manager, markInput(authority));

    expect(out).toEqual({ kind: 'already-resolved' });
    // The done row is untouched: the merge-revert hazard the derive-inside
    // shape exists to prevent (#746) — status must not regress to running.
    const state = await manager.load(parentId);
    expect(findSubstepState(state?.substepStates ?? [], SUBSTEP, FRAME)).toMatchObject({
      status: 'done',
      result: 'pass',
    });
  });

  it('refuses claim_superseded when the parent claim rotates between capture and commit', async () => {
    const { parentId, authority } = await makeClaimedParent();
    // A second orchestrator re-claims the parent in the window between linkage
    // determination and the substep commit — the exact accident ADR 0002 fences.
    unwrapSessionMutation(await sessionService.issueRunControlClaim(parentId));

    const out = await markInlineSubstepLaunched(manager, markInput(authority));

    expect(out).toMatchObject({ kind: 'claim_superseded', runId: parentId });
    const state = await manager.load(parentId);
    expect(findSubstepState(state?.substepStates ?? [], SUBSTEP, FRAME)).toBeUndefined();
  });

  it('refuses claim_superseded when the generation advances under the SAME claim key', async () => {
    const { parentId, authority } = await makeClaimedParent();
    // The tombstoning rotation above is caught by the capture itself; this is
    // the other rotation class — the run's claim generation moves while the
    // original key still resolves active. Any update of a claim's guarded
    // columns bumps the run's counter (`claims_bump_gen_update`), so touch the
    // claim row directly, exactly as a grant rewrite would.
    const store = await getRunbookStore(testDir);
    await store.transaction((txn) => {
      txn.tx
        .prepare('UPDATE claims SET grants_json = grants_json WHERE controlled_run = :runId')
        .run({ runId: parentId });
      return 'committed' as const;
    });

    const out = await markInlineSubstepLaunched(manager, markInput(authority));

    expect(out).toMatchObject({ kind: 'claim_superseded', runId: parentId });
    const state = await manager.load(parentId);
    expect(findSubstepState(state?.substepStates ?? [], SUBSTEP, FRAME)).toBeUndefined();
  });

  it('returns a permanent commit refusal after exactly one attempt', async () => {
    const { parentId, authority } = await makeClaimedParent();
    // Only the ambiguous `concurrent_modification` arm may retry; a permanent
    // refusal retried under the same facts is the shape CLAUDE.md forbids. The
    // deps seam is the injection point, so a structural double is the honest
    // witness here — the real store cannot be made to refuse this arm without
    // an execution lease the fixture has no business taking.
    const envelope = {
      kind: 'execution_in_progress',
      runId: parentId,
      message: `Run ${parentId} has an execution in progress.`,
    } as const;
    let saveCalls = 0;
    const deps = {
      captureAuthorityState: manager.captureAuthorityState.bind(manager),
      saveState: async () => {
        saveCalls += 1;
        return envelope;
      },
    };

    const out = await markInlineSubstepLaunched(deps, markInput(authority));

    expect(out).toEqual(envelope);
    expect(saveCalls).toBe(1);
  });

  it('derives against the committed row when an unrelated write lands before the mark', async () => {
    const { parentId, authority } = await makeClaimedParent();
    // Same claim generation, new state version and a sibling substep row: the
    // mark must keep the sibling (lost-update fold) and still commit under the
    // determination-time generation.
    await manager.update(parentId, {
      substepStates: [{ id: '1.2', frameKey: FRAME, status: 'done', result: 'pass' }],
    });

    const out = await markInlineSubstepLaunched(manager, markInput(authority));

    expect(out).toEqual({ kind: 'marked' });
    const state = await manager.load(parentId);
    expect(findSubstepState(state?.substepStates ?? [], SUBSTEP, FRAME)?.status).toBe('running');
    expect(findSubstepState(state?.substepStates ?? [], '1.2', FRAME)).toMatchObject({
      status: 'done',
      result: 'pass',
    });
  });

  it('re-derives and commits when a concurrent write lands inside the capture-commit window', async () => {
    const { parentId, authority } = await makeClaimedParent();
    // A REAL interleave through the public seam: the first commit attempt runs
    // only after a sibling write bumped the state version, so `saveState`
    // refuses `concurrent_modification` and the fence must re-capture,
    // re-derive, and land — keeping the sibling row (lost-update fold).
    const realSave = manager.saveState.bind(manager);
    const saveSpy = jest.spyOn(manager, 'saveState');
    saveSpy.mockImplementationOnce(async (captured, next) => {
      await manager.update(parentId, {
        substepStates: [{ id: '1.2', frameKey: FRAME, status: 'done', result: 'pass' }],
      });
      return realSave(captured, next);
    });

    const out = await markInlineSubstepLaunched(manager, markInput(authority));

    expect(out).toEqual({ kind: 'marked' });
    expect(saveSpy.mock.calls.length).toBeGreaterThan(1);
    const state = await manager.load(parentId);
    expect(findSubstepState(state?.substepStates ?? [], SUBSTEP, FRAME)?.status).toBe('running');
    expect(findSubstepState(state?.substepStates ?? [], '1.2', FRAME)).toMatchObject({
      status: 'done',
      result: 'pass',
    });
  });

  it('reports concurrent_modification once sustained contention exhausts the budget', async () => {
    const { parentId, authority } = await makeClaimedParent();
    // Every attempt loses: a sibling write lands between each capture and its
    // commit. The fence must spend the store's exported budget and then hand
    // back the ambiguous arm itself — never a permanent refusal it did not
    // observe.
    let bump = 0;
    const realSave = manager.saveState.bind(manager);
    const saveSpy = jest.spyOn(manager, 'saveState').mockImplementation(async (captured, next) => {
      bump += 1;
      // Any authoritative rewrite bumps the version via the state_json trigger,
      // so a rotating sibling row keeps every attempt stale without touching
      // the fenced substep.
      await manager.update(parentId, {
        substepStates: [
          { id: '1.2', frameKey: FRAME, status: 'done', result: bump % 2 ? 'pass' : 'fail' },
        ],
      });
      return realSave(captured, next);
    });

    const out = await markInlineSubstepLaunched(manager, markInput(authority));

    expect(out).toMatchObject({ kind: 'concurrent_modification', runId: parentId });
    // Exactly the store's exported budget — not one attempt more (the pacing
    // and the budget both come from the store, so a drift here is a drift from
    // the cycle this loop mirrors).
    expect(saveSpy).toHaveBeenCalledTimes(DEFAULT_MUTATE_ATTEMPTS);
    const state = await manager.load(parentId);
    expect(findSubstepState(state?.substepStates ?? [], SUBSTEP, FRAME)).toBeUndefined();
  }, 15_000);

  describe('inlineTargetAlreadyResolved', () => {
    // The decision table, pinned directly: the fence consults this on every
    // attempt, and run.ts's pre-read guard shares it, so its arms must hold
    // independently of either caller.
    async function parentStateWith(
      overrides: Partial<Pick<RunbookState, 'substepStates' | 'activeFrameKey' | 'substep'>>,
    ): Promise<RunbookState> {
      const { parentId } = await makeClaimedParent();
      const state = await manager.load(parentId);
      if (state === null) throw new Error('expected parent state');
      return { ...state, ...overrides };
    }

    it('resolves done rows and respects frame identity', async () => {
      const done = await parentStateWith({
        substepStates: [{ id: SUBSTEP, frameKey: FRAME, status: 'done', result: 'pass' }],
      });
      expect(inlineTargetAlreadyResolved(done, SUBSTEP, FRAME, ORDERED)).toBe(true);
      // A running row is not resolved.
      const running = await parentStateWith({
        substepStates: [{ id: SUBSTEP, frameKey: FRAME, status: 'running' }],
      });
      expect(inlineTargetAlreadyResolved(running, SUBSTEP, FRAME, ORDERED)).toBe(false);
      // A done row in ANOTHER frame does not resolve this frame's target.
      const otherFrame = await parentStateWith({
        substepStates: [
          { id: SUBSTEP, frameKey: buildFrameKey('9'), status: 'done', result: 'pass' },
        ],
      });
      expect(inlineTargetAlreadyResolved(otherFrame, SUBSTEP, FRAME, ORDERED)).toBe(false);
    });

    it('applies the cursor check only inside the active frame with a known cursor', async () => {
      // Cursor past the target: resolved.
      const past = await parentStateWith({ activeFrameKey: FRAME, substep: '1.2' });
      expect(inlineTargetAlreadyResolved(past, SUBSTEP, FRAME, ORDERED)).toBe(true);
      // Cursor AT the target: not resolved.
      const at = await parentStateWith({ activeFrameKey: FRAME, substep: SUBSTEP });
      expect(inlineTargetAlreadyResolved(at, SUBSTEP, FRAME, ORDERED)).toBe(false);
      // Inactive frame: the cursor says nothing about this frame.
      const inactive = await parentStateWith({
        activeFrameKey: buildFrameKey('9'),
        substep: '1.2',
      });
      expect(inlineTargetAlreadyResolved(inactive, SUBSTEP, FRAME, ORDERED)).toBe(false);
      // No cursor at all: nothing to compare.
      const cursorless = await parentStateWith({ activeFrameKey: FRAME });
      expect(inlineTargetAlreadyResolved(cursorless, SUBSTEP, FRAME, ORDERED)).toBe(false);
      // No substeps on the step: the check is disabled.
      const noOrder = await parentStateWith({ activeFrameKey: FRAME, substep: '1.2' });
      expect(inlineTargetAlreadyResolved(noOrder, SUBSTEP, FRAME, [])).toBe(false);
      // Unknown cursor or target id (-1): state may be mid-transition — skip.
      const unknownCursor = await parentStateWith({ activeFrameKey: FRAME, substep: '9.9' });
      expect(inlineTargetAlreadyResolved(unknownCursor, SUBSTEP, FRAME, ORDERED)).toBe(false);
      const unknownTarget = await parentStateWith({ activeFrameKey: FRAME, substep: '1.2' });
      expect(inlineTargetAlreadyResolved(unknownTarget, '9.9', FRAME, ORDERED)).toBe(false);
    });
  });

  it('touches only the linkage-named substep row of the named parent (#714 write scope)', async () => {
    const { parentId, authority } = await makeClaimedParent();
    // Pre-existing sibling rows and an unrelated run: the exemption this fence
    // replaced must not silently widen — the mark may change exactly one row of
    // exactly one run.
    await manager.update(parentId, {
      substepStates: [
        { id: '1.2', frameKey: FRAME, status: 'pending' },
        { id: '1.3', frameKey: FRAME, status: 'done', result: 'fail' },
      ],
    });
    const bystander = await manager.create(
      { source: 'project', path: 'bystander.md' },
      mockRunbook,
      { runbookPath: 'bystander.md' },
    );
    const bystanderBefore = await manager.load(bystander.id);
    const parentBefore = await manager.load(parentId);
    if (parentBefore === null) throw new Error('expected parent state');
    // Re-capture: the seeding write above bumped the version the fence commits
    // against; the claim generation is unchanged, which is the fenced fact.
    const recaptured = await manager.captureRunAuthorityState(parentId);
    if (recaptured.kind !== 'captured') throw new Error('expected captured authority');
    expect(recaptured.authority.claimGeneration).toBe(authority.claimGeneration);

    const out = await markInlineSubstepLaunched(manager, markInput(recaptured.authority));
    expect(out).toEqual({ kind: 'marked' });

    const parentAfter = await manager.load(parentId);
    // Guard the comparison's own strictness: this fixture never ran the actor,
    // so there is no snapshot for the deep-equal to silently skip over.
    expect(parentBefore.snapshot).toBeUndefined();
    // The whole committed state equals the pre-state with EXACTLY the target
    // row appended and the write timestamp moved — sibling rows verbatim, every
    // other field byte-identical.
    expect(parentAfter).toEqual({
      ...parentBefore,
      substepStates: [
        { id: '1.2', frameKey: FRAME, status: 'pending' },
        { id: '1.3', frameKey: FRAME, status: 'done', result: 'fail' },
        { id: SUBSTEP, frameKey: FRAME, status: 'running' },
      ],
      updatedAt: parentAfter?.updatedAt,
    });
    // No other run changed.
    expect(await manager.load(bystander.id)).toEqual(bystanderBefore);
  });

  it('refuses missing when the parent run no longer exists', async () => {
    const { parentId, authority } = await makeClaimedParent();
    await manager.delete(parentId);

    const out = await markInlineSubstepLaunched(manager, markInput(authority));

    expect(out).toMatchObject({ kind: 'missing', runId: parentId });
  });
});
