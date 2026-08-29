---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

Pass/fail and collect continuations now enter the same core Run Progression
activation (#854). The lifecycle seam records one manual completion, then its
`activate` directive carries a core-minted, run-bound `RunProgressionAuthority`;
the CLI hands that directive through verbatim instead of assembling claim keys
or choosing completion work. Explicit states in the existing compiled XState
machine select each completion application, mismatch refusal, and exhausted
compare-and-swap contention refusal. Each selected completion is applied in its
own compare-and-swap turn and observed before the machine selects again. Fresh
entry still feeds its transitional waiting classification back into the machine
until #857 moves that selection into machine states.

Terminal pass/fail transitions enter the same activation with an observed
boundary, so core decides when upward propagation runs and folds its typed
result without replaying the initiating observation or Run Release. The CLI
still supplies the propagation callable until #856 moves that effect into an
invoked machine state. CLI status rendering now keeps semantic lifecycle
separate from process-exit failure: refusals and invocation failures exit
non-zero without inventing a stopped run. The shared `driveRunProgression`
wiring is used by both pass/fail and `rundown collect`, and the old CLI
terminal-propagation branch and coordination flags are gone.
