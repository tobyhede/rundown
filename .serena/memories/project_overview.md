# Rundown Project Overview

## Purpose
Rundown is a format for defining executable runbooks using Markdown. It provides a CLI, parser, core state management, MCP server, and Claude Code plugin.

## Tech Stack
- TypeScript (ESM modules)
- Node.js
- Monorepo with npm workspaces
- Jest for testing
- ESLint + Biome for linting/formatting
- XState for state machines (core package)
- Zod for schema validation

## Packages
- `packages/parser` - Markdown runbook parser
- `packages/core` - Runbook state management and XState compilation
- `packages/cli` - Command-line interface
- `packages/mcp` - MCP server for AI agent integration
- `packages/claude-code-plugin` - Claude Code plugin

## Code Style
- ESM modules (type: "module")
- TSDoc documentation on all exports
- PascalCase for types/interfaces, camelCase for functions/variables
- Zod schemas for validation
- OutputEmitter for CLI output
