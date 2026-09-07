---
'@rundown-org/cli': patch
---

# `rundown status --text` no longer calls a finished run "No active runbook"

`TextRenderer` had no branch for a terminal run, so `--text` and the default
JSON output disagreed about whether the run existed.

`buildActiveStatus` sets `active: lifecycleStatus === undefined`, so a completed
or stopped run reaches the renderer with `active: false`. With nothing stashed,
it fell into the `!active && !stashed` early return and printed
`No active runbook.` at exit `0` — while the same command in JSON reported
`status: "completed"` plus the full status body.

`StatusDetailData` did not declare `status` at all, so the renderer could not
have expressed "completed" even had it reached the code.

## What changed

- `StatusDetailData` declares `status?: 'completed' | 'stopped'`, which
  `buildActiveStatus` has been supplying all along.
- A terminal branch runs ahead of the no-active early return, printing metadata,
  then `Runbook:  COMPLETE` or `Runbook:  STOP`, then the resolved variables.

**The shape is a decision, and this is the reasoning.** A finished run has no
next step to announce, so the branch is modelled on the adjacent stashed branch
rather than on the active one: metadata, the terminal marker, and the variables
it resolved are the whole of what is still true about it. That is why the full
step body is not printed.

## Spec correction

`docs/spec/cli-output.md` claimed that "invalid, missing, stale, **terminal**,
or unlinked claim ids return an error response". A terminal claim returns a
status body at exit `0`, so the spec was wrong on that word. It now says what
the terminal arm actually does, in both formats.
