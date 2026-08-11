# Atomic `stash --claim-id` Implementation Plan (#666)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `rundown stash --claim-id` verify the presented bearer inside the same SQLite transaction that writes the stash slot, so a bearer that was rotated, tombstoned, or superseded after resolution can no longer commit a stash under dead authority.

**Architecture:** Add `SessionService.stashForClaimId(claimId)` modelled on the existing `unstashForClaimId` — parse the bearer once, use it in the `mutateSessionGuarded` affected-run selector, then verify the secret, classify the claim, and write the stash slot all inside one transaction. Rewire the CLI's `--claim-id` path to call it directly instead of using `resolveCommandTarget` as mutation authority, with a refusal mapper mirroring `claimPopRefusal`. The bare (non-claim) stash path is untouched.

**Tech Stack:** TypeScript (NodeNext ESM), XState-backed core, SQLite store (`node:sqlite` / sql.js drivers), Jest, Commander, Biome + ESLint, Stryker.

## Global Constraints

- Correctness > type safety > clean architecture > test coverage. Never paper over a state-machine or store gap in the CLI.
- The CLI is a thin wrapper. Runbook/session logic lives in `@rundown-org/core`; the CLI invokes it and renders the result.
- Never migrate persisted state. This change adds no persisted field, so nothing to migrate.
- JSON is the default CLI output; `--text` is human-only. New CLI tests assert the JSON envelope first.
- `pnpm run verify` MUST pass before any push. Scoped `jest` runs are not a substitute (cspell + typed ESLint only run there).
- Biome owns TS/JS/JSON; Prettier owns Markdown only. **Never run `prettier` on TypeScript.** Use `npx biome check --config-path=. --write <files>` for TS, `pnpm run format` for Markdown.
- All exported symbols need TSDoc: description, `@param` for every parameter, `@returns` when non-void, `@throws` when it can throw.
- Use `isError()` / `getErrorMessage()` from core, never `Error.isError()` directly.
- Branch: `issue-666/atomic-stash-for-claim-id` in the worktree at `.claude/worktrees/issue-666-atomic-stash-claim`. Run everything from there; never `cd` to the main checkout.
- Never use bare `git stash` / `git stash pop` — the stash stack is shared across worktrees.

## Design decisions that deviate from the issue text

These are deliberate and were established by auditing the code. Do not "restore" the issue's wording.

1. **No `claim_generation` capture.** The issue says to "capture and check the generation". The cited template, `unstashForClaimId`, does not do this, and does not need to: `mutateSessionGuarded` runs `BEGIN IMMEDIATE`, so verifying the bearer and writing the slot in one callback leaves no window for rotation to interleave. A generation capture would be redundant machinery guarding a window that no longer exists. (`ctx.commitRow(...).claimGeneration` and `captureAuthority(ctx.tx, ...)` are both available if a future change needs it; neither is used here.)
2. **No new error code.** `CLAIMED_RUNBOOK_UNAVAILABLE` and `DELEGATION_SUPERSEDED` are already registered in `CLISymbolicErrorCodeValues`, and `describeSupersededClaim` already maps `claim-rotated` → `CLAIMED_RUNBOOK_UNAVAILABLE` while reserving `DELEGATION_SUPERSEDED` (RD-825, no-retry) for parent-moved causes. `docs/reference/cli.md:813-825` already documents exactly this split. Reusing pop's mapper produces the correct codes with no registry change.
3. **Two claim kinds, not one.** `unstashForClaimId` returns `child-linkage-mismatch` when `!claim.delegation`, so pop supports delegated claims only. `stash --claim-id` also accepts a **run-control** bearer (pinned by `session-service.test.ts:656`, which shows `getActiveForClaimId`'s non-delegated early return). `stashForClaimId` must therefore guard the linkage and delegation-liveness checks on `claim.delegation` being present. An unguarded copy of pop's body would refuse every orchestrator stash — a regression.
4. **The claim record is left untouched.** `unstashForClaimId` calls `ctx.touchClaimUpdatedAt` + `refreshedClaimRecord`; `stashForClaimId` must not. `docs/reference/cli.md:755` promises stash "preserv[es] the claim record", and `claim-seen-drift-guard.test.ts` classifies `stash` as non-recording. A pure slot write keeps both true.
5. **Targeting is implied, not re-derived.** `stashRunbook`'s `targetedByClaim` check asks whether *some* claim controls the run. Once the presented bearer is verified against an active claim, that claim controls `claim.controlledRunId` by construction, so the check is trivially satisfied and is not reproduced. The default-stack filter *is* reproduced, because a run-control-claimed run is stack-resident and must leave the stack when stashed.
6. **Out of scope:** `resolveCommandTarget` never runs `claimAuthorizesRunMutation`, so neither stash nor pop checks claim *grants*. That is an authorization gap, distinct from this issue's atomicity gap, and pop has it too. Do not fix it here.
7. **The `liveness.kind === 'closed'` arm is defence in depth and is expected to be hard to reach.** Closing a delegation while the claim row is still active requires the parent-side latch to defer its tombstone, which it only does when the child is execution-owned — and `mutateSessionGuarded` refuses an owned run first. `unstashForClaimId` carries the identical arm for the identical reason. Keep it for symmetry and for the case where a future latch change makes it reachable; do not delete it to chase a mutation survivor, and do not fabricate a test that reaches it by writing raw SQL the production path cannot produce.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `packages/core/src/runbook/session-service.ts` | Modify | Add `StashForClaimIdResult` type + `stashForClaimId` method. `stashRunbook` / `stash` untouched. |
| `packages/core/src/runbook/index.ts` | Modify (`:101-111`) | Export `type StashForClaimIdResult` from the explicit barrel list. |
| `packages/core/__tests__/runbook/session-service.test.ts` | Modify | New `describe('stashForClaimId', …)` inside `claim-id runbook targeting`, immediately before `:1355`. |
| `packages/cli/src/commands/stash.ts` | Modify | Add `claimStashRefusal`; split the action into claim path (atomic core call) and bare path (`getActive` + `stashRunbook`). |
| `packages/cli/__tests__/commands/stash-pop.test.ts` | Modify | New `--claim-id` rotation + refusal tests, JSON envelope. |
| `docs/reference/cli.md` | Modify | `:755` row wording; the stash prose at `:546-552`. |
| `docs/spec/cli-output.md` | Modify | New `stash --claim-id` refusal subsection under `## stash`. |

---

### Task 1: Core — atomic `stashForClaimId`

**Files:**
- Modify: `packages/core/src/runbook/session-service.ts` (add type near `UnstashForClaimIdResult` at `:166-190`; add method after `stashRunbook`, which ends at `:1440`)
- Modify: `packages/core/src/runbook/index.ts:101-111`
- Test: `packages/core/__tests__/runbook/session-service.test.ts`

**Interfaces:**
- Consumes: `parseClaimBearer`, `verifyClaimSecret`, `linkageMatchesClaim`, `classifyDelegationLiveness`, `this.describeSupersession`, `this.mutateGuarded` — all already imported/defined in `session-service.ts`.
- Produces: `StashForClaimIdResult` (9 variants, below) and
  `stashForClaimId(claimId: ClaimId): Promise<SessionMutationResult<StashForClaimIdResult>>`.
  Task 2 imports both from `@rundown-org/core`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/__tests__/runbook/session-service.test.ts`, inside the existing `describe('claim-id runbook targeting', …)` block, immediately before the test at `:1355` (`stash preserves a claim record and unstashForClaimId restores only the matching child`). The surrounding block already has `manager`, `sessionService`, `mockRunbook`, `holdExecutionLease`, and the `claim-test-helpers` imports in scope.

```ts
    describe('stashForClaimId', () => {
      it('refuses a bearer rotated after resolution and leaves the stash slot untouched', async () => {
        // The #666 interleave: resolve with the old bearer, mint a replacement
        // for the same run, then stash with the old bearer. Before this method
        // existed the stash committed, because `stashRunbook` authorised on the
        // run id alone and `mintRunControlClaim` keeps the run claim-targeted.
        const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
          runbookPath: 'solo.md',
        });
        const { claimId: oldBearer } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(run.id),
        );

        expect((await sessionService.getActiveForClaimId(oldBearer)).status).toBe('claimed');

        unwrapSessionMutation(await sessionService.issueRunControlClaim(run.id));

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(oldBearer));

        expect(result).toEqual({
          status: 'superseded',
          claimId: oldBearer,
          reason: 'claim-rotated',
        });
        const session = await manager.loadSession();
        expect(session.stashedRunbookId).toBeUndefined();
        expect(session.defaultStack).toEqual([run.id]);
      });

      it('stashes a run-control claim and takes its run off the default stack', async () => {
        const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
          runbookPath: 'solo.md',
        });
        const { claimId } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(run.id),
        );

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(claimId));

        expect(result.status).toBe('stashed');
        if (result.status === 'stashed') {
          expect(result.state.id).toBe(run.id);
          expect(result.claim.controlledRunId).toBe(run.id);
        }
        const session = await manager.loadSession();
        expect(session.stashedRunbookId).toBe(run.id);
        expect(session.defaultStack).toEqual([]);
      });

      it('stashes a delegated child and preserves its claim record unchanged', async () => {
        const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
          runbookPath: 'parent.md',
        });
        const linkage = linkageFor(parent.id, 'a');
        const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
          runbookPath: 'child.md',
          parentLinkage: linkage,
        });
        const claimed = assertClaimed(
          await claimLiveDelegation(sessionService, manager, child.id, linkage),
        );
        const before = (await manager.loadSession()).claims[claimed.claim.claimKey];

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(claimed.claimId));

        expect(result.status).toBe('stashed');
        const session = await manager.loadSession();
        expect(session.stashedRunbookId).toBe(child.id);
        // `stash --claim-id` preserves the claim record (#519 non-recording).
        expect(session.claims[claimed.claim.claimKey]).toEqual(before);
      });

      it('refuses a delegated child whose parent moved past the delegation', async () => {
        const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
          runbookPath: 'parent.md',
        });
        const linkage = linkageFor(parent.id, 'b');
        const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
          runbookPath: 'child.md',
          parentLinkage: linkage,
        });
        const claimed = assertClaimed(
          await claimLiveDelegation(sessionService, manager, child.id, linkage),
        );
        // The child is not execution-owned, so the parent-side latch tombstones
        // the claim as the parent's cursor advances. The bearer then lands on the
        // tombstone arm and must be named superseded, not unknown.
        await manager.update(parent.id, { step: '2' });

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(claimed.claimId));

        expect(result).toEqual({
          status: 'superseded',
          claimId: claimed.claimId,
          reason: 'cursor-advanced',
        });
        expect((await manager.loadSession()).stashedRunbookId).toBeUndefined();
      });

      it('refuses an execution-owned run before deciding anything about the bearer', async () => {
        const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
          runbookPath: 'solo.md',
        });
        const { claimId } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(run.id),
        );
        holdExecutionLease(run.id);

        const outcome = await sessionService.stashForClaimId(claimId);

        expect(outcome.kind).toBe('execution_in_progress');
        expect((await manager.loadSession()).stashedRunbookId).toBeUndefined();
      });

      it('reports an unknown bearer as missing-claim without touching the slot', async () => {
        const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
          runbookPath: 'solo.md',
        });
        unwrapSessionMutation(await sessionService.pushRunbookWithRunControlClaim(run.id));

        const unknown = assertClaimId(
          `rdclm_${'0'.repeat(32)}_${'A'.repeat(43)}` satisfies string,
        );
        const result = unwrapSessionMutation(await sessionService.stashForClaimId(unknown));

        expect(result).toEqual({ status: 'missing-claim', claimId: unknown });
        expect((await manager.loadSession()).stashedRunbookId).toBeUndefined();
      });

      it('separates re-stashing the same claim from a slot held by another run', async () => {
        const first = await manager.create({ source: 'project', path: 'a.md' }, mockRunbook, {
          runbookPath: 'a.md',
        });
        const second = await manager.create({ source: 'project', path: 'b.md' }, mockRunbook, {
          runbookPath: 'b.md',
        });
        const { claimId: firstClaim } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(first.id),
        );
        const { claimId: secondClaim } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(second.id),
        );

        unwrapSessionMutation(await sessionService.stashForClaimId(firstClaim));

        const again = unwrapSessionMutation(await sessionService.stashForClaimId(firstClaim));
        expect(again.status).toBe('already-stashed');

        const blocked = unwrapSessionMutation(await sessionService.stashForClaimId(secondClaim));
        expect(blocked.status).toBe('slot-occupied');
        if (blocked.status === 'slot-occupied') {
          expect(blocked.stashedRunbookId).toBe(first.id);
        }
        expect((await manager.loadSession()).stashedRunbookId).toBe(first.id);
      });

      it('refuses a terminal child', async () => {
        const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
          runbookPath: 'solo.md',
        });
        const { claimId } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(run.id),
        );
        await manager.update(run.id, { lifecycle: 'completed' });

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(claimId));

        expect(result.status).toBe('terminal-child');
        if (result.status === 'terminal-child') {
          expect(result.lifecycle).toBe('completed');
        }
        expect((await manager.loadSession()).stashedRunbookId).toBeUndefined();
      });
    });
```

`assertClaimId` is already imported at the top of this file (`:9`). If the malformed-bearer literal in the `missing-claim` test trips `assertClaimId`, replace it with a bearer minted for a throwaway run that is then released — the assertion is about an unknown key, not about the literal.

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/session-service.test.ts -t "stashForClaimId"
```
Expected: FAIL — `sessionService.stashForClaimId is not a function` (and a TS error that the property does not exist).

- [ ] **Step 3: Add the result type**

In `packages/core/src/runbook/session-service.ts`, immediately after the `UnstashForClaimIdResult` declaration (ends `:190`):

```ts
/**
 * Result of stashing a claimed runbook by explicit claim id.
 *
 * Mirrors {@link UnstashForClaimIdResult}, with two stash-specific refusals in
 * place of `not-stashed`: `already-stashed` (the slot already holds this
 * claim's own run) and `slot-occupied` (it holds a different run).
 */
export type StashForClaimIdResult =
  | { readonly status: 'stashed'; readonly claim: ClaimRecord; readonly state: RunbookState }
  | { readonly status: 'missing-claim'; readonly claimId: ClaimId }
  | { readonly status: 'already-stashed'; readonly claim: ClaimRecord }
  | {
      readonly status: 'slot-occupied';
      readonly claim: ClaimRecord;
      readonly stashedRunbookId: RunId;
    }
  | { readonly status: 'missing-child'; readonly childRunId: RunId }
  | {
      readonly status: 'terminal-child';
      readonly claim: ClaimRecord;
      readonly lifecycle: 'completed' | 'stopped';
    }
  | { readonly status: 'child-linkage-mismatch'; readonly claim: ClaimRecord }
  | { readonly status: 'parent-missing'; readonly claim: ClaimRecord }
  | {
      readonly status: 'superseded';
      readonly claimId: ClaimId;
      readonly reason: ClaimSupersededReason;
    };
```

- [ ] **Step 4: Add the method**

In the same file, immediately after `stashRunbook` (ends `:1440`) and before `unstashForClaimId`:

```ts
  /**
   * Stash a claimed runbook by explicit claim id, atomically.
   *
   * The presented bearer is verified inside the same transaction that writes the
   * stash slot. `stashRunbook` authorises on the run id alone — it asks only
   * whether *some* claim controls the run — so a bearer rotated between an
   * unlocked resolve and the commit still succeeded (#666). Resolving and
   * committing in one `mutateSessionGuarded` cycle removes that window by
   * construction; there is no captured generation to re-check because there is
   * no gap for a rotation to land in.
   *
   * Unlike {@link unstashForClaimId}, the linkage and delegation-liveness checks
   * are guarded on `claim.delegation`: `stash --claim-id` accepts a run-control
   * bearer as well as a delegated one, and `linkageMatchesClaim` reports `false`
   * for a claim with no delegation.
   *
   * The claim record is deliberately left untouched — stash preserves it, and
   * the command is classified non-recording (#519).
   *
   * @param claimId - Bearer claim id for the runbook to stash
   * @returns Discriminated stash result describing success or the refusal reason.
   *   Refused `execution_in_progress` or `recovery_required` instead when the
   *   run is execution-owned or awaiting recovery; the value is absent then.
   */
  async stashForClaimId(claimId: ClaimId): Promise<SessionMutationResult<StashForClaimIdResult>> {
    // Hoisted out of the callback so the affected-run selector reads the same
    // parsed bearer the mutation does; the slot write is guarded against the
    // claim's controlled run.
    const parsed = parseClaimBearer(claimId);
    const affectedRun = (session: SessionData): readonly RunId[] => {
      if (!Object.hasOwn(session.claims, parsed.claimKey)) return [];
      const claim = session.claims[parsed.claimKey];
      return verifyClaimSecret(parsed.secret, claim.secretHash) ? [claim.controlledRunId] : [];
    };
    return this.mutateGuarded(affectedRun, (ctx): StashForClaimIdResult => {
      const { session } = ctx;
      if (!Object.hasOwn(session.claims, parsed.claimKey)) {
        // Same split as `unstashForClaimId`: a bearer the parent-side latch
        // tombstoned is superseded, not unknown. `ctx.claim` reads through the
        // open transaction, so the tombstone is read under the same snapshot.
        const presented = ctx.claim(parsed.claimKey);
        if (
          presented === null ||
          presented.status === 'active' ||
          !verifyClaimSecret(parsed.secret, presented.record.secretHash)
        ) {
          return { status: 'missing-claim', claimId };
        }
        const parentRunId = presented.record.delegation?.parentRunId;
        return {
          status: 'superseded',
          claimId,
          reason: this.describeSupersession(
            presented.record,
            parentRunId === undefined ? null : ctx.readState(parentRunId),
          ).reason,
        };
      }
      const claim = session.claims[parsed.claimKey];
      if (!verifyClaimSecret(parsed.secret, claim.secretHash)) {
        return { status: 'missing-claim', claimId };
      }
      // Split, where `stashRunbook` collapsed both into `null`: re-stashing the
      // caller's own parked run is a different mistake from colliding with
      // someone else's, and only the second is `ALREADY_STASHED`.
      if (session.stashedRunbookId === claim.controlledRunId) {
        return { status: 'already-stashed', claim };
      }
      if (session.stashedRunbookId !== undefined) {
        return { status: 'slot-occupied', claim, stashedRunbookId: session.stashedRunbookId };
      }

      const state = ctx.readState(claim.controlledRunId);
      if (!state) {
        // The claim's controlled run state cannot be read. The FK cascade deletes
        // a claim with its run, so this is not reachable through a supported
        // delete — but the caller-visible refusal taxonomy returns a typed
        // `missing-child` rather than throwing, so a corrupted database degrades
        // gracefully.
        return { status: 'missing-child', childRunId: claim.controlledRunId };
      }
      if (state.lifecycle === 'completed' || state.lifecycle === 'stopped') {
        return { status: 'terminal-child', claim, lifecycle: state.lifecycle };
      }
      if (claim.delegation) {
        if (!linkageMatchesClaim(state.parentLinkage, claim)) {
          return { status: 'child-linkage-mismatch', claim };
        }
        // Classified, not lifecycle-checked, for the reason given in
        // `getActiveForClaimId`: an active row whose delegation has closed must
        // still refuse, including the `cursor-advanced` case a lifecycle check
        // cannot see.
        const parent = ctx.readState(claim.delegation.parentRunId);
        const liveness = classifyDelegationLiveness(parent, claim.delegation);
        if (liveness.kind === 'parent-unreadable') {
          return { status: 'parent-missing', claim };
        }
        if (liveness.kind === 'closed') {
          return { status: 'superseded', claimId, reason: liveness.reason };
        }
      }

      // `stashRunbook`'s `targetedByClaim` arm is not reproduced: the verified
      // bearer's claim controls this run, so it is satisfied by construction.
      // The stack filter is reproduced — a run-control-claimed run is stack
      // resident and must leave the stack when it is parked.
      session.defaultStack = session.defaultStack.filter((id) => id !== claim.controlledRunId);
      session.stashedRunbookId = claim.controlledRunId;
      return { status: 'stashed', claim, state };
    });
  }
```

- [ ] **Step 5: Export the type from the barrel**

In `packages/core/src/runbook/index.ts`, add `type StashForClaimIdResult` to the existing explicit export list from `./session-service.js` (`:101-111`), keeping the list's alphabetical order — it goes immediately before `type UnstashForClaimIdResult`.

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/session-service.test.ts
```
Expected: PASS, all tests in the file (the pre-existing ones must stay green — `stashRunbook` and `stash()` were not modified).

- [ ] **Step 7: Confirm no core consumer regressed**

Run:
```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/lifecycle-command-service.test.ts __tests__/testing/session-fixtures.test.ts __tests__/runbook/storage/runbook-store.test.ts
```
Expected: PASS. In particular `lifecycle-command-service.test.ts:896` and `:1651` must stay green — they pin the *narrowed* best-effort revalidation and are unaffected by an additive method.

- [ ] **Step 8: Format, typecheck, commit**

```bash
npx biome check --config-path=. --write packages/core/src/runbook/session-service.ts packages/core/src/runbook/index.ts packages/core/__tests__/runbook/session-service.test.ts
pnpm --filter @rundown-org/core exec tsc --noEmit -p tsconfig.json
git add packages/core/src/runbook/session-service.ts packages/core/src/runbook/index.ts packages/core/__tests__/runbook/session-service.test.ts
git commit -m "feat(core): add atomic stashForClaimId with in-transaction bearer verification

Closes the eighth check-then-act path (#666): stash resolved the bearer in
an unlocked read and committed in a separate, bearer-blind transaction, so a
rotated bearer still stashed. Verification and the slot write now share one
mutateSessionGuarded cycle."
```

---

### Task 2: CLI — rewire `stash --claim-id` onto the atomic seam

**Files:**
- Modify: `packages/cli/src/commands/stash.ts` (whole action body)
- Test: `packages/cli/__tests__/commands/stash-pop.test.ts`

**Interfaces:**
- Consumes: `stashForClaimId`, `type StashForClaimIdResult` (Task 1); `describeSupersededClaim`, `redactClaimId`, `type StaleClaimRefusalCode`, `type ClaimId`, `type RunbookState` from `@rundown-org/core`; `renderSessionMutationRefusal`, `parseClaimIdOption`, `getStepTotal`, `buildMetadata`, `OutputEmitter`.
- Produces: nothing consumed by later tasks.

**Behaviour that must not change:** bare `stash` output and codes (`stash-pop.test.ts:95,106,115,124,130,143`, `output-format.test.ts:253/265/272/282` including the literal `'Runbook:  STASHED'`, `schema-validation.test.ts:545/556`); the command description `'Pause runbook enforcement, preserve state'` and the `--claim-id` help string `'Target a claimed delegated child runbook'` (`stash-pop.test.ts:48`, and the drift guard's reason text); `stash --claim-id` staying non-recording for `lastSeenAt`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('stash command', …)` block in `packages/cli/__tests__/commands/stash-pop.test.ts`. Add `issueRunControlClaimFor` to the existing `@rundown-org/core/testing/session-fixtures` import, and `parseConcatenatedJson` to the `../helpers/test-utils.js` import (it is already exported there; confirm the name before relying on it).

```ts
    it('refuses a rotated run-control bearer and leaves the stash slot empty', async () => {
      const runbookPath = await createRunbook(workspace, 'solo.runbook.md', ['First step']);
      const started = await runCliInProcess(['run', runbookPath], workspace);
      expect(started.exitCode).toBe(0);
      const startedEvent = parseConcatenatedJson(started.stdout).find(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' &&
          value !== null &&
          (value as { type?: unknown }).type === 'runbook_started',
      );
      const oldBearer = startedEvent?.claim_id;
      if (typeof oldBearer !== 'string') {
        throw new Error('Expected runbook_started to carry a claim_id');
      }
      const runId = (await readSession(workspace)).active;
      if (runId === null) throw new Error('Expected an active run');

      // Rotate: mint a replacement run-control claim for the same run. The old
      // bearer is now dead authority.
      await issueRunControlClaimFor(workspace.dir, runId);

      const result = await runCliInProcess(['stash', '--claim-id', oldBearer], workspace);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          kind: 'error',
          code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
          command: 'stash',
        }),
      );
      // The decisive assertion: the slot did not move.
      expect((await readSession(workspace)).stashed).toBeNull();
      // The bearer secret must never reach the transcript.
      expect(result.stdout).not.toContain(oldBearer.split('_')[2]);
    });

    it('stashes with a valid run-control bearer', async () => {
      const runbookPath = await createRunbook(workspace, 'solo.runbook.md', ['First step']);
      const started = await runCliInProcess(['run', runbookPath], workspace);
      const startedEvent = parseConcatenatedJson(started.stdout).find(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' &&
          value !== null &&
          (value as { type?: unknown }).type === 'runbook_started',
      );
      const bearer = startedEvent?.claim_id;
      if (typeof bearer !== 'string') {
        throw new Error('Expected runbook_started to carry a claim_id');
      }
      const runId = (await readSession(workspace)).active;

      const result = await runCliInProcess(['stash', '--claim-id', bearer], workspace);

      expect(result.exitCode).toBe(0);
      const session = await readSession(workspace);
      expect(session.stashed).toBe(runId);
      expect(session.active).toBeNull();
    });
```

`workspace.dir` is the project root property on the test workspace; confirm its exact name in `createTestWorkspace` and use whatever it is called.

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
pnpm --filter @rundown-org/cli exec jest __tests__/commands/stash-pop.test.ts -t "rotated run-control bearer"
```
Expected: FAIL — the stash commits, so `exitCode` is 0 and `session.stashed` is the run id. This is the #666 defect reproduced at the CLI boundary.

- [ ] **Step 3: Add the refusal mapper**

In `packages/cli/src/commands/stash.ts`, replace the import block and add the mapper above `registerStashCommand`:

```ts
import type { Command } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  describeSupersededClaim,
  redactClaimId,
  type ClaimId,
  type RunbookState,
  type StaleClaimRefusalCode,
  type StashForClaimIdResult,
} from '@rundown-org/core';
import { getCwd, getStepTotal } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';
import { renderSessionMutationRefusal } from '../helpers/session-mutation-result.js';

/** Symbolic codes `stash --claim-id` can refuse with. */
type StashRefusalCode = StaleClaimRefusalCode | 'ALREADY_STASHED';

/**
 * Map a non-success `stashForClaimId` result to its user-facing envelope.
 *
 * Mirrors `claimPopRefusal` in `pop.ts`, including its RD-825 handling: core
 * owns the superseded wording and code, so a superseded bearer carries the
 * no-retry signal rather than a generic unavailable envelope.
 *
 * @param claimId - Bearer the caller presented; only its redacted key is shown
 * @param result - The refusal arm returned by `stashForClaimId`
 * @returns Message and symbolic code for `OutputEmitter.error`
 */
function claimStashRefusal(
  claimId: ClaimId,
  result: Exclude<StashForClaimIdResult, { status: 'stashed' }>,
): { readonly message: string; readonly code: StashRefusalCode } {
  // User- and log-facing refusal: identify the claim by its non-secret lookup
  // key, never the bearer `claimId` (which carries the live secret segment).
  const claimKey = redactClaimId(claimId);
  const unavailable = (message: string) =>
    ({ message, code: 'CLAIMED_RUNBOOK_UNAVAILABLE' }) as const;
  switch (result.status) {
    case 'missing-claim':
      return unavailable(`Claim id ${claimKey} does not exist.`);
    case 'missing-child':
      return unavailable(
        `Claim id ${claimKey} no longer has readable child runbook state. Recover with \`rundown prune\` and restart from source.`,
      );
    case 'already-stashed':
      // Same wording the target resolver used before this path became atomic,
      // so a caller re-stashing its own parked run sees no change.
      return unavailable(
        `Claim id ${claimKey} is currently stashed. Run \`rundown pop\` with its claim id to resume.`,
      );
    case 'slot-occupied':
      return { message: 'A runbook is already stashed. Pop it first.', code: 'ALREADY_STASHED' };
    case 'terminal-child':
      return unavailable(`Claim id ${claimKey} points at a ${result.lifecycle} child runbook.`);
    case 'child-linkage-mismatch':
      return unavailable(`Claim id ${claimKey} is no longer linked to its child runbook.`);
    case 'parent-missing':
      return unavailable(`Claim id ${claimKey} parent runbook is missing.`);
    case 'superseded':
      return describeSupersededClaim(claimKey, result.reason);
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}
```

- [ ] **Step 4: Rewire the action**

Replace the body of `.action(...)` in `registerStashCommand` (currently `stash.ts:22-98`) with:

```ts
    .action(async (options: { claimId?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text, command: 'stash' });
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const claimTarget = parseClaimIdOption(options.claimId, output);
          if (!claimTarget.ok) return;

          let state: RunbookState;
          if (claimTarget.claimId !== undefined) {
            // Bearer as mutation authority: core verifies it inside the same
            // transaction that writes the stash slot. Deliberately NOT
            // `resolveCommandTarget` — that resolves in a separate, unlocked
            // read, which is the #666 defect.
            const stashResult = await sessionService.stashForClaimId(claimTarget.claimId);
            if (stashResult.kind !== 'committed') {
              renderSessionMutationRefusal(output, stashResult);
              output.flush();
              process.exitCode = 1;
              return;
            }
            const stashed = stashResult.value;
            if (stashed.status !== 'stashed') {
              const refusal = claimStashRefusal(claimTarget.claimId, stashed);
              output.error(refusal.message, refusal.code);
              output.flush();
              process.exitCode = 1;
              return;
            }
            state = stashed.state;
          } else {
            const active = await sessionService.getActive();
            if (!active) {
              output.noActiveRunbook();
              output.flush();
              return;
            }
            const stashResult = await sessionService.stashRunbook(active.id);
            if (stashResult.kind !== 'committed') {
              renderSessionMutationRefusal(output, stashResult);
              output.flush();
              process.exitCode = 1;
              return;
            }
            if (stashResult.value === null) {
              output.error('A runbook is already stashed. Pop it first.', 'ALREADY_STASHED');
              output.flush();
              process.exitCode = 1;
              return;
            }
            state = active;
          }

          const totalSteps = await getStepTotal(cwd, state.runbook);

          // Emit structured output - TextRenderer handles stash action specially
          output.metadata(buildMetadata(state));
          output.status('stash', 'Runbook stashed', {
            position: {
              current: state.step,
              total: totalSteps,
            },
            stashedId: state.id,
          });
          output.flush();
        },
        { text: options.text },
      );
    });
```

Note `stashedId` is now `state.id` rather than the value echoed back by the store; they are the same id on every success path.

- [ ] **Step 5: Run the new tests to verify they pass**

Run:
```bash
pnpm --filter @rundown-org/cli exec jest __tests__/commands/stash-pop.test.ts
```
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Run the full CLI guard set**

Run:
```bash
pnpm --filter @rundown-org/cli exec jest __tests__/commands/output-format.test.ts __tests__/commands/schema-validation.test.ts __tests__/commands/status.test.ts __tests__/helpers/claim-seen-drift-guard.test.ts __tests__/commands/command-test-mutation-linkage.test.ts __tests__/cli.test.ts __tests__/integration.test.ts
```
Expected: PASS. The drift guard is the sharpest of these: `stash --claim-id` must still not move `lastSeenAt`, and the stash/pop loop test at `:607` must still see `updatedAt` change (pop still writes it) while stash leaves the record alone.

- [ ] **Step 7: Format, typecheck, commit**

```bash
npx biome check --config-path=. --write packages/cli/src/commands/stash.ts packages/cli/__tests__/commands/stash-pop.test.ts
pnpm --filter @rundown-org/cli exec tsc --noEmit -p tsconfig.json
git add packages/cli/src/commands/stash.ts packages/cli/__tests__/commands/stash-pop.test.ts
git commit -m "fix(cli): present the stash bearer as mutation authority, not a target selector

stash --claim-id now commits through the atomic stashForClaimId seam with a
refusal mapper mirroring claimPopRefusal. The bare stash path is unchanged."
```

---

### Task 3: Documentation

**Files:**
- Modify: `docs/reference/cli.md:755` (table row) and `:546-552` (stash prose)
- Modify: `docs/spec/cli-output.md` (`## stash` section, around `:695-698`)

**Interfaces:** none — documentation only.

No error-code registration is needed (see Design decision 2). `docs-error-code-drift.repo-asset.test.ts` scans ```json fences in `docs/spec/cli-output.md` and requires documented ⊆ registered; every code used here is already registered, so any fence added below is safe. `check:docs:cli-help` is unaffected because neither the command description nor any option string changed.

- [ ] **Step 1: Update the `--claim-id` table row**

In `docs/reference/cli.md`, replace the `stash --claim-id` row (`:755`):

```markdown
| `rundown stash --claim-id <claim_id>`                      | Bearer-authorized stash of a claimed runbook, preserving the claim record         |
```

- [ ] **Step 2: Document the claim semantics in the stash prose**

In `docs/reference/cli.md`, after the `#### rundown stash - Pause Enforcement` block (`:546-552`), add:

```markdown
With `--claim-id`, the bearer is mutation authority, not a target selector: it
is verified inside the same transaction that writes the stash slot, so a bearer
that was rotated, released, or superseded refuses rather than parking a runbook
under authority that has ended. A superseded delegation reports
`DELEGATION_SUPERSEDED` with the RD-825 no-retry instruction; a rotated or
released claim reports `CLAIMED_RUNBOOK_UNAVAILABLE`. The claim record itself is
preserved across a stash.
```

- [ ] **Step 3: Document the refusal envelope in the output spec**

In `docs/spec/cli-output.md`, extend the `### rundown stash --claim-id <claim_id>` subsection (`:695-698`) so it reads:

````markdown
### rundown stash --claim-id <claim_id>

Same output shape as `rundown stash`, but stashes the runbook identified by
`claim_id`. The bearer is verified inside the transaction that writes the stash
slot, so a rotated, released, or superseded bearer refuses and the slot is left
unchanged.

**JSON (rotated or released bearer):**

```json
{
  "kind": "error",
  "error": "Claim id rdclk_3668bda31850ba84c2c1bb9a991a2d33 was released or replaced and is no longer authority. Claim the parent's current delegation instead of reusing this id.",
  "code": "CLAIMED_RUNBOOK_UNAVAILABLE",
  "command": "stash"
}
```
````

- [ ] **Step 4: Format and verify the docs gate**

```bash
pnpm run format
pnpm --filter @rundown-org/core exec jest __tests__/output/docs-error-code-drift.repo-asset.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/reference/cli.md docs/spec/cli-output.md
git commit -m "docs: describe bearer-authorized stash and its refusal envelope"
```

---

### Task 4: Full verification and mutation coverage

**Files:** none modified unless a gate fails.

- [ ] **Step 1: Run the pre-PR gate**

Run:
```bash
pnpm run verify
```
Expected: PASS. This is the only run that exercises cspell and typed ESLint (`jsdoc/require-throws` and friends), so a change can be green in every scoped suite and still fail here. If cspell flags a new term, add it to `cspell-dictionary.txt` rather than rewording prose that is technically correct.

- [ ] **Step 2: Mutation-test the changed lines**

Run:
```bash
pnpm run test:mutate:changed
```
Expected: no Survived or NoCoverage mutants **inside the changed ranges**. Judge on in-range survivors only — the aggregate percentage is meaningless at this scope and the 70% break threshold will fail regardless.

Read survivors correctly: this runner scopes each file to its dedicated unit test, so a mutant killed only by an integration test reports as a survivor. That is the intended reading. If a survivor looks like it is covered elsewhere, confirm with:
```bash
pnpm run test:mutate:changed --related-tests
```
before concluding the test is missing.

Likely survivor sites to check deliberately, and the assertion that kills each:
- the `session.stashedRunbookId === claim.controlledRunId` vs `!== undefined` split — killed by the `already-stashed` / `slot-occupied` test
- the `claim.delegation` guard — killed by the run-control success test (removing the guard makes it refuse `child-linkage-mismatch`)
- the `defaultStack.filter` — killed by the run-control test's `expect(session.defaultStack).toEqual([])`
- `presented.status === 'active'` in the tombstone split — killed by the rotation test

Expected and acceptable survivors: mutants inside the `liveness.kind === 'parent-unreadable'` / `'closed'` arms, for the reason in Design decision 7. Record them in the report rather than deleting the arms or writing raw-SQL fixtures to reach them.

- [ ] **Step 3: Confirm the defect is actually closed**

Re-read the two evidence assertions and confirm they are present and passing:
- `packages/core/__tests__/runbook/session-service.test.ts` — "refuses a bearer rotated after resolution and leaves the stash slot untouched"
- `packages/cli/__tests__/commands/stash-pop.test.ts` — "refuses a rotated run-control bearer and leaves the stash slot empty"

Both must assert the typed/JSON refusal **and** that the stash slot is unchanged. A refusal without the slot assertion does not demonstrate the fix.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin issue-666/atomic-stash-for-claim-id
gh pr create --title "fix(core,cli): verify the stash bearer in the transaction that writes the slot (#666)" --body "$(cat <<'EOF'
## Summary

`stash --claim-id` resolved the presented bearer in an unlocked read and then mutated the stash slot in a separate transaction that never checked which claim was presented. A bearer rotated between resolve and commit still succeeded.

`SessionService.stashForClaimId` now verifies the bearer inside the same `mutateSessionGuarded` transaction that writes the slot, and the CLI presents the bearer as mutation authority instead of using `resolveCommandTarget` as a target selector.

## Evidence

Deterministic rotation interleave, core and CLI: the old bearer resolves, a replacement is minted for the same run, the old bearer attempts to stash, and the stash refuses with the typed result while the slot stays unchanged.

## Notes

- No `claim_generation` capture: atomicity comes from the single transaction, matching `unstashForClaimId`. There is no window left for a rotation to land in.
- No new error code: `CLAIMED_RUNBOOK_UNAVAILABLE` / `DELEGATION_SUPERSEDED` already cover this, and `docs/reference/cli.md` already documented the split.
- Unlike pop, the linkage and liveness checks are guarded on `claim.delegation`, because `stash --claim-id` also accepts a run-control bearer.
- Bare `stash`, `stashRunbook`, and `stash()` are unchanged.

Closes #666.
EOF
)"
```

---

## Self-Review

**Spec coverage.** Issue scope item by item: atomic `stashForClaimId` under one guarded transaction — Task 1. Typed refusal union mirroring `UnstashForClaimIdResult`, refusing rotated/removed/superseded/mismatched bearers — Task 1 Step 3. Rewire `stash.ts` off `resolveCommandTarget` with a mapper mirroring `claimPopRefusal` and preserving `describeSupersededClaim`'s RD-825 signal — Task 2 Steps 3-4. Retain bare stash behaviour and `session-fixtures.ts` — Task 2 Step 4 (bare branch) and Task 1 (`stashRunbook` untouched). Error code wired — Design decision 2: none needed, documented instead. `docs/reference/cli.md:755` — Task 3 Step 1. `stash-pop.test.ts` — Task 2 Step 1. Required evidence (deterministic rotation interleave, one core + one CLI test) — Task 1 Step 1 and Task 2 Step 1, re-confirmed at Task 4 Step 3.

Two scope items are deliberately not implemented as written, with reasons in "Design decisions": the generation capture, and the new error code. One scope item is added that the issue does not mention: the `claim.delegation` guard, without which the run-control bearer path regresses.

**Type consistency.** `StashForClaimIdResult` is spelled identically in Task 1 (declaration, barrel export) and Task 2 (import, `Exclude<…, { status: 'stashed' }>`). The success arm is `'stashed'` everywhere. `slot-occupied` carries `stashedRunbookId`, read only in the core test. `already-stashed` carries `claim` only, and the mapper does not read it. `StashRefusalCode` widens `StaleClaimRefusalCode` with `'ALREADY_STASHED'`, which `OutputEmitter.error` accepts as a bare `string`.

**Unverified details flagged for the implementer:** the exact name of the workspace root property (`workspace.dir`) in Task 2 Step 1, the export name `parseConcatenatedJson` in `test-utils.ts`, and whether the literal malformed bearer in Task 1's `missing-claim` test satisfies `assertClaimId`. Each has an inline instruction to confirm and adapt.
