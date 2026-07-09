# TransitionTarget Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the duplicated `--claim-id` / `--run` parsing dance across six mutating CLI commands with a single domain type (`TransitionTarget`) parsed at one seam, so the illegal "both flags supplied" state is unrepresentable rather than re-checked per command.

**Architecture:** Introduce a `TransitionTarget` discriminated union (`claim | run | active`) and a single `parseTransitionTarget` that composes the existing atomic parsers and owns the mutual-exclusion rejection. A shared registrar (`withTransitionTargetOptions`) bonds the two Commander options so they can only be registered together. Commands consume a `TransitionTarget` and map it into core's existing selector via a shared adapter. A whole-program co-occurrence test pins that only the known commands register the flag pair, turning "less duplication" into an enforced invariant (Option C: structural enforcement).

**Tech Stack:** TypeScript, Commander.js, Jest, pnpm workspaces. Core types (`ClaimId`, `RunId`, `isClaimId`, `isRunId`, `CallerEvidence`) come from `@rundown-org/core`.

## Global Constraints

- **Error precedence is observable and fixed:** `INVALID_SYNTAX` (both flags) → `INVALID_CLAIM_ID` (malformed claim) → `INVALID_RUN_ID` (malformed run). Preserve this order exactly — tests and an agent contract depend on these codes.
- **Side-effect / bail contract:** each atomic parser emits its own diagnostic, calls `output.flush()`, sets `process.exitCode = 1`, and returns a sentinel. `parseTransitionTarget` preserves this: on any failure the diagnostic is already emitted and it returns `undefined`; callers bail with `if (!target) return;`. It never restructures error rendering.
- **Atomic parsers stay reusable and are NOT deleted:** `abort` uses `parseClaimIdOption` alone (no `--run`); `parseTransitionTarget` *composes* `rejectClaimRunCombination` + `parseClaimIdOption` + `parseRunOption`, it does not absorb or remove them.
- **JSON error envelopes must stay byte-identical** for every currently-passing input. The only intentional behavior change: `delegate` with a **malformed `--run` AND `--claim-id` both present** now yields `INVALID_SYNTAX` instead of `INVALID_RUN_ID` (this case is untested today and the change unifies delegate with every other command — see Task 7).
- **No import cycle** between `transition-target.ts`, `claim-id-option.ts`, and `run-option.ts`.
- **CLI tests default to JSON output.** Only add `--text` when a test is explicitly about human-readable rendering.
- Always instruct the `rundown` binary in any docs/help copy, never `rd`.

---

## File Structure

**New files:**
- `packages/cli/src/helpers/transition-target.ts` — the `TransitionTarget` type, `parseTransitionTarget`, `transitionTargetFields` adapter, and the `withTransitionTargetOptions` registrar. Single responsibility: turn the raw claim/run flag pair into one domain value and register the flag pair.
- `packages/cli/__tests__/helpers/transition-target.test.ts` — unit tests for the parser, adapter, and registrar.
- `packages/cli/__tests__/helpers/transition-target-single-source.test.ts` — whole-program co-occurrence drift guard.

**Modified files:**
- `packages/cli/src/commands/goto.ts` — consume `TransitionTarget`.
- `packages/cli/src/commands/stop.ts` — consume `TransitionTarget` (two spread sites).
- `packages/cli/src/commands/complete.ts` — consume `TransitionTarget` (two spread sites).
- `packages/cli/src/commands/collect.ts` — consume `TransitionTarget` (two spread sites).
- `packages/cli/src/commands/delegate.ts` — consume `TransitionTarget` via a `delegateSeamFields` switch; fix `--run` help text drift.
- `packages/cli/src/helpers/transition-command.ts` — migrate `pass`/`fail` parsing to `parseTransitionTarget`.
- `packages/core/__tests__/runbook/command-target-resolver.test.ts` — add direct unit cases for the `no-authorizing-claim` refusal branch (folded-in PR #585 coverage item; see Task 10).
- `docs/reference/cli-help.md` — **generated**, not hand-edited. Regenerated via `pnpm run docs:cli-help` in Task 7 (delegate's help text/ordering is the only change) and committed, so the `check:docs:cli-help` gate in `pnpm run verify` passes.

**Unchanged (verify only):**
- `packages/cli/src/helpers/claim-id-option.ts`, `run-option.ts` — atomic parsers stay as-is.
- `packages/core/src/runbook/command-policy.ts` — `CommandTargetSelector` already models `default | claim | run | explicit-step`; the CLI now produces it faithfully.

**Out of scope (separate follow-up plan):** `delegate` anchors its issuance run on `--run`-or-active rather than the claim's `controlledRunId` (`lifecycle-command-service.ts` `#resolveIssuanceAnchor`). That is a core correctness fix independent of flag parsing; this plan preserves today's anchoring behavior and only changes how the CLI *parses* the flags.

---

### Task 1: `TransitionTarget` type, parser, and adapter

**Files:**
- Create: `packages/cli/src/helpers/transition-target.ts`
- Test: `packages/cli/__tests__/helpers/transition-target.test.ts`

**Interfaces:**
- Consumes: `parseClaimIdOption`, `rejectClaimRunCombination` from `./claim-id-option.js`; `parseRunOption` from `./run-option.js`; `ClaimId`, `RunId` from `@rundown-org/core`; `OutputEmitter` from `../services/output-emitter.js`.
- Produces:
  - `type TransitionTarget = { kind: 'claim'; claimId: ClaimId } | { kind: 'run'; runId: RunId } | { kind: 'active' }`
  - `parseTransitionTarget(raw: { claimId?: string; run?: string }, output: OutputEmitter): TransitionTarget | undefined`
  - `transitionTargetFields(target: TransitionTarget): { claimId?: ClaimId; runId?: RunId }`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/cli/__tests__/helpers/transition-target.test.ts
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { ClaimId, RunId } from '@rundown-org/core';
import {
  parseTransitionTarget,
  transitionTargetFields,
} from '../../src/helpers/transition-target.js';

// The atomic parsers set `process.exitCode = 1` on failure (their real
// side-effect contract). Reset it after each test so a rejection case cannot
// make the Jest process itself exit non-zero.
afterEach(() => {
  process.exitCode = 0;
});

const CLAIM_ID =
  'rdclm_00000000000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const RUN_ID = `rd_${'1'.repeat(32)}`;

/** Minimal OutputEmitter double capturing error code + flush. */
function fakeOutput() {
  const errors: Array<{ message: string; code: string }> = [];
  return {
    errors,
    error: (message: string, code: string) => errors.push({ message, code }),
    flush: jest.fn(),
  };
}

describe('parseTransitionTarget', () => {
  it('returns { kind: "active" } when neither flag is supplied', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({}, output as never);
    expect(target).toEqual({ kind: 'active' });
    expect(output.errors).toHaveLength(0);
  });

  it('returns { kind: "claim" } for a valid --claim-id', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ claimId: CLAIM_ID }, output as never);
    expect(target).toEqual({ kind: 'claim', claimId: CLAIM_ID as ClaimId });
  });

  it('returns { kind: "run" } for a valid --run', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ run: RUN_ID }, output as never);
    expect(target).toEqual({ kind: 'run', runId: RUN_ID as RunId });
  });

  it('rejects both flags with INVALID_SYNTAX and returns undefined', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ claimId: CLAIM_ID, run: RUN_ID }, output as never);
    expect(target).toBeUndefined();
    expect(output.errors).toEqual([
      expect.objectContaining({ code: 'INVALID_SYNTAX' }),
    ]);
  });

  it('rejects a malformed claim with INVALID_CLAIM_ID', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ claimId: 'not-a-claim' }, output as never);
    expect(target).toBeUndefined();
    expect(output.errors).toEqual([expect.objectContaining({ code: 'INVALID_CLAIM_ID' })]);
  });

  it('rejects a malformed run with INVALID_RUN_ID', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ run: 'not-a-run' }, output as never);
    expect(target).toBeUndefined();
    expect(output.errors).toEqual([expect.objectContaining({ code: 'INVALID_RUN_ID' })]);
  });

  it('applies precedence: both + malformed run yields INVALID_SYNTAX (not INVALID_RUN_ID)', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ claimId: CLAIM_ID, run: 'not-a-run' }, output as never);
    expect(target).toBeUndefined();
    expect(output.errors).toEqual([expect.objectContaining({ code: 'INVALID_SYNTAX' })]);
  });
});

describe('transitionTargetFields', () => {
  it('maps claim to { claimId }', () => {
    expect(transitionTargetFields({ kind: 'claim', claimId: CLAIM_ID as ClaimId })).toEqual({
      claimId: CLAIM_ID,
    });
  });

  it('maps run to { runId }', () => {
    expect(transitionTargetFields({ kind: 'run', runId: RUN_ID as RunId })).toEqual({
      runId: RUN_ID,
    });
  });

  it('maps active to {}', () => {
    expect(transitionTargetFields({ kind: 'active' })).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/cli test -- transition-target.test`
Expected: FAIL — `Cannot find module '../../src/helpers/transition-target.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/cli/src/helpers/transition-target.ts
import type { ClaimId, RunId } from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';
import { parseClaimIdOption, rejectClaimRunCombination } from './claim-id-option.js';
import { parseRunOption } from './run-option.js';

/**
 * Which run a mutating command targets, and by what authority — one logical
 * parameter with three mutually exclusive shapes. Because there is no `both`
 * inhabitant, the illegal "claim-id AND run supplied together" state is
 * unrepresentable once the raw flags have been parsed.
 *
 * - `claim`: `--claim-id` bearer authority (the claim also identifies its run).
 * - `run`: `--run` read-only target selector; not mutation authority.
 * - `active`: neither flag; the implicit active run.
 */
export type TransitionTarget =
  | { readonly kind: 'claim'; readonly claimId: ClaimId }
  | { readonly kind: 'run'; readonly runId: RunId }
  | { readonly kind: 'active' };

/**
 * Parse the raw `--claim-id` / `--run` flag pair into a single
 * {@link TransitionTarget}. The only sanctioned path from the two flags to a
 * target: "both supplied" is a parse-time `INVALID_SYNTAX` that never reaches a
 * caller.
 *
 * Composes the atomic parsers to preserve the fixed precedence
 * (`INVALID_SYNTAX` → `INVALID_CLAIM_ID` → `INVALID_RUN_ID`) and their
 * side-effect contract: on any failure the relevant parser has already emitted
 * its diagnostic, flushed, and set `process.exitCode`; this returns `undefined`
 * and the caller bails.
 *
 * @param raw - Raw Commander option values (`claimId`, `run`), each `undefined`
 *   when absent.
 * @param output - Output emitter used by the atomic parsers to render failures.
 * @returns The parsed target, or `undefined` when a diagnostic has been emitted.
 */
export function parseTransitionTarget(
  raw: { readonly claimId?: string; readonly run?: string },
  output: OutputEmitter,
): TransitionTarget | undefined {
  if (rejectClaimRunCombination({ claimId: raw.claimId, run: raw.run, output })) {
    return undefined;
  }
  const claim = parseClaimIdOption(raw.claimId, output);
  if (!claim.ok) return undefined;
  const run = parseRunOption(raw.run, output);
  if (!run.ok) return undefined;
  if (claim.claimId !== undefined) return { kind: 'claim', claimId: claim.claimId };
  if (run.runId !== undefined) return { kind: 'run', runId: run.runId };
  return { kind: 'active' };
}

/**
 * Map a {@link TransitionTarget} into the optional `{ claimId?, runId? }` fields
 * consumed by core's command-context builders (which mirror core's
 * `CommandTargetSelector`). The single adapter from the union to the legacy
 * spread shape; because the union has no `both` inhabitant, at most one field is
 * ever present.
 *
 * @param target - The parsed transition target.
 * @returns Spreadable fields: `{ claimId }`, `{ runId }`, or `{}`.
 */
export function transitionTargetFields(
  target: TransitionTarget,
): { readonly claimId?: ClaimId; readonly runId?: RunId } {
  switch (target.kind) {
    case 'claim':
      return { claimId: target.claimId };
    case 'run':
      return { runId: target.runId };
    case 'active':
      return {};
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rundown-org/cli test -- transition-target.test`
Expected: PASS (all 10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/helpers/transition-target.ts \
        packages/cli/__tests__/helpers/transition-target.test.ts
git commit -m "feat(cli): add TransitionTarget type and parseTransitionTarget"
```

---

### Task 2: `withTransitionTargetOptions` registrar

**Files:**
- Modify: `packages/cli/src/helpers/transition-target.ts`
- Test: `packages/cli/__tests__/helpers/transition-target.test.ts`

**Interfaces:**
- Consumes: `Command` from `commander`.
- Produces:
  - `interface TransitionTargetDescriptions { claimId?: string; run?: string }`
  - `withTransitionTargetOptions(command: Command, descriptions?: TransitionTargetDescriptions): Command` — registers `--claim-id <claimId>` and `--run <runId>` as an inseparable pair (descriptions default to the standard shared wording; overridable per command) and returns the command for chaining.

- [ ] **Step 1: Write the failing test** (append to `transition-target.test.ts`)

```typescript
import { Command } from 'commander';
import { withTransitionTargetOptions } from '../../src/helpers/transition-target.js';

describe('withTransitionTargetOptions', () => {
  it('registers both --claim-id and --run as a bonded pair', () => {
    const command = new Command('demo');
    withTransitionTargetOptions(command);
    const longs = command.options.map((o) => o.long).sort();
    expect(longs).toEqual(['--claim-id', '--run']);
  });

  it('defaults to the standard shared descriptions', () => {
    const command = new Command('demo');
    withTransitionTargetOptions(command);
    const byLong = new Map(command.options.map((o) => [o.long, o]));
    expect(byLong.get('--claim-id')?.description).toBe('Target a claimed delegated child runbook');
    expect(byLong.get('--run')?.description).toBe('Target a runbook by run id');
  });

  it('accepts per-command description overrides', () => {
    const command = new Command('demo');
    withTransitionTargetOptions(command, { claimId: 'Custom claim help', run: 'Custom run help' });
    const byLong = new Map(command.options.map((o) => [o.long, o]));
    expect(byLong.get('--claim-id')?.description).toBe('Custom claim help');
    expect(byLong.get('--run')?.description).toBe('Custom run help');
  });

  it('returns the command for chaining', () => {
    const command = new Command('demo');
    expect(withTransitionTargetOptions(command)).toBe(command);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rundown-org/cli test -- transition-target.test`
Expected: FAIL — `withTransitionTargetOptions is not a function`.

- [ ] **Step 3: Add the registrar** (append to `transition-target.ts`; add `import type { Command } from 'commander';` at the top)

```typescript
/** Optional per-command help text for the transition-target flag pair. */
export interface TransitionTargetDescriptions {
  /** `--claim-id` help; defaults to the standard shared wording. */
  readonly claimId?: string;
  /** `--run` help; defaults to the standard shared wording. */
  readonly run?: string;
}

/**
 * Register `--claim-id` and `--run` on a command as an inseparable pair. This is
 * the single registrar of the transition-target flag pair: a command opts in
 * with one call and cannot register one flag of the pair without the other. The
 * whole-program single-source test asserts that `--run` appears only on commands
 * that register the pair, so the pair and its parser cannot drift apart.
 *
 * The registrar owns the *bonding*, not the copy: descriptions default to the
 * standard shared wording (matching what `pass`/`fail` and the selector commands
 * already display) and may be overridden per command where the standard wording
 * is inaccurate — notably `delegate`, whose `--claim-id` authorizes the issuing
 * run rather than "a claimed delegated child."
 *
 * @param command - The Commander command to register the option pair on.
 * @param descriptions - Optional per-command help overrides.
 * @returns The same command, for chaining.
 */
export function withTransitionTargetOptions(
  command: Command,
  descriptions?: TransitionTargetDescriptions,
): Command {
  return command
    .option(
      '--claim-id <claimId>',
      descriptions?.claimId ?? 'Target a claimed delegated child runbook',
    )
    .option('--run <runId>', descriptions?.run ?? 'Target a runbook by run id');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rundown-org/cli test -- transition-target.test`
Expected: PASS (14 tests total — 10 from Task 1 plus the 4 registrar tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/helpers/transition-target.ts \
        packages/cli/__tests__/helpers/transition-target.test.ts
git commit -m "feat(cli): add withTransitionTargetOptions registrar"
```

---

### Task 3: Convert `goto` to consume a `TransitionTarget`

**Files:**
- Modify: `packages/cli/src/commands/goto.ts` (registration ~lines 20-24; action ~lines 35-45)
- Test: `packages/cli/__tests__/commands/claim-run-combination.test.ts` (already covers goto's both-flags rejection — used as the regression gate)

**Interfaces:**
- Consumes: `withTransitionTargetOptions`, `parseTransitionTarget`, `transitionTargetFields` from `../helpers/transition-target.js`.

- [ ] **Step 1: Run the existing regression test to confirm current green**

Run: `pnpm --filter @rundown-org/cli test -- claim-run-combination.test`
Expected: PASS (7 cases, including `goto`). This is the byte-identical-envelope gate; it must stay green after the edit.

- [ ] **Step 2: Replace the option registration**

`withTransitionTargetOptions(command)` takes a command and returns it, so it slots into the fluent chain in place of the two removed `.option` lines. In `goto.ts`, find (lines 18-24):

```typescript
  program
    .command('goto <step>')
    .description('Jump to specific step (e.g., "3" or "3.1" for substep)')
    .option('--index <number>', 'FOR loop iteration to target')
    .option('--claim-id <claimId>', 'Target a claimed delegated child runbook')
    .option('--run <runId>', 'Target a runbook by run id')
    .option('--text', 'Output as human-readable text')
    .action(
```

Replace with:

```typescript
  withTransitionTargetOptions(
    program
      .command('goto <step>')
      .description('Jump to specific step (e.g., "3" or "3.1" for substep)')
      .option('--index <number>', 'FOR loop iteration to target'),
  )
    .option('--text', 'Output as human-readable text')
    .action(
```

> This is the wrapping idiom every command in Tasks 4-7 uses: wrap the chain up to (and including) the last option that precedes the pair, then continue the chain (`.option('--text')`, `.action(...)`, etc.) on the returned command. No `descriptions` argument is passed here: the registrar's defaults (`'Target a claimed delegated child runbook'` / `'Target a runbook by run id'`) are exactly `goto`'s existing `--claim-id`/`--run` help text, so the wiring test `goto.test.ts:28` (which asserts the `--claim-id` description) stays green with no edit. The same holds for `stop`/`complete`/`collect` in Tasks 4-6.

- [ ] **Step 3: Replace the parse block in the action**

Find (goto.ts ~lines 35-46):

```typescript
            if (rejectClaimRunCombination({ claimId: options.claimId, run: options.run, output })) {
              return;
            }
            const claimTarget = parseClaimIdOption(options.claimId, output);
            if (!claimTarget.ok) return;
            const runTarget = parseRunOption(options.run, output);
            if (!runTarget.ok) return;
            const contextResult = await buildGotoContext(output, cwd, {
              ...(claimTarget.claimId !== undefined ? { claimId: claimTarget.claimId } : {}),
              ...(runTarget.runId !== undefined ? { runId: runTarget.runId } : {}),
              commandStreamOptions: commandStreamOptionsForOutputMode(options.text),
            });
```

Replace with:

```typescript
            const target = parseTransitionTarget(options, output);
            if (!target) return;
            const contextResult = await buildGotoContext(output, cwd, {
              ...transitionTargetFields(target),
              commandStreamOptions: commandStreamOptionsForOutputMode(options.text),
            });
```

- [ ] **Step 4: Update imports**

In `goto.ts`, remove the now-unused imports `parseClaimIdOption`, `rejectClaimRunCombination` (from `../helpers/claim-id-option.js`) and `parseRunOption` (from `../helpers/run-option.js`). Add:

```typescript
import {
  withTransitionTargetOptions,
  parseTransitionTarget,
  transitionTargetFields,
} from '../helpers/transition-target.js';
```

- [ ] **Step 5: Run the regression test + typecheck**

Run: `pnpm --filter @rundown-org/cli test -- claim-run-combination.test goto`
Then: `pnpm --filter @rundown-org/cli run build`
Expected: PASS; build clean (no unused-import or type errors).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/goto.ts
git commit -m "refactor(cli): goto consumes TransitionTarget"
```

---

### Task 4: Convert `stop` to consume a `TransitionTarget`

**Files:**
- Modify: `packages/cli/src/commands/stop.ts` (registration lines 28-29; action lines 40-59 — TWO spread sites)

**Interfaces:**
- Consumes: `withTransitionTargetOptions`, `parseTransitionTarget`, `transitionTargetFields`.

- [ ] **Step 1: Replace the option registration**

In `stop.ts`, wrap the command in `withTransitionTargetOptions`, removing the `.option('--claim-id'...)` and `.option('--run'...)` lines (28-29) exactly as in Task 3 Step 2 (keep `.argument('[message]'...)` and `.option('--text'...)`).

- [ ] **Step 2: Replace the parse block and BOTH spread sites**

Find (stop.ts lines 40-59):

```typescript
            if (rejectClaimRunCombination({ claimId: options.claimId, run: options.run, output })) {
              return;
            }
            const claimTarget = parseClaimIdOption(options.claimId, output);
            if (!claimTarget.ok) return;
            const runTarget = parseRunOption(options.run, output);
            if (!runTarget.ok) return;

            try {
              const { exitError } = await runSeamTerminal(output, cwd, 'stop', {
                ...(claimTarget.claimId ? { claimId: claimTarget.claimId } : {}),
                ...(runTarget.runId !== undefined ? { runId: runTarget.runId } : {}),
                ...(message !== undefined ? { message } : {}),
              });
              if (exitError) process.exitCode = 1;
            } catch (error: unknown) {
              await handleTerminalRecovery('stop', error, output, cwd, {
                ...(claimTarget.claimId ? { claimId: claimTarget.claimId } : {}),
                ...(runTarget.runId !== undefined ? { runId: runTarget.runId } : {}),
              });
            }
```

Replace with:

```typescript
            const target = parseTransitionTarget(options, output);
            if (!target) return;
            const targetFields = transitionTargetFields(target);

            try {
              const { exitError } = await runSeamTerminal(output, cwd, 'stop', {
                ...targetFields,
                ...(message !== undefined ? { message } : {}),
              });
              if (exitError) process.exitCode = 1;
            } catch (error: unknown) {
              await handleTerminalRecovery('stop', error, output, cwd, {
                ...targetFields,
              });
            }
```

- [ ] **Step 3: Update imports** — remove `parseClaimIdOption`, `rejectClaimRunCombination`, `parseRunOption`; add the three-symbol import from `../helpers/transition-target.js` (as in Task 3 Step 4).

- [ ] **Step 4: Run the regression test + build**

Run: `pnpm --filter @rundown-org/cli test -- claim-run-combination.test stop`
Then: `pnpm --filter @rundown-org/cli run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/stop.ts
git commit -m "refactor(cli): stop consumes TransitionTarget"
```

---

### Task 5: Convert `complete` to consume a `TransitionTarget`

**Files:**
- Modify: `packages/cli/src/commands/complete.ts` (registration lines 35-36; action lines 47-66 — TWO spread sites, identical shape to `stop`)

**Interfaces:**
- Consumes: `withTransitionTargetOptions`, `parseTransitionTarget`, `transitionTargetFields`.

- [ ] **Step 1: Replace the option registration** — wrap the command in `withTransitionTargetOptions`, removing the `--claim-id`/`--run` `.option` lines (35-36); keep `.argument('[message]'...)` and `.option('--text'...)`.

- [ ] **Step 2: Replace the parse block and BOTH spread sites**

Find (complete.ts lines 47-66):

```typescript
            if (rejectClaimRunCombination({ claimId: options.claimId, run: options.run, output })) {
              return;
            }
            const claimTarget = parseClaimIdOption(options.claimId, output);
            if (!claimTarget.ok) return;
            const runTarget = parseRunOption(options.run, output);
            if (!runTarget.ok) return;

            try {
              const { exitError } = await runSeamTerminal(output, cwd, 'complete', {
                ...(claimTarget.claimId ? { claimId: claimTarget.claimId } : {}),
                ...(runTarget.runId !== undefined ? { runId: runTarget.runId } : {}),
                ...(message !== undefined ? { message } : {}),
              });
              if (exitError) process.exitCode = 1;
            } catch (error: unknown) {
              await handleTerminalRecovery('complete', error, output, cwd, {
                ...(claimTarget.claimId ? { claimId: claimTarget.claimId } : {}),
                ...(runTarget.runId !== undefined ? { runId: runTarget.runId } : {}),
              });
            }
```

Replace with:

```typescript
            const target = parseTransitionTarget(options, output);
            if (!target) return;
            const targetFields = transitionTargetFields(target);

            try {
              const { exitError } = await runSeamTerminal(output, cwd, 'complete', {
                ...targetFields,
                ...(message !== undefined ? { message } : {}),
              });
              if (exitError) process.exitCode = 1;
            } catch (error: unknown) {
              await handleTerminalRecovery('complete', error, output, cwd, {
                ...targetFields,
              });
            }
```

- [ ] **Step 3: Update imports** — remove `parseClaimIdOption`, `rejectClaimRunCombination`, `parseRunOption`; add the three-symbol `transition-target.js` import.

- [ ] **Step 4: Run the regression test + build**

Run: `pnpm --filter @rundown-org/cli test -- claim-run-combination.test complete`
Then: `pnpm --filter @rundown-org/cli run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/complete.ts
git commit -m "refactor(cli): complete consumes TransitionTarget"
```

---

### Task 6: Convert `collect` to consume a `TransitionTarget`

**Files:**
- Modify: `packages/cli/src/commands/collect.ts` (registration lines 57-58; action lines 74-116 — TWO spread sites)

**Interfaces:**
- Consumes: `withTransitionTargetOptions`, `parseTransitionTarget`, `transitionTargetFields`.
- Note: `collect`'s downstream `runCollect` options type (`collect.ts:136-140`) already carries `claimId?: ClaimId` / `runId?: RunId`; the spread stays compatible.

- [ ] **Step 1: Replace the option registration** — wrap the command in `withTransitionTargetOptions`, removing the `--claim-id`/`--run` `.option` lines (57-58); keep the `--step`, `--index`, `--text` options.

- [ ] **Step 2: Replace the parse block (first spread site)**

Find (collect.ts lines 74-84):

```typescript
            if (rejectClaimRunCombination({ claimId: options.claimId, run: options.run, output })) {
              return;
            }
            const claimTarget = parseClaimIdOption(options.claimId, output);
            if (!claimTarget.ok) return;
            const runTarget = parseRunOption(options.run, output);
            if (!runTarget.ok) return;
            const contextResult = await buildTransitionContext(output, cwd, {
              ...(claimTarget.claimId !== undefined ? { claimId: claimTarget.claimId } : {}),
              ...(runTarget.runId !== undefined ? { runId: runTarget.runId } : {}),
              commandStreamOptions,
            });
```

Replace with:

```typescript
            const target = parseTransitionTarget(options, output);
            if (!target) return;
            const targetFields = transitionTargetFields(target);
            const contextResult = await buildTransitionContext(output, cwd, {
              ...targetFields,
              commandStreamOptions,
            });
```

- [ ] **Step 3: Replace the second spread site**

Find (collect.ts lines 111-117, inside the `runCollect` call):

```typescript
            const shouldExitWithError = await runCollect(ctx, {
              step: options.step,
              index: options.index,
              text: options.text,
              ...(claimTarget.claimId !== undefined ? { claimId: claimTarget.claimId } : {}),
              ...(runTarget.runId !== undefined ? { runId: runTarget.runId } : {}),
            });
```

Replace with:

```typescript
            const shouldExitWithError = await runCollect(ctx, {
              step: options.step,
              index: options.index,
              text: options.text,
              ...targetFields,
            });
```

- [ ] **Step 4: Update imports** — remove `parseClaimIdOption`, `rejectClaimRunCombination` (from `claim-id-option.js`) and `parseRunOption` (from `run-option.js`); add the three-symbol `transition-target.js` import. Keep the `ClaimId` / `RunId` type imports (still used by the `runCollect` options type).

- [ ] **Step 5: Run the regression test + build**

Run: `pnpm --filter @rundown-org/cli test -- claim-run-combination.test collect`
Then: `pnpm --filter @rundown-org/cli run build`
Expected: PASS; build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/collect.ts
git commit -m "refactor(cli): collect consumes TransitionTarget"
```

---

### Task 7: Reconcile `delegate` — consume a `TransitionTarget` and fix `--run` help text

**Files:**
- Modify: `packages/cli/src/commands/delegate.ts` (registration lines 169-173; `targetedSeamFields` lines 62-94; call site lines 244-252)
- Test: `packages/cli/__tests__/commands/delegate.test.ts` (existing `INVALID_RUN_ID` case at line 402; `claim-run-combination.test.ts` delegate case) + a new precedence case.

**Interfaces:**
- Consumes: `withTransitionTargetOptions`, `parseTransitionTarget`, `TransitionTarget` from `../helpers/transition-target.js`; `readLifecycleCallerEvidence` (already imported); `CallerEvidence`, `RunId` (already imported).
- Produces: local `delegateSeamFields(target: TransitionTarget): { callerEvidence: CallerEvidence; targetRunId?: RunId }` replacing `targetedSeamFields`.

**Behavior note (intentional change):** today `delegate` parses `--run` before rejecting the both-flags combination, so `delegate --run <malformed> --claim-id <valid>` yields `INVALID_RUN_ID`. After this task it yields `INVALID_SYNTAX`, matching every other command. This case is untested today; the two pinned delegate cases (malformed-run *without* claim → `INVALID_RUN_ID`; both-valid → `INVALID_SYNTAX`) are preserved.

- [ ] **Step 1: Write the new precedence test** (append to the relevant `describe` in `delegate.test.ts`, near line 410)

```typescript
    it('rejects both --claim-id and a malformed --run with INVALID_SYNTAX (precedence)', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        [
          'delegate',
          '--run',
          'not-a-run-id',
          '--claim-id',
          'rdclm_00000000000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        ],
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).toBe('INVALID_SYNTAX');
    });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rundown-org/cli test -- delegate.test -t "precedence"`
Expected: FAIL — receives `INVALID_RUN_ID` (delegate's current run-first ordering).

- [ ] **Step 3: Replace `targetedSeamFields` with `delegateSeamFields`**

Find (delegate.ts lines 62-94, the whole `targetedSeamFields` function) and replace with:

```typescript
/**
 * Derive the delegate seam-call fields from a resolved {@link TransitionTarget}.
 *
 * `--claim-id` supplies bearer authority (mapped into `callerEvidence`); `--run`
 * supplies a target-run selector (mapped into `targetRunId`). The union has no
 * `both` inhabitant, so the previously hand-rolled mutual-exclusion check is
 * gone — the switch is total.
 *
 * @param target - The parsed transition target.
 * @returns Spreadable `callerEvidence` (+ `targetRunId` when a run is named).
 */
function delegateSeamFields(target: TransitionTarget): {
  readonly callerEvidence: CallerEvidence;
  readonly targetRunId?: RunId;
} {
  switch (target.kind) {
    case 'claim':
      return { callerEvidence: readLifecycleCallerEvidence({ claimId: target.claimId }) };
    case 'run':
      return { callerEvidence: readLifecycleCallerEvidence(), targetRunId: target.runId };
    case 'active':
      return { callerEvidence: readLifecycleCallerEvidence() };
  }
}
```

- [ ] **Step 4: Replace the call site**

Find (delegate.ts lines 244-252):

```typescript
          const runTarget = parseRunOption(options.run, output);
          if (!runTarget.ok) return;
          const seamFields = targetedSeamFields({
            claimId: options.claimId,
            rawRun: options.run,
            runId: runTarget.runId,
            output,
          });
          if (seamFields === undefined) return;
```

Replace with:

```typescript
          const target = parseTransitionTarget(options, output);
          if (!target) return;
          const seamFields = delegateSeamFields(target);
```

> The delegate-specific pre-checks above this line — `rejectClaimIdValueSmuggling`, `rejectArtifactInheritance`, `validateIndexRequiresStep` — are unchanged and still run first, preserving their precedence.

- [ ] **Step 5: Fix the `--run` help-text drift and use the registrar (statement form)**

`delegate`'s `--claim-id` (line 171) and `--run` (line 173) are non-adjacent — they straddle `--retry` and precede a multi-line `.addOption(...)` chain — so use the **statement form** rather than trying to wrap the fluent chain. `delegate` passes explicit descriptions: the standard `--claim-id` default (`'Target a claimed delegated child runbook'`) is inaccurate here (delegate's claim-id authorizes the *issuing* run, not a child), so keep delegate's accurate wording; and the `--run` text is corrected from its aspirational form to a plain selector description.

In `registerDelegateCommand`, capture the base command and register the pair as a statement. Change the head of the builder from:

```typescript
  program
    .command('delegate [runbook]')
    .description('Create a delegation token for a child runbook')
    .option('--step <stepId>', 'Step to delegate (e.g., 1.1 or 1.2.1 for step.iteration.substep)')
    .option('--index <number>', 'FOR loop iteration to target (requires --step)')
    .option('--claim-id <claimId>', 'Bearer authority for the run that issues the delegation')
    .option('--retry', 'Retry an existing delegation: cancel and re-issue with a fresh token')
    .option('--run <runId>', 'Select the target run; authority still comes from --claim-id')
    .addOption(
```

to:

```typescript
  const command = program
    .command('delegate [runbook]')
    .description('Create a delegation token for a child runbook')
    .option('--step <stepId>', 'Step to delegate (e.g., 1.1 or 1.2.1 for step.iteration.substep)')
    .option('--index <number>', 'FOR loop iteration to target (requires --step)')
    .option('--retry', 'Retry an existing delegation: cancel and re-issue with a fresh token');
  withTransitionTargetOptions(command, {
    claimId: 'Bearer authority for the run that issues the delegation',
    run: 'Select the target run (selector only; authority comes from --claim-id)',
  });
  command
    .addOption(
```

The remaining `.addOption(...)` calls and `.action(...)` continue on `command` unchanged (they were previously chained off `program.command(...)`; they now chain off the captured `command`, which is the same object). Do NOT reintroduce standalone `.option('--claim-id'...)` / `.option('--run'...)` calls — that would defeat the single-registrar guarantee that Task 9 enforces.

> `delegate` has no wiring-test assertion on the `--claim-id`/`--run` descriptions (`delegate.test.ts` pins `--step`/`--index`/`--retry`/`--input*` only), so this help-text change breaks no test.

- [ ] **Step 6: Update imports** — remove `parseRunOption` (from `run-option.js`) and `parseClaimIdOption`, `rejectClaimRunCombination` (from `claim-id-option.js`); add:

```typescript
import {
  withTransitionTargetOptions,
  parseTransitionTarget,
  type TransitionTarget,
} from '../helpers/transition-target.js';
```

Keep `readLifecycleCallerEvidence` and the `CallerEvidence` / `RunId` type imports.

- [ ] **Step 7: Run the delegate suites + build**

Run: `pnpm --filter @rundown-org/cli test -- delegate.test claim-run-combination.test`
Then: `pnpm --filter @rundown-org/cli run build`
Expected: PASS (including the new precedence test, the preserved `INVALID_RUN_ID` case at line 402, and the both-valid `INVALID_SYNTAX` case); build clean.

- [ ] **Step 8: Regenerate the committed CLI help doc**

This is the only task that changes rendered help text (delegate's `--run` wording + the `--claim-id`/`--run` pair now ordered after `--retry`). The root `verify` gate runs `check:docs:cli-help`, which regenerates `docs/reference/cli-help.md` with `--check` and **fails the build if the committed doc is stale** (`package.json:64,67`). The four selector commands are unaffected (their help text is preserved by the registrar defaults), so the only diff is delegate's block (`docs/reference/cli-help.md:470-488`).

Run: `pnpm run docs:cli-help`
Then confirm the diff is limited to delegate's option block: `git diff -- docs/reference/cli-help.md`
Expected: only delegate's `--run` description and the `--claim-id`/`--run`/`--retry` option ordering change; no other command's block moves.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/commands/delegate.ts \
        packages/cli/__tests__/commands/delegate.test.ts \
        docs/reference/cli-help.md
git commit -m "refactor(cli): delegate consumes TransitionTarget; fix --run help drift"
```

---

### Task 8: Migrate `pass`/`fail` parsing to `parseTransitionTarget`

**Files:**
- Modify: `packages/cli/src/helpers/transition-command.ts` (parse block lines 116-122; spread site lines 133-139)

**Interfaces:**
- Consumes: `parseTransitionTarget`, `transitionTargetFields` from `./transition-target.js`.
- Note: `pass`/`fail` keep registering `--claim-id`/`--run` via the core-derived `PASS_FAIL_VALUE_TAKING_OPTION_NAMES` loop (they share it with `--step`/`--index`), so they do NOT use `withTransitionTargetOptions`. Only the *parsing* is unified here. Registration is unchanged.

- [ ] **Step 1: Run the pass/fail suites to confirm current green**

Run: `pnpm --filter @rundown-org/cli test -- pass.test fail.test`
Expected: PASS (baseline before the edit).

- [ ] **Step 2: Replace the parse block**

Find (transition-command.ts lines 115-122):

```typescript
            const cwd = getCwd();
            if (rejectClaimRunCombination({ claimId: options.claimId, run: options.run, output })) {
              return;
            }
            const claimTarget = parseClaimIdOption(options.claimId, output);
            if (!claimTarget.ok) return;
            const runTarget = parseRunOption(options.run, output);
            if (!runTarget.ok) return;
```

Replace with:

```typescript
            const cwd = getCwd();
            const target = parseTransitionTarget(options, output);
            if (!target) return;
            const targetFields = transitionTargetFields(target);
```

- [ ] **Step 3: Replace the spread site**

Find (transition-command.ts lines 133-139):

```typescript
            const { manager, applied, exitError } = await runSeamTransition(output, cwd, config, {
              ...(claimTarget.claimId !== undefined ? { claimId: claimTarget.claimId } : {}),
              ...(runTarget.runId !== undefined ? { runId: runTarget.runId } : {}),
              ...(options.step !== undefined ? { step: options.step } : {}),
              ...(options.index !== undefined ? { index: options.index } : {}),
              commandStreamOptions,
            });
```

Replace with:

```typescript
            const { manager, applied, exitError } = await runSeamTransition(output, cwd, config, {
              ...targetFields,
              ...(options.step !== undefined ? { step: options.step } : {}),
              ...(options.index !== undefined ? { index: options.index } : {}),
              commandStreamOptions,
            });
```

- [ ] **Step 4: Update imports** — remove `parseClaimIdOption`, `rejectClaimRunCombination` (from `./claim-id-option.js`) and `parseRunOption` (from `./run-option.js`); add:

```typescript
import { parseTransitionTarget, transitionTargetFields } from './transition-target.js';
```

- [ ] **Step 5: Run the pass/fail suites + the both-flags test + build**

Run: `pnpm --filter @rundown-org/cli test -- pass.test fail.test claim-run-combination.test`
Then: `pnpm --filter @rundown-org/cli run build`
Expected: PASS (including `pass.test` line 147 "rejects combining --claim-id with --run"); build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/helpers/transition-command.ts
git commit -m "refactor(cli): pass/fail parse claim/run via parseTransitionTarget"
```

---

### Task 9: Whole-program co-occurrence drift guard

**Files:**
- Create: `packages/cli/__tests__/helpers/transition-target-single-source.test.ts`

**Interfaces:**
- Consumes: `createProgram` from `../../src/cli.js`.

This test is the structural guarantee: `--run` may appear ONLY on the known transition-target commands, and each of those commands must register BOTH `--claim-id` and `--run`. Because `withTransitionTargetOptions` (and the pass/fail core-derived loop) are the only registrars that emit `--run`, a future both-flags command that hand-rolls its own parsing would register `--run` outside the allowlist and fail this test — forcing it through the shared seam.

- [ ] **Step 1: Write the test**

```typescript
// packages/cli/__tests__/helpers/transition-target-single-source.test.ts
import { describe, it, expect } from '@jest/globals';
import type { Command } from 'commander';
import { createProgram } from '../../src/cli.js';

// Structural invariant for the transition-target flag pair (`--claim-id` +
// `--run`). These two options are "which run, and by what authority" — one
// logical parameter. `pass`, `fail`, `goto`, `stop`, `complete`, `collect`, and
// `delegate` register the pair; every other mutating command that targets a run
// by claim only (`abort`, `status`, `pop`, `stash`) registers `--claim-id`
// WITHOUT `--run`, and read-only commands register neither. `--run` therefore
// appears on exactly the transition-target commands. If a new command grows a
// `--run` selector without routing through the shared parser, this test fails —
// turning "we deduplicated" into an enforced guarantee that the claim/run pair
// and its single parser cannot drift apart.

/** Canonical names of the commands that register the claim/run pair. */
const TRANSITION_TARGET_COMMANDS = new Set([
  'pass',
  'fail',
  'goto',
  'stop',
  'complete',
  'collect',
  'delegate',
]);

/** Long option names registered directly on a subcommand. */
function optionLongs(command: Command): Set<string> {
  return new Set(command.options.map((o) => o.long).filter((l): l is string => l !== undefined));
}

describe('transition-target flag pair single source of truth', () => {
  const program = createProgram();

  it('registers --run on exactly the transition-target commands', () => {
    const withRun = program.commands
      .filter((c) => optionLongs(c).has('--run'))
      .map((c) => c.name())
      .sort();
    expect(withRun).toEqual([...TRANSITION_TARGET_COMMANDS].sort());
  });

  it('registers --claim-id alongside --run on every transition-target command', () => {
    for (const command of program.commands) {
      if (!TRANSITION_TARGET_COMMANDS.has(command.name())) continue;
      const longs = optionLongs(command);
      expect(longs.has('--claim-id')).toBe(true);
      expect(longs.has('--run')).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm --filter @rundown-org/cli test -- transition-target-single-source.test`
Expected: PASS. If it fails on the first assertion, the actual `--run` command set is printed — reconcile `TRANSITION_TARGET_COMMANDS` with reality (this catches any command whose registration was missed in Tasks 3-8).

- [ ] **Step 3: Sanity-check the guard actually guards (temporary negative check)**

Temporarily add `.option('--run <runId>', 'x')` to a read-only command (e.g. `status.ts`), re-run the test, and confirm it FAILS. Then revert the temporary edit and confirm it passes again. Do not commit the temporary edit.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/__tests__/helpers/transition-target-single-source.test.ts
git commit -m "test(cli): pin transition-target flag pair to its commands"
```

---

### Task 10: Direct unit cases for the `no-authorizing-claim` refusal branch

> **Folded-in PR #585 coverage item, independent of the refactor.** `resolveMutationAuthority`'s `no-authorizing-claim` branch (`packages/core/src/runbook/command-target-resolver.ts:382`) is only exercised indirectly today. This task adds direct core unit cases. It touches no CLI parsing code and may be done in any order relative to Tasks 1-9.

**Files:**
- Modify: `packages/core/__tests__/runbook/command-target-resolver.test.ts` (append to the existing `describe('resolveMutationAuthority', ...)` block, which ends at line 343)

**Interfaces:**
- Consumes existing test fixtures already defined in the file: `fakeReader`, `verifiedClaim`, `verifiedClaimWithoutMutateGrant`, `claimId`, `child`, and the `ClaimAuthorizationRequest` / `RunbookState` types. No new imports.

- [ ] **Step 1: Write the two failing tests**

Append inside the `describe('resolveMutationAuthority', () => { ... })` block (before its closing `});` at line 343):

```typescript
  it('refuses a verified bearer claim that lacks the requested grant (no-authorizing-claim)', async () => {
    const request: ClaimAuthorizationRequest = { action: 'mutate-run', runId: child.id };

    const result = await resolveMutationAuthority({
      targetReader: fakeReader({
        claimVerification: { status: 'verified', claim: verifiedClaimWithoutMutateGrant },
        failOnDefaultRead: true,
      }),
      presentedClaimId: claimId,
      targetState: child,
      request,
    });

    expect(result).toEqual({ kind: 'refused', reason: 'no-authorizing-claim' });
  });

  it('refuses a verified bearer claim whose mutate grant is for a different run (no-authorizing-claim)', async () => {
    // Pins that authorization is driven by `request.runId`, NOT `targetState`.
    // The target is `child` (which `verifiedClaim` CAN mutate), but the request
    // names a different run. authorizeClaim compares the grant's runId to
    // `request.runId` (command-target-resolver.ts:372), so an implementation that
    // instead authorized against `targetState.id` would wrongly ALLOW and fail
    // this test. Keeping `targetState: child` + `request.runId: foreign.id` is
    // what makes the distinction observable — set both to the same run and the
    // test would pass even under the buggy `targetState`-based implementation.
    const foreign = { id: 'foreign', lifecycle: 'running' } as RunbookState;
    const request: ClaimAuthorizationRequest = { action: 'mutate-run', runId: foreign.id };

    const result = await resolveMutationAuthority({
      targetReader: fakeReader({
        claimVerification: { status: 'verified', claim: verifiedClaim },
        failOnDefaultRead: true,
      }),
      presentedClaimId: claimId,
      targetState: child,
      request,
    });

    expect(result).toEqual({ kind: 'refused', reason: 'no-authorizing-claim' });
  });
```

- [ ] **Step 2: Run to verify they pass against current behavior**

Run: `pnpm --filter @rundown-org/core test -- command-target-resolver.test -t "no-authorizing-claim"`
Expected: PASS (2 tests). These pin the currently-untested branch — they document existing behavior directly rather than driving new code, so they pass immediately. If either FAILS, the refusal branch does not behave as documented — stop and investigate before proceeding.

- [ ] **Step 3: Confirm they actually exercise the target branch (mutation-guard rationale)**

Run: `pnpm --filter @rundown-org/core test -- command-target-resolver.test`
Expected: the full `resolveMutationAuthority` suite passes. The two new cases hit `no-authorizing-claim` via distinct failure modes — verified claim missing the grant, and verified claim whose grant names a different run — so a mutant that collapses `no-authorizing-claim` into another reason is now killed.

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/runbook/command-target-resolver.test.ts
git commit -m "test(core): cover resolveMutationAuthority no-authorizing-claim refusal (PR #585)"
```

---

### Task 11: Full verification and dead-code sweep

**Files:**
- Verify only (no new behavior): all modified command files, `claim-id-option.ts`, `run-option.ts`.

- [ ] **Step 1: Confirm the atomic parsers are still used where required**

Run: `grep -rn "parseClaimIdOption" packages/cli/src/`
Expected: still referenced by `abort.ts`, `status.ts`, `pop.ts`, `stash.ts` (claim-only commands) and by `transition-target.ts`. `rejectClaimRunCombination` should now be referenced ONLY by `transition-target.ts`. `parseRunOption` should be referenced ONLY by `transition-target.ts`. If any command still imports them directly, that command was missed — reconcile.

- [ ] **Step 2: Run the full CLI test suite**

Run: `pnpm --filter @rundown-org/cli test`
Expected: PASS (all suites). The four selector commands (`goto`/`stop`/`complete`/`collect`) keep their exact `--claim-id`/`--run` help text via the registrar defaults, so their wiring tests need no change. The generated `docs/reference/cli-help.md` was already regenerated and committed in Task 7. The only remaining risk is a Jest `--help`/`helpInformation()` snapshot that renders delegate's option block (check `packages/cli/__tests__/cli.test.ts`): if one fails and its diff is exactly delegate's `--run` wording + `--claim-id`/`--run`/`--retry` ordering change, refresh it (`pnpm --filter @rundown-org/cli test -- -u`, then inspect the diff before committing); otherwise investigate the failure rather than refreshing.

- [ ] **Step 3: Run the full pre-PR gate**

Run: `pnpm run verify`
Expected: clean — including `check:docs:cli-help` (passes because Task 7 committed the regenerated `docs/reference/cli-help.md`), `check:format`, `check:spell`, lint, `check:types`, and the full test suite. If `check:docs:cli-help` fails here, Task 7's doc regeneration was missed or not committed — run `pnpm run docs:cli-help` and inspect `git diff -- docs/reference/cli-help.md`.

- [ ] **Step 4: Manually drive the observable contract (evidence, not assertion)**

The CLI bin is `dist/cli.js` (`packages/cli/package.json:6-9`); `pnpm run verify` in Step 3 has already built it.

```bash
cd packages/cli
# both flags → INVALID_SYNTAX
node dist/cli.js goto 1 --run rd_11111111111111111111111111111111 \
  --claim-id rdclm_00000000000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA 2>&1 | tail -1
# malformed run only → INVALID_RUN_ID
node dist/cli.js goto 1 --run not-a-run 2>&1 | tail -1
# malformed claim only → INVALID_CLAIM_ID
node dist/cli.js goto 1 --claim-id not-a-claim 2>&1 | tail -1
```
Expected: JSON payloads with codes `INVALID_SYNTAX`, `INVALID_RUN_ID`, `INVALID_CLAIM_ID` respectively.

- [ ] **Step 5: Commit a Jest snapshot refresh only if Step 2 required one**

Skip this step if no snapshot changed. If Step 2 refreshed a Jest `--help` snapshot, stage that snapshot file explicitly (never `git add -A`, which can sweep unrelated worktree changes):

```bash
git add packages/cli/__tests__/__snapshots__/  # or the specific .snap file that changed
git commit -m "test(cli): refresh delegate --help snapshot for transition-target options"
```

---

## Notes for the executor

- **Commit groupings** map 1:1 to tasks; each task ends green and independently reviewable.
- If `withTransitionTargetOptions` produces a `--help` ordering you dislike (options grouped differently than before), that is cosmetic and acceptable — do not reintroduce per-command `.option` calls to preserve ordering, as that defeats the single-registrar guarantee.
- The `delegate` **anchoring** inconsistency (issuance run resolved from `--run`-or-active rather than the claim's `controlledRunId`) is deliberately NOT addressed here. It is a core-side correctness fix with its own test surface; open a separate plan for it. This plan only changes flag *parsing*, preserving delegate's current target-resolution behavior.
- **Scope of the structural guarantee (deliberate):** this plan lands the single-registrar + single-parser + co-occurrence-test enforcement at the CLI option/parse boundary, and maps the union into core's builders via the `transitionTargetFields` adapter — it does NOT retype every core-facing builder (`buildGotoContext`, `runSeamTransition`, `runSeamTerminal`, `buildTransitionContext`, `runCollect`, `issueDelegation`) to accept a `TransitionTarget` directly. Those builders keep their `{ claimId?, runId? }` inputs, whose only producer is now `transitionTargetFields(target)` (which cannot emit both). Pushing the union all the way into those signatures is a strictly larger change (they share fields with already-shipped pass/fail code and carry many unrelated inputs) and is a reasonable follow-up if you want the type to drive dispatch end-to-end. The illegal "both" state is already unrepresentable at the boundary where the flags enter, which is where the CodeRabbit finding and the forgettable-guard risk lived.
