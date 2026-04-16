# Rundown MCP Server

This document provides a reference for the Rundown MCP (Model Context Protocol) server, which enables AI agents to execute runbooks via MCP tools.

**For CLI usage, see:**
- [RUNDOWN.md](./RUNDOWN.md) - CLI guide and reference
- [SPEC.md](./SPEC.md) - Rundown specification

---

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Claude Desktop Configuration](#claude-desktop-configuration)
- [Architecture](#architecture)
- [MCP Tools Reference](#mcp-tools-reference)
  - [validate](#validate)
  - [list](#list)
  - [status](#status)
  - [run](#run)
  - [pass](#pass)
  - [fail](#fail)
  - [goto](#goto)
  - [complete](#complete)
  - [stop](#stop)
- [Response Format](#response-format)
- [Delegation](#delegation)
- [Troubleshooting](#troubleshooting)

---

## Overview

The Rundown MCP server (`@rundown-org/mcp`) provides MCP integration for runbook execution. It exposes the Rundown CLI commands as MCP tools, allowing AI agents to:

- Start and manage runbook execution
- Navigate through runbook steps
- Report step outcomes (pass/fail)
- Query runbook status

| Component | Description |
|-----------|-------------|
| **Package** | `@rundown-org/mcp` |
| **Binary** | `rundown-mcp` |
| **Transport** | stdio |
| **Timeout** | 30 seconds per command |

---

## Installation

```bash
npm install -g @rundown-org/mcp
```

**Requirements:**
- Node.js >= 24.0.0
- `@rundown-org/cli` installed (global or local)

Verify installation:
```bash
rundown-mcp --help
```

---

## Claude Desktop Configuration

Add the Rundown MCP server to your Claude Desktop settings:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

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

### Alternative: Global Installation

If installed globally:

```json
{
  "mcpServers": {
    "rundown": {
      "command": "rundown-mcp"
    }
  }
}
```

### Alternative: Local Project

For project-specific usage:

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

---

## Architecture

The MCP server acts as a bridge between MCP clients (like Claude Desktop) and the Rundown CLI:

```
[MCP Client] --> [MCP Server] --> [Rundown CLI] --> [State Files]
                     |                   |
                stdio transport     execFile
```

**Key characteristics:**

| Aspect | Implementation |
|--------|----------------|
| **Transport** | stdio (standard input/output) |
| **CLI Invocation** | `npx --no rundown <cmd>` |
| **Response Format** | JSON wrapped in MCP content blocks |
| **Timeout** | 30 seconds per command |
| **Error Handling** | Parses JSON errors from stdout/stderr |

The server delegates all operations to the CLI, then wraps the JSON response in MCP content format.

---

## MCP Tools Reference

### Tool Summary

| Tool | Description | Required | Optional |
|------|-------------|----------|----------|
| `validate` | Check runbook syntax | `file` | - |
| `list` | List runbooks | - | `all`, `tags` |
| `status` | Get runbook state | - | - |
| `run` | Start runbook | - | `file`, `prompted` |
| `pass` | Mark step passed | - | - |
| `fail` | Mark step failed | - | - |
| `goto` | Jump to step | `step` | - |
| `complete` | Force early completion | - | `message` |
| `stop` | Stop runbook | - | `message` |

> **Note:** The CLI `stash` and `pop` commands are not exposed via MCP. These commands manage local session state which is typically not needed in MCP agent workflows.

---

### validate

Check runbook syntax before execution.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file` | string | Yes | Path to runbook file |

**Example:**
```json
{
  "tool": "validate",
  "arguments": {
    "file": "deploy.runbook.md"
  }
}
```

**CLI Equivalent:** `rundown check <file>`

---

### list

List active or available runbooks.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `all` | boolean | No | List available runbook files (default: active only) |
| `tags` | string | No | Filter by tags (comma-separated, requires `all: true`) |

**Example - List active runbooks:**
```json
{
  "tool": "list",
  "arguments": {}
}
```

**Example - List all available runbooks:**
```json
{
  "tool": "list",
  "arguments": {
    "all": true
  }
}
```

**Example - Filter by tags:**
```json
{
  "tool": "list",
  "arguments": {
    "all": true,
    "tags": "deploy,production"
  }
}
```

**CLI Equivalent:** `rundown ls [--all] [--tags <tags>]`

---

### status

Get current runbook state.

**Parameters:** None.

**Example:**
```json
{
  "tool": "status",
  "arguments": {}
}
```

**CLI Equivalent:** `rundown status`

---

### run

Start a runbook.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file` | string | No | Runbook file to start |
| `prompted` | boolean | No | Disable automatic command execution |

**Example - Start runbook:**
```json
{
  "tool": "run",
  "arguments": {
    "file": "deploy.runbook.md"
  }
}
```

**Example - Start in prompted mode:**
```json
{
  "tool": "run",
  "arguments": {
    "file": "deploy.runbook.md",
    "prompted": true
  }
}
```

**CLI Equivalent:** `rundown run [<file>] [--prompted] [--var key=value]... [--var-file path]`

**Note:** The `--var` and `--var-file` options are CLI-only. The MCP `run` tool does not currently expose variable configuration parameters. Delegation to child runbooks uses the CLI `delegate`/`claim`/`abort` commands. See [SPEC.md §6 Templating](./SPEC.md#6-templating) for full variable configuration details.

---

### pass

Mark the current step as passed.

**Parameters:** None.

**Example:**
```json
{
  "tool": "pass",
  "arguments": {}
}
```

**CLI Equivalent:** `rundown pass`

---

### fail

Mark the current step as failed.

**Parameters:** None.

**Example:**
```json
{
  "tool": "fail",
  "arguments": {}
}
```

**CLI Equivalent:** `rundown fail`

---

### goto

Jump to a specific step.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `step` | string | Yes | Target step (e.g., "3" or "2.1") |

**Example - Jump to step:**
```json
{
  "tool": "goto",
  "arguments": {
    "step": "3"
  }
}
```

**Example - Jump to substep:**
```json
{
  "tool": "goto",
  "arguments": {
    "step": "2.1"
  }
}
```

**CLI Equivalent:** `rundown goto <step>`

---

### complete

Force early completion of a runbook (runbooks auto-complete on final step).

**Note:** Runbooks auto-complete when the final step's PASS transition executes. This tool is for forcing early completion from any step, bypassing remaining steps.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `message` | string | No | Completion message |

**Example:**
```json
{
  "tool": "complete",
  "arguments": {}
}
```

**Example - With message:**
```json
{
  "tool": "complete",
  "arguments": {
    "message": "All deployment steps verified"
  }
}
```

**CLI Equivalent:** `rundown complete [<message>]`

---

### stop

Stop the runbook (abort execution).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `message` | string | No | Stop reason message |

**Example:**
```json
{
  "tool": "stop",
  "arguments": {}
}
```

**Example - With reason:**
```json
{
  "tool": "stop",
  "arguments": {
    "message": "Deployment blocked by failing tests"
  }
}
```

**CLI Equivalent:** `rundown stop [<message>]`

---

## Response Format

All tools return responses wrapped in MCP content blocks:

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

The `text` field contains pretty-printed JSON from the CLI output.

### Success Response

The nested JSON structure varies by command. See [CLI-OUTPUT-SPEC.md](./CLI-OUTPUT-SPEC.md) for detailed schemas.

### Error Response

Errors are returned in the same format:

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

---

## Delegation

MCP tools operate on the active runbook context. Multi-agent delegation (dispatching substeps to child runbooks) is managed via the CLI `delegate`/`claim`/`abort` commands, not through MCP tools.

### Delegation Workflow (CLI)

```bash
# 1. Main agent delegates substep to child runbook
rd delegate task.runbook.md --step 2.1

# 2. Subagent claims the delegation token
rd claim <token>

# 3. Subagent works through child runbook and reports result
rd pass    # or: rd fail
```

See [RUNDOWN.md](./RUNDOWN.md#delegation-commands) for full delegation command reference.

---

## Troubleshooting

### Common Issues

| Issue | Cause | Resolution |
|-------|-------|------------|
| "command not found: rundown" | CLI not installed | `npm install -g @rundown-org/cli` |
| "No active runbook" | No runbook running | Use `run` tool to start a runbook |
| Timeout after 30s | Command hanging | Check CLI directly, verify state files |
| Empty response | CLI returned no output | Check stderr in server logs |

### Debugging

1. **Check MCP server logs** - Look for errors in Claude Desktop console
2. **Test CLI directly** - Run `rundown status --text` in terminal
3. **Verify state files** - Check `.rundown/` directory
4. **Check permissions** - Ensure npx can find rundown

### Server Startup Message

When running correctly, the server outputs to stderr:
```
Rundown MCP Server running
```

---

## Quick Reference

| Operation | Tool | Required Parameters |
|-----------|------|---------------------|
| Check syntax | `validate` | `file` |
| List runbooks | `list` | - |
| Get status | `status` | - |
| Start runbook | `run` | - |
| Step passed | `pass` | - |
| Step failed | `fail` | - |
| Jump to step | `goto` | `step` |
| Mark complete | `complete` | - |
| Abort | `stop` | - |
