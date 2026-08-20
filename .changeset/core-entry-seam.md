---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

# Enter an execution unit through core, not by rendering it in the CLI

The CLI execution loop used to render the unit it was about to enter — merge
effective variables, build the step frame, pick which expander applied to which
field, assemble a `StepEntryMetadata` — and then read its own rendered command
back out to decide what to do next. `expandedCommandCode === undefined` was the
loop's control-flow signal for "nothing to run". Rendering precedence is a
language-level concern the spec owns, so it belongs behind the machine (#799);
`undefined`-as-signal is a missing type.

`RunbookActorService.enterExecutionUnit({ state, steps })` now does all three —
render, observe, classify — and returns `ExecutionUnitEntry`, a three-arm union:

- **`awaiting`** — nothing for this process to run. One arm for the three
  conditions the loop used to spell out itself: a prompted run, a prompted-FOR
  step, and a unit that declares no command.
- **`runnable`** — carries a `RenderedUnitCommand`: the expanded code, its
  display projection, and the `RD_*` environment for the child process.
- **`inline-launch`** — carries the one-shot intent the machine prepared.

The loop sends state and steps and reads back a classified entry. It renders
nothing, and it derives exactly one fact for itself — whether the cursor is on a
substep — because the missing-deriver authority precondition has to answer that
before any entry exists.

**The command is one value, and that is the point.** The string announced in
`STEP_ENTERED.commandCode` and the string handed to `EXECUTE_COMMAND` come from
one expansion, so a non-deterministic `--helpers` helper cannot make a runbook
run something other than what it announced. That property used to be held by
statement ordering in the loop; it is now held by construction.

The comment that ordering carried was wrong and is not carried forward. It
claimed artifact-producing helpers "append a manifest row per call, so a second
expansion would duplicate the entries". `expandLoopVariablesForCommand` is
synchronous and reduces to `substituteText`, which imports neither `fs` nor the
manifest module; the manifest append is idempotent by identity anyway. The real
constraint is helper determinism, which is what the docs now say.

`RenderedUnitCommand` is nominally branded — tier 1 of the doctrine in
`effective-vars.ts`, a `declare const` `unique symbol`, minted only inside
`deriveExecutionUnitEntry`. Tier 1 is right here because the record is consumed
by typed functions and never round-trips through JSON: `EXECUTE_COMMAND` targets
`__execute-command`, whose `invoke.input` reads the event with no `assign`, so a
rendered command never reaches persisted context.

The brand is load-bearing rather than decorative, and two things keep it that
way. `RenderedUnitCommand` is **not** re-exported from `@rundown-org/core`, so
outside core the type cannot be named — and a type that cannot be named cannot
be asserted to, aliased, or reached through a namespace import. Inside core,
where a relative import puts the name back in scope, a type-aware ESLint rule
(`local/no-rendered-unit-command-cast`,
`eslint-rules/no-rendered-unit-command-cast.mjs`) bans every assertion that can
mint one. Tier 1 means the assertion IS the mint, so the set of assertion
SYNTAXES is the whole surface — but a selector that matches syntax has to
enumerate every spelling, and an import rename (`RenderedUnitCommand as Local`)
produces a spelling no enumeration anticipates. The rule instead resolves the
asserted-to TYPE through the checker and walks its symbol, base types, and
union/intersection members, so a rename, an alias two hops away, or an interface
that inherits the brand all resolve to the same declared symbol and get caught
the same as a direct cast. `scripts/__tests__/eslint-brand-cast-guard.test.mjs`
lints a snippet per laundering route through the real config, because a bug in
the rule's type resolution matches nothing and otherwise reads as passing.
Separately, the CLI, MCP and plugin `src/**` may no longer import
`buildStepVariables`, `expandLoopVariables`, `expandLoopVariablesForCommand`, or
`deriveExecutionUnitEntry` from core at all.

**The entry seam's internals came off the public barrel** on the same reasoning.
`deriveStepEnteredEffect` used to carry two cursor-mismatch guards, refusing an
entry whose `stepId` / `substepId` disagreed with the snapshot; they are deleted
because the entry now has exactly ONE producer, which reads the cursor and the
snapshot off the same `RunbookState`. That argument only holds while a front end
cannot reach the deriver with a hand-built entry, and a wildcard
`export * from './execution-observation.js'` was putting the deriver,
`StepEntryMetadata` and `StepEntryObservationInput` on `@rundown-org/core`
without any file naming them. The barrel names its exports now.

**`hasCommand` is now a field on the entry, derived from the parsed unit.** It
used to be computed as `commandCode !== undefined` inside
`deriveStepEnteredEffect`, which made a payload flag an accident of which
builder produced the entry — the collect-side builder renders nothing, so every
entry it produced reported `hasCommand: false` regardless of the unit. A command
that renders to the empty string is now correctly `hasCommand: true`.

**Both re-entry frontier seams shed their `entry` parameter.** Each read exactly
one field off it — `isSubstep` — and both now derive that from the state they
already hold, through the same `resolveCurrentExecutionUnit` the entry seam
uses. A caller-supplied entry was the wrong shape for it anyway: the field
describes the cursor, so taking it from the caller let an entry describing one
cursor decide a question about another.

The unfenced seam (`projectAndConsumeReEntryFrontier`) enters through
`enterExecutionUnit` with the verified bearers attached, and its `projected` arm
returns the whole classified entry rather than bare observations, so the caller
gets the same classification on the re-entry path as on an ordinary one. The
ordering guarantee is untouched: the consume still commits before the entry is
returned, so a failed consume discloses no bearers. The fenced twin
(`prepareReEntryFrontierConsume`, which `rundown collect` drives) returns the
prepared state and the projected frontier, leaving the commit and the disclosure
to the caller's transaction — `RunbookCollectionService` enters through
`enterExecutionUnit` after its commit lands.

**`enterExecutionUnit` is declared `async`.** Its body is synchronous today, but
three refusals run before the derivation returns — the snapshot freshness gate,
the machine compile, and the render itself — and without the keyword all three
threw in the CALLER's tick rather than rejecting the promise the signature
advertises. A caller that attached `.catch(...)` to the returned promise, or
collected the call in `Promise.all`, observed none of them. `await` callers are
unaffected.

**Behaviour notes.** Helper path containment now resolves against `manager.cwd`
rather than the `cwd` argument threaded into the loop — the canonicalised
directory the actor service already used for artifact path projection, so the
two can no longer disagree. (The CLI always passes `process.cwd()`, which Node
returns already resolved, so the two values are identical in production; the
canonicalisation only bites a caller that supplies a symlinked path, and
containment wants the resolved one anyway.)

Three refusals are now typed `InvalidRunbookStateError` rather than bare, which
is what routes each onto the CLI's existing RD-309 finish/stop/prune recovery
rather than an envelope carrying the wrong instruction:

- A run whose `templateVars` carry no string `ContextId` or `WorkPath`
  (`reason: 'missing_render_context'`).
- A cursor naming a step the parsed runbook does not define
  (`reason: 'cursor_step_not_in_runbook'`, raised by `findStepOrThrow`, which
  now takes the run id for the defect). This one was a live misclassification:
  the collect path wraps any non-`InvalidRunbookStateError` rejection out of the
  entry seam as RD-833, whose recovery reads "fix the helper and re-delegate" —
  the wrong instruction entirely for corrupt persisted state.
- A persisted row carrying no `prompted` (`reason: 'missing_prompted'`).
  `RunbookState.prompted` is required now and `create` always writes it, exactly
  as `templateVars` already worked, so the `?? false` at each read site is gone
  rather than unreachable. The field decides whether a run announces its
  commands or executes them, and is the value a composing parent inherits down
  into a fresh inline child, so defaulting it silently adapted an incompatible
  row into an executing run.

**Five branches came out as provably dead** while mutation-testing the new
module to 100%, and each was a second spelling of a fact the types already
carried: `currentStep.kind === 'command'` and `currentStep.kind === 'for'`
(`command` is declared on `Substep` and `StepWithCommand` only, `forClause` on
`ResolvedStepWithFor` only — both are now structural `in` checks); two of the
five identity checks in the inline-intent projection (`entry.stepId` IS
`state.step` by construction, and the entry's `substepId` check subsumes the raw
cursor's); and an outer `typeof state.snapshot` guard the optional chain already
answered. The cursor overlay that used to sit in `snapshotForEntry` went with
them — it existed to satisfy `deriveStepEnteredEffect`'s guards, which this work
deletes, so nothing read it any more.

**The #816 divergence is closed rather than characterised.** `rundown collect`
used to build its own partial entry — ids, position, name and flags, and none of
the four rendered fields — while the CLI execution loop's builder filled all of
them, so the same cursor produced two different `STEP_ENTERED` payloads
depending on which command reached it. There is one builder now and nothing left
to disagree, so the characterisation assertions are inverted rather than
deleted: what was `toBeUndefined()` is the rendered value, and what was `false`
is the composed one. They read the emitted payload, because the argument they
used to capture is core-private. The end-to-end contrast is pinned in the CLI's
`integration/step-entered-run-collect-agreement.test.ts`, and the two loop-half
assertions moved from the CLI's mocked loop onto the real derivation in
`packages/core/__tests__/runbook/execution-unit-entry.test.ts`, asserting the
same values on the same fixtures.

Behaviour is otherwise unchanged.
