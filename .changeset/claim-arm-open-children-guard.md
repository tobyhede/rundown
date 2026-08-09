---
'@rundown-org/core': patch
---

# Guard the `--claim-id` arm against a racing child claim

`rundown pass --claim-id` / `rundown fail --claim-id` now reach the same
in-transaction open-delegated-children guard that bare and `--run` transitions
already used. Previously the claim arm computed its guard flag from the
resolution shape and excluded claim-shaped resolutions entirely, so it committed
through the unguarded path: a child claim that landed after the resolver's
pre-check and before the decisive write was not seen, and the parent advanced
over an open child.

This is the arm that matters in practice. On a delegation-exposed run a bare
mutation is refused `ACTOR_CONTEXT_REQUIRED` and `--run` cannot carry a bearer,
so `--claim-id` is the only invocation the post-R1 protocol leaves an
orchestrator — the guarded shapes were the ones it could not reach.

A delegated-child bearer stays exempt, mirroring the existing pre-check
exemption: the guard reads `claims WHERE parent_run_id = <target>`, and RD-819
refuses nested delegation, so that set is provably empty.

No new error code and no output-schema change: `OPEN_DELEGATED_CHILDREN` already
surfaced on this arm via the non-transactional pre-check. What changes is that a
claim committing inside the window is now refused rather than silently
overwritten. The refusal is write-free — the guard aborts the transaction before
its first UPDATE, so the run is left usable and is not parked in recovery.

Closes the last of #608's seven atomicity paths.
