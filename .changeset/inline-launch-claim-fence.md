---
'@rundown-org/core': patch
'@rundown-org/cli': patch
---

Fence the inline-launch parent mutation under the parent's claim generation (ADR
0002, #714). `rundown run --step` was the one remaining path where a same-cwd
process could mutate another actor's run with no authority check: it resolved
the active parent and wrote its `substepStates` under a version-only
compare-and-swap. The launch now captures the parent's controlling run-control
claim at linkage determination — refusing before any child run is created when
no live claim controls the parent — and the substep mark commits through a new
core seam (`markInlineSubstepLaunched`) whose every attempt re-captures under
the original claim key and commits compare-and-swapped against BOTH the state
version and the captured claim generation. A parent re-claimed in the window
refuses permanently with the new registered code
`INLINE_PARENT_CLAIM_SUPERSEDED` (RD-834), rolling the child back and leaving
the parent to its current orchestrator; version contention alone still
re-derives inside the store's budget. The fence records which authority was
current, not that the caller held it — the residual same-cwd trust boundary is
now stated in `docs/reference/security.md`.
