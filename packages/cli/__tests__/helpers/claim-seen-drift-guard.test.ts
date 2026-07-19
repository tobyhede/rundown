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
  backdateClaimSeen,
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
 * A workspace arranged so one command can exercise its intended claim-id role.
 *
 * Carries the workspace ITSELF, not just the claim: the drivers have to run the
 * CLI, and `runCliInProcess` needs the workspace the arrangement just created.
 */
interface Arrangement {
  readonly workspace: TestWorkspace;
  /** Bearer the command under test presents. */
  readonly claimId: ClaimId;
  /** Lookup key for that same bearer — what `backdateClaimSeen`/`readSession` key on. */
  readonly claimKey: ClaimLookupKey;
  /**
   * Pending delegation token. Present ONLY for `abort`, which takes a token
   * argument rather than `--run`. This field is why the driver takes the whole
   * Arrangement: `driveClaimAbort` is unwritable without it.
   */
  readonly token?: string;
}

/** How one bearer-authority command is arranged and invoked. */
interface RecordingCase {
  /** Stand up a fresh workspace and bearer. The caller owns cleanup. */
  readonly arrange: () => Promise<Arrangement>;
  /**
   * Drive the command through its intended bearer-authority path. The observable
   * result may be a mutation or an authorized no-op; liveness was already proved
   * before either outcome.
   */
  readonly driveInvocation: (arranged: Arrangement) => Promise<void>;
}

/**
 * A claim-authenticated command that must NOT record, and how to drive it.
 *
 * `driveInvocation` matters most here: a refused command records nothing and
 * would pass the non-recording assertion vacuously, leaving the guard green
 * while pinning nothing. Each driver asserts its own exit code is 0 first.
 */
interface NonRecordingCase {
  /** Why this claim is a target rather than attributable presenter authority. */
  readonly reason: string;
  readonly arrange: () => Promise<Arrangement>;
  /** Drive this command to a successful target-selection invocation. */
  readonly driveInvocation: (arranged: Arrangement) => Promise<void>;
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
 * the invocation driver's own assertion.
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
 * maps a stopped runbook to exit 1 — that is the applied terminal path for these
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
// The arranged parent already auto-issued this substep, so this drives the
// `already-delegated` no-op. Authorization still proves the bearer holder alive;
// the no-op outcome is deliberately irrelevant to the mark.
const driveClaimDelegate = async (a: Arrangement): Promise<void> =>
  expectOk(['delegate', '--step', '1.1'], a);

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
 * Commands whose presented bearer is authority attributable to its own holder.
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
  pass: { arrange: arrangeClaimedRun, driveInvocation: driveClaimPass },
  fail: { arrange: arrangeClaimedRun, driveInvocation: driveClaimFail },
  complete: { arrange: arrangeClaimedRun, driveInvocation: driveClaimComplete },
  stop: { arrange: arrangeClaimedRun, driveInvocation: driveClaimStop },
  goto: { arrange: arrangeClaimedRun, driveInvocation: driveClaimGoto },
  delegate: { arrange: arrangeDelegatableParent, driveInvocation: driveClaimDelegate },
  collect: { arrange: arrangeCollectableParent, driveInvocation: driveClaimCollect },
  abort: { arrange: arrangeAbortableParent, driveInvocation: driveClaimAbort },
};

/**
 * Commands whose `--claim-id` names another agent's claim as a target selector.
 * They do not record because the presenter cannot vouch for that holder (AC5).
 *
 * Listed rather than omitted, because a non-recording classification is a
 * DECISION the guard pins in BOTH directions: a future edit that starts recording
 * on one of these fails loudly, which matters because such an edit would quietly
 * reopen the anti-fooling hole and nothing else in the suite would notice.
 */
const NON_RECORDING_CLAIM_COMMANDS: Readonly<Record<string, NonRecordingCase>> = {
  status: {
    reason:
      'Its help says "Target a claimed delegated child runbook": the claim names another holder as a target, so the presenter cannot vouch for that child\'s liveness.',
    arrange: arrangeClaimedRun,
    driveInvocation: driveClaimStatus,
  },
  stash: {
    reason:
      'Its help says "Target a claimed delegated child runbook": the claim is target selection, not bearer authority attributable to the presenter.',
    arrange: arrangeStashableChild,
    driveInvocation: driveClaimStash,
  },
  pop: {
    reason:
      'Its help says "Target a claimed delegated child runbook": an orchestrator naming a child cannot refresh that child\'s liveness mark.',
    arrange: arrangeStashableChild,
    driveInvocation: driveClaimPop,
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

describe('claim liveness recording drift guard (#519 AC4)', () => {
  // THE ANCHOR: every command the real program exposes with --claim-id must be
  // CLASSIFIED, in one direction or the other. Both failure modes are invisible
  // without this:
  //  - a new bearer-authority command that records nothing => a live claimant can
  //    read idle because its presentation was never observed;
  //  - a new target-selector command that DOES record => one agent can falsely
  //    vouch for another claim's liveness.
  // Set equality against the REAL program is what makes it fail closed in both
  // directions. Fed from these tables instead, it could never fail at all.
  it('classifies every command the real program registers with --claim-id', () => {
    const classified = [
      ...Object.keys(RECORDING_COMMANDS),
      ...Object.keys(NON_RECORDING_CLAIM_COMMANDS),
    ].sort();

    // If this fails with an EXTRA command, classify the presented claim: is it
    // bearer authority attributable to its own holder (=> RECORDING_COMMANDS),
    // or another holder's target selector (=> NON_RECORDING_CLAIM_COMMANDS, WITH
    // a reason)? Help text is intended-use evidence for that attribution. Do not
    // narrow the scan to make this pass — the scan is the guarantee.
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
  )('records claim liveness when %s presents bearer authority', async (_name, {
    arrange,
    driveInvocation,
  }) => {
    const arranged = await arrange();
    try {
      await backdateClaimSeen(arranged.workspace, arranged.claimKey, EPOCH);

      await driveInvocation(arranged);

      // The rule: every command that presents the claim as its holder's authority
      // records that holder as seen. Terminal commands record too; the eventual
      // run outcome does not change what authorization already proved.
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

  it('records claim liveness on delegate --retry, the distinct retry issuance site (#519)', async () => {
    // The RECORDING_COMMANDS it.each drives `delegate` through its FRESH issuance
    // site (issueDelegation). `delegate --retry` records at a SEPARATE site inside
    // #issueRetry, under the DelegationLock (lifecycle-command-service.ts:1290-1292)
    // — a line the fresh case never reaches. Deleting it leaves the entire it.each
    // green, so the retry recorder was unpinned end-to-end. This drives that exact
    // site through the real CLI and asserts the mark moved.
    //
    // It is a standalone `it`, not an it.each row: the classification anchor keys on
    // REAL command names (`delegate`), and `delegate --retry` is a flag path, not a
    // command the program registers.
    //
    // The parent from arrangeDelegatableParent is delegation-exposed (it owns
    // delegated children), so a retry MUST present bearer authority via `--claim-id`
    // — exactly the presenter path this records. Its substep 1.1 is a pending
    // delegation (childRunId null), which retry cancels and re-issues.
    const arranged = await arrangeDelegatableParent();
    try {
      await backdateClaimSeen(arranged.workspace, arranged.claimKey, EPOCH);

      const retried = await runCliInProcess(
        ['delegate', '--retry', '--step', '1.1', '--claim-id', arranged.claimId],
        arranged.workspace,
      );
      // Non-vacuous, per the driver discipline the rest of this file follows: a
      // REFUSED retry records nothing and would freeze the mark for the wrong
      // reason, passing this test hollow. Assert the committed `retried` action, not
      // exit 0 alone.
      expect(retried.exitCode).toBe(0);
      expect(findActionOutput(retried.stdout)?.action).toBe('retried');

      const after = (await readSession(arranged.workspace)).claims[arranged.claimKey].lastSeenAt;
      expect(Date.parse(after)).toBeGreaterThan(Date.parse(EPOCH));
    } finally {
      await arranged.workspace.cleanup();
    }
  });

  it.each(
    Object.entries(NON_RECORDING_CLAIM_COMMANDS),
  )('does NOT record claim liveness when %s uses a target selector', async (name, {
    reason,
    arrange,
    driveInvocation,
  }) => {
    const arranged = await arrange();
    try {
      await backdateClaimSeen(arranged.workspace, arranged.claimKey, EPOCH);

      // Drives the command to a successful invocation (exit 0) — a refusal would
      // leave the mark unchanged for the wrong reason and pass vacuously.
      await driveInvocation(arranged);

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
    // DOCUMENTS AC5 AT THIS SEAM — it does NOT guard it, and the difference was
    // established by running the probe rather than reasoning about it.
    //
    // The intuition says `collect` is where the wrong implementation looks right:
    // `listOpenClaimsForParent` sits on the seam, so "loop the open children and
    // record them all" is a natural line to write. Written out, THAT LINE DOES
    // NOTHING. `recordClaimSeen` verifies the bearer secret, and a parent holds
    // only child claim KEYS — never child bearers — so it returns `no-claim`.
    // This case cannot go red for the reason it names.
    //
    // Kept because it still catches a `recordClaimSeen` that stopped requiring
    // the secret — a real regression, just not the one the intuition worries about.
    // AC5's falsifiable case is `records the CALLER's bearer, never the bearer named
    // as the target` in packages/core/__tests__/runbook/claim-seen.test.ts: the
    // ONE input carrying two bearers. The CLI cannot express that divergence (one
    // --claim-id flag populates both fields), which is why it is not in this file.
    //
    // "A parent cannot vouch for a child's liveness, and must not appear to."
    const {
      workspace,
      claimId: parentClaimId,
      claimKey: parentClaimKey,
      childClaimKeys,
    } = await arrangeCollectedTrio();
    try {
      await backdateClaimSeen(workspace, parentClaimKey, EPOCH);
      for (const childKey of childClaimKeys) {
        await backdateClaimSeen(workspace, childKey, EPOCH);
      }

      expect(
        (await runCliInProcess(['collect', '--claim-id', parentClaimId], workspace)).exitCode,
      ).toBe(0);

      const session = await readSession(workspace);
      // The orchestrator presented its own bearer authority: its mark moves.
      expect(Date.parse(session.claims[parentClaimKey].lastSeenAt)).toBeGreaterThan(
        Date.parse(EPOCH),
      );
      // The children were targets of collection, not presenters. Their marks
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
    // DOCUMENTS AC5, like the collect case above, for the same reason: an
    // implementation that looped the session's claims could not move any of them —
    // `recordClaimSeen` verifies the bearer secret and this command holds no
    // bearer but the parent's. Kept as a regression net on that API contract, not
    // credited as AC5's guarantee. The falsifiable case is the seam-level one in
    // packages/core/__tests__/runbook/claim-seen.test.ts.
    //
    // It is still the sharpest arrangement in this file, and the one the it.each
    // above structurally cannot express: `Arrangement` carries a single claim, so it
    // has no slot for "and this OTHER claim must not have moved". Every other
    // recording command presents a bearer for the run it mutates; `abort` is the
    // only one where the presented bearer (the parent's) controls a DIFFERENT run
    // from the claims it affects.
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
      await backdateClaimSeen(workspace, parentClaimKey, EPOCH);
      await backdateClaimSeen(workspace, bystanderChildClaimKey, EPOCH);

      // `--force` is REQUIRED: the delegation is claimed, so the bare form throws
      // `needs_force`. This is not belt-and-braces.
      expect(
        (await runCliInProcess(['abort', token, '--force', '--claim-id', parentClaimId], workspace))
          .exitCode,
      ).toBe(0);

      const session = await readSession(workspace);
      // The parent presented its own bearer authority: its mark moves.
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

  it('a stash/pop target-selector loop never clears the child claim idle mark', async () => {
    // Stash and pop both describe `--claim-id` as targeting a claimed child.
    // Even though they mutate session targeting, the orchestrator presenting the
    // selector cannot establish that the child's own holder is alive. This is the
    // sibling of the status target-selector test in claim-seen.test.ts.
    const { workspace, claimId, claimKey } = await arrangeStashableChild();
    try {
      await backdateClaimSeen(workspace, claimKey, EPOCH);
      const updatedAtBefore = (await readSession(workspace)).claims[claimKey].updatedAt;

      for (let i = 0; i < 3; i++) {
        expect((await runCliInProcess(['stash', '--claim-id', claimId], workspace)).exitCode).toBe(
          0,
        );
        expect((await runCliInProcess(['pop', '--claim-id', claimId], workspace)).exitCode).toBe(0);
      }

      const claim = (await readSession(workspace)).claims[claimKey];
      expect(claim.lastSeenAt).toBe(EPOCH);
      // Still idle after six successful target-selector mutations: a parent
      // cannot make a dead child read alive by repeatedly naming it.
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
