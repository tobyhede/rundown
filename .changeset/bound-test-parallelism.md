---
'@rundown-org/claude-code-plugin': patch
'@rundown-org/parser': patch
'@rundown-org/core': patch
'@rundown-org/cli': patch
'@rundown-org/mcp': patch
---

Bound local test parallelism so a full check cannot saturate the machine.

Two amplifiers stacked. Every package's `test:*` script already passed
`--maxWorkers=2`, which is conservative on its own, but the root `test:unit`,
`test:integration`, `test:coverage`, `check:types` and `check:complexity`
scripts are `run-p` — they launch every package at once. One `pnpm run verify`
was therefore ~15 Jest processes plus six `tsc` plus an ESLint permitted 8 GB,
and nothing capped how many of those could run concurrently.

`run-p` now takes `--max-parallel 2` in those five scripts, so the per-package
fan-out is capped at source.

Jest's worker count moves from a CLI flag to config:
`maxWorkers: Math.max(1, Number(process.env.JEST_MAX_WORKERS) || 2)` in
`jest.config.base.js` and in each package's `jest.config.shared.js`. The default
is unchanged at 2. The eleven `--maxWorkers=2` flags are removed from the
package scripts, because a CLI flag beats config and leaving them would make the
environment variable inert — the change would look applied and do nothing.

`JEST_MAX_WORKERS=1` now bounds every Jest run in the tree, including one an
agent or script invokes directly. The value is restated in each
`jest.config.shared.js` rather than imported from the root: those files are
deliberately self-contained so they resolve inside Stryker's sandbox copy of the
package directory.
