# Cluster A — the `complete`/`stop` Core Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route `rd complete` and `rd stop` through a new core terminal seam (`RunbookLifecycleCommandService.runTerminal`) that owns the subprocess withhold, caller-evidence gate, collection-pending refusal, core outcome derivation, and retained terminal-claim tombstones — closing roadmap items 2, 4, 8, and 9.

**Architecture:** A single new core method `runTerminal` mirrors the existing `runTransition` seam. It resolves the target (claim vs bare-inline-cascade), runs `resolveCommandIntent` for the caller-evidence + collection-pending gates, drives `FORCE_COMPLETE`/`FORCE_STOP` through the actor service, **records the child outcome before release** via `recordChildCompletion` (core derives `completed→pass`/`stopped→fail` through `lifecycleToDelegationOutcome`), and releases with `retainClaimsAsTerminal: true`. `complete.ts`/`stop.ts` collapse to thin front ends that stream events and set exit codes. The bare inline-chain FORCE cascade currently in `force-terminal-workflow.ts` moves wholesale into a core `#driveTerminalBare`.

**Tech Stack:** TypeScript, XState (state machine in `@rundown-org/core`), Jest (unit + integration), fast-check (property tests), Stryker (mutation testing). pnpm monorepo.

## Global Constraints

Copied verbatim from `CLAUDE.md` and the high-level plan; every task's requirements implicitly include these:

- **State machine drives Rundown logic.** All step/lifecycle logic lives in the core state machine; CLI/MCP/plugin are thin front ends that invoke it. Do not re-implement lifecycle logic in the CLI.
- **No silent mapping.** STOP/COMPLETE/BREAK propagate as themselves. `completed→pass`/`stopped→fail` derivation is done exactly once, in core, via `lifecycleToDelegationOutcome`. A stopped terminal must report `fail` and exit non-zero — never a silent `pass`.
- **Type-driven dispatch.** Discriminated unions + `never` exhaustiveness guards throughout. No `if` on raw action-type strings in guards. Every `switch` over a discriminated union ends in a `const _exhaustive: never = value` default.
- **No synthetic IDs / no `any`.** Use XState's native events and the existing typed unions.
- **TSDoc on every exported symbol** (description, `@param`, `@returns`, `@throws`). Type guards document the type predicate.
- **JSON output by default.** CLI tests exercise the JSON path first; `--text` only when the test is about human rendering.
- **NEVER migrate persisted runbook state.** No new persisted fields introduced here; all new types are in-memory command outcomes.

### Confirmed design decisions (baked in — do NOT re-litigate)

1. **Full cascade into the seam** — the bare inline-chain FORCE cascade moves into core `#driveTerminalBare`; the CLI keeps only event streaming + exit code.
2. **Force through on open delegated children** — bare `complete`/`stop` do NOT refuse when async delegated children are open. Do NOT extend the `open_claims` gate to the terminal intent.
3. **Retain root tombstone** — release the resolved root with `retainClaimsAsTerminal: true`; inline descendants carry no claims and still delete.
4. **Record-before-release** — record the child outcome durably *before* tearing down session targeting (stricter than pass/fail's release-then-propagate).
5. **No Commander aliases** — `complete`/`stop` register no aliases (`'done'` in `['complete','done']` is the `[message]` positional).

---

## Reused primitives (do NOT reinvent — every task references these by name)

| Primitive | Location | Use |
| --- | --- | --- |
| `lifecycleToDelegationOutcome(lifecycle)` | `packages/core/src/runbook/completion-service.ts:84` | Core derivation `completed→'pass'`, `stopped→'fail'`. |
| `recordChildCompletion({ childState })` | `completion-service.ts:526` (unlocked twin `:551`, derives result at `:556` via `args.result ?? lifecycleToDelegationOutcome(...)`) | Record-before-release. Omit `result` so core derives it. Acquires `DelegationLock` itself. |
| `releaseRunbook(id, { retainClaimsAsTerminal: true })` | `session-service.ts:637` (locked inner `releaseRunbookLocked:680`, retain branch `:694`) | Retain the terminal-claim tombstone. |
| `releaseRunbooks(ids)` | `session-service.ts:607` | Bulk-release inline descendants (no retain). |
| `resolveCommandIntent(input)` | `command-policy.ts:314` | Caller-evidence + collection-pending gate. |
| `rejectBareMutationIfCollectionPending(input)` | `command-policy.ts:284` | Collection-pending sub-gate (extended in Stage B). |
| `resolveActiveInlineForceTerminalPlan(kind)` | `session-service.ts:552`, returns `ActiveInlineForceTerminalPlan` (`:54`) | Resolve the bare inline cascade plan. |
| `resolveClaimTarget(reader, claimId, { includeStashed })` | `command-target-resolver.ts:184` (private) | Shared claim-id head reused by the new terminal resolver. |
| `actorContextFromEvidence(evidence, anchorRunId)` | `actor-context.ts` | Map caller evidence → actor context anchored on a run. |
| `deriveTransitionObservation(...)` | `packages/core/src/events/transition-observation.ts:152` | Project machine transitions into `TransitionObservationEvent[]`. |
| `ForceTerminalEventBridge` | `packages/cli/src/helpers/force-terminal-workflow.ts:63` | CLI streaming bridge (Category A) — retained in CLI. |
| `readLifecycleCallerEvidence()` | `packages/cli/src/helpers/caller-evidence.ts:32` | Build typed `CallerEvidence` in the CLI. |
| `bareRoleSpecificMutation(argv)` | `subprocess-mutation-boundary.ts:310` | Subprocess withhold classifier (extended in Stage A). |

**Do NOT** add a new `lifecycleToResult`-style helper, a second collection-pending reader, a parallel claim-id resolver, or a CLI `completed?pass:fail` ternary. All four exist or are being centralised in core.

---

## File Structure

**Modified (core):**
- `packages/core/src/runbook/subprocess-mutation-boundary.ts` — add `complete`/`stop` to the withhold set + alias map (Stage A).
- `packages/core/src/runbook/command-policy.ts` — add `terminal-run-force` `CommandIntent`; extend the collection-pending sub-gate (Stage B).
- `packages/core/src/runbook/command-target-resolver.ts` — add `TerminalCommandName`, `TerminalTargetResolution`, `resolveTerminalTarget` (Stage C).
- `packages/core/src/runbook/lifecycle-command-service.ts` — add `LifecycleTerminalInput`, `LifecycleTerminalOutcome`, `runTerminal`, `#driveTerminalClaim`, `#driveTerminalBare` (Stages C + D).
- `packages/core/src/runbook/index.ts` (barrel) — re-export the new public types.

**Modified (cli):**
- `packages/cli/src/commands/complete.ts` — collapse to thin front end (Stage D).
- `packages/cli/src/commands/stop.ts` — collapse to thin front end (Stage D).

**New (cli):**
- `packages/cli/src/helpers/terminal-command.ts` — shared `runSeamTerminal` helper (`renderTerminalRefusal` / `renderTerminalApplied` pair), modeled on `runSeamTransition` in `transitions.ts:697`.

**Deleted / absorbed (cli):**
- `packages/cli/src/helpers/force-terminal-workflow.ts` — the cascade body (`:194-218`) and plan-mapping (`:158-189`) move into core `#driveTerminalBare`. Keep only `ForceTerminalEventBridge` (`:63`, currently **not** `export`ed) — relocate it into `terminal-command.ts` (adding the `export`) and delete `force-terminal-workflow.ts`. (Resolved in Task 9, Step 5.)

**Test files touched:** listed per task.

---

## Stage A — Subprocess withhold set (Item 2)

### Task 1: Add `complete`/`stop` to the subprocess withhold classifier

**Files:**
- Modify: `packages/core/src/runbook/subprocess-mutation-boundary.ts:24`, `:26`, `:46`
- Test: `packages/core/__tests__/runbook/subprocess-mutation-boundary.test.ts:70-83`, `:118-157`

**Interfaces:**
- Produces: `RoleSpecificMutationCommand = 'pass' | 'fail' | 'delegate' | 'complete' | 'stop'` — consumed by `bareRoleSpecificMutation` (`:310`), `subprocessMutationWithheldMessage` (`:402`), `mutationCommandAliases` (`:85`), and the plugin/MCP front ends.
- Consumes: nothing new. `carriesClaimEvidence` (`:259`) and the `command !== 'delegate'` exemption branch (`:329`) already generalise to any non-`delegate` command, so `complete --claim-id` / `stop --claim-id` are exempt with **no scanner change**.

- [ ] **Step 1: Flip the bug-pinning rows to failing assertions**

In `subprocess-mutation-boundary.test.ts`, remove `[['complete', 'done']]` and `[['stop']]` from the "does not withhold the non-role-specific call" `it.each` at `:70-83`, and add a new positive-withhold block plus a claim-exemption block:

```typescript
it.each([
  [['complete'], 'complete'],
  [['complete', 'done'], 'complete'],
  [['stop'], 'stop'],
  [['stop', 'Aborting'], 'stop'],
])('classifies bare terminal command %j as a withheld %s', (argv, expected) => {
  expect(bareRoleSpecificMutation(argv)).toBe(expected);
});

it.each([
  [['complete', '--claim-id', 'claim-1']],
  [['stop', '--claim-id=claim-1']],
  [['complete', '--claim-id', 'rdclm_x', '--text']],
])('does not withhold the claim-evidence terminal mutation %j', (argv) => {
  expect(bareRoleSpecificMutation(argv)).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rundown-org/core test -- subprocess-mutation-boundary`
Expected: FAIL — `bareRoleSpecificMutation(['complete'])` currently returns `undefined`, not `'complete'`.

- [ ] **Step 3: Extend the type and sets (minimal implementation)**

In `subprocess-mutation-boundary.ts`:

```typescript
// :24
export type RoleSpecificMutationCommand = 'pass' | 'fail' | 'delegate' | 'complete' | 'stop';

// :26
const ROLE_SPECIFIC_MUTATION_COMMANDS: ReadonlySet<RoleSpecificMutationCommand> = new Set([
  'pass',
  'fail',
  'delegate',
  'complete',
  'stop',
]);

// :46 — no aliases (decision #5): 'done' is the [message] positional, not an alias.
const MUTATION_COMMAND_ALIASES: Readonly<Record<RoleSpecificMutationCommand, readonly string[]>> = {
  pass: ['yes', 'ok'],
  fail: ['no'],
  delegate: [],
  complete: [],
  stop: [],
};
```

Because `MUTATION_COMMAND_ALIASES` is a `Record<RoleSpecificMutationCommand, …>`, TypeScript forces the two new keys — omitting them is a compile error (this is the type guard against forgetting).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rundown-org/core test -- subprocess-mutation-boundary`
Expected: PASS. The claim-exemption cases pass because `carriesClaimEvidence` scans for `--claim-id` in flag position for every non-`delegate` command, and `subprocessMutationWithheldMessage` (`:406`) already renders `rd complete --claim-id` / `rd stop --claim-id` (the `command === 'delegate' ? 'pass' : command` ternary yields the command itself).

- [ ] **Step 5: Extend the property tests**

Update the alias-normalisation property at `:118-138` and the never-withhold-`--claim-id` property at `:140-157` to include `complete`/`stop`:

```typescript
// In 'withholds every bare alias as its canonical command (property)' (:121)
const aliasPairs = (['pass', 'fail', 'delegate', 'complete', 'stop'] as const).flatMap(
  (canonical) => mutationCommandAliases(canonical).map((alias) => [alias, canonical] as const),
);
// complete/stop/delegate have no aliases; the > 0 guard still holds via pass/fail.

// In 'never withholds pass/fail that carries --claim-id (property)' (:146)
fc.constantFrom('pass', 'fail', 'complete', 'stop'),
```

Run: `pnpm --filter @rundown-org/core test -- subprocess-mutation-boundary`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/subprocess-mutation-boundary.ts \
  packages/core/__tests__/runbook/subprocess-mutation-boundary.test.ts
git commit -m "fix(core): withhold bare complete/stop from subprocess front ends (roadmap item 2)"
```

### Stage A verification

- [ ] `pnpm --filter @rundown-org/core build`
- [ ] `pnpm --filter @rundown-org/core test -- subprocess-mutation-boundary`
- [ ] `pnpm run test:property` (subprocess-boundary property tests)
- [ ] Scoped mutation: `pnpm run test:mutate:core -- --mutate packages/core/src/runbook/subprocess-mutation-boundary.ts` — expect no surviving mutants on the new set members / alias-map keys.

---

## Stage B — CommandIntent + gates (Item 8)

### Task 2: Add the `terminal-run-force` command intent and collection-pending gate

**Files:**
- Modify: `packages/core/src/runbook/command-policy.ts:14` (union), `:289-293` (sub-gate)
- Test: `packages/core/__tests__/runbook/command-policy.test.ts` (new `terminal-run-force` cases mirroring `delegating-run-advance` at `:90-305`)

**Interfaces:**
- Produces: new `CommandIntent` member `{ kind: 'terminal-run-force'; command: 'complete' | 'stop'; targeted: boolean }` — consumed by `resolveCommandIntent` and by the seam's `#driveTerminalBare` (Task 11).
- Consumes: `rejectBareMutationIfCollectionPending` (extended), the `role === 'unknown_for_target'` gate (`:338`, fires automatically for any non-inspect/non-collection intent), `readDelegationCollectionPendingForPolicy`.

- [ ] **Step 1: Write the failing tests**

Add to `command-policy.test.ts` a `describe('resolveCommandIntent terminal-run-force', …)` block. **Reuse the file's EXISTING fixtures — do not invent new ones:** `state()` (`:25`, a running delegating parent with `id: parentRunId`), `stateWithReportedOutcome()` (`:65`, the collection-pending fixture), `claimRecord()` (`:49`, an open-claim record), the `parentRunId` constant (`:20`), and the actor-context builders `trustedRunControllerContext` / `UNKNOWN_ACTOR_CONTEXT` (imported at `:13-14`). Mirror the existing `delegating-run-advance` cases (`:90-305`):

```typescript
it('refuses a bare terminal force with no actor evidence as actor_context_required', () => {
  const outcome = resolveCommandIntent({
    actorContext: UNKNOWN_ACTOR_CONTEXT,
    intent: { kind: 'terminal-run-force', command: 'complete', targeted: false },
    targetSelector: { kind: 'default' },
    targetState: state(),
  });
  expect(outcome).toEqual({ kind: 'actor_context_required', intent: 'terminal-run-force' });
});

it('refuses a bare terminal force when the delegating run is collection pending', () => {
  const outcome = resolveCommandIntent({
    actorContext: trustedRunControllerContext(parentRunId),
    intent: { kind: 'terminal-run-force', command: 'stop', targeted: false },
    targetSelector: { kind: 'default' },
    targetState: stateWithReportedOutcome(),
  });
  expect(outcome.kind).toBe('delegation_collection_pending');
});

it('allows a bare terminal force through open delegated children (decision #2, force-through)', () => {
  const outcome = resolveCommandIntent({
    actorContext: trustedRunControllerContext(parentRunId),
    intent: { kind: 'terminal-run-force', command: 'complete', targeted: false },
    targetSelector: { kind: 'default' },
    targetState: state(),
    openClaims: [claimRecord()], // open_claims is NOT extended to terminal-run-force
  });
  expect(outcome.kind).toBe('allowed');
});

it('allows a targeted terminal force (claim path) unconditionally on the collection sub-gate', () => {
  const outcome = resolveCommandIntent({
    actorContext: trustedRunControllerContext(parentRunId),
    intent: { kind: 'terminal-run-force', command: 'complete', targeted: true },
    targetSelector: { kind: 'default' },
    targetState: stateWithReportedOutcome(),
  });
  expect(outcome.kind).toBe('allowed'); // targeted → collection-pending sub-gate skipped (:294)
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rundown-org/core test -- command-policy`
Expected: FAIL — TypeScript rejects `{ kind: 'terminal-run-force', … }` (not yet a `CommandIntent` member); once the union compiles, the collection-pending test fails because the sub-gate does not yet include the new kind.

- [ ] **Step 3: Add the union member and extend the sub-gate**

In `command-policy.ts`, add to `CommandIntent` (after the `delegation-issuance` member at `:34`):

```typescript
  | {
      /** Bare or claim-targeted complete/stop forcing a run terminal. */
      readonly kind: 'terminal-run-force';
      /** Terminal command being evaluated. */
      readonly command: 'complete' | 'stop';
      /** True when the caller supplied an explicit `--claim-id` target. */
      readonly targeted: boolean;
    }
```

Extend `rejectBareMutationIfCollectionPending` (`:289-293`) to gate the new kind:

```typescript
  if (
    input.intent.kind !== 'delegating-run-advance' &&
    input.intent.kind !== 'delegation-issuance' &&
    input.intent.kind !== 'terminal-run-force'
  ) {
    return undefined;
  }
```

No other change is needed:
- The `role === 'unknown_for_target'` actor-context gate at `:338` fires for any intent that reaches it (i.e. not `inspect`, not `delegation-collection`), so `terminal-run-force` gets actor-context refusal for free.
- The `open_claims` gate at `:345-357` keys on `input.intent.kind === 'delegating-run-advance'`, so `terminal-run-force` is **not** gated by open claims (decision #2) — do NOT touch it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rundown-org/core test -- command-policy`
Expected: PASS.

- [ ] **Step 5: Verify the barrel/type consumers still compile**

Run: `pnpm --filter @rundown-org/core build`
Expected: PASS — `DelegationPolicyOutcome`'s `actor_context_required` carries `intent: CommandIntent['kind']`, which now widens to include `'terminal-run-force'` automatically; `resolveTransitionTarget`'s `switch (policy.kind)` at `command-target-resolver.ts:323` is unaffected (it switches on the *outcome* kind, not the intent kind).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/command-policy.ts \
  packages/core/__tests__/runbook/command-policy.test.ts
git commit -m "feat(core): add terminal-run-force intent + collection-pending gate (roadmap item 8)"
```

### Stage B verification

- [ ] `pnpm --filter @rundown-org/core build`
- [ ] `pnpm --filter @rundown-org/core test -- command-policy`
- [ ] Scoped mutation: `pnpm run test:mutate:core -- --mutate packages/core/src/runbook/command-policy.ts` — expect no surviving mutants on the extended `!==` chain in `rejectBareMutationIfCollectionPending`.

---

## Stage C — Terminal target resolver + seam types (Item 4 foundation)

### Task 3: Add `TerminalCommandName`, `TerminalTargetResolution`, and `resolveTerminalTarget`

**Files:**
- Modify: `packages/core/src/runbook/command-target-resolver.ts` (after `resolveTransitionTarget` at `:357`)
- Test: `packages/core/__tests__/runbook/command-target-resolver.test.ts` (new confirm/conflict matrix mirroring the pass/fail confirm/conflict tests)

**Interfaces:**
- Produces:
  - `export type TerminalCommandName = 'complete' | 'stop';` (deliberately **separate** from `TransitionCommandName = 'pass' | 'fail'` at `:9` — do not widen it, so the pass/fail `never` guards stay intact).
  - `export type TerminalTargetResolution` (discriminated union below).
  - `export async function resolveTerminalTarget(targetReader: CommandTargetReader, options: { readonly command: TerminalCommandName; readonly claimId: ClaimId }): Promise<TerminalTargetResolution>`.
- Consumes: private `resolveClaimTarget` (`:184`) with `includeStashed: false`; `ClaimTargetResolution` (`:38`).

- [ ] **Step 1: Write the failing tests**

Add to `command-target-resolver.test.ts` a `describe('resolveTerminalTarget', …)` block using the existing `CommandTargetReader` fake pattern (the file already builds fakes for `resolveTransitionTarget`). Cover the confirm/conflict matrix and passthrough:

```typescript
it.each([
  ['complete', 'completed', 'terminal_claim_confirmed'],
  ['stop', 'stopped', 'terminal_claim_confirmed'],
  ['complete', 'stopped', 'terminal_claim_conflict'],
  ['stop', 'completed', 'terminal_claim_conflict'],
] as const)(
  '%s against a %s child resolves as %s',
  async (command, lifecycle, expectedKind) => {
    const reader = makeReaderWithTerminalClaim(CLAIM_ID, lifecycle);
    const res = await resolveTerminalTarget(reader, { command, claimId: CLAIM_ID });
    expect(res.kind).toBe(expectedKind);
    if (res.kind === 'terminal_claim_confirmed') {
      expect(res.command).toBe(command);
      expect(res.lifecycle).toBe(lifecycle);
    }
    if (res.kind === 'terminal_claim_conflict') {
      expect(res.requestedCommand).toBe(command);
      expect(res.expectedCommand).toBe(lifecycle === 'completed' ? 'complete' : 'stop');
    }
  },
);

it('passes through a live claim unchanged', async () => {
  const reader = makeReaderWithClaim(CLAIM_ID);
  const res = await resolveTerminalTarget(reader, { command: 'complete', claimId: CLAIM_ID });
  expect(res.kind).toBe('claim');
});

it('passes through a stale claim unchanged', async () => {
  const reader = makeReaderWithMissingClaim(CLAIM_ID);
  const res = await resolveTerminalTarget(reader, { command: 'stop', claimId: CLAIM_ID });
  expect(res.kind).toBe('stale_claim');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rundown-org/core test -- command-target-resolver`
Expected: FAIL — `resolveTerminalTarget` is not exported.

- [ ] **Step 3: Add the type and resolver**

Append to `command-target-resolver.ts`:

```typescript
/** Manual terminal commands that force a run complete/stopped. Kept separate from
 * {@link TransitionCommandName} so the pass/fail exhaustiveness guards stay intact. */
export type TerminalCommandName = 'complete' | 'stop';

/**
 * Terminal (complete/stop) claim-target resolution.
 *
 * Shares `claim` / `stale_claim` with {@link CommandTargetResolution} and splits
 * the base `terminal_claim` into confirm/conflict against the requested command
 * (mirroring {@link TransitionTargetResolution} for pass/fail). There is no
 * `default` / `none` member: the bare terminal path does not resolve through here
 * (it uses {@link SessionService.resolveActiveInlineForceTerminalPlan}); only the
 * `--claim-id` path calls this resolver.
 */
export type TerminalTargetResolution =
  | { readonly kind: 'claim'; readonly claimId: ClaimId; readonly claim: ClaimRecord; readonly state: RunbookState }
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  | {
      readonly kind: 'terminal_claim_confirmed';
      readonly claimId: ClaimId;
      readonly claim: ClaimRecord;
      readonly state: RunbookState;
      readonly lifecycle: 'completed' | 'stopped';
      readonly command: TerminalCommandName;
    }
  | {
      readonly kind: 'terminal_claim_conflict';
      readonly claimId: ClaimId;
      readonly claim: ClaimRecord;
      readonly state: RunbookState;
      readonly lifecycle: 'completed' | 'stopped';
      readonly expectedCommand: TerminalCommandName;
      readonly requestedCommand: TerminalCommandName;
    };

/**
 * Resolve an explicit `--claim-id` target for a complete/stop command.
 *
 * Reuses the shared claim-id head ({@link resolveClaimTarget}) with
 * `includeStashed: false` (a write command must refuse a stashed child), then —
 * for a terminal claim — splits confirm vs conflict on lifecycle-vs-command:
 * `completed` expects `complete`, `stopped` expects `stop`.
 *
 * @param targetReader - Read-side dependency used to resolve the claim id.
 * @param options - Terminal command and explicit claim id.
 * @returns Live-claim, stale-claim, or terminal confirm/conflict resolution.
 */
export async function resolveTerminalTarget(
  targetReader: CommandTargetReader,
  options: { readonly command: TerminalCommandName; readonly claimId: ClaimId },
): Promise<TerminalTargetResolution> {
  const claimed = await resolveClaimTarget(targetReader, options.claimId, { includeStashed: false });
  if (claimed.kind !== 'terminal_claim') {
    // 'claim' and 'stale_claim' share identical shapes across both unions.
    return claimed;
  }
  const expectedCommand: TerminalCommandName =
    claimed.lifecycle === 'completed' ? 'complete' : 'stop';
  return expectedCommand === options.command
    ? {
        kind: 'terminal_claim_confirmed',
        claimId: claimed.claimId,
        claim: claimed.claim,
        state: claimed.state,
        lifecycle: claimed.lifecycle,
        command: expectedCommand,
      }
    : {
        kind: 'terminal_claim_conflict',
        claimId: claimed.claimId,
        claim: claimed.claim,
        state: claimed.state,
        lifecycle: claimed.lifecycle,
        expectedCommand,
        requestedCommand: options.command,
      };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rundown-org/core test -- command-target-resolver`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runbook/command-target-resolver.ts \
  packages/core/__tests__/runbook/command-target-resolver.test.ts
git commit -m "feat(core): add resolveTerminalTarget with confirm/conflict split (roadmap item 4)"
```

### Task 4: Add the seam terminal input/outcome types

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts` (imports + new exported types after `LifecycleTransitionOutcome` at `:220`)
- Test: type-level only — exercised by the seam unit tests in Tasks 5/6/7.

**Interfaces:**
- Produces (all exported from `lifecycle-command-service.ts` and re-exported from the core barrel):
  - `LifecycleTerminalInput`
  - `LifecycleTerminalOutcome`
- Consumes: `TerminalCommandName` (Task 3), `CallerEvidence`, `CommandTargetSelector`, `RunId`, `ClaimId`, `TransitionObservationEvent`, `DELEGATION_COLLECTION_PENDING_MESSAGE`, `RunbookState`, the `recordChildCompletion` return type.

- [ ] **Step 1: Add the import**

Add `resolveTerminalTarget`, `type TerminalCommandName`, `type TerminalTargetResolution` to the existing import from `./command-target-resolver.js` (`:13-16`).

- [ ] **Step 2: Add `LifecycleTerminalInput`**

```typescript
/** Input to {@link RunbookLifecycleCommandService.runTerminal}. */
export interface LifecycleTerminalInput {
  /** The terminal command being run. Drives FORCE_COMPLETE vs FORCE_STOP and the
   * derived delegation outcome (via lifecycleToDelegationOutcome), never a literal. */
  readonly command: TerminalCommandName;
  /** Typed caller evidence mapped to an actor context by core. */
  readonly callerEvidence: CallerEvidence;
  /** Target selector — only `default` (bare cascade) or `claim` are valid for a
   * terminal command; an `explicit-step` selector is rejected by `runTerminal`. */
  readonly targetSelector: CommandTargetSelector;
  /** Optional terminal message forwarded to the machine (`FORCE_*.message`). */
  readonly message?: string;
  /** Optional display-result policy for the transition observation projection. */
  readonly computeActionResult?: (actionType: ActionType) => boolean;
}
```

- [ ] **Step 3: Add `LifecycleTerminalOutcome`**

The `reported` field reuses the `recordChildCompletion` return type so no new enum is invented:

```typescript
/** Outcome of the record-before-release child propagation, surfaced for rendering/tests. */
type TerminalReportOutcome = Awaited<ReturnType<RunbookCompletionService['recordChildCompletion']>>;

/**
 * Result of a complete/stop transition through the terminal seam.
 *
 * Refusal variants reuse the {@link TerminalTargetResolution} / policy shapes so
 * the `DELEGATION_COLLECTION_PENDING_MESSAGE` literal type and the terminal-claim
 * confirm/conflict payloads (keyed on `command`) are preserved by construction.
 * There is deliberately NO `open_delegated_children` member (decision #2).
 */
export type LifecycleTerminalOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  | { readonly kind: 'actor_context_required'; readonly targetRunId: RunId }
  | {
      readonly kind: 'delegation_collection_pending';
      readonly parentRunId: RunId;
      readonly outcomeCompletionKeys: readonly string[];
      readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
    }
  | {
      readonly kind: 'terminal_claim_confirmed';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly command: TerminalCommandName;
    }
  | {
      readonly kind: 'terminal_claim_conflict';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly expectedCommand: TerminalCommandName;
      readonly requestedCommand: TerminalCommandName;
    }
  | {
      /** The resolved bare-cascade root was already terminal; the chain was released. */
      readonly kind: 'already_terminal';
      readonly targetRunId: RunId;
      readonly lifecycle: 'completed' | 'stopped';
    }
  | {
      /** Bare cascade could not resolve a running root to force. */
      readonly kind: 'inline_plan_unavailable';
      readonly reason: 'missing-inline-parent' | 'inline-cycle' | 'root-unavailable';
      readonly message: string;
      readonly code: string;
    }
  | {
      /** Single-run claim-path terminal applied. */
      readonly kind: 'applied-claim';
      readonly runId: RunId;
      readonly status: 'completed' | 'stopped';
      readonly events: readonly TransitionObservationEvent[];
      readonly reported: TerminalReportOutcome;
    }
  | {
      /** Multi-run bare inline-cascade terminal applied. */
      readonly kind: 'applied-bare';
      readonly rootRunId: RunId;
      readonly status: 'completed' | 'stopped';
      readonly events: readonly TransitionObservationEvent[];
      readonly forcedRunIds: readonly RunId[];
      readonly reported: TerminalReportOutcome;
    };
```

- [ ] **Step 4: Re-export from the barrel**

In `packages/core/src/runbook/index.ts` (or the package `index.ts` that re-exports the seam), add `LifecycleTerminalInput`, `LifecycleTerminalOutcome`, `TerminalCommandName`, `resolveTerminalTarget`, `TerminalTargetResolution` alongside the existing `LifecycleTransitionOutcome` / `resolveTransitionTarget` exports.

- [ ] **Step 5: Verify it compiles**

Run: `pnpm --filter @rundown-org/core build`
Expected: PASS (no method uses these yet — they land in Stage D).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts packages/core/src/runbook/index.ts
git commit -m "feat(core): add LifecycleTerminalInput/Outcome seam types"
```

### Stage C verification

- [ ] `pnpm --filter @rundown-org/core build`
- [ ] `pnpm --filter @rundown-org/core test -- command-target-resolver`
- [ ] Scoped mutation: `pnpm run test:mutate:core -- --mutate packages/core/src/runbook/command-target-resolver.ts` — expect no surviving mutants on the `expectedCommand` ternary or the confirm/conflict keying.

---

## Stage D — Seam `runTerminal` + CLI rewiring (Items 4 + 9)

> **Seam test scaffolding (applies to Tasks 5/6/7).** The `makeSeam` / `makeSeamWithTerminalClaim` / `makeSeamWithLiveClaim` / `makeSeamWithResolvedChain` / `makeSeamWithResolvedPlan` / `makeSeamWithPlanStatus` factories named in these tasks **do not exist yet — you are writing them.** Build them the way the existing file already builds its subject: construct `new RunbookLifecycleCommandService({...})` from **real** services (`SessionService`, `ExecutionLifecycleService`, `RunbookCompletionService`, `createCliRunbookActorService`/core actor service) over a temp `RunbookStateManager`, exactly like `lifecycle-command-service.test.ts:133` and the `buildIssuanceSeam` helper at `:190-226`. Do **not** invent an injectable-double seam. Wire behaviour and capture calls with `jest.spyOn(sessionService, 'releaseRunbook')` / `jest.spyOn(completionService, 'recordChildCompletion')` / `jest.spyOn(actorService, 'sendAndSync')` (the retain-flag assertion at `:1051` is the proven precedent). For the record-before-release **ordering** arrays (`order: string[]`), attach `.mockImplementation((...args) => { order.push('record'); return realOrFakeResult; })` to the spied methods so the array captures true call order — this is what kills an order-swap mutant, so do not simplify it away.

### Task 5: `runTerminal` dispatcher with `never`-guarded selector routing

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts` (new public method on the class, after `runTransition` at `:394`)
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts` (extend with `runTerminal` doubles, as existing seam tests do)

**Interfaces:**
- Produces: `async runTerminal(input: LifecycleTerminalInput): Promise<LifecycleTerminalOutcome>` — consumed by the CLI `runSeamTerminal` helper (Task 8).
- Consumes: `#driveTerminalClaim` (Task 10), `#driveTerminalBare` (Task 11).

- [ ] **Step 1: Write the failing dispatcher test**

```typescript
it('runTerminal rejects an explicit-step selector', async () => {
  const seam = makeSeam(); // existing double-based factory in this test file
  await expect(
    seam.runTerminal({
      command: 'complete',
      callerEvidence: { kind: 'direct_cli' },
      targetSelector: { kind: 'explicit-step', step: '1.1' },
    }),
  ).rejects.toThrow(/do not support --step/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service`
Expected: FAIL — `runTerminal` does not exist.

- [ ] **Step 3: Implement the dispatcher**

```typescript
  /**
   * Resolve the target, run terminal policy, and force a run (or an inline chain)
   * terminal for a complete/stop command.
   *
   * @param input - Command, caller evidence, target selector (default/claim), and
   *   optional message.
   * @returns A typed refusal or an `applied-claim` / `applied-bare` outcome.
   * @throws {Error} When an `explicit-step` selector is supplied (complete/stop
   *   have no `--step` surface), or on a stale-state / dispatch failure.
   */
  async runTerminal(input: LifecycleTerminalInput): Promise<LifecycleTerminalOutcome> {
    switch (input.targetSelector.kind) {
      case 'claim':
        return this.#driveTerminalClaim(input, input.targetSelector.claimId);
      case 'default':
        return this.#driveTerminalBare(input);
      case 'explicit-step':
        throw new Error('complete/stop do not support --step targeting');
      default: {
        const _exhaustive: never = input.targetSelector;
        throw new Error(`Unsupported terminal target selector: ${String(_exhaustive)}`);
      }
    }
  }
```

- [ ] **Step 4: Add throwing stubs for the two private drivers (so the file compiles)**

Add `#driveTerminalClaim` and `#driveTerminalBare` returning `Promise.reject(new Error('not implemented'))` placeholders; Tasks 6/7 replace their bodies. (This keeps Task 5 independently reviewable while the dispatcher test passes.)

- [ ] **Step 5: Run the dispatcher test to verify it passes**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service -t "explicit-step"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts \
  packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "feat(core): add runTerminal dispatcher with never-guarded selector routing"
```

### Task 6: `#driveTerminalClaim` — claim-path FORCE + record-before-release + retained tombstone

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts` (`#driveTerminalClaim` body)
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`

**Interfaces:**
- Consumes: `resolveTerminalTarget` (Task 3), `actorService.sendAndSync`, `completionService.recordChildCompletion`, `sessionService.releaseRunbook`, `deriveTransitionObservation`, `#findStep`, `loadSteps`.
- Produces: `applied-claim` / `terminal_claim_confirmed` / `terminal_claim_conflict` / `stale_claim` outcomes.

- [ ] **Step 1: Write the failing tests**

```typescript
it('claim complete on a completed child confirms and retains the tombstone', async () => {
  const { seam, releaseSpy } = makeSeamWithTerminalClaim('completed');
  const out = await seam.runTerminal({
    command: 'complete',
    callerEvidence: { kind: 'direct_cli' },
    targetSelector: { kind: 'claim', claimId: CLAIM_ID },
  });
  expect(out.kind).toBe('terminal_claim_confirmed');
  // Idempotent path STILL releases with retain (item 4, second site).
  expect(releaseSpy).toHaveBeenCalledWith(CHILD_RUN_ID, { retainClaimsAsTerminal: true });
});

it('claim complete on a stopped child conflicts (no FORCE, still retains)', async () => {
  const { seam, sendSpy, releaseSpy } = makeSeamWithTerminalClaim('stopped');
  const out = await seam.runTerminal({
    command: 'complete',
    callerEvidence: { kind: 'direct_cli' },
    targetSelector: { kind: 'claim', claimId: CLAIM_ID },
  });
  expect(out.kind).toBe('terminal_claim_conflict');
  expect(sendSpy).not.toHaveBeenCalled();
  expect(releaseSpy).toHaveBeenCalledWith(CHILD_RUN_ID, { retainClaimsAsTerminal: true });
});

it('claim stop on a running child forces FAIL, records before release, derives outcome', async () => {
  const order: string[] = [];
  const { seam, recordSpy, releaseSpy } = makeSeamWithLiveClaim({
    onRecord: () => order.push('record'),
    onRelease: () => order.push('release'),
  });
  const out = await seam.runTerminal({
    command: 'stop',
    callerEvidence: { kind: 'direct_cli' },
    targetSelector: { kind: 'claim', claimId: CLAIM_ID },
  });
  expect(out).toMatchObject({ kind: 'applied-claim', status: 'stopped' });
  // Record BEFORE release (decision #4).
  expect(order).toEqual(['record', 'release']);
  // recordChildCompletion called with NO explicit result (core derives fail).
  expect(recordSpy).toHaveBeenCalledWith({ childState: expect.objectContaining({ id: CHILD_RUN_ID }) });
  expect(releaseSpy).toHaveBeenCalledWith(CHILD_RUN_ID, { retainClaimsAsTerminal: true });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service -t "claim"`
Expected: FAIL — `#driveTerminalClaim` is a stub.

- [ ] **Step 3: Implement `#driveTerminalClaim`**

```typescript
  // Claim-path terminal: resolve confirm/conflict, else FORCE the live child,
  // record its outcome (core-derived) BEFORE releasing with a retained tombstone.
  async #driveTerminalClaim(
    input: LifecycleTerminalInput,
    claimId: ClaimId,
  ): Promise<LifecycleTerminalOutcome> {
    const { sessionService, actorService, completionService } = this.#deps;
    const resolution = await resolveTerminalTarget(sessionService, { command: input.command, claimId });

    switch (resolution.kind) {
      case 'stale_claim':
        return { kind: 'stale_claim', claimId: resolution.claimId, message: resolution.message };
      case 'terminal_claim_confirmed':
        // Idempotent no-op: child already terminal. Still release with retain so a
        // later --claim-id can confirm/conflict again (item 4, second site).
        await sessionService.releaseRunbook(resolution.state.id, { retainClaimsAsTerminal: true });
        return {
          kind: 'terminal_claim_confirmed',
          claimId: resolution.claimId,
          lifecycle: resolution.lifecycle,
          command: resolution.command,
        };
      case 'terminal_claim_conflict':
        await sessionService.releaseRunbook(resolution.state.id, { retainClaimsAsTerminal: true });
        return {
          kind: 'terminal_claim_conflict',
          claimId: resolution.claimId,
          lifecycle: resolution.lifecycle,
          expectedCommand: resolution.expectedCommand,
          requestedCommand: resolution.requestedCommand,
        };
      case 'claim':
        break;
      default: {
        const _exhaustive: never = resolution;
        return _exhaustive;
      }
    }

    const state = resolution.state;
    const steps = await this.#deps.loadSteps(state);
    const currentStep = this.#findStep(steps, state.step);
    // Exhaustive command→event map with a `never` fallthrough (No silent mapping).
    const eventType = ((): 'FORCE_COMPLETE' | 'FORCE_STOP' => {
      switch (input.command) {
        case 'complete':
          return 'FORCE_COMPLETE';
        case 'stop':
          return 'FORCE_STOP';
        default: {
          const _exhaustive: never = input.command;
          throw new Error(`Unsupported terminal command: ${String(_exhaustive)}`);
        }
      }
    })();

    const syncResult = await actorService.sendAndSync(state.id, steps, {
      type: eventType,
      ...(input.message !== undefined ? { message: input.message } : {}),
    });
    if (!syncResult) {
      throw new Error('Failed to dispatch terminal transition to runbook engine');
    }

    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState: state,
      updatedState: syncResult.state,
      snapshot: syncResult.snapshot,
      result: input.command === 'complete' ? 'pass' : 'fail',
      ...(input.computeActionResult ? { computeActionResult: input.computeActionResult } : {}),
    });

    // Record BEFORE release (decision #4). No explicit `result` → core derives
    // completed→pass / stopped→fail via lifecycleToDelegationOutcome (kills the
    // complete.ts:236 / stop.ts:215 literals). recordChildCompletion self-guards
    // when the child carries no linkage (returns 'not-applicable').
    const reported = await completionService.recordChildCompletion({ childState: syncResult.state });

    await sessionService.releaseRunbook(state.id, { retainClaimsAsTerminal: true });

    return {
      kind: 'applied-claim',
      runId: state.id,
      status: syncResult.state.lifecycle === 'stopped' ? 'stopped' : 'completed',
      events: observation.events,
      reported,
    };
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service -t "claim"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts \
  packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "feat(core): claim-path terminal seam records before release, retains tombstone (item 4/9)"
```

### Task 7: `#driveTerminalBare` — absorb the inline FORCE cascade + gate the resolved root

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts` (`#driveTerminalBare` body); add `sessionService.releaseRunbooks` to the dependency surface if not already reachable (it is a `SessionService` method, already injected).
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`

**Interfaces:**
- Consumes: `sessionService.resolveActiveInlineForceTerminalPlan` (`session-service.ts:552`), `actorContextFromEvidence`, `resolveCommandIntent` with `{ kind: 'terminal-run-force', … }`, `actorService.sendAndSync`, `deriveTransitionObservation`, `completionService.recordChildCompletion`, `sessionService.releaseRunbook` (root, retain) + `sessionService.releaseRunbooks` (descendants).
- Produces: `applied-bare` / `none` / `already_terminal` / `inline_plan_unavailable` / `actor_context_required` / `delegation_collection_pending`.

- [ ] **Step 1: Write the failing tests**

```typescript
it('bare complete refuses with actor_context_required when caller evidence is unknown', async () => {
  const seam = makeSeamWithResolvedPlan({ rootRunId: ROOT, running: true });
  const out = await seam.runTerminal({
    command: 'complete',
    callerEvidence: { kind: 'unknown' }, // maps to unknown_for_target on the root
    targetSelector: { kind: 'default' },
  });
  expect(out).toEqual({ kind: 'actor_context_required', targetRunId: ROOT });
});

it('bare stop refuses when the resolved root is collection pending (item 8)', async () => {
  const seam = makeSeamWithResolvedPlan({ rootRunId: ROOT, running: true, collectionPending: true });
  const out = await seam.runTerminal({
    command: 'stop',
    callerEvidence: { kind: 'direct_cli' },
    targetSelector: { kind: 'default' },
  });
  expect(out.kind).toBe('delegation_collection_pending');
});

it('bare complete forces the chain descendant-to-root and records the root before release', async () => {
  const order: string[] = [];
  const seam = makeSeamWithResolvedChain({
    forceOrder: [CHILD, ROOT],
    onSend: (id) => order.push(`force:${id}`),
    onRecord: () => order.push('record'),
    onReleaseRoot: () => order.push('release-root'),
    onReleaseDescendants: () => order.push('release-descendants'),
  });
  const out = await seam.runTerminal({
    command: 'complete',
    callerEvidence: { kind: 'direct_cli' },
    targetSelector: { kind: 'default' },
  });
  expect(out).toMatchObject({ kind: 'applied-bare', rootRunId: ROOT, status: 'completed' });
  expect(order).toEqual(['force:CHILD', 'force:ROOT', 'record', 'release-descendants', 'release-root']);
  // Root released WITH retain; descendants WITHOUT.
  expect(releaseRootSpy).toHaveBeenCalledWith(ROOT, { retainClaimsAsTerminal: true });
  expect(releaseDescendantsSpy).toHaveBeenCalledWith([CHILD]);
});

it('bare stop maps a non-running resolved root to already_terminal', async () => {
  const seam = makeSeamWithResolvedPlan({ rootRunId: ROOT, running: false, lifecycle: 'completed' });
  const out = await seam.runTerminal({
    command: 'stop',
    callerEvidence: { kind: 'direct_cli' },
    targetSelector: { kind: 'default' },
  });
  expect(out).toEqual({ kind: 'already_terminal', targetRunId: ROOT, lifecycle: 'completed' });
});

it.each([
  ['none', 'none'],
  ['missing-inline-parent', 'inline_plan_unavailable'],
  ['inline-cycle', 'inline_plan_unavailable'],
])('bare complete maps plan status %s to outcome %s', async (planStatus, outcomeKind) => {
  const seam = makeSeamWithPlanStatus(planStatus);
  const out = await seam.runTerminal({
    command: 'complete',
    callerEvidence: { kind: 'direct_cli' },
    targetSelector: { kind: 'default' },
  });
  expect(out.kind).toBe(outcomeKind);
});

it('bare complete surfaces root-unavailable when the resolved root races to null (RUNBOOK_STATE_CHANGED)', async () => {
  // Distinct from the plan.status cases above: the plan resolves (root running),
  // but the root's sendAndSync returns null mid-loop, so forcedRunIds never
  // includes the root and the dedicated non-terminal outcome fires (plan body
  // "Root raced to null"). Spy sendAndSync to resolve null for plan.targetState.id.
  const seam = makeSeamWithResolvedPlan({ rootRunId: ROOT, running: true, forceRacesToNull: true });
  const out = await seam.runTerminal({
    command: 'complete',
    callerEvidence: { kind: 'direct_cli' },
    targetSelector: { kind: 'default' },
  });
  expect(out).toMatchObject({
    kind: 'inline_plan_unavailable',
    reason: 'root-unavailable',
    code: 'RUNBOOK_STATE_CHANGED',
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service -t "bare"`
Expected: FAIL — `#driveTerminalBare` is a stub.

- [ ] **Step 3: Implement `#driveTerminalBare`**

```typescript
  // Bare-cascade terminal: resolve the inline chain, gate the resolved root, force
  // descendant→root collecting observations, record the root outcome BEFORE
  // releasing (root retains its tombstone; descendants delete).
  async #driveTerminalBare(input: LifecycleTerminalInput): Promise<LifecycleTerminalOutcome> {
    const { sessionService, actorService, completionService } = this.#deps;
    const plan = await sessionService.resolveActiveInlineForceTerminalPlan(input.command);

    switch (plan.status) {
      case 'none':
        return { kind: 'none' };
      case 'missing-inline-parent':
        return {
          kind: 'inline_plan_unavailable',
          reason: 'missing-inline-parent',
          message: `Inline parent ${plan.missingParentRunId} is unavailable`,
          code: 'INLINE_PARENT_UNAVAILABLE',
        };
      case 'inline-cycle':
        return {
          kind: 'inline_plan_unavailable',
          reason: 'inline-cycle',
          message: `Inline parent cycle detected at ${plan.repeatedRunId}`,
          code: 'INLINE_PARENT_CYCLE',
        };
      case 'resolved':
        break;
      default: {
        const _exhaustive: never = plan;
        return _exhaustive;
      }
    }

    if (plan.targetState.lifecycle !== 'running') {
      // Resolved but already terminal: release the chain (explicit teardown) and
      // report the no-op. The root is terminal, so retaining vs deleting the
      // tombstone is moot — keep the existing bulk release.
      await sessionService.releaseRunbooks(plan.releaseRunIds);
      return {
        kind: 'already_terminal',
        targetRunId: plan.targetState.id,
        lifecycle: plan.targetState.lifecycle === 'stopped' ? 'stopped' : 'completed',
      };
    }

    // Gate the resolved ROOT before forcing (items 8 + 2-core). Root linkage is
    // delegation-or-none, so `terminal-run-force` targeted:false runs the
    // actor-context + collection-pending gates on it.
    const actorContext = actorContextFromEvidence(input.callerEvidence, plan.targetState.id);
    const policy = resolveCommandIntent({
      actorContext,
      intent: { kind: 'terminal-run-force', command: input.command, targeted: false },
      targetSelector: { kind: 'default' },
      targetState: plan.targetState,
    });
    switch (policy.kind) {
      case 'allowed':
        break;
      case 'actor_context_required':
        return { kind: 'actor_context_required', targetRunId: plan.targetState.id };
      case 'delegation_collection_pending':
        return {
          kind: 'delegation_collection_pending',
          parentRunId: policy.parentRunId,
          outcomeCompletionKeys: policy.outcomeCompletionKeys,
          message: policy.message,
        };
      case 'open_claims':
      case 'collect_requires_orchestrator':
      case 'missing_outcomes':
      case 'already_collected':
      case 'collection_frame_not_active':
      case 'collection_applied':
      case 'collection_failed':
        // Unreachable for a bare terminal-run-force intent: `open_claims` is keyed
        // on `delegating-run-advance` only (command-policy.ts:345 — decision #2
        // forces terminal through open children), and the collection-operation /
        // orchestrator outcomes belong to the collection path (emitted by
        // collectDelegationOutcomes, never resolveCommandIntent). A real
        // occurrence is an invariant violation, not an expected refusal, so it
        // stays a throw. Enumerating them (rather than a bare `default: throw`)
        // preserves compile-time exhaustiveness: a future DelegationPolicyOutcome
        // member fails the build here instead of silently reaching the throw.
        // Mirrors resolveTransitionTarget (command-target-resolver.ts:337-352).
        throw new Error(`Unexpected terminal policy outcome: ${policy.kind}`);
      default: {
        const _exhaustive: never = policy;
        return _exhaustive;
      }
    }

    const eventType = input.command === 'complete' ? 'FORCE_COMPLETE' : 'FORCE_STOP';
    const events: TransitionObservationEvent[] = [];
    const forcedRunIds: RunId[] = [];
    let finalRootState: RunbookState = plan.targetState;

    // Force descendant→root (force-terminal-workflow.ts:194-218 body, collecting
    // observations instead of streaming).
    for (const state of plan.forceOrder) {
      if (state.lifecycle !== 'running') continue;
      const steps = await this.#deps.loadSteps(state);
      const currentStep = this.#findStep(steps, state.step);
      const result = await actorService.sendAndSync(state.id, steps, {
        type: eventType,
        ...(input.message !== undefined ? { message: input.message } : {}),
      });
      if (!result) continue; // raced to null; skip (matches prior behaviour)
      forcedRunIds.push(state.id);
      const observation = deriveTransitionObservation({
        steps,
        currentStep,
        previousState: state,
        updatedState: result.state,
        snapshot: result.snapshot,
        result: input.command === 'complete' ? 'pass' : 'fail',
        ...(input.computeActionResult ? { computeActionResult: input.computeActionResult } : {}),
      });
      events.push(...observation.events);
      if (state.id === plan.targetState.id) finalRootState = result.state;
    }

    // Root raced to null → never forced; surface the dedicated non-terminal outcome
    // (force-terminal-workflow.ts:228-234).
    if (!forcedRunIds.includes(plan.targetState.id)) {
      return {
        kind: 'inline_plan_unavailable',
        reason: 'root-unavailable',
        message: `Runbook state changed during force-${input.command}; retry`,
        code: 'RUNBOOK_STATE_CHANGED',
      };
    }

    // Record the ROOT outcome BEFORE releasing (decision #4). Core derives the
    // outcome (kills complete.ts:124 / stop.ts:117 literals); self-guards since the
    // root's linkage is delegation-or-none (inline descendants never reach here as
    // the propagating child — only the root propagates).
    const reported = await completionService.recordChildCompletion({ childState: finalRootState });

    // Release descendants (no claims → delete) then the root (retain tombstone,
    // decision #3). Descendant ids are the chain minus the root.
    const descendantReleaseIds = plan.releaseRunIds.filter((id) => id !== plan.targetState.id);
    if (descendantReleaseIds.length > 0) {
      await sessionService.releaseRunbooks(descendantReleaseIds);
    }
    await sessionService.releaseRunbook(plan.targetState.id, { retainClaimsAsTerminal: true });

    return {
      kind: 'applied-bare',
      rootRunId: plan.targetState.id,
      status: finalRootState.lifecycle === 'stopped' ? 'stopped' : 'completed',
      events,
      forcedRunIds,
      reported,
    };
  }
```

Add the `actorContextFromEvidence` and `resolveCommandIntent` imports if not already present (`resolveCommandIntent` is imported at `:11`; `actorContextFromEvidence` at `:4`).

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service -t "bare"`
Expected: PASS.

- [ ] **Step 5: Run the full seam test file**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service`
Expected: PASS (existing `runTransition` tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts \
  packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "feat(core): absorb bare inline FORCE cascade into #driveTerminalBare with root gate (item 1/8/9)"
```

### Task 8: CLI `runSeamTerminal` helper + `renderTerminalRefusal` / `renderTerminalApplied`

**Files:**
- Create: `packages/cli/src/helpers/terminal-command.ts`
- Test: `packages/cli/__tests__/helpers/terminal-command.test.ts` (new)

**Interfaces:**
- Produces: `export async function runSeamTerminal(output: OutputEmitter, cwd: string, command: TerminalCommandName, options: { readonly claimId?: ClaimId; readonly message?: string }): Promise<{ readonly manager: RunbookStateManager; readonly exitError: boolean }>` — consumed by `complete.ts`/`stop.ts` (Task 9).
- Consumes: `RunbookLifecycleCommandService`, the seam constructor deps (mirror `runSeamTransition` at `transitions.ts:703-715`), `readLifecycleCallerEvidence`, `ForceTerminalEventBridge` (relocated here from `force-terminal-workflow.ts`), `OutputEmitter`, `buildMetadata`.

- [ ] **Step 1: Write the failing test**

Cover the refusal renderers and exit codes via the JSON path (CLAUDE.md: JSON first). Use the in-process CLI harness or double the seam. Minimum cases:

Every `LifecycleTerminalOutcome` member that `renderTerminalOutcome` handles must be driven at least once — the switch's `return true`/`return false` and `outcome.code` passthrough are named Stryker targets (Stage D), so an undriven member leaves a surviving mutant. Cover all ten kinds:

```typescript
it('renders none as noActiveRunbook and exits 0', async () => { /* kind: 'none' → return false */ });
it('renders a stale_claim outcome as CLAIMED_RUNBOOK_UNAVAILABLE and exits non-zero', async () => { /* … */ });
it('renders actor_context_required as ACTOR_CONTEXT_REQUIRED and exits non-zero', async () => { /* carries targetRunId */ });
it('renders delegation_collection_pending via emitDelegationCollectionPendingError and exits non-zero', async () => { /* … */ });
it('renders terminal_claim_confirmed as an idempotent already-resolved payload, exit 0', async () => { /* … */ });
it('renders terminal_claim_conflict as DELEGATION_RESULT_CONFLICT and exits non-zero', async () => { /* … */ });
it('renders already_terminal as RUNBOOK_NOT_RUNNING and exits 0', async () => { /* kind: 'already_terminal' → return false */ });
it.each([
  ['missing-inline-parent', 'INLINE_PARENT_UNAVAILABLE'],
  ['inline-cycle', 'INLINE_PARENT_CYCLE'],
  ['root-unavailable', 'RUNBOOK_STATE_CHANGED'],
])('renders inline_plan_unavailable (%s) with code %s and exits non-zero', async (reason, code) => {
  /* assert output.error called with outcome.code === code AND exitError === true */
});
it('applied-bare stopped → exit non-zero; applied-* completed → exit 0', async () => { /* … */ });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rundown-org/cli test -- terminal-command`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `runSeamTerminal`**

Build the seam exactly like `runSeamTransition` (`transitions.ts:703-715`), then render:

```typescript
export async function runSeamTerminal(
  output: OutputEmitter,
  cwd: string,
  command: TerminalCommandName,
  options: { readonly claimId?: ClaimId; readonly message?: string } = {},
): Promise<{ readonly manager: RunbookStateManager; readonly exitError: boolean }> {
  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
  const seam = new RunbookLifecycleCommandService({
    sessionService,
    actorService,
    lifecycleService,
    completionService,
    loadRun: async (id) => (await manager.load(id)) ?? undefined,
    loadSteps: (state) => getRunbookFromState(state, cwd),
    // `RunbookLifecycleCommandServiceDependencies` has NINE non-optional members
    // (lifecycle-command-service.ts:62-123). `runTerminal` drives complete/stop
    // only and never issues delegations, so the three issuance deps are guarded
    // stubs — copy them verbatim from `runSeamTransition` (transitions.ts:721-729)
    // so the front end stays off the runbook-resolver import graph.
    resolveChildRunbook: () => {
      throw new Error('runSeamTerminal seam does not issue delegations');
    },
    persistIssuedSubstep: () => {
      throw new Error('runSeamTerminal seam does not issue delegations');
    },
    findDelegationByToken: () => {
      throw new Error('runSeamTerminal seam does not issue delegations');
    },
  });

  const targetSelector: CommandTargetSelector = options.claimId
    ? { kind: 'claim', claimId: options.claimId }
    : { kind: 'default' };

  const outcome = await seam.runTerminal({
    command,
    callerEvidence: readLifecycleCallerEvidence(),
    targetSelector,
    ...(options.message !== undefined ? { message: options.message } : {}),
    computeActionResult:
      command === 'complete'
        ? (actionType) => actionType !== 'RETRY' && actionType !== 'STOP'
        : () => false,
  });

  const exitError = await renderTerminalOutcome(output, command, manager, outcome);
  output.flush();
  return { manager, exitError };
}
```

`renderTerminalOutcome` switches exhaustively over `LifecycleTerminalOutcome` and reuses the existing renderers (do NOT invent new codes):

```typescript
async function renderTerminalOutcome(
  output: OutputEmitter,
  command: TerminalCommandName,
  manager: RunbookStateManager,
  outcome: LifecycleTerminalOutcome,
): Promise<boolean> {
  switch (outcome.kind) {
    case 'none':
      output.noActiveRunbook(command);
      return false;
    case 'stale_claim':
      output.error(outcome.message, 'CLAIMED_RUNBOOK_UNAVAILABLE');
      return true;
    case 'actor_context_required':
      output.error(`Actor context is required to ${command} this run.`, 'ACTOR_CONTEXT_REQUIRED', {
        targetRunId: outcome.targetRunId,
      });
      return true;
    case 'delegation_collection_pending':
      emitDelegationCollectionPendingError(
        output,
        command, // widen emitDelegationCollectionPendingError's command param — see Task 8 note
        outcome.parentRunId,
        outcome.outcomeCompletionKeys,
        outcome.message,
      );
      return true;
    case 'terminal_claim_confirmed':
      if (output.isJson()) {
        output.json({
          kind: 'action',
          action: command,
          status: 'already-resolved',
          claimId: outcome.claimId,
          lifecycle: outcome.lifecycle,
        });
      } else {
        output.message(`ALREADY ${command.toUpperCase()}  claim ${outcome.claimId} (child ${outcome.lifecycle})`);
      }
      return false;
    case 'terminal_claim_conflict':
      output.error(
        `Claim ${outcome.claimId} already resolved as ${outcome.expectedCommand}; cannot ${outcome.requestedCommand} it.`,
        'DELEGATION_RESULT_CONFLICT',
      );
      return true;
    case 'already_terminal':
      output.noActiveRunbook(command, 'RUNBOOK_NOT_RUNNING');
      return false;
    case 'inline_plan_unavailable':
      output.error(outcome.message, outcome.code);
      return true; // all three reasons (missing-inline-parent/inline-cycle/root-unavailable) exit non-zero
    case 'applied-claim':
    case 'applied-bare': {
      const rootRunId = outcome.kind === 'applied-claim' ? outcome.runId : outcome.rootRunId;
      const rootState = await manager.load(rootRunId);
      if (rootState) output.metadata(buildMetadata(rootState));
      if (outcome.events.length > 0 && rootState) {
        const bridge = new ForceTerminalEventBridge(output);
        for (const event of outcome.events) bridge.emit(rootState, event);
      }
      if (outcome.status === 'stopped') {
        output.stopped('Runbook stopped');
        return true;
      }
      output.complete('Runbook completed successfully');
      return false;
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
```

**Task 8 note — `emitDelegationCollectionPendingError` command param.** Its signature (`transitions.ts:440`) currently types `command: 'pass' | 'fail' | 'delegate'`. Widen it to `'pass' | 'fail' | 'delegate' | 'complete' | 'stop'` (a message-only widening; the body just interpolates `command`). This is the single shared refusal renderer — do not fork it.

**Event attribution note.** The seam returns `events` already ordered descendant→root but without per-state runbook-id attribution. Streaming them all through one `ForceTerminalEventBridge` bound to the loaded root state stamps them with the root's `runbookId`/`runbook` ref. This is an accepted simplification: the terminal command is one logical action on the root. If per-descendant attribution must be preserved, extend `applied-bare` to carry `readonly events: readonly { runId: RunId; runbook: string; event: TransitionObservationEvent }[]` and stamp per element — flagged as a follow-up, not required for correctness.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rundown-org/cli test -- terminal-command`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/helpers/terminal-command.ts \
  packages/cli/src/helpers/transitions.ts \
  packages/cli/__tests__/helpers/terminal-command.test.ts
git commit -m "feat(cli): add runSeamTerminal helper wiring complete/stop through the core terminal seam"
```

### Task 9: Collapse `complete.ts` and `stop.ts` to thin front ends + flip tombstone tests

**Files:**
- Modify: `packages/cli/src/commands/complete.ts`, `packages/cli/src/commands/stop.ts`
- Test: `packages/cli/__tests__/commands/complete.test.ts:361-367` (flip), `packages/cli/__tests__/commands/stop.test.ts:433-435` (flip)

**Interfaces:**
- Consumes: `runSeamTerminal` (Task 8), `parseClaimIdOption`, `withErrorHandling`, `OutputEmitter`.
- Removes: direct `forceTerminalWorkflow`, `resolveCommandTarget`, `sendAndSync`, `releaseRunbook`, `propagateChildTerminal`, and the four hand-rolled literal sites (`complete.ts:124`+`236`, `stop.ts:117`+`215`).

- [ ] **Step 1: Flip the tombstone-retention bug-pinning tests**

`complete.test.ts:361-367` currently asserts the claim tombstone is **deleted**:

```typescript
// CURRENT (bug-pinning):
expect(Object.values(session.claims)).not.toContainEqual(
  expect.objectContaining({ childRunId }),
);
```

Change to assert it is **retained**:

```typescript
// CORRECTED (item 4 fixed):
expect(Object.values(session.claims)).toContainEqual(
  expect.objectContaining({ childRunId }),
);
```

Apply the identical flip to `stop.test.ts:433-435` (the `stop` idempotent no-op test), matching the already-correct `stop.test.ts:380-381` which asserts `toContainEqual` for the stale-claim path.

- [ ] **Step 2: Run to verify they fail against the current code**

Run: `pnpm --filter @rundown-org/cli test -- complete stop`
Expected: FAIL — current `complete.ts:201`/`:231` and `stop.ts:177`/`:204` call `releaseRunbook(state.id)` with no retain, so the tombstone is deleted.

- [ ] **Step 3: Rewrite `complete.ts`**

Reduce the action body to Category-A parsing + a single seam call + exit code:

```typescript
export function registerCompleteCommand(program: Command): void {
  program
    .command('complete')
    .description('Force early completion of current runbook (runbooks auto-complete on final step)')
    .argument('[message]', 'Completion message')
    .option('--claim-id <claimId>', 'Target a claimed delegated child runbook')
    .option('--text', 'Output as human-readable text')
    .action(async (message: string | undefined, options: { claimId?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'complete' });
          const cwd = getCwd();
          const claimTarget = parseClaimIdOption(options.claimId, output);
          if (!claimTarget.ok) return;

          const { exitError } = await runSeamTerminal(output, cwd, 'complete', {
            ...(claimTarget.claimId ? { claimId: claimTarget.claimId } : {}),
            ...(message !== undefined ? { message } : {}),
          });
          if (exitError) process.exitCode = 1;
        },
        { text: options.text },
      );
    });
}
```

**Recovery-path note.** The current `complete.ts:73-90` orphan-cleanup on `InvalidRunbookStateError` / recoverable active-stack errors is a genuine CLI concern (Category A: unusable persisted snapshot). Preserve it by wrapping the `runSeamTerminal` call in the same `try/catch` and calling `cleanupOrphanedActiveStack(manager, sessionService)` on those error kinds. Keep this catch minimal — it is the only CLI logic that survives the collapse. (`runSeamTerminal` returns the `manager`; construct `sessionService` from it, or have the catch build its own.)

- [ ] **Step 4: Rewrite `stop.ts`** identically, with `'stop'` and `runSeamTerminal(output, cwd, 'stop', …)`; preserve its own orphan-cleanup catch (`stop.ts:66-83`).

- [ ] **Step 5: Delete/absorb `force-terminal-workflow.ts`**

Move `ForceTerminalEventBridge` into `terminal-command.ts` (Task 8 already imports it there) and delete `packages/cli/src/helpers/force-terminal-workflow.ts` plus its test `packages/cli/__tests__/helpers/force-terminal-workflow.test.ts` (its behaviour is now covered by the core seam tests + `terminal-command.test.ts`). Remove the now-unused imports (`forceTerminalWorkflow`, `propagateChildTerminal`, `extractParentLinkage`, `resolveCommandTarget`, `createCliRunbookActorService`, `getRunbookFromState`, `buildMetadata`, `InvalidRunbookStateError` unless still used by the recovery catch) from `complete.ts`/`stop.ts`.

- [ ] **Step 6: Run the flipped + full command tests**

Run: `pnpm --filter @rundown-org/cli test -- complete stop`
Expected: PASS — tombstone now retained; all existing behavioural assertions (exit codes, no-active-runbook, terminal no-op, parent propagation via core `reported`) still hold.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/complete.ts packages/cli/src/commands/stop.ts \
  packages/cli/src/helpers/terminal-command.ts \
  packages/cli/__tests__/commands/complete.test.ts packages/cli/__tests__/commands/stop.test.ts
git rm packages/cli/src/helpers/force-terminal-workflow.ts \
  packages/cli/__tests__/helpers/force-terminal-workflow.test.ts
git commit -m "refactor(cli): route complete/stop through core terminal seam; retain tombstone (items 2/4/9)"
```

### Task 10: End-to-end integration coverage (Items 2 + 8)

**Files:**
- Test: `packages/cli/__tests__/integration/collection-pending-lifecycle.test.ts` (extend, mirroring existing bare pass/fail refusal cases)
- Test: a subprocess-front-end withhold assertion (extend the existing subprocess/MCP boundary integration test, or `collection-pending-lifecycle.test.ts`).

**Interfaces:** none new — exercises the full CLI → seam path.

- [ ] **Step 1: Write the failing integration tests**

Extend `collection-pending-lifecycle.test.ts` and **reuse its existing helpers** — `runCliInProcess`, `injectDelegationOutcomeForActiveRun` (arranges the reported-but-uncollected outcome row), and the file-local `emittedCodes(stdout)` scanner (`:21`). Do **not** use `findErrorOutput` (it does not exist) or `JSON.parse` on stdout — the seam streams *concatenated* JSON (events + action/error), so scan codes across all emitted objects via `emittedCodes` exactly as the existing bare-pass refusal case does (`:79-81`):

```typescript
it('bare rd complete against a collection-pending run refuses with DELEGATION_COLLECTION_PENDING (item 8 e2e)', async () => {
  // Arrange: delegating parent with a reported-but-uncollected outcome row.
  await injectDelegationOutcomeForActiveRun(workspace);
  // Act: run bare `complete` in-process.
  const result = await runCliInProcess('complete', workspace);
  expect(result.exitCode).toBe(1);
  expect(emittedCodes(result.stdout)).toContain('DELEGATION_COLLECTION_PENDING');
});

it('bare rd stop against a collection-pending run refuses (item 8 e2e)', async () => {
  await injectDelegationOutcomeForActiveRun(workspace);
  const result = await runCliInProcess('stop', workspace);
  expect(result.exitCode).toBe(1);
  expect(emittedCodes(result.stdout)).toContain('DELEGATION_COLLECTION_PENDING');
});

it('a subprocess front end withholds bare complete/stop (item 2 e2e)', () => {
  expect(bareRoleSpecificMutation(['complete'])).toBe('complete');
  expect(bareRoleSpecificMutation(['stop'])).toBe('stop');
  expect(bareRoleSpecificMutation(['complete', '--claim-id', 'x'])).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify they fail (before Tasks 2/7/9 land) / pass (after)**

Run: `pnpm --filter @rundown-org/cli test:integration -- collection-pending-lifecycle`
Expected: PASS once Stages B + D are integrated (the CLI now routes through the gated seam).

- [ ] **Step 3: Commit**

```bash
git add packages/cli/__tests__/integration/collection-pending-lifecycle.test.ts
git commit -m "test(cli): pin bare complete/stop collection-pending refusal + subprocess withhold e2e (items 2/8)"
```

### Task 11: Claim-path propagation/ordering integration coverage (Items 4 + 9)

**Files:**
- Test: `packages/cli/__tests__/commands/complete.test.ts`, `stop.test.ts` (new cases alongside the flipped ones)

- [ ] **Step 1: Write the failing tests**

Reuse the real helpers these files already import — `findActionOutput`, `readRunbookState`, `readSession` — plus `parseConcatenatedJson` (test-utils export) for code scanning and `readDelegationOutcomeReportedFacts` (imported from `@rundown-org/core`) for the derived-outcome assertion. There is **no** `findErrorOutput` or `parentDelegationOutcome` helper — do not reference them.

```typescript
it('rd stop --claim-id on a stopped child confirms idempotently and retains the tombstone', async () => {
  // (already covered by the flipped test; add the confirmed-payload assertion)
  const action = findActionOutput(result.stdout);
  expect(action).toMatchObject({ status: 'already-resolved', lifecycle: 'stopped' });
});

it('rd complete --claim-id on a stopped child conflicts (DELEGATION_RESULT_CONFLICT)', async () => {
  // The seam emits JSON; scan the concatenated objects for the refusal code.
  const codes = parseConcatenatedJson(result.stdout).map((o) => (o as { code?: string }).code);
  expect(codes).toContain('DELEGATION_RESULT_CONFLICT');
  expect(result.exitCode).not.toBe(0);
});

it('rd stop --claim-id on a running child reports fail (derived) to the parent before release', async () => {
  // After: the parent carries a delegation-outcome row whose outcome is 'fail',
  // DERIVED by core from the stopped lifecycle (not a CLI literal). Read it with
  // the real core projector — asserting the derived value directly is what pins
  // item 9 (a collection-pending refusal alone does NOT distinguish pass/fail).
  const parent = await readRunbookState(workspace, parentRunId);
  expect(parent).not.toBeNull();
  const outcomes = readDelegationOutcomeReportedFacts(parent!).map((fact) => fact.outcome);
  expect(outcomes).toContain('fail');
  // AND the claim tombstone is retained (record-before-release + retain).
  const session = await readSession(workspace);
  expect(Object.values(session.claims)).toContainEqual(expect.objectContaining({ childRunId }));
});
```

- [ ] **Step 2: Run to verify** — Run: `pnpm --filter @rundown-org/cli test -- complete stop`; Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/__tests__/commands/complete.test.ts packages/cli/__tests__/commands/stop.test.ts
git commit -m "test(cli): pin claim-path terminal confirm/conflict + derived parent outcome (items 4/9)"
```

### Stage D verification

- [ ] `pnpm run build`
- [ ] `pnpm test` (unit, all packages)
- [ ] `pnpm run test:integration`
- [ ] `pnpm run test:property`
- [ ] Scoped mutation:
  - `pnpm run test:mutate:core -- --mutate packages/core/src/runbook/lifecycle-command-service.ts`
  - `pnpm run test:mutate:cli -- --mutate packages/cli/src/commands/complete.ts --testFiles packages/cli/__tests__/commands/complete.test.ts`
  - `pnpm run test:mutate:cli -- --mutate packages/cli/src/commands/stop.ts --testFiles packages/cli/__tests__/commands/stop.test.ts`
  - `pnpm run test:mutate:cli -- --mutate packages/cli/src/helpers/terminal-command.ts --testFiles packages/cli/__tests__/helpers/terminal-command.test.ts`
  - Target: no surviving mutants on the record-before-release ordering, the `retainClaimsAsTerminal: true` flags, the confirm/conflict keying, the FORCE_COMPLETE/FORCE_STOP `never` switches, and the exit-code branches.

---

## Final verification (before any push)

- [ ] `pnpm run build` — type-checks all new discriminated unions + `never` guards.
- [ ] `pnpm test` then `pnpm run test:integration` — unit + in-process CLI tests.
- [ ] `pnpm run test:property` — subprocess-boundary property tests.
- [ ] `pnpm run verify` — format + spell + lint + test (MUST run before push).
- [ ] All four scoped Stryker runs (Stages A–D above) show no surviving mutants on the new gate/keying/ordering branches.
- [ ] **Manual smoke:**
  1. Drive a delegated child terminal via `rd complete --claim-id <id>`; confirm the parent shows collection-pending and the claim tombstone survives (`rd status` / session inspection).
  2. Repeat the same `--claim-id`; confirm it is an idempotent `already-resolved` (not a re-force, not a delete).
  3. Bare `rd complete` on a collection-pending parent refuses with `DELEGATION_COLLECTION_PENDING`.

---

## Self-Review (checklist run against the high-level plan)

**1. Spec coverage:**
- Item 2 (Trust) → Task 1 (withhold set) + Task 10 (e2e). ✓
- Item 4 (tombstone retain) → Tasks 3/6 (claim retain, both sites) + Task 7 (bare root retain) + Task 9 (flipped tests). ✓
- Item 8 (collection-pending) → Task 2 (gate) + Task 7 (bare root gate) + Task 10 (e2e). ✓
- Item 9 (core derivation) → Tasks 6/7 (`recordChildCompletion` with no explicit `result`) retiring `complete.ts:124`+`236`, `stop.ts:117`+`215` + Task 11 (derived-outcome assertion). ✓
- Decision #1 (full cascade in seam) → Task 7. ✓  Decision #2 (force through open children) → Task 2 (open_claims NOT extended) + Task 7 (no open-children member). ✓  Decision #3 (retain root, delete descendants) → Task 7. ✓  Decision #4 (record-before-release) → Tasks 6/7 (ordering assertions). ✓  Decision #5 (no aliases) → Task 1 (`complete: []`, `stop: []`). ✓

**2. Placeholder scan:** every code step shows concrete code; every test step shows the assertion; no "TBD"/"handle edge cases". ✓

**3. Type consistency:** `TerminalCommandName` used identically in Tasks 3/4/5/6/7/8; `LifecycleTerminalOutcome` members (`applied-claim.runId` vs `applied-bare.rootRunId`) referenced consistently in Task 8's renderer; `terminal_claim_confirmed.command` / `terminal_claim_conflict.expectedCommand`+`requestedCommand` keyed on command everywhere; `reported: TerminalReportOutcome` reuses `recordChildCompletion`'s return type. ✓

**4. `never` exhaustiveness:** every new `switch` (runTerminal selector, `#driveTerminalClaim` resolution, `#driveTerminalBare` plan.status, `#driveTerminalBare` policy.kind — with the unreachable collection/open-claims members enumerated before the `never` default, mirroring `resolveTransitionTarget` at `command-target-resolver.ts:337-352` — command→event maps, `renderTerminalOutcome`) ends in a `const _exhaustive: never = …` default. ✓

## Follow-ups (out of scope — note only)
- Optional: align pass/fail to the stricter record-before-release ordering (roadmap mandates it only for complete/stop).
- Optional: per-descendant event attribution for `applied-bare` (Task 8 note) if the current root-stamped streaming proves insufficient for the agent-facing envelope.
