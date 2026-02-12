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
- [Multi-Agent Support](#multi-agent-support)
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
- Node.js >= 20.12.0
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
                stdio transport     execFile + --json
```

**Key characteristics:**

| Aspect | Implementation |
|--------|----------------|
| **Transport** | stdio (standard input/output) |
| **CLI Invocation** | `npx --no rundown <cmd> --json` |
| **Response Format** | JSON wrapped in MCP content blocks |
| **Timeout** | 30 seconds per command |
| **Error Handling** | Parses JSON errors from stdout/stderr |

The server delegates all operations to the CLI with `--json` flag for machine-readable output, then wraps the response in MCP content format.

---

## MCP Tools Reference

### Tool Summary

| Tool | Description | Required | Optional |
|------|-------------|----------|----------|
| `validate` | Check runbook syntax | `file` | - |
| `list` | List runbooks | - | `all`, `tags` |
| `status` | Get runbook state | - | `agent` |
| `run` | Start runbook | - | `file`, `step`, `agent`, `prompted` |
| `pass` | Mark step passed | - | `agent` |
| `fail` | Mark step failed | - | `agent` |
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

**CLI Equivalent:** `rundown check <file> --json`

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

**CLI Equivalent:** `rundown ls [--all] [--tags <tags>] --json`

---

### status

Get current runbook state.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent` | string | No | Agent ID for multi-agent coordination |

**Example:**
```json
{
  "tool": "status",
  "arguments": {}
}
```

**Example - Agent-specific status:**
```json
{
  "tool": "status",
  "arguments": {
    "agent": "subagent-1"
  }
}
```

**CLI Equivalent:** `rundown status [--agent <id>] --json`

---

### run

Start a runbook or bind an agent to a pending step.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file` | string | No | Runbook file to start |
| `step` | string | No | Step ID to queue for agent binding |
| `agent` | string | No | Agent ID binding to queued step |
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

**Example - Queue step for agent:**
```json
{
  "tool": "run",
  "arguments": {
    "step": "2.1",
    "file": "task.runbook.md"
  }
}
```

**Example - Agent binds to queued step:**
```json
{
  "tool": "run",
  "arguments": {
    "agent": "subagent-1"
  }
}
```

**CLI Equivalent:** `rundown run [<file>] [--step <id>] [--agent <id>] [--prompted] --json`

---

### pass

Mark the current step as passed.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent` | string | No | Agent ID for multi-agent coordination |

**Example:**
```json
{
  "tool": "pass",
  "arguments": {}
}
```

**Example - Agent reports pass:**
```json
{
  "tool": "pass",
  "arguments": {
    "agent": "subagent-1"
  }
}
```

**CLI Equivalent:** `rundown pass [--agent <id>] --json`

---

### fail

Mark the current step as failed.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent` | string | No | Agent ID for multi-agent coordination |

**Example:**
```json
{
  "tool": "fail",
  "arguments": {}
}
```

**Example - Agent reports failure:**
```json
{
  "tool": "fail",
  "arguments": {
    "agent": "subagent-1"
  }
}
```

**CLI Equivalent:** `rundown fail [--agent <id>] --json`

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

**CLI Equivalent:** `rundown goto <step> --json`

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

**CLI Equivalent:** `rundown complete [<message>] --json`

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

**CLI Equivalent:** `rundown stop [<message>] --json`

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

## Multi-Agent Support

Tools with an `agent` parameter support multi-agent coordination:

| Tool | Agent Support |
|------|---------------|
| `status` | Query agent-specific runbook stack |
| `run` | Bind agent to pending step |
| `pass` | Report pass for agent's step |
| `fail` | Report fail for agent's step |

### Multi-Agent Workflow

1. **Main agent** starts parent runbook and queues substeps
2. **Subagent** binds to queued step via `run` with `agent` parameter
3. **Subagent** executes assigned work
4. **Subagent** reports outcome via `pass` or `fail` with `agent` parameter

```json
// Main agent queues step with child runbook
{ "tool": "run", "arguments": { "step": "2.1", "file": "task.runbook.md" } }

// Subagent binds to queued step
{ "tool": "run", "arguments": { "agent": "worker-1" } }

// Subagent completes work
{ "tool": "pass", "arguments": { "agent": "worker-1" } }
```

See [RUNDOWN.md](./RUNDOWN.md#subagent-dispatch-patterns) for detailed multi-agent patterns.

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
2. **Test CLI directly** - Run `rundown status --json` in terminal
3. **Verify state files** - Check `.claude/rundown/` directory
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
| Start runbook | `run` | `file` |
| Step passed | `pass` | - |
| Step failed | `fail` | - |
| Jump to step | `goto` | `step` |
| Mark complete | `complete` | - |
| Abort | `stop` | - |
