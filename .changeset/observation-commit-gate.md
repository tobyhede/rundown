---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

Observation delivery is now the commit gate for Run Progression. During an
explicit activation, each durable commit's observations are delivered
synchronously through the caller's sink before any subsequent effect may begin.
A throwing sink ends the activation with the typed `failed` outcome
(`observation_delivery_failed`, retryable): the committed turn stays durable, no
terminal lifecycle is synthesized, and a later activation resumes from current
durable state without replaying delivered or failed observations — no outbox,
replay log, or event-sourcing subsystem is introduced. Loading, restoring, and
read-only inspection remain inert until activation. The `rundown collect`
continuation maps the failure fail-closed: a broken renderer exits non-zero
under a best-effort `OBSERVATION_DELIVERY_FAILED` error envelope while the run
rests at its last committed boundary. That envelope is flushed at its render
point, so it still precedes the deferred collect action object and the "action
object is the last JSON line" contract holds; and once the channel has reported
itself broken, the command's remaining renders are best-effort too — a channel
that stays broken can no longer unwind the typed failure into the RD-999
unknown-error envelope.

The gate holds uniformly across the frontend-supplied composition callables:
core hands each callable the gated sink at invocation, core exports
`ObservationDeliveryError` as the typed signal for a reporting-channel failure
inside a callable, and the CLI adapters gate the output channel they hand into
the launch span and the propagation walk. Propagation and flow-back folds now
preserve a refusing condition's registered code and boundary-derived recovery (a
consume-failed frontier stays retryable through every fold), exit-flipping
refusals always carry a diagnostic in the stream, and the terminal-at-activation
path surfaces a propagation refusal over a retryable release refusal instead of
discarding it.
