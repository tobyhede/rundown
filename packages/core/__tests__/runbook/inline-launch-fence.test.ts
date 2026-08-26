import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import type { Runbook } from '../../src/runbook/types.js';
import { buildFrameKey, findSubstepState } from '../../src/runbook/targeting.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import type { CapturedAuthority } from '../../src/runbook/storage/mutation-result.js';
import { markInlineSubstepLaunched } from '../../src/runbook/inline-launch-fence.js';

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

  async function makeClaimedParent(): Promise<{ parentId: string; authority: CapturedAuthority }> {
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
    jest.spyOn(manager, 'saveState').mockImplementation(async (captured, next) => {
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
    const state = await manager.load(parentId);
    expect(findSubstepState(state?.substepStates ?? [], SUBSTEP, FRAME)).toBeUndefined();
  }, 15_000);

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
