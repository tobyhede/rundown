# Rundown-aware Codex fallback notes

The Stage 1 Codex integration is the Rundown Codex plugin, installed by the E2E
entrypoint from the local `rundown-local` Codex marketplace. The plugin provides
bundled skills and an MCP server config for `rundown-mcp`.

If plugin loading is unavailable while debugging, use the `rundown` CLI
directly:

1. Discover runbooks: `rundown ls --all`
2. Start a runbook: `rundown run rundown:write-plan`
3. Inspect current state: `rundown status`
4. Report outcomes with `rundown pass` or `rundown fail`

JSON is the default agent-facing output. Do not add `--text` unless a human is
debugging output formatting.
