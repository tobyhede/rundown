import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deletePersistedRunState,
  patchPersistedRunState,
} from '@rundown-org/core/testing/session-fixtures';
import { recordInlineLaunchStart, type InlineLaunchStart } from '@rundown-org/core';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  readSession,
  readRunbookState,
  runCliInProcess,
  type TestWorkspace,
  writeSession,
  withRunTarget,
} from '../helpers/test-utils.js';

function flattenEvents(events: unknown[]): Record<string, unknown>[] {
  const flat: Record<string, unknown>[] = [];
  for (const event of events) {
    if (Array.isArray(event)) {
      flat.push(...flattenEvents(event));
      continue;
    }
    if (event && typeof event === 'object') {
      flat.push(event as Record<string, unknown>);
    }
  }
  return flat;
}

function findDelegateToken(stdout: string, substepId: string): string {
  const events = flattenEvents(parseConcatenatedJson(stdout));
  for (const event of events) {
    if (!Array.isArray(event.delegateFrontier)) continue;
    for (const entry of event.delegateFrontier) {
      if (
        entry &&
        typeof entry === 'object' &&
        (entry as { readonly id?: unknown }).id === substepId
      ) {
        const token = (entry as { readonly token?: unknown }).token;
        if (typeof token === 'string') return token;
      }
    }
  }
  throw new Error(`No delegation token found for ${substepId} in stdout:\n${stdout}`);
}

function findClaim(stdout: string): { readonly claimId: string; readonly runId: string } {
  const action = flattenEvents(parseConcatenatedJson(stdout)).find(
    (event) =>
      event.action === 'claimed' &&
      typeof event.claim_id === 'string' &&
      typeof event.run_id === 'string',
  );
  if (typeof action?.claim_id === 'string' && typeof action.run_id === 'string') {
    return { claimId: action.claim_id, runId: action.run_id };
  }
  throw new Error(`No claim action found in stdout:\n${stdout}`);
}

describe('Automatic inline child launch integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function writeInlineParentAndChild(): Promise<void> {
    await writeFile(
      join(workspace.rootRunbooksDir(), 'parent.runbook.md'),
      `---
name: parent
required:
  - PlanPath
inputs:
  - PlanPath
---
# Parent

## 1. Start
- PASS CONTINUE

Ready.

## 2. Write
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md

## 3. Review
- PASS COMPLETE

Reviewing {{PlanPath}}.
`,
    );
    const childRunbook = `---
name: child
outputs:
  - PlanPath "{{WorkPath}}/plan.md"
---
# Child

## 1. Create
- PASS COMPLETE

Child prompt.
`;
    await writeFile(join(workspace.rootRunbooksDir(), 'child.runbook.md'), childRunbook);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childRunbook);
  }

  it('launches an inline child from a typed STEP_ENTERED intent', async () => {
    await writeFile(
      join(workspace.rootRunbooksDir(), 'parent.runbook.md'),
      `---
name: parent
required:
  - PlanPath
inputs:
  - PlanPath
---
# Parent

## 1. Start
- PASS CONTINUE

Ready.

## 2. Write
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md

## 3. Review
- PASS COMPLETE

Reviewing {{PlanPath}}.
`,
    );
    const childRunbook = `---
name: child
outputs:
  - PlanPath "{{WorkPath}}/plan.md"
---
# Child

## 1. Create
- PASS COMPLETE

Child prompt.
`;
    await writeFile(join(workspace.rootRunbooksDir(), 'child.runbook.md'), childRunbook);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childRunbook);

    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --input PlanPath=/placeholder/input.txt',
      workspace,
    );
    if (start.exitCode !== 0) {
      throw new Error(`parent start failed:\nSTDOUT:\n${start.stdout}\nSTDERR:\n${start.stderr}`);
    }
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent runbook');

    const passParentStep = await runCliInProcess(
      await withRunTarget(['pass'], workspace),
      workspace,
    );
    const events = flattenEvents(parseConcatenatedJson(passParentStep.stdout));

    const inlineStepIndex = events.findIndex(
      (event) =>
        event.type === 'step_entered' &&
        (event.position as { readonly current?: unknown; readonly substep?: unknown } | undefined)
          ?.current === '2' &&
        (event.position as { readonly current?: unknown; readonly substep?: unknown } | undefined)
          ?.substep === '1' &&
        event.inlineLaunch !== undefined,
    );
    const childStartIndex = events.findIndex(
      (event, index) => index > inlineStepIndex && event.type === 'runbook_started',
    );
    const childStepIndex = events.findIndex(
      (event, index) =>
        index > childStartIndex &&
        event.type === 'step_entered' &&
        (event.position as { readonly current?: unknown } | undefined)?.current === '1' &&
        event.prompt === 'Child prompt.',
    );
    expect(inlineStepIndex).toBeGreaterThanOrEqual(0);
    const inlineStep = events[inlineStepIndex];
    expect(inlineStep).toEqual(
      expect.objectContaining({
        description: 'Runbook: child.runbook.md',
        position: expect.objectContaining({
          current: '2',
          substep: '1',
        }),
        inlineLaunch: expect.objectContaining({
          childRunbookRef: expect.objectContaining({
            source: 'project',
            path: expect.stringMatching(/child\.runbook\.md$/),
          }),
          parentStep: '2',
          parentStepId: '1',
        }),
      }),
    );
    expect(inlineStep.delegateFrontier).toBeUndefined();

    const inlineLaunch = inlineStep.inlineLaunch as {
      readonly childRunbookPath?: unknown;
      readonly contextSnapshot?: unknown;
      readonly parentSubstepId?: unknown;
    };
    expect(typeof inlineLaunch.childRunbookPath).toBe('string');
    expect(inlineLaunch.childRunbookPath).toMatch(/child\.runbook\.md$/);
    expect(inlineLaunch.parentSubstepId).toBeUndefined();
    expect(inlineLaunch.contextSnapshot).toBeUndefined();
    expect(JSON.stringify(inlineLaunch)).not.toContain('/placeholder/input.txt');
    expect(childStartIndex).toBeGreaterThan(inlineStepIndex);
    expect(childStepIndex).toBeGreaterThan(childStartIndex);

    const parentState = await readRunbookState(workspace, parentRunId);
    expect(parentState).not.toBeNull();
    const parentContext = parentState?.snapshot as {
      readonly context?: { readonly inlineLaunchIntent?: unknown };
    };
    expect(parentContext.context?.inlineLaunchIntent).toBeUndefined();
    expect(parentState?.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        frameKey: expect.any(String),
        inline: expect.objectContaining({
          childRunId: expect.stringMatching(/^rd_[a-f0-9]{32}$/),
          // Released, not retained: the latch is held for the launch span and
          // dropped when the intent is consumed. A completed launch that kept
          // it would read as one still in progress on every later visit to this
          // frame.
          started: null,
        }),
      }),
    );

    const passChild = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(passChild.exitCode).toBe(0);
    expect(passChild.stdout).toContain('Reviewing');
    expect(passChild.stdout).toContain('/plan.md');
    expect(passChild.stdout).not.toContain('/placeholder/input.txt');
  });

  // Stage the state a process that died mid-inline-launch leaves behind: the
  // child run exists, but the parent never recorded the launch latch and never
  // consumed the launch intent, and the session stack was never advanced onto
  // the child. Written through the persisted-state fixture seam (state lives in
  // SQLite — a `writeFile` into `.rundown/runs/` is read by nothing).
  async function stageInterruptedInlineLaunch(): Promise<{
    readonly parentRunId: string;
    readonly childRunId: string;
  }> {
    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --input PlanPath=/placeholder/input.txt',
      workspace,
    );
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent runbook');

    const passParentStep = await runCliInProcess(
      await withRunTarget(['pass'], workspace),
      workspace,
    );
    expect(passParentStep.exitCode).toBe(0);

    const parentState = await readRunbookState(workspace, parentRunId);
    if (!parentState) throw new Error('expected parent runbook state');
    const inlineState = parentState.substepStates?.find((entry) => entry.inline)?.inline;
    if (!inlineState) throw new Error('expected inline metadata');
    const childRunId = inlineState.childRunId;
    if (typeof childRunId !== 'string') throw new Error('expected inline child run id');

    const sessionBeforeRewind = await readSession(workspace);
    await writeSession(workspace, {
      defaultStack: [parentRunId],
      claims: sessionBeforeRewind.claims,
      ...(sessionBeforeRewind.stashed ? { stashed: sessionBeforeRewind.stashed } : {}),
    });

    // `parentEntry` is deliberately absent: it is not a persisted field of the
    // intent. Core re-derives it from the parent's live frame coordinates when
    // it projects the intent, which is precisely why a frame re-entry produces a
    // higher entry than the child recorded.
    const restoredIntent = {
      parentRunId,
      parentStepId: '1',
      parentStep: '2',
      parentFrameKey: '2|',
      childRunId,
      childRunbookPath: inlineState.childRunbookPath,
      childRunbookRef: inlineState.childRunbookRef,
      contextSnapshot: inlineState.contextSnapshot,
    };
    await patchPersistedRunState(workspace.cwd, parentRunId, (current) => {
      const snapshot = current.snapshot as {
        context?: Record<string, unknown>;
        [key: string]: unknown;
      };
      return {
        ...current,
        substepStates: (
          current.substepStates as { inline?: { childRunId?: string } }[] | undefined
        )?.map((entry) =>
          entry.inline?.childRunId === childRunId
            ? { ...entry, inline: { ...entry.inline, started: null } }
            : entry,
        ),
        snapshot: {
          ...snapshot,
          context: { ...(snapshot.context ?? {}), inlineLaunchIntent: restoredIntent },
        },
      };
    });

    return { parentRunId, childRunId };
  }

  /**
   * Stage the OTHER thing a process that died mid-inline-launch can leave: the
   * latch committed, and no child run at all.
   *
   * This is the window the compare-and-latch opened by writing `inline.started`
   * before `manager.create`, and it is indistinguishable on disk from a live
   * observer that has latched and is still resolving the child runbook — which
   * is exactly why the recorded owner's liveness, and not the child's absence,
   * is what decides whether it may be taken over.
   *
   * Built by letting the real launch run and then removing what the crash would
   * have prevented, so everything else about the parent is what production
   * wrote.
   *
   * @param started - The latch record to leave behind, naming its owner.
   * @returns The staged parent and the child run id the intent still names.
   */
  async function stageStrandedInlineLaunch(
    started: InlineLaunchStart,
  ): Promise<{ readonly parentRunId: string; readonly childRunId: string }> {
    const { parentRunId, childRunId } = await stageInterruptedInlineLaunch();
    await deletePersistedRunState(workspace.cwd, childRunId);
    await patchPersistedRunState(workspace.cwd, parentRunId, (current) => ({
      ...current,
      substepStates: (
        current.substepStates as { inline?: { childRunId?: string } }[] | undefined
      )?.map((entry) =>
        entry.inline?.childRunId === childRunId
          ? { ...entry, inline: { ...entry.inline, started } }
          : entry,
      ),
    }));
    return { parentRunId, childRunId };
  }

  // The recovery the file lock had and the latch that replaced it did not. The
  // lock reclaimed a crashed holder through a PID-aware staleness check; the
  // latch, until this, had no notion of an owner at all, so a launch stranded
  // here reported `waiting` on every later observation — forever, with no
  // diagnostic naming the condition.
  it('reclaims an inline launch latched by a dead process and performs it', async () => {
    await writeInlineParentAndChild();
    // Above every platform's pid_max (Linux 4194304, macOS 99998), so this owner
    // is dead on any host — unlike a spawned-and-reaped pid, which is only dead
    // until the OS recycles it. Reclamation is a liveness decision and NEVER an
    // age-based one, so the recorded instant is deliberately recent.
    const { parentRunId, childRunId } = await stageStrandedInlineLaunch({
      at: new Date().toISOString(),
      ownerPid: 999999999,
      ownerStartId: null,
    });

    // Frame re-entry is the gesture that re-observes a stranded launch. A bare
    // transition cannot: core's reactivation seam resumes a RUNNING child, and
    // here there is none, so `pass` would fall through and pass the substep. Only
    // re-entering the execution unit re-projects the intent, which is the
    // observation the latch is consulted on.
    const recover = await runCliInProcess(await withRunTarget(['goto', '2'], workspace), workspace);
    expect(recover.exitCode).toBe(0);

    // The stranded launch was performed: the child the intent names now exists,
    // is running, and is the active run.
    expect((await readSession(workspace)).active).toBe(childRunId);
    expect(await readRunbookState(workspace, childRunId)).toEqual(
      expect.objectContaining({ id: childRunId, lifecycle: 'running' }),
    );

    // The latch now names THIS process. A reclamation that left the dead owner
    // in place would leave the launch reclaimable while it runs, which is the
    // duplicate `manager.create` the latch exists to prevent — reintroduced by
    // the recovery itself.
    const parentAfter = await readRunbookState(workspace, parentRunId);
    const inlineAfter = parentAfter?.substepStates?.find((entry) => entry.inline)?.inline;
    // Released at the child's START, not at its finish: the launch span ends
    // when `afterStarted` consumes the intent, which is why the child asserted
    // `running` above is still running here while the latch is already free.
    // That THIS process was recorded as the new owner while the span ran is
    // pinned on the event in the unit suite, where the mid-flight state is
    // observable; here the durable outcome is what matters, and a latch left
    // behind would strand the next visit to this frame.
    expect(inlineAfter?.started).toBeNull();

    // Recovery is reported rather than silent, and on stderr so JSON stdout
    // stays a clean event stream.
    expect(recover.stderr).toContain(
      `Reclaimed the inline launch of ${childRunId} from process 999999999`,
    );
  });

  // The safety half, and the reason absence of the child run cannot be the
  // signal: this state is byte-identical to the reclaimable one apart from who
  // owns it. A false reclamation here would send a second process into a launch
  // span the first is still executing and race the store's bare
  // `INSERT INTO runs` on the intent's fixed child id.
  it('never reclaims an inline launch whose owner is alive, and names the wait', async () => {
    await writeInlineParentAndChild();
    // Recorded through production's own recorder for the process actually
    // running this test, so the start id is one this host can read back and the
    // liveness probe cannot answer "dead" on a mismatch the fixture invented.
    const started = recordInlineLaunchStart(new Date().toISOString());
    const { parentRunId, childRunId } = await stageStrandedInlineLaunch(started);

    const observe = await runCliInProcess(await withRunTarget(['goto', '2'], workspace), workspace);
    expect(observe.exitCode).toBe(0);

    // Stood down: no child run was created, and the session was not advanced
    // onto one. The launch belongs to the live owner.
    expect(await readRunbookState(workspace, childRunId)).toBeNull();
    expect((await readSession(workspace)).active).toBe(parentRunId);

    // And the latch it found is the latch it left — an observer that rewrote it
    // would be claiming a launch it is not performing.
    const parentAfter = await readRunbookState(workspace, parentRunId);
    expect(parentAfter?.substepStates?.find((entry) => entry.inline)?.inline?.started).toEqual(
      started,
    );

    expect(observe.stderr).toContain(
      `Inline child ${childRunId} is already being launched by process ${String(process.pid)}`,
    );
  });

  // The counterpart, and the reason the latch is RELEASED when the launch is
  // consumed rather than left as a record of a launch that happened. A latch
  // outlives its span only if nothing clears it, and a retained one names a pid
  // that is very much alive — this process — so a later visit to the same frame
  // from the same process would classify its own completed launch as `held` and
  // stand down against itself, forever, with a diagnostic naming its own pid.
  // Nothing about the state distinguishes that from a genuine concurrent
  // observer, so the fix is at the other end: a launch that finishes holds
  // nothing.
  it('re-enters a frame in the same process after a completed launch instead of standing down', async () => {
    await writeInlineParentAndChild();
    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --input PlanPath=/placeholder/input.txt',
      workspace,
    );
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent runbook');

    // A complete, ordinary launch: this process latches, creates the child, runs
    // it to completion, and the parent advances past the frame.
    expect(
      (await runCliInProcess(await withRunTarget(['pass'], workspace), workspace)).exitCode,
    ).toBe(0);
    const launched = await readRunbookState(workspace, parentRunId);
    const firstChildRunId = launched?.substepStates?.find((entry) => entry.inline)?.inline
      ?.childRunId;
    if (typeof firstChildRunId !== 'string') throw new Error('expected inline child run id');
    expect(launched?.substepStates?.find((entry) => entry.inline)?.inline?.started).toBeNull();
    expect(
      (await runCliInProcess(await withRunTarget(['pass'], workspace), workspace)).exitCode,
    ).toBe(0);

    // Remove the finished child so the re-entry is decided by the latch rather
    // than refused earlier as a superseded-entry child — that refusal has its
    // own test, and its stated remedy is exactly this removal.
    await deletePersistedRunState(workspace.cwd, firstChildRunId);

    const reenter = await runCliInProcess(await withRunTarget(['goto', '2'], workspace), workspace);

    // Launched again rather than blocked. `runCliInProcess` shares this test's
    // pid, so a retained latch would name a live owner and this would be
    // `waiting` with `already being launched by process <this pid>`.
    expect(reenter.exitCode).toBe(0);
    expect(reenter.stderr).not.toContain('already being launched by process');
    const relaunched = await readRunbookState(workspace, parentRunId);
    const relaunchedChildId = relaunched?.substepStates?.find((entry) => entry.inline)?.inline
      ?.childRunId;
    expect((await readSession(workspace)).active).toBe(relaunchedChildId);
    expect(await readRunbookState(workspace, String(relaunchedChildId))).toEqual(
      expect.objectContaining({ lifecycle: 'running' }),
    );
    // Nothing was reclaimed: the previous launch finished and released, so this
    // one took a free latch. A "reclaimed from process N" here would be
    // reporting a crash that never happened.
    expect(reenter.stderr).not.toContain('Reclaimed the inline launch');
  });

  // Crash recovery is a RESUME, not a frame re-entry. The gesture is the bare
  // transition core already routes through its inline-child reactivation seam
  // (`#reactivateRunningInlineChild`): it resumes the child launched at the
  // parent's CURRENT frame entry and, like `classifyDelegationLiveness`, refuses
  // one stamped at any other entry. Spelling this as `rundown goto <step>`
  // instead — as this test once did — advances the frame entry, which by the
  // ratified rule makes the existing child a superseded-generation child that
  // must not be adopted (see the refusal test below).
  it('resumes an existing inline child through a bare transition after an interrupted launch', async () => {
    await writeInlineParentAndChild();
    const { parentRunId, childRunId } = await stageInterruptedInlineLaunch();

    const recover = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(recover.exitCode).toBe(0);

    // The SAME child is resumed — the interrupted launch is finished, not
    // duplicated by a second child run for the same substep.
    expect((await readSession(workspace)).active).toBe(childRunId);
    const resumedParent = await readRunbookState(workspace, parentRunId);
    expect(resumedParent?.substepStates?.filter((entry) => entry.inline)).toEqual([
      expect.objectContaining({
        id: '1',
        status: 'running',
        inline: expect.objectContaining({ childRunId }),
      }),
    ]);
    // The parent's frame entry is untouched by the resume, so the child's
    // recorded linkage still names the live entry.
    const childState = await readRunbookState(workspace, childRunId);
    expect(childState?.parentLinkage).toEqual(
      expect.objectContaining({ kind: 'inline', parentEntry: resumedParent?.activeEntry }),
    );

    // And the resumed child still composes: its result flows back into the
    // parent, which advances to its next step.
    const passChild = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(passChild.exitCode).toBe(0);
    expect(passChild.stdout).toContain('Reviewing');
  });

  // The resume does not merely re-activate the child: it FINISHES the launch the
  // dead process abandoned. Recording the launch latch, consuming the one-shot intent
  // and re-establishing the child's own run-control authority all live in
  // `launchInlineChildFromIntent`'s existing-child branch, which nothing reaches
  // unless the parent's own execution loop runs. Leaving the reactivation seam
  // at `loop: { kind: 'none' }` left that branch — and with it
  // `SessionService.adoptRunControlClaim` — unreachable from every CLI gesture:
  // the run stayed half-launched and the resumed child held no authority.
  it('finishes the interrupted launch and re-arms the resumed child on a bare transition', async () => {
    await writeInlineParentAndChild();
    const { parentRunId, childRunId } = await stageInterruptedInlineLaunch();

    const resume = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(resume.exitCode).toBe(0);

    // The child is announced with authority of its OWN. The prior bearer died
    // with the launching process, so the adoption supersedes it, and
    // `runbook_started.claim_id` is the single sanctioned channel for the
    // replacement — without it an orchestrator cannot address the run it is
    // about to watch.
    const resumeEvents = flattenEvents(parseConcatenatedJson(resume.stdout));
    const started = resumeEvents.find(
      (event) => event.type === 'runbook_started' && event.runbookId === childRunId,
    );
    expect(started).toBeDefined();
    expect(started?.claim_id).toEqual(expect.stringMatching(/^rdclm_/));

    // The interrupted launch is finished, not merely resumed: the parent
    // recorded the start it never got to record, and consumed its one-shot
    // intent so a later entry cannot replay the launch.
    const parentAfter = await readRunbookState(workspace, parentRunId);
    const inlineAfter = parentAfter?.substepStates?.find((entry) => entry.inline)?.inline;
    expect(inlineAfter?.childRunId).toBe(childRunId);
    // Took the latch to finish the interrupted launch, then released it with the
    // intent — the launch is over, and the row says so.
    expect(inlineAfter?.started).toBeNull();
    expect(
      (parentAfter?.snapshot as { context?: { inlineLaunchIntent?: unknown } } | undefined)?.context
        ?.inlineLaunchIntent,
    ).toBeUndefined();

    // The adopted claim is real authority, not a label: it drives the child.
    const driveChild = await runCliInProcess(
      ['pass', '--claim-id', String(started?.claim_id)],
      workspace,
    );
    expect(driveChild.exitCode).toBe(0);
    expect(flattenEvents(parseConcatenatedJson(driveChild.stdout))).not.toContainEqual(
      expect.objectContaining({ code: 'ACTOR_CONTEXT_REQUIRED' }),
    );
  });

  // The counterpart constraint. A reactivation whose launch already finished has
  // nothing left to do, so it must NOT run the parent's loop: doing so re-enters
  // the parent's execution unit behind the operator's back — re-announcing a
  // step it never left and, on a substep that also carries a command, running
  // that command a second time.
  it('does not re-enter the parent execution unit when the launch already finished', async () => {
    await writeInlineParentAndChild();

    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --input PlanPath=/placeholder/input.txt',
      workspace,
    );
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent runbook');

    const compose = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(compose.exitCode).toBe(0);
    const parentState = await readRunbookState(workspace, parentRunId);
    const childRunId = parentState?.substepStates?.find((entry) => entry.inline)?.inline
      ?.childRunId;
    if (typeof childRunId !== 'string') throw new Error('expected inline child run id');

    // Rewind the session so the next bare transition targets the parent, whose
    // launch is complete: the latch recorded and the intent already consumed.
    const sessionBeforeRewind = await readSession(workspace);
    await writeSession(workspace, {
      defaultStack: [parentRunId],
      claims: sessionBeforeRewind.claims,
      ...(sessionBeforeRewind.stashed ? { stashed: sessionBeforeRewind.stashed } : {}),
    });

    const reactivate = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(reactivate.exitCode).toBe(0);
    expect((await readSession(workspace)).active).toBe(childRunId);

    const events = flattenEvents(parseConcatenatedJson(reactivate.stdout));
    expect(
      events.filter((event) => event.type === 'step_entered' && event.runbookId === parentRunId),
    ).toEqual([]);
  });

  // The ratified rule: a self-targeting GOTO is a genuine frame re-entry, so it
  // advances the frame entry, and an inline child stamped at the previous entry
  // is stale — exactly as `classifyDelegationLiveness` closes a delegated child
  // `cursor-advanced` when the parent's entry no longer matches the one captured
  // at delegation time. Adopting it silently would run the previous generation's
  // child against a fresh visit to the frame.
  it('refuses to adopt an inline child launched at a superseded frame entry', async () => {
    await writeInlineParentAndChild();
    const { parentRunId, childRunId } = await stageInterruptedInlineLaunch();

    const entryBeforeReentry = (await readRunbookState(workspace, parentRunId))?.activeEntry;
    expect(typeof entryBeforeReentry).toBe('number');

    const reenter = await runCliInProcess(await withRunTarget(['goto', '2'], workspace), workspace);
    expect(reenter.exitCode).toBe(1);

    const events = flattenEvents(parseConcatenatedJson(reenter.stdout));
    // Its own code and its own wording: this is a superseded generation, not the
    // inconsistent-state condition `INLINE_CHILD_LINKAGE_MISMATCH` names.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error_occurred',
        code: 'INLINE_CHILD_FRAME_SUPERSEDED',
        message: expect.stringContaining(childRunId),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ code: 'INLINE_CHILD_LINKAGE_MISMATCH' }),
    );
    // Diagnosable: both entries and the remedy are named, so an operator can
    // tell a superseded child from a corrupt linkage without reading source.
    const refusal = events.find((event) => event.code === 'INLINE_CHILD_FRAME_SUPERSEDED');
    expect(refusal?.message).toEqual(
      expect.stringContaining(`entry ${String(entryBeforeReentry)} of frame 2|`),
    );
    expect(refusal?.message).toMatch(/Finish, stop, or prune/);

    // Refused, not adopted: the stale child was never activated.
    expect((await readSession(workspace)).active).toBe(parentRunId);

    // The refusal is actionable, not a dead end: prune the superseded child and
    // the same re-entry launches a fresh one under the current entry.
    const prune = await runCliInProcess(['prune', '--inactive'], workspace);
    expect(prune.exitCode).toBe(0);

    const relaunch = await runCliInProcess(
      await withRunTarget(['goto', '2'], workspace),
      workspace,
    );
    expect(relaunch.exitCode).toBe(0);
    const relaunchedParent = await readRunbookState(workspace, parentRunId);
    const relaunchedChildId = relaunchedParent?.substepStates?.find((entry) => entry.inline)?.inline
      ?.childRunId;
    expect(relaunchedChildId).toBeDefined();
    expect((await readSession(workspace)).active).toBe(relaunchedChildId);
    const relaunchedChild = await readRunbookState(workspace, relaunchedChildId!);
    expect(relaunchedChild?.parentLinkage).toEqual(
      expect.objectContaining({
        kind: 'inline',
        parentEntry: relaunchedParent?.activeEntry,
      }),
    );
    expect(relaunchedParent?.activeEntry).not.toBe(entryBeforeReentry);
  });

  it('does not let a run-targeted pass skip a recovered unstarted inline child substep', async () => {
    await writeInlineParentAndChild();

    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --input PlanPath=/placeholder/input.txt',
      workspace,
    );
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent runbook');

    const passParentStep = await runCliInProcess(
      await withRunTarget(['pass'], workspace),
      workspace,
    );
    expect(passParentStep.exitCode).toBe(0);

    const parentState = await readRunbookState(workspace, parentRunId);
    expect(parentState).not.toBeNull();
    if (!parentState) throw new Error('expected parent runbook state');

    const sessionBeforePassRecovery = await readSession(workspace);
    await writeSession(workspace, {
      active: parentRunId,
      defaultStack: [parentRunId],
      claims: sessionBeforePassRecovery.claims,
      ...(sessionBeforePassRecovery.stashed ? { stashed: sessionBeforePassRecovery.stashed } : {}),
    });

    const passRecoveredParent = await runCliInProcess(
      await withRunTarget(['pass'], workspace),
      workspace,
    );

    expect(passRecoveredParent.exitCode).toBe(0);
    expect(passRecoveredParent.stdout).not.toContain('Reviewing');
    expect(passRecoveredParent.stdout).not.toContain('/placeholder/input.txt');
    const session = await readSession(workspace);
    expect(session.active).not.toBe(parentRunId);
    const updatedParent = await readRunbookState(workspace, parentRunId);
    expect(updatedParent?.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        status: 'running',
        inline: expect.objectContaining({
          childRunId: session.active,
        }),
      }),
    );
  });

  it('does not let a run-targeted fail skip a recovered unstarted inline child substep', async () => {
    await writeInlineParentAndChild();

    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --input PlanPath=/placeholder/input.txt',
      workspace,
    );
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent runbook');

    const passParentStep = await runCliInProcess(
      await withRunTarget(['pass'], workspace),
      workspace,
    );
    expect(passParentStep.exitCode).toBe(0);

    const sessionBeforeFailRecovery = await readSession(workspace);
    await writeSession(workspace, {
      active: parentRunId,
      defaultStack: [parentRunId],
      claims: sessionBeforeFailRecovery.claims,
      ...(sessionBeforeFailRecovery.stashed ? { stashed: sessionBeforeFailRecovery.stashed } : {}),
    });

    const failRecoveredParent = await runCliInProcess(
      await withRunTarget(['fail'], workspace),
      workspace,
    );

    expect(failRecoveredParent.exitCode).toBe(0);
    expect(failRecoveredParent.stdout).not.toContain('Reviewing');
    const session = await readSession(workspace);
    expect(session.active).not.toBe(parentRunId);
    const updatedParent = await readRunbookState(workspace, parentRunId);
    expect(updatedParent?.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        status: 'running',
        inline: expect.objectContaining({
          childRunId: session.active,
        }),
      }),
    );
  });

  it('preserves child runbook identity for artifacts produced by automatic inline launch', async () => {
    await writeFile(
      join(workspace.rootRunbooksDir(), 'parent.runbook.md'),
      `---
name: parent
required:
  - PlanPath
inputs:
  - PlanPath
---
# Parent

## 1. Start
- PASS CONTINUE

Ready.

## 2. Write
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md

## 3. Review
- PASS COMPLETE

Reviewing {{PlanPath}}.
`,
    );
    const childRunbook = `---
name: child
outputs:
  - PlanPath
---
# Child

## 1. Create
- ARTIFACTS
  - PlanPath "plan.json"
- PASS COMPLETE

Child prompt.
`;
    await writeFile(join(workspace.rootRunbooksDir(), 'child.runbook.md'), childRunbook);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childRunbook);

    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --input PlanPath=/placeholder/input.txt',
      workspace,
    );
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent runbook');

    const passParentStep = await runCliInProcess(
      await withRunTarget(['pass'], workspace),
      workspace,
    );
    expect(passParentStep.exitCode).toBe(0);
    const childRunId = (await readSession(workspace)).active;
    if (!childRunId || childRunId === parentRunId) {
      throw new Error('expected active inline child runbook');
    }

    const passChild = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(passChild.exitCode).toBe(0);

    const parentState = await readRunbookState(workspace, parentRunId);
    const variables = parentState?.variables as Record<string, unknown> | undefined;
    const planPath = variables?.PlanPath as
      | {
          readonly kind?: unknown;
          readonly runId?: unknown;
          readonly uri?: unknown;
          readonly runbook?: { readonly path?: unknown };
        }
      | undefined;

    expect(planPath).toEqual(
      expect.objectContaining({
        kind: 'artifact-record',
        runId: childRunId,
        runbook: expect.objectContaining({
          path: expect.stringContaining('child.runbook.md'),
        }),
      }),
    );
    expect(planPath?.uri).toEqual(expect.stringContaining(`/${childRunId}/plan.json`));
    expect(passChild.stdout).toContain('Reviewing');
    expect(passChild.stdout).toContain('plan.json');
    expect(passChild.stdout).not.toContain('/placeholder/input.txt');
  });

  it('exits zero when inline child failure is handled by parent FAIL ANY CONTINUE', async () => {
    await writeFile(
      join(workspace.rootRunbooksDir(), 'parent.runbook.md'),
      `# Parent

## 1. Start
- PASS CONTINUE

Ready.

## 2. Gate
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

- child.runbook.md

## 3. Done
- PASS COMPLETE

Done.
`,
    );
    await writeFile(
      join(workspace.rootRunbooksDir(), 'child.runbook.md'),
      `# Child

## 1. Check
- PASS COMPLETE
- FAIL STOP

Child prompt.
`,
    );
    await writeFile(
      join(workspace.runbooksDir(), 'child.runbook.md'),
      `# Child

## 1. Check
- PASS COMPLETE
- FAIL STOP

Child prompt.
`,
    );

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const passStart = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(passStart.exitCode).toBe(0);

    const session = await readSession(workspace);
    const childRunId = session.defaultStack.at(-1);
    expect(childRunId).toBeDefined();
    const childBeforeFail = await readRunbookState(workspace, childRunId!);
    expect(childBeforeFail?.parentLinkage?.kind).toBe('inline');

    const failChild = await runCliInProcess(await withRunTarget(['fail'], workspace), workspace);
    expect(failChild.exitCode).toBe(0);

    const parentRunId = childBeforeFail!.parentLinkage!.parentRunId;
    const parentAfter = await readRunbookState(workspace, parentRunId);
    expect(parentAfter?.lifecycle).toBe('running');
    expect(parentAfter?.step).toBe('3');
    expect(parentAfter?.retryCount).toBe(0);
  });

  it('rejects automatic inline launch inside a claimed child delegation scope', async () => {
    await writeFile(
      join(workspace.rootRunbooksDir(), 'parent.runbook.md'),
      `# Parent

## 1. Delegate
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Claimed child
- child.runbook.md
`,
    );

    const childRunbook = `# Child

## 1. Start
- PASS CONTINUE

Claimed child start.

## 2. Inline grandchild
- PASS ALL CONTINUE
- FAIL ANY STOP

### 2.1 Grandchild
- grandchild.runbook.md

## 3. Done
- PASS COMPLETE

Claimed child done.
`;
    await writeFile(join(workspace.rootRunbooksDir(), 'child.runbook.md'), childRunbook);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childRunbook);

    const grandchildRunbook = `# Grandchild

## 1. Work
- PASS COMPLETE

Grandchild prompt.
`;
    await writeFile(join(workspace.rootRunbooksDir(), 'grandchild.runbook.md'), grandchildRunbook);
    await writeFile(join(workspace.runbooksDir(), 'grandchild.runbook.md'), grandchildRunbook);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const token = findDelegateToken(start.stdout, '1.1');

    const claim = await runCliInProcess(['claim', token], workspace);
    expect(claim.exitCode).toBe(0);
    const claimedChild = findClaim(claim.stdout);

    const passClaimedChild = await runCliInProcess(
      ['pass', '--claim-id', claimedChild.claimId],
      workspace,
    );
    expect(passClaimedChild.exitCode).toBe(1);

    const events = flattenEvents(parseConcatenatedJson(passClaimedChild.stdout));
    expect(events).toContainEqual(
      expect.objectContaining({
        action: 'stop',
        code: 'INLINE_LAUNCH_FORBIDDEN',
        message: 'Automatic inline launch is not supported inside claimed child scopes.',
        stopped: true,
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ code: 'INLINE_CHILD_LAUNCH_FAILED' }),
    );
    expect(passClaimedChild.stderr).not.toMatch(/generic failure/i);

    const childState = await readRunbookState(workspace, claimedChild.runId);
    expect(childState).not.toBeNull();
    const lastAction = (
      childState?.snapshot as { readonly context?: { readonly lastAction?: unknown } } | undefined
    )?.context?.lastAction;
    expect(lastAction).toEqual(
      expect.objectContaining({
        type: 'INLINE_LAUNCH_FAILED',
        reason: 'inline_launch_forbidden',
      }),
    );
  });

  // An inline child's terminal flows back through `propagateInlineChildTerminalResult`
  // into the core upward-propagation seam, which drains and re-runs the COMPOSING
  // parent. That continuation used to carry no delegation authority, so a parent
  // whose next step is a DELEGATE step was refused
  // `Delegation issuance requires verified claim authority` and stopped — a valid
  // nested workflow misclassified as absent authority. The parent's own
  // run-control claim is live in this very process (the loop that launched the
  // inline child holds it), so the continuation must issue under it.
  it('issues the composing parent delegation frontier when an inline child advances it into a DELEGATE step', async () => {
    await writeFile(
      join(workspace.runbooksDir(), 'parent.runbook.md'),
      `# Parent

## 1. Compose

- PASS ALL CONTINUE
- FAIL ANY STOP
- inline.runbook.md

## 2. Fan-out

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 2.1 Task A

- worker.runbook.md
`,
    );
    await writeFile(
      join(workspace.runbooksDir(), 'inline.runbook.md'),
      `# Inline

## 1. Work

- PASS COMPLETE
- FAIL STOP

\`\`\`bash
rd echo --result pass
\`\`\`
`,
    );
    await writeFile(
      join(workspace.runbooksDir(), 'worker.runbook.md'),
      `# Worker

## 1. Do work

- PASS COMPLETE
- FAIL STOP

Do the delegated work.
`,
    );

    const start = await runCliInProcess('run parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const events = flattenEvents(parseConcatenatedJson(start.stdout));
    expect(events).not.toContainEqual(
      expect.objectContaining({ reason: 'actor_context_required' }),
    );

    // The parent advanced into its DELEGATE step and auto-issued a bearer for the
    // delegated substep — the frontier the refusal used to suppress entirely.
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected the parent to remain the active runbook');
    const frontierEvent = events.find(
      (event) =>
        event.type === 'step_entered' &&
        event.runbookId === parentRunId &&
        Array.isArray(event.delegateFrontier),
    );
    expect(frontierEvent).toBeDefined();
    const frontier = frontierEvent!.delegateFrontier as { id: string; token: string }[];
    expect(frontier.map((entry) => entry.id)).toEqual(['2.1']);
    expect(frontier[0].token).toMatch(/^rdtk_/);

    const parentState = await readRunbookState(workspace, parentRunId);
    expect(parentState?.step).toBe('2');
    expect(parentState?.lifecycle).toBe('running');
  }, 30_000);

  // The nested-delegation prohibition (RD-819) is keyed on a DELEGATION parent
  // linkage, never on the absence of authority. Threading verified authority into
  // continuations must not reopen it — so pin the strongest form: a delegated
  // child holding its OWN verified bearer claim, advancing under it, is still
  // refused the moment it reaches a DELEGATE step, and no bearer is ever issued.
  it('still refuses a delegated child that reaches a DELEGATE step under its own claim (RD-819)', async () => {
    await writeFile(
      join(workspace.runbooksDir(), 'parent.runbook.md'),
      `# Parent

## 1. Fan-out

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Task A

- nested.runbook.md
`,
    );
    await writeFile(
      join(workspace.runbooksDir(), 'nested.runbook.md'),
      `# Nested

## 1. Prepare

- PASS CONTINUE
- FAIL STOP

Prepare the nested work.

## 2. Fan-out again

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 2.1 Task B

- worker.runbook.md
`,
    );
    await writeFile(
      join(workspace.runbooksDir(), 'worker.runbook.md'),
      `# Worker

## 1. Do work

- PASS COMPLETE
- FAIL STOP

Do the delegated work.
`,
    );

    const start = await runCliInProcess('run parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const startEvents = flattenEvents(parseConcatenatedJson(start.stdout));
    const token = findDelegateToken(start.stdout, '1.1');
    expect(startEvents.length).toBeGreaterThan(0);

    const claimed = await runCliInProcess(`claim ${token}`, workspace);
    expect(claimed.exitCode).toBe(0);
    const claimedChild = findClaim(claimed.stdout);

    // The child advances under its own verified bearer — authority is PRESENT —
    // and is still refused at the DELEGATE step.
    const advanced = await runCliInProcess(['pass', '--claim-id', claimedChild.claimId], workspace);
    expect(advanced.exitCode).toBe(1);
    const advancedEvents = flattenEvents(parseConcatenatedJson(advanced.stdout));
    expect(advancedEvents).toContainEqual(
      expect.objectContaining({
        action: 'stop',
        stopped: true,
        message: 'Nested delegation forbidden',
      }),
    );
    // No nested bearer was minted for the forbidden fan-out.
    expect(advancedEvents).not.toContainEqual(
      expect.objectContaining({ delegateFrontier: expect.anything() }),
    );

    const childState = await readRunbookState(workspace, claimedChild.runId);
    expect(childState?.lifecycle).toBe('stopped');
  }, 30_000);

  // A freshly launched inline child receives its own run-control runtime from
  // `prepareRunControlClaim`; a RESUMED one received nothing, so the moment its
  // cursor advanced into an authored DELEGATE step the machine refused
  // `actor_context_required` and stopped a run that would have proceeded had the
  // first process not died. Forwarding the composing parent's runtime is NOT the
  // remedy — it belongs to another run, and `delegationRuntimeFor` rightly
  // rejects it — so the child's OWN authority is what must be re-established.
  //
  // The fixture parks the child in prompted mode: it exists, is initialized, and
  // has executed nothing — the shape of a child created before the launching
  // process died. Clearing its prompted flag lets the resumed child advance into
  // the DELEGATE step the fresh launch never reached.
  //
  // The resume is driven by the bare-transition reactivation seam, NOT by
  // `rundown goto <step>`: a self-targeting GOTO advances the frame entry, which
  // makes the existing child a superseded generation the ratified rule forbids
  // adopting. Re-arming the child's own authority is then a separate, explicit
  // act on the child — `SessionService.adoptRunControlClaim` is the in-product
  // form of it, and its refusal-when-a-credential-was-already-issued guard is
  // pinned in `__tests__/services/execution-loop.test.ts`.
  it('lets a resumed inline child re-armed with its own authority reach a DELEGATE step', async () => {
    await writeFile(
      join(workspace.runbooksDir(), 'parent.runbook.md'),
      `# Parent

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
`,
    );
    await writeFile(
      join(workspace.runbooksDir(), 'child.runbook.md'),
      `# Child

## 1. Prepare
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
rd echo --result pass
\`\`\`

## 2. Fan-out

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 2.1 Task A

- worker.runbook.md
`,
    );
    await writeFile(
      join(workspace.runbooksDir(), 'worker.runbook.md'),
      `# Worker

## 1. Do work
- PASS COMPLETE
- FAIL STOP

Do the delegated work.
`,
    );

    const start = await runCliInProcess('run parent.runbook.md --prompted', workspace);
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent runbook');

    const compose = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(compose.exitCode).toBe(0);

    const parentState = await readRunbookState(workspace, parentRunId);
    const inlineState = parentState?.substepStates?.find((entry) => entry.inline)?.inline;
    if (!inlineState) throw new Error('expected inline metadata');
    const childRunId = inlineState.childRunId;
    if (typeof childRunId !== 'string') throw new Error('expected inline child run id');

    // The child was parked, not driven: nothing was issued under its original
    // bearer, so re-establishing authority orphans no credential.
    const parkedChild = await readRunbookState(workspace, childRunId);
    expect(parkedChild?.step).toBe('1');
    expect(parkedChild?.substepStates?.some((entry) => entry.delegation)).toBeFalsy();

    await patchPersistedRunState(workspace.cwd, childRunId, { prompted: false });

    // Rewind the session stack to the parent, as a process that died before the
    // child's loop ran would have left it.
    const sessionBeforeRewind = await readSession(workspace);
    await writeSession(workspace, {
      defaultStack: [parentRunId],
      claims: sessionBeforeRewind.claims,
      ...(sessionBeforeRewind.stashed ? { stashed: sessionBeforeRewind.stashed } : {}),
    });

    // A bare transition on the parent resumes the child at the parent's LIVE
    // frame entry. It neither advances that entry nor re-runs the launch, so the
    // child's recorded linkage still names the frame it was launched into.
    const resume = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(resume.exitCode).toBe(0);
    expect((await readSession(workspace)).active).toBe(childRunId);
    const resumedParent = await readRunbookState(workspace, parentRunId);
    const resumedLinkage = (await readRunbookState(workspace, childRunId))?.parentLinkage;
    expect(resumedLinkage).toEqual(
      expect.objectContaining({ kind: 'inline', parentEntry: resumedParent?.activeEntry }),
    );

    // The resumed child's original bearer died with the process that launched
    // it, so it holds no authority of its own: driving it bare is refused rather
    // than silently borrowing the composing parent's.
    const bare = await runCliInProcess(['pass'], workspace);
    expect(bare.exitCode).toBe(1);
    expect(flattenEvents(parseConcatenatedJson(bare.stdout))).toContainEqual(
      expect.objectContaining({ code: 'ACTOR_CONTEXT_REQUIRED' }),
    );

    // Re-armed with run-control authority of its OWN — which is sound precisely
    // because the parked child issued no credential the replacement could not
    // reproduce — it runs its command step and advances into the DELEGATE step,
    // issuing the frontier a resumed child used to be refused.
    const advance = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(advance.exitCode).toBe(0);
    const resumeEvents = flattenEvents(parseConcatenatedJson(advance.stdout));
    expect(resumeEvents).not.toContainEqual(
      expect.objectContaining({ code: 'ACTOR_CONTEXT_REQUIRED' }),
    );
    expect(resumeEvents).not.toContainEqual(
      expect.objectContaining({ reason: 'actor_context_required' }),
    );
    const frontierEvent = resumeEvents.find(
      (event) =>
        event.type === 'step_entered' &&
        event.runbookId === childRunId &&
        Array.isArray(event.delegateFrontier),
    );
    expect(frontierEvent).toBeDefined();
    const frontier = frontierEvent?.delegateFrontier as { id: string; token: string }[];
    expect(frontier.map((entry) => entry.id)).toEqual(['2.1']);
    expect(frontier[0].token).toMatch(/^rdtk_/);

    const resumedChild = await readRunbookState(workspace, childRunId);
    expect(resumedChild?.step).toBe('2');
    expect(resumedChild?.lifecycle).toBe('running');
  }, 30_000);
});
