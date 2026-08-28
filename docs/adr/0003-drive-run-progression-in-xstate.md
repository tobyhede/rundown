# ADR 0003: Drive Run Progression in XState

Run Progression was divided between the compiled runbook machine and the CLI
execution loop, forcing frontends to decide completion draining, command
dispatch, inline composition, upward flow-back, and refusal control. Each run's
existing compiled XState machine owns complete Run Progression, including inline
composition, and every continuing operation converges on its explicitly
activated path using one core-verified, run-bound authority; restoring a machine
is inert. Between durable transitions and effects the machine synchronously
delivers observations and waits; delivery failure fails only the invocation at
the last committed boundary without changing lifecycle, and historical events
are not durably replayed because persisted run state remains authoritative.

## Consequences

Run Progression returns one closed outcome: `waiting`, `completed`, `stopped`,
`refused`, or `failed`. `Stopped` is reserved for an actual stopped lifecycle;
it is never a generic rendering of refusal or invocation failure, and temporary
coordination statuses such as `handled` and `blocked` do not cross the machine
interface. Every non-terminal outcome identifies the run where progression
yielded and carries a typed reason; core derives one exhaustive recovery
classification from that reason, while frontends only render it and map their
own process exits.

Progression advances through fenced machine turns with at most one durable
commit per turn. Pure XState transitions may compose around that boundary, but
the next external effect waits for the commit and its observations; the invoked
domain operation owns its specific SQLite transaction, while the progression
runtime never opens a generic transaction across awaited effects.
