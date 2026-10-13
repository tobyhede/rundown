# Rundown CLI Reference

This document is the user reference for the Rundown CLI (`rundown` / `rd`):
installation, quick start, command reference, and common tasks. For execution
model and runtime semantics, see [docs/reference/runtime.md](runtime.md).

**See also:**

- [docs/reference/cli-help.md](cli-help.md) — generated `--help` output for
  every command; the authoritative flag list
- [docs/spec/cli-output.md](../spec/cli-output.md) — JSON and text output shapes
  for every command, including error envelopes
- [docs/spec/language.md](../spec/language.md) — Rundown specification
- [docs/spec/grammar.md](../spec/grammar.md) — Format grammar and expansion
  rules

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
  - [Runbook Discovery](#runbook-discovery)
- [Security Policy](#security-policy)
  - [Quick Reference](#security-quick-reference)
- [CLI Commands](#cli-commands)
  - [Run Ownership](#run-ownership)
  - [Runbook Lifecycle](#runbook-lifecycle)
  - [State Transitions](#state-transitions)
  - [Status Commands](#status-commands)
  - [Artifact Commands](#artifact-commands)
  - [Validation](#validation)
  - [Maintenance](#maintenance)
  - [Testing and Utilities](#testing-and-utilities)
- [Common Tasks](#common-tasks)
- [Output Format](#output-format)
  - [Standard Output Structure](#standard-output-structure)
  - [Table Output](#table-output)
  - [Detail Views](#detail-views)
  - [Command Execution Output](#command-execution-output)
  - [Key Elements](#key-elements)
- [Troubleshooting and Error Handling](#troubleshooting-and-error-handling)
  - [Common Errors and Resolutions](#common-errors-and-resolutions)
  - [State Recovery](#state-recovery)
- [Integration with Claude Code](#integration-with-claude-code)
- [CLI Quick Reference](#cli-quick-reference)

---

## Installation

```bash
npm install -g @rundown-org/cli
```

Verify installation:

```bash
rundown --help
```

Use `rundown` for every command. The package also installs a short `rd` binary
pointing at the same CLI, but oh-my-zsh ships a core `alias rd=rmdir` that
shadows it (shell aliases beat `PATH`), so **`rd` is unreliable** — prefer
`rundown`. On oh-my-zsh, restore the short name by adding `alias rd=rundown` to
`~/.zshrc` **after** oh-my-zsh loads.

---

## Quick Start

**Run a runbook:**

```bash
# Using an absolute path
rundown run /path/to/project/.rundown/runbooks/simple.runbook.md

# Or from the project root, with runbook in the standard location
rundown run simple.runbook.md
```

The CLI resolves runbook paths in this order:

1. Absolute path (used as-is)
2. Relative to current working directory
3. By name via the discovery chain: project (`.rundown/runbooks/`), then plugin
   (`$CLAUDE_PLUGIN_ROOT/runbooks/`), then bundled (CLI package
   `dist/runbooks/`) — see [Runbook Discovery](#runbook-discovery) below for the
   full priority table

`rundown run` prints the run's **Owner Token** once, as `owner_token` on the
first (`runbook_started`) event. Keep it: every command that changes the run
needs it (see [Run Ownership](#run-ownership)).

### Runbook Discovery

When a runbook is referenced by name (rather than an explicit path), the CLI
searches multiple sources in priority order:

| Priority    | Source  | Location                        |
| ----------- | ------- | ------------------------------- |
| 1 (highest) | Project | `.rundown/runbooks/`            |
| 2           | Plugin  | `$CLAUDE_PLUGIN_ROOT/runbooks/` |
| 3           | Bundled | CLI package `dist/runbooks/`    |

Directories are scanned recursively, so nested layouts like
`planning/write-plan.runbook.md` are supported.

**Namespace syntax** — Use `namespace:name` to target a specific source
explicitly:

- `write-plan` — resolves via the priority chain above
- `rundown:write-plan` — explicit: from the plugin source only

`rundown ls --all` lists discoverable runbooks with a `SOURCE` column indicating
where each was found (`project`, `plugin`, or `bundled`).

**Check status:**

```bash
rundown status                # List every run
rundown status --run <run_id> # Show one run in detail
```

**Progress through steps:**

```bash
rundown pass --token <owner_token> --step 1   # Step 1 succeeded, apply PASS transition
rundown fail --token <owner_token> --step 1   # Step 1 failed, apply FAIL transition
```

**Stop a runbook:**

```bash
rundown stop [message] --token <owner_token>
```

---

## Security Policy

Rundown enforces a security policy layer to control what commands, files, and
environment variables runbooks can access. See
[docs/reference/security.md](security.md) for full default policy details,
including command allow/block/prompt behavior, sandbox-on-by-default
enforcement, and the default write allowlist.

### Security Quick Reference

| Flag                    | Effect                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `--allow-run <cmds>`    | Allow specific commands (comma-separated)                                                |
| `--allow-read <paths>`  | Allow reading specific paths                                                             |
| `--allow-write <paths>` | Allow writing to specific paths                                                          |
| `--allow-env <vars>`    | Allow specific environment variables                                                     |
| `--allow-all`           | Bypass all policy checks                                                                 |
| `--deny-all`            | Block all operations not explicitly allowed                                              |
| `-y, --yes`             | Auto-approve prompts                                                                     |
| `--non-interactive`     | CI mode (auto-deny unlisted commands)                                                    |
| `--policy <file>`       | Use custom policy file                                                                   |
| `--trust-js-policy`     | Trust an explicitly selected JS policy file and helper modules declared by policy config |
| `--helpers <paths>`     | Helper module paths to load (comma-separated, relative to project root)                  |
| `--sandbox`             | Enable OS-level filesystem sandbox (default)                                             |
| `--no-sandbox`          | Disable sandbox enforcement; a general sandbox opt-out                                   |
| `--sandbox-strict`      | Fail if sandbox is unavailable (default; explicit affirmation of fail-closed)            |

Policy discovery is data-only by default: `.rundownrc`, `.rundownrc.json`,
`.rundownrc.yaml`, `.rundownrc.yml`, or the `rundown` field in `package.json`.
Executable `rundown.config.js/.cjs/.mjs` files are only loaded when passed via
`--policy` together with `--trust-js-policy`.

```bash
# Allow specific commands for this run
rundown run deploy.runbook.md --allow-run docker,kubectl

# CI/CD: strict mode with no prompts
rundown run test.runbook.md --non-interactive
```

---

## CLI Commands

### Run Ownership

Every run has exactly one owner, proven by its **Owner Token**
(`rdo_<43 base64url characters>`). `rundown run` prints the token once, as
`owner_token` on the `runbook_started` event (`Owner token:` in `--text`
output). No other command, status response, or listing ever shows it again, so
capture it when the run starts.

- **Mutating commands** — `pass`, `fail`, `goto`, `stop`, `complete`, `collect`,
  `retry`, and `prune` of a running run — name the run they change with
  `--token <owner_token>`. The token both selects the run and proves the caller
  owns it. A command without `--token` is refused `TOKEN_REQUIRED`; a token no
  run carries is refused `UNKNOWN_TOKEN`; a token whose run has already finished
  is refused `RD-303` (completed) or `RD-304` (stopped or abandoned).
- **Read-only commands** — `status`, `ls`, and `artifact` — take no token.
  `--run <rd_…>` (the run id, carried as `runbookId` on every event) selects a
  run for `status` and `artifact`. `--run` is never mutation authority:
  combining it with `--token` on a mutating command is refused `INVALID_SYNTAX`.
  The one exception is the [human escape hatch](#escape-hatch),
  `rundown stop --run <run-id>`, which a person at an interactive terminal
  confirms, and which is audited on the run; agents never use it.
- **One conditional save** — a mutating command reads the run, derives its
  change, and commits it with a single conditional write. If another write
  landed on the run in between, the command is refused `CONCURRENT_MODIFICATION`
  and nothing is written. It is never retried on your behalf: re-read the run
  and re-issue the command.
- **Execution lease** — while a step's command runs, the run holds an execution
  lease. Every mutating command is refused `EXECUTION_IN_PROGRESS` until the
  command's result commits. If the process running the command dies, the step is
  Interrupted: Rundown never repeats the command, `pass` and `complete` are
  refused `EXECUTION_INTERRUPTED`, and the owner decides with `fail --step`
  (which takes the step's FAIL handler, including an authored `RETRY`), `goto`,
  or `stop`. `rundown status` shows either condition as `execution`. A step
  whose command never started — the process died after the commit that entered
  it — holds no lease; `pass` on it is refused `EXECUTION_PENDING` rather than
  passing a command that never ran, and `goto <step>` runs it.
- **Inline children** — a runbook-list substep without `DELEGATE` launches an
  Inline Child: a child run owned by you, authorized by your Owner Token, with
  no token of its own (its `runbook_started` event carries no `owner_token`).
  While one runs, your token targets the **deepest running inline child**, so
  every mutating command — `pass`, `fail`, `goto`, `stop`, `complete` — acts on
  that child and `--step` names a step of the child. When a command drives the
  child to a terminal, the same command collects its result (completed = pass,
  stopped = fail, plus its frontmatter `outputs:`) into the parent substep and
  continues the parent. If the process died before that collect, your next
  command commits only the collect first — it runs no further step and launches
  no child — and then applies at the parent's resulting position. See
  [Composition](#composition) under `rundown run`.
- **Delegations** — a `DELEGATE` runbook-list substep is a child run owned by
  whichever agent claims it. The step's `step_entered` event lists each child
  with a **Claim Ticket** (`rdt_<43 base64url characters>`), printed there once
  and never in status. `rundown claim <ticket>` starts the child and prints the
  child's own Owner Token; its owner drives it like any run it owns. Every
  command on a Delegation first checks the child still counts: once its parent
  re-entered the step, decided the substep by hand, or retried it, it is refused
  `DELEGATION_CANCELLED`, and once the parent finished or was pruned
  `PARENT_RUN_FINISHED`. `rundown stop` is the one command such a child still
  accepts: it ends the child's own run, whose result is never collected. The
  child never writes its parent; the parent's owner reads its result with
  `rundown collect`. A lost ticket or lost child token is recovered with
  `rundown retry`, and a sub-agent that cannot finish its child ends it with
  `rundown release`, the one write authorized by an agent id rather than an
  Owner Token. See [Delegation](#delegation).

Mutating commands check their arguments in a fixed order, and the first refusal
wins; nothing is written on any of them. See
[docs/spec/cli-output.md § Error Output](../spec/cli-output.md#error-output-all-commands).

### Runbook Lifecycle

#### `rundown run <file>` - Start Runbook

Start a new runbook from a runbook file.

```bash
rundown run my-runbook.runbook.md
rundown run my-runbook.runbook.md --prompted  # Disable automatic execution
rundown run my-runbook.runbook.md --text      # Emit execution events as human-readable text
rundown run my-runbook.runbook.md --input key=value  # Set template variable (repeatable)
rundown run my-runbook.runbook.md --input-json 'items=["a","b"]'  # Set variable with JSON value (repeatable)
rundown run my-runbook.runbook.md --input-file vars.yaml  # Load variables from YAML file (repeatable)
rundown run execute-plan.runbook.md --artifacts PlanPath=rd://artifacts/ctx/run/PlanPath  # Supply an input artifact (repeatable)
rundown run fanout.runbook.md --artifacts-json 'Plans=["rd://artifacts/ctx/run/p0","rd://artifacts/ctx/run/p1"]'  # JSON array of artifact URIs
rundown run my-runbook.runbook.md --prompted --step 2.1  # Jump to step 2.1 after starting
rundown run my-runbook.runbook.md --prompted --step 2 --index 3  # Jump into FOR iteration 3 of step 2
```

**Flags:**

- `--prompted` — Show commands without auto-executing.
- `--text` — Output execution events as human-readable text (JSON is the
  default).
- `--input <key=value>` / `--input-json <key=json>` / `--input-file <path>` —
  Set template variables (all repeatable). `--input KEY` without `=value`
  inherits the environment variable `KEY`. `--input-json` carries JSON
  array/object values. `--input-file` paths must be project-relative and must
  remain inside the project directory after symlink resolution; absolute paths
  and `..` traversal are rejected.
- `--artifacts <key=rd://uri>` / `--artifacts-json <key=json-array>` — Supply
  **input artifacts** (both repeatable; declared via frontmatter `artifacts:`).
  Values MUST be `rd://artifacts/...` URIs (or, for `--artifacts-json`, a JSON
  array of such URIs) naming **existing** manifest rows — the channel is
  read-only and never mints rows; a non-`rd://` value is a hard error. This is a
  distinct boundary channel from `--input*`: `--input X=rd://...` is a plain
  string and does not rehydrate, and supplying the same name via both channels
  is an error. There is no `--artifacts-file` and no `KEY`-only env-inherit
  form.
- `--step <stepId>` — Jump to a step after starting, under the run's freshly
  minted Owner Token (the same navigation as `rundown goto`). Requires
  `--prompted`; without it the command is refused `INVALID_SYNTAX`. If the run
  completes during launch, the jump cannot be applied and is refused `RD-303`.
- `--index <number>` — FOR loop iteration to target (requires `--step`).

**Behavior:**

1. Parse runbook file
2. Create a run with a unique run id (`rd_…`) and Owner Token
3. Emit `runbook_started` carrying `owner_token`
4. Enter execution loop

**Execution Loop:**

- Auto-execute bash code blocks (unless `--prompted`)
- A code block's own exit code decides the step result: 0 = PASS, non-zero =
  FAIL. This is the **block's** exit code, not `rundown run`'s
- Stop at prompt-only steps (no code block); the stream ends with that step's
  `step_entered` event
- Continue until COMPLETE or STOP

`rundown run`'s **own** exit code follows the shared halt rule — see
[Exit codes for `run`, `goto`, `pass` and `fail`](#exit-codes-for-run-goto-pass-and-fail).

**With `--prompted`:**

- Commands displayed but not executed
- Agent must run command manually
- Use `rundown pass` or `rundown fail` (with `--token` and `--step`) after the
  command

#### Composition

A runbook-list substep without `DELEGATE` — `### 2.1` listing one
`child.runbook.md`, or the step-level list shorthand, which makes one substep
per entry — composes an **Inline Child**:

- Entering the substep reserves the child (a preallocated run id and the
  parent's variables) in the parent's own record; each entry reserves afresh, so
  a FOR iteration, a `GOTO` back onto the step, or a `RETRY` launches a new
  child, and a child from an earlier entry is never collected.
- Run Progression creates the child run and drives it like any run. The child
  inherits the parent's variables, its `context.parent.*` /
  `context.ancestors.*` addressing, and, inside a FOR loop, the iteration
  binding (`Index` and the loop variable, when the child declares it). A
  `--prompted` run's children are prompted too.
- Your Owner Token drives the child:
  `rundown pass --token <owner_token> --step <child step>`. A `--step` naming
  the parent's own step while the child runs is refused `INVALID_STEP`, and the
  message names the inline child.
- When the child reaches a terminal, its result — `completed` as PASS, `stopped`
  as FAIL — and its frontmatter `outputs:` flow into the parent substep in the
  same command, and the parent's handlers decide what happens next. Children
  nest: a child's own inline substeps launch grandchildren the same way.
- If the process died after the child's terminal but before that collect, your
  next mutating command (`stop` and `complete` included) commits the collect
  alone — level by level up an uncollected chain — without running the parent's
  next step or launching a child, and then applies at the parent's resulting
  position. If that collect finished the run, the command is refused as on any
  finished run.
- An inline child that cannot be launched (its runbook is not found, or misses a
  required input) leaves the parent resting on the substep; the command reports
  the refusal, and `rundown pass` / `rundown fail --step <parent substep>`
  decides it by hand.

A substep listing more than one runbook is refused before any run is created,
with `RUNBOOK_COMPOSITION_UNSUPPORTED`: each substep composes one child. A child
whose own runbook does so is refused the same way when it launches or is
claimed.

#### Delegation

A runbook-list substep marked `- DELEGATE` (or every substep of a step marked
`- DELEGATE`) composes a **Delegation**: a child run owned by whichever agent
claims it.

- Entering a delegated substep reserves its child — and the child of every later
  delegated substep of the step — in the parent's own record: a preallocated run
  id, the runbook, and the context the child inherits (the parent's variables
  and, inside a FOR loop, the iteration binding), captured at that moment. Each
  entry reserves afresh, so a FOR iteration, a `GOTO` back onto the step, or a
  `RETRY` reserves new children, and a child of an earlier entry no longer
  counts.
- The `step_entered` event that announces the entry lists the children:
  `children: [{ step, index?, runId, runbook, ticket }]`. The `ticket` is a
  Claim Ticket, printed only on the entry that issued it — hand each to one
  sub-agent. Status and later events never show it, so a lost ticket cannot be
  read again.
- `rundown claim <ticket>` (see
  [claim](#rundown-claim-ticket---claim-a-delegation)) creates the child under
  its reserved run id, prints its `runbook_started` with the child's own
  `owner_token` and its `parent`, and starts its execution loop. A ticket claims
  its child once: a second claim is refused `ALREADY_CLAIMED`. A `--prompted`
  parent's children are prompted too.
- The sub-agent drives the child with the child's token. A child that is
  terminal has a Child Result — `completed` as PASS, `stopped` or `abandoned` as
  FAIL — and its frontmatter `outputs:`; it never writes them into the parent.
- The parent's owner applies them with `rundown collect --token <owner_token>`
  (see [collect](#rundown-collect---collect-delegated-results)). Collect reads
  every child of the step's current entry: each terminal child not yet applied
  is applied, in any order — the substep the parent rests on takes its result at
  once, and a later substep's result is held until the parent reaches it — and
  the rest are reported `pending` or `unclaimed`, with nothing applied for them.
  Collect is the only way a Delegation's result reaches its parent.
- The owner may decide a delegated substep by hand with `rundown pass` /
  `fail --step <substep>` (with `--index` inside a FOR loop); its child then no
  longer counts, and its sub-agent's next command is refused
  `DELEGATION_CANCELLED`. The sub-agent ends the child with
  `rundown stop --token <child owner_token>`, the one command a cancelled child
  still accepts (as does a child whose parent finished or was pruned); nothing
  collects its result. The decision itself is the substep's result: the step's
  handlers and aggregation proceed on it.
- A lost ticket, a child nobody claims, or a child whose sub-agent lost its
  Owner Token is recovered with `rundown retry` (see
  [retry](#rundown-retry---retry-a-delegation)): it cancels the child and
  reserves a fresh one with a new ticket, printed once. There is no re-claim and
  no re-reveal: a ticket is printed on the one event that issued it, and a child
  is claimed once.
- A sub-agent that cannot finish its child ends it with `rundown release` (see
  [release](#rundown-release-child-id---release-a-delegation)): the child is
  `abandoned`, which Collect applies as FAIL while the parent still counts it;
  the event says whether it does.
- The ticket of every child a re-entry or a `retry` replaced stays recorded on
  the parent (its hash only), so it is refused `DELEGATION_CANCELLED` rather
  than `UNKNOWN_TICKET`, however many replacements ago it was issued.
- If the turn that entered the step could not record the Claim Tickets (another
  of the owner's commands wrote the run first, refused
  `CONCURRENT_MODIFICATION`), no ticket was printed. The owner's
  `rundown collect --token <owner_token>` enters the step again and prints the
  tickets in its `step_entered`; a ticket is printed only once.
- An Inline Child may delegate: its step entry issues the tickets, and the
  root's Owner Token collects into it like any command on the inline chain; when
  the collect finishes the inline child, its parent collects it in the same
  command.

#### `rundown claim <ticket>` - Claim a Delegation

Start the delegated child a Claim Ticket names. The ticket is the command's only
authority; it takes no `--token`.

```bash
rundown claim rdt_…                    # Start the child; prints its owner_token once
rundown claim rdt_… --agent-id <id>    # Record the claiming agent on the child
```

**Flags:**

- `--agent-id <id>` — Identity of the claiming agent, recorded on the child; a
  later `release` of the child is matched against it. Given more than once it is
  refused `INVALID_SYNTAX`, never resolved last-wins. Elsewhere than Claude Code
  — Codex, MCP, a person, the scenario harness — the claimant passes one stable
  id by hand, and the same id to `release`.
- `--text` — Human-readable output.

**In Claude Code.** The plugin's `PreToolUse(Bash)` hook stamps
`--agent-id '<agent_id>'` from the sub-agent's `agent_id` on every
`rundown claim` / `rundown release` it reads with confidence — a plain command,
in an `&&` / `;` / `|` chain, behind `VAR=x`, `env`, `timeout`, `nice`, `npx` or
`pnpm exec` — replacing any `--agent-id` typed, and denies such a claim from the
top-level agent (`CLAIM_OUTSIDE_SUBAGENT`, a hook denial). Every other command
runs untouched, so the user's Bash permission rules still match it. A claim the
hook could not read reaches the CLI unstamped, and inside Claude Code
(`CLAUDECODE=1`, which Claude Code sets in every Bash tool command) `claim`
without `--agent-id` is refused `AGENT_ID_REQUIRED`; an `--agent-id` smuggled in
beside the stamp makes two, refused `INVALID_SYNTAX`. Outside Claude Code an
unnamed claim records no agent. The stamp guards against agent confusion, not a
malicious agent: one that deliberately builds an `--agent-id` the hook cannot
see, or strips `CLAUDECODE` from its own environment, is outside that threat
model and is not prevented.

In one transaction, `claim` verifies the reservation is still a child its parent
counts and the parent is running, and creates the child run under the reserved
run id. The output is the child's event stream, exactly as `rundown run`'s:
`runbook_started` carries the child's `owner_token` and its
`parent: { runId, step }`.

Refusals (nothing is created): `INVALID_SYNTAX` for a value that is not a Claim
Ticket (never echoed), `UNKNOWN_TICKET` for a ticket no reservation carries,
`ALREADY_CLAIMED` for a second claim, `DELEGATION_CANCELLED` when the parent no
longer counts the child, `PARENT_RUN_FINISHED` when the parent finished, and the
child runbook's own preparation failures (`RUNBOOK_NOT_FOUND`,
`MISSING_REQUIRED_VARS`, …).

#### `rundown collect` - Collect Delegated Results

Apply the results of the run's delegated children (see
[Delegation](#delegation)).

```bash
rundown collect --token <owner_token>
```

The token resolves as for every mutating command — to the deepest running inline
child — and collect reads the Delegations of that run's current step entry. The
output is one `children_collected` event,
`children: [{ step, index?, runId, status, result? }]`, where `status` is:

| `status`            | Meaning                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `collected`         | Terminal; this collect applied its Child Result                               |
| `already_collected` | An earlier collect applied it                                                 |
| `pending`           | Claimed and still running; nothing applied                                    |
| `unclaimed`         | Reserved, but no agent has claimed its ticket yet; nothing applied            |
| `cancelled`         | The run no longer counts it (the owner decided its substep, or left the step) |

When a result moves the run, the transition and the run's continuation follow as
for `pass`: the next step's `step_entered` (with fresh tickets if it delegates),
or the run's terminal. Pending and unclaimed children exit 0. Refusals:
`TOKEN_REQUIRED`, `UNKNOWN_TOKEN`, `RD-303` / `RD-304`, `EXECUTION_IN_PROGRESS`
/ `EXECUTION_INTERRUPTED`, `CONCURRENT_MODIFICATION` (the results applied before
it stand), and `NOTHING_TO_COLLECT` when the run's current step delegates
nothing.

#### `rundown retry` - Retry a Delegation

Cancel the Current Child of one delegated substep and reserve a fresh one with a
new Claim Ticket (see [Delegation](#delegation)).

```bash
rundown retry --token <owner_token> --step 3.1
rundown retry --token <owner_token> --step 1.1 --index 2   # inside a FOR loop
```

The token resolves as for `collect`. `--step` names a delegated substep of the
run's current step — the one the run rests on or a later one of a fan-out — and
`--index` the current FOR iteration, which a loop requires. One conditional save
cancels the child and reserves the fresh one at the same step entry, under a new
run id, with the same runbook and the context the cancelled child was reserved
with. The output is one `delegation_retried` event:
`{ step, index?, cancelledRunId, children: [{ step, index?, runId, runbook, ticket }] }`;
the new `ticket` is printed there once and never in status.

The cancelled child's commands and its old ticket are refused
`DELEGATION_CANCELLED` (its owner may still `stop` it), and nothing collects it,
even if it is already terminal. Refusals: `TOKEN_REQUIRED`, `UNKNOWN_TOKEN`,
`RD-303` / `RD-304`, `EXECUTION_IN_PROGRESS` / `EXECUTION_INTERRUPTED`,
`INVALID_STEP` (no `--step`, another step, a bare step id, a substep the step
does not define, or a wrong `--index`), `NOTHING_TO_RETRY` (the substep
delegates nothing, or its child was already collected or decided by hand), and
`CONCURRENT_MODIFICATION` (nothing was cancelled and no ticket was issued).

#### `rundown release <child-id>` - Release a Delegation

End a delegated child its claiming agent cannot finish — for example because it
lost the child's Owner Token — as `abandoned`, so its parent's Collect reads a
definite result (FAIL).

```bash
rundown release rd_… --agent-id <id>
```

**Flags:**

- `--agent-id <id>` — Identity of the releasing agent. It must equal the agent
  id the claim recorded; a child claimed without one is released without one.
  Given more than once it is refused `INVALID_SYNTAX`. In Claude Code the
  plugin's Bash hook stamps the sub-agent's own `agent_id` (see
  [claim](#rundown-claim-ticket---claim-a-delegation)), replacing any value
  typed, and strips it from a top-level agent's release, so that releases only a
  child claimed without one. Elsewhere the claimant passes the id its claim
  used.
- `--text` — Human-readable output.

Release is authorized by that agent id, not an Owner Token, and grants nothing
else: it never touches the parent. It ends the child `abandoned` together with
the running Inline Children the child composes — they have no token of their
own, so once the child is abandoned nothing else could end them — in one
conditional write naming the version each was read at. The output is the child's
`runbook_abandoned` event:
`{ parent: { standing, runId?, step }, abandonedInline: [runId…] }`, where
`standing` says whether anything will Collect the abandoned child:

| `standing`        | Meaning                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `current`         | The parent still counts it; its next `collect` applies it as FAIL           |
| `cancelled`       | The parent no longer counts it (decided, retried or re-entered); never read |
| `parent_finished` | The parent reached a terminal; nothing collects it                          |
| `parent_pruned`   | The parent was pruned (no `runId`); nothing collects it                     |

Refusals (nothing is written): `INVALID_RUN_ID`, `RUN_TARGET_UNAVAILABLE` (no
such run), `NOT_A_DELEGATION`, `AGENT_MISMATCH`, `RD-303` / `RD-304` (the child
already finished), `EXECUTION_IN_PROGRESS` (its command, or a command of an
Inline Child it composes, is running; an Interrupted one is decided by the
release), and `CONCURRENT_MODIFICATION`.

#### `rundown stop` - Abort Runbook

Immediately terminate a running runbook.

```bash
rundown stop --token <owner_token>
rundown stop "Abandon release" --token <owner_token>
rundown stop "Lost the token" --run <run-id>   # Human escape hatch, at a terminal only
```

**Flags:**

- `--token <token>` — Owner Token of the run to stop (required, except for the
  escape hatch below).
- `--run <run-id>` — the human escape hatch: stop a top-level run whose Owner
  Token was lost. Never combined with `--token`.

Marks the run as stopped and preserves its row in `.rundown/rundown.db` for
inspection. `rundown stop` is a failure terminal: it exits non-zero after
successfully stopping the run.

<a id="escape-hatch"></a>

**The human escape hatch: `rundown stop --run <run-id>`.** A lost top-level
Owner Token is recovered only by a person, never by an agent. `stop --run` is
the one mutation a run id may drive, and it is interactive and audited:

- It requires a human at an interactive terminal (stdin and stderr are both a
  TTY). Without one — a pipe, an agent's shell, CI, the scenario harness, or
  `--non-interactive` — it is refused `INTERACTIVE_REQUIRED` with nothing
  written. `--yes` does not answer it. MCP has no tool for it.
- It refuses before asking: an id that names no run is `RUN_TARGET_UNAVAILABLE`,
  a malformed one `INVALID_RUN_ID`, a finished run `RD-303` / `RD-304`, and a
  child run `NOT_A_TOP_LEVEL_RUN`, naming only the recoveries that reach it. An
  inline child runs on the token of the run at the top of its inline chain, so
  the refusal names that run (`rundown stop --run <root-id>` if its token is
  lost), never an intermediate inline child. A delegation is ended by its own
  `stop --token`, or by its claiming agent's `rundown release <child-id>` (under
  the agent id it claimed with); while its parent still counts it, the parent's
  owner can also `rundown retry` it. An orphaned delegation (its parent was
  pruned) has no parent to ask. An attempt In Progress on the run or any running
  inline child it composes refuses it `EXECUTION_IN_PROGRESS`, so the human is
  never asked to confirm a stop that would be refused.
- It then asks on stderr, naming the run, its runbook, its step, the running
  inline children that will stop with it, and the user and host it will record.
  Anything but `y` / `yes` — an empty answer, end of input (Ctrl-D), or Ctrl-C —
  is refused `NOT_CONFIRMED` with nothing written.
- On yes it stops the whole run: the named run and every running inline child it
  composes (its current inline child, transitively), each through its own
  machine, in one all-or-nothing conditional write. Those children ran on the
  lost token and nothing else could reach them. The same write records the audit
  on the named run: `humanStop: { at, user, host, message? }`, where `user` is
  the login name, `host` the host name, and `message` the stop message.
  `rundown status --run <run-id>` shows it. The action object lists the stopped
  children in `stoppedInline`. An Interrupted attempt is cleared, as any `stop`
  clears it. A write to any of the runs while the human decided refuses it
  `CONCURRENT_MODIFICATION`, never retried, and nothing is stopped.

Agents must never run it: an agent that has lost a top-level token asks the user
to run `rundown stop --run <run-id>` themselves.

While an inline child runs, `stop` and `complete` act on the deepest running
child: the parent Collects it (stopped as FAIL, completed as PASS) in the same
command, and the command exits by where the parent then rests — a stopped child
whose parent's FAIL handler continues exits 0. The final action object names the
child's run id and carries the message.

<a id="force-terminal-targeting"></a>

`rundown complete` and `rundown stop` are workflow-level overrides that force
the run to a terminal from whatever step it is on. They are not the same as
handler-derived `COMPLETE` / `STOP` actions authored in a runbook's transitions;
the latter are results of normal step execution.

Both commands stream terminal observation events (`step_transitioned`, then
`runbook_completed` / `runbook_stopped`) before the final action object, so
their JSON output is newline-delimited — parse the last line for the action
object. See [docs/spec/cli-output.md](../spec/cli-output.md#complete) for the
full output shape.

#### `rundown complete [message]` - Force Early Completion

Manually complete a runbook before reaching the final step.

**Note:** Runbooks auto-complete when the final step's PASS transition executes
and there are no more steps. This command is only needed for early exit
scenarios.

```bash
rundown complete --token <owner_token>                            # Force completion from current step
rundown complete "Skipping remaining steps" --token <owner_token> # Complete with message
```

**Flags:**

- `--token <token>` — Owner Token of the run to complete (required).

**When to use:**

- Early exit when remaining steps are unnecessary
- Agent-driven workflows requiring explicit completion
- Graceful exit from steps without explicit completion transitions

**Comparison with `stop`:**

- `complete` - Marks the run as **successful** and exits 0
- `stop` - Marks the run as **aborted/failed** and exits non-zero

Both preserve the run's state for inspection; `rundown prune` removes it.

### State Transitions

#### `rundown pass` - Mark Step Passed

Signal successful step completion.

```bash
rundown pass --token <owner_token> --step 2              # At top-level step 2
rundown pass --token <owner_token> --step 2.1            # At substep 2.1
rundown pass --token <owner_token> --step 2.1 --index 3  # At substep 2.1 in FOR iteration 3
```

**Aliases:** `rundown yes`, `rundown ok`

**Flags:**

- `--token <token>` — Owner Token of the run (required).
- `--step <stepId>` — The run's current step or substep position (required).
- `--index <number>` — The current FOR loop iteration (requires `--step`;
  required inside a FOR iteration).

`--step` (and `--index`) confirm the position you are reporting on; they do not
select a different step. A missing `--step`, a step or substep other than the
current one, a bare step id while a substep is active, or a missing or wrong
`--index` inside a FOR iteration (or an `--index` outside one) is refused
`INVALID_STEP` before anything is written, and the message names the current
position. While an inline child runs, the position is the child's: `--step`
names a step of the deepest running inline child, and naming the parent's step
is `INVALID_STEP`.

**Behavior:**

1. Send PASS event to XState
2. Evaluate PASS transition
3. Execute resulting action
4. Print action taken and new step

#### `rundown fail` - Mark Step Failed

Signal step failure.

```bash
rundown fail --token <owner_token> --step 2              # At top-level step 2
rundown fail --token <owner_token> --step 2.1            # At substep 2.1
rundown fail --token <owner_token> --step 2.1 --index 3  # At substep 2.1 in FOR iteration 3
```

**Alias:** `rundown no`

**Flags:**

- `--token <token>` — Owner Token of the run (required).
- `--step <stepId>` — The run's current step or substep position (required).
- `--index <number>` — The current FOR loop iteration (requires `--step`;
  required inside a FOR iteration).

The `--step` / `--index` rule is the same as for `pass`.

**Behavior:**

1. Send FAIL event to XState
2. Evaluate FAIL transition (may trigger RETRY)
3. Execute resulting action
4. Print action taken

For RETRY transitions:

- If `retryCount < max`: increment count, stay in step (`action` reports
  `RETRY (n/max)`)
- If exhausted: execute fallback action (default: STOP)

##### Exit codes for `run`, `goto`, `pass` and `fail`

The exit code of any of these commands reports **the action the runbook program
actually took**, not the verb you typed. It answers one question for a scripted
driver: _has the run this process is driving halted?_

The rule is the same for all four. It is stated here once because it drifted
apart when it was documented for `pass` / `fail` alone (ADR 0004).

- **Exit non-zero** — the run has **halted**: it reached `stopped` (including a
  STOP after RETRY was exhausted), or the command was refused or failed to
  deliver its observations.
- **Exit 0** — the run is **still progressing** or has completed, even when the
  result was a failure. A `rundown fail` whose handler is non-terminal (for
  example `FAIL CONTINUE`, `FAIL GOTO 1`, or a RETRY with attempts left) exits
  0: the failure is real and recorded in state and the JSON output, but the run
  has not halted, so a `set -e`-style driver should keep going.

The result of the step (`pass` / `fail`) is a separate channel — it is always
recorded and emitted in the JSON output (`stepResult`) regardless of exit code.
Exit 0 from `rundown fail` never means the failure was swallowed; it means the
runbook's configured handler absorbed it without halting the run. Read the event
stream for what happened; the exit code only tells you whether to keep driving.

#### `rundown goto <step>` - Jump to Step

Navigate directly to a step. `goto` can drive a run to a terminal, so its exit
code follows the shared halt rule — see
[Exit codes for `run`, `goto`, `pass` and `fail`](#exit-codes-for-run-goto-pass-and-fail).

```bash
rundown goto 3 --token <owner_token>            # Jump to step 3
rundown goto 3.1 --token <owner_token>          # Jump to substep 3.1
rundown goto 3 --index 2 --token <owner_token>  # Jump to step 3 and enter FOR iteration 2
```

**Flags:**

- `--token <token>` — Owner Token of the run (required).
- `--index <number>` — For FOR-annotated targets, enter the loop at the
  specified iteration.

`goto` takes no `--step`: the positional argument is the target, not a
confirmation of the current position.

**Restrictions:**

- Target must exist (`STEP_NOT_FOUND` otherwise; the error lists the available
  steps)
- `--index` / `AT` is only valid when the target is a FOR step
  (`INVALID_AT_TARGET` otherwise)
- Resets retryCount to 0
- Clears lastResult (prevents the previous result from leaking)

**Valid GOTO Formats (in runbook transitions):**

| Target           | Valid From | Description                                                                                            |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `GOTO N`         | Any step   | Jump to step N (if FOR step, AT defaults per [spec §6](../spec/language.md#6-transitions-and-actions)) |
| `GOTO N.M`       | Any step   | Jump to substep M of step N                                                                            |
| `GOTO Name`      | Any step   | Jump to named step                                                                                     |
| `GOTO Name.M`    | Any step   | Jump to substep M of named step                                                                        |
| `GOTO N AT I`    | Any step   | Enter FOR step N at iteration I (only if N is a FOR step)                                              |
| `GOTO N.M AT I`  | Any step   | Jump to substep M of FOR step N at iteration I                                                         |
| `GOTO Name AT I` | Any step   | Enter named FOR step at iteration I                                                                    |

The `AT` qualifier is only valid when the target is a step with a FOR
annotation. See
[docs/spec/language.md §6](../spec/language.md#6-transitions-and-actions) for
the authoritative AT default rule and full action details.

### Status Commands

#### `rundown status` - Show Run State

Show every run, or one run in detail. `status` is read-only and takes no
`--token`; no status response carries an Owner Token.

```bash
rundown status                       # List every run (JSON output by default)
rundown status --run <run_id>        # Show one run in detail
rundown status --run <run_id> --text # Human-readable detail
rundown status --claimed-by <agent-id> # Delegations still holding an agent
```

**Flags:**

- `--run <runId>` — Show one run in detail. A malformed id is refused
  `INVALID_RUN_ID`; a well-formed id that names no run is refused
  `RUN_TARGET_UNAVAILABLE`.
- `--claimed-by <agent-id>` — List the Delegations that still hold an agent:
  running, claimed under that agent id (`claim --agent-id`), and still counted
  by their parent. The answer is
  `{ kind: "claimed_delegations", agentId, delegations: [{ runId, runbook, parentRunId, step }] }`;
  a finished, abandoned or cancelled child, or one whose parent finished or was
  pruned, is not listed. The Claude Code plugin's `SubagentStop` hook reads it
  to hold a sub-agent until it finishes or releases its child. Combined with
  `--run`, or empty, it is refused `INVALID_SYNTAX`.

While a run's step command is running or was interrupted, both forms carry
`execution: { condition: "in_progress" | "interrupted", step, attempt, pid, startedAt }`;
see
[docs/spec/cli-output.md § Execution condition](../spec/cli-output.md#execution-condition).

Inline children are runs too, so the chain from root to child is visible: each
child's list entry and detail carry `parent: { runId, step, kind }`, and a run
whose step composes a child carries `child: { runId, kind, status }` in its
detail (`status` is `reserved` before the child's run exists). A run whose step
delegates carries `children: [{ runId, step, index?, status, result? }]` — its
Delegations of the current entry by id, lifecycle and Child Result only. None
ever carries a token or a Claim Ticket; see
[docs/spec/cli-output.md § Child runs](../spec/cli-output.md#child-runs).

**Output (bare, `--text`):**

```text
ID                                   STATUS   STEP  RUNBOOK                              TITLE
rd_0123456789abcdef0123456789abcdef  running  2/3   .rundown/runbooks/deploy.runbook.md  Deploy
```

**Output (`--run`, `--text`, abbreviated):**

```text
File:     .rundown/runbooks/deploy.runbook.md
State:    .rundown/rundown.db
Run:      rd_0123456789abcdef0123456789abcdef
Action:   CONTINUE
Result:   PASS

## 2. Verify

Entry: 2

Vars:
  Date: 2026-05-07
  ...
```

A run whose persisted state this build cannot read is left out of the list, and
a `[rundown] Warning: Invalid runbook state for …` line is written to stderr;
see `RD-309` in [Common Errors](#common-errors-and-resolutions).

#### `rundown ls` - List Runbooks

List persisted runs, or available runbook files.

```bash
rundown ls                      # List persisted runs (JSON output by default)
rundown ls --all                # List available runbook files
rundown ls --all --tags review  # Filter by tag
```

**Run status values:**

- `running` - In progress
- `complete` - Successfully finished
- `stopped` - Terminated with failure
- `abandoned` - Ended without completing

In `--text` mode the run id column is truncated to its first 8 characters; JSON
carries it in full. The Owner Token is never listed.

**Columns (for `--all`):** `NAME`, `SOURCE`, `DESCRIPTION`, `TAGS`. The `SOURCE`
column indicates where each runbook was discovered (`project`, `plugin`, or
`bundled`) — see [Runbook Discovery](#runbook-discovery).

### Artifact Commands

```bash
rundown artifact ls                         # List artifact aliases visible in the run
rundown artifact inspect <Alias-or-uri>      # Return the full artifact record for an alias or manifest-backed exact URI
rundown artifact path <Alias-or-uri>         # JSON: full artifact record; --text: local path only
rundown artifact uri <Alias>                 # JSON: full artifact record; --text: canonical artifact URI only
rundown artifact ls --run <run_id>          # Inspect a specific run
```

Artifact commands are read-only inspection/projection tools. They do not read or
write artifact file contents. `--run <rd_…>` selects the run; without it they
use the single running run. Several running runs are refused `INVALID_SYNTAX`
(name one with `--run`); no running run is the `NO_ACTIVE_RUNBOOK` warning (exit
0). JSON output is optimized for agents and includes both `uri` and `path`; use
`--text` on `path` or `uri` only when a shell-friendly single projection is
needed.

### Validation

#### `rundown check <file>` - Validate Runbook

Check a runbook file for syntax errors.

```bash
rundown check my-runbook.runbook.md          # JSON output by default
rundown check my-runbook.runbook.md --text   # Human-readable text output
```

`check` emits JSON by default. Pass `--text` for the human-readable layout shown
below.

**Output (`--text`):**

```text
PASS: 3 steps
```

or

```text
FAIL: 2 errors

Line 15: Step 3 missing (expected sequential numbering)
Line 22: Invalid transition: GOTO 10 (step does not exist)
```

Warnings do not fail the check. A runbook with a substep listing more than one
runbook is valid but gets a warning naming those substeps, because `rundown run`
refuses it with `RUNBOOK_COMPOSITION_UNSUPPORTED`. A single-runbook inline or
`DELEGATE` substep runs and is not warned about.

### Maintenance

#### `rundown prune` - Remove Runbook State

Clean up run state records (not runbook source files).

```bash
rundown prune                        # Remove completed + stopped runs (default)
rundown prune --dry-run              # Preview what would be removed
rundown prune --completed            # Only completed
rundown prune --stopped              # Only stopped (aborted/failed)
rundown prune --inactive             # Only invalid or abandoned runs
rundown prune --active               # Running runs: each needs its token, or your confirmation
rundown prune --all                  # Every finished and invalid run, and running runs as --active
rundown prune --token <owner_token>  # Delete that one run
```

The lifecycle filters select finished and invalid runs. A **running** run is
deleted when `--token <owner_token>` names it, one run per invocation, or — a
top-level run selected by `--active` or `--all` — when a human at an interactive
terminal confirms it: prune asks on stderr, once per running run, and only about
a run it would otherwise delete. The deleted row is gone, so the prune output
records who confirmed it: each row the confirmed delete removes carries
`confirmedBy: { at, user, host }` in JSON, and
`confirmed by <user>@<host> at <time>` in the text `NOTE` column. Without a
terminal (a pipe, an agent's shell, CI, `--non-interactive`) and under
`--dry-run`, prune never asks, and keeps each running top-level run with
`retained: "token required"`; one the human declines (or answers with Ctrl-D or
Ctrl-C) is kept with `retained: "not confirmed"`. A running child run is never
offered, as the [escape hatch](#escape-hatch) never stops one: it is kept with
`retained: "child run"` and a `detail` naming the recoveries that reach it (an
inline child goes with its root; a delegation is ended by its own `--token`, its
claiming agent's `release`, or its parent's owner). Runs whose persisted state
this build cannot read are reached only by `--inactive` or `--all` (they are
listed with `status: "invalid"`); a bare `rundown prune` never sees them.
`prune` takes no `--run`: naming a run id is refused `INVALID_SYNTAX`, since a
run id is never authority to delete.

<a id="prune-retention"></a>

**Child Result retention.** A current child — a delegation or inline child its
running parent still counts — is never pruned on its own, whatever the filter,
`--all` included. A finished one holds a result its parent has not collected and
is kept with `retained: "uncollected"`; a running one is kept with
`retained: "current child"`. `prune --token` naming such a child (a delegation's
own token) is refused `CURRENT_CHILD_PROTECTED` with nothing deleted. Protection
ends when the parent collects the child (`rundown collect`, or the implicit
collect of an inline child), when cancellation makes its result unnecessary
(`rundown retry`, the owner's own `pass` / `fail` on the substep, or a re-entry
of the step), when the parent finishes, or when the parent is pruned. Ending
protection deletes nothing by itself: the child becomes eligible for an ordinary
prune. Within one prune that deletes the parent, a finished delegation the
prune's own filters select is deleted after it (so
`prune --completed --token <parent-token>` removes a completed delegation with
its parent, while a bare `prune --token` does not select it); a running one is
never deleted this way and is kept as `"child run"`. Whether a running parent
still counts a delegation is read from the parent's runbook; if that runbook
cannot be parsed, the parent's delegations are kept with
`retained: "parent unreadable"` and a `detail` saying why, and the rest of the
prune proceeds (`prune --token` naming such a delegation is refused
`CURRENT_CHILD_PROTECTED`). Retention is what keeps a delegated child's reserved
id taken, so its claim ticket can never claim a second child.

Deleting a run deletes its inline children with it, transitively, and lists each
of them; protection ends with the parent, so a current inline child of the
deleted run is listed as deleted. The execution-lease rule covers that whole
chain: an attempt In Progress on the token's run or any of its inline children
refuses the invocation `EXECUTION_IN_PROGRESS` with nothing deleted, and a run
selected by a filter is kept with `retained: "execution in progress"`. If any
run in a chain changes between prune's read and its delete, the delete is
refused `CONCURRENT_MODIFICATION`, never retried.

### Testing and Utilities

#### `rundown echo` - Test Helper

Echo command for runbook testing. Supports configurable pass/fail result
sequences (useful for exercising retry logic).

```bash
rundown echo [command...]
rundown echo -r pass                # Configure result (repeatable)
rundown echo -r fail -r pass        # Sequence: fail first, then pass
```

#### `rundown resolve <file>` - Resolve Variables

Resolve and validate template variables and data sources for a runbook without
executing it.

```bash
rundown resolve my-runbook.runbook.md
rundown resolve my-runbook.runbook.md --input environment=staging
rundown resolve my-runbook.runbook.md --input-json 'items=["a","b"]'  # JSON value
rundown resolve my-runbook.runbook.md --input-file vars.yaml          # YAML file
rundown resolve execute-plan.runbook.md --artifacts PlanPath=rd://artifacts/ctx/run/PlanPath  # Artifact channel
```

`--input`, `--input-json`, `--input-file`, `--artifacts`, and `--artifacts-json`
are all repeatable. `--artifacts` / `--artifacts-json` resolve `rd://` artifact
URIs the same way as `rundown run` (see that command's flags).

Useful for verifying that required variables are satisfied and data sources
resolve before running.

#### `rundown prompt <content>` - Emit Prompt Content

Output content wrapped in markdown fences. Used by the runtime to render
`prompt` code blocks; can also be invoked directly.

```bash
rundown prompt 'Review the implementation'
```

#### `rundown scenario` - Runbook Scenarios

List, show, or execute scenarios declared in a runbook's frontmatter (see
[docs/internal/scenarios.md](../internal/scenarios.md)).

```bash
rundown scenario ls <file>                  # List scenarios
rundown scenario show <file> <name>         # Show scenario details
rundown scenario run <file> <name>          # Execute and verify
rundown scenario run <file> <name> --quiet  # Suppress command output
```

Implementation notes:

- `scenario run` creates an isolated temp workspace, copies the scenario runbook
  into `.rundown/runbooks/`, copies referenced `*.runbook.md` files found in
  commands, and executes commands through `executeCommandSequence`.
- `rd`/`rundown` commands are spawned directly as `node <cliPath> ...` so JSON
  output can be captured; non-`rd` commands run through the shell.
- Scenario `commands:` should express the visible CLI workflow directly. Do not
  wrap `rd`/`rundown` calls in `node -e`, `bash -c`, npm scripts, helper
  scripts, or shell pipelines; hidden CLI calls are not visible to the scenario
  runner's state, token, and transition capture. Put detailed payload assertions
  in Jest integration or unit tests instead.
- Leading command-scoped env assignments are supported for `rd` commands when a
  scenario needs them for unrelated command behavior. Shell operators in an `rd`
  command are rejected; split those commands into separate scenario entries.
- Prefix a command with `!` followed by a literal space when a non-zero exit is
  expected. If an expected-failure command exits 0, the scenario fails;
  otherwise the failed command is allowed to continue.
- During scenario execution, JSON warnings emitted by commands must be declared
  in `expect.warnings`; any unasserted warning fails the scenario even when the
  underlying command exits 0.
- Owner Tokens and run ids are captured from `runbook_started` events.
  `${TOKEN}` expands to the first captured `owner_token`, `${TOKEN_2}` to the
  second, and so on; `${RUN_ID}` / `${RUN_ID_2}` expand to the captured
  `runbookId` values, for `status --run` assertions. Mutating commands use
  `--token ${TOKEN}`.
- `--input-file` dependencies are copied by directory. Scenario execution copies
  the entire containing directory for each relative `--input-file` path so YAML
  files that contain sibling `file:` references keep working. Absolute paths and
  `..` traversal are rejected.
- Scenario `expect.entered` assertions match captured `step_entered` events.

#### `rundown scenario-suite` - Scenario Suites

List, show, or execute cases from a scenario suite file.

```bash
rundown scenario-suite ls <suite-file>
rundown scenario-suite show <suite-file> <case>
rundown scenario-suite run <suite-file> <case>
rundown scenario-suite run <suite-file> --all      # Run all cases
rundown scenario-suite run <suite-file> --quiet    # Suppress output
```

Implementation notes:

- `scenario-suite run` executes each case through the same command sequence
  runner as `scenario run`, so the same `${TOKEN}` / `${RUN_ID}` placeholders
  apply, and JSON warnings emitted by commands must be declared in
  `expect.warnings`; any unasserted warning fails the case even when the
  underlying command exits 0.

#### Sibling CLIs: `rdpath` and `rdx`

Two companion CLIs ship alongside `rundown`:

- **`rdpath`** — Path assembly tool for date-prefixed filenames and
  context-scoped paths. See [docs/reference/rdpath.md](rdpath.md).
- **`rdx`** — JSON-to-Markdown renderer with optional schema validation. See
  [docs/reference/rdx.md](rdx.md).

---

## Common Tasks

### Task: Run a Simple Sequential Runbook

```bash
# Start the runbook; copy owner_token from the runbook_started event
rundown run myrunbook.runbook.md

# After completing each step, signal the outcome for the current step
rundown pass --token <owner_token> --step 1    # or rundown yes, rundown ok
rundown fail --token <owner_token> --step 2    # Step failed, apply FAIL transition
```

### Task: Check Runbook Status

```bash
rundown status                 # Every run, with status and step
rundown status --run <run_id>  # One run in detail
```

The detail view shows:

- Current runbook file
- SQLite state database location
- Run id
- Last action taken and its result
- Current step, its entry, and the run's variables

### Task: Jump to a Specific Step

```bash
rundown goto 3 --token <owner_token>    # Jump to step 3
rundown goto 2.1 --token <owner_token>  # Jump to substep 1 of step 2
```

### Task: Agent-Controlled Branching

A prompt-only step can leave the next action to the agent:

```markdown
## 5. Check remaining
- PASS CONTINUE
- FAIL STOP

Check TodoWrite for remaining items.

If more remain: `rundown goto 3 --token <owner_token>`
If complete: `rundown pass --token <owner_token> --step 5`
```

The agent reads the step, evaluates the condition, and runs the appropriate CLI
command.

### Task: List Runbooks

```bash
# List persisted runs
rundown ls

# List all available runbook files
rundown ls --all

# Filter by tags
rundown ls --all --tags tdd,review
```

### Task: Validate a Runbook Before Running

```bash
rundown check myrunbook.runbook.md
```

Output: `PASS: N steps` or `FAIL: error details`

### Task: Clean Up Old Runbook State

```bash
# Preview what would be removed
rundown prune --dry-run

# Remove completed + stopped runbook state (default)
rundown prune

# Remove only completed runbook state
rundown prune --completed

# Remove only stopped (aborted/failed) runbook state
rundown prune --stopped

# Remove every finished and invalid run (running runs are retained without a
# terminal to confirm them; uncollected current children always are)
rundown prune --all

# Remove one running run you own
rundown prune --token <owner_token>
```

---

## Output Format

Output formatting is implemented in
`packages/cli/src/services/output-emitter.ts` and
`packages/cli/src/helpers/table-formatter.ts`. JSON is the default on every
command; `--text` is the human-readable alternative. The full per-command shapes
are in [docs/spec/cli-output.md](../spec/cli-output.md).

### Standard Output Structure

`rundown run --text` on a runbook that rests at a prompt-only step:

```text
File:     .rundown/runbooks/deploy.runbook.md
State:    .rundown/rundown.db
Run:      rd_0123456789abcdef0123456789abcdef
Owner token: rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
Action:   START

## 1. Build

Build the release.
```

A transition (`rundown goto 3 --token <owner_token> --text`):

```text

─── 3 ────────────────────────────────────────────
Action:   GOTO 3
From:     1
At:       3

## 3. Announce

Tell the team.
```

### Table Output

List commands (`rundown ls`, `rundown status`, `rundown prune`,
`rundown scenario ls`) use aligned tables following Linux CLI conventions:

| Convention         | Standard                                  |
| ------------------ | ----------------------------------------- |
| **Headers**        | UPPERCASE, first row, no decorative lines |
| **Alignment**      | Left for text, right for numbers          |
| **Separator**      | 2 spaces between columns                  |
| **Last column**    | Extends to end (no padding)               |
| **Empty values**   | Empty string                              |
| **Machine output** | JSON output by default                    |

Example (`rundown ls --text`):

```text
ID        STATUS   STEP  RUNBOOK                              TITLE
rd_01234  running  2/3   .rundown/runbooks/deploy.runbook.md  Deploy
```

Example (`rundown scenario ls`):

```text
NAME            EXPECTED  DESCRIPTION                                                 TAGS
immediate       COMPLETE  Step passes on first attempt
after-retry     COMPLETE  Fails first, succeeds on retry
auto-execution  COMPLETE  Code block auto-executes - fails once then passes on retry
```

### Detail Views

Single-item display commands (`rundown scenario show`) use aligned key-value
format:

| Convention        | Standard                                  |
| ----------------- | ----------------------------------------- |
| **Key alignment** | Pad to longest key + `:`                  |
| **Format**        | `Key:` followed by spaces to align values |
| **Nested items**  | Indent 2 spaces under label               |

Example (`rundown scenario show`):

```text
Name:        after-retry
Description: Fails first, succeeds on retry
Expected:    COMPLETE
Commands:
  $ rd run --prompted retry-success.runbook.md
  $ rd fail --token ${TOKEN} --step 1
  $ rd pass --token ${TOKEN} --step 1
```

### Command Execution Output

`rundown scenario run --text` prints a `Scenario:` header, then each command
(after placeholder substitution) under a separator line followed by that
command's output, and ends with the scenario's terminal state:

```text
Scenario:  after-retry
──────────────────────────────────────────────────


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
$ rd run --prompted retry-success.runbook.md

...

Scenario: COMPLETE
```

With `--quiet`, only the final `Scenario: COMPLETE` line is printed.

### Key Elements

| Element        | Description                                                 |
| -------------- | ----------------------------------------------------------- |
| `File:`        | Runbook file path                                           |
| `State:`       | State database path (`.rundown/rundown.db`)                 |
| `Run:`         | Run id this output describes (`rd_…`)                       |
| `Owner token:` | The run's Owner Token — printed by `rundown run` only       |
| `Action:`      | Last action (START, CONTINUE, GOTO, RETRY, COMPLETE, STOP)  |
| `From:`        | Previous step position                                      |
| `Result:`      | PASS or FAIL                                                |
| `For:`         | Loop scope (`index/end` or `index/?`) when in FOR execution |
| `At:`          | Current execution path (display path, e.g. `1.2.1`)         |
| `$`            | Command being executed                                      |
| `Runbook:`     | Runbook terminal state (COMPLETE, STOP)                     |

JSON output compatibility:

- Position fields (`current`, `substep`, `total`) carry the step position.
- Loop/location-aware fields are optional: `position.at`, `position.for.index`,
  `position.for.end`.
- `targetAt` is derived at output boundaries from canonical target identity
  fields.

---

## Troubleshooting and Error Handling

### Common Errors and Resolutions

Error envelopes are `{ "kind": "error", "error": …, "code": … }`, with `command`
and `details` where known. Their exact shapes are in
[docs/spec/cli-output.md § Error Output](../spec/cli-output.md#error-output-all-commands).

| Error                                       | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Resolution                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUNBOOK_NOT_FOUND`                         | Runbook path or name did not resolve                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Check the file path, or run `rundown ls --all` to list available runbooks                                                                                                                                                                                                                                                                                                   |
| `STEP_NOT_FOUND`                            | `goto` (or `run --prompted --step`) named a step or substep that does not exist                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Use one of the step ids listed in `details.available`                                                                                                                                                                                                                                                                                                                       |
| `INVALID_AT_TARGET`                         | `--index` or `AT` aimed at a step with no FOR clause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Drop `--index`, or target the FOR step                                                                                                                                                                                                                                                                                                                                      |
| "FOR loop references undefined data source" | Sourced FOR clause without matching source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Define source via --input-json, config.yaml, or --input-file                                                                                                                                                                                                                                                                                                                |
| "File drift detected"                       | Data file changed during iteration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Ensure file stability or restart runbook                                                                                                                                                                                                                                                                                                                                    |
| `TOKEN_REQUIRED`                            | A mutating command (`pass`, `fail`, `goto`, `stop`, `complete`, `collect`, `retry`) was issued without `--token`                                                                                                                                                                                                                                                                                                                                                                                                                           | Pass `--token <owner_token>`, copied from the `runbook_started` event printed by `rundown run` (or, for a delegated child, by `rundown claim`)                                                                                                                                                                                                                              |
| `INVALID_SYNTAX`                            | `--run` combined with `--token` on a mutating command, or `--run` on any mutating command but `stop` (`--run` is a read-only selector, never authority, except in the human escape hatch); a malformed `--token` (not `rdo_<43 base64url characters>` — the value is never echoed); `run --step` without `--prompted`; a malformed `--index`; or a runbook syntax error                                                                                                                                                                    | Pass `--token <owner_token>` alone on mutating commands; copy the token exactly; add `--prompted` to `run --step`                                                                                                                                                                                                                                                           |
| `UNKNOWN_TOKEN`                             | A well-formed token that no run carries — mistyped, or the token of a run that has been pruned                                                                                                                                                                                                                                                                                                                                                                                                                                             | Copy `owner_token` from the `runbook_started` event of the run you mean to drive. A lost token cannot be recovered from `status` or `ls`; stop driving that run and start a new one                                                                                                                                                                                         |
| `RD-303` (`RUNBOOK_COMPLETED`)              | The token's run has already completed, so the mutation cannot be applied. `details` names the run and its lifecycle. Also emitted by `run --prompted --step` when the run completes during launch                                                                                                                                                                                                                                                                                                                                          | Nothing to do on that run; start a new one with `rundown run`                                                                                                                                                                                                                                                                                                               |
| `RD-304` (`RUNBOOK_STOPPED`)                | The token's run has already ended without completing (`stopped` or `abandoned`)                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Start a new run with `rundown run`                                                                                                                                                                                                                                                                                                                                          |
| `INVALID_STEP`                              | `pass` / `fail` was issued without `--step`, or `--step` / `--index` does not confirm the run's current position: another step, a bare step id while a substep is active, a substep other than the current one, a missing or wrong `--index` inside a FOR iteration, or an `--index` outside one. While an inline child runs, the current position is the child's, so a `--step` naming the parent's step is refused too. Refused before anything is written; the message names the current position (and, for an inline child, the child) | Pass the current position: `--step 2` at a top-level step, `--step 2.1` at a substep, `--step 1.1 --index 3` inside FOR iteration 3                                                                                                                                                                                                                                         |
| `RUNBOOK_COMPOSITION_UNSUPPORTED`           | `rundown run` was given a runbook with a substep listing more than one runbook (no run is created; `details.substeps` names them), or a child being launched or claimed has one (for an inline child, an `error_occurred` on the parent, which rests on the substep)                                                                                                                                                                                                                                                                       | Give each substep one runbook, or decide the parent substep with `pass` / `fail --step`                                                                                                                                                                                                                                                                                     |
| `INLINE_CHILD_LAUNCH_FAILED`                | An inline child could not be launched or initialised for a reason with no code of its own (for example, inline children nested more than 32 deep). A child whose runbook is not found, or misses a required input, reports that preparation code instead (`RUNBOOK_NOT_FOUND`, `MISSING_REQUIRED_VARS`, …). The parent rests on the substep; nothing else was written                                                                                                                                                                      | Fix the child runbook, or decide the parent substep by hand with `pass` / `fail --step`                                                                                                                                                                                                                                                                                     |
| `CONCURRENT_MODIFICATION`                   | A mutating command's single conditional save found that another write landed on the run since it was read — two of the owner's own commands raced. Nothing was written; the persisted state is intact. `details.runId` names the run                                                                                                                                                                                                                                                                                                       | Re-read the run (`rundown status --run <run_id>`) and re-issue the command if it still applies; it is never retried on your behalf                                                                                                                                                                                                                                          |
| `UNKNOWN_TICKET`                            | `rundown claim` was given a well-formed Claim Ticket that no reservation carries — mistyped, or its parent was pruned                                                                                                                                                                                                                                                                                                                                                                                                                      | Copy the ticket from the `children` of the `step_entered` event that issued it                                                                                                                                                                                                                                                                                              |
| `ALREADY_CLAIMED`                           | `rundown claim` was given a ticket whose child was already claimed; a ticket claims its child once. Nothing is written                                                                                                                                                                                                                                                                                                                                                                                                                     | Drive the child with the `owner_token` the first claim printed; a lost one is recovered by the parent's owner retrying the step                                                                                                                                                                                                                                             |
| `DELEGATION_CANCELLED`                      | A delegated child's command (or a claim of its ticket) after its parent stopped counting it: the parent's owner decided the substep by hand, retried it, or re-entered the step. Nothing is written                                                                                                                                                                                                                                                                                                                                        | Stop working on the child and end it with `rundown stop --token <owner_token>`, the one command it still accepts; its result would never be collected                                                                                                                                                                                                                       |
| `PARENT_RUN_FINISHED`                       | A delegated child's command (or a claim of its ticket) after its parent reached a terminal or was pruned. Nothing is written                                                                                                                                                                                                                                                                                                                                                                                                               | Stop working on the child and end it with `rundown stop --token <owner_token>`, the one command it still accepts; its parent can no longer collect it                                                                                                                                                                                                                       |
| `NOTHING_TO_COLLECT`                        | `rundown collect` on a run whose current step delegates nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Collect only while the run rests on a step whose `step_entered` listed `children`                                                                                                                                                                                                                                                                                           |
| `NOTHING_TO_RETRY`                          | `rundown retry` named a substep that delegates nothing, or whose child was already collected or decided by hand. Nothing is written                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AGENT_ID_REQUIRED`                         | `rundown claim` inside Claude Code (`CLAUDECODE=1`) without `--agent-id`: a claim the plugin's Bash hook did not stamp. Run it as a plain command from the sub-agent the ticket was dispatched to, or pass `--agent-id` by hand without the plugin. Nothing is written                                                                                                                                                                                                                                                                     |
| `AGENT_MISMATCH`                            | `rundown release` named another agent id than the claim recorded (or one where the claim recorded none, or none where it did). Nothing is written                                                                                                                                                                                                                                                                                                                                                                                          |
| `NOT_A_DELEGATION`                          | `rundown release` named a run that is not a delegated child. Nothing is written                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `CURRENT_CHILD_PROTECTED`                   | `rundown prune --token` named a current child its running parent still counts: a delegation that is running, or finished with a result the parent has not collected. Nothing is deleted; `details` names the run, its parent and the parent step                                                                                                                                                                                                                                                                                           | Let the parent collect it (or `rundown retry` it), or finish or prune the parent; the child is prunable once [protection ends](#prune-retention)                                                                                                                                                                                                                            |
| `INTERACTIVE_REQUIRED`                      | `rundown stop --run` (the [human escape hatch](#escape-hatch)) without a human at an interactive terminal, or under `--non-interactive`. Nothing is written                                                                                                                                                                                                                                                                                                                                                                                | An agent stops its run with `--token`; for a lost top-level token, ask the user to run `rundown stop --run <run-id>` at a terminal                                                                                                                                                                                                                                          |
| `NOT_CONFIRMED`                             | The human answered anything but yes to `rundown stop --run`, including end of input (Ctrl-D) or Ctrl-C. Nothing is written                                                                                                                                                                                                                                                                                                                                                                                                                 | Re-run it and answer `y` if the stop is intended                                                                                                                                                                                                                                                                                                                            |
| `NOT_A_TOP_LEVEL_RUN`                       | `rundown stop --run` named a child run. Nothing is asked or written                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Follow the recovery the message names. An inline child: the run at the top of its inline chain, by its `--token` or `rundown stop --run <root-id>`. A delegation: its own `stop --token`, its claiming agent's `rundown release <child-id>`, or — while its parent still counts it — the parent's owner's `rundown retry`                                                   |
| `EXECUTION_IN_PROGRESS`                     | The run's current step holds the execution lease and the process running its command is alive. Every mutating command is refused so the command never runs twice; nothing was written. `details` names `runId`, `step`, `attempt`, `pid`, `startedAt`                                                                                                                                                                                                                                                                                      | Wait for the command to finish, then re-read the run (`rundown status --run <run_id>`)                                                                                                                                                                                                                                                                                      |
| `EXECUTION_INTERRUPTED`                     | The run's current step holds the execution lease but the process that started its command is gone, so its outcome is unknown. `pass` and `complete` are refused; Rundown never repeats the command. `details` as for `EXECUTION_IN_PROGRESS`                                                                                                                                                                                                                                                                                               | Decide explicitly: `rundown fail --token <owner_token> --step <step>` (the FAIL handler, including an authored `RETRY`), `rundown goto <step> --token <owner_token>`, `rundown stop --token <owner_token>`, or discard the run with `rundown prune --token <owner_token>`                                                                                                   |
| `EXECUTION_PENDING`                         | `pass` named a step whose command has not run: the command that entered the step ended before running it, so no lease is held. Nothing is written. `details`: `runId`, `step`                                                                                                                                                                                                                                                                                                                                                              | Run it with `rundown goto <step> --token <owner_token>`, or decide explicitly with `rundown fail --token <owner_token> --step <step>` or `rundown stop --token <owner_token>`                                                                                                                                                                                               |
| `RUN_TARGET_UNAVAILABLE`                    | A read-only command (`status`, `artifact`) was given a well-formed `--run` id that names no run, `release` a child id that names none, or `stop --run` a run id that names none. Also streamed as an `error_occurred` event when a run is deleted (for example by a concurrent `rundown prune`) while a command is advancing it                                                                                                                                                                                                            | Use a run id from `rundown status`; a deleted run cannot be resumed — restart it from source                                                                                                                                                                                                                                                                                |
| `INVALID_RUN_ID`                            | Malformed `--run` value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Supply a valid run id — `rd_<32 hex characters>`                                                                                                                                                                                                                                                                                                                            |
| `RD-305` (`INCOMPATIBLE_STATE_SCHEMA`)      | `.rundown/rundown.db` carries a schema version this build cannot read, and Rundown never migrates persisted state. Affects the whole database, so every in-flight run is unrecoverable                                                                                                                                                                                                                                                                                                                                                     | Delete `.rundown/rundown.db` and restart your runbooks from source                                                                                                                                                                                                                                                                                                          |
| `RD-306` (`WAL_JOURNAL_MODE_UNAVAILABLE`)   | The database did not enter WAL mode. SQLite still serializes cross-process writers through file locking in rollback-journal mode, but that mode does not provide WAL's reader/writer concurrency and is not a validated Rundown deployment mode. SQLite returned a non-WAL mode or no readable mode, which narrows the cause to a VFS with no shared memory (a network mount such as NFS or SMB), a temporary database opened with no filename, or a connection already in a write transaction                                             | Establish which of the three applies before moving anything. A read-only file or directory is **not** among them — that fails the pragma outright and surfaces as `RD-307`. A network mount is the common case; move the project to local disk                                                                                                                              |
| `RD-307` (`STATE_STORE_UNAVAILABLE`)        | `.rundown/rundown.db` could not be opened, so commands that access persisted run state cannot continue. Store-independent commands such as `rundown check` remain available. The driver's verbatim cause distinguishes a read-only file or directory, a file that is not a database, lock contention that outlasted the bounded timeout and retries, and a host whose SQLite adapter cannot initialize                                                                                                                                     | Retry after transient lock contention; repair the host or file for persistent failures. Rundown never downgrades to the single-writer sql.js adapter outside WebContainer                                                                                                                                                                                                   |
| `RD-308` (`CONCURRENT_STATE_MODIFICATION`)  | A run-state conditional save found the run changed since it was read: another of the owner's commands committed to the same run first. Nothing was written and the persisted state is intact. This is the thrown face of the same condition `CONCURRENT_MODIFICATION` renders as a command outcome                                                                                                                                                                                                                                         | Re-read the run (`rundown status --run <run_id>`) and re-issue the command. It is never retried on your behalf                                                                                                                                                                                                                                                              |
| `RD-309` (`INVALID_PERSISTED_RUN_STATE`)    | One run's persisted state does not match the contract this build reads: unparseable state, a `schemaVersion` other than the build's own, a missing required field such as `templateVars` or `prompted`, a snapshot or cursor naming a step the runbook no longer declares, or a deprecated dynamic-step snapshot. Only that run is affected — the database and every other run in it are intact. Any command that loads the run refuses, including `complete` and `stop`                                                                   | Discard it with `rundown prune --inactive`, then re-run the runbook from source. Pruning is the only recovery: the run cannot be resumed, completed, or stopped, and a bare `rundown prune` selects completed and stopped runs only, so it never sees the invalid row (`--all` reaches it too, along with every other finished run). Rundown never migrates persisted state |

See
[docs/spec/cli-output.md § Runbook database and persisted state](../spec/cli-output.md#runbook-database-and-persisted-state-rd-306rd-309)
for the thrown `RD-306`…`RD-309` envelope shape, and
[§ `RD-309`](../spec/cli-output.md#rd-309--invalid-persisted-run-state) for the
closed set of `reason` values.

`RD-504` (`RUN_PROGRESSION_ENTRY_FAILED`) means Run Progression selected an
execution unit and then could not render its `STEP_ENTERED` entry — usually a
`--helpers` helper raising while expanding the unit's description, prompt, or
command. Nothing was consumed and nothing terminal was applied, so it is
retryable: fix the helper or entry-render failure and re-run the command, which
re-renders the same entry.

### State Recovery

If state becomes corrupted:

1. `rundown status` - List runs and spot the affected one (unreadable runs are
   reported on stderr)
2. `rundown stop [message] --token <owner_token>` - Stop a running run you own
3. `rundown prune --inactive` - Remove invalid or abandoned runs
4. `rundown prune --all` - Remove every finished and invalid run
5. `rundown run <file>` - Restart fresh

---

## Integration with Claude Code

The Claude Code plugin (`@rundown-org/claude-code-plugin`) ships the
`running-runbooks` skill, which describes the execution protocol an agent
follows: start with `rundown run`, keep the `owner_token`, and report each step
with `rundown pass` / `rundown fail` using `--token` and `--step`.

Run state lives in `.rundown/rundown.db` and survives context clears and session
restarts. The Owner Token does not: it is printed only once, so an agent that
loses it can still inspect the run (`rundown status --run <run_id>`) but can no
longer change it.

---

## CLI Quick Reference

```bash
# Lifecycle
rundown run <file>                              # Start runbook; prints owner_token once
rundown stop [message] --token <owner_token>    # Abort runbook with optional message
rundown complete [message] --token <owner_token> # Force early completion (auto-complete on final step)

# Delegation
rundown claim <ticket>                          # Claim a delegated child; prints its owner_token once
rundown collect --token <owner_token>           # Apply the delegated children's results
rundown retry --token <owner_token> --step <N.M> # Cancel a child; reserve a fresh one with a new ticket
rundown release <child-id> --agent-id <id>      # Abandon a child you claimed (collected as FAIL)

# Transitions
rundown pass --token <owner_token> --step <N>   # Step succeeded (aliases: yes, ok)
rundown fail --token <owner_token> --step <N>   # Step failed (alias: no)
rundown pass --token <owner_token> --step <N.M> --index <I> # Substep inside FOR iteration I
rundown goto <N> --token <owner_token>          # Jump to step N
rundown goto <N.M> --token <owner_token>        # Jump to substep N.M

# Status (read-only, no token)
rundown status                  # List every run
rundown status --run <run_id>   # Show one run in detail
rundown ls                      # List persisted runs
rundown ls --all                # List available runbooks

# Maintenance
rundown check <file>            # Validate runbook
rundown resolve <file>          # Resolve and validate variables/data sources
rundown prune                   # Clean up completed and stopped runs
rundown prune --inactive        # Clean up invalid or abandoned runs
rundown prune --token <owner_token> # Delete one running run you own

# Testing and utilities
rundown echo [command...]              # Test helper (configurable pass/fail)
rundown prompt <content>               # Output content in markdown fences
rundown scenario ls <file>             # List runbook scenarios
rundown scenario show <file> <name>    # Show scenario details
rundown scenario run <file> <name>     # Execute a scenario
rundown scenario-suite ls <suite>      # List scenario-suite cases
rundown scenario-suite run <suite>     # Execute suite case(s)

# Artifacts (read-only)
rundown artifact ls [--run <run_id>]   # List artifact aliases
rundown artifact inspect <alias-or-uri> # Full artifact record

# Sibling CLIs
rdpath --dir <path>          # Path assembly tool (see docs/reference/rdpath.md)
rdx <file>                   # Render JSON to Markdown (see docs/reference/rdx.md)
```
