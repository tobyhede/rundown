---
'@rundown-org/core': major
'@rundown-org/cli': major
---

# Atomic Run Release, and a finished run keeps its claim

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

No release owner crosses execution frames. A transition capable of terminalizing
the addressed run arms its transaction-owned Run Release; `ReleaseRole` decides
claim disposition. Three session-derived modes are deleted:

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
- Frontier and drain refusals apply no terminal transition, leave the running
  run targeted, and preserve its authority for retry/recovery. Refusal Hand-back
  changes reporting only; it never claims terminality or releases the run.
- A drain that reaches terminal now projects its addressed release atomically.
  It used to be gated on the `release-runbook` arm alone, so on `stack-pop`
  nothing released at all: the drain writes no session state of its own, and no
  healing path removes a loadable terminal run, so a finished run kept resolving
  as the session default. The third arm was never part of that defect —
  `defer-to-caller` was migration scaffolding and is removed by the atomic fold.

## Shape

Terminal state and addressed release commit together. Re-entrant inline
flow-back returns `handled` or fail-closed `blocked`, which makes enclosing
frames stand down without repeating the upward walk. The public execution-loop
result carries progression only, never a release disposition.

Closes #781 and #789. No deprecated aliases, compatibility adapters or lint bans
were added; the old names are simply gone.
