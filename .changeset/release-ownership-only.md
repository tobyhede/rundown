---
'@rundown-org/core': major
'@rundown-org/cli': major
---

# Release ownership, and a finished run keeps its claim

An already-terminal `rundown run` entry revoked the run-control claim it had
minted moments earlier. The orchestrator holding that bearer was told
`CLAIMED_RUNBOOK_UNAVAILABLE` — "was released or replaced and is no longer
authority" — about a rotation that never happened, and could not learn the run's
outcome at all.

The cause was a vocabulary that spelled three independent facts as one word.
`stack-pop | release-runbook | defer-to-caller` conflated **who** releases,
**whether** release fires, and **what happens to the claims**, and the CLI
derived which arm to use from session contents that no longer described any of
the three. `stack-pop` — the default — meant "this run is unclaimed, so revoke",
while `rundown run` mints a run-control claim for every default-stack root. The
arm asserted the exact inverse of the truth.

## What replaces it

`ExecutionReleaseOwner` — `'loop' | 'caller'` — carries ownership and nothing
else. What a release does to claims is not spelled at the loop at all: it
addresses the run it drove, and `ReleaseRole` owns the disposition that follows.
Three derivations are deleted, not translated onto another session-derived mode:

- `runbook-pipeline`'s activation-kind ternary,
- `goto-workflow`'s `resolveTerminalReleaseModeForRunbook`, which read the
  session's claims,
- `transitions`' restatement of core's resolution kind.

`LifecycleTerminalReleaseMode` goes with them. Core derived it, threaded it
through four private drive methods, and returned it on three outcomes without
ever branching on it — a CLI decision that had taken up residence in the seam.

## What changes for a caller

- An already-terminal loop entry resolves its run-control claim `terminal`, with
  the run's own lifecycle, rather than `superseded` / `claim-rotated`.
- The three frontier refusal arms and the drain's cursor-mismatch refusal remove
  the refused run from session targeting without revoking its claims. Each of
  those refusals leaves the run RUNNING, and RD-829 documents its own
  remediation as "retry" — destroying the authority a retry needs was never
  intended, and followed only from the default arm omitting retention. Under
  `caller` ownership these arms release nothing at all, exactly as they did
  before: what they report there is #833's question, not this one's.
- A drain that reaches terminal now releases whenever the loop owns the release.
  It used to be gated on the `release-runbook` arm alone, so on `stack-pop`
  nothing released at all: the drain writes no session state of its own, and no
  healing path removes a loadable terminal run, so a finished run kept resolving
  as the session default. The third arm was never part of that defect —
  `defer-to-caller` released nothing because the inline parent-advance seam
  released instead, which is the one arm of the old union that was right.

## Shape

`applyExecutionTerminalRelease` splits into `releaseTerminalRun` and
`releaseRefusedContinuation`, named for their callers rather than for a mode.
They share one `addressed` release site — before terminality the preserved claim
is live authority, after it the claim is terminal evidence — and differ only in
what a refused release costs: the terminal helper downgrades a `'done'` it can
no longer honour, and the refusal helper has no clean report to protect.

One `loopOwnsRelease` predicate decides ownership for both, exhaustively, so
"not the caller" can never come to mean "the loop" and have the loop release a
second time behind whoever actually owns it.

Closes #781 and #789. No deprecated aliases, compatibility adapters or lint bans
were added; the old names are simply gone.
