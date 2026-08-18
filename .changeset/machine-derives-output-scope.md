---
'@rundown-org/core': minor
'@rundown-org/cli': patch
---

# Derive the OUTPUTS scope behind the state machine, not in the CLI

The CLI used to decide which OUTPUTS an execution unit captures and where those
channels live, then ship both conclusions to the machine on `EXECUTE_COMMAND`.
`deriveOutputScope` and `extractUnitOutputs` are gone from
`packages/cli/src/services/execution.ts`; `outputScope` and `nakedOutputs` are
gone from the event. Core now derives both inside the `commandExecActor`
invoke-input closure. `commandExecActor` itself is untouched — only the source
of its input changed.

Every input to that derivation was already machine-owned, and OUTPUTS capture is
Category B by name in CLAUDE.md's side-effect table, so nothing external had to
move with it. The two halves enter through different doors, which is the whole
point of the placement: `nakedOutputs` is **compile-time-bound** — which names a
unit captures is fixed by the parsed runbook, so the leaf-state builder resolves
it once and closes over it — while `outputScope` is **event-time-bound**,
because its iteration tier comes from `context.forStack` and changes per FOR
iteration, so it is read from context at fire time. This is the same split
`buildArtifactResolveInput` already applies one function away in `compiler.ts`,
for the sibling ARTIFACTS directive over the same `forStack`; core carried two
parallel derivations of one concept and drove only one of them from the machine.

The scope is now built from the leaf state's own `stepName`/`substepId` rather
than from a cursor the sender reports, which closes a real gap: a persisted
`substep` naming a substep that no longer exists on the step used to fall back
through `resolveCurrentExecutionUnit` to a step-level scope, while the machine
sat wherever the machine actually sat. A leaf state exists only for a substep
the compiled runbook defines, so the position and the scope can no longer
disagree.

Core gains `deriveOutputScope(stepId, substepId, forStack)` from
`output-channels.js`, beside the `OutputScope` type it constructs, and
`extractUnitOutputs(step, substepId)` from `execution-units.js`, beside
`resolveCurrentExecutionUnit`. Both drop the CLI versions' separate `isSubstep`
boolean: a defined `substepId` **is** the substep tier, so the two can no longer
be passed in disagreement, and the two test cases that exercised the
contradictory combinations are unrepresentable rather than deleted.

Two mutants survive on the leaf builder's `owningStep === undefined` guard. They
are equivalent, not a coverage gap: `config.stepName` always names a step in
`steps`, so the arm is unreachable, and the guard mirrors the shape the adjacent
`needsIteration` line already uses on the same variable. The two mutants on that
line that do encode real behaviour are killed by
`compiler-command-exec.test.ts`.

No new source-text guard accompanies this. The three `readFile`-plus-regex tests
in the CLI exist because those seams cannot state their invariant in types; this
one now can — the event fields are gone, so a re-added CLI derivation has
nowhere to send its result and fails to compile.
