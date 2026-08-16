---
'@rundown-org/core': patch
'@rundown-org/cli': patch
---

# Undo a stood-down inline activation with a conditional pop, not a pre-read

Standing down from an inline launch another process owns has to undo the session
push core's reactivation seam may have made. It did that by resolving the stack
top with `getActive` and then calling the positional `popRunbook` — the #666
check-then-act shape, which `stash` was fixed for and which this path
reintroduced.

The two steps read different snapshots. `getActive` is an unguarded
`loadSession` + `load`; `popRunbook` re-reads the session inside its own
`BEGIN IMMEDIATE` and pops whatever `defaultStack` ends in **by then**. So a run
pushed in between is the run that gets popped.

That is not a leaked activation, which is what the swallowed-error policy on
this path is licensed for. `projectRunbookRelease` deletes every claim
controlling the run it removes, and `rundown run` pushes-and-mints atomically
precisely so a stack entry never exists without its controlling claim — so the
wrongly popped run loses the run-control bearer its orchestrator is still
holding, and every later `--claim-id` resolves `missing`. There is no gesture
that puts it back.

The arm's own precondition is what makes this reachable rather than theoretical:
it runs only when a **live** process owns the launch, so a concurrent writer is
guaranteed, and the default stack is one project-global row every `rundown`
process in the cwd shares. `mutateSessionGuarded` narrows the window — an
execution-owned top refuses `execution_in_progress` — but a top that is pushed
and not yet leased, or never leased, goes straight through.

`SessionService.popRunbookIfActive(expected)` (new, exported from
`@rundown-org/core`) decides the whole question inside the guarded transaction
and removes the run only while it is still the top, returning `popped` or a
domain `not-active` carrying whatever displaced it. Its affected-run selector
names `expected` only when `expected` already holds the top, so a mismatch
degrades to `not-active` rather than to an `execution_in_progress` refusal
naming a foreign run the call was never going to touch.

`not-active` carries `activeRunbookId` for diagnosis, and because it is what
lets a test assert the decision was made against the post-push snapshot; no
caller renders it today, and both inline sites treat every committed answer
alike.

`releaseRunbook` is deliberately not the fix: it filters the id out of the stack
at **any** depth, so an undo meant as "only if still active" would still reach a
child a concurrent push has since buried.

Both inline sites move over — the `already-latched` stand-down and the
consume-failure rollback, which carried the same two-call shape.

Not every positional pop, though: the execution loop's terminal `stack-pop`
still calls `popRunbook()` with the run it means to release in scope and never
compared. It has no pre-read, so it is not this defect, but it can remove a
foreign run pushed-and-minted and not yet leased. Tracked separately.

Pinned by a real two-process race in `session-service.process.test.ts`: with the
push holding the transaction and the conditional pop contending, the previous
shape pops the **foreign** run, and the new one declines. Per this repo's own
note, only a real multi-process test observes this — every sequential test stays
green either way — so the CLI adds structural assertions that the `getActive` +
`popRunbook` pair is absent.
