# Rundown MCP Server Specification

This document specifies the Rundown MCP (Model Context Protocol) server: its
transport, tool surface, request and response envelope, error semantics, and the
way it delegates execution to the Rundown CLI. For runtime semantics, see
[docs/reference/runtime.md](runtime.md). For policy semantics, see
[docs/reference/security.md](security.md). For CLI usage, see
[docs/reference/cli.md](cli.md).

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in normative sections of this document are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).
Sections explicitly marked "non-normative" provide setup instructions, examples,
or troubleshooting guidance.

## 1. Scope

This specification defines the behavior of the `@rundown-org/mcp` server. It
covers the stdio transport contract, the set of MCP tools exposed by the server,
the request and response envelope, error provenance, the inheritance
relationship with the Rundown CLI, and conformance requirements.

This specification does not define Rundown document syntax, CLI command-line
semantics, runtime state machines, security policy semantics, or the inner JSON
shape of CLI command output. Those topics are defined in
[docs/spec/language.md](../spec/language.md), [docs/reference/cli.md](cli.md),
[docs/reference/runtime.md](runtime.md),
[docs/reference/security.md](security.md), and
[docs/spec/cli-output.md](../spec/cli-output.md), respectively.

<a id="overview"></a>

## 2. Terminology

| Term              | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| MCP client        | Process that consumes the server over stdio (for example Claude Desktop). |
| MCP server        | The `rundown-mcp` process exposing Rundown tools to a client.             |
| Tool              | A named, schema-validated operation registered with the MCP server.       |
| Content block     | An MCP response element of the form `{ "type": "text", "text": "..." }`.  |
| Response envelope | The MCP response object containing one or more content blocks.            |
| Active run        | The current top-level run as understood by the Rundown CLI session.       |
| Tool invocation   | A single client-initiated call to one MCP tool.                           |

## 3. Server Identity

| Aspect           | Requirement                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Package          | `@rundown-org/mcp`.                                                                          |
| Binary           | `rundown-mcp`.                                                                               |
| Server name      | The server MUST advertise the MCP server name `rundown`.                                     |
| Server version   | The server MUST advertise its package version as the MCP server version.                     |
| Transport        | The server MUST use stdio transport.                                                         |
| Runtime          | The server REQUIRES Node.js 24 or later.                                                     |
| CLI prerequisite | The server REQUIRES the Rundown CLI to be resolvable through `npx`.                          |
| Startup message  | On successful startup the server MUST write the line `Rundown MCP Server running` to stderr. |

The server MUST NOT expose any tool not defined by this specification.

<a id="architecture"></a>

## 4. CLI Delegation Model

The MCP server is a thin bridge over the Rundown CLI.

```text
[MCP Client] --stdio--> [rundown-mcp] --execFile--> [rundown CLI] --> [.rundown/]
```

| Aspect            | Requirement                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Invocation        | The server MUST execute the CLI as `npx --no rundown <args...>`.                                                              |
| Per-call timeout  | Each CLI invocation MUST be bounded by a 30 second timeout.                                                                   |
| Argument passing  | Tool arguments MUST be forwarded to the CLI as separate `argv` entries; the server MUST NOT shell-interpolate tool arguments. |
| Working directory | The CLI MUST inherit the server process working directory.                                                                    |
| Environment       | The CLI MUST inherit the server process environment without modification by the MCP layer.                                    |
| Output capture    | The server MUST capture CLI stdout and stderr and parse them per [§6](#response-format).                                      |

The MCP server MUST NOT augment, weaken, retry, migrate, or alter CLI behavior.
Policy semantics, sandboxing, prompt and non-interactive behavior, and runtime
state semantics are inherited from the CLI process and are defined by
[docs/reference/security.md](security.md) and
[docs/reference/runtime.md](runtime.md).

<a id="mcp-tools-reference"></a>

## 5. Tool Surface

### 5.1 Tool Summary

The MCP server mirrors the agent-facing CLI surface, mapping tools to CLI
subcommands so that agent clients have broadly the same execution and
coordination capabilities as a human at the terminal, EXCEPT that a subprocess
mutation boundary withholds ambient lifecycle mutations that name no lane.
Because the MCP server reaches the CLI by spawning a subprocess, typed caller
evidence cannot cross the process boundary: a spawned `rundown pass` /
`rundown fail` / `rundown delegate` arrives as an ordinary `argv`,
indistinguishable from a human at the terminal, and a **bare** one would
silently inherit direct-CLI trust (`trusted_run_controller`) over the active
run. The boundary therefore requires spawned mutating calls to present bearer
authority explicitly:

- **Claim lane** — a real `claimId`, mapped to `--claim-id <claim_id>`
  (independent claim-controller evidence for a delegated child).
- **Run selector** — a real `runId`, mapped to `--run <rd_…>`, names the target
  run but is not authority by itself.

A call carrying `claimId` passes through on the shared mutating commands. A call
carrying only `runId` is withheld in-process, because run ids are selectors, not
bearer authority. `claimId` and `runId` are mutually exclusive; the server MUST
reject a tool call carrying both before invoking the CLI. Tools that exist
purely for local session management, destructive state operations, or authoring
helpers are CLI-only (see [§5.14](#unsupported-cli-operations)).

The server MUST register exactly the following tools:

| Tool                    | Required parameters | Optional parameters                                                                        | CLI mapping                                                                                                                                                                                                                   |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`validate`](#validate) | `file`              | —                                                                                          | `rundown check <file>`                                                                                                                                                                                                        |
| [`list`](#list)         | —                   | `all`, `tags`                                                                              | `rundown ls [--all] [--tags <tags>]`                                                                                                                                                                                          |
| [`status`](#status)     | —                   | `claimId`                                                                                  | `rundown status [--claim-id <id>]`                                                                                                                                                                                            |
| [`run`](#run)           | —                   | `file`, `prompted`, `step`, `index`, `input`, `inputJson`, `inputFile`                     | `rundown run [<file>] [--prompted] [--step <id>] [--index <n>] [--input ...] [--input-json ...] [--input-file ...]`                                                                                                           |
| [`pass`](#pass)         | —                   | `step`, `index`, `claimId`, `runId`                                                        | `rundown pass [--step <id>] [--index <n>]` authorized by `--claim-id <id>` (bearer authority); `--run <rd_…>` is a selector only — a bare or runId-only form is withheld in-process ([§5.6](#pass)); reject both flags        |
| [`fail`](#fail)         | —                   | `step`, `index`, `claimId`, `runId`                                                        | `rundown fail [--step <id>] [--index <n>]` authorized by `--claim-id <id>` (bearer authority); `--run <rd_…>` is a selector only — a bare or runId-only form is withheld in-process ([§5.7](#fail)); reject both flags        |
| [`goto`](#goto)         | `step`              | `index`, `claimId`, `runId`                                                                | `rundown goto <step> [--index <n>]` authorized by `--claim-id <id>` (bearer authority); `--run <rd_…>` is a selector only — a bare or runId-only form is withheld in-process ([§5.8](#goto)); reject both flags               |
| [`complete`](#complete) | —                   | `message`, `claimId`, `runId`                                                              | `rundown complete [<message>]` authorized by `--claim-id <id>` (bearer authority); `--run <rd_…>` is a selector only — a bare or runId-only form is withheld in-process ([§5.9](#complete)); reject both flags                |
| [`stop`](#stop)         | —                   | `message`, `claimId`, `runId`                                                              | `rundown stop [<message>]` authorized by `--claim-id <id>` (bearer authority); `--run <rd_…>` is a selector only — a bare or runId-only form is withheld in-process ([§5.10](#stop)); reject both flags                       |
| [`delegate`](#delegate) | —                   | `runbook`, `step`, `index`, `retry`, `claimId`, `runId`, `input`, `inputJson`, `inputFile` | `rundown delegate …` authorized by `--claim-id <id>` (bearer authority); `--run <rd_…>` is a selector only — a bare or runId-only form is withheld in-process ([§5.11](#delegate)); reject both flags                         |
| [`claim`](#claim)       | `token`             | `input`, `inputJson`, `inputFile`                                                          | `rundown claim <token> [--input ...] [--input-json ...] [--input-file ...]`                                                                                                                                                   |
| [`collect`](#collect)   | —                   | `step`, `index`, `claimId`, `runId`                                                        | `rundown collect [--step <id>] [--index <n>]` authorized by `--claim-id <id>` (bearer authority); `--run <rd_…>` is a selector only — a bare or runId-only form is withheld in-process ([§5.13](#collect)); reject both flags |

Parameter types are defined per tool below. The server MUST validate tool inputs
against the declared schema and reject inputs that fail validation without
invoking the CLI.

Repeatable parameters (`input`, `inputJson`, `inputFile`) MUST be arrays of
strings; each element is forwarded as a separate `--input` / `--input-json` /
`--input-file` argument.

<a id="validate"></a>

### 5.2 `validate`

Check runbook syntax without execution.

| Parameter | Type   | Required | Behavior                                                   |
| --------- | ------ | -------- | ---------------------------------------------------------- |
| `file`    | string | Yes      | Path to a runbook file passed verbatim to `rundown check`. |

<a id="list"></a>

### 5.3 `list`

List active or available runbooks.

| Parameter | Type    | Required | Behavior                                                       |
| --------- | ------- | -------- | -------------------------------------------------------------- |
| `all`     | boolean | No       | When true, the server MUST forward `--all` to the CLI.         |
| `tags`    | string  | No       | When set, the server MUST forward `--tags <value>` to the CLI. |

Tag filtering is meaningful only in combination with `all: true`; the CLI
defines that semantics.

<a id="status"></a>

### 5.4 `status`

Return current runbook state.

| Parameter | Type   | Required | Behavior                                                                                       |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------------------- |
| `claimId` | string | No       | When set, forwarded as `--claim-id <value>` to scope the query to a specific delegation claim. |

<a id="run"></a>

### 5.5 `run`

Start or resume a runbook.

| Parameter   | Type        | Required | Behavior                                                                                                     |
| ----------- | ----------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `file`      | string      | No       | When set, forwarded as the positional runbook argument to `rundown run`.                                     |
| `prompted`  | boolean     | No       | When true, the server MUST forward `--prompted`.                                                             |
| `step`      | string      | No       | When set, forwarded as `--step <value>` to link a child to a parent substep or to jump to a step on entry.   |
| `index`     | integer ≥ 0 | No       | When set, forwarded as `--index <value>` to target a FOR-loop iteration. Requires `step`.                    |
| `input`     | string[]    | No       | Each element forwarded as a separate `--input <value>` argument (`key=value`, or `key` to inherit from env). |
| `inputJson` | string[]    | No       | Each element forwarded as a separate `--input-json <value>` argument (`key=<json>`).                         |
| `inputFile` | string[]    | No       | Each element forwarded as a separate `--input-file <path>` argument.                                         |

Variable resolution semantics — precedence, env bridging via `RD_INPUT_*`,
delegation inheritance, reserved names — are defined by
[docs/reference/runtime.md §Variable Resolution](runtime.md#template-variables)
and apply unchanged when variables are supplied through MCP.

<a id="pass"></a>

### 5.6 `pass`

Mark a step as passed.

| Parameter | Type        | Required | Behavior                                                                                              |
| --------- | ----------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `step`    | string      | No       | When set, forwarded as `--step <value>` to target a specific substep.                                 |
| `index`   | integer ≥ 0 | No       | When set, forwarded as `--index <value>` to target a FOR-loop iteration. Requires `step`.             |
| `claimId` | string      | No       | When set, forwarded as `--claim-id <value>` to scope to a delegation claim.                           |
| `runId`   | string      | No       | When set, forwarded as `--run <value>` (`rd_<32 hex>`) for target selection. Not authority by itself. |

Over MCP, `pass` REQUIRES bearer authority: a `pass` without a real `claimId` is
classified as a subprocess lifecycle mutation and withheld in-process — the
server MUST return a withheld-mutation `error` payload WITHOUT invoking the CLI.
A spawned bare `rundown pass` would be a mutation without bearer proof. `runId`
by itself is target selection, not authority. Supplying both `claimId` and
`runId` is rejected before the CLI is invoked. To mark a non-delegated
standalone step passed, run `rundown pass` directly in a trusted terminal.

<a id="fail"></a>

### 5.7 `fail`

Mark a step as failed.

| Parameter | Type        | Required | Behavior                                                                                              |
| --------- | ----------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `step`    | string      | No       | When set, forwarded as `--step <value>` to target a specific substep.                                 |
| `index`   | integer ≥ 0 | No       | When set, forwarded as `--index <value>` to target a FOR-loop iteration. Requires `step`.             |
| `claimId` | string      | No       | When set, forwarded as `--claim-id <value>` to scope to a delegation claim.                           |
| `runId`   | string      | No       | When set, forwarded as `--run <value>` (`rd_<32 hex>`) for target selection. Not authority by itself. |

Over MCP, `fail` REQUIRES explicit targeting, exactly as [`pass`](#pass): a bare
`fail` without a real `claimId` is classified as a subprocess lifecycle mutation
and withheld in-process — the server MUST return a withheld-mutation `error`
payload WITHOUT invoking the CLI. A real `claimId` is forwarded to the CLI;
`runId` alone is not authority, and `claimId` cannot be combined with `runId`.
To mark a non-delegated standalone step failed, run `rundown fail` directly in a
trusted terminal.

<a id="goto"></a>

### 5.8 `goto`

Jump to a step.

| Parameter | Type        | Required | Behavior                                                                                                   |
| --------- | ----------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `step`    | string      | Yes      | Target step (for example `"3"` or `"2.1"`), forwarded verbatim to `rundown goto`.                          |
| `index`   | integer ≥ 0 | No       | When set, forwarded as `--index <value>` to target a FOR-loop iteration.                                   |
| `claimId` | string      | No       | When set, forwarded as `--claim-id <value>` to scope to a delegation claim.                                |
| `runId`   | string      | No       | When set, forwarded as `--run <value>` (`rd_<32 hex>`) for target selection only. Not authority by itself. |

Over MCP, `goto` follows the same two-lane rule as [`pass`](#pass): a bare jump
(no `claimId`) on a delegation-exposed run is withheld in-process; name the
claim bearer (`claimId`). `runId` alone is withheld, and `claimId` cannot be
combined with `runId`.

<a id="complete"></a>

### 5.9 `complete`

Force early completion of the active runbook.

| Parameter | Type   | Required | Behavior                                                                                                   |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| `message` | string | No       | When set, forwarded as the positional message argument to `rundown complete`.                              |
| `claimId` | string | No       | When set, forwarded as `--claim-id <value>` to scope to a delegation claim.                                |
| `runId`   | string | No       | When set, forwarded as `--run <value>` (`rd_<32 hex>`) for target selection only. Not authority by itself. |

Without `claimId` or `runId`, this mirrors bare `rundown complete`, which is
withheld at the boundary (and, since R1, refused by core on any
delegation-exposed run with `ACTOR_CONTEXT_REQUIRED`). Supply the claim lane
(`claimId`) to forward the call. `runId` alone is withheld, and `claimId` cannot
be combined with `runId`. When forwarded, `rundown complete` inside inline
composition targets the outermost contiguous-inline ancestor. See
[docs/reference/cli.md](cli.md#force-terminal-targeting) for force-terminal
targeting semantics.

<a id="stop"></a>

### 5.10 `stop`

Abort the active runbook.

| Parameter | Type   | Required | Behavior                                                                                                   |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| `message` | string | No       | When set, forwarded as the positional message argument to `rundown stop`.                                  |
| `claimId` | string | No       | When set, forwarded as `--claim-id <value>` to scope to a delegation claim.                                |
| `runId`   | string | No       | When set, forwarded as `--run <value>` (`rd_<32 hex>`) for target selection only. Not authority by itself. |

Without `claimId` or `runId`, this mirrors bare `rundown stop`, which is
withheld at the boundary (and, since R1, refused by core on any
delegation-exposed run with `ACTOR_CONTEXT_REQUIRED`). Supply the claim lane
(`claimId`) to forward the call. `runId` alone is withheld, and `claimId` cannot
be combined with `runId`. When forwarded, `rundown stop` is a failure terminal
that exits non-zero, and inside inline composition it targets the outermost
contiguous-inline ancestor. See
[docs/reference/cli.md](cli.md#force-terminal-targeting) for force-terminal
targeting semantics.

<a id="delegate"></a>

### 5.11 `delegate`

**Available WITH `claimId`; the bare form is withheld.** A `delegate` call that
presents the orchestrator bearer (`claimId`, mapped to `--claim-id <id>`) is
forwarded to the CLI. A **bare** `delegate` (no `claimId`) is withheld: the
server MUST return a withheld-mutation `error` payload WITHOUT spawning the CLI,
because a subprocess-spawned bare `delegate` would mutate without bearer
authority. `runId` is target selection only and cannot exempt the withhold.
Supplying both `claimId` and `runId` is rejected before the CLI is invoked.

| Parameter   | Type        | Required | Behavior                                                                                                    |
| ----------- | ----------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `runbook`   | string      | No       | Positional runbook argument forwarded to `rundown delegate`.                                                |
| `step`      | string      | No       | Substep being delegated, forwarded as `--step <value>`.                                                     |
| `index`     | integer ≥ 0 | No       | FOR-loop targeting, forwarded as `--index <value>`. Requires `step`.                                        |
| `retry`     | boolean     | No       | Retry an existing delegation, forwarded as `--retry`.                                                       |
| `claimId`   | string      | No       | Bearer claim returned by `rundown run`, forwarded as `--claim-id <value>`. Required to exempt the withhold. |
| `runId`     | string      | No       | Optional run selector (`rd_<32 hex>`), mutually exclusive with `claimId`.                                   |
| `input`     | string[]    | No       | `--input <value>` arguments.                                                                                |
| `inputJson` | string[]    | No       | `--input-json <value>` arguments.                                                                           |
| `inputFile` | string[]    | No       | `--input-file <path>` arguments.                                                                            |

To delegate or retry from a plain terminal instead, run `rundown delegate`
directly. Delegation semantics — token issuance, claim lifecycle, abort,
collection — are defined by
[docs/reference/cli.md Delegation Commands](cli.md#delegation-commands).

<a id="claim"></a>

### 5.12 `claim`

Claim a delegation token and launch the child runbook.

| Parameter   | Type     | Required | Behavior                                                                   |
| ----------- | -------- | -------- | -------------------------------------------------------------------------- |
| `token`     | string   | Yes      | Delegation token, forwarded as the positional argument to `rundown claim`. |
| `input`     | string[] | No       | Each element forwarded as a separate `--input <value>` argument.           |
| `inputJson` | string[] | No       | Each element forwarded as a separate `--input-json <value>` argument.      |
| `inputFile` | string[] | No       | Each element forwarded as a separate `--input-file <path>` argument.       |

<a id="collect"></a>

### 5.13 `collect`

Aggregate a delegated step and advance the parent runbook through core.

| Parameter | Type        | Required | Behavior                                                                                                   |
| --------- | ----------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `step`    | string      | No       | When set, forwarded as `--step <value>` to scope the collection to a specific substep.                     |
| `index`   | integer ≥ 0 | No       | When set, forwarded as `--index <value>` for FOR-loop targeting. Requires `step`.                          |
| `claimId` | string      | No       | When set, forwarded as `--claim-id <value>` to scope to a delegation claim.                                |
| `runId`   | string      | No       | When set, forwarded as `--run <value>` (`rd_<32 hex>`) for target selection only. Not authority by itself. |

Over MCP, `collect` REQUIRES bearer authority: a `collect` without a real
`claimId` is classified as a subprocess lifecycle mutation and withheld
in-process — the server MUST return a withheld-mutation `error` payload WITHOUT
invoking the CLI. A spawned bare `rundown collect` would be parent aggregation
without bearer proof. A `collect` carrying a real `claimId` presents bearer
evidence; `runId` alone is withheld. Collection still requires an actor
controlling the target delegating run, and `claimId` cannot be combined with
`runId`: collecting into an ancestor the caller does not control remains refused
by core policy (`COLLECT_REQUIRES_ORCHESTRATOR`). To aggregate a delegated step
on the parent from a plain terminal, run `rundown collect` directly.

<a id="unsupported-cli-operations"></a>

### 5.14 Unsupported CLI Operations

The MCP server MUST NOT expose the following CLI capabilities. Clients requiring
these capabilities MUST drive the CLI directly.

| CLI capability                                                                          | Reason for exclusion                                                              |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `stash`, `pop`                                                                          | Local session state management.                                                   |
| `abort`                                                                                 | Destructive operation on a token a peer may still be holding; CLI-only by policy. |
| `prune`                                                                                 | Destructive state operation.                                                      |
| `scenario`, `scenario-suite`                                                            | Authoring and testing surfaces.                                                   |
| `prompt`, `echo`                                                                        | Authoring helpers.                                                                |
| `--schema`                                                                              | JSON Schema introspection is a CLI inspection feature.                            |
| Policy flags (`--allow-*`, `--deny-all`, `--policy`, `--sandbox*`, `--trust-js-policy`) | Policy is inherited from CLI invocation context.                                  |

<a id="response-format"></a>

## 6. Request and Response Format

### 6.1 Tool Input

Tool inputs MUST conform to the schema declared in [§5](#mcp-tools-reference).
Unknown properties MAY be ignored, EXCEPT for [`delegate`](#delegate), whose
schema is strict — unknown keys are rejected. (Because `delegate` is withheld
regardless (see [§5.11](#delegate)), this strictness is moot in practice.)
Type-incorrect properties MUST cause the server to reject the invocation without
spawning the CLI.

### 6.2 Response Envelope

Every tool response MUST be an MCP response object whose `content` field is an
array containing exactly one text content block. The `text` field MUST be a
pretty-printed (two-space indent) JSON serialization of the response payload.

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"step\": \"2\",\n  \"status\": \"running\"\n}"
    }
  ]
}
```

### 6.3 Success Payload

When the CLI exits with status zero and produces non-empty stdout, the
serialized response payload MUST be the parsed CLI stdout payload.

When the CLI exits with status zero and produces empty stdout, the serialized
response payload MUST represent the absence of data. The exact JSON shape is
implementation-defined but MUST NOT include an `error` field.

### 6.4 Error Payload

When the CLI exits with non-zero status, the serialized response payload MUST
include an `error` field carrying a human-readable message. Error provenance
MUST follow this order:

1. JSON parsed from CLI stdout, if any.
2. JSON parsed from CLI stderr, if any.
3. Trimmed raw stderr or stdout text.
4. The transport-layer error message.

The first source that yields content MUST be used. The server MUST NOT retry the
CLI on error.

Not every `error` payload originates from the CLI. Some errors are generated
**in-process** and never involve a CLI invocation, yet MUST be returned in the
same `{ "error": ... }` envelope shape:

- **Withheld-mutation errors** — a bare `pass` / `fail` (no claim evidence) or
  any `delegate` call (see [§5.6](#pass), [§5.7](#fail), [§5.11](#delegate)) is
  refused by the subprocess mutation boundary before the CLI is spawned.
- **`delegate` claim-id validation errors** — a `delegate` call carrying
  `--claim-id` is rejected in-process, since delegation has no claim-controller
  form.
- **Schema-validation and argv-build failures** — inputs that fail the tool's
  declared schema, or that cannot be mapped to a valid CLI `argv`, are formatted
  in-process without invoking the CLI.

The stdout-then-stderr-then-raw provenance order above applies only to errors
that DO reach the CLI.

### 6.5 Multi-Payload Stdout

The CLI MAY emit multiple JSON payloads on stdout (for example interleaved event
lines and a terminal command result). When more than one JSON value is present,
the server MUST prefer the last value whose object representation contains a
`command` key, or (for legacy payloads) an `action` key. If no such value
exists, the server MUST surface all parsed values as an array.

### 6.6 Streaming

The MCP server MUST NOT stream partial CLI output to the client. Each tool
invocation MUST resolve to exactly one response envelope.

## 7. Variables and Inputs

The MCP tool surface exposes Rundown variable configuration through the
repeatable `input`, `inputJson`, and `inputFile` parameters on `run`,
`delegate`, and `claim` (see [§5](#mcp-tools-reference)). Semantics —
precedence, file-path scoping, JSON parsing, env bridging through `RD_INPUT_*`,
delegation inheritance, dynamic built-ins, and reserved names — are defined by
[docs/reference/runtime.md §Variable Resolution](runtime.md#template-variables)
and apply unchanged when variables are supplied through MCP.

`RD_INPUT_*` environment variables present in the MCP server's process
environment MUST also flow to the CLI unchanged through normal environment
inheritance.

<a id="delegation"></a>

## 8. Delegation

The MCP server exposes the delegation lifecycle through the [`claim`](#claim)
and [`collect`](#collect) tools. Issuing a delegation via
[`delegate`](#delegate) is NOT available over MCP: every `delegate` call is
withheld in-process by the subprocess mutation boundary (see
[§5.11](#delegate)), because delegation carries no claim evidence and a
subprocess-spawned `delegate` would silently inherit direct-CLI trust over the
active run. To issue or retry a delegation, run `rundown delegate` directly in a
trusted terminal. For the claim tool, claim lifecycle is inherited unchanged
from the CLI; the MCP server adds no policy or state of its own. A bare
`collect` (no `claimId`) is likewise withheld in-process by the subprocess
mutation boundary ([§5.13](#collect)) — a claim-evidenced `collect` carrying a
real `claimId` is unaffected, and its result aggregation is inherited unchanged
from the CLI. Token abort likewise remains CLI-only (see
[§5.14](#unsupported-cli-operations)). See
[docs/reference/cli.md Delegation Commands](cli.md#delegation-commands) and
[docs/reference/runtime.md State Persistence](runtime.md#state-persistence).

<a id="security-and-state"></a>

## 9. Security and Runtime Inheritance

The MCP server MUST NOT define independent policy, sandbox, or state semantics.

| Concern                                                     | Source of truth                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Command, file, and environment policy                       | [docs/reference/security.md](security.md).                                                                             |
| Sandbox enforcement                                         | [docs/reference/security.md §Filesystem Sandbox](security.md#sandbox-usage).                                           |
| Policy modes (`prompted`, `execute`, `deny`) and CLI grants | [docs/reference/security.md](security.md).                                                                             |
| Runtime state, sessions, claims, stash semantics            | [docs/reference/runtime.md §State Persistence](runtime.md#state-persistence).                                          |
| Invalid persisted state and no-migration rule               | [docs/reference/runtime.md §Invalid Persisted State / No Migration](runtime.md#invalid-persisted-state--no-migration). |
| Variable resolution                                         | [docs/reference/runtime.md §Variable Resolution](runtime.md#template-variables).                                       |

When the CLI fails closed on stale or incompatible persisted state, the MCP
server MUST surface the CLI's error verbatim through the response envelope. The
MCP server MUST NOT shim, retry, migrate, rewrite, or otherwise mask such
errors.

## 10. Conformance

A conforming Rundown MCP server MUST satisfy the following requirements:

1. Advertise the MCP server name `rundown` and the package version as server
   version.
2. Use stdio transport and write `Rundown MCP Server running` to stderr on
   successful startup.
3. Register exactly the tools defined in [§5](#mcp-tools-reference).
4. Validate tool inputs against their declared schemas and reject invalid inputs
   without invoking the CLI.
5. Invoke the CLI through `npx --no rundown <args>` with a 30 second per-call
   timeout.
6. Forward tool arguments as separate `argv` entries without shell
   interpolation.
7. Return responses as a single text content block whose `text` is the
   pretty-printed JSON payload.
8. On success with empty stdout, return a payload that does not include an
   `error` field.
9. On CLI failure, populate `error` using the stdout-then-stderr-then-raw
   provenance order defined in [§6.4](#response-format).
10. When CLI stdout contains multiple JSON values, return the last `command`- or
    `action`-keyed payload, or all parsed payloads as an array if none is
    present.
11. Refuse to expose unsupported CLI capabilities listed in
    [§5.14](#unsupported-cli-operations).
12. Inherit policy and runtime semantics from the CLI process without
    modification, retry, or migration.

---

## Installation (non-normative) <a id="installation"></a>

```bash
npm install -g @rundown-org/mcp
```

Verify:

```bash
rundown-mcp --help
```

The CLI must also be resolvable through `npx`:

```bash
npm install -g @rundown-org/cli
```

## Claude Desktop Configuration (non-normative) <a id="claude-desktop-configuration"></a>

Configuration file location:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Default (use `npx`):

```json
{
  "mcpServers": {
    "rundown": {
      "command": "npx",
      "args": ["rundown-mcp"]
    }
  }
}
```

Global install:

```json
{
  "mcpServers": {
    "rundown": {
      "command": "rundown-mcp"
    }
  }
}
```

### Codex plugin config

The Rundown Codex plugin references the existing stdio server through
`.mcp.json`:

```json
{
  "mcpServers": {
    "rundown": {
      "command": "rundown-mcp"
    }
  }
}
```

This config does not change MCP semantics. The server remains a local stdio
front end over the Rundown CLI.

Project-scoped working directory:

```json
{
  "mcpServers": {
    "rundown": {
      "command": "npx",
      "args": ["--no", "rundown-mcp"],
      "cwd": "/path/to/project"
    }
  }
}
```

## Examples (non-normative)

Validate a runbook:

```json
{
  "tool": "validate",
  "arguments": { "file": "deploy.runbook.md" }
}
```

Start a runbook in prompted mode:

```json
{
  "tool": "run",
  "arguments": { "file": "deploy.runbook.md", "prompted": true }
}
```

Jump to a substep:

```json
{
  "tool": "goto",
  "arguments": { "step": "2.1" }
}
```

Sample success response:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"step\": \"2\",\n  \"status\": \"running\"\n}"
    }
  ]
}
```

Sample error response:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"error\": \"No active runbook\"\n}"
    }
  ]
}
```

<a id="troubleshooting"></a>

## Troubleshooting (non-normative)

| Symptom                      | Likely cause                                                                           | Resolution                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command not found: rundown` | CLI not installed or not on `PATH`.                                                    | `npm install -g @rundown-org/cli`.                                                                                                                                            |
| `No active runbook`          | No run is active.                                                                      | Start one with the `run` tool.                                                                                                                                                |
| Timeout after 30 seconds     | CLI invocation hung (interactive prompt, blocked policy decision, missing dependency). | Run the equivalent CLI command directly. Confirm `--non-interactive` semantics in the host environment.                                                                       |
| Empty response               | CLI produced no stdout.                                                                | Check stderr in MCP host logs and run the CLI directly.                                                                                                                       |
| Invalid-state error surfaced | CLI refused to resume an incompatible persisted run.                                   | Finish or close the run, or prune the affected state and restart. See [runtime.md §Invalid Persisted State / No Migration](runtime.md#invalid-persisted-state--no-migration). |

To debug further:

1. Inspect MCP host logs for stderr from `rundown-mcp`.
2. Run the corresponding CLI command directly with `--text` for human-readable
   output.
3. Confirm `.rundown/` state files exist and are readable.
4. Confirm `npx` can resolve `rundown` from the MCP server's working directory.
