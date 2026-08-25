---
'@rundown-org/cli': minor
---

# Make execution-loop progression explicit

`runExecutionLoop` now returns a status object and uses the shared
`status: 'refused'` discriminant for Refusal Hand-back. Inline composition also
has an ownership-neutral `handled` / `blocked` statuses: synchronous child
flow-back already drove the enclosing progression, so the resumed frame stands
down instead of walking the same ancestors again while preserving
success/failure.

Run Release is deliberately absent from the result. Terminal state and its
addressed release commit atomically; callers observe progression and never claim
release ownership. `ExecutionLoopOptions.sessionService` remains injectable so
integration tests can observe one launch/session boundary.
