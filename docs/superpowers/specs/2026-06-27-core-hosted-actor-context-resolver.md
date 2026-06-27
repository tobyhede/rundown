# Core-Hosted Actor-Context Resolver

- **Date:** 2026-06-27
- **Status:** Proposed
- **Supersedes (partially):** the two-helper split introduced by
  `docs/superpowers/plans/2026-06-26-cli-actor-context-ingress.md` (Tasks 1, 5,
  6). This spec is prospective and write-once; it does not edit that plan. A
  follow-up plan consumes this spec.

## Problem statement

The CLI actor-context ingress plan claims to implement a "single frozen
trust-mapping table," but the table is realised in **two** functions in **two**
packages with **deliberately divergent defaults**: a CLI
`resolveActorContext(ingress, state)` (claim path + `direct-cli` default;
consumed by `collect`/`delegate`, which pre-resolve their target in the CLI) and
a core `buildTransitionActorContext(activeId, options)` (no claim path,
`unknown` default; consumed by `pass`/`fail`, whose target is resolved inside
core's `resolveTransitionTarget`). Neither leaks policy — both only call the core
constructors `trustedRunControllerContext` / `claimControllerContext` /
`UNKNOWN_ACTOR_CONTEXT` — but the evidence→`ActorContext` mapping must now be
changed in lockstep across a package boundary. Any future row added to the table
(a new source, a new claim shape) must be edited twice and kept consistent by
convention. This spec designs the unified, **core-hosted** mapping: one function
in `@rundown-org/core` that both the pre-resolved-target callers
(`collect`/`delegate`) and the core-resolves-target callers (`pass`/`fail`)
funnel through.

This is consistent with CLAUDE.md's architectural principles. The
evidence→`ActorContext` mapping is part of the runbook program's authorization
model (it produces the typed evidence that core's `resolveCommandIntent` /
`deriveEffectiveRole` consume), so it belongs in core. The CLI's job — reading a
flag and an env var and rendering an error envelope — is Category A (genuinely
external/CLI: env-var reads, flag reads, stdout rendering) and stays in the CLI.

---

## 1. Current state (as the plan stands)

### 1.1 The shared domain types (core, already exist)

`packages/core/src/runbook/actor-context.ts` is the single source of truth for
the union and constructors. Verified shapes:

```typescript
// actor-context.ts:6
export type ActorContextSource = 'direct-cli' | 'plugin' | 'mcp';

// actor-context.ts:9-31
export type ActorContext =
  | { readonly kind: 'trusted_run_controller'; readonly runId: RunId; readonly source: ActorContextSource }
  | { readonly kind: 'claim_controller'; readonly claimId: ClaimId; readonly tokenHash: DelegationTokenHash; readonly controlledRunId: RunId }
  | { readonly kind: 'unknown' };

// actor-context.ts:48
export const UNKNOWN_ACTOR_CONTEXT: ActorContext = { kind: 'unknown' };

// actor-context.ts:57-62
export function trustedRunControllerContext(runId: RunId, source: ActorContextSource): ActorContext;

// actor-context.ts:73-84
export function claimControllerContext(input: {
  readonly claimId: ClaimId;
  readonly tokenHash: DelegationTokenHash;
  readonly controlledRunId: RunId;
}): ActorContext;
```

Note `claim_controller` has **no `source` field** — a claim controller is
identified by `claimId`/`tokenHash`/`controlledRunId`, never by a provenance
tag. The evidence a CLI claim caller holds is the `ClaimRecord`
(`packages/core/src/runbook/claim-id.ts:19-27`): `claimId`, `childRunId`,
`tokenHash` — **not** `controlledRunId` (the resolver derives that from the
resolved target id).

### 1.2 Helper A — CLI `resolveActorContext` (planned)

`docs/.../2026-06-26-cli-actor-context-ingress.md` Task 1 creates
`packages/cli/src/helpers/resolve-actor-context.ts` exporting
`resolveActorContext(ingress: ActorIngress, state: RunbookState): ActorContext`.
Its table (plan lines 476-495):

- `claimId && tokenHash` present → `claimControllerContext({ claimId, tokenHash, controlledRunId: ingress.controlledRunId ?? state.id })`.
- exactly one of `claimId`/`tokenHash` → `UNKNOWN_ACTOR_CONTEXT`.
- otherwise → `trustedRunControllerContext(state.id, ingress.source ?? 'direct-cli')`.

The **default is `direct-cli`.** It is consumed by `collect`
(`packages/cli/src/commands/collect.ts:428-434`, currently inline
`ctx.claim ? claimControllerContext(...) : trustedRunControllerContext(state.id, 'direct-cli')`)
and by `delegate` (`packages/cli/src/commands/delegate.ts:132-133`, currently
inline `trustedRunControllerContext(state.id, 'direct-cli')`). Both commands
**pre-resolve their `RunbookState`** in the CLI, so they hold a target and can
call a `(ingress, state)` mapping directly.

### 1.3 Helper B — core `buildTransitionActorContext` (planned)

Task 6 extracts a helper from the inline expression already present at
`packages/core/src/runbook/command-target-resolver.ts:327-331`:

```typescript
const actorContext =
  options.actorContext ??
  (options.directCliCompatibility
    ? trustedRunControllerContext(active.id, 'direct-cli')
    : UNKNOWN_ACTOR_CONTEXT);
```

into an exported `buildTransitionActorContext(activeId, { actorContext?, actorContextSource?, directCliCompatibility? })`.
Its table:

- explicit `actorContext` → passthrough.
- `actorContextSource` → `trustedRunControllerContext(activeId, source)`.
- `directCliCompatibility` → `trustedRunControllerContext(activeId, 'direct-cli')`.
- otherwise → `UNKNOWN_ACTOR_CONTEXT`.

There is **no claim path** (pass/fail's claim targeting is handled earlier in
`resolveTransitionTarget`, lines 281-316, before the bare-advance branch that
needs an actor context). The **default is `unknown`.** It is reached only from
inside `resolveTransitionTarget` (`command-target-resolver.ts`,
`ResolveTransitionTargetOptions`, lines 117-141), because `pass`/`fail` do
**not** pre-resolve their target in the CLI — core resolves `active.id` at one
choke point and constructs the context there. The CLI only supplies the `source`
tag, threaded down via the new `actorContextSource?` option.

### 1.4 The drift

The two helpers encode the **same evidence→context table** with two
intentional differences:

| Axis | CLI `resolveActorContext` | core `buildTransitionActorContext` |
| --- | --- | --- |
| Claim path | yes (`claimId && tokenHash`) | no |
| Trusted-controller source | `ingress.source ?? 'direct-cli'` | `actorContextSource` / `'direct-cli'` via `directCliCompatibility` |
| No-evidence default | `direct-cli` (trusted) | `unknown` (strict) |
| Target known at call time | yes (pre-resolved `state`) | no (core resolves `active.id`) |

A change to the source→trust mapping — e.g. "a fourth source `remote` must map
to `unknown` unless a claim is present" — would have to be made in both files,
kept consistent across a package boundary, and re-tested in two suites. That is
exactly the duplication this spec removes.

---

## 2. Proposed design

### 2.1 One table, in core

Host the evidence→`ActorContext` mapping as a single public function in core,
co-located with the union and constructors it produces. The two caller classes
funnel through it; nobody else implements the table.

**New, in `packages/core/src/runbook/actor-context.ts`** (re-exported from
`packages/core/src/runbook/index.ts`, the barrel that already exports
`trustedRunControllerContext` / `claimControllerContext` /
`UNKNOWN_ACTOR_CONTEXT` / `ActorContextSource`):

```typescript
/**
 * Caller evidence assembled before core maps it to an {@link ActorContext}.
 *
 * All fields optional. Evidence only — no provenance policy, no defaults:
 * an absent `source` maps to `unknown`, never to a trusted controller. The
 * "a bare local CLI call is direct-cli" default is a front-end concern and is
 * applied by the CLI ingress reader, not by this type (see § 2.3).
 */
export interface ActorIngress {
  /** Provenance tag (`--actor-source` / `RD_ACTOR_SOURCE` / integration argv). */
  readonly source?: ActorContextSource;
  /** Claim id when acting on a claimed delegated run. */
  readonly claimId?: ClaimId;
  /** Token hash bound to the claim (from the resolved `ClaimRecord`). */
  readonly tokenHash?: DelegationTokenHash;
  /** Controlled run id; defaults to the resolved target id when omitted. */
  readonly controlledRunId?: RunId;
}

/**
 * Map caller ingress + a resolved target run id to an {@link ActorContext}.
 *
 * The single source of truth for the evidence→context table:
 * - `claimId` AND `tokenHash` present  → `claim_controller` (source ignored;
 *   `controlledRunId` defaults to `targetRunId`).
 * - exactly one of `claimId`/`tokenHash` → `unknown` (contradictory evidence).
 * - a `source` present, no claim         → `trusted_run_controller(targetRunId, source)`.
 * - no source, no claim                  → `unknown` (strict default).
 *
 * Role derivation against the target stays in `deriveEffectiveRole`; this
 * function only records typed evidence.
 *
 * @param ingress - Caller evidence
 * @param targetRunId - Resolved run the caller is acting on
 * @returns The constructed actor context
 */
export function resolveActorContext(ingress: ActorIngress, targetRunId: RunId): ActorContext;
```

Two deliberate refinements over the plan's CLI version:

1. **Second argument is `RunId`, not `RunbookState`.** The mapping reads only
   `.id`; the plan's CLI version takes the whole `RunbookState` and stubs it in
   tests as `{ id } as unknown as RunbookState`. Narrowing the input removes the
   stub and matches the call shape on both sides (`collect`/`delegate` pass
   `state.id`; `resolveTransitionTarget` passes `active.id`).
2. **No-evidence default is `unknown`,** matching the strict-core semantics that
   `pass`/`fail` already depend on. The `direct-cli` compatibility default is
   relocated to the CLI ingress boundary (§ 2.3), where it actually belongs.

This makes the `unknown` context **reachable by type but never a CLI default**
(the Global Constraint "`unknown` is reachable by type, not by default" from the
source plan): `resolveActorContext({}, id)` returns `unknown`, but no CLI path
produces an empty ingress (§ 2.3).

### 2.2 `resolveTransitionTarget` calls the shared function

`buildTransitionActorContext` is **deleted from the plan.** Instead,
`command-target-resolver.ts` calls the shared core function at its existing
choke point. The inline expression at lines 327-331 becomes:

```typescript
const actorContext = resolveActorContext(
  { source: options.actorContextSource },
  active.id,
);
```

`ResolveTransitionTargetOptions` (lines 117-141) gains:

```typescript
/** Provenance source for the resolved default target; absent → unknown (strict). */
readonly actorContextSource?: ActorContextSource;
```

and **drops `directCliCompatibility`** (see § 2.4 — it is redundant once a
source tag is the only axis). The `actorContext?: ActorContext` passthrough may
remain for strict adapters that already hold a fully-formed context, but the
default construction now routes through `resolveActorContext`.

### 2.3 The CLI keeps only ingress reading (Category A)

The CLI no longer constructs `ActorContext` and no longer owns any part of the
table. It retains, in `packages/cli/src/helpers/`:

- **`ACTOR_SOURCE_VALUES` / `parseActorSource` / `InvalidActorSourceError`** —
  validation of an `--actor-source` / `RD_ACTOR_SOURCE` **string token** against
  the source vocabulary. This is Category A ingress validation: it answers "is
  this flag/env string a syntactically valid source?", not "what trust does it
  confer?". It produces a typed `ActorContextSource` or throws; it never builds
  an `ActorContext`. (The valid-value tuple is kept exhaustive against core's
  `ActorContextSource` by the plan's existing compile-time
  `Record<ActorContextSource, true>` guard — see § 8 for the one residual
  coupling.)
- **`readActorSourceIngress(command, env?)`** — reads `--actor-source` (via
  `optsWithGlobals()`) and `RD_ACTOR_SOURCE`, applies flag-over-env precedence,
  and **applies the front-end default**: every `rd` invocation is a direct local
  CLI front end unless tagged otherwise, so this returns a **concrete
  `ActorContextSource`, defaulting to `'direct-cli'`**:

  ```typescript
  export function readActorSourceIngress(
    command: ActorSourceReader,
    env: NodeJS.ProcessEnv = process.env,
  ): ActorContextSource; // never undefined; '' env treated as unset → 'direct-cli'
  ```

  This is the **one** site that owns the `direct-cli` default. It replaces the
  plan's `... | undefined` reader (which deferred the default into the CLI
  table). Strict domain callers (MCP-strict adapters, core tests) never call
  `readActorSourceIngress`; they pass no `source` to `resolveActorContext` and
  get `unknown`.
- Catching `InvalidActorSourceError` and rendering the `INVALID_ACTOR_SOURCE`
  JSON envelope via `OutputEmitter` inside each command's `withErrorHandling`
  block (unchanged from the plan; still per-command, never a Commander hook).

### 2.4 Default ownership — the resolved trade-off

The two defaults (`direct-cli` vs `unknown`) are **unified in mechanism but kept
distinct in ownership**, and they must stay distinct:

- **`unknown` is owned by the core table.** It is the strict-core meaning of "no
  trusted evidence." `resolveActorContext` returns it intrinsically when ingress
  carries neither a source nor a complete claim.
- **`direct-cli` is owned by the CLI ingress reader.** It is the front-end
  meaning of "a bare local `rd` call is a trusted direct-CLI controller." It is
  applied once, in `readActorSourceIngress`.

They are the **same axis** — "what `source`, if any, is in the ingress" — so the
two helpers collapse into one table. But they are **not collapsible into a
single default value**, because:

- If the **table** defaulted to `direct-cli`, every strict caller of
  `resolveTransitionTarget` (core adapters, a future MCP-strict mode) that
  passes no source would be silently promoted to a trusted controller —
  destroying the strict-core `unknown` guarantee that the existing
  `actor_context_required` refusal (`command-target-resolver.ts:351-352`)
  depends on.
- If the **reader** returned `undefined` and the table defaulted to `unknown`, a
  bare local `rd collect` / `rd pass` would resolve to `unknown` and be refused
  — a behaviour regression from today's `direct-cli` compatibility lane.

So the separation is load-bearing, not stylistic. Locating each default at its
correct owner is what lets a single table serve both a trusting front end and a
strict core.

A direct consequence: **`directCliCompatibility: boolean` is retired.**
`directCliCompatibility: true` is exactly `actorContextSource: 'direct-cli'`;
once the source tag is the only axis, the boolean is a second way to say the
same thing and is removed from `ResolveTransitionTargetOptions`. Reducing the
option surface is a concrete win the unification unlocks.

### 2.5 Flow per caller class (the single funnel)

**`collect`** (pre-resolved target; `packages/cli/src/commands/collect.ts`):

1. Inside `withErrorHandling`: `source = readActorSourceIngress(command)` →
   concrete `ActorContextSource` (renders `INVALID_ACTOR_SOURCE` on a bad token).
2. Build ingress from the already-resolved `ctx.claim` (a `ClaimRecord`) and
   `state`:
   `{ source, ...(ctx.claim ? { claimId: ctx.claim.claimId, tokenHash: ctx.claim.tokenHash } : {}) }`.
3. `const actorContext = resolveActorContext(ingress, state.id);` (core).
4. `collectionService.collectDelegationOutcomes({ actorContext, ... })`.

**`delegate`** (pre-resolved target; no `--claim-id` option, so no claim
evidence; `packages/cli/src/commands/delegate.ts`):

1. `source = readActorSourceIngress(command)`.
2. `const actorContext = resolveActorContext({ source }, state.id);`.
3. `resolveCommandIntent({ actorContext, ... })` (unchanged downstream).

**`pass` / `fail`** (core-resolved target;
`packages/cli/src/helpers/transition-command.ts` → `transitions.ts` → core):

1. CLI `transition-command.ts`: `source = readActorSourceIngress(command)`.
2. CLI `transitions.ts#buildTransitionContext` forwards it as
   `resolveTransitionTarget(sessionService, { command, claimId, targeted, actorContextSource: source })`.
   The CLI never constructs an `ActorContext` (it still does not know
   `active.id`).
3. Core `resolveTransitionTarget` resolves `active.id`, then calls the **same**
   `resolveActorContext({ source: options.actorContextSource }, active.id)` at
   its existing choke point. For a bare local CLI pass, `source` is `'direct-cli'`
   (defaulted by the reader), so behaviour is byte-identical to today.

All three classes now call exactly one function for the table:
`resolveActorContext`. The `collect`/`delegate` class calls it **directly**
(they hold the target); the `pass`/`fail` class calls it **transitively through
`resolveTransitionTarget`** (core holds the target). No shadow target resolution
is introduced in the CLI — that would violate "the CLI is a thin wrapper."

In the actor-input-wiring vocabulary
(`docs/internal/architecture.md § Actor input wiring`), the `source` tag is an
**event-time-bound** value (it varies per invocation and is read at call time
from the CLI ingress), threaded as an explicit argument rather than persisted —
consistent with "persisted context contains only data; runtime references flow
through invoke-input closures." `ActorContext` itself is runtime-only and is
never serialised into snapshots (the no-persisted-state constraint holds
unchanged).

---

## 3. What the CLI retains vs. surrenders

| Concern | Category | Owner after this spec |
| --- | --- | --- |
| Read `--actor-source` flag | A (flag read) | CLI `readActorSourceIngress` |
| Read `RD_ACTOR_SOURCE` env | A (env read) | CLI `readActorSourceIngress` |
| Flag-over-env precedence | A | CLI `readActorSourceIngress` |
| `direct-cli` front-end default | A (front-end policy) | CLI `readActorSourceIngress` |
| Validate the string token | A (ingress validation) | CLI `parseActorSource` |
| Render `INVALID_ACTOR_SOURCE` envelope | A (stdout render) | CLI command `withErrorHandling` |
| Source vocabulary (`ActorContextSource`) | domain | core (exists) |
| Evidence→`ActorContext` table | domain | **core `resolveActorContext` (new)** |
| `direct-cli` vs `unknown` no-evidence default | domain (`unknown`) / front-end (`direct-cli`) | core / CLI (split, § 2.4) |
| Claim-vs-trusted decision | domain | **core `resolveActorContext` (new)** |
| Target resolution + choke-point construction | domain | core `resolveTransitionTarget` (exists) |

The CLI explicitly **constructs no `ActorContext`** after this spec. It reads,
validates, defaults, and renders — all Category A — and hands a typed
`ActorContextSource` (plus, for `collect`, the already-in-hand `ClaimRecord`
fields) to core. This removes the "frontend adapter is allowed to construct
`ActorContext`" carve-out the source plan introduced (plan lines 12-17, 46-49):
construction returns to core, and the CLI is a pure ingress reader again — a
tighter fit to "the CLI is a thin wrapper."

---

## 4. Migration delta from the current plan

The follow-up plan that implements this spec changes the source plan as follows.

| Plan task | Change |
| --- | --- |
| **Task 1** (CLI `resolve-actor-context.ts`) | Split. `resolveActorContext` + `ActorIngress` **move to core** `actor-context.ts` (second arg becomes `RunId`; no-evidence default becomes `unknown`). `ACTOR_SOURCE_VALUES` / `parseActorSource` / `InvalidActorSourceError` **stay in the CLI** `actor-source-option.ts` (string-token validation only). The CLI table test is deleted; the table test moves to core (§ 7). |
| **Task 2** (`readActorSourceIngress`) | Return type changes from `ActorContextSource \| undefined` to **`ActorContextSource`** (defaults to `'direct-cli'`). This single site now owns the front-end default. Tests update: "neither flag nor env set → `'direct-cli'`" (was `undefined`). |
| **Task 3** (register flag + `INVALID_ACTOR_SOURCE` code) | Unchanged. Still capture-only flag; still per-command validation. |
| **Task 4** (`delegate`) | Imports `resolveActorContext` + `ActorIngress` **from `@rundown-org/core`** instead of a CLI helper. Calls `resolveActorContext({ source }, state.id)`. `buildDelegateActorIngress` becomes a trivial one-liner or is dropped (the source-propagation driver moves to the core table test). |
| **Task 5** (`collect`) | Imports `resolveActorContext` **from core**; calls it with `state.id`. Drops `claimControllerContext` / `trustedRunControllerContext` imports from `collect.ts` (the table no longer lives there). |
| **Task 6** (`pass`/`fail`) | `buildTransitionActorContext` is **not** created. `command-target-resolver.ts` calls `resolveActorContext({ source: options.actorContextSource }, active.id)` at lines 327-331. `ResolveTransitionTargetOptions` gains `actorContextSource?` and **drops `directCliCompatibility`**. CLI `transitions.ts` forwards `actorContextSource` (never `directCliCompatibility`). |
| **Task 7** (`complete`/`stop`/`claim` comments) | Unchanged. |
| **Produces block / Plans 6 & 7** | The consumed symbols change package: Plans 6/7 import `resolveActorContext` / `ActorIngress` from `@rundown-org/core`, not from `packages/cli/src/helpers/`. The CLI-surface contract (`--actor-source` / `RD_ACTOR_SOURCE`, hard error on invalid) is unchanged. |

Constraints that **still hold** unchanged: no persisted-state migration
(`ActorContext` stays runtime-only); type-driven dispatch (the table narrows on a
discriminated union, never raw string `if` ladders outside `parseActorSource`);
no silent mapping (an invalid source is still a hard `INVALID_ACTOR_SOURCE`
error); the INVARIANT (the collection-pending guard refuses bare
`pass`/`fail`/`delegate` for every source — it is source-independent in core and
untouched here); JSON output contract unchanged.

---

## 5. Trade-offs & alternatives

### Alternative (a) — keep the CLI table, do nothing

Rejected. It is the status quo the review flagged: a future table change must be
made twice across a package boundary and kept consistent by convention. It also
keeps the "CLI may construct `ActorContext`" carve-out, which is the only place
the CLI owns authorization-evidence construction.

### Alternative (b) — keep the split, add a cross-helper consistency test

**Considered; deferred, not adopted.** The review's option (b) keeps both
helpers and adds a test that drives the same evidence vectors through CLI
`resolveActorContext` and core `buildTransitionActorContext` and asserts equal
output. This is cheaper (no code moves) and pins the drift. But:

- It pins **consistency**, not **single-sourcing.** Two implementations remain;
  the test only fails *after* they diverge. A new row still has to be written
  twice, and the test must be remembered and extended for it.
- The two helpers have genuinely different shapes (claim path vs none;
  `direct-cli` vs `unknown` default), so the consistency test must special-case
  those differences — encoding the very divergence it is meant to police, and
  becoming load-bearing documentation of "these are allowed to differ here but
  not there."
- It does not remove the CLI's construction carve-out.

It is a reasonable **stopgap** if the core-hosting move cannot be scheduled
immediately (e.g. to ship the source plan first, then refactor). That is why it
is *deferred* rather than *rejected*: a follow-up plan may land (b) as an interim
guard and this spec's design as the durable fix.

### Where core-hosting is arguably *worse* (intellectual honesty)

Two honest costs:

1. **The bare-CLI end-to-end assertion splits across two layers.** Today the CLI
   `resolveActorContext` lets one unit test assert "bare ingress →
   `trusted_run_controller(direct-cli)`." After this spec, that single
   assertion decomposes: the **core** table test asserts "no source →
   `unknown`," and the **CLI** reader test asserts "no flag/env → `'direct-cli'`."
   The composed truth ("bare `rd collect` → trusted direct-cli") is now verified
   by two tests in two packages rather than one. This is a real diffusion. It is
   acceptable because each layer's test is *simpler* and tests *one* thing
   (table vs default-ownership), and an integration test per command still pins
   the composed behaviour — but it is more moving parts than the monolithic CLI
   helper.

2. **`pass`/`fail` gain nothing from the move.** Their construction was already
   in core; for them, core-hosting only swaps one core helper
   (`buildTransitionActorContext`) for another (`resolveActorContext`). The
   payoff is entirely on the `collect`/`delegate` side (and in deleting the
   duplicate table). If `collect`/`delegate` did not exist, this refactor would
   be net-neutral churn. They do exist, so the move pays — but the benefit is
   asymmetric, and a reviewer should weigh it as "is removing one duplicated
   table worth touching four files and a public core export?" The answer here is
   yes (a duplicated authorization table is exactly the kind of shadow logic
   CLAUDE.md forbids), but it is not free.

Neither cost is disqualifying; both are recorded so the follow-up plan does not
discover them mid-implementation.

---

## 6. Sequence summary

```
collect / delegate (target already resolved in CLI)
  readActorSourceIngress(command)  ->  ActorContextSource (default 'direct-cli')   [CLI, Cat A]
  resolveActorContext({ source, ...claimFields }, state.id)  ->  ActorContext      [CORE table]
  resolveCommandIntent / collectDelegationOutcomes({ actorContext })               [CORE policy]

pass / fail (target resolved inside core)
  readActorSourceIngress(command)  ->  ActorContextSource (default 'direct-cli')   [CLI, Cat A]
  buildTransitionContext(..., { actorSource })                                     [CLI thin forward]
  resolveTransitionTarget(reader, { command, actorContextSource })                 [CORE]
    -> resolves active.id
    -> resolveActorContext({ source: actorContextSource }, active.id) -> ActorContext  [CORE table]
    -> resolveCommandIntent({ actorContext })                                       [CORE policy]
```

One table (`resolveActorContext`), two entry paths (direct for pre-resolved
targets, transitive for core-resolved targets).

---

## 7. Test strategy

The point of the move is **exactly one place to test the table.**

**Core unit table** (`packages/core/__tests__/runbook/actor-context.test.ts` or
a sibling `actor-context-resolver.test.ts`) — the *only* table test:

| Ingress | `targetRunId` | Expected |
| --- | --- | --- |
| `{}` | `r` | `{ kind: 'unknown' }` |
| `{ source: 'direct-cli' }` | `r` | `trusted_run_controller(r, 'direct-cli')` |
| `{ source: 'plugin' }` | `r` | `trusted_run_controller(r, 'plugin')` |
| `{ source: 'mcp' }` | `r` | `trusted_run_controller(r, 'mcp')` |
| `{ claimId, tokenHash }` | `r` | `claim_controller(claimId, tokenHash, controlledRunId=r)` |
| `{ claimId, tokenHash, controlledRunId: c }` | `r` | `claim_controller(..., controlledRunId=c)` |
| `{ source: 'plugin', claimId, tokenHash }` | `r` | `claim_controller(...)` (claim wins; **no `source`**) |
| `{ claimId }` (no tokenHash) | `r` | `{ kind: 'unknown' }` |
| `{ tokenHash }` (no claimId) | `r` | `{ kind: 'unknown' }` |

**Core property tests** (fast-check), the invariants the review recommended,
pinned in one place:

1. **Total / well-typed:** for any `ActorIngress` and `RunId`,
   `resolveActorContext(i, r).kind ∈ { 'trusted_run_controller', 'claim_controller', 'unknown' }`.
2. **Claim iff complete claim evidence:** `result.kind === 'claim_controller'`
   ⟺ `i.claimId !== undefined && i.tokenHash !== undefined`.
3. **Source never on a claim controller:** `result.kind === 'claim_controller'`
   ⟹ `!('source' in result)` (claim wins over any source tag, and carries none).
4. **Default behaviour:** when no claim evidence,
   `result.kind === (i.source !== undefined ? 'trusted_run_controller' : 'unknown')`,
   and on the trusted branch `result.source === i.source` and `result.runId === r`.
5. **`controlledRunId` default:** on the claim branch,
   `result.controlledRunId === (i.controlledRunId ?? r)`.

**Core resolver pins** (`command-target-resolver.test.ts`): unchanged in intent
— `actorContextSource: 'plugin'` yields `source: 'plugin'` in the constructed
context without changing the resolution `kind`; the collection-pending refusal
fires for any source. These now assert *through* `resolveActorContext` (no
`buildTransitionActorContext`), and additionally pin that
`actorContextSource` absent → `unknown` (the strict default that replaced
`directCliCompatibility`).

**CLI tests** (`actor-source-option.test.ts`, command tests) — **no table
test:** only `readActorSourceIngress` precedence/validation (flag wins over env;
empty env treated as unset; **neither set → `'direct-cli'`**; invalid →
`InvalidActorSourceError`), and per-command `INVALID_ACTOR_SOURCE` envelope
rendering + the cross-source collection-pending INVARIANT (unchanged from the
plan). The CLI never re-tests the evidence→context mapping.

---

## 8. Open questions / risks

1. **Residual vocabulary coupling.** `ACTOR_SOURCE_VALUES` (the runtime tuple
   the CLI validates against) stays in the CLI while `ActorContextSource` (the
   type) stays in core. This is a *narrow* coupling — a list of three strings,
   guarded exhaustive against the union by a compile-time
   `Record<ActorContextSource, true>` check — and it is genuinely CLI ingress
   validation (Category A). **Option:** host `ACTOR_SOURCE_VALUES` +
   `parseActorSource` in core too (next to `ActorContextSource`), leaving the
   CLI only the flag/env read and envelope render. That would make core the
   single source of *both* the vocabulary and the table, at the cost of putting
   a string-validation helper (arguably Category A) in core. Recommend deciding
   this in the follow-up plan; the spec's mapping move is correct either way.
2. **`actorContext?` passthrough on `ResolveTransitionTargetOptions`.** Once
   construction routes through `resolveActorContext`, is the explicit
   `actorContext?` passthrough still needed, or do all strict callers now supply
   a `source` instead? If no caller passes a pre-built `actorContext`, drop it
   for a smaller surface; if MCP-strict or a core adapter still needs to inject a
   `claim_controller` directly, keep it. Resolve by auditing callers in the
   follow-up plan.
3. **Public core export surface.** `resolveActorContext` + `ActorIngress` become
   public core exports consumed by the CLI, MCP, and plugin. This widens core's
   committed API. Acceptable (it is the intended single seam), but the follow-up
   plan should add the TSDoc and treat it as a stable export, not an internal
   helper.
4. **Source-propagation driving test relocation.** The plan's TDD drivers
   (`buildDelegateActorIngress`, `buildTransitionActorContext` unit tests) were
   designed to fail before the source was threaded. With the table in core, the
   genuine driver becomes the core table test (rows asserting `source: 'plugin'`
   propagates). The follow-up plan must ensure a test still *fails before* the
   `actorContextSource` option exists on `resolveTransitionTarget`, so the
   pass/fail wiring stays test-driven rather than asserted after the fact.
