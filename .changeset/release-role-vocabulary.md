---
'@rundown-org/core': minor
'@rundown-org/cli': patch
---

# Add the ReleaseRole vocabulary, and characterise today's terminal claim disposition

New in core, with no callers yet: `ReleaseRole`
(`addressed | collateral | discarded`), `ClaimDisposition`
(`retain-as-terminal-evidence | revoke`), `claimDisposition(role)`, `RunRelease`
and `projectRunRelease(session, release)`, in
`packages/core/src/runbook/session-release.ts`.

The session release primitive currently asks each caller for a **conclusion** —
`retainClaimsAsTerminal`, a boolean meaning "should this claim survive?" — which
is domain logic, performed independently at sixteen call sites. Fifteen of them
agree, and they agree on a rule none of them states: the run the caller acted
_on_ keeps its claim as terminal evidence, and a run swept up so that the
addressed run could close does not. The sixteenth omits the option, and omission
reads as the destructive direction, so a run that reached terminal has its
run-control claim revoked and its holder is told to re-claim a delegation that
was never issued.

The new vocabulary asks for the **fact** the caller already holds instead — "I
addressed this run" — and owns the conclusion itself, which makes that whole bug
class unrepresentable: there is no option left to omit. `discarded` is a
distinct arm rather than a synonym for `collateral` because the destroy paths
must never be spelled `addressed`, which would retain claims over a run that is
about to stop existing.

`claimDisposition` takes the role alone, and a property test pins the invariant
that makes that safe: a run's disposition depends only on its own role, never on
ordering and never on the other members of a batch. That is what lets it widen
to `claimDisposition(role, claim)` later — when a run-control claim and a
delegated bearer over the same run want different treatment — without touching a
caller. `projectRunRelease` is synchronous and mutates in place by requirement,
because several dispositions reach the projection through a session callback
that accepts nothing else.

Also adds CLI integration tests characterising today's disposition at the
resolution seam, so the behaviour change that follows is visible as a one-line
diff. They record that an already-terminal loop entry resolves `superseded` /
`claim-rotated`, that a run completing through a fenced command resolves
`terminal`, and that both survive a process boundary. Nothing calls the new
vocabulary yet, so no behaviour changes here.
