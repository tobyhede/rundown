import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunbookDocument, type ResolvedStep } from '@rundown-org/parser';
import {
  assertRunId,
  commitRunProgressionEvent,
  generateRunId,
  progressionDirectiveForStartedRun,
  recordInlineLaunchStart,
  RunbookStateManager,
  SessionService,
  type DelegationTokenHash,
  type FrameKey,
  type InlineLaunchIntent,
  type InlineLaunchStart,
  type InlineLinkage,
  type ParentLinkage,
  type RunbookActorService,
  type RunProgressionAuthority,
  type RunId,
  type SubstepState,
} from '@rundown-org/core';
import { patchPersistedRunState } from '@rundown-org/core/testing/session-fixtures';
import { createCliRunbookActorService } from '../../src/helpers/actor-service-factory.js';
import {
  classifyInlineChildLinkage,
  heldInlineLatch,
  inlineLinkageFromIntent,
  latchInlineLaunch,
  type InlineLaunchLatch,
} from '../../src/services/inline-launch-latch.js';

// ACCEPTED MUTATION SURVIVORS in inline-launch-latch.ts, scoped run:
//
//   STRYKER_SCOPED=true STRYKER_CONCURRENCY=1 pnpm --filter @rundown-org/cli \
//     exec stryker run --mutate src/services/inline-launch-latch.ts \
//     --testFiles __tests__/services/inline-launch-latch.test.ts --force
//
// 97.01% — 162 killed, 3 SURVIVED and 2 NO-COVERAGE. The five reconcile as
// 3 + 2, and every one is unreachable by construction rather than untested:
//
// Survived (3), all optional-chaining guards over a shape that cannot coexist
// with a persisted intent — the intent and the substep row are written by the
// same machine transition, so a run carrying one carries the other:
//  - `snapshot?.context.` — a snapshot object with no `context` key.
//    Note the OUTER `snapshot?.` is killed, by the absent-snapshot case below:
//    `state.snapshot` really is optional, and dropping that guard throws a
//    TypeError out of the compare-and-swap instead of refusing.
//  - `state.substepStates.find` — a parent with no substep rows at all.
//  - `substepState.inline` — no row at the intent's own coordinate.
//
// No-coverage (2), both on ONE line: the launch switch's `default:` arm, whose
// body is `const _exhaustive: never = ownership`. Stryker mutates the arm twice
// (ConditionalExpression and BlockStatement), and neither is reachable at
// runtime — it is the compile-time exhaustiveness check the repo uses
// everywhere, and getting there would need an ownership kind the type forbids.
//
// The scope added alongside `INLINE_LAUNCH_ABANDONED` contributes five more
// accepted survivors, ALL of them logging-only, in a scoped run over its own
// changed ranges:
//  - the `catch` body in `heldInlineLatch` (emptying it still swallows, which is
//    the behaviour; the log is the only difference),
//  - the warn message string and the `...describe()` spread into its context,
//  - the `describe` closure the `won` arm passes, whose sole consumer is that
//    warn call.
// Asserting on them would mean pinning log text, which this repo does not do —
// core's `heldLock` owns the identical best-effort policy and its own test
// (`file-lock.test.ts`, "disposal is best-effort") asserts the swallow and the
// release count, not the message. The behavioural mutants around them — release
// once, release not at all after `keep()`, release at most once across repeated
// disposal, and never propagate — are killed by the `heldInlineLatch` describe
// below, which counts releases; driving that through the latch alone cannot,
// because a second release lands on an already-cleared row and is
// indistinguishable from none.
//
// Worth recording because an earlier revision of this module scored 69% over
// 203 mutants, with 24 survivors in a hand-rolled `isPersistedInlineLaunchIntent`
// `&&` chain it used to own. They were unkillable at this interface: forcing a
// conjunct true let a malformed intent past the guard, and the coordinate
// comparison refused it anyway. The chain is gone — core's
// `isInlineLaunchIntentWithoutParentEntry` is the guard now — so that surface was
// deleted rather than tested.

describe('classifyInlineChildLinkage', () => {
  const parentRunId = assertRunId(`rd_${'a'.repeat(32)}`);
  const otherParentRunId = assertRunId(`rd_${'b'.repeat(32)}`);
  const current: InlineLinkage = {
    kind: 'inline',
    parentRunId,
    parentStepId: '1',
    parentStep: '2',
    parentFrameKey: '2|' as FrameKey,
    parentEntry: 3,
  };

  it('matches a child recorded at the same coordinates and the same frame entry', () => {
    expect(classifyInlineChildLinkage({ ...current }, current)).toEqual({ kind: 'matched' });
  });

  it('reports a superseded entry when only the frame entry differs', () => {
    // The ratified staleness rule: a frame re-entry advances the entry, and a
    // child stamped at the previous entry belongs to that previous entry —
    // exactly what `classifyDelegationLiveness` closes `cursor-advanced` for a
    // delegated child. Reported as its own kind so the refusal can say so.
    expect(classifyInlineChildLinkage({ ...current, parentEntry: 2 }, current)).toEqual({
      kind: 'superseded-entry',
      recordedEntry: 2,
      currentEntry: 3,
    });
  });

  it('reports a superseded entry for a child stamped ahead of the current entry', () => {
    // Direction is not the discriminator — divergence is. A child claiming a
    // higher entry than the frame has reached is no more adoptable than a
    // stale one, and calling it a coordinate conflict would misdiagnose it.
    expect(classifyInlineChildLinkage({ ...current, parentEntry: 9 }, current)).toEqual({
      kind: 'superseded-entry',
      recordedEntry: 9,
      currentEntry: 3,
    });
  });

  it.each<readonly [string, ParentLinkage]>([
    ['a different parent run', { ...current, parentRunId: otherParentRunId }],
    ['a different substep id', { ...current, parentStepId: '2' }],
    ['a different parent step', { ...current, parentStep: '3' }],
    ['a different frame key', { ...current, parentFrameKey: '2#1|' as FrameKey }],
    [
      'a delegation linkage',
      {
        ...current,
        kind: 'delegation',
        tokenHash: 'sha256:deadbeef' as DelegationTokenHash,
      },
    ],
  ])('reports a conflicting parent for %s', (_label, recorded) => {
    expect(classifyInlineChildLinkage(recorded, current)).toEqual({ kind: 'conflicting-parent' });
  });

  it('reports a conflicting parent when the child records no linkage at all', () => {
    expect(classifyInlineChildLinkage(undefined, current)).toEqual({
      kind: 'conflicting-parent',
    });
  });

  it('prefers the coordinate conflict when the entry also differs', () => {
    // A child naming another parent is not "stale" — the remedy differs, so
    // the coordinate check must win rather than being masked by the entry one.
    expect(
      classifyInlineChildLinkage(
        { ...current, parentRunId: otherParentRunId, parentEntry: 2 },
        current,
      ),
    ).toEqual({ kind: 'conflicting-parent' });
  });
});

const PARENT_MARKDOWN = `---
name: parent
---
# Parent

## 1. Start
- PASS CONTINUE

Ready.

## 2. Compose
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md

## 3. Review
- PASS COMPLETE

Reviewed.
`;

/**
 * A pid above every platform's pid_max (Linux 4194304, macOS 99998), so
 * `kill(pid, 0)` is always ESRCH — unlike a spawned-and-reaped pid, which is
 * only dead until the OS recycles it.
 */
const DEAD_PID = 999999999;

/** Work directory the parent's template vars name; every run here shares it. */
const WORK_PATH = '.rundown/work';

const CHILD_MARKDOWN = `---
name: child
---
# Child

## 1. Create
- PASS COMPLETE

Child prompt.
`;

/**
 * A parent run persisted at the exact moment the latch is reached.
 *
 * The intent is prepared by the machine's own `inlineLaunchIntentActor` on
 * substep entry, so everything here — the intent, the child run id, the substep
 * row carrying a null `started` — is real machine output rather than a fixture
 * shaped to look like one.
 */
interface LatchableParent {
  readonly manager: RunbookStateManager;
  readonly actorService: RunbookActorService;
  readonly authority: RunProgressionAuthority;
  readonly parentRunId: RunId;
  readonly childRunId: RunId;
  readonly steps: readonly ResolvedStep[];
  readonly intent: InlineLaunchIntent;
  readonly parentLinkage: InlineLinkage;
}

describe('latchInlineLaunch', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'rd-latch-'));
    // Stops policy/config discovery walking above the temp workspace.
    await writeFile(join(cwd, '.git'), 'gitdir: /dev/null\n');
    const runbooks = join(cwd, '.rundown', 'runbooks');
    await mkdir(runbooks, { recursive: true });
    await writeFile(join(runbooks, 'child.runbook.md'), CHILD_MARKDOWN);
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /**
   * Drive a real parent run to the substep whose entry prepared an inline
   * launch intent, and hand back everything the latch decides against.
   *
   * @returns The seeded parent, its store seams, and the observed intent.
   * @throws {Error} When the machine did not persist an intent, which would
   *   otherwise surface as an unexplained `superseded` in every case below.
   */
  async function seedLatchableParent(): Promise<LatchableParent> {
    const manager = new RunbookStateManager(cwd);
    const actorService = createCliRunbookActorService(manager);
    const { runbook } = parseRunbookDocument(PARENT_MARKDOWN, 'parent.runbook.md');
    const parentRunId = generateRunId();
    const created = await manager.create(
      { source: 'project', path: 'parent.runbook.md' },
      runbook,
      {
        runId: parentRunId,
        runbookPath: 'parent.runbook.md',
        runbookSrc: PARENT_MARKDOWN,
        templateVars: { RunId: parentRunId, ContextId: 'ctx-latch', WorkPath: WORK_PATH },
      },
    );
    const { getRunbookFromState } = await import('../../src/helpers/runbook-loader.js');
    const steps = getRunbookFromState(created, cwd);
    await actorService.initializeState(parentRunId, steps);
    const issued = await new SessionService(manager).issueRunControlClaim(parentRunId);
    if (issued.kind !== 'committed') throw new Error(issued.message);
    const authority = progressionDirectiveForStartedRun(created, steps, issued.value).authority;
    // Step 1 → step 2, whose substep entry invokes `inlineLaunchIntentActor`.
    const initialized = await manager.load(parentRunId);
    if (initialized === null) throw new Error('initialized parent disappeared');
    const passed = await actorService.prepareActorMutation(parentRunId, initialized, steps, {
      type: 'PASS',
    });
    const captured = await manager.captureRunAuthorityState(parentRunId);
    if (captured.kind !== 'captured') throw new Error(captured.message);
    const passCommit = await manager.saveState(captured.authority, passed.nextState);
    if (passCommit.kind !== 'committed') throw new Error(passCommit.message);

    const state = await manager.load(parentRunId);
    const persisted = (
      state?.snapshot as
        | { readonly context?: { readonly inlineLaunchIntent?: unknown } }
        | undefined
    )?.context?.inlineLaunchIntent;
    if (!persisted || typeof persisted !== 'object') {
      throw new Error(
        `seedLatchableParent: no inline launch intent persisted for ${parentRunId}; ` +
          `substepStates=${JSON.stringify(state?.substepStates)}`,
      );
    }
    // The persisted intent carries every coordinate except `parentEntry`, which
    // the actor service stamps at observation time from the parent's frame. This
    // is a fresh frame, so entry 1 — the same value `inferFrameEntryFromState`
    // derives for it.
    const intent = { ...(persisted as Omit<InlineLaunchIntent, 'parentEntry'>), parentEntry: 1 };
    return {
      manager,
      actorService,
      authority,
      parentRunId,
      childRunId: assertRunId(intent.childRunId),
      steps,
      intent,
      parentLinkage: inlineLinkageFromIntent(intent),
    };
  }

  /**
   * Call the latch for a seeded parent, optionally through a second connection.
   *
   * The intent is the only thing that names the launch — the latch derives the
   * parent run, the child run id and the linkage from it — so an `intent`
   * override moves every coordinate that travels with it and a divergence case
   * cannot leave one behind.
   *
   * @param parent - The seeded parent and its intent.
   * @param options - Overrides for this call.
   * @param options.intent - Intent to observe instead of the seeded one.
   * @param options.manager - State manager owning the compare-and-swap cycle.
   * @param options.actorService - Actor service deriving `INLINE_CHILD_STARTED`.
   * @returns The latch outcome.
   */
  function latch(
    parent: LatchableParent,
    options?: {
      intent?: InlineLaunchIntent;
      manager?: RunbookStateManager;
      actorService?: RunbookActorService;
    },
  ): Promise<InlineLaunchLatch> {
    return latchInlineLaunch({
      manager: options?.manager ?? parent.manager,
      actorService: options?.actorService ?? parent.actorService,
      authority: parent.authority,
      steps: parent.steps,
      intent: options?.intent ?? parent.intent,
    });
  }

  /**
   * Replace the intent stored inside the parent's opaque machine snapshot.
   *
   * Written raw because there is no machine event that produces a malformed
   * intent — the shapes below model a snapshot this code did not write, which is
   * exactly what the guard exists to refuse.
   *
   * @param parent - The seeded parent whose snapshot is being rewritten.
   * @param plant - Derives the replacement from the intent the machine stored.
   * @returns Resolves once the rewritten row is persisted.
   */
  async function plantPersistedIntent(
    parent: LatchableParent,
    plant: (intent: Record<string, unknown>) => unknown,
  ): Promise<void> {
    await patchPersistedRunState(cwd, parent.parentRunId, (current) => {
      const snapshot = current.snapshot as {
        readonly context: Record<string, unknown>;
      };
      return {
        ...current,
        snapshot: {
          ...snapshot,
          context: {
            ...snapshot.context,
            inlineLaunchIntent: plant(
              snapshot.context.inlineLaunchIntent as Record<string, unknown>,
            ),
          },
        },
      };
    });
  }

  /**
   * Read the latch record the latch writes onto a seeded parent's substep row.
   *
   * @param parent - The seeded parent whose row carries the latch.
   * @returns The record, `null` when unlatched, or `undefined` when no row exists.
   */
  async function readLatch(parent: LatchableParent): Promise<InlineLaunchStart | null | undefined> {
    const state = await parent.manager.load(parent.parentRunId);
    return state?.substepStates?.find(
      (entry) =>
        entry.id === parent.intent.parentStepId && entry.frameKey === parent.intent.parentFrameKey,
    )?.inline?.started;
  }

  it('reports a missing parent as its own arm rather than a null beside the union', async () => {
    // `mutateStateReturning` never runs the callback for a run that does not
    // exist, so this is the one outcome the compare-and-swap does not decide.
    // It is still an answer to "may this launch proceed", so it travels on the
    // same union — a caller narrowing the union cannot skip it.
    const parent = await seedLatchableParent();
    await parent.manager.delete(parent.parentRunId);

    await expect(latch(parent)).resolves.toEqual({ kind: 'missing' });
  });

  it.each(['completed', 'stopped'] as const)(
    'refuses a parent that reached %s as inactive, writing nothing',
    async (lifecycle) => {
      const parent = await seedLatchableParent();
      await parent.manager.update(parent.parentRunId, { lifecycle });

      await expect(latch(parent)).resolves.toEqual({ kind: 'inactive' });
      // Refused ahead of the write. A spurious stamp would make every later
      // re-entry of this frame report a launch that never happened, because the
      // machine's own `inlineLaunchIntentActor` carries `started` forward.
      expect(await readLatch(parent)).toBeNull();
    },
  );

  it('stands down as superseded once the intent no longer names this launch', async () => {
    const parent = await seedLatchableParent();
    // Exactly what `INLINE_LAUNCH_CONSUMED` leaves behind: the winner of this
    // launch consumed the intent, so this observer's observation is stale.
    await commitRunProgressionEvent(
      parent.authority,
      parent.manager,
      parent.actorService,
      parent.steps,
      { type: 'INLINE_LAUNCH_CONSUMED' },
    );

    await expect(latch(parent)).resolves.toEqual({ kind: 'superseded' });
    expect(await readLatch(parent)).toBeNull();
  });

  // Every coordinate the persisted intent is compared on, one case each. The
  // comparison is what makes "superseded" mean *this* launch rather than "some
  // intent is present": drop any one of these and an observer acting on a stale
  // observation latches the launch a DIFFERENT intent now names, writing a start
  // for a child nobody asked for. Divergence is applied to the observed intent
  // rather than the persisted one, because that is the direction the staleness
  // actually runs — the row moves on and the observation does not.
  it.each<{
    readonly name: string;
    readonly diverge: (intent: InlineLaunchIntent) => InlineLaunchIntent;
  }>([
    { name: 'parent substep id', diverge: (intent) => ({ ...intent, parentStepId: '9' }) },
    { name: 'parent step', diverge: (intent) => ({ ...intent, parentStep: '9' }) },
    {
      name: 'parent frame key',
      diverge: (intent) => ({ ...intent, parentFrameKey: '9|' }),
    },
    { name: 'child run id', diverge: (intent) => ({ ...intent, childRunId: generateRunId() }) },
    {
      name: 'child runbook path',
      diverge: (intent) => ({ ...intent, childRunbookPath: 'other.runbook.md' }),
    },
    {
      name: 'child runbook source',
      diverge: (intent) => ({
        ...intent,
        childRunbookRef: { ...intent.childRunbookRef, source: 'plugin' },
      }),
    },
    {
      name: 'child runbook ref path',
      diverge: (intent) => ({
        ...intent,
        childRunbookRef: { ...intent.childRunbookRef, path: 'other.runbook.md' },
      }),
    },
  ])(
    'stands down as superseded when the observed intent diverges in its $name',
    async ({ diverge }) => {
      const parent = await seedLatchableParent();

      await expect(latch(parent, { intent: diverge(parent.intent) })).resolves.toEqual({
        kind: 'superseded',
      });
      expect(await readLatch(parent)).toBeNull();
    },
  );

  // `parentRunId` is the one coordinate the table above cannot vary, and that is
  // the interface working rather than a gap: the latch derives the run it reads
  // FROM the intent, so an observed intent naming another parent selects that
  // parent, and the two can no longer be made to disagree. Its two reachable
  // states are pinned separately below.
  it('refuses an intent naming a run outside the verified authority', async () => {
    const parent = await seedLatchableParent();

    await expect(
      latch(parent, { intent: { ...parent.intent, parentRunId: generateRunId() } }),
    ).resolves.toEqual({ kind: 'superseded' });
    // The seeded parent is untouched: the latch never went near it.
    expect(await readLatch(parent)).toBeNull();
  });

  it('refuses a superseded claim authority without writing the launch latch', async () => {
    const parent = await seedLatchableParent();
    const rotated = await new SessionService(parent.manager).issueRunControlClaim(
      parent.parentRunId,
    );
    expect(rotated.kind).toBe('committed');

    await expect(latch(parent)).resolves.toEqual({ kind: 'superseded' });
    expect(await readLatch(parent)).toBeNull();
  });

  it('refuses a parent that carries no machine snapshot at all', async () => {
    // `RunbookState.snapshot` is optional: a run created but never initialised
    // has none. There is no intent to read, so the answer is `superseded` — the
    // same fail-closed answer an intent naming another launch gets, and not the
    // TypeError an unguarded read would throw out of the compare-and-swap.
    const parent = await seedLatchableParent();
    await patchPersistedRunState(cwd, parent.parentRunId, ({ snapshot: _drop, ...rest }) => rest);

    await expect(latch(parent)).resolves.toEqual({ kind: 'superseded' });
    expect(await readLatch(parent)).toBeNull();
  });

  it('stands down when the persisted intent names a different parent than the run holding it', async () => {
    // The remaining reachable divergence, and it can only be planted: a row whose
    // stored intent claims another parent is state this code did not write, and
    // the comparison is what stops the latch acting on it.
    const parent = await seedLatchableParent();
    await plantPersistedIntent(parent, (intent) => ({
      ...intent,
      parentRunId: generateRunId(),
    }));

    await expect(latch(parent)).resolves.toEqual({ kind: 'superseded' });
    expect(await readLatch(parent)).toBeNull();
  });

  // The shape guard beneath the coordinate comparison. `snapshot` is an opaque
  // blob, so the intent read out of it is `unknown` until this guard narrows it;
  // a missing or wrongly-typed field means the snapshot is not one this code
  // wrote, and the only safe reading of that is "no intent I recognise". Planted
  // raw for the same reason CLAUDE.md gives for refusing to migrate persisted
  // state: the recovery is a refusal, so the refusal is what must be pinned.
  it.each<{ readonly name: string; readonly plant: (intent: Record<string, unknown>) => unknown }>([
    { name: 'is not an object at all', plant: () => 'child.runbook.md' },
    { name: 'is null', plant: () => null },
    {
      name: 'has no parentRunId',
      plant: ({ parentRunId: _drop, ...rest }) => rest,
    },
    {
      name: 'has no parentStepId',
      plant: ({ parentStepId: _drop, ...rest }) => rest,
    },
    { name: 'has no parentStep', plant: ({ parentStep: _drop, ...rest }) => rest },
    {
      name: 'has no parentFrameKey',
      plant: ({ parentFrameKey: _drop, ...rest }) => rest,
    },
    { name: 'has no childRunId', plant: ({ childRunId: _drop, ...rest }) => rest },
    {
      name: 'has no childRunbookPath',
      plant: ({ childRunbookPath: _drop, ...rest }) => rest,
    },
    {
      name: 'carries a bare string runbook ref',
      plant: (intent) => ({ ...intent, childRunbookRef: 'child.runbook.md' }),
    },
    {
      name: 'carries a runbook ref with no source',
      plant: (intent) => ({
        ...intent,
        childRunbookRef: { path: 'child.runbook.md' },
      }),
    },
    {
      name: 'carries a runbook ref with no path',
      plant: (intent) => ({ ...intent, childRunbookRef: { source: 'project' } }),
    },
    {
      name: 'carries no context snapshot',
      plant: ({ contextSnapshot: _drop, ...rest }) => rest,
    },
  ])('refuses a persisted intent that $name', async ({ plant }) => {
    const parent = await seedLatchableParent();
    await plantPersistedIntent(parent, plant);

    await expect(latch(parent)).resolves.toEqual({ kind: 'superseded' });
    expect(await readLatch(parent)).toBeNull();
  });

  it.each<{
    readonly name: string;
    readonly linkage: (parent: LatchableParent) => ParentLinkage;
    readonly mismatch: Record<string, unknown>;
    /** Entry the observing intent claims; defaults to the seeded frame's own. */
    readonly observedEntry?: number;
  }>([
    {
      name: 'a child launched at a superseded frame entry',
      linkage: (parent) => ({ ...parent.parentLinkage, parentEntry: 2 }),
      mismatch: { kind: 'superseded-entry', recordedEntry: 2, currentEntry: 1 },
    },
    {
      // The mirror, and the only case that reads the entry off the OBSERVED
      // intent: the seeded frame is entry 1, so a linkage projection that
      // hardcoded the current entry would satisfy the case above and fail here.
      name: 'a child launched at the entry a re-entered frame has left behind',
      linkage: (parent) => parent.parentLinkage,
      observedEntry: 2,
      mismatch: { kind: 'superseded-entry', recordedEntry: 1, currentEntry: 2 },
    },
    {
      // A representable delegation under the intent's fixed child id — token
      // hash and all — rather than a shape the classifier merely fails to
      // recognise. Only that proves the refusal covers the child a
      // `rundown delegate` would have persisted here.
      name: 'a child linked by delegation rather than inline launch',
      linkage: (parent) => ({
        ...parent.parentLinkage,
        kind: 'delegation',
        // A hash the persisted-state schema accepts, so the child row this
        // refusal is read against is one a real `rundown delegate` could have
        // written. A malformed hash would be rejected at the store boundary and
        // the case would never reach the classifier.
        tokenHash: `sha256:${'d'.repeat(64)}` as DelegationTokenHash,
      }),
      mismatch: { kind: 'conflicting-parent' },
    },
  ])('refuses $name rather than latching over it', async ({ linkage, mismatch, observedEntry }) => {
    const parent = await seedLatchableParent();
    const { runbook } = parseRunbookDocument(CHILD_MARKDOWN, 'child.runbook.md');
    await parent.manager.create({ source: 'project', path: 'child.runbook.md' }, runbook, {
      runbookPath: 'child.runbook.md',
      runId: parent.childRunId,
      parentLinkage: linkage(parent),
      runbookSrc: CHILD_MARKDOWN,
      templateVars: { RunId: parent.childRunId, ContextId: 'ctx-child', WorkPath: WORK_PATH },
    });
    const intent =
      observedEntry === undefined ? undefined : { ...parent.intent, parentEntry: observedEntry };

    await expect(latch(parent, intent ? { intent } : undefined)).resolves.toEqual({
      kind: 'linkage-refused',
      mismatch,
    });
    // The stamp is still null, so an absent linkage check would have reached
    // `won` and written it. Its absence is what proves the refusal is decided
    // ahead of the write.
    expect(await readLatch(parent)).toBeNull();
  });

  describe('the scope the won arm hands back', () => {
    // What the disposer actually does, against a real store rather than the
    // shape assertions above. Everything here is the behaviour that used not to
    // exist: before the scope, a span that failed after latching left the record
    // set, held by a pid that is still running, and no later observation in any
    // process could get past it.
    it('releases the latch on scope exit, keeping the intent', async () => {
      const parent = await seedLatchableParent();
      const outcome = await latch(parent);
      if (outcome.kind !== 'won') throw new Error(`expected won, got ${outcome.kind}`);
      expect(await readLatch(parent)).not.toBeNull();

      await outcome.held[Symbol.asyncDispose]();

      expect(await readLatch(parent)).toBeNull();
      // The intent SURVIVES, which is what separates abandonment from
      // consumption. A released latch with no intent left would be a launch
      // nothing can re-observe — the opposite failure, equally terminal.
      const after = await parent.manager.load(parent.parentRunId);
      const context = (
        after?.snapshot as { readonly context?: Record<string, unknown> } | undefined
      )?.context;
      expect(context?.inlineLaunchIntent).toEqual(
        expect.objectContaining({ childRunId: parent.childRunId }),
      );
    });

    it('leaves the latch alone after keep()', async () => {
      const parent = await seedLatchableParent();
      const outcome = await latch(parent);
      if (outcome.kind !== 'won') throw new Error(`expected won, got ${outcome.kind}`);
      const latched = await readLatch(parent);

      outcome.held.keep();
      await outcome.held[Symbol.asyncDispose]();

      // Untouched, not merely still present: a span that consumed the intent has
      // already released the latch, and a disposer that fired anyway would send a
      // second release for a launch that is over.
      expect(await readLatch(parent)).toEqual(latched);
    });

    // The disposer is fire-and-forget, so it must not be able to release a latch
    // that is no longer this span's. It names the record it wrote and the
    // machine applies the release only while the row still holds that record —
    // the gate lives there rather than here precisely so it does not depend on
    // this caller's discipline.
    //
    // The reclaim is staged rather than raced: producing it for real needs the
    // previous owner to be provably DEAD, and a dead process runs no disposer,
    // so the sequence this pins is not one the CLI can reach today. What it
    // pins is that the release stays scoped to its own latch if a second sender
    // ever does — which is the difference between the exactly-once launch being
    // a property of the machine and a property of this file.
    it('leaves a latch another owner reclaimed alone on scope exit', async () => {
      const parent = await seedLatchableParent();
      const outcome = await latch(parent);
      if (outcome.kind !== 'won') throw new Error(`expected won, got ${outcome.kind}`);
      const reclaimed: InlineLaunchStart = {
        at: '2026-05-30T00:00:09.000Z',
        ownerPid: 7777,
        ownerStartId: 'start-id-7777',
      };
      // Exactly what a reclaiming observer commits: the same launch, at the same
      // coordinates, with the record overwritten by its own identity.
      const current = await parent.manager.load(parent.parentRunId);
      if (current === null) throw new Error('inline parent disappeared');
      const replaced = await parent.actorService.prepareActorMutation(
        parent.parentRunId,
        current,
        parent.steps,
        {
          type: 'INLINE_CHILD_STARTED',
          parentStepId: parent.intent.parentStepId,
          parentFrameKey: parent.intent.parentFrameKey as FrameKey,
          childRunId: parent.childRunId,
          started: reclaimed,
        },
      );
      const captured = await parent.manager.captureRunAuthorityState(parent.parentRunId);
      if (captured.kind !== 'captured') throw new Error(captured.message);
      const committed = await parent.manager.saveState(captured.authority, replaced.nextState);
      if (committed.kind !== 'committed') throw new Error(committed.message);

      await outcome.held[Symbol.asyncDispose]();

      // Untouched. Clearing it would hand a third observer an unlatched launch
      // while the reclaimer is still inside its span.
      expect(await readLatch(parent)).toEqual(reclaimed);
    });

    it('releases at most once across repeated disposal', async () => {
      const parent = await seedLatchableParent();
      const outcome = await latch(parent);
      if (outcome.kind !== 'won') throw new Error(`expected won, got ${outcome.kind}`);

      await outcome.held[Symbol.asyncDispose]();
      // The second disposal must be inert rather than merely harmless. It lands
      // on a row that has moved on, and the release event is scoped to the exact
      // launch the intent names, so a second send would be deciding against
      // state this scope no longer describes.
      await expect(outcome.held[Symbol.asyncDispose]()).resolves.toBeUndefined();
      expect(await readLatch(parent)).toBeNull();
    });
  });

  // The scope's own policy, tested at the seam that owns it rather than through
  // a store. Counting releases is the only way to state "at most once" — driven
  // through the latch above, a second release lands on an already-cleared row
  // and is indistinguishable from none.
  describe('heldInlineLatch', () => {
    it('releases once on scope exit', async () => {
      let releases = 0;
      const run = async (): Promise<string> => {
        await using _held = heldInlineLatch(
          async () => {
            releases += 1;
          },
          () => ({}),
        );
        return 'span-result';
      };

      await expect(run()).resolves.toBe('span-result');
      expect(releases).toBe(1);
    });

    it('releases at most once across repeated explicit disposal and a later keep', async () => {
      let releases = 0;
      const held = heldInlineLatch(
        async () => {
          releases += 1;
        },
        () => ({}),
      );

      await held[Symbol.asyncDispose]();
      await held[Symbol.asyncDispose]();
      held.keep();
      await held[Symbol.asyncDispose]();

      expect(releases).toBe(1);
    });

    it('does not release after keep()', async () => {
      let releases = 0;
      const held = heldInlineLatch(
        async () => {
          releases += 1;
        },
        () => ({}),
      );

      held.keep();
      await held[Symbol.asyncDispose]();

      expect(releases).toBe(0);
    });

    it('disposal is best-effort: a throwing release neither propagates nor masks the result', async () => {
      // The RD-102 policy `heldLock` owns for file locks, on the same terms: a
      // failed release leaves a latch the next observer reclaims once this
      // process exits, so letting it escape would replace the span's real
      // outcome — the launch error the operator needs — with a cleanup error.
      const run = async (): Promise<string> => {
        await using _held = heldInlineLatch(
          async () => {
            throw new Error('abandon send failed');
          },
          () => ({}),
        );
        return 'span-result';
      };

      await expect(run()).resolves.toBe('span-result');
    });
  });

  it('wins a free latch, recording this process as its owner at this run of the clock', async () => {
    const parent = await seedLatchableParent();

    const before = Date.now();
    const outcome = await latch(parent);
    const after = Date.now();

    // `reclaimedFrom: null` is the assertion that this took a FREE latch. The
    // arm that takes one over from a dead owner reports the same `kind`, and
    // only this field separates routine from recovery.
    expect(outcome).toEqual({
      kind: 'won',
      existingChild: null,
      reclaimedFrom: null,
      // The release scope, built by the arm that TOOK the latch rather than by
      // the caller: a `won` that could be received without a scope is a `won`
      // the caller can forget to release, which is the shape that left a failed
      // span holding the latch against its own live pid.
      held: { keep: expect.any(Function), [Symbol.asyncDispose]: expect.any(Function) },
    });
    const record = await readLatch(parent);
    // The one field of the record whose VALUE nothing else constrains: the type
    // requires a `string`, and the ownership classifier only reads the pid and
    // start id, so an empty or stale instant persists with exactly-once still
    // intact. Pinned as a full ISO instant AND as a reading of this run's clock
    // — a shape check alone accepts `new Date(0)`.
    expect(record?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(record!.at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(record!.at)).toBeLessThanOrEqual(after);
    // Recorded through the production recorder, so the start id is one THIS
    // host reads back — a hand-built record would be classified dead on a
    // mismatch the fixture invented, and the latch would be reclaimable the
    // moment it was written.
    expect(record?.ownerPid).toBe(process.pid);
    expect(record?.ownerStartId).toBe(recordInlineLaunchStart(record!.at).ownerStartId);
  });

  it('carries an adoptable existing child on the arm that wins', async () => {
    // The interrupted launch that created the child but never recorded the
    // start. The launch span branches on `existingChild`, so a `won` that
    // dropped it would create a run that already exists.
    const parent = await seedLatchableParent();
    const { runbook } = parseRunbookDocument(CHILD_MARKDOWN, 'child.runbook.md');
    await parent.manager.create({ source: 'project', path: 'child.runbook.md' }, runbook, {
      runbookPath: 'child.runbook.md',
      runId: parent.childRunId,
      parentLinkage: parent.parentLinkage,
      runbookSrc: CHILD_MARKDOWN,
      templateVars: { RunId: parent.childRunId, ContextId: 'ctx-child', WorkPath: WORK_PATH },
    });

    const outcome = await latch(parent);

    expect(outcome.kind).toBe('won');
    expect(outcome.kind === 'won' ? outcome.existingChild?.id : null).toBe(parent.childRunId);
  });

  it('stands down as already-latched while a live owner holds the launch', async () => {
    // A live owner is inside the launch span right now. Downstream of the latch
    // this is indistinguishable from `superseded` — both answer `waiting` — so
    // the discriminant, and the pid it names, are the whole assertion. The owner
    // here is this process, which is what makes it unambiguously alive.
    const parent = await seedLatchableParent();
    const won = await latch(parent);
    expect(won.kind).toBe('won');
    const held = await readLatch(parent);

    await expect(latch(parent)).resolves.toEqual({
      kind: 'already-latched',
      ownerPid: process.pid,
    });
    // Stood down without rewriting the record it found: overwriting it would
    // move the launch's ownership to an observer that is not performing it.
    expect(await readLatch(parent)).toEqual(held);
  });

  // The property the file lock had and the first cut of the latch dropped: a
  // crashed owner is taken over rather than stranding the launch forever. Driven
  // through a pid above every platform's pid_max (Linux 4194304, macOS 99998),
  // so `kill(pid, 0)` is always ESRCH — unlike a spawned-and-reaped pid, which
  // is only dead until the OS recycles it.
  describe('reclamation', () => {
    /** Plant a latch record on the seeded parent's own substep row. */
    async function plantLatch(parent: LatchableParent, started: InlineLaunchStart): Promise<void> {
      const rows = (await parent.manager.load(parent.parentRunId))?.substepStates ?? [];
      await parent.manager.update(parent.parentRunId, {
        substepStates: rows.map((row) =>
          row.inline ? { ...row, inline: { ...row.inline, started } } : row,
        ),
      });
    }

    it('takes over a latch whose owner is provably gone, and names who it took it from', async () => {
      const parent = await seedLatchableParent();
      await plantLatch(parent, {
        at: '2026-05-30T00:00:01.000Z',
        ownerPid: DEAD_PID,
        ownerStartId: null,
      });

      await expect(latch(parent)).resolves.toEqual({
        kind: 'won',
        existingChild: null,
        reclaimedFrom: DEAD_PID,
        held: { keep: expect.any(Function), [Symbol.asyncDispose]: expect.any(Function) },
      });
      // The reclaiming observer records ITSELF as the new owner. Leaving the
      // dead pid in place would let a third observer reclaim the launch this one
      // is now performing, mid-span.
      expect((await readLatch(parent))?.ownerPid).toBe(process.pid);
    });

    it('never reclaims a live owner, whatever the child looks like', async () => {
      // Absence of the child run is deliberately NOT the signal: an observer
      // that has latched and is still resolving the child runbook presents
      // exactly the state a crashed one leaves. Only liveness separates them.
      const parent = await seedLatchableParent();
      await plantLatch(parent, recordInlineLaunchStart('2026-05-30T00:00:01.000Z'));

      await expect(latch(parent)).resolves.toEqual({
        kind: 'already-latched',
        ownerPid: process.pid,
      });
    });
  });

  // Which ROW carries the latch. A parent accumulates a substep row per substep
  // per frame entry, and only one of them answers "has this launch started".
  // Each case below plants a stamped row that the selection must NOT accept, so
  // a selection that widened — matching any substep, any frame, or any child —
  // reports `already-latched` and strands the launch forever, since nothing
  // downstream ever re-examines it.
  it.each<{
    readonly name: string;
    readonly decoy: (
      parent: LatchableParent,
      inline: NonNullable<SubstepState['inline']>,
    ) => SubstepState;
  }>([
    {
      name: 'another substep of the same frame',
      decoy: (parent, inline) => ({
        id: '9',
        frameKey: parent.intent.parentFrameKey as FrameKey,
        status: 'running',
        inline,
      }),
    },
    {
      name: 'the same substep at another frame entry',
      decoy: (parent, inline) => ({
        id: parent.intent.parentStepId,
        frameKey: '9|' as FrameKey,
        status: 'running',
        inline,
      }),
    },
  ])('does not read the latch off a stamped row belonging to $name', async ({ decoy }) => {
    const parent = await seedLatchableParent();
    const rows = (await parent.manager.load(parent.parentRunId))?.substepStates ?? [];
    const own = rows.find(
      (row) =>
        row.id === parent.intent.parentStepId && row.frameKey === parent.intent.parentFrameKey,
    );
    expect(own?.inline?.started).toBeNull();
    // Ordered ahead of the launch's own row, so a widened selection lands on the
    // decoy rather than merely tolerating it.
    await parent.manager.update(parent.parentRunId, {
      substepStates: [
        decoy(parent, {
          ...own!.inline!,
          started: recordInlineLaunchStart('2026-05-30T00:00:01.000Z'),
        }),
        ...rows,
      ],
    });

    await expect(latch(parent)).resolves.toEqual({
      kind: 'won',
      existingChild: null,
      reclaimedFrom: null,
      held: { keep: expect.any(Function), [Symbol.asyncDispose]: expect.any(Function) },
    });
  });

  // The two rows that hold no latch for THIS intent, and the reason they are
  // their own arm rather than a kind of `unlatched`: the latch is written onto
  // the substep row's `inline`, so a row with none makes the write a silent
  // no-op, and a row naming another child makes the machine throw out of the
  // compare-and-swap. Reporting `won` from either would enter the launch span
  // with nothing latched — and so would the next observer, which is the
  // duplicate `INSERT INTO runs` the latch exists to prevent.
  it.each<{
    readonly name: string;
    readonly reason: 'no-inline-metadata' | 'other-child';
    readonly rewrite: (row: SubstepState) => SubstepState;
  }>([
    {
      // Reachable through the machine: `upsertSubstepState` merges, so a
      // `pass`/`fail`/`goto` on the frame writes a row for this substep before
      // the launch intent's own `inline` is folded into it.
      name: 'carries no inline metadata',
      reason: 'no-inline-metadata',
      rewrite: ({ inline: _drop, ...row }) => row,
    },
    {
      // Planted, because `inlineLaunchIntentActor` derives the intent's
      // `childRunId` FROM this row and so cannot produce a disagreement. The arm
      // is defensive, and this pins that it stays fail-closed rather than
      // reaching the machine's untyped `Inline child run mismatch`.
      name: 'records a different inline child',
      reason: 'other-child',
      rewrite: (row) =>
        row.inline ? { ...row, inline: { ...row.inline, childRunId: generateRunId() } } : row,
    },
  ])('refuses as unrecorded when the substep row $name', async ({ reason, rewrite }) => {
    const parent = await seedLatchableParent();
    const rows = (await parent.manager.load(parent.parentRunId))?.substepStates ?? [];
    await parent.manager.update(parent.parentRunId, { substepStates: rows.map(rewrite) });

    await expect(latch(parent)).resolves.toEqual({ kind: 'unrecorded', reason });
  });

  // The contention this module was extracted to make testable. Two observers of
  // ONE intent, both holding a row read at the same version, against a real
  // SQLite store — the launch span opens with an unconditional `manager.create`
  // for the intent's FIXED child run id, so if both reach it the loser gets an
  // untyped SQLITE_CONSTRAINT throw rather than a typed refusal. The latch is
  // the only thing preventing that.
  describe('under contention', () => {
    it('admits exactly one of two observers holding the same version', async () => {
      const parent = await seedLatchableParent();
      // A second connection, so the two observers are as separate as two
      // processes are: distinct managers, distinct actor services, one store.
      const contender = new RunbookStateManager(cwd);
      const contenderActors = createCliRunbookActorService(contender);

      // Hold the first authority capture until the second has captured too, so
      // both derive against the same verified version and one guarded commit is
      // genuinely stale.
      let captures = 0;
      let releaseFirstReader: (() => void) | undefined;
      // Bounded, so a run in which the second observer never reaches its build
      // fails on `builds` below rather than hanging the first observer until
      // Jest's timeout with no diagnostic. The bound is a failure path only: the
      // successful interleave clears it at the rendezvous.
      let rendezvousTimer: ReturnType<typeof setTimeout> | undefined;
      const bothRead = new Promise<void>((resolve) => {
        releaseFirstReader = resolve;
        rendezvousTimer = setTimeout(resolve, 2000);
      });
      const releaseRendezvous = (): void => {
        clearTimeout(rendezvousTimer);
        releaseFirstReader?.();
      };
      const gateCapture = (manager: RunbookStateManager): void => {
        const real = manager.captureAuthorityState.bind(manager);
        manager.captureAuthorityState = async (...args) => {
          const captured = await real(...args);
          captures += 1;
          if (captures === 1) await bothRead;
          if (captures === 2) releaseRendezvous();
          return captured;
        };
      };
      gateCapture(parent.manager);
      gateCapture(contender);

      // Each winner performs the launch span's opening act, exactly as
      // `launchInlineChildFromIntent` does: one unconditional create for the
      // fixed child run id.
      const { runbook: childRunbook } = parseRunbookDocument(CHILD_MARKDOWN, 'child.runbook.md');
      const creates: RunId[] = [];
      const observe = async (seams: {
        manager: RunbookStateManager;
        actorService: RunbookActorService;
      }): Promise<InlineLaunchLatch> => {
        const outcome = await latch(parent, seams);
        if (outcome.kind === 'won' && outcome.existingChild === null) {
          creates.push(parent.childRunId);
          await seams.manager.create(
            { source: 'project', path: 'child.runbook.md' },
            childRunbook,
            {
              runbookPath: 'child.runbook.md',
              runId: parent.childRunId,
              parentLinkage: parent.parentLinkage,
              runbookSrc: CHILD_MARKDOWN,
              templateVars: {
                RunId: parent.childRunId,
                ContextId: 'ctx-child',
                WorkPath: WORK_PATH,
              },
            },
          );
        }
        return outcome;
      };

      let outcomes: InlineLaunchLatch[];
      try {
        outcomes = await Promise.all([
          observe(parent),
          observe({ manager: contender, actorService: contenderActors }),
        ]);
      } finally {
        // Never leave the bound pending: a rejected observer would otherwise
        // hold the worker open for the rest of the timeout.
        clearTimeout(rendezvousTimer);
      }

      expect(captures).toBeGreaterThanOrEqual(3);
      expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['already-latched', 'won']);
      // The loser re-derived against the committed row and found a LIVE owner —
      // this process, since both observers run in it — rather than reclaiming a
      // latch whose owner is mid-launch. That arm is the one that would restore
      // the duplicate create, so the pid it names is part of the assertion.
      const stoodDown = outcomes.find((outcome) => outcome.kind === 'already-latched');
      expect(stoodDown).toEqual({ kind: 'already-latched', ownerPid: process.pid });
      // The winner took a FREE latch, not one taken over from a dead owner.
      expect(outcomes.find((outcome) => outcome.kind === 'won')).toEqual({
        kind: 'won',
        existingChild: null,
        reclaimedFrom: null,
        held: { keep: expect.any(Function), [Symbol.asyncDispose]: expect.any(Function) },
      });
      // One entry into the launch span, so one `INSERT INTO runs` for the fixed
      // child id — the SQLITE_CONSTRAINT the latch exists to prevent never had a
      // second writer to race.
      expect(creates).toHaveLength(1);
      const child = await parent.manager.load(parent.childRunId);
      expect(child?.id).toBe(parent.childRunId);
      // Latched exactly once, by the observer that won.
      expect((await readLatch(parent))?.ownerPid).toBe(process.pid);
    });
  });
});
