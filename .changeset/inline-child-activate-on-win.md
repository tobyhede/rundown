---
'@rundown-org/core': minor
'@rundown-org/cli': patch
---

# Activate an inline child only once its launch is won

Core's bare inline-child reactivation seam pushed the child onto the session
before returning the parent for the CLI's loop to drive. That push was
speculative. The seam matches on a running child whose linkage names the
parent's current frame, and it does not consult the launch latch — so it cannot
distinguish an interrupted launch from a live owner mid-launch. The two are one
process's launch at two moments, and the seam had already activated the child by
the time the launch span discovered which one it was looking at.

Only one of the launch span's six outcomes undid it. `already-latched` popped
the activation back off; `missing`, `inactive`, `superseded`, `linkage-refused`
and `unrecorded` all returned with the child still targeted by a session
belonging to a process that had just refused to execute it. The CLI also
mirrored the store's push decision in a local boolean, read back later to decide
whether to roll the activation back — a decision derived from an unlocked
`getActive` that a concurrent push could invalidate before the rollback read it.

The fix is not to undo the push five more times. It is to not make it: the seam
now activates only on the arm where the launch is already finished, and the
launch span activates once the latch has told it the launch is its own. Four
leaking arms stop leaking because there is nothing left to leak, and — the part
five undo calls would not have bought — an arm added later inherits the same
property without doing anything. `releaseStoodDownInlineChild` is deleted.

New `SessionService.pushRunbookIfNotActive` replaces the `getActive`-then-push
pair at both activation sites. It decides "is this run already the top?" inside
the transaction that acts on the answer and returns which way it went, so the
launch span rolls back only an activation it performed itself and the local
boolean is gone.

That method is deliberately unguarded, matching `pushRunbook`. The session
ownership preflight refuses on `runs.exec_token IS NOT NULL` alone, and the
dead-owner probe that reclaims a SIGKILLed owner's lease lives on the
execution-lease acquisition path, never on a session mutation. The caller this
exists for is a span finishing a launch whose owner died, and a child abandoned
mid-execution is precisely the run still holding a lease naming a dead pid —
guarding the write would refuse `execution_in_progress` on exactly the recovery
it is part of. Adding a stack entry also takes nothing away from a run under
execution, which is what the guard protects.

The `superseded` stand-down also gains the diagnostic its `already-latched`
sibling has. Both end the turn as `waiting` having written nothing, and a wait
that never resolves has to be distinguishable from nothing happening.

The invariant is stated in the seam and in `docs/internal/architecture.md` §5,
which documented the old contract: the child is activated only by the launch
span that wins it. It is load-bearing in the other direction too — a winning arm
that executed a child without pushing would leave it running unactivated, and
the operator's next bare command would address the parent instead.
