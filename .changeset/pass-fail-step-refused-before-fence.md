---
'@rundown-org/core': patch
'@rundown-org/cli': patch
---

# An out-of-contract `pass --step` / `fail --step` is refused instead of latching recovery

`--step` on `rundown pass` / `rundown fail` targets a substep of the active
step. A value outside that contract — a bare step id such as `--step 1` (even
when step 1 is the active step), another step, or a substep the step does not
have — used to put the run into `recoveryRequired`. Every later `pass` then
failed with `RECOVERY_REQUIRED` until the operator ran `goto`, `complete` or
`stop`.

The cause was the order of operations, not the validation itself. The seam
resolved the explicit target inside the execution fence's `compute`, which runs
after the execution lease is acquired and the effect boundary is marked. The
resolver's refusal was a plain throw, and the executor cannot tell a throw there
from a failed external effect, so it recorded the attempt as
`effect_boundary_crossed` although nothing external had run (#763).

The target is now resolved in the fence's existing `beforeEffect` hook, against
the same captured state that `compute` records onto, before any lease or effect
marker is written. `resolveManualCompletionCursor` returns a typed
`ManualCompletionCursorResolution` instead of throwing for caller input, and the
lifecycle seam returns the new `invalid_step_target` outcome. The CLI renders
that outcome as an `INVALID_STEP` error with exit 1, and the run stays where it
was. No lease, recovery or retry machinery changed.
