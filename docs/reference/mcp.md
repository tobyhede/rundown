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

| Term              | Meaning                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| MCP client        | Process that consumes the server over stdio (for example Claude Desktop).   |
| MCP server        | The `rundown-mcp` process exposing Rundown tools to a client.               |
| Tool              | A named, schema-validated operation registered with the MCP server.         |
| Content block     | An MCP response element of the form `{ "type": "text", "text": "..." }`.    |
| Response envelope | The MCP response object containing one or more content blocks.              |
| Owner Token       | `rdo_…` secret printed once by `rundown run`; the run's mutation authority. |
| Run id            | `rd_…` identifier of a run; a read-only selector.                           |
| Tool invocation   | A single client-initiated call to one MCP tool.                             |

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

The MCP server mirrors the agent-facing CLI surface: each tool maps to one CLI
subcommand, and the CLI decides every outcome. Authority follows the CLI's run
ownership model (see
[docs/reference/cli.md Run Ownership](cli.md#run-ownership)):

- **Owner Token** — `rundown run` prints the run's Owner Token
  (`rdo_<43 base64url characters>`) once, as `owner_token` on the
  `runbook_started` event. Every mutating tool (`pass`, `fail`, `goto`,
  `complete`, `stop`, `collect`, `retry`) REQUIRES it as `token`, forwarded as
  `--token <token>`. The token both selects the run and proves ownership.
- **Claim Ticket** — a delegated step's `step_entered` lists each child's Claim
  Ticket (`rdt_<43 base64url characters>`). `claim` REQUIRES it as `ticket`; it
  is that tool's only authority, and its response carries the child's own Owner
  Token.
- **Agent id** — `claim` records `agentId` on the child; `release` takes the
  child's run id as `runId` and the same `agentId`, which the CLI matches
  against the one the claim recorded. The agent supplies it on both calls: no
  hook stamps it yet (#907). It takes no token, and its authority covers that
  one write.
- **Run selector** — `runId` (`rd_<32 hex>`), accepted by `status` and forwarded
  as `--run <runId>`, selects a run for reading. It is never mutation authority:
  `release` takes a `runId` only to name the child its agent id authorizes.

The server checks only that `token` is present and is a string; a call without
it fails schema validation in-process. Resolving the token, and refusing a
malformed, unknown, or finished-run token (`INVALID_SYNTAX`, `UNKNOWN_TOKEN`,
`RD-303`, `RD-304`), is the CLI's job; the server passes those refusals through
unchanged.

The server MUST register exactly the following tools:

| Tool                    | Required parameters | Optional parameters                                                    | CLI mapping                                                                                                         |
| ----------------------- | ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`validate`](#validate) | `file`              | —                                                                      | `rundown check <file>`                                                                                              |
| [`list`](#list)         | —                   | `all`, `tags`                                                          | `rundown ls [--all] [--tags <tags>]`                                                                                |
| [`status`](#status)     | —                   | `runId`                                                                | `rundown status [--run <runId>]`                                                                                    |
| [`run`](#run)           | —                   | `file`, `prompted`, `step`, `index`, `input`, `inputJson`, `inputFile` | `rundown run [<file>] [--prompted] [--step <id>] [--index <n>] [--input ...] [--input-json ...] [--input-file ...]` |
| [`pass`](#pass)         | `token`, `step`     | `index`                                                                | `rundown pass --token <token> --step <id> [--index <n>]`                                                            |
| [`fail`](#fail)         | `token`, `step`     | `index`                                                                | `rundown fail --token <token> --step <id> [--index <n>]`                                                            |
| [`goto`](#goto)         | `token`, `step`     | `index`                                                                | `rundown goto <step> --token <token> [--index <n>]`                                                                 |
| [`complete`](#complete) | `token`             | `message`                                                              | `rundown complete [<message>] --token <token>`                                                                      |
| [`stop`](#stop)         | `token`             | `message`                                                              | `rundown stop [<message>] --token <token>`                                                                          |
| [`claim`](#claim)       | `ticket`            | `agentId`                                                              | `rundown claim <ticket> [--agent-id <agentId>]`                                                                     |
| [`collect`](#collect)   | `token`             | —                                                                      | `rundown collect --token <token>`                                                                                   |
| [`retry`](#retry)       | `token`, `step`     | `index`                                                                | `rundown retry --token <token> --step <id> [--index <n>]`                                                           |
| [`release`](#release)   | `runId`             | `agentId`                                                              | `rundown release <runId> [--agent-id <agentId>]`                                                                    |

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

List persisted runs, or available runbook files when `all` is true.

| Parameter | Type    | Required | Behavior                                                       |
| --------- | ------- | -------- | -------------------------------------------------------------- |
| `all`     | boolean | No       | When true, the server MUST forward `--all` to the CLI.         |
| `tags`    | string  | No       | When set, the server MUST forward `--tags <value>` to the CLI. |

Tag filtering is meaningful only in combination with `all: true`; the CLI
defines that semantics.

<a id="status"></a>

### 5.4 `status`

Return run state: every run when `runId` is absent, or one run in detail. No
status response carries an Owner Token.

| Parameter | Type   | Required | Behavior                                                                                       |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------------------- |
| `runId`   | string | No       | When set, forwarded as `--run <value>` (`rd_<32 hex>`) to select one run. Read-only selection. |

<a id="run"></a>

### 5.5 `run`

Start a runbook. The CLI's `runbook_started` event carries `owner_token`, the
only place the token is ever printed; the client MUST keep it to call any
mutating tool on that run. The response is the full event stream
([§6.5](#65-multi-payload-stdout)), so it includes that event and the
`step_entered` naming the first position.

| Parameter   | Type        | Required | Behavior                                                                                                                                     |
| ----------- | ----------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`      | string      | No       | When set, forwarded as the positional runbook argument to `rundown run`.                                                                     |
| `prompted`  | boolean     | No       | When true, the server MUST forward `--prompted`.                                                                                             |
| `step`      | string      | No       | When set, forwarded as `--step <value>` to jump to that step after starting. The CLI refuses it without `prompted: true` (`INVALID_SYNTAX`). |
| `index`     | integer ≥ 0 | No       | When set, forwarded as `--index <value>` to target a FOR-loop iteration. Requires `step`; the server rejects `index` without `step`.         |
| `input`     | string[]    | No       | Each element forwarded as a separate `--input <value>` argument (`key=value`, or `key` to inherit from env).                                 |
| `inputJson` | string[]    | No       | Each element forwarded as a separate `--input-json <value>` argument (`key=<json>`).                                                         |
| `inputFile` | string[]    | No       | Each element forwarded as a separate `--input-file <path>` argument.                                                                         |

Variable resolution semantics — precedence, env bridging via `RD_INPUT_*`,
reserved names — are defined by
[docs/reference/runtime.md §Variable Resolution](runtime.md#template-variables)
and apply unchanged when variables are supplied through MCP.

Inline children (runbook-list substeps without `DELEGATE`) run as they do
through the CLI: the run's Owner Token drives the deepest running inline child,
and the event stream carries each child's events under its own `runbookId`.
Delegations (`DELEGATE` substeps) are driven by the `claim` and `collect` tools:
a delegated step's `step_entered` lists each child's Claim Ticket, `claim`
starts the child and returns its own Owner Token, and `collect` applies the
children's results with the parent's token.

<a id="pass"></a>

### 5.6 `pass`

Mark the current step passed.

| Parameter | Type        | Required | Behavior                                                                                            |
| --------- | ----------- | -------- | --------------------------------------------------------------------------------------------------- |
| `token`   | string      | Yes      | Owner Token from `runbook_started`, forwarded as `--token <value>`.                                 |
| `step`    | string      | Yes      | The run's current position (for example `"2"` or `"2.1"`), forwarded as `--step <value>`.           |
| `index`   | integer ≥ 0 | No       | Forwarded as `--index <value>`. Required by the CLI inside a FOR iteration and refused outside one. |

`step` and `index` confirm the run's current position; they do not select a
different step. A position that does not match is refused by the CLI with
`INVALID_STEP` before anything is written.

<a id="fail"></a>

### 5.7 `fail`

Mark the current step failed. Parameters and position rules are identical to
[`pass`](#pass).

| Parameter | Type        | Required | Behavior                                                                                            |
| --------- | ----------- | -------- | --------------------------------------------------------------------------------------------------- |
| `token`   | string      | Yes      | Owner Token from `runbook_started`, forwarded as `--token <value>`.                                 |
| `step`    | string      | Yes      | The run's current position (for example `"2"` or `"2.1"`), forwarded as `--step <value>`.           |
| `index`   | integer ≥ 0 | No       | Forwarded as `--index <value>`. Required by the CLI inside a FOR iteration and refused outside one. |

<a id="goto"></a>

### 5.8 `goto`

Jump to a step.

| Parameter | Type        | Required | Behavior                                                                          |
| --------- | ----------- | -------- | --------------------------------------------------------------------------------- |
| `token`   | string      | Yes      | Owner Token from `runbook_started`, forwarded as `--token <value>`.               |
| `step`    | string      | Yes      | Target step (for example `"3"` or `"2.1"`), forwarded verbatim to `rundown goto`. |
| `index`   | integer ≥ 0 | No       | When set, forwarded as `--index <value>` to target a FOR-loop iteration.          |

<a id="complete"></a>

### 5.9 `complete`

Force early completion of the run.

| Parameter | Type   | Required | Behavior                                                                      |
| --------- | ------ | -------- | ----------------------------------------------------------------------------- |
| `token`   | string | Yes      | Owner Token from `runbook_started`, forwarded as `--token <value>`.           |
| `message` | string | No       | When set, forwarded as the positional message argument to `rundown complete`. |

See [docs/reference/cli.md](cli.md#force-terminal-targeting) for force-terminal
semantics.

<a id="stop"></a>

### 5.10 `stop`

Abort the run.

| Parameter | Type   | Required | Behavior                                                                  |
| --------- | ------ | -------- | ------------------------------------------------------------------------- |
| `token`   | string | Yes      | Owner Token from `runbook_started`, forwarded as `--token <value>`.       |
| `message` | string | No       | When set, forwarded as the positional message argument to `rundown stop`. |

`rundown stop` is a failure terminal that exits non-zero after stopping the run;
its final action object is still returned as the payload (see
[§6.4](#response-format)). See
[docs/reference/cli.md](cli.md#force-terminal-targeting) for force-terminal
semantics.

The tool has no `runId` parameter and never emits `--run`: the human escape
hatch for a lost top-level token, `rundown stop --run <run-id>`, needs a person
at an interactive terminal, which an MCP caller is not (see
[docs/reference/cli.md](cli.md#escape-hatch)). An agent that lost its token asks
the user to run it.

<a id="claim"></a>

### 5.10a `claim`

Claim a delegated child by its Claim Ticket and start it.

| Parameter | Type   | Required | Behavior                                                                                     |
| --------- | ------ | -------- | -------------------------------------------------------------------------------------------- |
| `ticket`  | string | Yes      | Claim Ticket from a delegated step's `step_entered` `children`, forwarded positionally.      |
| `agentId` | string | No       | Identity of the claiming agent, forwarded as `--agent-id <value>` and recorded on the child. |

The payload is the child's event stream; its `runbook_started` carries the
child's `owner_token`, which every later tool call on the child presents as
`token`. Refusals (`UNKNOWN_TICKET`, `ALREADY_CLAIMED`, `DELEGATION_CANCELLED`,
`PARENT_RUN_FINISHED`) pass through unchanged. See
[docs/reference/cli.md § Delegation](cli.md#delegation).

<a id="collect"></a>

### 5.10b `collect`

Apply the results of the run's delegated children.

| Parameter | Type   | Required | Behavior                                                            |
| --------- | ------ | -------- | ------------------------------------------------------------------- |
| `token`   | string | Yes      | Owner Token from `runbook_started`, forwarded as `--token <value>`. |

The payload starts with a `children_collected` event naming each child's status
(`collected`, `already_collected`, `pending`, `unclaimed`, `cancelled`),
followed by the run's continuation when a result moved it.

<a id="retry"></a>

### 5.10c `retry`

Cancel a delegated substep's child and reserve a fresh one with a new Claim
Ticket — the recovery for a lost ticket, an unclaimed child, or a child whose
Owner Token was lost.

| Parameter | Type    | Required | Behavior                                                            |
| --------- | ------- | -------- | ------------------------------------------------------------------- |
| `token`   | string  | Yes      | Owner Token from `runbook_started`, forwarded as `--token <value>`. |
| `step`    | string  | Yes      | The delegated substep (`3.1`), forwarded as `--step <value>`.       |
| `index`   | integer | No       | The current FOR iteration, forwarded as `--index <value>`.          |

The payload is one `delegation_retried` event naming the `cancelledRunId` and
listing the fresh child in `children` with its new `ticket`, printed there once.
Refusals (`INVALID_STEP`, `NOTHING_TO_RETRY`, …) pass through unchanged.

<a id="release"></a>

### 5.10d `release`

Abandon a delegated child its claiming agent cannot finish; its parent collects
it as a fail while it still counts it.

| Parameter | Type   | Required | Behavior                                                                           |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------- |
| `runId`   | string | Yes      | The child's run id (`runbookId` of its `runbook_started`), forwarded positionally. |
| `agentId` | string | No       | The agent id the claim recorded, forwarded as `--agent-id <value>`.                |

The payload is the child's `runbook_abandoned` event: `parent.standing` says
whether the parent still collects it (`current`) or never will (`cancelled`,
`parent_finished`, `parent_pruned`), and `abandonedInline` lists the running
Inline Children abandoned with it. Refusals (`AGENT_MISMATCH`,
`NOT_A_DELEGATION`, `RUN_TARGET_UNAVAILABLE`, `RD-303` / `RD-304`) pass through
unchanged.

<a id="unsupported-cli-operations"></a>

### 5.11 Unsupported CLI Operations

The MCP server MUST NOT expose the following CLI capabilities. Clients requiring
these capabilities MUST drive the CLI directly.

| CLI capability                                                                          | Reason for exclusion                                   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `prune`                                                                                 | Destructive state operation.                           |
| `artifact`                                                                              | Artifact inspection is a CLI inspection feature.       |
| `resolve`                                                                               | Authoring helper.                                      |
| `scenario`, `scenario-suite`                                                            | Authoring and testing surfaces.                        |
| `prompt`, `echo`                                                                        | Authoring helpers.                                     |
| `run --artifacts`, `run --artifacts-json`                                               | Input artifacts are supplied through the CLI only.     |
| `--schema`                                                                              | JSON Schema introspection is a CLI inspection feature. |
| `--text`                                                                                | The MCP surface is JSON only.                          |
| Policy flags (`--allow-*`, `--deny-all`, `--policy`, `--sandbox*`, `--trust-js-policy`) | Policy is inherited from CLI invocation context.       |

<a id="response-format"></a>

## 6. Request and Response Format

### 6.1 Tool Input

Tool inputs MUST conform to the schema declared in [§5](#mcp-tools-reference).
Unknown properties MAY be ignored; they are never forwarded to the CLI.
Type-incorrect or missing required properties MUST cause the server to reject
the invocation without spawning the CLI.

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

### 6.4 Non-Zero Exit Payload

When the CLI exits with non-zero status, the serialized response payload MUST be
taken from the first of these sources that yields content:

1. JSON parsed from CLI stdout, if it parses to an object or array.
2. JSON parsed from CLI stderr, if it parses to an object or array.
3. `{ "error": <text> }`, where `<text>` is the trimmed raw stderr, or failing
   that the trimmed raw stdout.
4. `{ "error": <message> }`, carrying the transport-layer error message.

A CLI refusal is a JSON error envelope
(`{ "kind": "error", "error": …, "code": … }`; see
[docs/spec/cli-output.md § Error Output](../spec/cli-output.md#error-output-all-commands)),
so it reaches the client with its `code` intact. A command that exits non-zero
by design — `stop` — returns its final action object, which carries no `error`
field. The server MUST NOT retry the CLI on error.

Some errors are generated **in-process** and never involve a CLI invocation:
inputs that fail the tool's declared schema, or that cannot be mapped to a valid
CLI `argv`, are formatted as `{ "error": "<path>: <message>; ..." }` without
invoking the CLI. The provenance order above applies only to calls that reach
the CLI.

### 6.5 Multi-Payload Stdout

Streaming commands emit newline-delimited JSON (see
[docs/spec/cli-output.md § Response Type Detection](../spec/cli-output.md#response-type-detection)).
When the output is not a single JSON value, the server parses each line that
begins with `{` and ignores the rest. If exactly one object parses, it is the
payload. Otherwise the payload MUST be the array of every parsed object, in
emission order. The server does not choose a line: the events a client needs
next are spread across the stream — `runbook_started` carries the one-time
`owner_token`, and `step_entered` names the position the next `pass` / `fail`
must confirm.

On a non-zero exit whose payload is such an array, the response's error message
is the `error` field of the last object that has one
([§6.4](#64-non-zero-exit-payload)).

### 6.6 Streaming

The MCP server MUST NOT stream partial CLI output to the client. Each tool
invocation MUST resolve to exactly one response envelope.

## 7. Variables and Inputs

The MCP tool surface exposes Rundown variable configuration through the
repeatable `input`, `inputJson`, and `inputFile` parameters on `run` (see
[§5.5](#run)). Semantics — precedence, file-path scoping, JSON parsing, env
bridging through `RD_INPUT_*`, dynamic built-ins, and reserved names — are
defined by
[docs/reference/runtime.md §Variable Resolution](runtime.md#template-variables)
and apply unchanged when variables are supplied through MCP.

`RD_INPUT_*` environment variables present in the MCP server's process
environment MUST also flow to the CLI unchanged through normal environment
inheritance.

<a id="security-and-state"></a>

## 8. Security and Runtime Inheritance

The MCP server MUST NOT define independent policy, sandbox, authority, or state
semantics.

| Concern                                                     | Source of truth                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Command, file, and environment policy                       | [docs/reference/security.md](security.md).                                                                             |
| Sandbox enforcement                                         | [docs/reference/security.md §Filesystem Sandbox](security.md#sandbox-usage).                                           |
| Policy modes (`prompted`, `execute`, `deny`) and CLI grants | [docs/reference/security.md](security.md).                                                                             |
| Run ownership and the Owner Token                           | [docs/reference/cli.md §Run Ownership](cli.md#run-ownership).                                                          |
| Persisted run state                                         | [docs/reference/runtime.md §State Persistence](runtime.md#state-persistence).                                          |
| Invalid persisted state and no-migration rule               | [docs/reference/runtime.md §Invalid Persisted State / No Migration](runtime.md#invalid-persisted-state--no-migration). |
| Variable resolution                                         | [docs/reference/runtime.md §Variable Resolution](runtime.md#template-variables).                                       |

When the CLI fails closed on stale or incompatible persisted state, the MCP
server MUST surface the CLI's error verbatim through the response envelope. The
MCP server MUST NOT shim, retry, migrate, rewrite, or otherwise mask such
errors.

## 9. Conformance

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
9. On non-zero CLI exit, select the payload using the
   stdout-then-stderr-then-raw provenance order defined in
   [§6.4](#response-format).
10. When CLI stdout contains multiple JSON values, return the last `command`- or
    `action`-keyed object, or all parsed objects as an array if none is present.
11. Refuse to expose unsupported CLI capabilities listed in
    [§5.11](#unsupported-cli-operations).
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

Mark the current step passed, using the `owner_token` from `runbook_started`:

```json
{
  "tool": "pass",
  "arguments": {
    "token": "rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "step": "2"
  }
}
```

Jump to a substep:

```json
{
  "tool": "goto",
  "arguments": {
    "token": "rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "step": "2.1"
  }
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
      "text": "{\n  \"kind\": \"error\",\n  \"error\": \"...\",\n  \"code\": \"UNKNOWN_TOKEN\"\n}"
    }
  ]
}
```

<a id="troubleshooting"></a>

## Troubleshooting (non-normative)

| Symptom                      | Likely cause                                                                           | Resolution                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command not found: rundown` | CLI not installed or not on `PATH`.                                                    | `npm install -g @rundown-org/cli`.                                                                                                                                            |
| `token: …` schema error      | A mutating tool was called without `token`.                                            | Pass `token`, the `owner_token` from the `runbook_started` event of the run.                                                                                                  |
| `UNKNOWN_TOKEN`              | The token names no run (mistyped, or its run was pruned).                              | Use the `owner_token` of the run you mean to drive. A lost token cannot be recovered; start a new run with the `run` tool.                                                    |
| `INVALID_STEP`               | `pass` / `fail` `step` or `index` does not match the run's current position.           | Read the current position with `status` and pass it as `step` (and `index` inside a FOR iteration).                                                                           |
| Timeout after 30 seconds     | CLI invocation hung (interactive prompt, blocked policy decision, missing dependency). | Run the equivalent CLI command directly. Confirm `--non-interactive` semantics in the host environment.                                                                       |
| Empty response               | CLI produced no stdout.                                                                | Check stderr in MCP host logs and run the CLI directly.                                                                                                                       |
| Invalid-state error surfaced | CLI refused to resume an incompatible persisted run.                                   | Finish or close the run, or prune the affected state and restart. See [runtime.md §Invalid Persisted State / No Migration](runtime.md#invalid-persisted-state--no-migration). |

To debug further:

1. Inspect MCP host logs for stderr from `rundown-mcp`.
2. Run the corresponding CLI command directly with `--text` for human-readable
   output.
3. Confirm `.rundown/rundown.db` exists and is readable.
4. Confirm `npx` can resolve `rundown` from the MCP server's working directory.
