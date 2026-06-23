# Testing Guide for @rundown-org/claude-code-plugin

How to run and write tests for the `claude-code-plugin` package. For the
architecture under test (the fixed hook dispatcher, the two delegation gates,
and the session state model), see
[`docs/plugin-overview.md`](docs/plugin-overview.md).

The plugin's only runtime surface is **native hook dispatch over stdin** (plus
the `rdpath`/`rdx` sibling bins). There is no repository gate config, no gate
engine, and no `session`/`log-dir`/`log-path` CLI subcommands — tests target the
current surface only.

## Test Architecture

### Layout

```text
__tests__/
├── helpers/                         # Shared test utilities
│   ├── test-utils.ts                # createMockHookInput, runCli, temp dirs, timing
│   ├── execfile-mock.ts             # execFileSync injection for rundown() calls
│   └── session-mock.ts              # Session doubles
├── gates/                           # The two fixed gates
│   ├── on-delegation-dispatch.test.ts
│   └── on-subagent-stop.test.ts
├── workflow/hooks/                  # Gate handler logic
│   ├── delegation-dispatch.test.ts
│   ├── delegation-detector.test.ts
│   ├── subagent-stop.test.ts
│   └── rundown.test.ts
├── runbooks/                        # Bundled-runbook runtime + validation
├── skills/                          # Skill content checks
├── security/
│   └── path-traversal.test.ts
├── shared/
│   └── logger.test.ts
├── *.contract.test.ts               # CLI entrypoint + minimal-dispatch contracts
├── *-fail-closed.regression.test.ts # Enforcement-gate fail-closed guards
├── untrusted-repo*.regression.test.ts
├── *.properties.test.ts             # fast-check property tests
├── hook-output.test.ts, schemas.test.ts, session.test.ts, types.test.ts, errors.test.ts
└── plan-schema*.test.ts, review-schema.test.ts, rdx*.test.ts, plan-validators.test.ts
```

### Categories

1. **Unit** — individual functions in isolation (gates, handlers, schemas,
   session).
2. **Contract** — `cli-entrypoint.contract.test.ts`,
   `minimal-dispatch.contract.test.ts` pin the stdin → dispatch → stdout
   behaviour and the route → gate mapping.
3. **Regression** — fail-closed enforcement (`*-fail-closed.regression.test.ts`)
   and untrusted-repo safety (project config can never enable/disable gates).
4. **Integration** — `*.integration.test.ts`, bundled-runbook runtime under
   `runbooks/`.
5. **Property** — `*.properties.test.ts` (fast-check).
6. **Security** — `security/path-traversal.test.ts`.

## Running Tests

```bash
pnpm test                 # all tests (jest)
pnpm run test:unit        # unit only (excludes integration/property/perf)
pnpm run test:integration # integration only
pnpm run test:property    # property tests
pnpm run test:coverage    # with coverage
pnpm run test:smoke       # scripts/smoke-test.sh
pnpm run test:mutate      # Stryker mutation testing
```

From the repo root, scoped runs:

```bash
pnpm --filter @rundown-org/claude-code-plugin test
pnpm --filter @rundown-org/claude-code-plugin test -- session.test.ts
pnpm run test:mutate:plugin
```

### Pre-PR plugin coverage

Root `pnpm run verify` runs build, lint, type checks, generated-doc checks, and
unit tests. It does not run plugin integration, property, coverage, smoke, or
mutation suites. For plugin behavior changes, run the smallest targeted Jest
command first, then run the relevant broader suite:

```bash
pnpm --filter @rundown-org/claude-code-plugin test:unit
pnpm --filter @rundown-org/claude-code-plugin test:integration
pnpm --filter @rundown-org/claude-code-plugin test:property
pnpm --filter @rundown-org/claude-code-plugin test:coverage
```

Use `pnpm run test:mutate:plugin` for mutation-sensitive changes after the
targeted tests are green. Do not lower Stryker thresholds to make a PR pass;
capture the current mutation baseline first and tighten it in a separate
tooling change when the baseline is stable.

### Coverage Thresholds (`jest.config.js`)

- **Global**: 75% branches, 90% functions, 85% lines, 85% statements.
- **`src/dispatcher.ts`**: 80% branches, 90% functions, 85% lines.

### Known LCOV gap: `src/rdpath.ts` and `src/rdx.ts`

The `rdpath`/`rdx` entrypoint shells do **not** appear in `coverage/lcov.info`,
even though `collectCoverageFrom` is `src/**/*.ts`. This is expected, not a hole
in the suite:

- Both files are CLI entrypoints that call `program.parse()` at module top level.
  They are only exercised by spawning the built `dist/{rdpath,rdx}.js` as a child
  `node` process (`rdpath-find-integration.test.ts`, ~30 cases;
  `rdx.integration.test.ts`, ~20 cases). Jest/istanbul instruments the in-process
  module graph only, so coverage of a spawned subprocess is never collected.
- They cannot be imported in-process to gain instrumentation without running the
  CLI as a side effect of the import (no `main`-module guard). Adding such a guard
  purely to satisfy coverage would change entrypoint behavior, which is out of
  scope for coverage hardening.
- Their actual logic lives in modules that **are** covered in-process:
  `src/rdx-core.ts` + `src/rdx-validate.ts` for `rdx`, and `assembleRdPath` /
  `findRdPathFiles` / `readActiveRunScope` from `@rundown-org/core` for `rdpath`.

The behavioral contract of both entrypoints is pinned by the spawn-based
integration tests above; the LCOV omission reflects the instrumentation boundary,
not untested code.

## Manual Hook Verification

Pipe a hook payload to the built CLI (`pnpm build` first). The plugin only acts
on `PreToolUse(Agent|Task)` and `SubagentStop`; any other event is a no-op (`{}`
/ empty stdout).

```bash
# SubagentStop with no active delegation — fast no-op
echo '{"hook_event_name":"SubagentStop","cwd":"'$(pwd)'","agent_id":"a1"}' | node dist/cli.js

# PreToolUse(Task) carrying a delegation token — records hash + injects claim context
echo '{"hook_event_name":"PreToolUse","cwd":"'$(pwd)'","tool_name":"Task","agent_id":"a1","tool_input":{"prompt":"... RD_CLAIM_TOKEN=rdtk_..."}}' | node dist/cli.js
```

## Test Utilities

`__tests__/helpers/test-utils.ts` exports: `createMockHookInput`,
`createMockSessionState`, `createTempTestDir`, `getCliPath`, `runCli`,
`measureExecutionTime`, `measureExecutionTimeSync`, `createMockExecSync`,
`createMockExecSyncError`, `sleep`, `assertDefined`.

```typescript
import { createMockHookInput, createTempTestDir } from '../helpers/test-utils.js';

const input = createMockHookInput('PreToolUse', {
  tool_name: 'Task',
  tool_input: { prompt: 'work … RD_CLAIM_TOKEN=rdtk_…' },
});

const testDir = await createTempTestDir();
try {
  // ... run dispatch against testDir.path
} finally {
  await testDir.cleanup();
}
```

`rundown()` shells out to the `rd` CLI via `execFileSync`; inject a fake with
`setExecSync` (see `__tests__/helpers/execfile-mock.ts`) rather than spawning a
real process. When mocking `@rundown-org/core` outside `packages/core`, pass
object-shaped service doubles (see the root `CLAUDE.md` testing conventions).

### Security testing

```typescript
const MALICIOUS_PATHS = ['../../../etc/passwd', 'valid/../../../escape'];
for (const p of MALICIOUS_PATHS) {
  expect(() => /* path resolver under test */).toThrow();
}
```

## Debugging

Plugin logging is **on by default** and written to a per-day file under the
system temp dir.

```bash
RUNDOWN_PLUGIN_LOG=0 pnpm test                 # disable logging
RUNDOWN_PLUGIN_LOG_LEVEL=debug pnpm test       # debug|info|warn|error (default: info)
```

## Adding Tests

1. Place the file in the matching `__tests__/` subdirectory (gate → `gates/`,
   handler → `workflow/hooks/`, etc.).
2. Use `test-utils.ts` helpers; clean up temp dirs in `afterEach`.
3. For enforcement gates, add a **fail-closed** assertion: an internal error
   must surface as a `block`, never as a silent pass.
4. Keep coverage above the thresholds above; prefer killing mutation survivors
   (`pnpm run test:mutate:plugin`) over loosening assertions.
