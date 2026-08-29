import { describe, expect, it } from '@jest/globals';
import { createActor, waitFor } from 'xstate';

import { compileRunbookToMachine, PENDING_MACHINE_EFFECT_TAG } from '../../src/runbook/compiler.js';
import type { RunbookContext } from '../../src/runbook/compiler.js';
import type { ResolveInlineRunbook } from '../../src/runbook/actors/inline-launch-intent-actor.js';
import { assertRunId, type RunId } from '../../src/runbook/run-id.js';
import type { InlineLaunchStart } from '../../src/runbook/types.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { brandFlattenedTemplateVarsForTest } from '../../src/testing/effective-vars.js';
import { makeDelegationCredentialIssuer } from '../../src/testing/delegation-fixtures.js';
import { createRunbook } from './fixtures.js';

// ACCEPTED MUTATION SURVIVORS for the latch actions in compiler.ts.
//
// A scoped run over `releaseInlineLaunchLatch` reports two survivors — the
// `assign({...})` object literal and the assigner arrow — while the machine
// transition that dispatches it (`INLINE_LAUNCH_ABANDONED: { actions: ... }`)
// has both of its mutants killed. That split is a Stryker limitation, not a
// coverage gap: `baseRunbookSetup = setup({ actions: { ... } })` is evaluated at
// MODULE LOAD, so the mutant switch inside each action definition runs once, on
// first import, before Stryker activates a mutant for any test. The behaviour is
// covered — applying `assign({})` by hand fails the abandonment test below.
//
// It is also pre-existing rather than new: the identical pair is reported for
// `clearInlineLaunchIntent`, the sibling action this one mirrors, which has had
// a dedicated behavioural test for as long as it has existed. Both were verified
// with:
//
//   STRYKER_SCOPED=true STRYKER_CONCURRENCY=1 pnpm --filter @rundown-org/core \
//     exec stryker run --mutate src/runbook/compiler.ts:<action-lines> \
//     --testFiles __tests__/runbook/inline-launch-compiler.test.ts --force
//
// The ownership gate adds two more, both `OptionalChaining` on the row lookup in
// `releaseInlineLatchHeldBy` (`?.inline?.started`). Each needs a state where an
// intent is persisted and the substep row it names either does not exist or
// carries no `inline` — which the machine cannot produce, because one transition
// writes both. Same unreachable-by-construction class the CLI latch suite
// records for the identical shape in `classifyParentInlineLatch`. The guard one
// line above them IS killed, by the consumed-intent case below: an absent intent
// is reachable, so it is tested rather than accepted.

type InlineLaunchCompilerOptions = NonNullable<Parameters<typeof compileRunbookToMachine>[1]> & {
  readonly resolveInlineRunbook: ResolveInlineRunbook;
  readonly generateChildRunId: () => RunId;
  readonly now: () => string;
};

/**
 * The latch an inline launcher commits: the instant and the owning process.
 *
 * One value rather than two fields, because a start with no owner cannot be
 * checked for liveness — which is the whole basis on which a later observer
 * decides whether the launch may be taken over.
 */
const LATCHED = {
  at: '2026-05-30T00:00:01.000Z',
  ownerPid: 4242,
  ownerStartId: 'start-id-4242',
} as const;

/**
 * The latch a SECOND owner wrote over the first one's, by reclamation.
 *
 * The abandonment release names the record it wrote, and the row must still
 * carry that record for the release to apply. This is the value that makes the
 * difference observable: a release naming {@link LATCHED} that lands on a row
 * holding this one is a stale sender undoing a live owner's reclamation.
 */
const RECLAIMED_BY_ANOTHER_OWNER = {
  at: '2026-05-30T00:00:09.000Z',
  ownerPid: 7777,
  ownerStartId: 'start-id-7777',
} as const;

/**
 * The same pid, restarted — a recycled pid is a DIFFERENT owner.
 *
 * Pinned separately from {@link RECLAIMED_BY_ANOTHER_OWNER} because a release
 * that compared pids alone would treat this as its own latch, which is the
 * exact confusion `ownerStartId` exists to prevent everywhere else in the latch
 * (see `runbook/process-identity`).
 */
const RECLAIMED_AFTER_PID_REUSE = {
  at: '2026-05-30T00:00:09.000Z',
  ownerPid: LATCHED.ownerPid,
  ownerStartId: 'start-id-4242-restarted',
} as const;

function childResolver(): ResolveInlineRunbook {
  return async (runbookRef) => ({
    path: 'runbooks/child.runbook.md',
    runbookRef,
    childRunbookRef: { source: 'project', path: 'runbooks/child.runbook.md' },
  });
}

describe('inline launch compiler integration', () => {
  it('prepares inline launch intent for non-DELEGATE runbook-list substeps', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    expect(steps[0]).toMatchObject({
      kind: 'substeps',
      substeps: [expect.objectContaining({ description: 'Runbook: child.runbook.md' })],
    });
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const options: InlineLaunchCompilerOptions = {
      templateVars: brandFlattenedTemplateVarsForTest({
        RunId: 'rd_cccccccccccccccccccccccccccccccc',
      }),
      resolveInlineRunbook: childResolver(),
      generateChildRunId: () => childRunId,
      now: () => '2026-05-30T00:00:00.000Z',
    };

    const actor = createActor(compileRunbookToMachine(steps, options));
    actor.start();

    const snapshot = await waitFor(
      actor,
      (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG),
      { timeout: 500 },
    );
    const context = snapshot.context as RunbookContext & {
      readonly inlineLaunchIntent?: unknown;
    };

    expect(context.inlineLaunchIntent).toMatchObject({
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      childRunId: 'rd_dddddddddddddddddddddddddddddddd',
      childRunbookPath: 'runbooks/child.runbook.md',
    });
    expect(context.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        frameKey: '1|',
        status: 'running',
        inline: expect.objectContaining({
          childRunId: 'rd_dddddddddddddddddddddddddddddddd',
        }),
      }),
    );

    actor.stop();
  });

  it('fails closed when an inline child runbook leaf has no resolver', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);

    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
      }),
    );
    actor.start();

    const snapshot = await waitFor(
      actor,
      (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG),
      { timeout: 500 },
    );

    expect(snapshot.context.lifecycle).toBe('stopped');
    expect(snapshot.context.lastAction).toMatchObject({
      type: 'INLINE_LAUNCH_FAILED',
      reason: 'inline_launch_failed',
      message: expect.stringContaining('Inline child runbook resolver is not configured'),
    });
    expect(snapshot.context.inlineLaunchIntent).toBeUndefined();

    actor.stop();
  });

  it('marks inline child start and keeps launch intent until consumed', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    actor.send({
      type: 'INLINE_CHILD_STARTED',
      parentStepId: '1',
      parentFrameKey: buildFrameKey('1'),
      childRunId,
      started: LATCHED,
    });

    const context = actor.getSnapshot().context;
    expect(context.inlineLaunchIntent).toMatchObject({
      parentStepId: '1',
      parentFrameKey: '1|',
      childRunId,
    });
    expect(context.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        frameKey: '1|',
        inline: expect.objectContaining({
          childRunId,
          started: LATCHED,
        }),
      }),
    );

    actor.send({ type: 'INLINE_LAUNCH_CONSUMED' });

    // Consuming the intent RELEASES the latch: it is held for the launch span
    // and no longer. Left in place, a completed launch would read as one still
    // in progress — a re-entry in the same process would find its own live pid
    // on it and stand down forever, and one in a later process would report
    // reclaiming a launch nobody crashed out of.
    const consumedContext = actor.getSnapshot().context;
    expect(consumedContext.inlineLaunchIntent).toBeUndefined();
    expect(consumedContext.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        frameKey: '1|',
        // Everything else about the launch survives — the child id is what a
        // later re-entry matches against, so releasing must not erase it.
        inline: expect.objectContaining({
          childRunId,
          started: null,
        }),
      }),
    );

    actor.stop();
  });

  // The failure counterpart of the event above, and the asymmetry is the whole
  // reason it is a separate event rather than a second caller of the same one.
  //
  // `INLINE_LAUNCH_CONSUMED` drops both the latch and the intent, because the
  // launch is over. A span that took the latch and then FAILED out of it must
  // drop only the latch: the launch is not over, and the surviving intent is
  // exactly what makes it re-observable. Clearing the intent here would trade a
  // permanently-latched launch for a permanently-lost one.
  it('releases the latch without clearing the intent when a launch span is abandoned', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    actor.send({
      type: 'INLINE_CHILD_STARTED',
      parentStepId: '1',
      parentFrameKey: buildFrameKey('1'),
      childRunId,
      started: LATCHED,
    });

    // Names the record this sender wrote. The action clears the latch only
    // while the row still holds that exact record, so the release cannot reach
    // a latch this sender does not own — see the reclamation tests below.
    actor.send({ type: 'INLINE_LAUNCH_ABANDONED', started: LATCHED });

    const abandoned = actor.getSnapshot().context;
    // The intent stays, still naming the same child, so the next observer reads
    // an unlatched launch it can win and finish.
    expect(abandoned.inlineLaunchIntent).toMatchObject({
      parentStepId: '1',
      parentFrameKey: '1|',
      childRunId,
    });
    expect(abandoned.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        frameKey: '1|',
        inline: expect.objectContaining({ childRunId, started: null }),
      }),
    );

    actor.stop();
  });

  // Root-level and idempotent, like every other latch event: the CLI releases
  // through a scope disposer, and a disposer that fires against a launch which
  // has already been consumed — or abandoned twice by a retried send — must not
  // corrupt the row it lands on.
  it('is a no-op when the launch it abandons holds no latch', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    // Cloned rather than aliased. `before` would otherwise be the same object
    // the machine holds, so an action that mutated `substepStates` in place —
    // the regression an `assign` returning fresh rows exists to prevent — would
    // update both sides of the comparison and pass.
    const before = structuredClone(actor.getSnapshot().context);

    // Never latched, so there is nothing to release.
    actor.send({ type: 'INLINE_LAUNCH_ABANDONED', started: LATCHED });

    const after = actor.getSnapshot().context;
    expect(after.substepStates).toEqual(before.substepStates);
    expect(after.inlineLaunchIntent).toEqual(before.inlineLaunchIntent);

    actor.stop();
  });

  // The other half of idempotence, and the arm the `keep()` disarm exists to
  // avoid rather than to make safe: a disposer that fires after the launch was
  // CONSUMED lands on a machine with no intent at all. Inert is the requirement
  // — a release that dereferenced the absent intent would throw out of the
  // event, and the disposer swallows what it throws, so the failure would be a
  // silent one at the seam whose whole job is not to mask outcomes.
  it('is inert when the intent it abandons has already been consumed', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    actor.send({
      type: 'INLINE_CHILD_STARTED',
      parentStepId: '1',
      parentFrameKey: buildFrameKey('1'),
      childRunId,
      started: LATCHED,
    });
    // The launch finished: the latch and the intent go together.
    actor.send({ type: 'INLINE_LAUNCH_CONSUMED' });
    const consumed = structuredClone(actor.getSnapshot().context);
    expect(consumed.inlineLaunchIntent).toBeUndefined();

    actor.send({ type: 'INLINE_LAUNCH_ABANDONED', started: LATCHED });

    const after = actor.getSnapshot().context;
    expect(after.substepStates).toEqual(consumed.substepStates);
    expect(after.inlineLaunchIntent).toBeUndefined();

    actor.stop();
  });

  // The ownership gate, and the reason the event carries a payload at all.
  //
  // The CLI releases from a DISPOSER — a best-effort, fire-and-forget path that
  // runs after an arbitrary failure, which is the classic shape for a sender
  // that has fallen behind the state it is acting on. So the machine does not
  // take "release this launch" on trust and re-derive the target from context:
  // the sender names the record it wrote, and the release applies only while
  // the row still holds it.
  //
  // Reachability is not the argument for the gate, and the reclaim it models is
  // deliberately not one the CLI can produce today: a reclaimer must first prove
  // the previous owner DEAD, and a dead process runs no disposer. The gate is
  // what makes that a property of the machine rather than a property of the one
  // caller — the exactly-once launch stops depending on a CLI-side invariant
  // that nothing outside the CLI enforces, which is what any second sender
  // (MCP, plugin, a later recovery path) would otherwise have to rediscover.
  it.each<{ readonly name: string; readonly holder: InlineLaunchStart }>([
    { name: 'another owner reclaimed the launch', holder: RECLAIMED_BY_ANOTHER_OWNER },
    { name: 'the owner pid was recycled by a new process', holder: RECLAIMED_AFTER_PID_REUSE },
  ])('leaves the latch alone when $name', async ({ holder }) => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    // The row as the reclaimer left it: same child, same coordinates, a latch
    // that is not the abandoning sender's.
    actor.send({
      type: 'INLINE_CHILD_STARTED',
      parentStepId: '1',
      parentFrameKey: buildFrameKey('1'),
      childRunId,
      started: holder,
    });

    // A stale sender releasing the launch it once held.
    actor.send({ type: 'INLINE_LAUNCH_ABANDONED', started: LATCHED });

    // Untouched. Clearing here would hand a third observer an `unlatched`
    // launch while the reclaimer is still inside its span, and two processes
    // would enter one launch — the duplicate `INSERT INTO runs` the latch
    // exists to prevent.
    expect(actor.getSnapshot().context.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        frameKey: '1|',
        inline: expect.objectContaining({ childRunId, started: holder }),
      }),
    );

    actor.stop();
  });

  // The release is scoped to the launch the consumed intent names, not to
  // "whatever inline row is at that coordinate". A row that has moved on to a
  // different child belongs to a different launch, whose latch is not this
  // event's to clear.
  it('returns the same substep rows when the launch was never latched', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    // No INLINE_CHILD_STARTED: the intent is prepared and its row carries the
    // inline metadata, with `started` still null.
    const beforeConsume = actor.getSnapshot().context.substepStates;
    expect(beforeConsume?.[0]?.inline?.started).toBeNull();

    actor.send({ type: 'INLINE_LAUNCH_CONSUMED' });

    expect(actor.getSnapshot().context.substepStates).toBe(beforeConsume);

    actor.stop();
  });

  it('leaves state unchanged when inline child start has no substep states', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Local
- PASS CONTINUE
- FAIL STOP
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(compileRunbookToMachine(steps));
    actor.start();
    const before = actor.getSnapshot().context;

    actor.send({
      type: 'INLINE_CHILD_STARTED',
      parentStepId: '1',
      parentFrameKey: buildFrameKey('1'),
      childRunId,
      started: LATCHED,
    });

    const after = actor.getSnapshot().context;
    expect(after.substepStates).toBeUndefined();
    expect(after.inlineLaunchIntent).toBeUndefined();
    expect(after).toEqual(before);

    actor.stop();
  });

  it('leaves state unchanged when inline child start finds no inline metadata', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Local
- PASS CONTINUE
- FAIL STOP
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const substepStates = [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' as const }];
    const actor = createActor(
      compileRunbookToMachine(steps, {
        substepStates,
      }),
    );
    actor.start();

    actor.send({
      type: 'INLINE_CHILD_STARTED',
      parentStepId: '1',
      parentFrameKey: buildFrameKey('1'),
      childRunId,
      started: LATCHED,
    });

    const context = actor.getSnapshot().context;
    expect(context.substepStates).toEqual(substepStates);

    actor.stop();
  });

  it('rejects inline child start when target metadata belongs to another child run', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });

    const error = new Promise<unknown>((resolve) => {
      const subscription = actor.subscribe({
        error: (received) => {
          subscription.unsubscribe();
          resolve(received);
        },
      });
      actor.send({
        type: 'INLINE_CHILD_STARTED',
        parentStepId: '1',
        parentFrameKey: buildFrameKey('1'),
        childRunId: assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
        started: LATCHED,
      });
    });

    await expect(error).resolves.toMatchObject({
      message: 'Inline child run mismatch for 1',
    });

    actor.stop();
  });

  it('preserves inline launch intent when child start mismatches the stored child run', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`);
    const childRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
    const actor = createActor(
      compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_cccccccccccccccccccccccccccccccc',
        }),
        resolveInlineRunbook: childResolver(),
        generateChildRunId: () => childRunId,
        now: () => '2026-05-30T00:00:00.000Z',
      }),
    );
    actor.start();

    await waitFor(actor, (candidate) => !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG), {
      timeout: 500,
    });
    const before = actor.getSnapshot().context;

    const error = new Promise<unknown>((resolve) => {
      const subscription = actor.subscribe({
        error: (received) => {
          subscription.unsubscribe();
          resolve(received);
        },
      });
      actor.send({
        type: 'INLINE_CHILD_STARTED',
        parentStepId: '1',
        parentFrameKey: buildFrameKey('1'),
        childRunId: assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
        started: LATCHED,
      });
    });

    await expect(error).resolves.toMatchObject({
      message: 'Inline child run mismatch for 1',
    });

    const after = actor.getSnapshot().context;
    expect(after.inlineLaunchIntent).toEqual(before.inlineLaunchIntent);
    expect(after.substepStates).toEqual(before.substepStates);

    actor.stop();
  });

  it('keeps DELEGATE runbook-list substeps on the delegation frontier path', async () => {
    const steps = createRunbook(`# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
  - DELEGATE
`);
    const machine = compileRunbookToMachine(steps, {
      templateVars: brandFlattenedTemplateVarsForTest({
        RunId: 'rd_cccccccccccccccccccccccccccccccc',
      }),
      resolveDelegationRunbook: async (runbookRef) => ({
        path: 'runbooks/child.runbook.md',
        runbookRef,
        childRunbookRef: { source: 'project', path: 'runbooks/child.runbook.md' },
      }),
      issueDelegationCredential: makeDelegationCredentialIssuer(),
    });
    const actor = createActor(machine);
    actor.start();

    const snapshot = await waitFor(
      actor,
      (candidate) =>
        !candidate.hasTag(PENDING_MACHINE_EFFECT_TAG) &&
        candidate.context.delegateFrontier !== undefined,
      { timeout: 500 },
    );
    const context = snapshot.context as RunbookContext & {
      readonly inlineLaunchIntent?: unknown;
    };

    expect(context.delegateFrontier).toBeDefined();
    expect(context.inlineLaunchIntent).toBeUndefined();

    actor.stop();
  });
});
