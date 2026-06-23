---
'@rundown-org/parser': major
'@rundown-org/core': major
'@rundown-org/cli': major
'@rundown-org/mcp': major
'@rundown-org/claude-code-plugin': major
---

BREAKING: Raise minimum Node.js version to >=24.0.0. This enables use of
`Error.isError()` (TC39) and other Node 24 features across the codebase.
