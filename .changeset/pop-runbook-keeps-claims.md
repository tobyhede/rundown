---
'@rundown-org/core': patch
---

# Undoing an inline-child activation no longer revokes the child's claim

`SessionService.popRunbookIfActive` undid a stack push by calling the general
release primitive, `projectRunbookRelease`, with no options — so
`retainClaimsAsTerminal` was falsy and every claim controlling the run was
revoked. But the operation being undone is `defaultStack.push(id)`, which mints
nothing and never reads `session.claims`. The undo disposed of authority the
push never created (#788).

That was irrecoverable, not merely wrong. The pop's one caller is the inline
launch rollback in the CLI, reached only when a process reclaims an interrupted
launch from a dead owner and the intent consume then throws. The child at that
moment is live, non-terminal, and survives the rollback — the next attempt
resumes it. But `adoptRunControlClaim` refuses to re-mint once that child has
issued a delegation, because the replacement could not reproduce the
credentials. So the child ran unarmed, the machine's `actor_context_required`
refusal stood permanently, and nothing addressed the run again. The holder was
not even told the truth about it: a revoked claim is tombstoned `superseded` and
resolves as `claim-rotated`, a rotation that never happened.

The fix is a new `projectStackPop` beside `projectRunbookRelease`, and its
narrowness is the guarantee rather than a style choice. It takes the stack array
alone, not `SessionData`, so it cannot revoke a claim or clear a stash slot —
today, or after a later edit that forgets why it must not. A release policy
carried as an option can be omitted, and omission reads as the destructive
direction; that is the same failure mode the `ReleaseRole` vocabulary removes
from the sixteen terminal-release call sites, applied here by deleting the
parameter instead of defaulting it.

It removes the **topmost** occurrence only. `session_stack` has no uniqueness
constraint and cannot gain one — an existing session carrying a duplicate would
become impossible to load, with `prune` as the only recovery, which the
no-migration rule forbids — so a run can legitimately sit lower in the stack,
and undoing one push must leave that entry alone. `projectRunbookRelease`
filters every occurrence, which is right for a release and wrong for an undo.

The method stays `mutateGuarded`. A stack-only projection issues no guarded
statement, so `execution_in_progress` and `recovery_required` are now
unreachable through this path, and the argument for deleting them is strong: the
preflight refuses on `exec_token IS NOT NULL` with no liveness probe, and this
method's only caller is the crash-recovery path where the child provably holds a
lease naming a dead pid — so the guard can only refuse where the undo must run,
leaving the child pushed after a failed launch. It is held back deliberately.
Both refusals come from one loop in `mutateSessionGuarded`, so the seam cannot
keep one and drop the other, and `recovery_required` is the arm the symmetry
argument covers least well. It wants a stale-lease test and a multi-process
test, not more argument. This projection is what makes that removal a no-op
rather than a lossy edit.
