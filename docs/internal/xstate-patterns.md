# XState v5 Patterns Reference

> Living reference. Verified against xstate@5.30.0 on 2026-05-10. Re-verify on each xstate upgrade.
> Audience: contributors editing `packages/core/src/runbook/compiler.ts`.
> For Rundown-compiler-specific patterns and migration plan, see [architecture.md § XState Compiler](./architecture.md#xstate-compiler).

## Table of Contents

- [What XState v5 Type-Checks at Compile Time](#type-check-matrix)
- [setup() API](#setup-api)
  - [setup().extend()](#setup-extend)
  - [setup().createStateConfig()](#setup-createstateconfig)
- [Type-Bound Helpers](#type-bound-helpers)
- [Event Design](#event-design)
  - [Event narrowing in actions](#event-narrowing)
  - [assertEvent()](#assertevent)
- [Context & assign()](#context-assign)
- [Guards](#guards)
  - [Inline guards](#guards-inline)
  - [Named guards](#guards-named)
  - [Parameterized guards](#guards-parameterized)
  - [Guard combinators](#guards-combinators)
- [Actors](#actors)
  - [fromPromise](#actors-frompromise)
  - [Type extraction utilities](#actors-type-extraction)
- [Transitions & State Checks](#transitions)
  - [Tags over matches()](#transitions-tags)
  - [state.can()](#transitions-can)
  - [enqueueActions](#transitions-enqueue)
  - [Routable States (xstate.route)](#transitions-routable)
- [Testing](#testing)
  - [createActor](#testing-createactor)
  - [transition() and initialTransition()](#testing-transition)
  - [actor.select()](#testing-select)
  - [provide() (no completeness check)](#testing-provide)
- [Anti-Patterns](#anti-patterns)
- [Known Limitations](#known-limitations)
- [Appendix: Hierarchical and Parallel States](#appendix-hierarchical-parallel)
- [References](#references)

---

<a id="type-check-matrix"></a>

## What XState v5 Type-Checks at Compile Time

**TL;DR:** XState v5 checks names, events, context, params, and actor I/O at compile time. Transition targets, `provide()` completeness, and per-state context narrowing are NOT checked.

| Element | Checked? | Notes |
|---------|----------|-------|
| Action names (string refs in `setup()`) | YES | Must match `setup({ actions })` keys |
| Guard names (string refs in `setup()`) | YES | Must match `setup({ guards })` keys |
| Actor source names | YES | Must match `setup({ actors })` keys |
| Event types in `send()` / `on:` keys | YES | Checked against event union |
| Context shape in `assign()` | YES | Property names and value types |
| Input/output shapes for actors | YES | End-to-end via `fromPromise` etc. |
| `onDone` output type | YES | Inferred from actor return type |
| Dynamic `params` shape | YES | Checked in `params` resolvers |
| Tags in `hasTag()` | YES | Via `types.tags` |
| Meta in state configs | YES | Via `types.meta` |
| Transition target strings | NO (reliable) | As of 5.30.x targets remain stringly typed for arbitrary user state names. The one exception is `xstate.route` — see [Routable States](#transitions-routable). |
| `sendTo()` event types to actors | PARTIAL | Validated when target is a typed `ActorRef`; NOT validated for string actor IDs |
| `.provide()` completeness | NO | Missing implementations not caught |
| Per-state context narrowing (typestates) | NO | TS language limitation |
| `state.matches()` type narrowing | NO | Returns `boolean`, not type predicate |

> See also: [Known Limitations](#known-limitations) for the constraints behind the "NO" entries.

### Problem -> Pattern Quick Lookup

| Problem | Pattern | Section |
|---------|---------|---------|
| Modular state blocks that preserve inference | `createStateConfig()` | [setup().createStateConfig()](#setup-createstateconfig) |
| Event narrowing in named actions | Dynamic params / `assertEvent()` / inline actions | [Event narrowing](#event-narrowing) |
| Mocking actors and guards in tests | `provide()` (caveat: no completeness check) | [provide()](#testing-provide) |
| Extracting configs breaks type inference | `createStateConfig()` / type-bound helpers | [setup().createStateConfig()](#setup-createstateconfig), [Type-Bound Helpers](#type-bound-helpers) |
| Conditional action composition | `enqueueActions` | [enqueueActions](#transitions-enqueue) |
| Typed dynamic transition target | `route: {}` + `xstate.route` event | [Routable States](#transitions-routable) |

---

<a id="setup-api"></a>

## setup() API

**TL;DR:** `setup()` is the mandatory entry point for typed machines. All types flow from it.

```typescript
import { setup, assign } from 'xstate';

const machine = setup({
  types: {
    context: {} as { count: number },
    events: {} as { type: 'increment'; value: number } | { type: 'reset' },
    input: {} as { defaultCount: number },
    output: {} as { finalCount: number },
    children: {} as { fetcher: 'fetchActor' },
    emitted: {} as { type: 'countChanged'; count: number },
    tags: {} as 'loading' | 'error',
    meta: {} as { description: string },
  },
  actions: { /* ... */ },
  guards: { /* ... */ },
  actors: { /* ... */ },
  delays: { /* ... */ },
}).createMachine({ /* ... */ });
```

The `{} as Type` cast pattern provides type information to TypeScript while the runtime value is an empty object.

| Slot | Purpose |
|------|---------|
| `context` | Shape of the machine's mutable state |
| `events` | Discriminated union of all sendable events |
| `input` | Initialization data passed to `createActor(machine, { input })` |
| `output` | Final output value when machine reaches a final state |
| `children` | Maps invoke IDs to actor source names (for typed `system.get()`) |
| `emitted` | Events the machine can emit to subscribers |
| `tags` | String literal union of valid tags |
| `meta` | Shape of state-level meta values |

<a id="setup-extend"></a>

### setup().extend()

Incrementally add actions, guards, and delays after initial `setup()`. Useful for modular composition.

```typescript
const base = setup({
  types: { context: {} as { count: number }, events: {} as { type: 'inc' } },
  actions: { log: () => console.log('logged') },
});

const extended = base.extend({
  actions: { notify: () => console.log('notified') },
  guards: { isPositive: ({ context }) => context.count > 0 },
});

const machine = extended.createMachine({ /* ... */ });
```

<a id="setup-createstateconfig"></a>

### setup().createStateConfig()

Create **type-safe extracted state configurations** that preserve inference. This solves the "extracting state configs breaks type inference" problem.

```typescript
const machineSetup = setup({
  types: { context: {} as { count: number }, events: {} as { type: 'inc' } },
  actions: { bump: assign({ count: ({ context }) => context.count + 1 }) },
});

// Extracted but still type-checked
const loadingState = machineSetup.createStateConfig({
  on: { inc: { actions: 'bump' } },  // 'bump' is validated against setup keys
});

const machine = machineSetup.createMachine({
  initial: 'loading',
  states: { loading: loadingState },
});
```

---

<a id="type-bound-helpers"></a>

## Type-Bound Helpers

**TL;DR:** After `setup()`, you get pre-typed helper methods usable outside the machine config — use these instead of raw imports.

| Helper | Purpose |
|--------|---------|
| `.assign()` | Typed context assignment |
| `.raise()` | Typed self-event |
| `.emit()` | Typed emitted event |
| `.sendTo()` | Typed send to actor |
| `.log()` | Typed log action |
| `.cancel()` | Cancel delayed event |
| `.stopChild()` | Stop child actor |
| `.spawnChild()` | Spawn child actor |
| `.enqueueActions()` | Conditional action composition |
| `.createAction()` | Create typed action function |
| `.createStateConfig()` | Create typed state config (see above) |
| `.extend()` | Extend setup with more implementations |

```typescript
const machineSetup = setup({
  types: {
    context: {} as { count: number },
    events: {} as { type: 'inc'; value: number } | { type: 'reset' },
  },
});

// These work OUTSIDE the machine config with full type safety
const incrementAction = machineSetup.assign({
  count: ({ context, event }) => context.count + 1,
});

const raiseReset = machineSetup.raise({ type: 'reset' });
```

> **Caveat:** `createAction` accepts `unknown` params and does NOT narrow per-event params the way `setup({ actions })` registrations do. Its event parameter is the full event union (see `setup.d.ts` — the helper signature uses `unknown` for the params slot). For per-event narrowing, prefer registering the action in `setup({ actions })` and using `params: ({ event }) => …` at the call site.

---

<a id="event-design"></a>

## Event Design

**TL;DR:** Events must be discriminated unions on `type`. Named actions see the full union — use dynamic params or `assertEvent()` to narrow.

```typescript
type MyEvents =
  | { type: 'submit'; email: string }
  | { type: 'cancel' }
  | { type: 'retry' };
```

<a id="event-narrowing"></a>

### Event narrowing in actions

Inside named actions registered in `setup({ actions })`, `event` is the **full union** (not narrowed). Three solutions:

**1. Dynamic params (preferred)** — params resolvers get narrowed event types from transition context:

```typescript
setup({
  actions: {
    logMessage: (_, params: { msg: string }) => console.log(params.msg),
  },
}).createMachine({
  on: {
    submit: {
      actions: {
        type: 'logMessage',
        params: ({ event }) => ({ msg: event.email }), // event IS narrowed here
      },
    },
  },
});
```

<a id="assertevent"></a>

**2. `assertEvent()` (runtime narrowing):**

```typescript
import { assertEvent } from 'xstate';

// Inside an action:
({ event }) => {
  assertEvent(event, 'submit');       // throws if wrong type
  console.log(event.email);           // narrowed
};

// Accepts arrays:
assertEvent(event, ['submit', 'retry']);
```

**3. Inline actions** get automatic narrowing from transition context:

```typescript
on: {
  greet: {
    actions: ({ event }) => {
      // event is narrowed to { type: 'greet'; … }
      console.log(event.message);
    },
  },
}
```

---

<a id="context-assign"></a>

## Context & assign()

**TL;DR:** Context is typed via `setup()` and updated only through `assign()`. Extracting `assign()` outside `setup()` breaks inference — use type-bound helpers.

```typescript
assign({
  count: ({ context }) => context.count + 1,    // property names and types checked
  feedback: ({ event }) => event.feedback,       // event typed in transition context
});
```

Use `readonly` modifiers for compile-time immutability (XState does NOT freeze at runtime):

```typescript
context: {} as {
  readonly items: readonly string[];
  readonly forStack: readonly ForContext[];
}
```

**Avoid:** Extracting `assign()` calls outside the `setup()` scope — this breaks generic inference. Solutions:
1. Keep assign inline within `setup()` or `createMachine()`.
2. Use type-bound helpers: `machineSetup.assign()`.
3. Use `createStateConfig()` for extracted state blocks.

---

<a id="guards"></a>

## Guards

**TL;DR:** Three patterns with increasing type safety: inline (full inference), named (context typed), parameterized (best reusability). Always include the first parameter.

<a id="guards-inline"></a>

**Inline** (full inference):

```typescript
on: { submit: { guard: ({ context }) => context.count > 0 } }
```

<a id="guards-named"></a>

**Named in setup()** (context typed, event is full union):

```typescript
setup({
  guards: { isValid: ({ context }) => context.feedback.length > 0 },
})
// Reference: guard: 'isValid'  -- type-checked against setup keys
```

<a id="guards-parameterized"></a>

**Parameterized** (best for reusability):

```typescript
setup({
  guards: {
    isGreaterThan: (_, params: { count: number; min: number }) =>
      params.count > params.min,
  },
})
// Reference with params resolver:
guard: { type: 'isGreaterThan', params: ({ context }) => ({ count: context.items.length, min: 0 }) }
```

<a id="guards-combinators"></a>

**Combinators:** `and()`, `or()`, `not()`, `stateIn()`:

```typescript
import { and, or, not, stateIn } from 'xstate';

guard: and(['isValid', not('isBlocked')])
guard: stateIn({ form: 'editing' })
```

**Avoid:** Omitting the first parameter in guard functions. `() => true` poisons type inference for ALL guard params via [issue #5014](https://github.com/statelyai/xstate/issues/5014). Always write `(_) => true`.

---

<a id="actors"></a>

## Actors

**TL;DR:** Use `fromPromise` for async work with typed input/output. Extract types with utility helpers like `ActorRefFrom`.

<a id="actors-frompromise"></a>

### fromPromise (typed input/output)

```typescript
import { fromPromise } from 'xstate';

const fetchUser = fromPromise(
  async ({ input, signal }: { input: { userId: string }; signal: AbortSignal }) => {
    const res = await fetch(`/api/users/${input.userId}`, { signal });
    return (await res.json()) as { name: string; email: string };
  }
);

// In setup:
setup({ actors: { fetchUser } }).createMachine({
  states: {
    loading: {
      invoke: {
        src: 'fetchUser',                                    // type-checked
        input: ({ context }) => ({ userId: context.userId }), // typed input
        onDone: {
          actions: ({ event }) => event.output.name,          // typed output
        },
        onError: {
          actions: ({ event }) => event.error,                // typed error
        },
      },
    },
  },
});
```

`fromCallback`, `fromObservable`, `fromEventObservable`, and `fromTransition` (reducer-style) are also available with similar typed-input/output patterns.

<a id="actors-type-extraction"></a>

### Type extraction utilities

| Helper | Purpose |
|--------|---------|
| `ActorRefFrom<typeof logic>` | Typed actor reference |
| `SnapshotFrom<typeof logic>` | Snapshot type |
| `EventFromLogic<typeof logic>` | Event union |
| `InputFrom<typeof logic>` | Input type |
| `OutputFrom<typeof logic>` | Output type |

---

<a id="transitions"></a>

## Transitions & State Checks

**TL;DR:** Prefer `hasTag()` over `matches()` for type-safe state queries. Use `state.can()` to check transition availability. Use `enqueueActions` for conditional composition. Use Routable States for typed dynamic targets.

<a id="transitions-tags"></a>

### Tags over matches()

`state.matches()` returns `boolean` without type narrowing. Use typed tags instead:

```typescript
setup({
  types: { tags: {} as 'loading' | 'error' | 'success' },
}).createMachine({
  states: {
    fetching: { tags: ['loading'] },
    failed: { tags: ['error'] },
  },
});

snapshot.hasTag('loading');   // autocomplete, type-checked
snapshot.hasTag('invalid');   // TypeScript error
```

<a id="transitions-can"></a>

### state.can()

Type-safe check whether an event would trigger a transition (including guard evaluation):

```typescript
snapshot.can({ type: 'PASS' });  // type-checked against event union
```

<a id="transitions-enqueue"></a>

### enqueueActions

Conditional action composition replacing v4's `pure()` and `choose()`. `enqueue.*` and `check()` are typed against the machine's setup:

```typescript
enqueueActions(({ context, event, enqueue, check }) => {
  enqueue.assign({ count: context.count + 1 });

  if (check('isAboveThreshold')) {  // named guard from setup({ guards })
    enqueue('logWarning');           // must exist in setup actions
  }

  enqueue.raise({ type: 'INCREMENT', amount: 1 }); // type-checked
  enqueue.sendTo('someActor', { type: 'UPDATE' });
});
```

`enqueueActions` also supports parameters:

```typescript
setup({
  actions: {
    doThings: enqueueActions(({ enqueue }, params: { name: string }) => {
      enqueue({ type: 'greet', params: { name: params.name } });
    }),
    greet: (_, params: { name: string }) => console.log(`Hello ${params.name}!`),
  },
}).createMachine({
  entry: { type: 'doThings', params: { name: 'World' } },
});
```

<a id="transitions-routable"></a>

### Routable States (xstate.route)

**Added in 5.30.** Marking a state with `route: {}` opts it into a typed `xstate.route` event. The event's `to` field is constrained to the union of routable state IDs in the machine, providing the **first typed transition-target mechanism** in v5.

```typescript
const machine = setup({
  types: { context: {} as { count: number } },
}).createMachine({
  initial: 'idle',
  states: {
    idle: {},
    active: {
      id: 'active',
      route: {},               // mark as routable
      states: { /* ... */ },
    },
    done: {
      id: 'done',
      route: {},
    },
  },
});

// Typed: 'to' must be one of '#active' | '#done'
actor.send({ type: 'xstate.route', to: '#active' });
actor.send({ type: 'xstate.route', to: '#typo' }); // TypeScript error
```

The `RoutableStateId<TConfig>` type (see `node_modules/xstate/dist/declarations/src/types.d.ts:941-946`) walks the state schema and extracts `#${id}` for every node with both `id` and `route`. The `setup().createMachine` return type unions in `{ type: 'xstate.route'; to: RoutableStateId<TConfig> }` automatically (see `node_modules/xstate/dist/declarations/src/setup.d.ts:99-102`).

This is directly relevant to dynamic compilers: a machine that exposes step IDs as routable targets can accept a typed jump event in place of stringly-typed `target` strings.

---

<a id="testing"></a>

## Testing

**TL;DR:** Use `createActor` for integration tests, `transition()` for pure logic tests, `actor.select()` for derived selectors, `provide()` for mocking. Note: `provide()` does NOT enforce completeness.

<a id="testing-createactor"></a>

### createActor

```typescript
import { createActor } from 'xstate';

const actor = createActor(machine, { input: { /* typed */ } });
actor.start();
actor.send({ type: 'PASS' });  // type-safe
expect(actor.getSnapshot().context.retryCount).toBe(0);
```

<a id="testing-transition"></a>

### transition() and initialTransition()

Pure transitions, no actor, no side effects. Both return a tuple `[snapshot, ExecutableActionsFrom<T>[]]` — the actions array contains side effects that *would* execute, so test authors can assert against them without running them.

```typescript
import { transition, initialTransition } from 'xstate';
import type { ExecutableActionsFrom } from 'xstate';

// Get initial state + actions
const [initialSnapshot, initialActions] = initialTransition(machine);
// initialActions: ExecutableActionsFrom<typeof machine>[]

// Pure transition
const [nextSnapshot, actions] = transition(machine, snapshot, { type: 'PASS' });
```

Signatures (from `node_modules/xstate/dist/declarations/src/transition.d.ts`):

```typescript
function transition<T extends AnyActorLogic>(
  logic: T,
  snapshot: SnapshotFrom<T>,
  event: EventFromLogic<T>,
): [nextSnapshot: SnapshotFrom<T>, actions: ExecutableActionsFrom<T>[]];

function initialTransition<T extends AnyActorLogic>(
  logic: T,
  ...input: undefined extends InputFrom<T> ? [InputFrom<T>?] : [InputFrom<T>]
): [SnapshotFrom<T>, ExecutableActionsFrom<T>[]];
```

> Note: `getNextSnapshot` and `getInitialSnapshot` are **deprecated**. Use `transition()` and `initialTransition()`.

<a id="testing-select"></a>

### actor.select()

**Added in 5.29.** Returns a `Readable<TSelected>` (with `.get()` and `.subscribe()`) over a derived projection of the snapshot. Useful for tests and UI subscribers that should react to a specific slice of state.

```typescript
const actor = createActor(machine).start();

const count = actor.select((s) => s.context.count);
count.get();                        // current value
const unsubscribe = count.subscribe((v) => console.log(v));

// Optional equality function avoids spurious notifications:
const items = actor.select(
  (s) => s.context.items,
  (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
);
```

Signature (from `createActor.d.ts:118`):

```typescript
select<TSelected>(
  selector: (snapshot: SnapshotFrom<TLogic>) => TSelected,
  equalityFn?: (a: TSelected, b: TSelected) => boolean,
): Readable<TSelected>;
```

<a id="testing-provide"></a>

### provide() (no completeness check)

```typescript
const testMachine = machine.provide({
  actions: { logTelemetry: () => { /* stub */ } },
  guards: { canRetry: () => true },
  actors: { fetchUser: fromPromise(async () => mockUser) },
});
```

**Avoid:** Assuming `provide()` catches missing implementations — it does NOT enforce completeness at compile time ([Discussion #4574](https://github.com/statelyai/xstate/discussions/4574)). Override keys must match the original `setup()`, but you can omit any of them silently.

---

<a id="anti-patterns"></a>

## Anti-Patterns

**TL;DR:** Most anti-patterns stem from breaking type inference by extracting code outside `setup()` scope, omitting parameters, or branching on event type strings inside actions.

### Extracting state configs into variables

Breaks type inference for events, actions, and transitions. Use [`createStateConfig()`](#setup-createstateconfig) instead, or use `as const` on action/guard string references when you must extract. Acknowledged as a TS limitation by maintainers ([Discussion #4697](https://github.com/statelyai/xstate/discussions/4697)).

### Omitting first guard parameter

`() => true` poisons type inference for ALL guard params (confirmed bug — [Issue #5014](https://github.com/statelyai/xstate/issues/5014), reproduces v5.16.0–5.23.0). Always write `(_) => true` or `(_ctx) => true`.

### `switch(event.type)` inside actions

Loses structure and bypasses XState's per-transition narrowing. Prefer one of:
- **Separate transitions** — one `on:` entry per event type, with inline or named actions per branch.
- **Parameterized actions** — extract event data via `params: ({ event }) => …` so the action receives a typed payload.
- **`enqueueActions({ check })`** — for guard-driven branching, `check()` accepts named guards from `setup({ guards })` and is fully type-checked. Example:

  ```typescript
  enqueueActions(({ enqueue, check }) => {
    if (check('isAdmin')) enqueue('grantAccess');
    else if (check('isGuest')) enqueue('redirectToLogin');
  });
  ```

### `unknown` in config interfaces

`{ actions?: unknown; guard?: unknown; [key: string]: unknown }` bypasses all type checking. A pragmatic escape hatch for dynamic generation, but every field becomes unchecked. Document the cost when used.

### Using enum values for actor sources

TypeScript widens enum references. Use string literals or explicit casts (`Services.MY_SERVICE as Services.MY_SERVICE`) per [Discussion #4697](https://github.com/statelyai/xstate/discussions/4697).

### Expecting `provide()` to enable deferred type-safe DI

`provide()` overrides are typed against the original `setup()` but completeness is not enforced. For genuinely generic machines, factory functions are the only mechanism that maintains type safety ([Discussion #4574](https://github.com/statelyai/xstate/discussions/4574)).

---

<a id="known-limitations"></a>

## Known Limitations

**TL;DR:** XState v5 type inference works best inline. Key gaps: no per-state context narrowing, mostly-stringly-typed transition targets, no `provide()` completeness checks, no typegen.

1. **Inline-vs-modular tension.** Type inference works best inline within `setup().createMachine()`. Mitigated by type-bound helpers, `createStateConfig()`, and `extend()`. Acknowledged by maintainers as a TS limitation ([Discussion #4697](https://github.com/statelyai/xstate/discussions/4697), [#4812](https://github.com/statelyai/xstate/discussions/4812)).

2. **No per-state context narrowing (typestates).** Context is a single type across the entire machine. Blocked by TypeScript's control-flow analysis limits ([Discussion #2323](https://github.com/statelyai/xstate/discussions/2323)). Workarounds: optional fields with runtime checks, or split into separate actor machines.

3. **Transition target strings.** Targets to arbitrary state names remain stringly typed. The only typed dynamic-target mechanism is [Routable States](#transitions-routable) (`route: {}` + `xstate.route`), added in 5.30.

4. **`sendTo()` to string actor IDs.** Event types are NOT validated against the target actor's event union ([Discussion #4995](https://github.com/statelyai/xstate/discussions/4995)). Workaround: cast the actor ID via `ActorRefFromLogic<typeof logic>`.

5. **`.provide()` completeness.** Missing implementations not caught at compile time ([Discussion #4574](https://github.com/statelyai/xstate/discussions/4574)). For required-implementation machines, use factory functions.

6. **`getMeta()` keyed by internal state IDs.** Returns `Record<StateId<TStateSchema> & string, TMeta | undefined>` — values are typed via `types.meta`, but keys are XState's internal state IDs (e.g. `"runbook.step1.substep2"`).

7. **Parallel state value typing.** `state.value` for parallel states is not a precise union of valid region combinations — it's a broad object type ([Issue #4229](https://github.com/statelyai/xstate/issues/4229)).

8. **Typegen removed in v5.** No codegen, no `tsTypes`. `setup()` is the replacement; `assertEvent()` is the replacement for typegen's per-action event narrowing — a runtime check, not compile-time.

9. **No community type-enhancement tools.** The ecosystem relies entirely on XState's built-in types. No active third-party packages fill the gaps.

---

<a id="appendix-hierarchical-parallel"></a>

## Appendix: Hierarchical and Parallel States

Compact reference for nested and parallel state typing. Behavior is consistent with the rest of v5 — types live in `setup()`, no per-state narrowing.

### Hierarchical (compound) states

Context and events are uniform across all nesting levels in a single `setup()` call:

```typescript
setup({
  types: {
    context: {} as { retryCount: number },
    events: {} as { type: 'PASS' } | { type: 'FAIL' } | { type: 'RETRY' },
  },
  guards: {
    canRetry: ({ context }) => context.retryCount < 3,
  },
}).createMachine({
  initial: 'step1',
  states: {
    step1: {
      initial: 'substep1',
      states: {
        substep1: {
          on: {
            PASS: { target: 'substep2' },
            RETRY: { guard: 'canRetry', target: 'substep1' },
          },
        },
        substep2: { type: 'final' },
      },
      onDone: { target: 'step2' },          // fires when child reaches final
    },
    step2: { type: 'final' },
  },
});
```

`onDone` on a compound state fires when its child reaches `type: 'final'`. The event payload is typed as `{ type: 'xstate.done.state.<id>' }`.

### Parallel states

`type: 'parallel'` produces an object-shaped `state.value`:

```typescript
setup({}).createMachine({
  type: 'parallel',
  states: {
    track:  { initial: 'paused', states: { paused: {}, playing: {} } },
    volume: { initial: 'normal', states: { normal: {}, muted: {} } },
  },
});

// state.value: { track: 'paused' | 'playing', volume: 'normal' | 'muted' }
```

**Limitations:**
- `state.value` is a broad object type, not a precise discriminated union of valid region combinations ([Issue #4229](https://github.com/statelyai/xstate/issues/4229)).
- Parallel `onDone` fires only when **all** regions reach final.
- Use [tags](#transitions-tags) for cross-region categorical state checks rather than inspecting `state.value`.

### Typed children

Map invoke IDs to actor source names via `types.children` for typed `system.get()` lookups:

```typescript
setup({
  types: {
    children: {} as { fetch1: 'fetcher'; fetch2: 'fetcher' },
  },
  actors: { fetcher },
}).createMachine({ /* ... */ });
```

---

<a id="references"></a>

## References

- [XState TypeScript Documentation](https://stately.ai/docs/typescript)
- [XState Setup API](https://stately.ai/docs/setup)
- [XState Actions](https://stately.ai/docs/actions) (enqueueActions, params)
- [XState Guards](https://stately.ai/docs/guards) (and/or/not/stateIn)
- [XState Actors](https://stately.ai/docs/actors) (fromPromise, fromCallback)
- [XState Tags](https://stately.ai/docs/tags)
- [XState Parallel States](https://stately.ai/docs/parallel-states)
- [XState Migration v4 to v5](https://stately.ai/docs/migration)
- [Discussion #4382 – State name type safety](https://github.com/statelyai/xstate/discussions/4382)
- [Discussion #4574 – Providing specific types](https://github.com/statelyai/xstate/discussions/4574)
- [Discussion #4697 – Extracting compound states](https://github.com/statelyai/xstate/discussions/4697)
- [Discussion #4812 – Modular code TS pain points](https://github.com/statelyai/xstate/discussions/4812)
- [Discussion #4995 – sendTo type safety](https://github.com/statelyai/xstate/discussions/4995)
- [Issue #5014 – Guard parameter inference bug](https://github.com/statelyai/xstate/issues/5014)
