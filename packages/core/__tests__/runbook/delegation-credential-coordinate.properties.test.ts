/**
 * Cross-path invariant for delegation credential coordinates.
 *
 * A credential coordinate is HMAC derivation input, so the *same* logical
 * delegation must receive the *same* coordinate whichever path issued it. Two
 * paths issue: the manual one (`createDelegation` called with a persisted
 * `RunbookState`) and the machine one (`delegationIssueActor` invoked from the
 * compiled machine). This suite pins them to each other rather than to a
 * literal, so neither can drift without the other.
 */
import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { createActor, waitFor } from 'xstate';

import { assertClaimLookupKey } from '../../src/runbook/claim-id.js';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import type {
  DelegationCredentialIssuer,
  DelegationCredentialLocation,
} from '../../src/runbook/delegation-credential.js';
import { createDelegation } from '../../src/runbook/delegation-service.js';
import {
  assertDelegationIssuanceNonce,
  hashDelegationToken,
} from '../../src/runbook/delegation-token.js';
import { inferFrameEntryFromState } from '../../src/runbook/frame-entry.js';
import { buildFrameKey, type FrameKey } from '../../src/runbook/targeting.js';
import type { ResolvedStep, RunbookState, Transitions } from '../../src/runbook/types.js';
import {
  brandFlattenedTemplateVarsForTest,
  brandRunIdForTest,
} from '../../src/testing/effective-vars.js';

const RUN_ID = brandRunIdForTest(`rd_${'c'.repeat(32)}`);
const ISSUER_CLAIM_KEY = assertClaimLookupKey(`rdclk_${'4'.repeat(32)}`);
const ISSUING_FRAME: FrameKey = buildFrameKey('2');
const OTHER_FRAME: FrameKey = buildFrameKey('1');
const DELEGATED_STEP_ID = '2.1';

const CONTINUE_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};
const DEFER_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
};

/**
 * One plain step followed by a delegating parent.
 *
 * The leading step exists so the machine can be snapshotted *before* it enters
 * the delegating frame; issuance must read the seeded bootstrap mirror rather
 * than whatever a freshly started actor happened to hold.
 */
const STEPS: readonly ResolvedStep[] = [
  { kind: 'base', name: '1', description: 'Plain first step', transitions: CONTINUE_TRANSITIONS },
  {
    kind: 'substeps',
    name: '2',
    description: 'Delegating parent',
    transitions: CONTINUE_TRANSITIONS,
    aggregation: { strategy: 'ALL' },
    substeps: [
      {
        id: '1',
        description: 'Delegated substep',
        transitions: DEFER_TRANSITIONS,
        runbooks: ['child.runbook.md'],
        delegate: true,
      },
    ],
  },
];

/** As {@link STEPS}, but the parent's FAIL carries a retry budget so `runRetryHook` re-issues. */
const RETRY_STEPS: readonly ResolvedStep[] = [
  { kind: 'base', name: '1', description: 'Plain first step', transitions: CONTINUE_TRANSITIONS },
  {
    kind: 'substeps',
    name: '2',
    description: 'Delegating parent',
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 1, action: { type: 'STOP' } },
    },
    aggregation: { strategy: 'ALL' },
    substeps: [
      {
        id: '1',
        description: 'Delegated substep',
        transitions: DEFER_TRANSITIONS,
        runbooks: ['child.runbook.md'],
        delegate: true,
      },
    ],
  },
];

/**
 * Drive a real actor to issuance and return the credential beside the
 * coordinates the machine itself ends up holding.
 *
 * Fresh path: PASS into the delegating frame, where `delegationIssueActor`
 * mints. Retry path: PASS then FAIL, so ALL aggregation fails and
 * `runRetryHook` re-issues a superseding credential. Because the machine is the
 * single writer, `context.frameEntry` after the transition is exactly what
 * `deriveActorStatePatch` commits — so it stands in for committed state here.
 *
 * @param startEntry - Entry the issuing frame starts on.
 * @param viaRetry - Whether to take the `runRetryHook` re-issuance path.
 * @returns The last issued location and the machine's settled coordinates.
 * @throws {Error} When no credential was issued.
 */
async function issueThroughMachine(
  startEntry: number,
  viaRetry: boolean,
): Promise<{
  location: DelegationCredentialLocation;
  committed: { activeFrameKey?: FrameKey; activeEntry?: number };
}> {
  const captured: DelegationCredentialLocation[] = [];
  const machine = compileRunbookToMachine(viaRetry ? RETRY_STEPS : STEPS, {
    templateVars: brandFlattenedTemplateVarsForTest({ RunId: RUN_ID }),
    resolveDelegationRunbook: async (runbookRef) => ({
      path: `/resolved/${runbookRef}`,
      runbookRef,
      childRunbookRef: { source: 'project' as const, path: `/canonical/${runbookRef}` },
    }),
    issueDelegationCredential: recordingIssuer(captured),
    frameEntry: {
      activeFrameKey: OTHER_FRAME,
      activeEntry: startEntry,
      frameEntryCounts: { [OTHER_FRAME]: startEntry },
    },
  });

  const actor = createActor(machine);
  actor.start();
  actor.send({ type: 'PASS' });
  await waitFor(actor, (snapshot) =>
    (snapshot.context.substepStates ?? []).some((ss) => ss.delegation !== undefined),
  );
  if (viaRetry) {
    actor.send({ type: 'FAIL' });
    await waitFor(actor, (snapshot) => captured.length > 1 || snapshot.status !== 'active');
  }
  const committed = actor.getSnapshot().context.frameEntry ?? {};
  actor.stop();

  // Without this the retry arm could silently degrade to a second run of the
  // fresh path and the property would still pass.
  if (viaRetry && captured.length < 2) {
    throw new Error(`retry path did not re-issue: captured ${String(captured.length)}`);
  }
  const location = captured.at(-1);
  if (!location) throw new Error('no credential was issued');
  return { location, committed };
}

/** Frame-entry coordinates a persisted run state can present. */
interface FrameEntryFixture {
  readonly activeFrameKey: FrameKey;
  readonly activeEntry: number;
  readonly frameEntryCounts: Readonly<Record<FrameKey, number>>;
}

/**
 * Build an issuer that records the coordinate it was handed.
 *
 * @param captured - Sink the issuer appends each observed location to.
 * @returns An issuer producing a fixed, deterministic credential.
 */
function recordingIssuer(captured: DelegationCredentialLocation[]): DelegationCredentialIssuer {
  return (location) => {
    captured.push(location);
    const token = `rdtk_${'A'.repeat(32)}`;
    return {
      token,
      tokenHash: hashDelegationToken(token),
      credential: {
        version: 1,
        issuerClaimKey: ISSUER_CLAIM_KEY,
        issuanceNonce: assertDelegationIssuanceNonce('A'.repeat(43)),
        ...location,
      },
    };
  };
}

/**
 * Issue through the compiled machine and return the coordinate it derived.
 *
 * @param frameEntry - Persisted frame-entry coordinates mirrored into context.
 * @returns The single location the machine handed to the issuer.
 */
async function machineLocation(
  frameEntry: FrameEntryFixture,
): Promise<DelegationCredentialLocation | undefined> {
  const captured: DelegationCredentialLocation[] = [];
  const machine = compileRunbookToMachine(STEPS, {
    templateVars: brandFlattenedTemplateVarsForTest({ RunId: RUN_ID }),
    resolveDelegationRunbook: async (runbookRef) => ({
      path: `/resolved/${runbookRef}`,
      runbookRef,
      childRunbookRef: { source: 'project' as const, path: `/canonical/${runbookRef}` },
    }),
    issueDelegationCredential: recordingIssuer(captured),
  });

  const bootstrap = createActor(machine);
  bootstrap.start();
  const baseSnapshot = bootstrap.getSnapshot();
  bootstrap.stop();

  const seeded = { ...baseSnapshot, context: { ...baseSnapshot.context, frameEntry } };
  const actor = createActor(machine, { snapshot: seeded });
  actor.start();
  actor.send({ type: 'PASS' });
  await waitFor(actor, (snapshot) =>
    (snapshot.context.substepStates ?? []).some((ss) => ss.delegation !== undefined),
  );
  actor.stop();
  return captured[0];
}

/**
 * Issue through `createDelegation` and return the coordinate it derived.
 *
 * @param frameEntry - Persisted frame-entry coordinates on the parent state.
 * @returns The single location the manual path handed to the issuer.
 */
function manualLocation(frameEntry: FrameEntryFixture): DelegationCredentialLocation | undefined {
  const captured: DelegationCredentialLocation[] = [];
  const state = {
    id: RUN_ID,
    step: '2',
    substepStates: [{ id: '1', frameKey: ISSUING_FRAME, status: 'pending' as const }],
    ...frameEntry,
  } satisfies Pick<
    RunbookState,
    'id' | 'step' | 'substepStates' | 'activeFrameKey' | 'activeEntry' | 'frameEntryCounts'
  >;

  const result = createDelegation(
    {
      state,
      stepId: DELEGATED_STEP_ID,
      childRunbookPath: '/resolved/child.runbook.md',
      childRunbookRef: { source: 'project', path: '/canonical/child.runbook.md' },
      frameKey: ISSUING_FRAME,
      issueCredential: recordingIssuer(captured),
    },
    STEPS,
  );
  if (result.status !== 'created') {
    throw new Error(`Manual delegation fixture did not create: ${result.status}`);
  }
  return captured[0];
}

describe('delegation credential coordinate: manual and machine issuance agree', () => {
  const frameEntryArb = fc
    .record({
      onIssuingFrame: fc.boolean(),
      activeEntry: fc.integer({ min: 1, max: 9 }),
      issuingFrameCount: fc.integer({ min: 1, max: 9 }),
      otherFrameCount: fc.integer({ min: 1, max: 9 }),
      recordIssuingFrame: fc.boolean(),
    })
    .map(
      (raw): FrameEntryFixture => ({
        activeFrameKey: raw.onIssuingFrame ? ISSUING_FRAME : OTHER_FRAME,
        activeEntry: raw.activeEntry,
        frameEntryCounts: {
          [OTHER_FRAME]: raw.otherFrameCount,
          ...(raw.recordIssuingFrame ? { [ISSUING_FRAME]: raw.issuingFrameCount } : {}),
        },
      }),
    );

  it('derives the same credential coordinate from the same persisted state', async () => {
    await fc.assert(
      fc.asyncProperty(frameEntryArb, async (frameEntry) => {
        // The two paths issue at different points in a frame's life, so "the
        // same persisted state" means the same COMMITTED state, not the same
        // pre-transition mirror.
        //
        // Machine issuance runs inside the transition that enters the issuing
        // frame: `syncFrameEntry` advances first, `delegationIssueActor` reads
        // the advanced value, and `deriveActorStatePatch` commits it. Manual
        // issuance runs against a run already parked in the frame, so its input
        // is that committed value. Feeding the manual path the advanced
        // coordinates is what puts both on the same footing; handing it the
        // pre-entry mirror would compare the entry before a frame switch
        // against the entry after one.
        //
        // The advance is spelled out here rather than delegated to
        // `advanceFrameEntry`, which is the very function the machine side runs.
        // Calling it would move both sides of the comparison together, so no
        // defect in the bump rule could ever make this property fail. The rule
        // it encodes, for a non-re-entering entry into `ISSUING_FRAME`:
        //   already on the frame -> the entry carries through unchanged
        //   entering it          -> one past the greater of the frame's
        //                           recorded count and the current entry
        // and the frame's recorded count is raised to the result, never lowered.
        const knownIssuing = frameEntry.frameEntryCounts[ISSUING_FRAME] ?? 0;
        const expectedEntry =
          frameEntry.activeFrameKey === ISSUING_FRAME
            ? frameEntry.activeEntry
            : Math.max(knownIssuing, frameEntry.activeEntry) + 1;
        const committed: FrameEntryFixture = {
          activeFrameKey: ISSUING_FRAME,
          activeEntry: expectedEntry,
          frameEntryCounts: {
            ...frameEntry.frameEntryCounts,
            [ISSUING_FRAME]: Math.max(knownIssuing, expectedEntry),
          },
        };
        const fromMachine = await machineLocation(frameEntry);
        const fromManual = manualLocation(committed);

        expect(fromMachine).toBeDefined();
        expect(fromManual).toBeDefined();
        expect(fromMachine).toEqual(fromManual);
      }),
      { numRuns: 20 },
    );
  });

  it('property: a machine-stamped parentEntry equals the entry committed state reports', async () => {
    // The invariant #681's `unobservedReplacement` predicate rests on, across
    // BOTH machine-owned issuance paths. A lag on either would make its fourth
    // conjunct false for exactly the credentials the contract exists to judge.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }), // starting entry for the issuing frame
        fc.boolean(), // fresh issuance vs runRetryHook re-issuance
        async (startEntry, viaRetry) => {
          const { location, committed } = await issueThroughMachine(startEntry, viaRetry);
          expect(location.parentEntry).toBe(
            inferFrameEntryFromState(committed, location.parentFrameKey),
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});
