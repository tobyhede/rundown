---
'@rundown-org/cli': patch
---

# Release the loop's own run at terminal, not whatever is on top

The execution loop's `stack-pop` terminal disposition called the positional
`popRunbook()`, which removes the top of the default stack. The run it means to
release was in scope the whole time and never compared to it.

That is a strictly weaker statement of the same intent, and it is weaker in two
directions at once. A stale child sitting above the ending run gets popped
instead — and because `projectRunbookRelease` deletes every claim controlling
what it removes, that takes the child's run-control claim with it — while the
run that actually reached terminal is left on the stack it was supposed to
leave. `stack-pop` is chosen when the run was resolved as the top or was just
pushed, so the two coincide in the ordinary case; the divergence is a foreign
run pushed-and-minted in the window, or a child not yet released.

`releaseRunbook(runbookId)` names it. That also matches the fenced command
mutation, which already releases by id inside its transaction — two terminal
paths for one run should not disagree about what they target — and its
`not-found` arm makes a run already released, by the fence or by another
process, a clean no-op rather than a refusal.

Claim disposition is unchanged: the bare form deletes claims exactly as the
positional pop did. `release-runbook` still retains a terminal tombstone and
this mode still does not. That divergence is real and tracked separately;
changing it in the same commit as the addressing would make a regression in
either untraceable to the other.

Not `popRunbookIfActive`: an undo must reach its run only while it is still
active, whereas a terminal release must reach its run wherever it now sits.
Narrowing this to the top would leak the ended run whenever anything had been
pushed above it.
