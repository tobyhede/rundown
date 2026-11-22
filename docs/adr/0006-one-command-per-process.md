# ADR 0006: One command per process

- **Status:** Accepted
- **Date:** 2026-11-23

Every `rundown` command runs in its own operating-system process. The process
starts, reads the run and session state it needs from `.rundown/rundown.db`,
does one command's work, writes its result back, and exits. Nothing a command
keeps in memory survives it, and no later command can depend on it. Every front
end follows this model: the MCP server and the Claude Code plugin hooks start
the CLI as a separate process for each call, rather than loading
`@rundown-org/core` themselves. A host that loads core and handles several
runbook commands in one process, such as an in-process MCP server, an editor
extension or a daemon, is out of scope.

This was implicit until #913. ADR 0005 rejected a long-lived daemon partly
because it "breaks one-invocation-per-command", and the persisted-state design
treats the database as the only state that crosses between commands. But #913's
execution lease added an in-memory registry of running attempts to serve "a
long-lived host (an MCP server)", and its review raised three defects that can
only happen when one process handles several commands (#945, items 4–6). This
ADR states the model so that code is designed against it.

## What a command may assume

- **The database is the only shared state.** Everything another command must see
  is written to `.rundown/rundown.db`, or to the run's files under
  `.rundown/runs/<run-id>/`, before the command exits. In-memory caches,
  registries and module-level state live for one command only.
- **Process memory is gone at exit.** A command needs no cleanup of in-memory
  state on failure. Durable cleanup, such as clearing an execution lease, still
  has to be written.
- **A lease or marker carrying this process's pid was written by an earlier,
  dead process with the same pid.** No other command can be running in this
  process, and Run Progression never classifies its own live lease, so such a
  marker is never this process's work in flight.
- **Process-wide settings belong to one command.** The working directory,
  environment, policy, sandbox settings and the open store are the command's own
  and need not be keyed by run or request.

Commands still run concurrently in _separate_ processes, and the guarantees for
that case are unchanged: one writer per run (ADR 0005), and the execution lease
for the owner's own parallel or retried commands.

The WebContainer dispatcher (`packages/cli/src/services/internal-commands.ts`)
runs a step's `rundown echo` or `rundown prompt` inside the calling process
because WebContainer cannot spawn nested processes. Neither command reads or
writes run state, so this does not break the model. Any command added to that
dispatcher must also leave run state alone.

## Considered Options

- **Support a long-lived in-process host.** Rejected. It would save Node's
  start-up cost on each MCP call, but it would make every process-wide value a
  per-request value (working directory, policy, sandbox, the sql.js driver, the
  lease's pid-based liveness) and would need in-process exclusion between
  concurrent requests. That is the kind of mechanism ADR 0005 removed.
- **Leave the model unstated.** Rejected. Code written for a host that does not
  exist, such as #913's attempt registry, costs maintenance, and its comments
  mislead readers about how Rundown runs.

## Consequences

- #913's in-memory attempt registry (`inFlightAttempts`, `holdInFlightAttempt`)
  will be replaced by the rule above: a lease carrying this process's pid is
  Interrupted (#945, item 4R).
- #945's items 4–6 are closed.
- `docs/internal/concurrency.md` will stop citing a long-lived host as a reason
  for any mechanism.
- A proposal to load core into a long-running process, for example to speed up
  the MCP server, needs a new ADR that supersedes this one. It must first
  account for all process-wide state, not just the execution lease.
