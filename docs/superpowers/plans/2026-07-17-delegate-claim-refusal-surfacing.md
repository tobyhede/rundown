# Delegate Claim-Refusal Surfacing — Handoff & Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish #586 by making `rundown delegate --claim-id <A>` surface the *real* claim problem (stale / stashed / terminal) instead of discarding it and refusing with a misleading error about a run the operator never named.

**Architecture:** `resolveIssuanceAnchor` (`packages/core/src/runbook/issuance-anchor.ts`) already asks `resolveCommandTarget` to resolve a presented bearer claim. That resolver returns a typed refusal (`stale_claim` / `terminal_claim`) carrying a redacted, cause-specific, **already-computed** message. The anchor currently throws it away and falls through to `getActive()`. This plan propagates those two kinds through the anchor → the seam's `DelegationIssuanceOutcome` → the CLI, rendered via the **existing** `renderStaleClaimRefusal` helper. No new error code is invented: the envelope becomes `CLAIMED_RUNBOOK_UNAVAILABLE`, exactly what `pass`/`fail` already emit for the same input.

**Tech Stack:** TypeScript, Jest (unit + integration), Stryker (mutation), pnpm workspaces. Packages: `@rundown-org/core` (anchor + seam), `@rundown-org/cli` (thin front end — renders outcomes only).

---

## Handoff: state of the branch

**Branch:** `delegate-claim-anchored-issuance` (worktree `.worktrees/delegate-claim-anchored-issuance`). **Baseline at handoff: `pnpm run verify` exits 0 — 6,551 tests pass.** Working tree clean.

### Commits on this branch (vs `main`)

| Commit | What |
| --- | --- |
| `53ed86880` | **#586 core fix.** Claim-anchored issuance: `#resolveIssuanceAnchor` gains required `callerEvidence`; anchors the claim's controlled run when no `--run`. |
| `0bc07612d` | CLI end-to-end regression test for the above. |
| `9b95775e6` | CLI preconditions (`--index` FOR-step, inferred-retry substep) validated against the claim-anchored run — **largely superseded, see below**. |
| `7bf09be37` | Review follow-ups: `issuance-anchor.test.ts` (11 tests), retry-active call site pinned, CLI `unknown_run` deferral pinned, stale TSDoc fixed. |
| `c7bde339c` | **Written by a concurrent session, not by this workstream.** "anchor delegation issuance under lock" (#508): `RetryCursor`, `invalid_index` / `retry_target_required` outcomes, DelegationLock-scoped read-modify-write. **It also swept in this workstream's then-unstaged `resolveIssuanceAnchor` signature refactor** — that refactor is intact in HEAD, but `c7bde339c` is a mixed commit. Nothing was lost; note it when writing the PR description. |

### What `c7bde339c` changed under this workstream (read this before editing)

The concurrent session **moved the delegate preconditions out of the CLI and into core** — the correct fix per CLAUDE.md ("a side effect that lives in the CLI but classifies as B is architectural debt; the fix is to move it, not to rationalise its location"). Consequences:

- `packages/cli/src/commands/delegate.ts` **no longer calls `resolveIssuanceAnchor`** (verified: zero callers under `packages/cli/src`). It keeps only Category-A flag parsing (`resolveIndexOption`, `parseStepIdFromString`) and imports `ResolveIssuanceAnchorOptions` **as a type only**.
- `resolveRetryLocator` in `delegate.ts:649` is now **synchronous** and takes `(tokenArg, options, output)` — no `sessionService`, no `seamFields`.
- Core owns the state-dependent validation, emitting new outcomes `invalid_index` (`lifecycle-command-service.ts:361`) and `retry_target_required` (`:362`).
- The anchor call sites went **3 → 2**: fresh at `:903`, retry at `:1149`. The retry-step / retry-active split was consolidated.
- `DelegateSeamFields` in `delegate.ts:80` is now `type DelegateSeamFields = ResolveIssuanceAnchorOptions` — an alias, so the CLI and seam shapes cannot drift.

**The #586 behaviour is preserved and still pinned** by the regression tests from `9b95775e6` / `0bc07612d` (`describe('DELEGATE claim-anchored CLI preconditions (#586 follow-up)')`, `delegate-workflow.test.ts:433`). Those tests are the reason the supersession is safe: they assert behaviour, not implementation. **Do not delete them.**

### Current anchor implementation (the exact code this plan edits)

`packages/core/src/runbook/issuance-anchor.ts`:

```typescript
export type IssuanceAnchorResolution =
  | { readonly kind: 'ok'; readonly state: RunbookState }
  | { readonly kind: 'unknown_run'; readonly runId: RunId; readonly message: string }
  | { readonly kind: 'none' };

// ... inside resolveIssuanceAnchor(reader, options):
  if (callerEvidence.kind === 'claim_bearer') {
    const target = await resolveCommandTarget(reader, { claimId: callerEvidence.claimId });
    if (target.kind === 'claim') {
      return { kind: 'ok', state: target.state };
    }
  }
  const active = await reader.getActive();
  return active ? { kind: 'ok', state: active } : { kind: 'none' };
```

The `if (target.kind === 'claim')` with **no `else`** is the defect: five of six claim statuses silently fall through.

---

## Background: why this work exists

`resolveClaimTarget` (`command-target-resolver.ts:283-320`) collapses six raw statuses into three kinds, each with a redacted, pre-computed message:

| Status | Kind | Message |
| --- | --- | --- |
| `claimed` | `claim` | — (anchors; already works) |
| `terminal` | `terminal_claim` | `Claim id <key> points at a completed child runbook.` |
| `missing` | `stale_claim` | `Claim id <key> does not exist.` |
| `invalid-secret` | `stale_claim` | `Claim id <key> is not valid for this session.` |
| `stale` | `stale_claim` | `Claim id <key> points at missing child state (<reason>).` |
| `unlinked` | `stale_claim` | `Claim id <key> is currently stashed. Run \`rundown pop\` with its claim id to resume.` |

So this is **two** new kinds, not six, and every message already exists.

**Today (reproduced against the real CLI at `c7bde339c`, not theorised):**

| Invocation | `pass --claim-id X` | `delegate --step 1.1 --claim-id X` |
| --- | --- | --- |
| X is **stashed**, a different run is active | `CLAIMED_RUNBOOK_UNAVAILABLE`<br>*"…is currently stashed. Run `rundown pop` with its claim id to resume."* | `CLAIM_GRANT_REQUIRED`<br>*"The supplied claim id is not authorized to run `rundown delegate` for this target."* — "this target" is the active run, which the operator never named. |
| X **does not exist**, a run is active | `CLAIMED_RUNBOOK_UNAVAILABLE`<br>*"Claim id `<key>` does not exist."* | `ACTOR_CONTEXT_REQUIRED`<br>*"This run has delegation activity, so a bare `rundown delegate` is refused. **Pass `--claim-id <claimId>`**…"* — the operator just passed `--claim-id`. |

**The pre-fix envelope is arbitrary**, because it is not about the claim at all: the anchor drops the diagnosis, anchors whatever run is active, and whichever gate happens to fire produces the message. `ACTOR_CONTEXT_REQUIRED` vs `CLAIM_GRANT_REQUIRED` depends on *why* the claim failed (`#resolveMutationActorContext` selects `claim_grant_required` only when `authority.reason === 'no-authorizing-claim'`; a nonexistent claim resolves a different reason and falls to the **bare-invocation** message). Any test asserting a single pre-fix code is therefore wrong — assert the post-fix code instead.

**Why it is in scope:** #586's acceptance criteria are narrower than this work and are **already met** by `53ed86880`/`7bf09be37` — this plan is not required to close #586. It is in scope because the branch exists to improve delegation/claim capability, and a claim command that discards the claim's own diagnosis is not that capability finished. Criterion 1's *"instead of **refusing**/anchoring on the active run"* also lands close to the stashed row above. If the branch must ship sooner, this plan is separable into a follow-up PR under cluster #565 (next to #519, the same operator-diagnostics surface).

**Blast radius is exactly the broken case:** `--run` outranks the claim (so `--run` invocations never consult it), and non-claim evidence skips the branch entirely. Only `claim_bearer` + non-live claim changes.

### Decisions already made (do not re-litigate)

1. **Terminal claims get a plain refusal, not confirm/conflict.** `pass`/`fail` split terminal into `terminal_claim_confirmed`/`terminal_claim_conflict` (`command-target-resolver.ts:528-543`) because a terminal lifecycle maps to an expected result (`completed→pass`, `stopped→fail`) for idempotency. Delegate has no result to confirm against a lifecycle; its idempotency notion is `already-delegated` (token echo), which is about the substep. Importing confirm/conflict would mean inventing an expected result that does not exist.
2. **No new error code.** Use the existing `renderStaleClaimRefusal` (`refusal-renderers.ts:23`), which emits `CLAIMED_RUNBOOK_UNAVAILABLE`. `delegate.ts` already imports two of that module's five renderers. The envelope change `CLAIM_GRANT_REQUIRED → CLAIMED_RUNBOOK_UNAVAILABLE` is **convergence with `pass`/`fail`**, not divergence.
3. **Keep `stale_claim` and `terminal_claim` distinct at the seam** even though the CLI renders both identically today. Collapsing them into one kind would be a lossy mapping for a presentation convenience; an idle/abandoned-claim feature (#519) will plausibly want to tell them apart.
4. **Accept the pre-existing message asymmetry.** `missing` → "does not exist" vs `invalid-secret` → "is not valid for this session" are distinguishable, so a probe learns whether a claim key exists. This is pre-existing (`pass`/`fail` already leak it) and the messages use the redacted `claimKey`, never the bearer secret. Inheriting it keeps delegate consistent; changing it is a separate cross-command decision.

---

## Global Constraints

- **State machine drives logic; the CLI is a thin wrapper.** All new logic lands in core. The CLI gains only two `case` arms in existing outcome switches. Do **not** reintroduce state-dependent validation into `delegate.ts` — `c7bde339c` just removed it.
- **Type-driven dispatch.** Dispatch on `CommandTargetResolution.kind`. Reuse the resolver's own discriminants (`stale_claim`, `terminal_claim`) rather than inventing new vocabulary.
- **No new error codes.** `CLAIMED_RUNBOOK_UNAVAILABLE` via `renderStaleClaimRefusal`.
- **Never migrate persisted runbook state.** This is pure read-side target selection. No persisted shape changes.
- **JSON output by default.** Assert the default JSON envelope; add `--text` only if testing human rendering.
- **Do not weaken existing tests.** One test legitimately flips (Task 1 Step 5); everything else stays.

---

## File Structure

- `packages/core/src/runbook/issuance-anchor.ts` — add `stale_claim` + `terminal_claim` to `IssuanceAnchorResolution`; make the `claim_bearer` branch total (no silent fall-through).
- `packages/core/src/runbook/lifecycle-command-service.ts` — add the two variants to `DelegationIssuanceOutcome`; map them at the two anchor call sites (`:903` fresh, `:1149` retry).
- `packages/cli/src/commands/delegate.ts` — import `renderStaleClaimRefusal`; add two `case` arms to each of the two outcome switches (near `case 'unknown_run':` at `:326` and `:428`).
- `packages/core/__tests__/runbook/issuance-anchor.test.ts` — flip the two fall-through tests to assert the new refusals; add the stashed-message test.
- `packages/core/__tests__/runbook/lifecycle-command-service.test.ts` — flip the terminal fall-through test; add a seam-level stale-claim test.
- `packages/cli/__tests__/integration/delegate-workflow.test.ts` — end-to-end: stashed claim → `CLAIMED_RUNBOOK_UNAVAILABLE` + the `rundown pop` message.

---

## Task 1: Anchor surfaces claim refusals instead of discarding them

**Files:**
- Modify: `packages/core/src/runbook/issuance-anchor.ts`
- Test: `packages/core/__tests__/runbook/issuance-anchor.test.ts`

**Interfaces:**
- Consumes: `resolveCommandTarget`, `CommandTargetReader` (already imported).
- Produces: `IssuanceAnchorResolution` gains `{ kind: 'stale_claim'; claimId: ClaimId; message: string }` and `{ kind: 'terminal_claim'; claimId: ClaimId; lifecycle: 'completed' | 'stopped'; message: string }`. `ClaimId` must be imported from `./claim-id.js`.

- [ ] **Step 1: Flip the two existing fall-through tests to the new expectation**

In `issuance-anchor.test.ts`, the tests `falls through to the active default for a terminal claim` and `falls through to the active default for a missing (stale) claim` currently assert `kind === 'ok'` with `state.id === activeRunId`. That behaviour is what this task removes. Replace their bodies' assertions (keep the `fakeReader` setups exactly as they are):

```typescript
      const anchored = await resolveIssuanceAnchor(reader, { callerEvidence: bearerEvidence });

      expect(anchored.kind).toBe('terminal_claim');
      if (anchored.kind !== 'terminal_claim') throw new Error('expected terminal_claim');
      expect(anchored.lifecycle).toBe('completed');
      expect(anchored.message).toContain('completed');
```

and for the missing-claim test:

```typescript
      const anchored = await resolveIssuanceAnchor(reader, { callerEvidence: bearerEvidence });

      expect(anchored.kind).toBe('stale_claim');
      if (anchored.kind !== 'stale_claim') throw new Error('expected stale_claim');
      expect(anchored.message).toContain('does not exist');
```

Rename both `it(...)` titles to `refuses …` (they no longer describe a fall-through):
- `refuses terminal_claim rather than anchoring the active default (#586)`
- `refuses stale_claim rather than anchoring the active default (#586)`

Also update the stashed test (`falls through to the active default for a stashed claim`) — it is the operator-facing case that motivates this work:

```typescript
    it('refuses a stashed claim with its actionable message (#586)', async () => {
      const reader = fakeReader({
        active: activeRun,
        claimResolution: { status: 'unlinked', claim: verifiedClaim, reason: 'stashed' },
      });

      const anchored = await resolveIssuanceAnchor(reader, { callerEvidence: bearerEvidence });

      expect(anchored.kind).toBe('stale_claim');
      if (anchored.kind !== 'stale_claim') throw new Error('expected stale_claim');
      // The whole point: the operator is told what to actually do.
      expect(anchored.message).toContain('rundown pop');
    });
```

Leave the `(3) the active default is the bare fallback` describe untouched — non-claim evidence must still fall through. **Note:** its test `resolves none when a stale claim leaves no active default` presents `claim_bearer` + missing claim, so it now expects `stale_claim`, not `none`. Move it into the `(2)` describe and assert `stale_claim`, or delete it as redundant with the missing-claim test above.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/core exec jest issuance-anchor.test.ts`

Expected: FAIL — the flipped tests receive `'ok'` (the current fall-through) instead of `'stale_claim'` / `'terminal_claim'`.

> **Jest invocation:** use `exec jest <path> -t "<name>"`, NOT `test -- <path> -t "<name>"`. Both packages define `"test": "jest"`, so the script form forwards a literal `--` into jest 30, which treats `-t` and the name as positional path patterns — the filter is silently dropped and a mistyped name reports green.

- [ ] **Step 3: Make the claim branch total**

In `issuance-anchor.ts`, extend the union (add `import type { ClaimId } from './claim-id.js';`):

```typescript
export type IssuanceAnchorResolution =
  | { readonly kind: 'ok'; readonly state: RunbookState }
  | { readonly kind: 'unknown_run'; readonly runId: RunId; readonly message: string }
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  | {
      readonly kind: 'terminal_claim';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly message: string;
    }
  | { readonly kind: 'none' };
```

Replace the claim branch. Every claim resolution is now handled — the branch never silently gives up:

```typescript
  if (callerEvidence.kind === 'claim_bearer') {
    const target = await resolveCommandTarget(reader, { claimId: callerEvidence.claimId });
    switch (target.kind) {
      case 'claim':
        return { kind: 'ok', state: target.state };
      // A presented claim that cannot anchor is the operator's real problem.
      // Surface the resolver's cause-specific message (already redacted to the
      // claim key) instead of discarding it and refusing against an unrelated
      // active default — that misdirection is the #586 defect in the refusal
      // path (see the `pass --claim-id` comparison in the plan).
      case 'stale_claim':
        return { kind: 'stale_claim', claimId: target.claimId, message: target.message };
      case 'terminal_claim':
        return {
          kind: 'terminal_claim',
          claimId: target.claimId,
          lifecycle: target.lifecycle,
          message: target.message,
        };
      default:
        // `default` / `none` / `run` / `unknown_run` are unreachable when only
        // `claimId` is supplied; fall through to the active default rather than
        // asserting never (the resolver's union is shared and may grow).
        break;
    }
  }
  const active = await reader.getActive();
  return active ? { kind: 'ok', state: active } : { kind: 'none' };
```

Update the TSDoc precedence list on `resolveIssuanceAnchor`: item (2) no longer says a stale/terminal/stashed claim "falls through to (3)" — it now refuses. That sentence is currently wrong the moment this lands.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rundown-org/core exec jest issuance-anchor.test.ts`

Expected: PASS (all tests, including the untouched `--run` precedence and bare-fallback describes).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runbook/issuance-anchor.ts \
  packages/core/__tests__/runbook/issuance-anchor.test.ts
git commit -m "fix(core): surface claim refusals from the issuance anchor (#586)"
```

---

## Task 2: Seam propagates the refusals

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts` (union near `:361`; call sites `:903` fresh, `:1149` retry)
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`

**Interfaces:**
- Consumes: `IssuanceAnchorResolution` (already imported).
- Produces: `DelegationIssuanceOutcome` gains `stale_claim` and `terminal_claim` with the same fields as Task 1. This mirrors how `unknown_run` already flows anchor → outcome → CLI.

- [ ] **Step 1: Flip the terminal fall-through test**

`lifecycle-command-service.test.ts` has `falls through to the active default when the claim's controlled run is terminal (#586)`, asserting `refused` / `claim_grant_required`. That is the behaviour being replaced. Rename to `refuses a terminal claim rather than anchoring the active default (#586)` and replace the assertions (keep the setup):

```typescript
      expect(outcome.kind).toBe('terminal_claim');
      if (outcome.kind !== 'terminal_claim') throw new Error('expected terminal_claim');
      expect(outcome.lifecycle).toBe('completed');
```

**Its mutation-killing role survives:** it existed to kill the `target.kind === 'claim'` → `true` mutant. Forcing that guard true now anchors a *terminal* run and issues, which this assertion still catches.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest lifecycle-command-service.test.ts -t "refuses a terminal claim"`

Expected: FAIL — outcome is `refused` (the anchor's refusal is not yet propagated by the seam).

- [ ] **Step 3: Add the outcome variants**

In `DelegationIssuanceOutcome` (alongside `unknown_run`, near `:361`):

```typescript
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  | {
      readonly kind: 'terminal_claim';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly message: string;
    }
```

- [ ] **Step 4: Map both anchor call sites**

The fresh site (`:903`) currently reads:

```typescript
    const anchored = await this.#resolveIssuanceAnchor(input);
    if (anchored.kind !== 'ok') {
      return anchored.kind === 'unknown_run' ? anchored : { kind: 'no-active-runbook' };
    }
```

Replace with a switch so a future resolution kind cannot silently become `no-active-runbook`:

```typescript
    const anchored = await this.#resolveIssuanceAnchor(input);
    if (anchored.kind !== 'ok') {
      switch (anchored.kind) {
        case 'unknown_run':
        case 'stale_claim':
        case 'terminal_claim':
          return anchored;
        case 'none':
          return { kind: 'no-active-runbook' };
        default: {
          const _exhaustive: never = anchored;
          return _exhaustive;
        }
      }
    }
```

The retry site (`:1149`) currently reads:

```typescript
      const anchored = await this.#resolveIssuanceAnchor(input);
      if (anchored.kind !== 'ok') {
        if (anchored.kind === 'unknown_run') return anchored;
        return locator.kind === 'active'
          ? { kind: 'retry_target_required' }
          : { kind: 'no-active-runbook' };
      }
```

Preserve the `retry_target_required` behaviour added by `c7bde339c` — it applies only to the `none` case:

```typescript
      const anchored = await this.#resolveIssuanceAnchor(input);
      if (anchored.kind !== 'ok') {
        switch (anchored.kind) {
          case 'unknown_run':
          case 'stale_claim':
          case 'terminal_claim':
            return anchored;
          case 'none':
            return locator.kind === 'active'
              ? { kind: 'retry_target_required' }
              : { kind: 'no-active-runbook' };
          default: {
            const _exhaustive: never = anchored;
            return _exhaustive;
          }
        }
      }
```

- [ ] **Step 5: Add a seam-level stale-claim test**

In the `issueDelegation (fresh)` describe, after the flipped terminal test. Uses the suite's own fixtures (`startSeamOnDelegateStep`, `runControlEvidence`); do not invent helpers. A never-issued claim id resolves `missing` → `stale_claim`:

```typescript
    it('refuses a stale (nonexistent) claim rather than anchoring the active default (#586)', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const unknownClaimId = assertClaimId(
        'rdclm_99999999999999999999999999999999_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
      );

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'claim_bearer', claimId: unknownClaimId },
      });

      expect(outcome.kind).toBe('stale_claim');
      if (outcome.kind !== 'stale_claim') throw new Error('expected stale_claim');
      expect(outcome.message).toContain('does not exist');
    });
```

`assertClaimId` is already imported by this suite; verify with `grep -n "assertClaimId" packages/core/__tests__/runbook/lifecycle-command-service.test.ts` and add it to the existing `claim-id.js` import if absent.

- [ ] **Step 6: Run the seam suite**

Run: `pnpm --filter @rundown-org/core exec jest lifecycle-command-service.test.ts`

Expected: PASS, all tests. If a `#508` test from `c7bde339c` fails, do **not** paper over it — it means this change interacts with the lock-scoped reread. Investigate before proceeding.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts \
  packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "fix(core): propagate claim refusals through the issuance seam (#586)"
```

---

## Task 3: CLI renders the refusals

**Files:**
- Modify: `packages/cli/src/commands/delegate.ts` (import at `:43-46`; switches near `case 'unknown_run':` at `:326` and `:428`)
- Test: `packages/cli/__tests__/integration/delegate-workflow.test.ts`

**Interfaces:**
- Consumes: `renderStaleClaimRefusal` from `../helpers/refusal-renderers.js` — emits `CLAIMED_RUNBOOK_UNAVAILABLE` (`refusal-renderers.ts:23-26`). **No new code, no new renderer.**
- Produces: nothing.

- [ ] **Step 1: Write the failing integration test**

Add to `delegate-workflow.test.ts` inside `describe('DELEGATE claim-anchored CLI preconditions (#586 follow-up)')` (opens at `:433`), reusing its `startForParentThenOther` fixture. A never-issued claim id is the simplest stale case and needs no stash plumbing:

```typescript
  it('surfaces the claim problem, not a grant refusal, for a stale claim (#586)', async () => {
    await startForParentThenOther();
    const unknownClaimId =
      'rdclm_99999999999999999999999999999999_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_';

    const result = await runCliInProcess(
      ['delegate', '--step', '1.1', '--claim-id', unknownClaimId],
      workspace,
    );

    // Before this fix the anchor discards the claim's diagnosis and anchors the
    // active default, so the refusal is about a run the operator never named:
    // here `ACTOR_CONTEXT_REQUIRED` — the BARE-invocation message telling the
    // caller to "Pass --claim-id", which they just did. (A stashed claim takes a
    // different pre-fix path and yields CLAIM_GRANT_REQUIRED; the pre-fix code is
    // arbitrary, which is why this asserts only the post-fix envelope.)
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { code?: string; error?: string };
    expect(payload.code).toBe('CLAIMED_RUNBOOK_UNAVAILABLE');
    // The load-bearing assertion: the operator is told what is actually wrong.
    expect(payload.error).toContain('does not exist');
  }, 20_000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm run build && pnpm --filter @rundown-org/cli exec jest delegate-workflow.test.ts -t "surfaces the claim problem"`

Expected: FAIL — `code` is `ACTOR_CONTEXT_REQUIRED` (verified against the real CLI at `c7bde339c`), not `CLAIMED_RUNBOOK_UNAVAILABLE`. Do not "fix" the test to expect whatever the pre-fix code happens to be — the point of the task is that the code becomes the claim's own diagnosis.

> **The integration suites spawn `packages/cli/dist/cli.js`.** Without `pnpm run build` they fail with a misleading `ENOENT: chmod` inside `createTestWorkspace`, not an assertion failure. Always build before running them after a core change.

- [ ] **Step 3: Render the outcomes**

Add `renderStaleClaimRefusal` to the existing import (`delegate.ts:43-46`):

```typescript
import {
  renderActorContextRequiredRefusal,
  renderClaimGrantRequiredRefusal,
  renderStaleClaimRefusal,
} from '../helpers/refusal-renderers.js';
```

In **both** outcome switches (near `case 'unknown_run':` at `:326` and `:428`), add:

```typescript
            case 'stale_claim':
            case 'terminal_claim':
              // Core owns the cause-specific message (shared with pass/fail).
              // Both render as CLAIMED_RUNBOOK_UNAVAILABLE: delegate has no
              // confirm/conflict notion for a terminal claim — there is no
              // expected result to reconcile a lifecycle against.
              renderStaleClaimRefusal(output, outcome.message);
              process.exitCode = 1;
              break;
```

Match each switch's surrounding style (the retry switch at `:326` and the fresh switch at `:428` may differ in whether they `break` or `return`; mirror `case 'unknown_run':` in the same switch).

- [ ] **Step 4: Verify it passes**

Run: `pnpm run build && pnpm --filter @rundown-org/cli exec jest delegate-workflow.test.ts -t "surfaces the claim problem"`

Expected: PASS.

- [ ] **Step 5: Regression sweep**

Run: `pnpm --filter @rundown-org/cli exec jest delegate-workflow.test.ts`
Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/delegate.test.ts`
Run: `pnpm --filter @rundown-org/cli exec jest __tests__/integration/explicit-run-targeting.test.ts`

Expected: PASS. `explicit-run-targeting` confirms `--run` semantics are untouched (`--run` outranks the claim, so it never reaches the new branch).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/delegate.ts \
  packages/cli/__tests__/integration/delegate-workflow.test.ts
git commit -m "fix(cli): render delegate claim refusals as CLAIMED_RUNBOOK_UNAVAILABLE (#586)"
```

---

## Task 4: Full verification and PR

**Files:** none (verification + PR admin).

- [ ] **Step 1: Run the pre-PR gate**

Run: `pnpm run verify; echo "exit: $?"`

Expected: **exit 0.** Check the real exit code — the suite prints noisy `getcwd`/`command not found` lines from a sandbox-policy test that are pre-existing and harmless. Baseline at handoff was 6,551 tests; this plan adds ~5.

- [ ] **Step 2: Mutation gate on the anchor**

Run from `packages/core`:

```bash
npx stryker run --mutate 'src/runbook/issuance-anchor.ts' \
  --testFiles '__tests__/runbook/issuance-anchor.test.ts' --reporters clear-text
```

Expected: score ≥ 70 (was **96.55%**, 28 killed, 0 no-coverage). The `callerEvidence.kind === 'claim_bearer'` → `true` mutant **survives and is a verified equivalent mutant** — with `claimId` undefined, `resolveCommandTarget` returns `default`/`none`, never `claim`, so the return value is identical. It was independently confirmed twice. **Do not write a `getActive()` call-count test to kill it** — that pins an implementation detail (read count), not behaviour, and is a worse test than none. If any *other* mutant survives, add the input that makes the forced branch observable.

> **Do NOT use `pnpm run test:mutate:core -- --mutate …`** — the wrapper injects a second `--`, and Stryker rejects the flags as positional args (`too many arguments for 'run'`). Invoke `npx stryker` from the package directory with package-relative paths. **Always line-scope or file-scope the run**: an unscoped run over the 2,700-line `lifecycle-command-service.ts` takes 70+ minutes; a scoped run takes ~2.

- [ ] **Step 3: Open the PR**

Include `Closes #586`. In the body:
- Note that `c7bde339c` is a **mixed commit** authored by a concurrent session (#508 lock work) that also swept in this branch's `resolveIssuanceAnchor` signature refactor.
- Note this discharges one of the two remaining code leaves in cluster #565 (R4 Capability Tier); **#519** (parent-side abandoned/idle claim detection) and the **#574** design umbrella remain open, so **#565 stays open**.
- Do **not** edit the epic (#564) or cluster (#565) roadmap status beyond referencing #586.

---

## Follow-ups not in scope (file as issues if wanted)

- **`UnknownRunRefusal` is structurally re-declared 4×** (`issuance-anchor.ts`, `command-target-resolver.ts:403`, `:441`, plus inline members of `CommandTargetResolution` / `TransitionTargetResolution`). Extract an exported type in `command-target-resolver.ts` and reference it from all four. Pre-existing debt this branch mildly compounds. Both reviewers raised it.
- **Precedence inversion vs `resolveCommandTarget`.** `resolveCommandTarget:465` tries `claimId` **before** `runId`; `resolveIssuanceAnchor` tries `targetRunId` **before** the claim. Unreachable today (the CLI rejects `--run` + `--claim-id` as `INVALID_SYNTAX` and `TransitionTarget` has no `both` inhabitant), but a latent trap for MCP/plugin front ends. Either align or document the deliberate inversion where `ResolveCommandTargetOptions:161-165` documents its own. Pinned by `issuance-anchor.test.ts` → `outranks a live bearer claim naming a different run`.
- **`--run` branch duplicates `resolveRunTarget`.** `issuance-anchor.ts`'s `--run` branch is line-for-line `command-target-resolver.ts:436-448`, differing only in the `kind` label. Routing it through `resolveCommandTarget({ runId })` is tempting but **not equivalent** — a combined single call would give the claim precedence and, on a terminal claim, never consult `--run` at all. Any fix must keep the two lookups separate.
- **Claim-key existence oracle** (Decision 4 above): `missing` vs `invalid-secret` messages are distinguishable across all claim-bearing commands. Pre-existing; a cross-command decision, not delegate's.

---

## Self-Review

- **Spec coverage.** The gap ("delegate discards claim-resolution diagnostics and refuses with an arbitrary error about the active run") → Task 1 (anchor surfaces them), Task 2 (seam propagates), Task 3 (CLI renders). Each layer has its own red→green. The four prior decisions are recorded above with their evidence so they are not re-litigated mid-implementation.
- **Placeholder scan.** No `TODO`/`TBD`/"handle edge cases". Every code step shows the exact edit. The one grep (`assertClaimId` import in Task 2 Step 5) names the exact command and the fallback action.
- **Type consistency.** `stale_claim` / `terminal_claim` carry identical fields in `IssuanceAnchorResolution` (Task 1) and `DelegationIssuanceOutcome` (Task 2), reusing `resolveClaimTarget`'s own discriminants and `ClaimId` from `claim-id.js`. `target.claimId` / `target.message` / `target.lifecycle` are confirmed present on those variants (`command-target-resolver.ts:286-320`). The CLI reads only `outcome.message`, present on both. `renderStaleClaimRefusal(output: OutputEmitter, message: string): boolean` matches the call.
- **Known behaviour change.** `delegate --claim-id <stale|stashed|terminal>` moves from an arbitrary gate refusal (`CLAIM_GRANT_REQUIRED` or `ACTOR_CONTEXT_REQUIRED`, depending on why the claim failed — both exit 1) to `CLAIMED_RUNBOOK_UNAVAILABLE` (exit 1). Exit code unchanged; the envelope converges with `pass`/`fail`. This is the branch's first behaviour change outside the #586 success path — call it out explicitly in the PR description.
