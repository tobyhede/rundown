# Plugin / MCP Caller-Evidence Subprocess Boundary — Design

> **Status:** prospective design for Task 5 of
> `docs/superpowers/plans/2026-06-28-core-lifecycle-command-seam.md`.
> Implemented in this cycle. Pins the subprocess trust boundary that must land
> **before** Tasks 6/7 stamp any direct-CLI call as `{ kind: 'direct_cli' }`.

## Problem

After Tasks 6/7, a bare (default-target) `rd pass` / `rd fail` / `rd delegate`
maps caller evidence to `{ kind: 'direct_cli' }`, which core resolves to a
`trusted_run_controller` actor context — full orchestrator trust over the active
run.

The Claude plugin (`packages/claude-code-plugin/src/workflow/hooks/rundown.ts`)
and the MCP server (`packages/mcp/src/tools.ts`) reach the CLI by **spawning a
subprocess** (`execFileSync('node', [cliPath, ...args])` and
`execFile(npx, ['--no', 'rundown', ...args])` under a 30s per-call timeout — the
contract in `docs/reference/mcp.md` — respectively). Typed `CallerEvidence`
cannot cross that process boundary: the subprocess arrives at the CLI as an
ordinary `argv`, indistinguishable from a human at a terminal. So a
plugin/MCP-spawned bare `rd pass` would **silently inherit direct-CLI trust** it
was never granted.

The CLI process cannot itself tell a plugin-spawned bare `rd pass` from a
human-run one — both are the same `argv` in the same process. Therefore the
boundary cannot live inside the CLI bare path. It must live **in the spawning
frontend**, which is the only party that knows the call originates from an
untrusted subprocess context.

## Constraints (from the plan + contract)

- **No source labels.** Do not add `--actor-source` or `RD_ACTOR_SOURCE`, and do
  not reintroduce any equivalent. A source label is an assertion, not evidence.
- **Preserve `--claim-id` claim-evidence mutations.** `rd pass --claim-id <id>` /
  `rd fail --claim-id <id>` are `claim_controller` mutations whose evidence
  (`claimId`, `tokenHash`, `controlledRunId`) is reconstructable CLI-side from
  the resolved claim record — no `direct_cli` trust is involved, and the
  resolver's early `--claim-id` return bypasses the `actor_context_required`
  gate. The plugin delegation workflow depends on this: delegated children are
  instructed to run `rd pass --claim-id` / `rd fail --claim-id`
  (`delegation-dispatch.ts`). Blocking that form would regress delegated-child
  completion, so it MUST stay allowed.
- **Preserve the MCP environment-inheritance rule.** The MCP CLI facade inherits
  the server process environment unchanged; this boundary adds no env mutation
  and reads no env for trust.
- **Read-only / inspect commands are unaffected.** `status`, `ls`, `check`,
  `run`, `claim`, `collect`, `goto`, `complete`, `stop`, etc. continue to shell
  out normally. Only the three role-specific lifecycle **mutation** commands are
  in scope.

## Decision: fail-closed blocking at the frontend (option 3)

The plan offers three implemented shapes. For this cycle we take **option 3**:
plugin/MCP role-specific mutation is **blocked** when it would carry only
`direct_cli` trust, until a purpose-built in-process evidence ingress exists
(future work). We do **not** build a new CLI evidence ingress this cycle, and we
do **not** pass `CallerEvidence` across the process boundary.

This is the minimal, fail-closed boundary that satisfies the plan's ordering
requirement ("implement the boundary before CLI migration"). A richer in-process
core API that accepts `CallerEvidence` directly (option 1) remains open as
follow-up; it is out of scope here.

### Blocking scope

A call is **blocked** iff it is a *bare role-specific lifecycle mutation*:

- the command (argv[0]) is one of `pass`, `fail`, `delegate`; **and**
- the argv carries **no** `--claim-id` (neither `--claim-id <v>` nor
  `--claim-id=<v>`).

Rationale: the only trust available to a bare pass/fail/delegate is
`direct_cli`. `--claim-id` carries independent claim evidence and is therefore
*not* bare. `delegate` has no claim form, so every subprocess `delegate` is bare
and blocked. `--step` / `--index` targets are still default-run mutations whose
only trust is `direct_cli`, so they are bare and blocked too.

### Single source of truth

The predicate lives in core
(`packages/core/src/runbook/subprocess-mutation-boundary.ts`,
`bareRoleSpecificMutation(argv) -> 'pass' | 'fail' | 'delegate' | undefined`) so
both frontends share one definition of the boundary rather than duplicating
security-relevant logic. It is a pure function over `argv` strings — no coupling
to CLI internals, no env reads, no source labels. Core already owns the
evidence/trust model (`actor-context.ts`), so the boundary's structural
definition belongs there.

Both frontends construct **canonical** argv (`pass` / `fail` / `delegate`, not
aliases): MCP maps tool names directly; the plugin's only mutation path would be
canonical. Aliases are therefore out of scope for the predicate.

## Frontend wiring

### MCP (`packages/mcp/src/tools.ts`)

In the tool handler, after `buildRundownCommand` and before `runCli`, apply
`bareRoleSpecificMutation`. When it matches, return a structured MCP error
envelope (one JSON text block, per spec §6.2) naming the command and the
`--claim-id` alternative — the CLI is never spawned. `buildRundownCommand` stays
pure (still builds the argv); the guard is the dispatch gate.

### Plugin (`packages/claude-code-plugin/src/workflow/hooks/rundown.ts`)

`rundown()` is the single choke point for every plugin→CLI spawn. Apply
`bareRoleSpecificMutation(args)` at entry; when it matches, **throw** a clear
error (fail-closed) instead of spawning. The plugin only spawns read-only
`status` today, so this is primarily a defensive invariant that also future-
proofs the choke point. `--claim-id` forms and read-only commands pass through
unchanged.

## What this is NOT

- Not a new evidence ingress. No new flag, env var, or argv channel carries
  trust.
- Not a change to the CLI bare path. The CLI still treats a bare `rd pass` as
  `direct_cli` for a genuine human invocation; the frontends simply refuse to
  *produce* such a subprocess call.
- Not a block on `--claim-id`, read-only, or inspect commands.

## Tests

- core: `bareRoleSpecificMutation` table + property coverage (pass/fail/delegate
  bare → blocked; `--claim-id` and `--claim-id=` → allowed; read-only → allowed;
  empty argv → allowed).
- MCP: bare `pass`/`fail`/`delegate` tool calls return the block envelope and do
  not invoke `runCli`; `--claim-id` `pass`/`fail` still spawn; read-only tools
  unaffected.
- plugin: `rundown()` throws on bare `pass`/`fail`/`delegate`; allows
  `--claim-id` forms and `status`.
