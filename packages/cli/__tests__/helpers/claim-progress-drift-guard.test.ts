import { describe, expect, it } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_IDLE_AFTER_MS,
  claimActivity,
  claimKeyFromBearer,
  getErrorMessage,
  type ClaimId,
  type ClaimLookupKey,
  type RoleSpecificMutationCommand,
} from '@rundown-org/core';
import type { Command } from 'commander';
import {
  backdateClaimProgress,
  createRunbook,
  createTestWorkspace,
  findActionOutput,
  getActiveState,
  issueRunControlClaim,
  readSession,
  runCliInProcess,
  setupParentWithChildren,
  type TestWorkspace,
} from './test-utils.js';
// THE anchor. The real program factory the shipped binary uses — it registers
// every command, so this import is what makes the scan INDEPENDENT of this
// test's own knowledge. Never rebuild a program from register*Command here: a
// scan fed by the classification tables can never fail (see "Why this task
// exists"). There must be NO `register*Command` import in this file.
import { createProgram } from '../../src/cli.js';

/** Backdated mark every case rewinds to, then asserts against. */
const EPOCH = '2020-01-01T00:00:00.000Z';

/**
 * A workspace arranged so one command can reach a committed success.
 *
 * Carries the workspace ITSELF, not just the claim: the drivers have to run the
 * CLI, and `runCliInProcess` needs the workspace the arrangement just created.
 */
interface Arrangement {
  readonly workspace: TestWorkspace;
  /** Bearer the command under test presents. */
  readonly claimId: ClaimId;
  /** Lookup key for that same bearer — what `backdateClaimProgress`/`readSession` key on. */
  readonly claimKey: ClaimLookupKey;
  /**
   * Pending delegation token. Present ONLY for `abort`, which takes a token
   * argument rather than `--run`. This field is why the driver takes the whole
   * Arrangement: `driveClaimAbort` is unwritable without it.
   */
  readonly token?: string;
}

/** How one claim-authenticated command is arranged and driven to a committed success. */
interface RecordingCase {
  /** Stand up a fresh workspace and bearer. The caller owns cleanup. */
  readonly arrange: () => Promise<Arrangement>;
  /**
   * Drive this command to a SUCCESSFUL mutation with the arranged bearer.
   * Asserts its own exit code, so a silently-refused command cannot masquerade
   * as "recorded nothing".
   */
  readonly driveSuccess: (arranged: Arrangement) => Promise<void>;
}

/**
 * A claim-authenticated command that must NOT record, and how to drive it.
 *
 * `driveSuccess` is REQUIRED here for the same reason it is on RecordingCase, and
 * it matters more: a refused command records nothing and would pass the
 * non-recording assertion VACUOUSLY, leaving the guard green while pinning
 * nothing. Each driver asserts its own exit code is 0 first.
 */
interface NonRecordingCase {
  /** Why this command fails the workflow-state predicate. Surfaced on failure. */
  readonly reason: string;
  readonly arrange: () => Promise<Arrangement>;
  /** Drive this command to a SUCCESSFUL (exit 0) invocation with the bearer. */
  readonly driveSuccess: (arranged: Arrangement) => Promise<void>;
}

/** A plain claimed run: the arrangement for every command that just needs a live bearer. */
async function arrangeClaimedRun(): Promise<Arrangement> {
  const workspace = await createTestWorkspace();
  // Three steps: `goto 2` needs somewhere to go, and `pass` must not drive the run
  // terminal before `complete`/`stop` get their turn in their own arrangements.
  const runbook = createRunbook({
    title: 'Guarded',
    steps: [
      { title: 'One', pass: 'CONTINUE', fail: 'STOP', content: 'First.' },
      { title: 'Two', pass: 'CONTINUE', fail: 'STOP', content: 'Second.' },
      { title: 'Three', pass: 'COMPLETE', fail: 'STOP', content: 'Third.' },
    ],
  });
  await writeFile(join(workspace.cwd, 'guarded.runbook.md'), runbook);
  expect((await runCliInProcess('run --prompted guarded.runbook.md', workspace)).exitCode).toBe(0);

  const state = await getActiveState(workspace);
  expect(state).not.toBeNull();
  const claimId = await issueRunControlClaim(workspace, state!.id);
  return { workspace, claimId, claimKey: claimKeyFromBearer(claimId) };
}

/** Claim a pending delegation token and return the child's bearer. */
async function claimChild(workspace: TestWorkspace, token: string): Promise<ClaimId> {
  const claimed = await runCliInProcess(`claim ${token}`, workspace);
  expect(claimed.exitCode).toBe(0);
  return String(findActionOutput(claimed.stdout)!.claim_id) as ClaimId;
}

/** Parent + two children, both claimed and passed — a collectable frame. */
async function arrangeCollectedTrio(): Promise<
  Arrangement & { readonly childClaimKeys: readonly ClaimLookupKey[] }
> {
  const workspace = await createTestWorkspace();
  const { parentRunId, token1, token2 } = await setupParentWithChildren(workspace);

  // Claim + pass BOTH children so their outcomes are reported and `collect` reaches
  // `collection_applied` rather than refusing. `pass` on a claimed child drives it
  // terminal through a path that passes `retainClaimsAsTerminal: true`, so both
  // child records survive into the session the AC5 assertions read.
  const childClaimKeys: ClaimLookupKey[] = [];
  for (const token of [token1, token2]) {
    const childClaimId = await claimChild(workspace, token);
    expect((await runCliInProcess(['pass', '--claim-id', childClaimId], workspace)).exitCode).toBe(
      0,
    );
    childClaimKeys.push(claimKeyFromBearer(childClaimId));
  }

  const parentClaimId = await issueRunControlClaim(workspace, parentRunId);
  return {
    workspace,
    claimId: parentClaimId,
    claimKey: claimKeyFromBearer(parentClaimId),
    childClaimKeys,
  };
}

/** The collect case reads the trio under the generic Arrangement names. */
async function arrangeCollectableParent(): Promise<Arrangement> {
  return arrangeCollectedTrio();
}

/**
 * Parent + two claimed children, for abort. `--force` is required BECAUSE both are
 * claimed (abort.ts -> `needs_force`); the bystander needs a live claim record to
 * carry the "did not move" assertion, which is the only reason it is claimed.
 */
async function arrangeAbortableTrio(): Promise<{
  readonly workspace: TestWorkspace;
  readonly parentClaimId: ClaimId;
  readonly parentClaimKey: ClaimLookupKey;
  readonly abortedChildClaimKey: ClaimLookupKey;
  readonly bystanderChildClaimKey: ClaimLookupKey;
  readonly token: string;
}> {
  const workspace = await createTestWorkspace();
  const { parentRunId, token1, token2 } = await setupParentWithChildren(workspace);

  const abortedChildClaimKey = claimKeyFromBearer(await claimChild(workspace, token1));
  const bystanderChildClaimKey = claimKeyFromBearer(await claimChild(workspace, token2));

  const parentClaimId = await issueRunControlClaim(workspace, parentRunId);
  return {
    workspace,
    parentClaimId,
    parentClaimKey: claimKeyFromBearer(parentClaimId),
    abortedChildClaimKey,
    bystanderChildClaimKey,
    token: token1,
  };
}

/** The it.each abort case needs only the parent's bearer and the token. */
async function arrangeAbortableParent(): Promise<Arrangement> {
  const trio = await arrangeAbortableTrio();
  return {
    workspace: trio.workspace,
    claimId: trio.parentClaimId,
    claimKey: trio.parentClaimKey,
    token: trio.token,
  };
}

/**
 * A claimed DELEGATED CHILD — the only claim shape `pop` accepts.
 * `unstashForClaimId` returns `child-linkage-mismatch` when `!claim.delegation`,
 * so a run-control claim cannot drive `pop` to exit 0 and would fail
 * driveSuccess's own assertion.
 */
async function arrangeStashableChild(): Promise<Arrangement> {
  const workspace = await createTestWorkspace();
  const { token1 } = await setupParentWithChildren(workspace);
  const claimId = await claimChild(workspace, token1);
  return { workspace, claimId, claimKey: claimKeyFromBearer(claimId) };
}

/** Parent with an authored DELEGATE substep, plus the parent's bearer. */
async function arrangeDelegatableParent(): Promise<Arrangement> {
  const workspace = await createTestWorkspace();
  const { parentRunId } = await setupParentWithChildren(workspace);
  const claimId = await issueRunControlClaim(workspace, parentRunId);
  return { workspace, claimId, claimKey: claimKeyFromBearer(claimId) };
}

/** Assert one claim-authenticated invocation succeeds. */
async function expectOk(args: readonly string[], arranged: Arrangement): Promise<void> {
  const result = await runCliInProcess(
    [...args, '--claim-id', arranged.claimId],
    arranged.workspace,
  );
  expect(result.exitCode).toBe(0);
}

/**
 * Assert a claim-authenticated invocation that COMMITS and then exits non-zero.
 *
 * `fail` and `stop` drive the run terminal through a FAIL transition, and the CLI
 * maps a stopped runbook to exit 1 — that is the committed-success path for these
 * two, not a refusal. Exit code alone therefore cannot discriminate here (a
 * refusal is non-zero too), so this asserts the committed action block instead:
 * the refusal path throws an error envelope and emits no action at all. Without
 * this the case would be exactly the vacuous pass the drivers exist to prevent.
 *
 * @param args - Command and flags, minus `--claim-id`.
 * @param arranged - The arrangement supplying the workspace and bearer.
 */
async function expectCommittedStop(args: readonly string[], arranged: Arrangement): Promise<void> {
  const result = await runCliInProcess(
    [...args, '--claim-id', arranged.claimId],
    arranged.workspace,
  );
  expect(result.exitCode).toBe(1);
  const action = findActionOutput(result.stdout);
  expect(action).not.toBeNull();
  expect(action!.stopped).toBe(true);
}

const driveClaimPass = async (a: Arrangement): Promise<void> => expectOk(['pass'], a);
const driveClaimFail = async (a: Arrangement): Promise<void> => expectCommittedStop(['fail'], a);
const driveClaimComplete = async (a: Arrangement): Promise<void> => expectOk(['complete'], a);
const driveClaimStop = async (a: Arrangement): Promise<void> => expectCommittedStop(['stop'], a);
const driveClaimStatus = async (a: Arrangement): Promise<void> => expectOk(['status'], a);
const driveClaimStash = async (a: Arrangement): Promise<void> => expectOk(['stash'], a);
// `goto <step>` is a positional argument, not a flag. Step 2 exists because
// arrangeClaimedRun authors three steps.
const driveClaimGoto = async (a: Arrangement): Promise<void> => expectOk(['goto', '2'], a);
const driveClaimCollect = async (a: Arrangement): Promise<void> => expectOk(['collect'], a);
// `--retry` reaches the `retried` committed-success member. A bare `delegate` on an
// already-auto-issued substep returns `already-delegated`, which commits nothing and
// correctly records nothing — driving it would assert the opposite of the rule.
const driveClaimDelegate = async (a: Arrangement): Promise<void> =>
  expectOk(['delegate', '--step', '1.1', '--retry'], a);

/**
 * `pop` cannot exit 0 in isolation — `unstashForClaimId` requires
 * `session.stashedRunbookId === claim.controlledRunId`, so its driver owns the
 * stash→pop ordering. This is the concrete reason the non-recording table needs
 * per-command closures rather than one generic dispatcher. BOTH invocations are
 * asserted: a stash that silently refused would leave `pop` refusing too, and the
 * case would pass vacuously twice over.
 */
const driveClaimPop = async (a: Arrangement): Promise<void> => {
  await expectOk(['stash'], a);
  await expectOk(['pop'], a);
};

/**
 * `abort` takes the pending TOKEN as a positional argument — which is why
 * `Arrangement` carries `token` and why the driver takes the whole arrangement.
 * `--force` is required because the delegation is claimed.
 */
const driveClaimAbort = async (a: Arrangement): Promise<void> => {
  expect(a.token).toBeDefined();
  await expectOk(['abort', a.token!, '--force'], a);
};

/**
 * Commands that change runbook workflow state, and so record.
 *
 * Keyed by command name and cross-checked below against BOTH the real program's
 * --claim-id surface and core's RoleSpecificMutationCommand union. Deliberately
 * NOT typed `Record<RoleSpecificMutationCommand, …>`: that union is a
 * SUBPROCESS-TRUST concept ("commands whose only available trust is the bare
 * direct-CLI lane"), and its overlap with this set is a coincidence that is
 * already imperfect — `abort` records but is not a member. Binding them would
 * give one type two meanings and let the union drift this guard for reasons
 * unrelated to idle detection.
 */
const RECORDING_COMMANDS: Readonly<Record<string, RecordingCase>> = {
  pass: { arrange: arrangeClaimedRun, driveSuccess: driveClaimPass },
  fail: { arrange: arrangeClaimedRun, driveSuccess: driveClaimFail },
  complete: { arrange: arrangeClaimedRun, driveSuccess: driveClaimComplete },
  stop: { arrange: arrangeClaimedRun, driveSuccess: driveClaimStop },
  goto: { arrange: arrangeClaimedRun, driveSuccess: driveClaimGoto },
  delegate: { arrange: arrangeDelegatableParent, driveSuccess: driveClaimDelegate },
  collect: { arrange: arrangeCollectableParent, driveSuccess: driveClaimCollect },
  abort: { arrange: arrangeAbortableParent, driveSuccess: driveClaimAbort },
};

/**
 * Claim-authenticated commands that do NOT change runbook workflow state, and so
 * do NOT record. These are NOT exceptions to the rule — they fail its predicate.
 *
 * Listed rather than omitted, because a non-recording classification is a
 * DECISION the guard pins in BOTH directions: a future edit that starts recording
 * on one of these fails loudly, which matters because such an edit would quietly
 * reopen the anti-fooling hole and nothing else in the suite would notice.
 */
const NON_RECORDING_CLAIM_COMMANDS: Readonly<Record<string, NonRecordingCase>> = {
  status: {
    reason:
      'Changes nothing (read-only). A stuck child polling its own status must never refresh its own mark.',
    arrange: arrangeClaimedRun,
    driveSuccess: driveClaimStatus,
  },
  stash: {
    reason:
      'Changes session targeting only, not the run. IS a claim-authenticated mutation (stash.ts:19) — which is exactly why the predicate is "changes runbook workflow state", not "mutates". Recording it would let a child loop stash/pop to fake liveness without advancing anything.',
    arrange: arrangeStashableChild,
    driveSuccess: driveClaimStash,
  },
  pop: {
    reason:
      'Changes session targeting only, not the run. IS a claim-authenticated mutation (pop.ts:59); see stash. Corroboration: unstashForClaimId already moves updatedAt ("record written"), the field this design deliberately leaves alone.',
    arrange: arrangeStashableChild,
    driveSuccess: driveClaimPop,
  },
};

/**
 * Every command the REAL program exposes with --claim-id, found by walking
 * createProgram() recursively (subcommands included).
 */
function claimAuthenticatedCommandNames(): string[] {
  const names: string[] = [];
  const visit = (command: Command): void => {
    if (command.options.some((option) => option.long === '--claim-id')) {
      names.push(command.name());
    }
    for (const child of command.commands) visit(child);
  };
  visit(createProgram());
  return names.sort();
}

describe('claim progress recording drift guard (#519 AC4)', () => {
  // THE ANCHOR: every command the real program exposes with --claim-id must be
  // CLASSIFIED, in one direction or the other. Both failure modes are invisible
  // without this:
  //  - a new workflow-state command that records nothing => a claim reads idle
  //    while advancing, a spurious check nobody traces back to a missing line;
  //  - a new session-targeting command that DOES record => the anti-fooling hole
  //    reopens and the idle signal can be faked.
  // Set equality against the REAL program is what makes it fail closed in both
  // directions. Fed from these tables instead, it could never fail at all.
  it('classifies every command the real program registers with --claim-id', () => {
    const classified = [
      ...Object.keys(RECORDING_COMMANDS),
      ...Object.keys(NON_RECORDING_CLAIM_COMMANDS),
    ].sort();

    // If this fails with an EXTRA command, classify it: does it change runbook
    // workflow state (=> RECORDING_COMMANDS) or only session targeting / nothing
    // (=> NON_RECORDING_CLAIM_COMMANDS, WITH a reason)? Do NOT narrow the scan to
    // make this pass — the scan is the guarantee.
    expect(claimAuthenticatedCommandNames()).toEqual(classified);
  });

  // CROSS-CHECK (not the anchor): core's subprocess-trust union overlaps this set
  // by coincidence. If a member of it is unclassified here, that is worth a look —
  // but `abort` proves the two concepts are NOT the same, so the union is checked
  // for containment only, never for equality.
  it('classifies every RoleSpecificMutationCommand member somewhere', () => {
    // `Record<RoleSpecificMutationCommand, true>`, NOT `readonly
    // RoleSpecificMutationCommand[]`. An array type accepts ANY subset, so a new
    // union member would keep this green and the literal below would be asserting
    // a file against itself — the same tautology the anchor above exists to avoid,
    // reintroduced in the cross-check. As a Record, a new member is a COMPILE
    // ERROR here (missing property), which is the whole point of the cross-check:
    // it makes the union's growth visible to this file. It stays containment-only
    // at runtime because `abort` proves the two concepts are not the same set.
    const union: Record<RoleSpecificMutationCommand, true> = {
      pass: true,
      fail: true,
      delegate: true,
      goto: true,
      complete: true,
      stop: true,
      collect: true,
    };
    for (const name of Object.keys(union)) {
      expect(name in RECORDING_COMMANDS || name in NON_RECORDING_CLAIM_COMMANDS).toBe(true);
    }
  });

  it.each(
    Object.entries(RECORDING_COMMANDS),
  )('records claim progress on a successful %s', async (_name, { arrange, driveSuccess }) => {
    const arranged = await arrange();
    try {
      await backdateClaimProgress(arranged.workspace, arranged.claimKey, EPOCH);

      await driveSuccess(arranged);

      // The rule: EVERY successful claim-authenticated command that changes runbook
      // workflow state records. Including the claim-terminating ones (complete/stop/
      // abort), whose write is redundant but harmless and buys a predicate with no
      // exceptions to remember.
      const after = (await readSession(arranged.workspace)).claims[arranged.claimKey].lastSeenAt;
      expect(Date.parse(after)).toBeGreaterThan(Date.parse(EPOCH));
    } finally {
      // Each case owns a whole workspace, so each case must tear one down. The
      // suite has no `beforeEach`/`afterEach` pair to do it: the arrangements
      // differ per command, so the workspace cannot be built before the case
      // knows which one it is.
      await arranged.workspace.cleanup();
    }
  });

  it.each(
    Object.entries(NON_RECORDING_CLAIM_COMMANDS),
  )('does NOT record claim progress on %s', async (name, { reason, arrange, driveSuccess }) => {
    const arranged = await arrange();
    try {
      await backdateClaimProgress(arranged.workspace, arranged.claimKey, EPOCH);

      // Drives the command to a SUCCESSFUL invocation (exit 0) — a refusal would
      // record nothing for the wrong reason and pass this test vacuously.
      await driveSuccess(arranged);

      // The mark must not move. `reason` documents WHY at the failure site: a
      // reader who broke this needs the anti-fooling argument, not just a diff.
      //
      // Jest's `expect` takes ONE argument — `expect(actual, reason)` is Vitest
      // syntax and does not compile here, so the reason is carried by wrapping
      // the failure instead.
      const after = (await readSession(arranged.workspace)).claims[arranged.claimKey].lastSeenAt;
      try {
        expect(after).toBe(EPOCH);
      } catch (error) {
        throw new Error(
          `${name} moved lastSeenAt but must not record.\nWhy it must not: ${reason}\n\n${getErrorMessage(error)}`,
        );
      }
    } finally {
      await arranged.workspace.cleanup();
    }
  });

  it('collect records ONLY the presented orchestrator claim, never a child (AC5)', async () => {
    // THE DESIGN'S CANONICAL AC5 CASE — "a parent cannot vouch for a child's
    // liveness, and must not appear to" — and, like the abort case below, one the
    // it.each above structurally cannot express: `Arrangement` carries a single
    // claim, with no slot for "and these OTHER claims must not have moved".
    //
    // `collect` is where the wrong implementation looks RIGHT. The orchestrator's
    // seam already holds `listOpenClaimsForParent` (a CollectionSessionService
    // method, sitting right there), so "loop the open children and record them
    // all" is a natural line to write — and it passes the generic collect case
    // above, which only checks that the parent's own mark moved. Only this test
    // fails on it. A parent that refreshed its children would report every stuck
    // child as live: the exact false negative #519 exists to prevent, self-inflicted.
    const {
      workspace,
      claimId: parentClaimId,
      claimKey: parentClaimKey,
      childClaimKeys,
    } = await arrangeCollectedTrio();
    try {
      await backdateClaimProgress(workspace, parentClaimKey, EPOCH);
      for (const childKey of childClaimKeys) {
        await backdateClaimProgress(workspace, childKey, EPOCH);
      }

      expect(
        (await runCliInProcess(['collect', '--claim-id', parentClaimId], workspace)).exitCode,
      ).toBe(0);

      const session = await readSession(workspace);
      // The orchestrator presented its bearer and advanced its own run: mark moves.
      expect(Date.parse(session.claims[parentClaimKey].lastSeenAt)).toBeGreaterThan(
        Date.parse(EPOCH),
      );
      // The children were collected FROM, not advanced BY, this command. Their marks
      // are frozen. UNCONDITIONAL — no `if (… !== undefined)` guard: these children
      // reported and were retained as terminal, so a vanished record is itself a
      // failure worth surfacing, not a reason to skip the assertion.
      for (const childKey of childClaimKeys) {
        expect(session.claims[childKey].lastSeenAt).toBe(EPOCH);
      }
    } finally {
      await workspace.cleanup();
    }
  });

  it('abort records ONLY the presented parent claim, never a bystander child (AC5)', async () => {
    // THE SHARPEST AC5 CASE, and the one the it.each above structurally cannot
    // express: `Arrangement` carries a single claim, so it has no slot for "and
    // this OTHER claim must not have moved". Every other recording command presents
    // a bearer for the run it mutates; `abort` is the only one where the presented
    // bearer (the parent's) controls a DIFFERENT run from the claims it affects. An
    // implementation that looped over the session's claims — or that recorded
    // `target.claimId` alongside `callerEvidence.claimId` — would pass every generic
    // case in this file, because the parent's mark moves and that is all they check.
    //
    // WHY A BYSTANDER, AND NOT THE ABORTED CHILD. The obvious test — "abort child A,
    // assert A's mark did not move" — CANNOT BE WRITTEN. Aborting a CLAIMED
    // delegation returns `needs_force`, and the force path calls
    // `cleanupForceAbortedLinkedChild` -> `releaseRunbook(childRunId)` WITHOUT
    // `retainClaimsAsTerminal`, which DELETES the claim record. So the aborted
    // child's mark is UNOBSERVABLE after the command: deleted is deleted, whether or
    // not it was recorded first. A bystander child is the observable form of the
    // same invariant — it has a live claim record throughout, it is not the abort's
    // target, and no correct implementation has any reason to touch it. A
    // loop-over-all-claims implementation moves it and fails here.
    const {
      workspace,
      parentClaimId,
      parentClaimKey,
      abortedChildClaimKey,
      bystanderChildClaimKey,
      token,
    } = await arrangeAbortableTrio();
    try {
      await backdateClaimProgress(workspace, parentClaimKey, EPOCH);
      await backdateClaimProgress(workspace, bystanderChildClaimKey, EPOCH);

      // `--force` is REQUIRED: the delegation is claimed, so the bare form throws
      // `needs_force`. This is not belt-and-braces.
      expect(
        (await runCliInProcess(['abort', token, '--force', '--claim-id', parentClaimId], workspace))
          .exitCode,
      ).toBe(0);

      const session = await readSession(workspace);
      // The parent presented its bearer and advanced the run: its mark moves.
      expect(Date.parse(session.claims[parentClaimKey].lastSeenAt)).toBeGreaterThan(
        Date.parse(EPOCH),
      );
      // The bystander was never presented and is not the target: its mark is frozen.
      // UNCONDITIONAL — no `if (… !== undefined)` guard. If this record has vanished,
      // that is itself a failure worth surfacing, not a reason to skip the assertion.
      expect(session.claims[bystanderChildClaimKey].lastSeenAt).toBe(EPOCH);
      // Pins the force-cleanup behaviour the reasoning above depends on. If a future
      // change makes force-abort RETAIN the child's claim as a terminal tombstone,
      // this fails — and that is the signal to add the direct "aborted child not
      // recorded" assertion, which would become observable at that point.
      expect(session.claims[abortedChildClaimKey]).toBeUndefined();
    } finally {
      await workspace.cleanup();
    }
  });

  it('a stash/pop loop never clears idle (anti-fooling sibling of the status loop)', async () => {
    // The decisive argument for excluding stash/pop. Both ARE claim-authenticated
    // mutations, so a rule keyed on "mutation" would record them — and then a child
    // could loop them to refresh itself alive forever WITHOUT advancing the run.
    // That is the exact hole that disqualified the rejected verify-path design,
    // reached through a mutating command instead of a read. Same defect, different
    // door. This is the sibling of the `status --claim-id` anti-fooling test in
    // packages/core/__tests__/runbook/claim-progress.test.ts.
    const { workspace, claimId, claimKey } = await arrangeStashableChild();
    try {
      await backdateClaimProgress(workspace, claimKey, EPOCH);
      const updatedAtBefore = (await readSession(workspace)).claims[claimKey].updatedAt;

      for (let i = 0; i < 3; i++) {
        expect((await runCliInProcess(['stash', '--claim-id', claimId], workspace)).exitCode).toBe(
          0,
        );
        expect((await runCliInProcess(['pop', '--claim-id', claimId], workspace)).exitCode).toBe(0);
      }

      const claim = (await readSession(workspace)).claims[claimKey];
      expect(claim.lastSeenAt).toBe(EPOCH);
      // Still idle after six successful claim-authenticated mutations: the signal
      // cannot be faked by a holder that never advances the run.
      expect(claimActivity(claim, new Date(), DEFAULT_IDLE_AFTER_MS).idle).toBe(true);

      // THE EMPIRICAL PROOF THAT ONE FIELD COULD NOT HAVE DONE THIS JOB.
      // `unstashForClaimId` moves `updatedAt` on every pop, so after this loop
      // `updatedAt` HAS moved while `lastSeenAt` has not. Had the design reused
      // `updatedAt` — the "obvious" economy this plan rejects — the same six commands
      // would have refreshed the idle clock and this dead claim would read as live.
      // The two fields mean different things, and this assertion is the only place in
      // the suite that demonstrates it against real behaviour rather than in prose.
      expect(claim.updatedAt).not.toBe(updatedAtBefore);
    } finally {
      await workspace.cleanup();
    }
  });
});
