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
rendered command never reaches persisted context. Two ESLint rules make the
brand load-bearing rather than decorative: `as RenderedUnitCommand` is banned
outside the producing module, and the CLI, MCP and plugin `src/**` may no longer
import `buildStepVariables`, `expandLoopVariables`,
`expandLoopVariablesForCommand`, or `deriveExecutionUnitEntry` from core at all.

**`hasCommand` is now a field on the entry, derived from the parsed unit.** It
used to be computed as `commandCode !== undefined` inside
`deriveStepEnteredEffect`, which made a payload flag an accident of which
builder produced the entry — the collect-side builder renders nothing, so every
entry it produced reported `hasCommand: false` regardless of the unit. A command
that renders to the empty string is now correctly `hasCommand: true`.

**The unfenced re-entry frontier seam sheds its `entry` parameter.**
`projectAndConsumeReEntryFrontier` read exactly one field off it — `isSubstep` —
and now derives that from the state it already holds, through the same
`resolveCurrentExecutionUnit` the entry seam uses. It enters through
`enterExecutionUnit` with the verified bearers attached, and its `projected` arm
returns the whole classified entry rather than bare observations, so the caller
gets the same classification on the re-entry path as on an ordinary one. The
ordering guarantee is untouched: the consume still commits before the entry is
returned, so a failed consume discloses no bearers. The fenced twin
(`prepareReEntryFrontierConsume`, which `rundown collect` drives) still takes a
caller-supplied entry and is unchanged here.

**Two behaviour notes.** Helper path containment now resolves against
`manager.cwd` rather than the `cwd` argument threaded into the loop — the
canonicalised directory the actor service already used for artifact path
projection, so the two can no longer disagree. (The CLI always passes
`process.cwd()`, which Node returns already resolved, so the two values are
identical in production; the canonicalisation only bites a caller that supplies
a symlinked path, and containment wants the resolved one anyway.) And a run
whose `templateVars` carry no string `ContextId` or `WorkPath` is now refused
with a typed `InvalidRunbookStateError` (`reason: 'missing_render_context'`)
rather than a bare `Error`, which routes it onto the CLI's existing
finish/stop/prune recovery path.

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

Behaviour is otherwise unchanged, and the #816 characterisation of the
`run`-vs-`collect` `STEP_ENTERED` divergence is still green: `rundown collect`
still builds its own partial entry. The two loop-half characterisation
assertions moved from the CLI's mocked loop onto the real derivation in
`packages/core/__tests__/runbook/execution-unit-entry.test.ts`, asserting the
same values on the same fixtures.
