# XState-owned Run Progression rescue

> **Status:** Approved for ticketing.
>
> **Parent:** Epic #850 — Delegation rescue: executable baseline.
>
> **Binding decisions:** ADR 0001 (transaction-owned Run Release), ADR 0002
> (claim-generation fence for inline launch), and ADR 0003 (XState-owned Run
> Progression).

## Problem Statement

Rundown's compiled XState machine owns individual runbook transitions, but the
direct CLI still owns the control system that decides when to drain completions,
project delegation frontiers, enter execution units, dispatch commands, launch
inline children, flow terminal results upward, wait, refuse, or report a
terminal. Six entry paths call that CLI execution loop and then coordinate with
additional status strings and booleans to avoid double propagation.

This split repeatedly makes a fact true in SQLite while the CLI reports
something else. A refusal that committed no terminal can be announced as
`runbook_stopped`; one caller receives refusal data while another receives a
false stopped status; and stale mutation paths can overwrite a newer committed
state. Each local repair adds another option, status, branch, test double, or
follow-up issue because the state machine still does not own Run Progression as
one behavior.

The project needs a rescue, not another compatibility layer. Progression must
have one owner, one behavioral test seam, explicit transaction boundaries, and
a deletion-based finish line.

## Solution

Make each run's existing compiled XState machine own complete **Run
Progression**: driving authored behavior until the composition awaits external
input, hands back a refusal, or reaches a terminal. Inline child launch,
execution, and upward flow-back are part of that same progression.

A core runtime explicitly activates the machine with one verified, run-bound
authority and then mechanically executes machine-selected fenced turns. Each
turn contains at most one durable commit. The domain operation selected by the
machine owns its SQLite transaction; the runtime never holds a generic
transaction across awaited effects. After a commit, its observations are
delivered synchronously before the next effect begins.

Every continuation entry path uses the same core activation and receives one
closed outcome: `waiting`, `completed`, `stopped`, `refused`, or `failed`.
Non-terminal outcomes identify the run where progression yielded, carry a typed
reason, and use one core-owned recovery classification. Frontends provide
native callables and caller evidence, render observations, and map process
exits; they do not decide runbook behavior.

The migration proceeds in vertical slices through this final seam. The first
slice is the real #849 concurrent-fence witness. Each subsequent slice migrates
a complete entry path and deletes the CLI decisions it displaces. There is no
persisted-state migration and no permanent legacy progression abstraction.

## User Stories

1. As a runbook author, I want Rundown to report a stopped run only when the run actually committed a stopped lifecycle, so that output agrees with durable state.
2. As an orchestrator agent, I want a refusal to leave the refusing run running and targeted, so that I retain the authority needed to recover or retry.
3. As an orchestrator agent, I want every non-terminal outcome to identify the run that yielded, so that I do not have to infer it from a nested event stream.
4. As an orchestrator agent, I want every `waiting` outcome to carry a typed reason, so that I know whether to provide input, wait for delegated work, or resume an inline child.
5. As an orchestrator agent, I want every `refused` outcome to carry one canonical reason and recovery classification, so that I do not retry a permanent refusal or abandon a transient one.
6. As an orchestrator agent, I want every expected invocation failure to be typed, so that infrastructure failure is not confused with runbook terminality.
7. As an orchestrator agent, I want unknown defects and corrupt persisted state to fail loudly, so that they are not hidden behind a generic recoverable result.
8. As a CLI user, I want a command that loses an execution fence to report the refusal without emitting `runbook_stopped`, so that the command's account matches SQLite.
9. As a CLI user, I want a broken output renderer to halt before the next effect, so that Rundown does not continue silently after losing its reporting channel.
10. As a CLI user, I want a reporting failure to leave the run at its last committed boundary, so that I can inspect and explicitly resume it.
11. As a CLI user, I want restoring or inspecting a persisted run to be inert, so that read-only operations cannot execute commands or launch children.
12. As a CLI user, I want an explicitly activated run to continue until it waits, refuses, or terminates, so that I do not manually pulse internal transitions.
13. As an inline-composition author, I want child launch, child execution, and parent flow-back to behave as one progression, so that intermediate call frames cannot double-advance the parent.
14. As an inline-composition author, I want a child terminal to remain committed if an ancestor later refuses, so that an ancestor refusal cannot erase completed child work.
15. As an inline-composition author, I want the final outcome to describe the composition's stable condition, so that a child completion followed by a parent prompt reports `waiting`, not a misleading intermediate terminal.
16. As a delegation orchestrator, I want frontier projection and consumption to remain bound to verified run authority, so that progression cannot disclose credentials under mismatched claims.
17. As a delegation orchestrator, I want claim generation and delegation capabilities carried as one verified authority, so that independently supplied values cannot disagree.
18. As a frontend integrator, I want one core Run Progression activation, so that CLI, MCP, and plugin frontends do not implement their own control loops.
19. As a frontend integrator, I want observations and final outcomes to have distinct roles, so that events describe the path while the outcome reliably controls the caller.
20. As a frontend integrator, I want process exit mapping to remain frontend-owned, so that core domain decisions do not depend on one transport.
21. As a maintainer, I want XState to decide every progression action, so that moving code into the core package cannot create another shadow state machine.
22. As a maintainer, I want one durable commit per fenced turn, so that every crash boundary and concurrency refusal is explicit.
23. As a maintainer, I want the selected domain operation to own its transaction, so that SQLite transactions never span subprocesses or other awaited effects.
24. As a maintainer, I want completion application, command execution, and inline launch to reuse their existing atomic seams, so that the rescue does not rebuild solved concurrency machinery.
25. As a maintainer, I want each committed transition reported before another effect begins, so that tests and operators observe the same causal order.
26. As a maintainer, I want an incremental migration that remains green after each slice, so that the rescue can land without a high-risk big-bang branch.
27. As a maintainer, I want every migration slice to delete displaced CLI decisions, so that temporary duplication cannot become permanent architecture.
28. As a maintainer, I want the first slice pinned by #849's genuine concurrent writer, so that the new seam proves behavior under a real race rather than mocks.
29. As a maintainer, I want #833 to pass through the same unconditional Refusal Hand-back path, so that frontier refusal and fence refusal cannot diverge again.
30. As a maintainer, I want the migration complete only when the old execution loop and its coordination statuses are gone, so that success is measured by reduced complexity rather than added abstractions.
31. As a test author, I want the public core activation to be the primary behavioral seam, so that tests survive internal statechart refactoring.
32. As a test author, I want real SQLite, lease, CAS, and transaction behavior in concurrency witnesses, so that mocked module boundaries cannot make a race invisible.
33. As a future contributor, I want the machine state schema version changed when state IDs or opaque snapshot context change, so that incompatible development state is rejected rather than adapted.
34. As a future contributor, I want unrelated Epic #850 improvements kept outside this rescue, so that progression ownership reaches completion before new architecture work starts.

## Implementation Decisions

- **Domain meaning.** Run Progression drives a run through authored behavior until the composition awaits external input, hands back a refusal, or reaches a terminal. Inline composition is included; generic “execution loop” terminology is retired.
- **Behavior owner.** Progression states live in each existing compiled runbook machine. No second durable coordinator machine and no ordinary core service may decide what happens next.
- **Explicit activation.** Loading and restoring machine state are inert. An allowed mutation or continuation explicitly activates progression; once activated, XState decides every subsequent action until it yields a final outcome.
- **Unified ingress.** Fresh run, pass/fail continuation, goto continuation, post-collect continuation, resumed inline child, and inline upward flow-back converge on the same activation path. Their initiating events may differ, but none owns a private progression loop.
- **Authority.** Frontends supply caller evidence. Core verifies it and constructs one run-bound progression authority that cannot disagree about target run, claim generation, or delegation capabilities.
- **Composition outcome.** The returned outcome describes the final stable condition of the whole inline progression. Intermediate child terminals remain observations, not competing control outcomes.
- **Ancestor refusal.** If a child terminal committed before an ancestor refusal, the child remains terminal. The outcome reports the refusing ancestor, leaves that ancestor running and targeted, and emits no terminal observation for it.
- **Closed outcome.** The only semantic arms are `waiting`, `completed`, `stopped`, `refused`, and `failed`. `Stopped` is reserved for an actual stopped lifecycle. Coordination-only statuses and booleans do not cross the activation interface.
- **Typed non-terminal information.** `Waiting`, `refused`, and `failed` identify the responsible run and carry exhaustive typed reasons. Core derives one machine-readable recovery classification from the reason; frontend adapters do not infer remediation from messages.
- **Failure boundary.** Enumerated invocation-layer disruptions may return `failed`. Execution contention and other no-apply conditions return `refused`. Invalid persisted state, violated programming invariants, and genuinely unknown failures remain exceptions rather than being normalized into a generic failure.
- **No event replay ledger.** A failed observation ends the invocation at the last committed state. The next activation reports current durable state and continues; it does not replay historical events from a durable outbox.
- **Fenced turns.** Progression advances through machine-selected turns containing at most one durable commit. Pure XState transitions may compose within a turn, but the next external effect cannot begin until the commit and its observations are complete.
- **Transaction ownership.** The selected domain operation owns its transaction. Completion application retains its compare-and-swap cycle; command execution retains capture, execution lease, effect, and commit; inline launch retains compare-and-latch; terminal mutation retains transaction-owned Run Release.
- **Observation backpressure.** The machine delivers observations synchronously after their commit and before the next effect. Observation delivery failure changes no run lifecycle and returns the typed invocation failure.
- **Runtime dependencies.** Process state, service references, credential callables, filesystem resolution, command runners, and observation delivery flow through machine-construction and invoke-input closures. Persisted context contains data only.
- **Existing seams first.** Deepen the current one-completion apply, re-entry projection/consume, execution-unit entry, command actor, effectful mutation runner, inline-launch intent, and upward-propagation seams. The rescue does not duplicate their decisions.
- **Frontend responsibility.** Frontends parse native arguments, gather caller evidence, provide native effect callables, subscribe and render observations, flush output, and map the closed outcome to their process or protocol result.
- **Migration.** Use vertical slices through the final activation. The first tracer is #849. Each later slice migrates one complete continuing entry path and deletes the CLI decisions it replaces. Temporary bridge events must have explicit removal work and cannot become protocol surface.
- **Schema policy.** If progression states change XState state IDs or opaque snapshot context, increment the persisted schema version and re-record the structural fixture. Existing development runs are rejected and restarted; no migration, fallback, or compatibility shim is permitted.
- **Deletion finish line.** Completion requires removing the CLI execution loop, the CLI completion-drain loop, optional refusal hand-back, coordination-only statuses and booleans, CLI frontier/inline/upward progression decisions, and all progression mutation through the unfenced legacy actor path.

## Testing Decisions

- **Primary behavioral seam.** Test one public core Run Progression activation using the compiled machine, real SQLite-backed state, real compare-and-swap, real execution leases, injected deterministic effect callables, and a synchronous observation sink.
- **Observable assertions only.** Progression tests assert durable run/session state, ordered observations, closed outcomes, refusing run identity, and recovery classification. They do not pin private XState state IDs or the internal number of pure transitions.
- **#849 first tracer.** Preserve the real concurrent-writer setup. The test must prove the fence refusal occurred, the parent remains running and targeted, the outcome is a typed refusal, and no stopped lifecycle observation is emitted.
- **#833 refusal agreement.** Preserve the frontier-authority witness. It must reach the same Refusal Hand-back behavior as #849: typed refusal, running durable state, retained targeting, and no false terminal.
- **Activation safety.** Test that loading, restoring, status inspection, and other read-only paths produce no command, launch, mutation, or observation side effect until explicit activation.
- **Turn ordering.** Test commit-before-observation and observation-before-next-effect with a recorder around the real persistence seam. A throwing observation sink must prevent the next effect while leaving the previous commit intact.
- **No replay.** After observation delivery fails, a new activation reports current state and continues without replaying the failed historical transition.
- **One-commit boundary.** Exercise completion application, fenced command execution, inline-launch latch, and terminal Run Release as separate turns. Tests should fail if a turn crosses two durable commits or starts the next effect before reporting the prior one.
- **Composition behavior.** Test child terminal followed by parent waiting, child terminal followed by ancestor refusal, and full-chain terminal propagation. The final outcome describes the composition while observations retain each run's committed transitions.
- **Authority coherence.** Test that progression accepts only core-verified run-bound authority and that a stale or mismatched claim generation refuses before any effect.
- **Typed result coverage.** Exhaustively exercise `waiting`, `completed`, `stopped`, `refused`, and `failed`, including every reason introduced by the migrated slice. Unknown errors and invalid persisted state must escape rather than be relabeled.
- **Thin frontend tests.** CLI tests cover caller-evidence translation, ordered rendering, output flushing, and exit mapping. They do not mock and re-test the machine's progression decisions.
- **Existing focused tests.** Retain lower-level coverage for completion application, the effectful mutation runner, transition observation, inline launch fencing, and pure XState transitions. Do not create a second mocked progression suite.
- **Real race coverage.** Any exclusion or concurrency claim must have a real SQLite or multi-process witness. Stubbing a mocked module boundary is not evidence of the race.
- **Migration coverage.** Every migrated entry path receives one end-to-end test through the public activation before its former CLI branch is deleted.
- **Schema guard.** If state IDs or snapshot context change, update the persisted-state shape fixture and assert the former schema is rejected rather than adapted.
- **Final contraction.** Source-level assertions may pin deletion of the old execution loop and coordination symbols after all callers migrate; behavioral coverage remains at the public activation and frontend seams.

## Out of Scope

- The global error-code registry and command-schema repair beyond progression reasons required by this spec.
- A codebase-wide refusal taxonomy unrelated to Run Progression.
- Run Release batch hardening tracked by #847/#838; this work preserves ADR 0001 but does not expand it.
- Run-status projection work tracked by #769.
- Delegation-liveness unification tracked by #659/#676.
- Cross-transport error-envelope work tracked under #798/#806.
- Abandoned delegation outcome reporting, single-cursor documentation, mutation tooling, and other sequenced Epic #850 work.
- Event sourcing, a durable observation outbox, exactly-once observation delivery, or historical event replay.
- Persisted-state migration or compatibility behavior for development runs written by older machine versions.
- Changing CLI syntax, adding a public `progress` command, or making read-only operations activate a run.
- Replacing SQLite transactions, execution leases, compare-and-swap, or the existing Run Release decisions.

## Further Notes

- This is a rescue operation. New abstractions are justified only when they establish the final machine-owned seam or permit deletion of an existing progression branch.
- The first implementation slice is #849 because it is a reachable concurrency failure exercising collect continuation, the command fence, Refusal Hand-back, observation truth, and the closed outcome in one vertical path.
- #833 follows through the same refusal path; it must not introduce a frontier-specific progression interface.
- #684 is relevant only where a migrated progression path would otherwise retain the unfenced legacy mutation. Broader actor-mutation cleanup remains separately ticketed unless it directly blocks deletion.
- Existing ADRs remain binding: terminal Run Release stays inside the transaction that commits terminal state, and inline launch remains fenced by the parent's captured claim generation.
- Success is measured by the disappearing CLI control system and passing executable witnesses, not by the number of new modules, documents, or issues created.
