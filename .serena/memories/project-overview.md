# Rundown Project Overview

## Purpose
Rundown is a format for defining executable runbooks using Markdown. It includes a parser, core state management, CLI, MCP server, and Claude Code plugin.

## Tech Stack
- TypeScript monorepo (npm workspaces)
- Jest for testing
- ESLint + Biome for linting/formatting
- Node.js runtime

## Package Structure
- `packages/parser` - Markdown runbook parser (`@rundown-org/parser`)
- `packages/core` - Runbook state management and XState compilation (`@rundown-org/core`)
- `packages/cli` - Command-line interface (`@rundown-org/cli`)
- `packages/mcp` - MCP server for AI agent integration
- `packages/claude-code-plugin` - Claude Code plugin

## Key Commands
- `npm run build` - Build all packages
- `npm run test` - Run all tests (Jest)
- `npm run lint` - Lint all packages
- `npm run lint:fix` - Auto-fix lint issues

## Testing Patterns
- Jest with `@jest/globals` imports (`describe`, `it`, `expect`)
- Test files use `.test.ts` extension
- Tests are in `__tests__` directories mirroring `src` structure
- Imports use `.js` extensions (ESM compat)
- Follow arrange-act-assert pattern

## Code Style
- TSDoc on all exported symbols
- ESM with `.js` import extensions
- Readonly types for immutability
- PascalCase for types/interfaces, camelCase for functions/variables
