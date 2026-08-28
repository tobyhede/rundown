import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertClaimId, claimKeyFromBearer } from '@rundown-org/core';
import {
  patchPersistedClaim,
  patchPersistedRunState,
} from '@rundown-org/core/testing/session-fixtures';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  readRunbookState,
  readSession,
  requireEmittedRunClaim,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * Issue #833 (re-scoped 2026-08-27 against main @ 9eb46d2a2).
 *
 * `runExecutionLoop`'s frontier-authority arm (`execution.ts:1550-1560`)
 * refuses to disclose a persisted, not-yet-consumed delegation re-entry
 * frontier when the driving continuation carries no `deriveDelegationToken`
 * capability. On the ONE caller that opts into `returnRefusals`
 * (`delegation-completion.ts:243`) that refusal travels back as data and
 * nothing is announced. Every other caller — including `goto-workflow.ts:387`
 * — does not opt in, so the same refusal instead emits `RUNBOOK_STOPPED` and
 * the loop returns `{status:'stopped'}`, even though nothing terminal was
 * ever applied and the run is still `running` in SQLite.
 *
 * REACHABILITY, traced empirically against this exact commit:
 *
 * The issue's suggested drive — start a DELEGATE-authoring parent, claim +
 * complete the child, then a BARE `pass`/`goto` with no `--claim-id` — does
 * NOT reach this arm. `RunbookLifecycleCommandService` refuses a bare
 * (`direct_cli`) mutation on ANY run whose document authors a DELEGATE
 * substep anywhere via `#refuseBareMutationOnExposedTarget`
 * (`lifecycle-command-service.ts:2882-2913`, wired into both `runTransition`
 * and `resolveRunNavigation`) — a document-wide, permanent classification
 * (`delegation-exposure.ts` clause (a)) that fires BEFORE the execution loop
 * is ever invoked, for `pass`, `fail`, and `goto` alike. A `--run`-targeted
 * bare mutation is refused earlier still: `resolveCommandIntent`
 * (`command-policy.ts`) requires bearer authority unconditionally whenever
 * `targetSelector.kind === 'run'`. Both refusals were confirmed directly: they
 * render the generic "This run has delegation activity..." /
 * `ACTOR_CONTEXT_REQUIRED` message from `refusal-renderers.ts`, never
 * `execution.ts`'s own `FRONTIER_AUTHORITY_REQUIRED_MESSAGE` — i.e. a
 * DIFFERENT, earlier gate, not the arm this issue is about.
 *
 * `transitionDelegationRuntime` (`lifecycle-command-service.ts:1338-1345`)
 * derives the loop's `delegationRuntime` from the PRESENTED CLAIM's own
 * grants, not from whatever authorized the mutation itself: it requires the
 * claim to separately authorize `delegate-from-run` on top of `mutate-run`.
 * A claim bearer never lacks the pairing in current production traffic (the
 * TSDoc calls this "a coincidence... it evaporates the day the nested
 * prohibition moves"), but the CODE PATH does not care how a caller ends up
 * missing `delegate-from-run` — only that it does. `patchPersistedClaim`
 * exists for precisely this: its own doc names "a claim missing a grant" as
 * the shape the public API refuses to mint and that tests must stage
 * directly. Stripping `delegate-from-run` from an otherwise-valid run-control
 * claim reproduces the exact `delegationTokenDeriver === undefined` condition
 * `execution.ts:1550` gates on, via a real `--claim-id` presented to a real
 * command (`goto-workflow.ts:387`), without touching the boundary gate above
 * (which only fires for `direct_cli` / bare-selector mutation).
 *
 * The frontier itself must be RE-INTRODUCED after the strip: the run's own
 * `--prompted` start disclosed and consumed it atomically (full authority
 * throughout), so by the time the claim is stripped `context.delegateFrontier`
 * is already empty again. `patchPersistedRunState` restores a structurally
 * valid entry built from the run's OWN sticky `substepStates[…].delegation`
 * record (real `credential` + `tokenHash`, never fabricated secrets) — the
 * shape a genuine interrupted-continuation (e.g. the resumed-inline-child arm
 * at `execution.ts:790`) would leave behind naturally. `readPersistedReEntryFrontier`
 * only requires structural validity to trip the loop's check; it never
 * verifies the credential, so no real claim needs to correspond to it.
 *
 * A driving `goto` to the SAME substep the cursor already occupies is a
 * self-targeting re-entry (already-established behaviour, see
 * inline-child-launch.test.ts). It reaches `runExecutionLoop` directly,
 * unlike a bare `pass`/`fail` on a substep-shaped cursor, which
 * `RunbookLifecycleCommandService` instead interprets as a manual substep
 * completion (record + drain) — confirmed empirically to consume the
 * fabricated frontier before the loop ever runs, by draining straight past
 * the substep.
 */
describe('issue #833: a frontier refusal is not announced as runbook_stopped', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('does not emit runbook_stopped for a re-entry frontier refusal that left the run running', async () => {
    await writeFile(
      join(workspace.rootRunbooksDir(), 'parent-833.runbook.md'),
      `# Parent 833

## 1. Delegate child
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child work
- DELEGATE
- child-833.runbook.md

## 2. Promote
- PASS COMPLETE
`,
    );
    const childContent = `# Child 833

## 1. Work
- PASS COMPLETE

Child prompt.
`;
    await writeFile(join(workspace.rootRunbooksDir(), 'child-833.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child-833.runbook.md'), childContent);

    const start = await runCliInProcess('run --prompted runbooks/parent-833.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent run');
    const parentClaimId = requireEmittedRunClaim(workspace, parentRunId);

    // Sanity: the auto-issued DELEGATE frontier for 1.1 disclosed (and
    // consumed) with full authority, leaving a sticky delegation record on
    // the substep — the real machine-produced data the fabricated frontier
    // below is built from.
    const parentStateBefore = await readRunbookState(workspace, parentRunId);
    expect(parentStateBefore).toEqual(
      expect.objectContaining({ step: '1', substep: '1', lifecycle: 'running' }),
    );
    const delegation = parentStateBefore?.substepStates?.find((s) => s.id === '1')?.delegation as
      | { readonly credential: unknown; readonly tokenHash: unknown }
      | undefined;
    if (!delegation) throw new Error('expected sticky delegation record on substep 1');

    // Strip `delegate-from-run`, keeping `mutate-run` — the exact shape
    // `patchPersistedClaim`'s own doc calls out as the sanctioned way to stage
    // "a claim missing a grant" the public API will not mint.
    await patchPersistedClaim(workspace.cwd, claimKeyFromBearer(assertClaimId(parentClaimId)), {
      grants: [{ action: 'mutate-run', runId: parentRunId }],
    });

    // Re-introduce a structurally valid, not-yet-consumed re-entry frontier
    // for substep 1.1, built from the run's own real credential + tokenHash.
    await patchPersistedRunState(workspace.cwd, parentRunId, (current) => {
      const snapshot = current.snapshot as { context?: Record<string, unknown> };
      return {
        ...current,
        snapshot: {
          ...snapshot,
          context: {
            ...(snapshot.context ?? {}),
            delegateFrontier: [
              {
                id: '1.1',
                runbook: 'child-833.runbook.md',
                credential: delegation.credential,
                tokenHash: delegation.tokenHash,
              },
            ],
          },
        },
      };
    });

    // Drive a self-targeting re-entry `goto` at the substep carrying the
    // frontier, with the now-mutate-run-only claim.
    const resume = await runCliInProcess(['goto', '1.1', '--claim-id', parentClaimId], workspace);
    const events = parseConcatenatedJson(resume.stdout) as Record<string, unknown>[];

    // (a) Setup guard / ground truth: no terminal transition was ever
    // applied. The refusal fires before the machine dispatch, so the run must
    // still be `running`.
    const parentAfter = await readRunbookState(workspace, parentRunId);
    expect(parentAfter?.lifecycle).toBe('running');

    // (b) THE PIN. The CLI's own account must agree with the ground truth
    // above: it must not claim the run stopped. Red today — the missing-
    // deriver arm at `execution.ts:1550-1560` emits `RUNBOOK_STOPPED` (reason
    // `actor_context_required`) on this exact path, for a run that stayed
    // running the whole time.
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'runbook_stopped' }));

    // (c) The refusal itself is still the honest report of what happened.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error_occurred', code: 'ACTOR_CONTEXT_REQUIRED' }),
    );

    // The run is still the active target — a real stop would have released
    // and popped it.
    expect((await readSession(workspace)).active).toBe(parentRunId);
  });
});
