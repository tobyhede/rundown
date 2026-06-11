# Design Note: Removing the `buildEvent` type assertion in the event emitter

> Status: **Draft proposal** (not yet scheduled). Authored from an investigation +
> empirical compile-verification of each candidate against the repo's `strict`
> config on 2026-06-11.
> Audience: contributors to `packages/core/src/events` and the CLI/JSON event
> subscribers that consume `RunbookEventV1`.

## 1. Summary

`RunbookEventEmitter.buildEvent` (`packages/core/src/events/emitter.ts:91-120`)
constructs each lifecycle event with an **unsafe type assertion**:

```typescript
return {
  v: '1', type, ts: new Date().toISOString(),
  runbookId: this.runbookId, runbook: this.runbook, seq: this.seq, payload,
} as Extract<RunbookEventV1, { type: T }>;
```

The assertion bypasses static checking of the `type`/`payload` correlation. To
compensate, a runtime guard `validatePayload` (`emitter.ts:130-158`) runs behind a
`if (process.env.NODE_ENV !== 'production')` gate (`emitter.ts:107`) — a dev-only
band-aid for the hole the assertion opens.

This note documents **why the hole exists**, the **constraints any fix must
satisfy**, and the **trade-offs of four candidate designs**. The recommended
design (Candidate D) removes the assertion entirely and lets `validatePayload`
and its `NODE_ENV` gate be deleted.

## 2. Root cause — why TypeScript cannot verify it today

`RunbookEventV1` (`types.ts:201-210`) is a discriminated union whose members are
`EventEnvelope & { type: 'X'; payload: XPayload }`. `PayloadFor<T>`
(`types.ts:215-218`) is `Extract<RunbookEventV1, { type: T }>['payload']`.

Inside `buildEvent<T extends RunbookEventV1['type']>`, the object literal is built
from **two independent generic expressions** — `type: T` and `payload: PayloadFor<T>`.
TypeScript types the literal as `{ …; type: T; payload: PayloadFor<T> }` but will
not prove this is assignable to `Extract<RunbookEventV1, { type: T }>` while `T` is
an unresolved type parameter: it does not distribute the union member-by-member
over an open type variable and re-correlate `type` with `payload`. This is
[microsoft/TypeScript#14094](https://github.com/microsoft/TypeScript/issues/14094).

The hole is real, not gratuitous: removing the `as` and returning `RunbookEventV1`
directly produces `TS2322` (`'RUNBOOK_STARTED' is not assignable to 'ERROR_OCCURRED'…`).
Given the *current* two-argument signature shape, some assertion is unavoidable.

## 3. Constraints any fix must satisfy

A redesign is only valid if it preserves all of the following:

1. **Two call-site classes must keep type-checking.**
   - **Concrete-literal sites (25):** `emit('TYPE', { …payload })` throughout
     `packages/cli/src/services/execution.ts` and elsewhere. These must keep
     precise per-type payload checking.
   - **Union-source sites (2):** `emitter.emit(effect.event.type, effect.event.payload)`
     at `execution.ts:1205` and `:1302`, where `effect.event` is the already-correlated
     union `ExecutionObservationEvent` (`execution-observation.ts:24-28`). A fix that
     only handles concrete literals but rejects a union argument is a regression.

2. **The public event contract must not change.** `RunbookEventV1` and the
   `EventSubscriber` callback shape (`subscriber: (event: RunbookEventV1) => void`)
   are consumed by `subscribers/cli.ts`, `subscribers/json.ts`, and the output layer
   (`output/types.ts:205-209`). Only the *input* side of `emit`/`buildEvent` is in
   scope to change.

3. **No new runtime cost on the emit hot path.** Events fire on every step
   transition and command start/complete; a fix must not add per-event work.

4. **Single source of truth for the event taxonomy.** Any new input type should be
   *derived from* `RunbookEventV1`, not hand-maintained in parallel (a second list
   drifts — the same failure mode that already weakened `validatePayload`; see §6).

## 4. Candidate designs and trade-offs

All four were compiled against the repo's `strict` config. Verdicts are empirical.

### Candidate A — Generic interface envelope (`RunbookEvent<T>`)

```typescript
interface RunbookEvent<T extends RunbookEventV1['type']> extends EventEnvelope {
  readonly type: T;
  readonly payload: PayloadFor<T>;
}
function buildEvent<T extends RunbookEventV1['type']>(
  type: T, payload: PayloadFor<T>,
): RunbookEvent<T> {
  return { v: '1', type, ts, runbookId, runbook, seq, payload }; // no assertion
}
```

- **What it fixes:** the `buildEvent` body compiles assertion-free.
- **Constraint it breaks:** **relocates the hole, doesn't remove it.** `emit` must
  hand the result to a `(event: RunbookEventV1) => void` subscriber. When `T` is
  instantiated as the *union* (the `execution.ts:1205` site), `RunbookEvent<'A'|'B'|'C'>`
  is a single object with a **decorrelated** union `type`/`payload` and is **not**
  assignable to `RunbookEventV1` (`TS2345`). You need an assertion again at the
  `subscriber(event)` boundary, or you must forbid union-typed `T`.
- **Verdict:** ❌ contains/relocates the hole. Violates constraint 1 (union sites).

### Candidate B — Builder record (`Record<EventType, builder>`)

```typescript
const builders: {
  [K in RunbookEventV1['type']]: (p: PayloadFor<K>) => Extract<RunbookEventV1, { type: K }>;
} = {
  RUNBOOK_STARTED: (payload) => ({ v: '1', type: 'RUNBOOK_STARTED', ts, runbookId, runbook, seq, payload }),
  STEP_ENTERED:    (payload) => ({ v: '1', type: 'STEP_ENTERED',    ts, runbookId, runbook, seq, payload }),
  // …one entry per event type
};
function buildEvent<T extends RunbookEventV1['type']>(type: T, payload: PayloadFor<T>): RunbookEventV1 {
  const make = builders[type] as (p: PayloadFor<T>) => RunbookEventV1; // re-correlation cast
  return make(payload);
}
```

- **What it fixes:** each builder *body* is concrete (literal `type:`), so every
  envelope literal is fully type-checked with no assertion. The record is
  **exhaustive** — a missing event type is a compile error — which subsumes the
  exhaustiveness role of `validatePayload`.
- **Residual hole:** indexing the mapped type with a generic `T` (`builders[type]`)
  yields a union of function types; calling it with `PayloadFor<T>` needs the cast
  on the lookup line. The hole shrinks to **one narrow lookup cast**.
- **Cost:** ~9 near-identical builder closures to maintain.
- **Ergonomics:** preserves the existing two-argument `emit('TYPE', {…})` call shape.
- **Verdict:** 🟡 contains the hole (one lookup cast) but improves checking and
  keeps caller ergonomics. Satisfies constraints 1–4. The pragmatic choice *if*
  two-arg call sites must stay untouched.

### Candidate C — Per-type overloads

A set of `emit('RUNBOOK_STARTED', p: RunbookStartedPayload): void;` … overloads over
a private union-typed implementation.

- **What it fixes:** callers at concrete sites get precise checking.
- **Constraints it breaks:** the implementation signature still builds the union
  generically and **still needs an internal assertion**. Worse, an overload set
  **rejects a union first argument**, so the `execution.ts:1205/1302` union sites no
  longer type-check.
- **Verdict:** ❌ doesn't remove the hole and regresses the union sites. Violates
  constraint 1. Not recommended.

### Candidate D — Pre-correlated pair input + envelope spread ★

Accept the `{ type, payload }` pair as a single argument (a discriminated-union
*value*) and spread it into the envelope:

```typescript
// Derived from RunbookEventV1 — single source of truth (constraint 4):
type RunbookEventInput =
  { [E in RunbookEventV1 as E['type']]: { type: E['type']; payload: E['payload'] } }[RunbookEventV1['type']];

function buildEvent(input: RunbookEventInput): RunbookEventV1 {
  return { v: '1', ts, runbookId, runbook, seq, ...input }; // no assertion
}
emit(input: RunbookEventInput): void {
  this.seq++;
  const event = this.buildEvent(input);
  for (const s of this.subscribers) s(event);
}
```

Why it works where the generic fails: the `type`/`payload` correlation already
lives **in the value being spread**, so TypeScript never has to re-correlate an
open `T`. Spreading a discriminated-union value preserves the correlation, and TS
distributes the envelope intersection over the union member-by-member.

Empirically verified end-to-end:

- Internal `{ …envelope, ...input }: RunbookEventV1` — compiles with **no assertion**.
- Concrete call `emit({ type: 'STEP_ENTERED', payload: {…} })` — OK.
- Union-source call `emit(effect.event)` — OK, and *simpler* than today (the pair is
  already in hand; no `.type`/`.payload` destructuring).
- Mismatched pair `emit({ type: 'ERROR_OCCURRED', payload: { position … } })` —
  correctly **rejected** (`TS2345`).

- **Verdict:** ✅ **removes the hole entirely** — no assertion in `buildEvent`, none
  at the subscriber boundary, none at the union sites. Satisfies all constraints.

## 5. Comparison

| Design | Assertion in `buildEvent` | Union sites (1205/1302) | Per-type checking | Caller ergonomics | `validatePayload` deletable |
|--------|---------------------------|-------------------------|-------------------|-------------------|-----------------------------|
| **A** Generic interface | none here, **needed at subscriber boundary** | ❌ breaks | full | unchanged (2-arg) | no |
| **B** Builder record | **1 lookup cast** | ✅ works | full + exhaustive | unchanged (2-arg) | yes (via exhaustive record) |
| **C** Overloads | **still needed** | ❌ breaks | full at call site | unchanged (2-arg) | no |
| **D** Pair + spread ★ | **none** | ✅ works (simpler) | full | **changes to 1-arg** | **yes** |

## 6. Recommendation

**Candidate D (pre-correlated pair + envelope spread).** It is the only design that
eliminates *every* assertion and keeps both call-site classes sound, because it
never asks TypeScript to re-correlate an open `T` — the correlation lives in the
`{ type, payload }` value being spread. It also aligns the emitter with the shape
the codebase already uses for machine-owned effects (`ExecutionObservationEvent`,
`execution-observation.ts:24-28`, whose members are exactly `{ type, payload }`
pairs), so the union sites simplify to `emitter.emit(effect.event)`.

### Trade-offs of choosing D

- **Caller migration (the main cost):** the 25 concrete sites change from
  `emit('TYPE', { … })` to `emit({ type: 'TYPE', payload: { … } })` — mechanical but
  more verbose. The 2 union sites get *simpler*. If two-arg ergonomics must be
  preserved, a thin two-arg overload can wrap D, but that re-imports a small cast
  into the glue — prefer migrating the sites over keeping the overload.
- **Runtime cost:** none (one object spread instead of an explicit literal).
- **External consumers:** unaffected — `RunbookEventV1` and `EventSubscriber` are
  unchanged. Only `emit`'s input shape changes; `RunbookEventInput` is a new
  *exported, derived* type.

If the caller-migration cost is judged too high for now, **Candidate B** is the
fallback: it keeps two-arg ergonomics and contains the hole to a single, clearly
commented lookup cast, at the price of ~9 builder closures.

### Can `validatePayload` and the `NODE_ENV` gate be deleted?

**Yes, under D (and under B).** `validatePayload` (`emitter.ts:130-158`) exists
solely to catch payload/type mismatches that the `as Extract<…>` assertion
bypasses. With no assertion (D) the compiler rejects mismatched pairs at every call
site, so the runtime guard protects nothing the type system doesn't already
guarantee — delete both the method and the `if (process.env.NODE_ENV !== 'production')`
block (`emitter.ts:104-109`).

Note the existing guard was already *weaker* than the types: its `requiredFields`
record (`emitter.ts:132-142`) is not field-exhaustive (e.g. it omits
`STEP_ENTERED.artifacts`), so removing it loses no real coverage. Under B, the
exhaustive `builders` record subsumes its taxonomy-exhaustiveness role instead.

## 7. Files referenced

- `packages/core/src/events/emitter.ts` — `emit` (63-77), `buildEvent` (91-120),
  the assertion (`:119`), the `NODE_ENV` gate (`:107`), `validatePayload` (130-158).
- `packages/core/src/events/types.ts` — `EventEnvelope` (14-31), `RunbookEventV1`
  (201-210), `PayloadFor` (215-218).
- `packages/core/src/events/execution-observation.ts` — `ExecutionObservationEvent`
  (24-28), the existing `{ type, payload }`-pair shape.
- `packages/cli/src/services/execution.ts` — union-source call sites (`:1205`, `:1302`).
- `packages/core/src/output/types.ts` — downstream consumer (205-209).
