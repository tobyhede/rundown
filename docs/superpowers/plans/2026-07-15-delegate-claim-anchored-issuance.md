# Delegate Claim-Anchored Issuance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `rundown delegate --claim-id <A>` (no `--run`) issue its delegation from the run claim A controls, matching every other mutating command — instead of silently anchoring on the active default run (#586).

**Architecture:** The fix is entirely in `@rundown-org/core`. The CLI already hands the claim to the seam as `callerEvidence` (a `claim_bearer` carrying the claim id); the seam's anchor resolver `#resolveIssuanceAnchor` just never uses it for target selection — it resolves the issuance anchor from `--run`-or-active only. We teach the anchor resolver to consult the claim: when a bearer claim is presented and no `--run` is named, resolve the anchor from the claim's controlled run via the same `resolveCommandTarget` seam the transition commands use. `#resolveIssuanceAnchor` is shared by three call sites — fresh issuance (`:847`) and the two retry locators that resolve an anchor, step (`:1080`) and inferred-active (`:1109`) — and all three carry the identical divergence, so all three pass `callerEvidence` (the token retry locator at `:1048` never calls the method and is untouched, correctly — it has its own `run_target_mismatch` token-scan semantics). `callerEvidence` becomes a **required** parameter: every caller already has `input.callerEvidence`, so making it required (not optional-defaulted) means the fresh/retry distinction is not a convention a future edit can silently break — omission is a compile error. The claim branch is purely additive — it diverts to the controlled run only when the claim resolves to a live claimed run; every other case (stale claim, terminal-controlled run, stashed child, non-claim evidence) falls through to the pre-existing active-default anchor and the unchanged authorization gate, so no existing behavior changes.

**Tech Stack:** TypeScript, XState (core state machine — not touched here), Jest (unit + integration), pnpm workspaces. Packages: `@rundown-org/core` (the `RunbookLifecycleCommandService` seam), `@rundown-org/cli` (thin front end — no production change, integration coverage only).

## Global Constraints

- **State machine drives Rundown logic; the CLI is a thin wrapper.** The target-selection fix is runbook-program logic and belongs in core. The CLI is not touched for production code — it already passes the claim as `callerEvidence`. (CLAUDE.md Architectural Principles.)
- **Type-driven dispatch; the claim is the target when present.** Anchor selection dispatches on the resolved `CommandTargetResolution.kind`, never on ad-hoc string checks. (CLAUDE.md Design Principles.)
- **Fix all three anchor call sites; `callerEvidence` is required, not optional.** `#resolveIssuanceAnchor` is called from three sites — fresh (`:847`), retry-step (`:1080`), retry-active (`:1109`) — and all three carry the same #586 divergence, so all three pass `input.callerEvidence`. Making the parameter REQUIRED (not optional-defaulted) is deliberate: `DelegationIssuanceInput` always carries `callerEvidence` on both `fresh` and `retry` variants, so there is no caller that legitimately omits it, and a required param turns "did this call site forget to anchor on the claim?" into a compile error instead of a prose convention. The retry **token** locator (`:1048`) does NOT call `#resolveIssuanceAnchor` (it scans by token and owns `run_target_mismatch`), so it is genuinely out of scope and unchanged.
- **`--run` and `--claim-id` are mutually exclusive at the CLI.** `delegateSeamFields` (`packages/cli/src/commands/delegate.ts:79-91`) produces `callerEvidence` (for a claim) OR `targetRunId` (for `--run`) — never both, on both the fresh and retry flows. The seam relies on this: the `--run` branch returns first, so the claim branch is reached only when no `--run` was named. Do not add a redundant guard.
- **Test layers (explicit).** This change is pinned at the unit layer (core seam: claim-anchoring on fresh AND retry-step, plus the stale/terminal fall-through) and the integration layer (end-to-end CLI red→green). **No property test** is added — the two existing delegation property suites (`delegation-exposure.properties.test.ts`, `delegation-inference.properties.test.ts`) cover pure classifiers, not the anchor seam, and the anchor input space (claim controls {active, non-active-live, terminal/stale}) is small and enumerable, so example unit tests pin it more precisely than fast-check over a stateful `SessionService`. **No scenario test** is added — the scenario system drives single-runbook demo transcripts; #586 is a multi-run session arrangement (a controlled-but-not-active run competing with a different active default) that a single-runbook transcript cannot express.
- **Never migrate persisted runbook state.** No persisted-state shape changes. This is pure read-side target selection.
- **JSON output by default.** The CLI integration test asserts the default JSON envelope (`findActionOutput`), not `--text`.

---

## Background: why the bug exists

`issueDelegation` (fresh) resolves its issuance anchor at `lifecycle-command-service.ts:847`:

```typescript
const anchored = await this.#resolveIssuanceAnchor(input.targetRunId);
```

`#resolveIssuanceAnchor` (`:1939-1955`) only knows about `targetRunId` (the `--run` selector). When `targetRunId` is `undefined` — which it always is on the `--claim-id` path, because `delegateSeamFields` maps a `claim` target to `callerEvidence` alone — it falls back to `getActive()` (the active default run). So `delegate --claim-id A` anchors on whatever run happens to be active, ignoring that claim A unambiguously names run A via its `controlledRunId`.

Every transition command avoids this: `runTransition` (`:1307`) and `resolveRunNavigation` (`:1515`) resolve their target through `resolveCommandTarget(sessionService, { claimId })`, which calls `getActiveForClaimId` → loads `record.controlledRunId` directly (`session-service.ts:594`, independent of the session stack) and returns `{ kind: 'claim', state }` where `state` is the controlled run. `delegate` is the one mutating command that doesn't. This plan closes that divergence.

**The divergence is shared by fresh AND the two retry anchor locators.** `#resolveIssuanceAnchor(input.targetRunId)` is called at three sites: fresh issuance (`:847`), the retry `step` locator (`:1080`), and the retry inferred-`active` locator (`:1109`). All three fall back to `getActive()` and none consults the claim, so `delegate --step 1.1 --claim-id A` (fresh) and `delegate --retry --step 1.1 --claim-id A` (retry) both mis-anchor when A is controlled-but-not-active. The retry `token` locator (`:1048`) is the ONE that is genuinely different — it scans by token and enforces `run_target_mismatch` against `--run`, never calling `#resolveIssuanceAnchor`. So the fix passes `input.callerEvidence` at all three anchor call sites and leaves the token locator alone. (An earlier draft scoped this to fresh-only and justified the exclusion by "retry has distinct token-scan semantics"; that reasoning is true only of the token locator, not the step/active locators, so it is corrected here — the fix now covers the full root cause.)

**Before-fix behavior for the fixed case** (claim A controls a non-active run, B is active): the seam anchors B, then the authorization gate checks claim A's `delegate-from-run` grant against B, which claim A does not hold → refuses `claim_grant_required` (exit 1). **After fix:** anchors A → gate checks the grant against A, which the run-control claim holds → issues from A. The test layers below pin exactly this red→green on both the fresh and retry-step paths.

---

## File Structure

- `packages/core/src/runbook/lifecycle-command-service.ts` — add a REQUIRED `callerEvidence` parameter to `#resolveIssuanceAnchor`; add a claim-anchored branch that resolves the controlled run via `resolveCommandTarget`; pass `input.callerEvidence` from all three anchor call sites (`:847` fresh, `:1080` retry-step, `:1109` retry-active). (#586 production change — the only file.)
- `packages/core/__tests__/runbook/lifecycle-command-service.test.ts` — add three failing-first unit tests: (1) a claim whose controlled run is NOT the active default anchors the controlled run on the FRESH path; (2) the same on the RETRY-step path; (3) a claim whose controlled run is TERMINAL falls through to the active default and is refused by the gate (pins the additive-only invariant and kills the inner-guard mutant). (#586 unit coverage.)
- `packages/cli/__tests__/integration/delegate-workflow.test.ts` — add an end-to-end regression test: with a controlled-but-not-active parent run and a different (still-running, `--prompted`) active default run, `delegate --step 1.1 --claim-id <A>` issues against run A. (#586 integration coverage — no new production code.)

---

## Task 1: Core anchors issuance on the claim's controlled run — fresh + retry (#586)

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts:847` (fresh call site), `:1080` (retry-step call site), `:1109` (retry-active call site), `:1939-1955` (`#resolveIssuanceAnchor`)
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts` (fresh + fall-through tests in the `issueDelegation (fresh)` describe at `:366+`; retry test in the `issueDelegation (retry)` describe — find it with `grep -n "describe('issueDelegation (retry)'" packages/core/__tests__/runbook/lifecycle-command-service.test.ts`)

**Interfaces:**
- Consumes: `resolveCommandTarget` (already imported at `lifecycle-command-service.ts:27`), `CallerEvidence` (already imported and used across the input types), `RunbookState`, `RunId` (already in scope).
- Produces: `#resolveIssuanceAnchor(targetRunId: RunId | undefined, callerEvidence: CallerEvidence)` — `callerEvidence` is REQUIRED (see Global Constraints). The return type is unchanged (`{ kind: 'ok'; state } | { kind: 'unknown_run'; runId; message } | { kind: 'none' }`). All three call sites pass `input.callerEvidence`.

- [ ] **Step 1: Write the failing core unit test**

Add this test inside the existing `describe('issueDelegation (fresh)', ...)` block (the block opens at `packages/core/__tests__/runbook/lifecycle-command-service.test.ts:366`), after the first "delegates" success test. It reuses the suite's own fixtures — `startSeamOnDelegateStep` (`:280`, activates run `runId` on a DELEGATE step and mints its run-control claim), `baseState` (`:172`), `activate` (`:196`, pushes a run and mints its run-control claim), `runControlEvidence` (`:209`, returns `{ kind: 'claim_bearer', claimId }` for a run), and `assertRunId` (already imported; used at `:133`). Do not invent new helpers.

```typescript
    it('anchors fresh issuance on the claim\'s controlled run, not the active default (#586)', async () => {
      // Run `runId` is activated with an authored DELEGATE substep and its own
      // run-control claim.
      const { seam: localSeam } = await startSeamOnDelegateStep();

      // A DIFFERENT run is then activated, so `runId` is controlled-but-not-active:
      // getActive() now returns this run, not `runId`.
      const otherRunId = assertRunId('rd_22222222222222222222222222222222');
      const activeDefault = baseState({ id: otherRunId, runbookPath: 'other.md' });
      await activate(activeDefault);

      // Delegating with `runId`'s run-control claim (NO --run) must anchor on
      // `runId` — the run the claim controls — not on the active default.
      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });

      expect(outcome.kind).toBe('delegated');
      if (outcome.kind !== 'delegated') throw new Error('expected delegated');
      // The load-bearing assertion: issuance anchored on the CONTROLLED run
      // (`runId`), not the active default (`otherRunId`). Before the fix the seam
      // anchors `otherRunId`, whose run the claim lacks a grant for, and the
      // outcome is `refused` (claim_grant_required) — so this expectation fails.
      expect(outcome.parentRunId).toBe(runId);
    });
```

Then add the fall-through test — REQUIRED, not optional. It pins the plan's load-bearing "additive only: a claim that does NOT resolve to a live claimed run falls through to the active-default anchor and the unchanged gate" invariant, AND kills the surviving `target.kind === 'claim' → true` mutant that the claim-anchoring test above does not (that test only ever presents a live `claim` resolution). Add it directly after:

```typescript
    it('falls through to the active default when the claim\'s controlled run is terminal (#586)', async () => {
      // The run `runId` is activated with a DELEGATE step and its run-control
      // claim, then driven terminal — so the claim resolves to `terminal_claim`,
      // NOT `claim`. A different run is the active default.
      const { seam: localSeam } = await startSeamOnDelegateStep();
      await manager.updateWithState(runId, () => ({ lifecycle: 'completed' as const }));
      const otherRunId = assertRunId('rd_33333333333333333333333333333333');
      await activate(baseState({ id: otherRunId, runbookPath: 'other.md' }));

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });

      // The terminal claim does NOT divert the anchor: the seam falls through to
      // the active default (`otherRunId`), and because the claim holds no
      // `delegate-from-run` grant for it, the unchanged gate refuses. A mutant
      // forcing `target.kind === 'claim'` true would anchor `runId` and produce a
      // different outcome, so this assertion kills it.
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('expected refused');
      expect(outcome.policy.kind).toBe('claim_grant_required');
    });
```

- [ ] **Step 2: Run both fresh-path tests to verify they fail as expected**

Run: `pnpm --filter @rundown-org/core exec jest lifecycle-command-service.test.ts -t "anchors fresh issuance on the claim"`

Expected: FAIL. Before the fix the seam anchors the active default (`otherRunId`); the authorization gate then rejects the claim's missing `delegate-from-run` grant for that run, so `outcome.kind` is `'refused'` — the `expect(outcome.kind).toBe('delegated')` assertion fails.

> The fall-through test (`falls through … when the claim's controlled run is terminal`) already PASSES before the fix — before the branch exists the seam always anchors the active default, which is exactly what it asserts. That is intended: it is a mutation-killing / invariant guard, not a red→green driver. Confirm it stays green after Step 3-4.

> **Jest invocation:** use `exec jest <path> -t "<name>"`, NOT `test -- <path> -t "<name>"`. Both packages define `"test": "jest"`, so the script form forwards a literal `--` into jest 30, which then treats `-t` and the name as positional path patterns — the name filter is silently dropped and a mistyped red-test name matches nothing yet reports green. `exec jest` bypasses the script indirection.

- [ ] **Step 3: Add the claim-anchored branch to `#resolveIssuanceAnchor`**

In `packages/core/src/runbook/lifecycle-command-service.ts`, change `#resolveIssuanceAnchor` (`:1939-1955`) to take a REQUIRED `callerEvidence` and consult the claim when no `--run` was named. Replace the whole method:

```typescript
  // Resolve the issuance anchor run. Precedence:
  //   1. `--run <id>`: the named session-stack member (a missing/foreign/terminal
  //      id refuses as `unknown_run`, carrying the same cause-specific message
  //      pass/complete refuse with).
  //   2. A presented bearer claim (no `--run`): the claim's controlled run,
  //      resolved via the same `resolveCommandTarget` seam every transition
  //      command uses (`getActiveForClaimId` -> `record.controlledRunId`). This is
  //      the #586 fix: a claim unambiguously names its run, so `delegate
  //      --claim-id A` issues from A even when A is not the active default. The
  //      divert is ADDITIVE — only a live `claim` resolution anchors here; a
  //      stale/terminal/stashed claim falls through to (3), where the unchanged
  //      authorization gate refuses it exactly as before.
  //   3. The active default run (`none` when absent) — the pre-existing bare path.
  async #resolveIssuanceAnchor(
    targetRunId: RunId | undefined,
    callerEvidence: CallerEvidence,
  ): Promise<
    | { readonly kind: 'ok'; readonly state: RunbookState }
    | { readonly kind: 'unknown_run'; readonly runId: RunId; readonly message: string }
    | { readonly kind: 'none' }
  > {
    if (targetRunId !== undefined) {
      const member = await this.#deps.sessionService.resolveRunningStackMember(targetRunId);
      if (member.kind !== 'running') {
        return unknownRunRefusal(targetRunId, member);
      }
      return { kind: 'ok', state: member.state };
    }
    if (callerEvidence.kind === 'claim_bearer') {
      const target = await resolveCommandTarget(this.#deps.sessionService, {
        claimId: callerEvidence.claimId,
      });
      if (target.kind === 'claim') {
        return { kind: 'ok', state: target.state };
      }
    }
    const active = await this.#deps.sessionService.getActive();
    return active ? { kind: 'ok', state: active } : { kind: 'none' };
  }
```

- [ ] **Step 4: Pass the caller evidence from all three anchor call sites**

`#resolveIssuanceAnchor` is now called with two arguments everywhere it resolves an anchor. There are exactly three such call sites (the retry `token` locator at `:1048` does not call it — leave it alone). At each, change:

```typescript
    const anchored = await this.#resolveIssuanceAnchor(input.targetRunId);
```

to:

```typescript
    const anchored = await this.#resolveIssuanceAnchor(input.targetRunId, input.callerEvidence);
```

The three sites are: `:847` (fresh, in `issueDelegation`), `:1080` (retry `step` locator, in `#issueRetry`), and `:1109` (retry inferred-`active` locator, in `#issueRetry`). Because the parameter is now required, TypeScript flags any site still passing one argument — a compile error is the guard that no anchor call site was missed. Confirm the token locator (`:1048`) was not touched.

- [ ] **Step 5: Write the failing RETRY-path claim-anchoring test**

Add to `packages/core/__tests__/runbook/lifecycle-command-service.test.ts` inside the `describe('issueDelegation (retry)', ...)` block. This proves the `:1080` retry-step call site is fixed (its own red→green), mirroring the fresh test: run `runId` is controlled-but-not-active, and `--retry --step 1.1 --claim-id runId` must anchor and re-issue against `runId`. Use the suite's retry fixture that stands up an active DELEGATE runbook with an already-issued substep (grep for the existing retry success test — e.g. `grep -n "retried" packages/core/__tests__/runbook/lifecycle-command-service.test.ts` — and mirror its setup, which activates `runId` on a DELEGATE step with an issued token). After that setup, activate a second run so `runId` is no longer the active default, then:

```typescript
      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: '1.1' },
        resolveOverrides: async () => undefined,
      });

      expect(outcome.kind).toBe('retried');
      if (outcome.kind !== 'retried') throw new Error('expected retried');
      // Anchored on the controlled run (`runId`), not the active default. Before
      // the Step 4 fix the retry-step locator anchors the active default, whose run
      // the claim lacks a grant for, so the outcome is `refused`.
      expect(outcome.parentRunId).toBe(runId);
```

(If the mirrored retry fixture already leaves `runId` as the sole active run, add the second-run activation exactly as in the fresh test: `await activate(baseState({ id: assertRunId('rd_44444444444444444444444444444444'), runbookPath: 'other.md' }));` before the `issueDelegation` call.)

- [ ] **Step 6: Run the retry test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest lifecycle-command-service.test.ts -t "retry"` (narrow further with the exact test name you chose)

Expected: FAIL before Step 4 is applied to `:1080` — the retry-step locator anchors the active default and the gate refuses (`outcome.kind === 'refused'`).

- [ ] **Step 7: Run the fresh + retry claim-anchoring tests to verify they pass**

Run: `pnpm --filter @rundown-org/core exec jest lifecycle-command-service.test.ts -t "anchors fresh issuance on the claim"`
Run: `pnpm --filter @rundown-org/core exec jest lifecycle-command-service.test.ts -t "falls through to the active default"`
Run: `pnpm --filter @rundown-org/core exec jest lifecycle-command-service.test.ts -t "retry"` (your retry test name)

Expected: PASS. The claim now anchors on `runId` on both the fresh and retry-step paths; the gate finds the run-control claim's grant for `runId`; the terminal-claim fall-through still refuses (invariant holds).

- [ ] **Step 8: Run the full seam suite to verify no regression**

Run: `pnpm --filter @rundown-org/core exec jest lifecycle-command-service.test.ts`

Expected: PASS. The existing fresh AND retry tests (claim controls the active run) pass unchanged — when the claim's controlled run IS the active default, the new branch resolves the same run the old `getActive()` path did, so their outcomes are identical.

- [ ] **Step 9: Run the broader core delegation suites**

Run: `pnpm --filter @rundown-org/core exec jest delegation`

Expected: PASS. This sweeps `delegation-service`, `retry-delegation`, `create-delegation`, `delegation-exposure`, and the delegation property tests, confirming the anchor change did not perturb issuance/echo/conflict or retry semantics.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts \
  packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "fix(core): anchor delegate issuance on the claim's controlled run, fresh + retry (#586)"
```

---

## Task 2: CLI end-to-end regression coverage (#586)

**Files:**
- Test: `packages/cli/__tests__/integration/delegate-workflow.test.ts` (add one `it` to the existing `describe('DELEGATE full workflow …')` block, which opens at `:109`)

**Interfaces:**
- Consumes (all already imported at the top of the file, `:5-17`): `createRunbook`, `runCliInProcess`, `getActiveState`, `readRunbookState` (unused here but present), `findActionOutput`, `issueRunControlClaim`, plus the file-local `setupParentWithChildren` (`:167`) and `buildParentDelegate` (`:128`). `writeFile` / `join` are imported at `:2-3`.
- Produces: nothing — pure regression coverage, no production code.

This test proves the Task 1 fix through the real CLI pipeline. `setupParentWithChildren` starts a `--prompted` parent that auto-issues tokens for substeps `1.1`/`1.2` on step entry, so `delegate --step 1.1` against that run echoes `already-delegated` (a clean exit-0 success carrying `parent_run_id`). We then activate a DIFFERENT run so the parent is controlled-but-not-active, mint a run-control claim for the parent, and assert `delegate --step 1.1 --claim-id <parent>` issues against the parent. Before the Task 1 fix, the seam anchors the active default run (which the parent's claim lacks a grant for), so the command refuses with exit 1.

- [ ] **Step 1: Write the failing integration test**

Add to `packages/cli/__tests__/integration/delegate-workflow.test.ts`, inside the `describe('DELEGATE full workflow …')` block (after the existing `full happy path` test, ~`:270`):

```typescript
  it('delegate --claim-id anchors on the claim\'s controlled run when it is not the active default (#586)', async () => {
    // Parent run A is activated with auto-issued 1.1/1.2 delegations.
    const { parentRunId } = await setupParentWithChildren();

    // Activate a DIFFERENT run so A is controlled-but-not-active: getActive() now
    // returns this run, not A. Start it `--prompted` so it ENTERS step 1 and stays
    // running/active WITHOUT auto-executing. A plain (non-prompted) `run` would
    // auto-execute this single-step `pass: COMPLETE` runbook to completion and
    // release it — restoring A as the active default and collapsing the red→green
    // discriminator (`--prompted` = "show commands without auto-executing",
    // run.ts:66; mirrors how setupParentWithChildren keeps the parent alive).
    const other = createRunbook({
      title: 'Other',
      steps: [{ title: 'Only', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'other.runbook.md'), other);
    const otherStart = await runCliInProcess('run --prompted runbooks/other.runbook.md', workspace);
    expect(otherStart.exitCode).toBe(0);
    const active = await getActiveState(workspace);
    expect(active).not.toBeNull();
    expect(active!.id).not.toBe(parentRunId); // A is no longer the active default

    // Mint a run-control claim for A and delegate against 1.1 with it (no --run).
    const parentClaimId = await issueRunControlClaim(workspace, parentRunId);
    const delegated = await runCliInProcess(
      ['delegate', '--step', '1.1', '--claim-id', parentClaimId],
      workspace,
    );

    // After the fix: exit 0, echoing A's already-issued 1.1 delegation, anchored
    // on A. Before the fix the seam anchors the active default `other` run — which
    // A's claim holds no grant for — and refuses `claim_grant_required` (exit 1).
    expect(delegated.exitCode).toBe(0);
    const action = findActionOutput<{ action: string; parent_run_id: string }>(delegated.stdout);
    expect(action).not.toBeNull();
    expect(action!.action).toBe('already-delegated');
    expect(action!.parent_run_id).toBe(parentRunId);
  }, 20_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rundown-org/cli exec jest delegate-workflow.test.ts -t "anchors on the claim"`

Expected: FAIL on `expect(delegated.exitCode).toBe(0)` — before the Task 1 fix, `delegate --claim-id <A>` anchors on the active `other` run, the gate rejects A's claim against it, and the command exits 1 with a `CLAIM_GRANT_REQUIRED` envelope (so `findActionOutput` finds no `already-delegated` action either).

> **NOTE for reviewers running tasks out of order:** if Task 1 is already merged, this test PASSES immediately (it is a regression guard, not a red→green driver in that ordering). Run it against `main`-before-Task-1 to see the red.

- [ ] **Step 3: Confirm the fix makes it pass**

With Task 1's production change in place, run:

Run: `pnpm --filter @rundown-org/cli exec jest delegate-workflow.test.ts -t "anchors on the claim"`

Expected: PASS.

- [ ] **Step 4: Run the surrounding integration suites for regression**

Run: `pnpm --filter @rundown-org/cli exec jest delegate-workflow.test.ts`
Run: `pnpm --filter @rundown-org/cli exec jest __tests__/integration/explicit-run-targeting.test.ts`

Expected: PASS. `explicit-run-targeting` is the suite that exercises `--run`-selector and claim-target semantics end-to-end; it confirms the `--run`-only and active-default paths are unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/__tests__/integration/delegate-workflow.test.ts
git commit -m "test(cli): pin claim-anchored delegate issuance end-to-end (#586)"
```

---

## Task 3: Full verification and issue closure

**Files:** none (verification + docs/issue admin).

- [ ] **Step 1: Run the pre-PR verification gate**

Run: `pnpm run verify`

Expected: PASS (format, spell, lint, unit tests across all packages). This is the mandatory pre-push gate per CLAUDE.md.

- [ ] **Step 2: Run the changed-file mutation gate on the core seam (recommended)**

Run: `pnpm run test:mutate:core -- --mutate packages/core/src/runbook/lifecycle-command-service.ts --testFiles packages/core/__tests__/runbook/lifecycle-command-service.test.ts`

Expected: both new guards on the anchor branch are killed. The `callerEvidence.kind === 'claim_bearer'` guard is killed by the fresh claim-anchoring test (non-claim evidence falls through). The `target.kind === 'claim'` guard — specifically the ConditionalExpression `→ true` mutant, which is only observable when a `claim_bearer` resolves to `terminal_claim`/`stale_claim` — is killed by the REQUIRED terminal-claim fall-through test (Task 1 Step 1); a case that only ever presents a live `claim` resolution would NOT kill it, which is why that fall-through test is required rather than optional. If any mutant still survives on the branch, do not paper over it — add the specific input (terminal vs stale vs stashed) that makes the forced-branch observable.

- [ ] **Step 3: Close #586 via the PR**

The PR description should include `Closes #586`. Note in the PR body that this discharges one of the two remaining code leaves in cluster #565 (R4 Capability Tier); #519 (parent-side abandoned/idle claim detection) and the #574 design umbrella remain open, so #565 stays open. Do NOT edit the epic (#564) or cluster (#565) roadmap status in this PR beyond referencing #586 — roadmap status is owned by those issues and updated when the cluster's remaining leaves land.

---

## Self-Review

- **Spec coverage.** Acceptance criterion 1 (`delegate --claim-id A`, no `--run`, issues from A when A is controlled-but-not-active) → Task 1 fresh unit test + Task 2 integration test; the retry-step path (same root cause) → Task 1 Step 5 retry unit test. Criterion 2 (new core unit + CLI integration coverage) → Task 1 (three unit tests) and Task 2. Criterion 3 (existing `--run`-only and bare/active behavior preserved) → the branch is additive and returns first for `--run`; verified by the terminal-claim fall-through test (Task 1 Step 1), the full seam + delegation suites (Task 1 Steps 8-9), and Task 2 Step 4 (`explicit-run-targeting`). Root-cause completeness: all three `#resolveIssuanceAnchor` call sites that fall back to `getActive()` (fresh + retry step/active) are fixed; the retry token locator is correctly excluded (it never calls the method).
- **Placeholder scan.** No `TODO`/`TBD`/"handle edge cases" — every code step shows the exact edit or test. The one step that resolves a fixture by grep (Task 1 Step 5's retry setup) points at a concrete existing test to mirror rather than leaving the setup unspecified.
- **Type consistency.** `#resolveIssuanceAnchor` keeps its exact return union; the parameter is REQUIRED (`callerEvidence: CallerEvidence`), and all three anchor call sites pass `input.callerEvidence` (available on both the `fresh` and `retry` variants of `DelegationIssuanceInput`), so a missed site is a compile error, not a silent behavior change. The claim branch dispatches on `resolveCommandTarget`'s `CommandTargetResolution.kind` (`'claim'`), whose `claim` variant carries `state` (confirmed at `command-target-resolver.ts:285`). `runControlEvidence` returns `{ kind: 'claim_bearer', claimId }` (test `:209-215`), matching the branch's `callerEvidence.kind === 'claim_bearer'` narrowing to `.claimId`. Direct object literal `{ claimId: callerEvidence.claimId }` is correct (not the `...(claimId ? {} : {})` spread the transition commands use — those spread because both `claimId` and `runId` are conditionally-present; here `.claimId` is unconditionally present inside the `claim_bearer` narrow).
