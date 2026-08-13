---
'@rundown-org/cli': patch
---

# Let core's claim transaction own the superseded-delegation refusal

`claimAndLaunch` no longer classifies delegation liveness of its own. The
diagnostic pre-check that ran `classifyDelegationLiveness` against the freshly
re-read parent — and refused `delegation-superseded` before core was reached —
is deleted.

The decision it made is one core already owns.
`SessionService.claimRunbookInTransaction` reads the parent **inside** the SQL
transaction that commits the claim and runs the same classifier there, so its
answer is derived from the exact row the claim lands on rather than from a read
taken moments earlier. The CLI already routed that refusal to the identical
outcome, and core refuses on every closed reason where the pre-check was scoped
to `cursor-advanced` alone.

Nothing user-visible changes: the same `DELEGATION_SUPERSEDED` envelope, with
the same `parentRunId` / `stepId` details and the same exit code, and still no
child run row left behind. What changes is which layer produces it — a
duplicated decision in the CLI is a shadow implementation of state-machine
logic, and the fix is to delete it rather than keep the two copies in step.

This is only safe on top of the linkage fix that anchors `parentStep` to the
delegating step: before it, core's in-transaction comparison was fed the parent
cursor it was comparing against, and a claim against an already-advanced parent
was admitted. With the pre-check removed and that fix reverted, such a claim
succeeds and launches a child — which is what makes core's classification, not
the deleted pre-check, demonstrably the thing doing the work.

Part of the domain-lock retirement in #690.
