# CLI Actor-Context Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize CLI construction of core `ActorContext` behind one
`resolveActorContext(ingress, state)` helper plus an `--actor-source` /
`RD_ACTOR_SOURCE` ingress, so every role-specific-mutation command tags its
caller provenance accurately (replacing `delegate.ts`'s hardcoded `'direct-cli'`
source), and the collection-pending guard still refuses bare
`pass`/`fail`/`delegate` for every source.

**Architecture:** This is a **frontend adapter** change in `@rundown-org/cli`.
The CLI is allowed to *construct* `ActorContext` (an explicit adapter decision —
the current delegation lifecycle brief requires the CLI compatibility lane, and
the live code identifies the actual construction sites). The authority for this
plan is the live code in this worktree plus the dated delegation lifecycle
spec/planned-work docs under `docs/superpowers/`; do not rely on
`docs/internal/*` for this work. Core keeps owning *role derivation*
(`deriveEffectiveRole`) and *policy* (`resolveCommandIntent`,
`resolveTransitionTarget`). The new `resolveActorContext` helper is a pure
function that maps a typed `ActorIngress` (source tag + claim evidence) plus a
resolved `RunbookState` to the `ActorContext` union, implementing the frozen
trust-mapping table. A program-level `--actor-source` flag (capture-only, no
validation in the Commander hook) and `RD_ACTOR_SOURCE` env var feed the
`source` tag (flag wins over env). Each actor-context-constructing command reads
and validates the source inside its own `withErrorHandling` / `OutputEmitter`
block, so an invalid value renders the standard `INVALID_ACTOR_SOURCE` JSON
error envelope (never a silent default, and never a raw Commander stderr line).
Plan 6 (plugin) consumes this by setting `RD_ACTOR_SOURCE=plugin` only on
plugin-helper-spawned `rd` calls; Plan 7 (MCP) emits `--actor-source mcp` as a
program-level token before the subcommand
(it cannot use the env bridge — `docs/reference/mcp.md §4` requires the CLI to
inherit the server env unmodified). Neither adds policy logic.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Commander 15,
Jest (`@jest/globals`), `@rundown-org/core` (re-exports all actor-context
symbols), the in-process CLI test harness (`runCliInProcess`).

## Global Constraints

These apply to **every** task below. Copied verbatim from the frozen framing
brief and CLAUDE.md.

- **Worktree only.** All work happens from the active repository root (`$PWD`).
  Do not use hard-coded worktree paths in commands.
- **Frontend adapter boundary.** Actor-context *construction* in the CLI is
  allowed; role *derivation* stays in core (`deriveEffectiveRole`). The CLI MUST
  NOT re-implement, replicate, or work around `resolveCommandIntent` /
  `resolveTransitionTarget` policy. (CLAUDE.md "The CLI is a thin wrapper.")
- **No persisted-state migration.** `ActorContext` is runtime-only and is never
  serialized into snapshots or run state. No task may add a persisted field, a
  schema-version bump, or a migration/fallback path.
- **Type-driven dispatch, no silent mapping.** An invalid `--actor-source` /
  `RD_ACTOR_SOURCE` value is a **hard error** (exit non-zero, rendered as the
  `INVALID_ACTOR_SOURCE` JSON envelope via the command's `OutputEmitter`), never
  a silent default. The resolver narrows on a discriminated union, never on raw
  string `if` ladders outside the `parseActorSource` validation choke point.
  Validation happens inside the constructing command's `withErrorHandling`
  block — NOT in a Commander `preAction`/`preSubcommand` hook, because a thrown
  hook error is caught by `cli.ts`'s `parseAsync().catch` and printed to stderr
  via `console.error(error.message)`, which would bypass the JSON envelope
  contract.
- **The INVARIANT (must be test-pinned).** The collection-pending guard
  (`rejectBareMutationIfCollectionPending`, surfaced as
  `delegation_collection_pending`) still refuses bare `pass`/`fail`/`delegate`
  for **every** source, including the trusted `plugin` / `mcp` tags. Source
  never buys past the guard.
- **`unknown` is reachable by type, not by default.** `resolveActorContext` MUST
  be able to return the `{ kind: 'unknown' }` context (the reserved inspect-only
  fallback), even though no current local frontend path triggers it by default.
- **JSON output contract unchanged.** JSON is the agent-facing default; `--text`
  is human-only. No task changes any existing JSON envelope shape, error code,
  or `--schema` output.
- **TSDoc on every new exported symbol** (description, `@param`, `@returns`,
  `@throws` where applicable). (CLAUDE.md "TSDoc Standards".)
- **Error helpers.** Never call `Error.isError()` directly; use `isError()` from
  `@rundown-org/core` if error-shape checks are needed.
- **All actor-context symbols import from `@rundown-org/core`** (the barrel
  re-exports them via `packages/core/src/runbook/index.ts`). Verified-present
  exports the new code uses: `type ActorContext`, `type ActorContextSource`,
  `type RunId`, `type ClaimId`, `type DelegationTokenHash`, `type RunbookState`,
  `trustedRunControllerContext`, `claimControllerContext`,
  `UNKNOWN_ACTOR_CONTEXT`.
- **Verify gate.** Before declaring the plan done, `pnpm run verify` must pass.

---

## File Structure

| File | Responsibility | Status |
| --- | --- | --- |
| `packages/cli/src/helpers/resolve-actor-context.ts` | NEW. Pure module. Exports `ActorIngress`, `ActorSource` validation (`parseActorSource`, `ACTOR_SOURCE_VALUES`, `InvalidActorSourceError`), and `resolveActorContext(ingress, state)`. Implements the frozen trust-mapping table. No I/O, no Commander, no core-service references. | Create |
| `packages/cli/__tests__/helpers/resolve-actor-context.test.ts` | NEW. Table-driven unit tests across every row of the frozen table, plus `parseActorSource` precedence/validation, plus the `unknown` reachability row. | Create |
| `packages/cli/src/cli.ts` | Register program-level **capture-only** `--actor-source <direct-cli\|plugin\|mcp>` option (mirrors the existing global `--no-color` / `--schema`). NO validation/throw in any hook. | Modify |
| `packages/core/src/output/zod-schemas.ts` | Add the CLI-only symbolic `INVALID_ACTOR_SOURCE` code to `CLISymbolicErrorCodeValues` and `CLIErrorCodes`, so the new `OutputEmitter.error(..., 'INVALID_ACTOR_SOURCE')` envelope is schema-recognized. | Modify |
| `packages/cli/__tests__/commands/actor-source-ingress.test.ts` | NEW. End-to-end ingress tests: pre-subcommand flag parse, `--help` advertises it at program level, env, flag-over-env precedence, invalid value renders `INVALID_ACTOR_SOURCE` JSON envelope, plus the cross-source collection-pending INVARIANT and the source-propagation driving test. | Create |
| `packages/cli/src/helpers/actor-source-option.ts` | NEW. Tiny helper `readActorSourceIngress(command, env?)` that reads `--actor-source` (via the ACTION command's `optsWithGlobals()`) and `RD_ACTOR_SOURCE`, applies flag-over-env precedence, and returns a validated `ActorContextSource` or `undefined` (throws `InvalidActorSourceError`, which the calling command catches and renders via `OutputEmitter`). | Create |
| `packages/cli/__tests__/helpers/actor-source-option.test.ts` | NEW. Unit tests for `readActorSourceIngress` precedence/validation against a stub `command`. | Create |
| `packages/cli/src/commands/collect.ts` | Replace inline `ctx.claim ? claimControllerContext(...) : trustedRunControllerContext(...)` with `resolveActorContext`; read+validate the source via `readActorSourceIngress` inside the existing `withErrorHandling` block. | Modify |
| `packages/cli/src/commands/delegate.ts` | Replace inline hardcoded `trustedRunControllerContext(state.id, 'direct-cli')` with `resolveActorContext` so the bare delegation issue carries the correct provenance source. (delegate has NO `--claim-id` option, so no claim-controller path applies — source-tag correction only.) | Modify |
| `packages/cli/src/helpers/transitions.ts` | Thread an `actorSource: ActorContextSource` through `buildTransitionContext` into `resolveTransitionTarget` so the trusted-controller tag reflects the ingress source instead of a hardcoded `'direct-cli'`. | Modify |
| `packages/cli/src/helpers/transition-command.ts` | Read+validate the ingress source (via `readActorSourceIngress`) inside `withErrorHandling`, pass it into `buildTransitionContext`. | Modify |
| `packages/core/src/runbook/command-target-resolver.ts` | Add a narrow `actorContextSource?: ActorContextSource` option that refines the existing `directCliCompatibility` tag (provenance only; no policy change). | Modify |

### Design note: how each command reaches the resolver

- **collect / delegate** already resolve a target `RunbookState` and already
  build an `ActorContext` inline. They call `resolveActorContext(ingress, state)`
  directly, reading `ingress.source` from `readActorSourceIngress(command)`
  inside their existing `withErrorHandling` block (so an invalid source renders
  the `INVALID_ACTOR_SOURCE` JSON envelope, not a hook stderr line).
  - **collect** also threads claim evidence: `claimId` / `tokenHash` come from
    the already-resolved claim record `ctx.claim`, and `controlledRunId` defaults
    to `state.id` (the resolved claimed child).
  - **delegate** has NO `--claim-id` option (it registers only
    `--step/--index/--retry/--input*/--text`), so there is no claim-targeting
    path and no claim-controller context to build. Its defect is purely the
    hardcoded `'direct-cli'` source at `delegate.ts:132`; the migration replaces
    it with `resolveActorContext({ source }, state)` so the bare delegation issue
    carries the correct provenance. No claim evidence is threaded.
- **pass / fail** do NOT pre-resolve state in the CLI — core's
  `resolveTransitionTarget` resolves the target *and* (today) synthesizes the
  actor context from `directCliCompatibility: true`, hardcoding source
  `'direct-cli'`. Rather than duplicate target resolution in the CLI (which
  would be a shadow implementation — forbidden), we thread the ingress `source`
  into core's existing compatibility branch so the trusted-controller tag is
  accurate. The construction still happens at the one core choke point; the CLI
  only supplies the provenance tag. This preserves behavior for `direct-cli`
  exactly while making `plugin`/`mcp` tags accurate, and the collection-pending
  guard fires identically for every source (it is source-independent in core).
- **complete / stop** are workflow-level force-terminal overrides
  (`forceTerminalWorkflow`) and the `--claim-id` narrow path
  (`resolveCommandTarget` + `FORCE_COMPLETE` / `FORCE_STOP`). They do **not**
  invoke `resolveCommandIntent` / `resolveTransitionTarget` and construct no
  `ActorContext` today. They have no actor-context-gated mutation to migrate.
  This plan does **not** invent one for them (that would be new policy surface,
  out of scope and a correctness risk). They are explicitly out of scope for
  context construction; a one-line code comment records why. (If a future plan
  adds actor-gated policy to force-terminal, it consumes the same
  `resolveActorContext` / `readActorSourceIngress` produced here.)
- **claim** launches a *new* child run (`claimAndLaunch`); it is not a
  target-relative mutation against an existing run and constructs no
  `ActorContext` today. Like complete/stop, there is no context to migrate; a
  one-line comment records why, and the helpers produced here are available to a
  future plan that needs them.

> Rationale for the narrowed command set: the frozen brief lists `pass`, `fail`,
> `complete`, `stop`, `claim` as "role-specific-mutation commands that lack
> [context]." Audit of the worktree (verified by grep) shows only `pass`/`fail`
> actually flow an actor context into core policy (via `directCliCompatibility`);
> `complete`/`stop`/`claim` invoke no actor-context-gated core API at all. Wiring
> a constructed-but-unused context into them would be dead code and a silent
> policy-surface expansion — both forbidden by CLAUDE.md ("Correctness over
> pragmatism", "thin wrapper"). This plan therefore migrates the real
> construction sites (collect, delegate, pass/fail) and records, in code, why
> complete/stop/claim are construction-free. The produced helpers remain the
> single ingress for any future need.

---

## Task 1: `resolveActorContext` pure resolver + unit tests

**Files:**
- Create: `packages/cli/src/helpers/resolve-actor-context.ts`
- Test: `packages/cli/__tests__/helpers/resolve-actor-context.test.ts`

**Interfaces:**
- Consumes (from `@rundown-org/core`): `type ActorContext`,
  `type ActorContextSource`, `type RunId`, `type ClaimId`,
  `type DelegationTokenHash`, `type RunbookState`,
  `trustedRunControllerContext`, `claimControllerContext`,
  `UNKNOWN_ACTOR_CONTEXT`.
- Produces (consumed by Tasks 3-6 and by Plans 6/7's prerequisite contract):
  - `interface ActorIngress { source?: ActorContextSource; claimId?: ClaimId; tokenHash?: DelegationTokenHash; controlledRunId?: RunId; }`
  - `function resolveActorContext(ingress: ActorIngress, state: RunbookState): ActorContext`
  - `const ACTOR_SOURCE_VALUES: readonly ActorContextSource[]`
  - `class InvalidActorSourceError extends Error { readonly code: 'INVALID_ACTOR_SOURCE'; readonly value: string; }`
  - `function parseActorSource(raw: string): ActorContextSource` (throws `InvalidActorSourceError`)

- [ ] **Step 1: Write the failing test**

Create `packages/cli/__tests__/helpers/resolve-actor-context.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import type {
  ActorContext,
  ClaimId,
  DelegationTokenHash,
  RunId,
  RunbookState,
} from '@rundown-org/core';
import {
  ACTOR_SOURCE_VALUES,
  InvalidActorSourceError,
  parseActorSource,
  resolveActorContext,
  type ActorIngress,
} from '../../src/helpers/resolve-actor-context.js';

// Minimal RunbookState stub: resolveActorContext only reads `.id`.
function stubState(id: string): RunbookState {
  return { id: id as RunId } as unknown as RunbookState;
}

const TARGET = stubState('run_target');
const CLAIM_ID = 'rdclm_target' as ClaimId;
const TOKEN_HASH = 'tokenhash_target' as DelegationTokenHash;
const CONTROLLED = 'run_controlled' as RunId;

describe('parseActorSource', () => {
  it('exposes exactly the three frozen source values', () => {
    expect([...ACTOR_SOURCE_VALUES]).toEqual(['direct-cli', 'plugin', 'mcp']);
  });

  it.each(['direct-cli', 'plugin', 'mcp'] as const)('accepts %s', (value) => {
    expect(parseActorSource(value)).toBe(value);
  });

  it('rejects an unknown value with a typed hard error (no silent default)', () => {
    expect.assertions(3);
    try {
      parseActorSource('remote');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidActorSourceError);
      expect((error as InvalidActorSourceError).code).toBe('INVALID_ACTOR_SOURCE');
      expect((error as InvalidActorSourceError).value).toBe('remote');
    }
  });

  it('rejects the empty string', () => {
    expect(() => parseActorSource('')).toThrow(InvalidActorSourceError);
  });
});

describe('resolveActorContext — frozen trust-mapping table', () => {
  it('row 1: source unset, no claim => trusted_run_controller(direct-cli)', () => {
    const ingress: ActorIngress = {};
    expect(resolveActorContext(ingress, TARGET)).toEqual<ActorContext>({
      kind: 'trusted_run_controller',
      runId: TARGET.id,
      source: 'direct-cli',
    });
  });

  it('row 1b: source direct-cli, no claim => trusted_run_controller(direct-cli)', () => {
    expect(resolveActorContext({ source: 'direct-cli' }, TARGET)).toEqual<ActorContext>({
      kind: 'trusted_run_controller',
      runId: TARGET.id,
      source: 'direct-cli',
    });
  });

  it('row 2: source plugin, no claim => trusted_run_controller(plugin)', () => {
    expect(resolveActorContext({ source: 'plugin' }, TARGET)).toEqual<ActorContext>({
      kind: 'trusted_run_controller',
      runId: TARGET.id,
      source: 'plugin',
    });
  });

  it('row 3: source mcp, no claim => trusted_run_controller(mcp)', () => {
    expect(resolveActorContext({ source: 'mcp' }, TARGET)).toEqual<ActorContext>({
      kind: 'trusted_run_controller',
      runId: TARGET.id,
      source: 'mcp',
    });
  });

  it('row 4: any source + full claim evidence => claim_controller (source ignored)', () => {
    const expected: ActorContext = {
      kind: 'claim_controller',
      claimId: CLAIM_ID,
      tokenHash: TOKEN_HASH,
      controlledRunId: CONTROLLED,
    };
    for (const source of ACTOR_SOURCE_VALUES) {
      expect(
        resolveActorContext(
          { source, claimId: CLAIM_ID, tokenHash: TOKEN_HASH, controlledRunId: CONTROLLED },
          TARGET,
        ),
      ).toEqual<ActorContext>(expected);
    }
  });

  // Resolver invariant: if valid claim evidence is present, claim_controller
  // wins over any source tag. This does not imply the plugin plan emits
  // source=plugin for agent-run Bash lifecycle commands; it only pins the
  // resolver table for callers that already have claim evidence.
  it('row 4: source=plugin + valid claim => claim_controller (claim wins)', () => {
    const result = resolveActorContext(
      { source: 'plugin', claimId: CLAIM_ID, tokenHash: TOKEN_HASH, controlledRunId: CONTROLLED },
      TARGET,
    );
    expect(result).toEqual<ActorContext>({
      kind: 'claim_controller',
      claimId: CLAIM_ID,
      tokenHash: TOKEN_HASH,
      controlledRunId: CONTROLLED,
    });
    // Belt-and-braces: it is NOT downgraded to a trusted run controller and
    // carries no `source` field (claim_controller has no source).
    expect(result.kind).toBe('claim_controller');
    expect((result as { source?: unknown }).source).toBeUndefined();
  });

  it('row 4 (MCP pin): source=mcp + valid claim => claim_controller (claim wins)', () => {
    const result = resolveActorContext(
      { source: 'mcp', claimId: CLAIM_ID, tokenHash: TOKEN_HASH, controlledRunId: CONTROLLED },
      TARGET,
    );
    expect(result).toEqual<ActorContext>({
      kind: 'claim_controller',
      claimId: CLAIM_ID,
      tokenHash: TOKEN_HASH,
      controlledRunId: CONTROLLED,
    });
    expect(result.kind).toBe('claim_controller');
    expect((result as { source?: unknown }).source).toBeUndefined();
  });

  it('claim evidence defaults controlledRunId to the resolved target id when omitted', () => {
    // The collect path resolves the claimed child as `state`, so a caller may
    // omit controlledRunId and rely on `state.id`.
    expect(
      resolveActorContext({ claimId: CLAIM_ID, tokenHash: TOKEN_HASH }, TARGET),
    ).toEqual<ActorContext>({
      kind: 'claim_controller',
      claimId: CLAIM_ID,
      tokenHash: TOKEN_HASH,
      controlledRunId: TARGET.id,
    });
  });

  it('row 5: partial claim evidence (claimId without tokenHash) => unknown', () => {
    // No resolvable controlled run AND no *complete* claim evidence: the
    // reserved inspect-only fallback. Type-reachable even though no default
    // local frontend path produces it.
    expect(resolveActorContext({ source: 'plugin', claimId: CLAIM_ID }, TARGET)).toEqual<ActorContext>(
      { kind: 'unknown' },
    );
  });

  it('row 5b: tokenHash without claimId => unknown', () => {
    expect(resolveActorContext({ source: 'mcp', tokenHash: TOKEN_HASH }, TARGET)).toEqual<ActorContext>(
      { kind: 'unknown' },
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/helpers/resolve-actor-context.test.ts`
Expected: FAIL — `Cannot find module '../../src/helpers/resolve-actor-context.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/helpers/resolve-actor-context.ts`:

```typescript
// packages/cli/src/helpers/resolve-actor-context.ts

import {
  type ActorContext,
  type ActorContextSource,
  type ClaimId,
  type DelegationTokenHash,
  type RunId,
  type RunbookState,
  UNKNOWN_ACTOR_CONTEXT,
  claimControllerContext,
  trustedRunControllerContext,
} from '@rundown-org/core';

/**
 * The three valid actor-context source tags, in declaration order.
 *
 * This is the single source of truth for `--actor-source` / `RD_ACTOR_SOURCE`
 * validation and is kept exhaustive against {@link ActorContextSource} by the
 * compile-time check below.
 */
export const ACTOR_SOURCE_VALUES: readonly ActorContextSource[] = [
  'direct-cli',
  'plugin',
  'mcp',
];

// Exhaustiveness guard: if `ActorContextSource` gains a variant, this assignment
// fails to type-check until ACTOR_SOURCE_VALUES is extended.
const _exhaustiveSourceCheck: Record<ActorContextSource, true> = {
  'direct-cli': true,
  plugin: true,
  mcp: true,
};
void _exhaustiveSourceCheck;

/**
 * Hard error raised when an `--actor-source` / `RD_ACTOR_SOURCE` value is not a
 * recognised {@link ActorContextSource}.
 *
 * Type-driven dispatch forbids a silent default: an unknown source must fail
 * loudly so a mis-tagged frontend is caught at ingress, not silently downgraded.
 */
export class InvalidActorSourceError extends Error {
  /** Stable machine-readable error code for the CLI error envelope. */
  readonly code = 'INVALID_ACTOR_SOURCE' as const;
  /** The rejected raw value, echoed back for diagnostics. */
  readonly value: string;

  /**
   * @param value - The rejected raw source string
   */
  constructor(value: string) {
    super(
      `Invalid --actor-source value "${value}". Expected one of: ${ACTOR_SOURCE_VALUES.join(', ')}.`,
    );
    this.name = 'InvalidActorSourceError';
    this.value = value;
  }
}

/**
 * Validate a raw source string against the frozen source set.
 *
 * @param raw - Raw value from `--actor-source` or `RD_ACTOR_SOURCE`
 * @returns The validated {@link ActorContextSource}
 * @throws {InvalidActorSourceError} when `raw` is not a recognised source
 */
export function parseActorSource(raw: string): ActorContextSource {
  if ((ACTOR_SOURCE_VALUES as readonly string[]).includes(raw)) {
    return raw as ActorContextSource;
  }
  throw new InvalidActorSourceError(raw);
}

/**
 * Caller evidence assembled by a CLI command before constructing actor context.
 *
 * All fields are optional: a bare workspace invocation supplies none and is
 * mapped to a trusted `direct-cli` run controller (the compatibility lane).
 */
export interface ActorIngress {
  /** Provenance tag from `--actor-source` / `RD_ACTOR_SOURCE`; defaults to `direct-cli`. */
  readonly source?: ActorContextSource;
  /** Claim id from `--claim-id`, when targeting a claimed delegated run. */
  readonly claimId?: ClaimId;
  /** Token hash bound to the claim, from existing claim-evidence plumbing. */
  readonly tokenHash?: DelegationTokenHash;
  /** Resolved claimed run id; defaults to the resolved target `state.id`. */
  readonly controlledRunId?: RunId;
}

/**
 * Map caller ingress + a resolved target run to a core {@link ActorContext}.
 *
 * Implements the frozen trust-mapping table:
 * - complete claim evidence (`claimId` AND `tokenHash`) => `claim_controller`,
 *   with `controlledRunId` defaulting to `state.id` (the resolved claimed run).
 *   `source` is provenance only and does not change the claim mapping.
 * - otherwise, a source tag (or the unset compatibility default) => a trusted
 *   run controller for `state.id`, tagged with the resolved source.
 * - partial/contradictory claim evidence with no resolvable controlled run =>
 *   `unknown` (reserved inspect-only fallback; type-reachable, never a default
 *   local path).
 *
 * Role derivation against a target stays in core (`deriveEffectiveRole`); this
 * adapter only records evidence.
 *
 * @param ingress - Caller evidence (source tag and optional claim evidence)
 * @param state - Resolved target run the caller is acting on
 * @returns The constructed actor context
 */
export function resolveActorContext(ingress: ActorIngress, state: RunbookState): ActorContext {
  const hasClaimId = ingress.claimId !== undefined;
  const hasTokenHash = ingress.tokenHash !== undefined;

  if (hasClaimId && hasTokenHash) {
    return claimControllerContext({
      claimId: ingress.claimId,
      tokenHash: ingress.tokenHash,
      controlledRunId: ingress.controlledRunId ?? state.id,
    });
  }

  // Exactly one of claimId/tokenHash present is contradictory evidence with no
  // resolvable controlled run: fall to the reserved inspect-only context.
  if (hasClaimId || hasTokenHash) {
    return UNKNOWN_ACTOR_CONTEXT;
  }

  return trustedRunControllerContext(state.id, ingress.source ?? 'direct-cli');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/helpers/resolve-actor-context.test.ts`
Expected: PASS (all `parseActorSource` and `resolveActorContext` cases green).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/helpers/resolve-actor-context.ts \
        packages/cli/__tests__/helpers/resolve-actor-context.test.ts
git commit -m "feat(cli): add resolveActorContext frozen trust-mapping resolver"
```

---

## Task 2: `readActorSourceIngress` option helper + unit tests

**Files:**
- Create: `packages/cli/src/helpers/actor-source-option.ts`
- Test: `packages/cli/__tests__/helpers/actor-source-option.test.ts`

**Interfaces:**
- Consumes: `parseActorSource`, `InvalidActorSourceError` (Task 1);
  `type ActorContextSource` (`@rundown-org/core`); a Commander `Command`'s
  `optsWithGlobals()` (returns `{ actorSource?: string }`).
- Produces:
  - `interface ActorSourceReader { optsWithGlobals(): { actorSource?: string } }`
  - `function readActorSourceIngress(command: ActorSourceReader, env?: NodeJS.ProcessEnv): ActorContextSource | undefined`
    — flag (`--actor-source`) wins over env (`RD_ACTOR_SOURCE`); returns
    `undefined` when neither is set (so the resolver applies its `direct-cli`
    default); throws `InvalidActorSourceError` on an invalid value from either
    source.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/__tests__/helpers/actor-source-option.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import { InvalidActorSourceError } from '../../src/helpers/resolve-actor-context.js';
import {
  readActorSourceIngress,
  type ActorSourceReader,
} from '../../src/helpers/actor-source-option.js';

function reader(actorSource?: string): ActorSourceReader {
  return { optsWithGlobals: () => ({ actorSource }) };
}

describe('readActorSourceIngress', () => {
  it('returns undefined when neither flag nor env is set', () => {
    expect(readActorSourceIngress(reader(undefined), {})).toBeUndefined();
  });

  it('reads the validated value from the --actor-source flag', () => {
    expect(readActorSourceIngress(reader('plugin'), {})).toBe('plugin');
  });

  it('reads the validated value from RD_ACTOR_SOURCE when the flag is unset', () => {
    expect(readActorSourceIngress(reader(undefined), { RD_ACTOR_SOURCE: 'mcp' })).toBe('mcp');
  });

  it('lets the flag take precedence over the env var', () => {
    expect(readActorSourceIngress(reader('plugin'), { RD_ACTOR_SOURCE: 'mcp' })).toBe('plugin');
  });

  it('throws InvalidActorSourceError on an invalid flag value (no silent default)', () => {
    expect(() => readActorSourceIngress(reader('remote'), {})).toThrow(InvalidActorSourceError);
  });

  it('throws InvalidActorSourceError on an invalid env value', () => {
    expect(() => readActorSourceIngress(reader(undefined), { RD_ACTOR_SOURCE: 'remote' })).toThrow(
      InvalidActorSourceError,
    );
  });

  it('ignores an empty-string env var (treated as unset)', () => {
    expect(readActorSourceIngress(reader(undefined), { RD_ACTOR_SOURCE: '' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/helpers/actor-source-option.test.ts`
Expected: FAIL — `Cannot find module '../../src/helpers/actor-source-option.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/helpers/actor-source-option.ts`:

```typescript
// packages/cli/src/helpers/actor-source-option.ts

import type { ActorContextSource } from '@rundown-org/core';
import { parseActorSource } from './resolve-actor-context.js';

/**
 * Minimal structural view of the Commander command needed to read the
 * program-level `--actor-source` option (kept narrow so tests need no real
 * Commander instance).
 */
export interface ActorSourceReader {
  /**
   * Return this command's options merged with inherited program-level options.
   *
   * @returns Options object exposing the optional `actorSource` string
   */
  optsWithGlobals(): { actorSource?: string };
}

/**
 * Resolve the actor-context source tag from CLI ingress.
 *
 * Precedence: the `--actor-source` flag wins over the `RD_ACTOR_SOURCE` env var.
 * An empty-string env value is treated as unset. When neither is supplied this
 * returns `undefined`, deferring the `direct-cli` compatibility default to
 * {@link resolveActorContext}.
 *
 * @param command - Command exposing program-level options via `optsWithGlobals`
 * @param env - Environment to read `RD_ACTOR_SOURCE` from (defaults to `process.env`)
 * @returns The validated source tag, or `undefined` when none was supplied
 * @throws {InvalidActorSourceError} when a supplied flag/env value is invalid
 */
export function readActorSourceIngress(
  command: ActorSourceReader,
  env: NodeJS.ProcessEnv = process.env,
): ActorContextSource | undefined {
  const flagValue = command.optsWithGlobals().actorSource;
  if (flagValue !== undefined) {
    return parseActorSource(flagValue);
  }
  const envValue = env.RD_ACTOR_SOURCE;
  if (envValue !== undefined && envValue !== '') {
    return parseActorSource(envValue);
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/helpers/actor-source-option.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/helpers/actor-source-option.ts \
        packages/cli/__tests__/helpers/actor-source-option.test.ts
git commit -m "feat(cli): add readActorSourceIngress flag/env source reader"
```

---

## Task 3: Register the capture-only `--actor-source` program option + parse/help pins

**Files:**
- Modify: `packages/cli/src/cli.ts` (add the option near the existing display
  options, around lines 77-79). Capture-only; NO validation in any hook.
- Modify: `packages/core/src/output/zod-schemas.ts` (register the new
  CLI-only symbolic error code used by migrated commands).
- Test: `packages/cli/__tests__/commands/actor-source-ingress.test.ts` (create)

**Interfaces:**
- Consumes: nothing new at runtime (the flag is plain Commander capture).
- Produces: a program-level Commander option `--actor-source <source>` readable
  by any ACTION command via `command.optsWithGlobals().actorSource`.

> **Why capture-only, validated per-command (findings 2+3).** Validating in a
> Commander `preAction`/`preSubcommand` hook is wrong on two counts: (2) the
> hook receives `(thisCommand, actionCommand)` and the program-level `thisCommand`
> is the *program*, not the leaf command — so `optsWithGlobals()` semantics there
> are unreliable; (3) a thrown hook error is caught by `cli.ts`'s
> `parseAsync().catch`, which only does `console.error(error.message)` +
> `process.exit(1)` — bypassing the `INVALID_ACTOR_SOURCE` JSON envelope
> contract. Therefore this task ONLY registers the flag as capture-only (like the
> existing `--no-color`). Each actor-context-constructing command reads and
> validates it inside its own `withErrorHandling` / `OutputEmitter` block (Tasks
> 4, 5, 6), so an invalid value renders the standard JSON error envelope. This
> task also registers `INVALID_ACTOR_SOURCE` in the shared output schema before
> those commands start emitting it. Tests
> that assert the invalid-value *envelope* therefore live in those tasks, against
> a command that actually validates — not here. Task 3 pins only what is true
> after registration alone: the flag PARSES pre-subcommand and is advertised at
> program level.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/__tests__/commands/actor-source-ingress.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  getActiveState,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('--actor-source / RD_ACTOR_SOURCE ingress', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('accepts a valid --actor-source flag without disturbing a read-only command', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    // `status` does not construct actor context (so it neither validates nor
    // uses the source), but the capture-only flag must parse cleanly.
    const result = await runCliInProcess('--actor-source plugin status', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/unknown option/i);
  });

  // CROSS-PLAN PIN (Plan 7 / MCP): the MCP server spawns
  // `npx --no rundown --actor-source mcp <subcommand> ...` — the flag is a
  // PROGRAM-LEVEL token BEFORE the subcommand, and MCP cannot use the
  // RD_ACTOR_SOURCE env bridge (docs/reference/mcp.md §4: the CLI MUST inherit
  // the server env unmodified). These tests pin that `--actor-source` is parsed
  // pre-subcommand and advertised at program level, so a refactor cannot quietly
  // move it onto a per-subcommand registration and break MCP.
  it('parses --actor-source as a program-level token placed BEFORE the subcommand', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    // mcp source, no claim, bare pass while NOT pending: must transition
    // normally (proving the pre-subcommand flag was consumed, not rejected as an
    // unknown option, and not mistaken for a subcommand argument). `pass` is
    // migrated in Task 6; until then the flag is captured-but-unused and the
    // transition still succeeds.
    const result = await runCliInProcess('--actor-source mcp pass --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/unknown option/i);
    const state = await getActiveState(workspace);
    expect(state?.step).toBe('2');
  });

  it('advertises --actor-source at the program level in --help', async () => {
    const result = await runCliInProcess('--help', workspace);

    // Program-level help (not a subcommand help) must list the flag, proving it
    // is registered on the program, not on an individual subcommand.
    expect(result.stdout).toMatch(/--actor-source/);
  });
});
```

> The invalid-value *envelope* assertions deliberately are NOT here: validation
> is per-command (Tasks 4/5/6). Asserting the envelope against an unmigrated
> read-only command would either fail (no validation wired) or force a
> hook-based throw that bypasses the JSON contract (finding 3). The pre-subcommand
> `pass` test above passes after registration because the flag is captured and
> ignored until Task 6 — it pins parse/placement, not validation.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/actor-source-ingress.test.ts`
Expected: FAIL — the `--actor-source` flag is unknown to Commander (`error:
unknown option '--actor-source'`) for the pre-subcommand and status cases; the
`--help` case fails because the flag is not yet advertised.

- [ ] **Step 3: Write minimal implementation (capture-only, no hook validation)**

In `packages/cli/src/cli.ts`, add the option immediately after the existing
display options (after line 79, the `--schema` option):

```typescript
  // Display options
  program.option('--no-color', 'Disable colored output');
  program.option('--schema', "Output JSON schema for the command's JSON output");

  // Actor-context ingress (provenance tag for role-specific mutation policy).
  // CAPTURE-ONLY: this flag is read AND validated inside each actor-context-
  // constructing command's withErrorHandling/OutputEmitter block (see
  // readActorSourceIngress), NOT here. Do not add validation to a Commander hook:
  // a thrown hook error is caught by parseAsync().catch below and printed to
  // stderr, which would bypass the INVALID_ACTOR_SOURCE JSON envelope contract.
  program.option(
    '--actor-source <source>',
    'Actor-context provenance for role-specific mutations (direct-cli | plugin | mcp)',
  );
```

Leave the existing `program.hook('preAction', ...)` UNCHANGED (it only handles
`--no-color`). Add NO import and NO validation call to `cli.ts`.

- [ ] **Step 4: Register `INVALID_ACTOR_SOURCE` as a CLI symbolic output code**

In `packages/core/src/output/zod-schemas.ts`, add the new symbolic code
immediately after `ACTOR_CONTEXT_REQUIRED` in both the values list and
`CLIErrorCodes`:

```typescript
const CLISymbolicErrorCodeValues = [
  // ...
  'DELEGATION_COLLECTION_PENDING',
  'ACTOR_CONTEXT_REQUIRED',
  'INVALID_ACTOR_SOURCE',
  'COLLECT_REQUIRES_ORCHESTRATOR',
  // ...
] as const;
```

```typescript
export const CLIErrorCodes = {
  // ...
  /** Actor context is required for the requested role-specific command */
  ACTOR_CONTEXT_REQUIRED: 'ACTOR_CONTEXT_REQUIRED',
  /** Actor source ingress value is invalid */
  INVALID_ACTOR_SOURCE: 'INVALID_ACTOR_SOURCE',
  /** Collection requires an actor that controls the target delegating run */
  COLLECT_REQUIRES_ORCHESTRATOR: 'COLLECT_REQUIRES_ORCHESTRATOR',
  // ...
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/actor-source-ingress.test.ts`
Expected: PASS — the flag parses pre-subcommand, status is undisturbed, and
`--help` advertises `--actor-source` at program level.

- [ ] **Step 6: Verify output schema accepts the new symbolic code**

Run: `pnpm --filter @rundown-org/core test -- zod-schemas`
Expected: PASS. If there is no focused test target for this file in the current
Jest config, run `pnpm --filter @rundown-org/core test` and confirm it passes.

- [ ] **Step 7: Verify no existing CLI tests regressed**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/status.test.ts __tests__/cli.test.ts`
Expected: PASS (the new global capture-only option does not disturb existing
commands).

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/cli.ts \
        packages/core/src/output/zod-schemas.ts \
        packages/cli/__tests__/commands/actor-source-ingress.test.ts
git commit -m "feat(cli): register capture-only --actor-source program option"
```

---

## Task 4: Migrate `delegate.ts` to `resolveActorContext` (provenance source) + INVARIANT + envelope tests

**Files:**
- Modify: `packages/cli/src/commands/delegate.ts` (the bare-delegation-issue
  policy call at `delegate.ts:132`; export a pure `buildDelegateActorIngress`
  helper; read+validate the ingress source inside the existing `withErrorHandling`
  block)
- Test: `packages/cli/__tests__/commands/delegate.test.ts` (cross-source
  collection-pending INVARIANT + invalid-source envelope, reusing the existing
  `setupAutoIssuedDelegation()` fixture)
- Test: `packages/cli/__tests__/commands/delegate-actor-source.test.ts` (NEW;
  the pure-helper source-propagation driving test)

**Interfaces:**
- Consumes: `resolveActorContext`, `ActorIngress`, `ActorContextSource` (Task 1);
  `readActorSourceIngress` (Task 2). Replaces the inline hardcoded
  `trustedRunControllerContext(state.id, 'direct-cli')`.
- Produces: `delegate` builds its actor context via `resolveActorContext` (fed by
  the exported `buildDelegateActorIngress(actorSource): ActorIngress` helper),
  tagged with the ingress source, and validates an invalid source through the
  JSON envelope.

> **What is actually being fixed (finding 1).** `delegate.ts:132` always built
> `trustedRunControllerContext(state.id, 'direct-cli')` with a HARDCODED source.
> `delegate` registers only `--step/--index/--retry/--input*/--text` — there is
> **no `--claim-id` option**, so there is no claim-targeting path and no claim
> bug. The ONLY defect is the hardcoded provenance: a `plugin`/`mcp` caller is
> mislabeled `direct-cli`. The migration replaces the inline construction with
> `resolveActorContext({ source }, state)`. No claim evidence is threaded.

> **Fixture (finding 4).** The existing guard test in `delegate.test.ts` uses a
> helper `setupAutoIssuedDelegation()` (defined in that file: it writes a
> `delegate-parent.runbook.md` whose substep 1 has `delegate: true`, runs it
> `--prompted`, then extracts the auto-issued token from
> `state.substepStates.find(s => s.id === '1').delegation.token`), then calls
> `injectDelegationOutcomeForActiveRun(workspace)` to make collection pending,
> then asserts bare `['delegate']` → exit 1 + `DELEGATION_COLLECTION_PENDING`
> envelope (validated against `ErrorResponseSchema`). The new tests below REUSE
> that exact fixture so they fail for the guard, not for runbook/inference
> reasons. They live in `delegate.test.ts` (where `setupAutoIssuedDelegation` is
> in scope), not in the ingress test file.

- [ ] **Step 1: Write the failing cross-source INVARIANT + envelope + driving tests**

Append to `packages/cli/__tests__/commands/delegate.test.ts`, inside the
top-level `describe('delegate command', ...)` (so `setupAutoIssuedDelegation`,
`injectDelegationOutcomeForActiveRun`, `ErrorResponseSchema`, and `workspace`
are all in scope):

```typescript
  describe('actor-source ingress', () => {
    // INVARIANT: the collection-pending guard refuses bare delegate for EVERY
    // source. Source never buys past the guard. Reuses the same fixture as the
    // canonical guard test so the failure is the guard, not runbook resolution.
    it.each(['direct-cli', 'plugin', 'mcp'] as const)(
      'still refuses bare delegate while pending (source=%s, flag)',
      async (source) => {
        await setupAutoIssuedDelegation();
        await injectDelegationOutcomeForActiveRun(workspace);

        const result = await runCliInProcess(`--actor-source ${source} delegate`, workspace);

        expect(result.exitCode).toBe(1);
        const raw = JSON.parse(result.stdout);
        expect(ErrorResponseSchema.safeParse(raw).success).toBe(true);
        expect((raw as { code?: string }).code).toBe('DELEGATION_COLLECTION_PENDING');
      },
    );

    it('still refuses bare delegate while pending when RD_ACTOR_SOURCE=plugin', async () => {
      await setupAutoIssuedDelegation();
      await injectDelegationOutcomeForActiveRun(workspace);

      const result = await runCliInProcess('delegate', workspace, {
        env: { RD_ACTOR_SOURCE: 'plugin' },
      });

      expect(result.exitCode).toBe(1);
      expect((JSON.parse(result.stdout) as { code?: string }).code).toBe(
        'DELEGATION_COLLECTION_PENDING',
      );
    });

    // ENVELOPE (finding 3): an invalid source renders the INVALID_ACTOR_SOURCE
    // JSON envelope through the command's OutputEmitter — NOT a raw stderr line.
    it('renders the INVALID_ACTOR_SOURCE JSON envelope on an invalid --actor-source', async () => {
      await setupAutoIssuedDelegation();

      const result = await runCliInProcess('--actor-source remote delegate', workspace);

      expect(result.exitCode).not.toBe(0);
      const raw = JSON.parse(result.stdout);
      expect(ErrorResponseSchema.safeParse(raw).success).toBe(true);
      expect((raw as { code?: string }).code).toBe('INVALID_ACTOR_SOURCE');
    });

    it('renders the INVALID_ACTOR_SOURCE envelope on an invalid RD_ACTOR_SOURCE', async () => {
      await setupAutoIssuedDelegation();

      const result = await runCliInProcess('delegate', workspace, {
        env: { RD_ACTOR_SOURCE: 'remote' },
      });

      expect(result.exitCode).not.toBe(0);
      expect((JSON.parse(result.stdout) as { code?: string }).code).toBe('INVALID_ACTOR_SOURCE');
    });
  });
```

- [ ] **Step 2: Write the failing SOURCE-PROPAGATION driving test (finding 5)**

The guard is source-INDEPENDENT, so the INVARIANT rows above pass even before
the source is threaded — they pin the invariant but do NOT drive the migration.
Add a test that OBSERVES the source actually flowing into the constructed ingress
via a pure exported helper, so the migration is genuinely test-driven (a
first-party module spy is unreliable under this package's `isolatedModules` +
`useESM` jest config, so a direct unit test of an exported helper is used).

Create `packages/cli/__tests__/commands/delegate-actor-source.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { buildDelegateActorIngress } from '../../src/commands/delegate.js';

// Robust source-propagation driver: a pure exported helper that delegate uses to
// build its ActorIngress from the resolved source. Module-spying a first-party
// named export is unreliable under this package's jest config (`isolatedModules:
// true` + `useESM: true`), so the driver is a direct unit test of the helper —
// mirroring Task 6's `buildTransitionActorContext`. This FAILS to compile/run
// before Step 4 extracts the helper, which is what TDD-drives the migration.
describe('buildDelegateActorIngress threads the actor source', () => {
  it('tags ingress.source when a source is supplied', () => {
    expect(buildDelegateActorIngress('plugin')).toEqual({ source: 'plugin' });
    expect(buildDelegateActorIngress('mcp')).toEqual({ source: 'mcp' });
  });

  it('produces an empty ingress (no source) when the source is undefined', () => {
    expect(buildDelegateActorIngress(undefined)).toEqual({});
  });
});

// A coarse end-to-end pin that the flag is at least accepted on the delegate
// path (the behavioral effect of source is invisible at the CLI because
// deriveEffectiveRole ignores source — so the unit test above is the real
// driver; this only guards against the flag being rejected as unknown).
describe('delegate accepts --actor-source without error', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('does not reject a valid --actor-source plugin on a fresh delegate', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('--actor-source plugin delegate', workspace);

    expect(result.stdout).not.toMatch(/unknown option/i);
    expect((JSON.parse(result.stdout) as { code?: string }).code).not.toBe('INVALID_ACTOR_SOURCE');
  });
});
```

> The unit test of `buildDelegateActorIngress` is the genuine driver: it fails
> to import (helper does not exist) before Step 4. The INVARIANT rows in Step 1
> are a separate source-independence assertion that must stay green throughout.

- [ ] **Step 3: Run the new tests to verify they fail correctly**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/delegate-actor-source.test.ts`
Expected: FAIL — `buildDelegateActorIngress` is not yet exported from
`delegate.ts`, so the import fails (the driving failure).

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/delegate.test.ts -t "actor-source ingress"`
Expected: the INVARIANT rows PASS (guard is source-independent), the two
`INVALID_ACTOR_SOURCE` envelope tests FAIL (delegate does not yet validate the
source). This split is expected and intended.

- [ ] **Step 4: Migrate the construction site (extract helper + read/validate inside withErrorHandling)**

In `packages/cli/src/commands/delegate.ts`, add the helper imports:

```typescript
import { resolveActorContext, type ActorIngress } from '../helpers/resolve-actor-context.js';
import { readActorSourceIngress } from '../helpers/actor-source-option.js';
```

Add the exported pure ingress helper near the top of the module (module scope,
not inside the action), with TSDoc:

```typescript
/**
 * Build the delegate command's actor ingress from a resolved source tag.
 *
 * `delegate` registers no `--claim-id` option, so it never carries claim
 * evidence — the ingress is provenance-source-only. Exported so the
 * source-propagation behavior is unit-testable in isolation.
 *
 * @param actorSource - Resolved `--actor-source` / `RD_ACTOR_SOURCE` tag, or undefined
 * @returns An `ActorIngress` with `source` set iff a tag was supplied
 */
export function buildDelegateActorIngress(
  actorSource: ActorContextSource | undefined,
): ActorIngress {
  return actorSource ? { source: actorSource } : {};
}
```

Add `type ActorContextSource` and `getErrorMessage` to the `@rundown-org/core`
import block in `delegate.ts` (`getErrorMessage` is barrel-exported via
`errors.ts` and already used in `packages/cli/src/helpers/wrapper.ts`; see
CLAUDE.md Testing Conventions).

Add a trailing `command: Command` parameter to the existing `.action` signature
(`Command` is already imported in this file). AFTER the
`if (options.retry) { ... return; }` early return (around `delegate.ts:106-117`)
— so it sits on the bare-issue / step-targeted path, not the `--retry` path which
has its own handler — read and validate the source, rendering an invalid value
through the JSON envelope:

```typescript
          let actorSource;
          try {
            actorSource = readActorSourceIngress(command);
          } catch (error: unknown) {
            // InvalidActorSourceError carries code 'INVALID_ACTOR_SOURCE' and a
            // human message; render it through the standard JSON envelope.
            output.error(getErrorMessage(error), 'INVALID_ACTOR_SOURCE');
            output.flush();
            process.exitCode = 1;
            return;
          }
```

Then replace the inline construction in the `isBareDelegationIssue` branch
(currently at `delegate.ts:132`):

```typescript
            const policy = resolveCommandIntent({
              actorContext: resolveActorContext(buildDelegateActorIngress(actorSource), state),
              intent: { kind: 'delegation-issuance', command: 'delegate', targeted: false },
              targetSelector: { kind: 'default' },
              targetState: state,
            });
```

> `state` is the active run resolved earlier in the bare-issue branch (it is
> already in scope at the original construction site). `buildDelegateActorIngress`
> is the module-scope helper added above.

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/delegate-actor-source.test.ts`
Expected: PASS — `buildDelegateActorIngress('plugin')` returns `{ source:
'plugin' }`, `buildDelegateActorIngress(undefined)` returns `{}`, and the
end-to-end `--actor-source plugin delegate` is not rejected.

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/delegate.test.ts`
Expected: PASS — all pre-existing delegate tests, the INVARIANT rows, and both
`INVALID_ACTOR_SOURCE` envelope tests.

- [ ] **Step 6: Add and run the behavior-unchanged regression test**

Append to the `describe('actor-source ingress', ...)` block in
`delegate.test.ts`:

```typescript
    it('issues a bare delegation unchanged when source=direct-cli is explicit', async () => {
      // Behavior-neutral for the default source: explicit direct-cli must match
      // the untagged happy path. Uses the same parent fixture the happy-path
      // tests use so a real token is issued.
      await setupAutoIssuedDelegation();

      // setupAutoIssuedDelegation leaves an auto-issued delegation on substep 1;
      // a fresh bare delegate with no pending outcome echoes/returns a token.
      const explicit = await runCliInProcess('--actor-source direct-cli delegate', workspace);

      expect(explicit.exitCode).toBe(0);
      const raw = JSON.parse(explicit.stdout);
      expect(DelegateResponseSchema.safeParse(raw).success).toBe(true);
    });
```

> `DelegateResponseSchema` is already imported in `delegate.test.ts`. If the
> bare-delegate-after-setup path returns an error envelope instead of a delegate
> response in this fixture (e.g. because substep 1 already has an in-flight
> delegation), model this assertion on whichever existing happy-path test in
> `delegate.test.ts` issues a token, and assert exit 0 + `DelegateResponseSchema`
> against that exact scenario. The load-bearing claim is only that explicit
> `direct-cli` is byte-identical to the untagged path.

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/delegate.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/delegate.ts \
        packages/cli/__tests__/commands/delegate.test.ts \
        packages/cli/__tests__/commands/delegate-actor-source.test.ts
git commit -m "feat(cli): tag delegate actor context source via resolveActorContext"
```

---

## Task 5: Migrate `collect.ts` to `resolveActorContext`

**Files:**
- Modify: `packages/cli/src/commands/collect.ts` (lines 428-434, the inline
  `ctx.claim ? claimControllerContext(...) : trustedRunControllerContext(...)`)
- Test: `packages/cli/__tests__/commands/collect.test.ts` (add a source-tag
  behavior-unchanged assertion)

**Interfaces:**
- Consumes: `resolveActorContext`, `ActorIngress` (Task 1);
  `readActorSourceIngress` (Task 2); `ctx.claim` (the resolved `ClaimRecord`
  already surfaced on the collect path, carrying `claimId` and `tokenHash`).
- Produces: `collect` builds context via the shared resolver; the claim-vs-no-
  claim branch and the `direct-cli`/source tag now live only in the resolver.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/__tests__/commands/collect.test.ts`, inside its
top-level `describe`:

```typescript
  it('collects unchanged when an explicit --actor-source plugin tag is supplied', async () => {
    // Source is provenance only: a plugin-tagged orchestrator of the run is
    // still the orchestrator-for-target, so collection behaves identically to
    // the untagged direct-cli path. Reuses the canonical drain fixture
    // `setupReadyToCollect` already defined in this file (see the
    // 'successful aggregation' describe block).
    await setupReadyToCollect(['pass', 'pass']);

    const tagged = await runCliInProcess(['--actor-source', 'plugin', 'collect'], workspace);

    // Identical to the untagged `['collect']` happy path: exit 0 and the parent
    // advances to step 2 (PASS ALL → CONTINUE).
    expect(tagged.exitCode).toBe(0);
    const state = await getActiveState(workspace);
    expect(state?.step).toBe('2');
  });

  it('renders the INVALID_ACTOR_SOURCE JSON envelope on an invalid --actor-source for collect', async () => {
    await setupReadyToCollect(['pass', 'pass']);

    const result = await runCliInProcess(['--actor-source', 'remote', 'collect'], workspace);

    expect(result.exitCode).not.toBe(0);
    expect((JSON.parse(result.stdout) as { code?: string }).code).toBe('INVALID_ACTOR_SOURCE');
  });
```

> `setupReadyToCollect` and `getActiveState` are already in scope in
> `collect.test.ts` (the file's `successful aggregation` block uses both). The
> load-bearing checks: a `plugin`-tagged collect is byte-identical to the
> untagged drain (exit 0, advance to step 2), and an invalid source renders the
> `INVALID_ACTOR_SOURCE` envelope via the OutputEmitter (finding 3) rather than a
> stderr line.

- [ ] **Step 2: Run tests to verify the driving test fails**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/collect.test.ts -t "INVALID_ACTOR_SOURCE JSON envelope on an invalid --actor-source for collect"`
Expected: FAIL — `collect` does not yet read/validate the source, so an invalid
`--actor-source remote` is silently parsed-and-ignored (collect proceeds, exit 0,
no `INVALID_ACTOR_SOURCE` envelope). This is the test that genuinely DRIVES the
migration.

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/collect.test.ts -t "explicit --actor-source plugin"`
Expected: this row may already PASS — collection is source-independent, so a
`plugin`-tagged collect already drains identically. It is the behavior-neutral
pin (must stay green through the migration), not the driver. Proceed to Step 3
regardless; the migration removes the inline construction both tests pin.

- [ ] **Step 3: Migrate the construction site**

In `packages/cli/src/commands/collect.ts`:

Add the helper imports near the existing imports:

```typescript
import { resolveActorContext, type ActorIngress } from '../helpers/resolve-actor-context.js';
import { readActorSourceIngress } from '../helpers/actor-source-option.js';
```

Remove `claimControllerContext` and `trustedRunControllerContext` from the
`@rundown-org/core` import block if they become unused after this change (keep
`type ActorContext`).

The `runCollect` function receives `ctx: TransitionContext`. The Commander
`Command` is available where `runCollect` is invoked (the `.action` callback);
thread the resolved source down. Change the `runCollect` signature to accept the
source, and resolve it in the registering action:

```typescript
async function runCollect(
  ctx: TransitionContext,
  options: CollectOptions,
  actorSource: ActorContextSource | undefined,
): Promise<boolean> {
```

Add `type ActorContextSource` to the `@rundown-org/core` import block in
`collect.ts`.

Replace the inline construction (lines 428-434):

```typescript
  // Source is provenance only; the claim-vs-no-claim trust decision lives in
  // resolveActorContext. On the claim path `ctx.claim` carries the claim id and
  // token hash, and `ctx.state` is the claimed child run, so controlledRunId
  // defaults to state.id; otherwise the trusted run-controller maps the active
  // run's controller to the orchestrator for its own run.
  const ingress: ActorIngress = {
    ...(actorSource ? { source: actorSource } : {}),
    ...(ctx.claim
      ? { claimId: ctx.claim.claimId, tokenHash: ctx.claim.tokenHash, controlledRunId: state.id }
      : {}),
  };
  const actorContext: ActorContext = resolveActorContext(ingress, state);
```

In the `.action` callback that calls `runCollect`, read AND validate the source
inside the existing `withErrorHandling` / `OutputEmitter` block, then pass it
down. Locate the call site (search for `runCollect(` in `collect.ts`), add the
`command` action parameter, and render an invalid source through the JSON
envelope rather than letting it throw:

```typescript
        let actorSource;
        try {
          actorSource = readActorSourceIngress(command);
        } catch (error: unknown) {
          output.error(getErrorMessage(error), 'INVALID_ACTOR_SOURCE');
          output.flush();
          process.exitCode = 1;
          return;
        }
        const shouldFail = await runCollect(ctx, options, actorSource);
```

> Add the trailing `command: Command` parameter to the collect `.action`
> signature if absent, importing `type Command` from `commander` (already
> imported for `registerCollectCommand`). Add `getErrorMessage` to the
> `@rundown-org/core` import block in `collect.ts` (barrel-exported; already used
> by the CLI's `wrapper.ts`). `output` is the `OutputEmitter` already constructed
> at the top of the collect action.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/collect.test.ts`
Expected: PASS (all pre-existing collect tests plus the new source-tag test).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/collect.ts \
        packages/cli/__tests__/commands/collect.test.ts
git commit -m "feat(cli): build collect actor context via resolveActorContext"
```

---

## Task 6: Thread the source tag into `pass`/`fail` via core's compatibility lane

**Files:**
- Modify: `packages/cli/src/helpers/transitions.ts` (`buildTransitionContext`
  overloads + body: accept an `actorSource` and pass it to
  `resolveTransitionTarget`)
- Modify: `packages/cli/src/helpers/transition-command.ts` (read+validate the
  ingress source via OutputEmitter, pass it into `buildTransitionContext`)
- Modify: `packages/core/src/runbook/command-target-resolver.ts` (add the narrow
  `actorContextSource?` option)
- Test: `packages/cli/__tests__/commands/pass.test.ts` AND
  `packages/cli/__tests__/commands/fail.test.ts` (symmetric cross-source guard +
  invalid-source envelope rows — finding 6)
- Test: `packages/core/__tests__/runbook/command-target-resolver.test.ts`
  (source-propagation driving test + tag-refinement + cross-source guard)

**Interfaces:**
- Consumes: `readActorSourceIngress` (Task 2); `trustedRunControllerContext` /
  `type ActorContextSource` (core); `resolveTransitionTarget`'s new
  `actorContextSource?` option.
- Produces: bare `pass`/`fail` carry an accurate `source` tag into core's
  trusted-controller construction while preserving identical behavior for
  `direct-cli`. The collection-pending guard remains source-independent.

> **Why through core, not a CLI shadow path:** pass/fail do not pre-resolve the
> target run in the CLI; core's `resolveTransitionTarget` resolves the target
> AND (today) synthesizes `trustedRunControllerContext(active.id, 'direct-cli')`
> when `directCliCompatibility` is set. Re-resolving the target in the CLI just
> to build the context would duplicate core targeting logic — a forbidden shadow
> implementation. Instead the CLI supplies the *source tag*, and core builds the
> trusted-controller context with that tag at its existing choke point. Core's
> policy and the collection-pending guard are unchanged.

> **The driving test lives in core (finding 5).** The CLI-level guard rows are
> source-INDEPENDENT, so they pass before the source is threaded and do not drive
> the change. The test that genuinely FAILS pre-migration is the core unit test
> in Step 1b: it asserts the constructed trusted-controller context carries
> `source: 'plugin'` when `actorContextSource: 'plugin'` is passed. Pre-migration,
> `resolveTransitionTarget` has no `actorContextSource` option, so the test fails
> to compile/run until the core option is added — that is what TDD-drives the
> refinement.

- [ ] **Step 1: Write the failing SYMMETRIC CLI guard + envelope rows (pass AND fail)**

Extend the `describe('collection-pending guard', ...)` block in
**`packages/cli/__tests__/commands/pass.test.ts`** with cross-source rows and an
invalid-source envelope row:

```typescript
    it.each(['plugin', 'mcp'] as const)(
      'still refuses bare pass while pending when source=%s (source never buys past the guard)',
      async (source) => {
        await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
        const completionKey = await injectDelegationOutcomeForActiveRun(workspace);

        const result = await runCliInProcess(`--actor-source ${source} pass`, workspace);

        expect(result.exitCode).toBe(1);
        const payload = JSON.parse(result.stdout) as {
          code?: string;
          details?: { outcomeCompletionKeys?: string[] };
        };
        expect(payload.code).toBe('DELEGATION_COLLECTION_PENDING');
        expect(payload.details?.outcomeCompletionKeys).toEqual([completionKey]);
      },
    );

    it('renders the INVALID_ACTOR_SOURCE envelope on an invalid --actor-source for pass', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('--actor-source remote pass', workspace);

      expect(result.exitCode).not.toBe(0);
      expect((JSON.parse(result.stdout) as { code?: string }).code).toBe('INVALID_ACTOR_SOURCE');
    });
```

Add the SYMMETRIC rows to **`packages/cli/__tests__/commands/fail.test.ts`**
inside its `describe('collection-pending guard', ...)` block (the INVARIANT is
"pass AND fail for every source" — finding 6):

```typescript
    it.each(['plugin', 'mcp'] as const)(
      'still refuses bare fail while pending when source=%s (source never buys past the guard)',
      async (source) => {
        await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
        const completionKey = await injectDelegationOutcomeForActiveRun(workspace);

        const result = await runCliInProcess(`--actor-source ${source} fail`, workspace);

        expect(result.exitCode).toBe(1);
        const payload = JSON.parse(result.stdout) as {
          code?: string;
          details?: { outcomeCompletionKeys?: string[] };
        };
        expect(payload.code).toBe('DELEGATION_COLLECTION_PENDING');
        expect(payload.details?.outcomeCompletionKeys).toEqual([completionKey]);
      },
    );

    it('renders the INVALID_ACTOR_SOURCE envelope on an invalid --actor-source for fail', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('--actor-source remote fail', workspace);

      expect(result.exitCode).not.toBe(0);
      expect((JSON.parse(result.stdout) as { code?: string }).code).toBe('INVALID_ACTOR_SOURCE');
    });
```

> `injectDelegationOutcomeForActiveRun` is already imported in both
> `pass.test.ts` and `fail.test.ts` (see their existing `collection-pending
> guard` blocks). The guard rows are source-independent and may already pass; the
> invalid-source envelope rows FAIL until Step 4 wires read+validate.

- [ ] **Step 1b: Write the failing core source-propagation driving test**

The genuine driver is a direct unit test of the EXPORTED
`buildTransitionActorContext` helper that Step 3 extracts from
`command-target-resolver.ts` (a pure function — no module-spy fragility under
`isolatedModules`). Add to
`packages/core/__tests__/runbook/command-target-resolver.test.ts`:

```typescript
// Extend the file's EXISTING imports — do NOT add a fresh import block.
// `resolveTransitionTarget` is already imported from command-target-resolver.js
// and re-importing it is a duplicate binding. Add `buildTransitionActorContext`
// to that existing block, and add `RunId` to the existing types.js type import
// (RunId is re-exported from types.js):
//   import {
//     type CommandTargetReader,
//     buildTransitionActorContext,   // ← add
//     resolveCommandTarget,
//     resolveTransitionTarget,
//   } from '../../src/runbook/command-target-resolver.js';
//   import type { Runbook, RunbookState, RunId, Step } from '../../src/runbook/types.js'; // ← add RunId

  it('buildTransitionActorContext tags the trusted controller with the source', () => {
    const id = 'run_active' as RunId;
    expect(buildTransitionActorContext(id, { actorContextSource: 'plugin' })).toEqual({
      kind: 'trusted_run_controller',
      runId: id,
      source: 'plugin',
    });
    expect(buildTransitionActorContext(id, { directCliCompatibility: true })).toEqual({
      kind: 'trusted_run_controller',
      runId: id,
      source: 'direct-cli',
    });
    expect(buildTransitionActorContext(id, {})).toEqual({ kind: 'unknown' });
  });
```

> This fails to import (`buildTransitionActorContext` does not exist) before Step
> 3 — that is the driving failure. It proves the source PROPAGATES into the
> constructed context (a `plugin` tag yields `source: 'plugin'`), which the
> source-independent CLI guard rows cannot prove. The same assertion is repeated
> as the canonical helper test in Step 3b; keep it in one place (here) and have
> Step 3b reference it rather than duplicating.

- [ ] **Step 2: Run the new tests to verify the drivers fail**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/runbook/command-target-resolver.test.ts -t "buildTransitionActorContext tags the trusted controller with the source"`
Expected: FAIL (compile or runtime) — `actorContextSource` is not yet an option
on `resolveTransitionTarget`. THIS is the driving failure.

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/pass.test.ts __tests__/commands/fail.test.ts -t "INVALID_ACTOR_SOURCE"`
Expected: FAIL — pass/fail do not yet read/validate the source, so an invalid
value is silently ignored (no envelope). The cross-source guard rows may already
pass (source-independent) and must stay green.

- [ ] **Step 3: Thread `actorSource` through `buildTransitionContext`**

In `packages/cli/src/helpers/transitions.ts`:

Add `type ActorContextSource` to the `@rundown-org/core` import block (the file
already imports `ClaimRecord`, `RunbookState`, etc.). Do NOT import
`trustedRunControllerContext` here: the CLI change below only forwards
`actorContextSource` to `resolveTransitionTarget` (core builds the
`trustedRunControllerContext` internally, once it has resolved `active.id`), so
importing it into `transitions.ts` would be an unused binding that fails
lint/type checks.

Update the `buildTransitionContext` pass/fail overload and implementation to
accept an optional `actorSource`:

```typescript
export function buildTransitionContext(
  output: OutputEmitter,
  cwd: string,
  options: {
    readonly command: 'pass' | 'fail';
    readonly claimId?: ClaimId;
    readonly step?: string;
    readonly actorSource?: ActorContextSource;
  },
): Promise<BuildTransitionContextResult>;
```

(Leave the base overload — `options?: { readonly claimId?: ClaimId }` — as-is;
the collect path does not use this function for actor tagging.)

In the implementation signature, add `actorSource` to the destructured options
type:

```typescript
  options: {
    readonly command?: 'pass' | 'fail';
    readonly claimId?: ClaimId;
    readonly step?: string;
    readonly actorSource?: ActorContextSource;
  } = {},
```

In the `if (options.command !== undefined)` branch, replace the
`resolveTransitionTarget` call so it passes an explicit `actorContext` built
from the source tag instead of relying solely on `directCliCompatibility`:

```typescript
    const active = await resolveTransitionTarget(sessionService, {
      command: options.command,
      claimId: options.claimId,
      targeted: options.step !== undefined,
      // Supply the source-tagged trusted-controller context only for the
      // default (non-claim) target; core resolves the active run id and the
      // bare advance is the only path that evaluates actor context. When an
      // explicit source is absent, fall back to the direct-cli compatibility
      // lane so behavior is byte-identical to before.
      ...(options.actorSource && options.claimId === undefined
        ? { actorContextSource: options.actorSource }
        : { directCliCompatibility: true }),
    });
```

> **Core touch point.** `resolveTransitionTarget` currently accepts
> `actorContext?: ActorContext` and `directCliCompatibility?: boolean`, building
> `trustedRunControllerContext(active.id, 'direct-cli')` for the latter. Passing
> a fully-formed `actorContext` from the CLI is impossible here because the CLI
> does not know `active.id` until core resolves it. Therefore add one narrow
> option to core's `ResolveTransitionTargetOptions`:
> `readonly actorContextSource?: ActorContextSource;` and extract the
> context-construction (currently the inline expression at
> `command-target-resolver.ts:327-331`) into a small EXPORTED helper so it is
> unit-testable in isolation (this is what Step 1b's preferred driving test
> targets):
>
> ```typescript
> /**
>  * Build the actor context a default-target transition presents to policy.
>  *
>  * Provenance-only refinement of the direct-CLI compatibility lane: an explicit
>  * `actorContextSource` tags the trusted run controller; otherwise
>  * `directCliCompatibility` yields the `direct-cli` tag; neither yields unknown.
>  *
>  * @param activeId - Resolved default-target run id
>  * @param options - Source tag / compatibility / explicit-context flags
>  * @returns The actor context for the bare-advance policy check
>  */
> export function buildTransitionActorContext(
>   activeId: RunId,
>   options: {
>     readonly actorContext?: ActorContext;
>     readonly actorContextSource?: ActorContextSource;
>     readonly directCliCompatibility?: boolean;
>   },
> ): ActorContext {
>   if (options.actorContext) return options.actorContext;
>   if (options.actorContextSource) {
>     return trustedRunControllerContext(activeId, options.actorContextSource);
>   }
>   if (options.directCliCompatibility) {
>     return trustedRunControllerContext(activeId, 'direct-cli');
>   }
>   return UNKNOWN_ACTOR_CONTEXT;
> }
> ```
>
> Then replace the inline `const actorContext = ...` at lines 327-331 with
> `const actorContext = buildTransitionActorContext(active.id, options);`. This
> is a tag-only refinement of the *existing* compatibility mapping, not new
> policy: role derivation and the collection-pending guard are untouched, so the
> INVARIANT is preserved by construction. `command-target-resolver.ts` already
> imports `UNKNOWN_ACTOR_CONTEXT`, `trustedRunControllerContext`, and `RunId`
> (lines 1-9); the only new import this edit adds is `type ActorContextSource`
> (add it to the existing import block from `./actor-context.js`, alongside
> `ActorContext`).

- [ ] **Step 3b: Pin the resolver outcome is source-independent (core unit tests)**

Add to `packages/core/__tests__/runbook/command-target-resolver.test.ts` the
outcome-level pins (separate from Step 1b's source-propagation driver): the
source tag must not change the *outcome*, and the collection-pending refusal must
fire for any source. Use the file's existing `fakeReader({ ... })` factory (it
returns a `CommandTargetReader`); the pending-collection fixture mirrors the
`pendingParent` construction in the existing `'refuses a bare transition when a
delegated outcome is waiting for collection'` test.

```typescript
  it('tags the trusted controller with actorContextSource without changing the outcome', async () => {
    const resolved = await resolveTransitionTarget(
      fakeReader({ active: parent, openClaims: [] }),
      { command: 'pass', actorContextSource: 'plugin' },
    );
    // `parent` has no pending delegated outcome, so the resolution is the
    // default active-run target — the source tag must not alter that.
    expect(resolved.kind).toBe('default');
  });

  it('keeps the collection-pending refusal for any source', async () => {
    // Stage a pending delegated outcome exactly as the existing
    // collection-pending test does, then assert the refusal regardless of source.
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const pendingParent = {
      ...parent,
      step: '1',
      substep: '1',
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      frameEntryCounts: { [buildFrameKey('1')]: 1 },
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    } as RunbookState;
    const resolved = await resolveTransitionTarget(
      fakeReader({ active: pendingParent, openClaims: [] }),
      { command: 'pass', actorContextSource: 'mcp' },
    );
    expect(resolved.kind).toBe('delegation_collection_pending');
  });
```

The direct `buildTransitionActorContext` helper unit test (the source-propagation
DRIVER) is already written in Step 1b — do not duplicate it here. These two
outcome-level pins are additive: together with the Step 1b helper test they cover
construction (source tag present), outcome-neutrality (source does not change the
resolution), and the cross-source guard.

> Both pins reuse the file's existing `fakeReader({ ... })` factory (which
> returns a `CommandTargetReader` backed by `getActive`,
> `getActiveForClaimId`, `listOpenClaimsForParent`); there are no
> `makeReaderWith*` helpers in that file. The pending-collection fixture is a
> verbatim copy of the `pendingParent` setup in the existing `'refuses a bare
> transition when a delegated outcome is waiting for collection'` test, so the
> `buildCompletionKey` / `activeFrame` / `buildFrameKey` / `buildResolvedCompletion`
> imports it relies on are already present in the test file.

- [ ] **Step 4: Read the source in `transition-command.ts` and forward it**

In `packages/cli/src/helpers/transition-command.ts`:

Add the import:

```typescript
import { readActorSourceIngress } from './actor-source-option.js';
```

Commander passes the `Command` as the final action argument. Update the action
signature to capture it and read the source, then forward it to
`buildTransitionContext`:

Commander invokes the action callback with `(options, command)` for pass/fail
(no positional args). Capture `command`, then read+validate the source inside
`withErrorHandling`, rendering an invalid value through the `OutputEmitter` JSON
envelope (finding 3 — there is NO hook validation; each command validates):

```typescript
    .action(
      async (
        options: { step?: string; index?: string; claimId?: string; text?: boolean },
        command: Command,
      ) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: def.name });

            let actorSource;
            try {
              actorSource = readActorSourceIngress(command);
            } catch (error: unknown) {
              output.error(getErrorMessage(error), 'INVALID_ACTOR_SOURCE');
              output.flush();
              process.exitCode = 1;
              return;
            }
            // ... existing depError / cwd / claimTarget logic unchanged ...
            const contextResult = await buildTransitionContext(output, cwd, {
              command: def.name,
              claimId: claimTarget.claimId,
              step: options.step,
              ...(actorSource ? { actorSource } : {}),
            });
```

> `Command` is already imported in `transition-command.ts` (`import type {
> Command } from 'commander'`). Add `getErrorMessage` to its `@rundown-org/core`
> import (barrel-exported; already used by `wrapper.ts`). The read+validate runs
> inside `withErrorHandling` so an invalid source renders the standard
> `INVALID_ACTOR_SOURCE` JSON envelope instead of a raw Commander stderr line.
> There is NO program-level hook validation (Task 3 registers the flag
> capture-only); validation is per-command by design.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/pass.test.ts __tests__/commands/fail.test.ts`
Expected: PASS — pre-existing pass/fail tests, the symmetric cross-source guard
rows, and both `INVALID_ACTOR_SOURCE` envelope rows; `direct-cli` behavior
unchanged.

Run: `pnpm --filter @rundown-org/core exec jest __tests__/runbook/command-target-resolver.test.ts`
Expected: PASS — the `buildTransitionActorContext` driver, the outcome-level
tag-refinement, and the cross-source guard tests.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/helpers/transitions.ts \
        packages/cli/src/helpers/transition-command.ts \
        packages/core/src/runbook/command-target-resolver.ts \
        packages/core/__tests__/runbook/command-target-resolver.test.ts \
        packages/cli/__tests__/commands/pass.test.ts \
        packages/cli/__tests__/commands/fail.test.ts
git commit -m "feat(cli): tag pass/fail actor source via core compatibility lane"
```

---

## Task 7: Record construction-free status for `complete` / `stop` / `claim`

**Files:**
- Modify: `packages/cli/src/commands/complete.ts` (one-line rationale comment)
- Modify: `packages/cli/src/commands/stop.ts` (one-line rationale comment)
- Modify: `packages/cli/src/commands/claim.ts` (one-line rationale comment)

**Interfaces:**
- Consumes: nothing new at runtime.
- Produces: in-code documentation that these commands intentionally construct no
  `ActorContext` (they invoke no actor-context-gated core policy), so a future
  reader does not "complete" the migration by adding dead context.

> No behavior change and no new policy. This task exists so the frozen brief's
> command list (`complete`, `stop`, `claim`) is explicitly addressed: each is
> recorded as construction-free with a pointer to the shared helpers for any
> future actor-gated need. No test is added because there is no behavior to pin;
> the existing command tests continue to pass unchanged.

- [ ] **Step 1: Add the rationale comment to `complete.ts`**

In `packages/cli/src/commands/complete.ts`, immediately inside the `.action`
body (after `const output = ...`), add:

```typescript
          // Actor-context ingress (Plan: cli-actor-context-ingress): `complete`
          // is a workflow-level force-terminal override and the narrow
          // --claim-id force path; it invokes no actor-context-gated core policy
          // (no resolveCommandIntent / resolveTransitionTarget), so it
          // constructs no ActorContext. A future actor-gated force-terminal
          // policy would consume readActorSourceIngress + resolveActorContext.
```

- [ ] **Step 2: Add the rationale comment to `stop.ts`**

In `packages/cli/src/commands/stop.ts`, immediately inside the `.action` body
(after `const output = ...`), add the same rationale comment, replacing
`complete` with `stop`:

```typescript
          // Actor-context ingress (Plan: cli-actor-context-ingress): `stop` is a
          // workflow-level force-terminal override and the narrow --claim-id
          // force path; it invokes no actor-context-gated core policy, so it
          // constructs no ActorContext. A future actor-gated force-terminal
          // policy would consume readActorSourceIngress + resolveActorContext.
```

- [ ] **Step 3: Add the rationale comment to `claim.ts`**

In `packages/cli/src/commands/claim.ts`, immediately inside the `.action` body
(after `const output = ...`), add:

```typescript
            // Actor-context ingress (Plan: cli-actor-context-ingress): `claim`
            // launches a NEW child run (claimAndLaunch); it is not a
            // target-relative mutation against an existing run and invokes no
            // actor-context-gated core policy, so it constructs no ActorContext.
            // A future need would consume readActorSourceIngress +
            // resolveActorContext.
```

- [ ] **Step 4: Verify the three commands still pass their tests**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/complete.test.ts __tests__/commands/stop.test.ts __tests__/commands/claim.test.ts`
Expected: PASS (comment-only change; no behavior difference).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/complete.ts \
        packages/cli/src/commands/stop.ts \
        packages/cli/src/commands/claim.ts
git commit -m "docs(cli): record complete/stop/claim as actor-context construction-free"
```

---

## Task 8: Full-suite verification gate

**Files:** none (verification only).

- [ ] **Step 1: Lint and type-check the changed packages**

Run:
```bash
pnpm run check:lint:typed
```
Expected: PASS (no `any`, no unused imports left from removed inline
constructors, TSDoc present on new exports).

- [ ] **Step 2: Run the CLI and core unit suites**

Run:
```bash
pnpm --filter @rundown-org/cli test
pnpm --filter @rundown-org/core test
```
Expected: PASS.

- [ ] **Step 3: Run the full pre-PR verify gate**

Run:
```bash
pnpm run verify
```
Expected: PASS (format, spell, lint, test). Fix any spell-check additions for
new identifiers (e.g. add `RD_ACTOR_SOURCE` to the dictionary if the spell check
flags it) before declaring done.

- [ ] **Step 4: Commit any verify-driven fixes**

```bash
git add -A
git commit -m "chore(cli): verify gate fixes for actor-context ingress"
```

---

## Produces — interface block for Plans 6 & 7

Plans 6 (plugin) and 7 (MCP) **consume** exactly these, from this precursor.
List this precursor as a prerequisite.

```typescript
// packages/cli/src/helpers/resolve-actor-context.ts
export interface ActorIngress {
  readonly source?: ActorContextSource;        // from --actor-source / RD_ACTOR_SOURCE; defaults to 'direct-cli'
  readonly claimId?: ClaimId;                  // from --claim-id (existing plumbing)
  readonly tokenHash?: DelegationTokenHash;    // from existing claim-evidence plumbing
  readonly controlledRunId?: RunId;            // resolved claimed run id; defaults to state.id
}

export function resolveActorContext(ingress: ActorIngress, state: RunbookState): ActorContext;

export const ACTOR_SOURCE_VALUES: readonly ActorContextSource[];           // ['direct-cli','plugin','mcp']
export function parseActorSource(raw: string): ActorContextSource;         // throws InvalidActorSourceError
export class InvalidActorSourceError extends Error {
  readonly code: 'INVALID_ACTOR_SOURCE';
  readonly value: string;
}

// packages/cli/src/helpers/actor-source-option.ts
export interface ActorSourceReader { optsWithGlobals(): { actorSource?: string } }
export function readActorSourceIngress(
  command: ActorSourceReader,
  env?: NodeJS.ProcessEnv,
): ActorContextSource | undefined;             // flag wins over env; undefined when neither set
```

CLI surface produced (Plans 6/7 set these on the `rd` invocations they drive):

- Program-level flag: `--actor-source <direct-cli|plugin|mcp>`
- Env bridge: `RD_ACTOR_SOURCE=<direct-cli|plugin|mcp>` (flag wins; invalid value
  is a hard error with code `INVALID_ACTOR_SOURCE`, never a silent default)

**Plan 6 (plugin)** sets `RD_ACTOR_SOURCE=plugin` only in the environment of
plugin-helper-spawned `rd` calls through the plugin `rundown()` helper. Agent-run
Bash lifecycle commands are not routed through that helper and do not become
`source=plugin` by this plan. No policy logic lives in the plugin.

**Plan 7 (MCP)** prepends `--actor-source mcp` to the spawned CLI argv in
`buildRundownCommand`; it does not mutate the MCP server environment. MCP
threads `--claim-id` only for tools whose CLI command supports claim targeting
and otherwise relies on this precursor's trusted-controller provenance. No
policy logic lives in MCP. One-line note in that plan: the trusted-controller
mapping assumes stdio-local; revisit if a remote transport is ever wired.

---

## Self-Review

**1. Spec coverage** (frozen brief "Precursor PRODUCES" + scope bullets + the
7 external-review findings):

| Brief / finding requirement | Task |
| --- | --- |
| `resolve-actor-context.ts` exporting `ActorIngress` + `resolveActorContext` implementing the frozen table | Task 1 |
| `--actor-source` program option (capture-only) + `RD_ACTOR_SOURCE` env bridge; flag precedence; invalid = hard error rendered as JSON envelope | Tasks 2 (reader), 3 (capture-only registration), 4/5/6 (per-command validation) |
| Centralize `collect.ts` | Task 5 |
| Centralize `delegate.ts` — provenance source only (NO claim path; delegate has no `--claim-id`) [finding 1] | Task 4 |
| Wire source into `pass` AND `fail` symmetrically [finding 6] | Task 6 |
| Address `complete`/`stop`/`claim` (construction-free, recorded; WHY = no actor-context-gated core path) | Task 7 |
| INVARIANT: collection-pending guard refuses bare pass/fail/delegate for EVERY source | Task 4 (delegate rows, `setupAutoIssuedDelegation` fixture [finding 4]), Task 6 (pass AND fail rows + core unit) |
| Source-PROPAGATION driving test that fails before source is threaded [finding 5] | Task 4 (`buildDelegateActorIngress` unit test), Task 6 (`buildTransitionActorContext` unit test) — both pure exported helpers, no fragile module spy under `isolatedModules` |
| Invalid source renders `INVALID_ACTOR_SOURCE` JSON envelope via OutputEmitter, NOT a hook throw / stderr [findings 2+3] | Tasks 4, 5, 6 (per-command try/catch → `output.error`); Task 3 registers capture-only, no hook validation |
| Resolver can produce `unknown` (type-complete, no default path) | Task 1 (rows 5/5b) |
| Resolver precedence pin: claim WINS over a non-`direct-cli` source when claim evidence is present | Task 1 (row 4 plugin + MCP source rows) |
| CROSS-PLAN PIN (Plan 7): `--actor-source` parsed PRE-subcommand + advertised at program level | Task 3 (program-level token + `--help` pins) |
| No verification claims against superseded spec / absent docs [finding 7] | Architecture note states authority = live code + frozen brief; absent docs named as non-existent |
| TSDoc on new exports | Tasks 1, 2, 6 (`buildTransitionActorContext`) |
| JSON output contract unchanged | Only ADDS the `INVALID_ACTOR_SOURCE` error code via the standard `output.error` envelope; no existing envelope edited |
| No persisted-state migration | No persisted field touched in any task |

**2. Placeholder scan:** No "TBD"/"implement later"/"add error handling"/"write
tests for the above"/"similar to Task N" remain. Every code step shows complete
code, including the per-command validation try/catch (Tasks 4/5/6), the extracted
`buildTransitionActorContext` helper with full TSDoc (Task 6 Step 3), and the
spy/helper driving tests (Tasks 4/6). The Task 4 Step-1 verification grep was
removed; the delegate surface is now stated as fact (no `--claim-id`, source-tag
fix only — finding 1). The remaining "if X, model on Y" notes (Task 4 Step 6,
Task 6 Step 1b fallback) point at named existing fixtures, not hand-waving.

**3. Type consistency:** Names are stable across tasks: `ActorIngress`,
`resolveActorContext`, `ACTOR_SOURCE_VALUES`, `parseActorSource`,
`InvalidActorSourceError` (Task 1) are imported under those exact names in Tasks
4, 5, 6. `readActorSourceIngress` / `ActorSourceReader` (Task 2) are imported
under those names in Tasks 4, 5, 6. The core option is `actorContextSource` in
the CLI call (Task 6 Step 3) and the core resolver edit (Task 6 Step 3 + 3b), and
the extracted helper is `buildTransitionActorContext` in both its definition
(Step 3) and its unit test (Step 3b). `getErrorMessage` (barrel-exported from
core via `errors.ts`, already used in `wrapper.ts`) is the error-message
extractor in every per-command catch. `ingress.controlledRunId ?? state.id`
(Task 1 impl) matches the "defaults to state.id" claim in the Produces block and
the collect call site (Task 5). The resolver's claim branch keys on `claimId &&
tokenHash` (Task 1) and is fed `ctx.claim.claimId` / `ctx.claim.tokenHash`
(Task 5) — consistent with the `ClaimRecord` fields surfaced on the collect path
(`transitions.ts:171`). delegate threads NO claim evidence (it has no
`--claim-id`), so its `ActorIngress` is `{ source? }` only — consistent between
the File Structure note, the design note, and Task 4 Step 4.
