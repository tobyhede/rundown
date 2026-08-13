---
'@rundown-org/cli': patch
---

# Make the fresh-claim invariant classification exhaustive

The fresh-launch claim path classified its refusal with a chain of `if`s over
`ClaimChildResult`'s reason and fell through to `CLAIM_INVARIANT_VIOLATED`
(RD-820) for anything unhandled. Five of the eight reasons were classified as
races; the other three fell through, and so would any reason added later — with
no compile error to say so.

That default arm is a claim about Rundown rather than about the caller, and it
has already been wrong once for exactly this reason:
`delegation-already-claimed` reached it by fall-through and reported a race
Rundown handled correctly as a broken invariant, naming the claimer's own
about-to-be-deleted child instead of the child that holds the delegation.

The chain is now an exhaustive `switch` with a `never` guard, so a new
`ClaimChildResult` variant fails compilation at this seam instead of silently
inheriting the invariant-violation envelope. Every existing mapping is preserved
exactly — `delegation-superseded`, `parent-missing`, `concurrent-modification`,
`delegation-already-claimed`, and `session-refused` keep their typed refusals,
and `child-missing`, `delegation-resolved`, and `linkage-mismatch` remain
genuine invariant violations, now stated as a deliberate classification rather
than a fall-through. No behaviour changes.
