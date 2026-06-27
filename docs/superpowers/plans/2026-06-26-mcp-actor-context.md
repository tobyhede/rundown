# MCP Actor Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Rundown MCP server tag every CLI invocation it spawns with provenance `source=mcp` and thread existing claim metadata only for tools that support `--claim-id`, so core resolves the correct `ActorContext` for actor-context-consuming CLI commands without any policy logic living in the MCP layer.

**Architecture:** MCP stays a thin facade over `npx --no rundown`. It prepends the provenance tag `mcp` (via the program-level `--actor-source mcp` argv flag) to every CLI command and preserves the already-supported `--claim-id` only on tools that expose that option (`status`, `pass`, `fail`, `goto`, `complete`, `stop`, `collect`; not `delegate` or `claim`). Construction and derivation of `ActorContext` stay entirely in CLI/core where the command consumes actor context; non-consuming commands merely tolerate the program-level flag. MCP adds no branch, no role decision, no inspect-vs-mutate gate, no policy, and no environment mutation of its own.

**Tech Stack:** TypeScript (Node 24), `@modelcontextprotocol/sdk`, Zod, Jest (`@jest/globals`, `jest.fn`), `@rundown-org/core` for `getErrorMessage`. Package under test: `@rundown-org/mcp` (`packages/mcp`).

## Prerequisite (must land first)

This plan **CONSUMES** the precursor plan
`docs/superpowers/plans/2026-06-26-cli-actor-context-ingress.md`. That plan
**PRODUCES** the exact interfaces this plan depends on. **Do not start this plan
until the precursor has landed.** Current verification found this MCP plan is
valid with the amendments in this document, not obsolete, but it remains blocked
on the CLI actor-source precursor. The consumed surface is:

- A program-level CLI option `--actor-source <direct-cli|plugin|mcp>` registered
  on the root `rundown`/`rd` program (usable with any subcommand), plus its env
  bridge `RD_ACTOR_SOURCE`. Flag takes precedence over env. An unknown/invalid
  value is a **hard error**, not a silent default.
- `resolveActorContext(ingress, state)` in
  `packages/cli/src/helpers/resolve-actor-context.ts`, plus the CLI-side
  plumbing that consumes actor context only where the precursor plan defines it.
  MCP never imports this — it only forwards provenance for all CLI calls. The
  actor-context-consuming CLI commands use that provenance; commands that do not
  consume actor context merely tolerate the program-level flag.
- The trust mapping (frozen): `source=mcp` + no claim →
  `trusted_run_controller(state.id, 'mcp')` (orchestrator of the active run);
  any source + valid claim evidence on an actor-context-consuming command →
  `claim_controller(...)`. The collection-pending guard still refuses bare
  `pass`/`fail`/`delegate` for **every** source; the CLI precursor tests proving
  this invariant are part of final acceptance for this plan.

**Verify the precursor has landed before Task 1:** run
`rundown run --help` (or `rd --help`) from the active repo root (`$PWD`) and confirm
`--actor-source` appears in the program-level options. If it does not, stop and
land the precursor first.

## Threat model note (forward-looking, do NOT build)

The trusted-controller mapping for `source=mcp` assumes the **stdio-local**
transport that is wired today (`packages/mcp/src/index.ts` connects only a
`StdioServerTransport`; `docs/reference/mcp.md §3` requires stdio). A local
stdio MCP server spawns the local CLI in the same workspace and is
trust-equivalent to the bare CLI under Rundown's accident-isolation threat
model, so tagging it as a trusted run-controller adds no privilege. **If a
remote (HTTP/SSE) transport is ever wired, the trust mapping for `source=mcp`
must be revisited** (the caller would no longer be a local workspace process).
This plan does not build remote transport support.

## Global Constraints

Every task's requirements implicitly include this section. Values copied
verbatim from the frozen framing brief, `docs/reference/mcp.md`, and
`CLAUDE.md`.

- **Thin facade, no shadow policy.** MCP MUST NOT define independent policy,
  derive roles, or gate inspect-vs-mutate. It sets ingress inputs only;
  construction/derivation stay in CLI/core (`CLAUDE.md` Architectural
  Principles; `mcp.md §9`).
- **Env inheritance is a MUST.** `mcp.md §4`: "The CLI MUST inherit the server
  process environment **without modification by the MCP layer**." Therefore the
  provenance tag is injected via **argv** (`--actor-source mcp`), never by
  mutating `process.env` or the `execFile` `env` option. This keeps the §4
  environment-inheritance MUST intact.
- **JSON envelope/error semantics MUST NOT regress.** `mcp.md §6`: exactly one
  text content block per call; success payload is parsed CLI stdout (no `error`
  field on empty success); error provenance order
  stdout→stderr→raw→transport. The `RunCli`/`createMcpTextResponse` behaviour is
  untouched by this plan.
- **Invocation contract unchanged.** `mcp.md §4` / `§10.5`: CLI is invoked as
  `npx --no rundown <args>` with a 30s per-call timeout. We prepend
  `--actor-source mcp` to `<args>`; the `npx --no rundown` prefix and timeout
  are unchanged.
- **No MCP policy or environment mutation.** MCP prepends argv only. It MUST NOT
  add policy decisions, role derivation, inspect-vs-mutate branching,
  `process.env` writes, or `execFile` `env` overrides.
- **Preserve the `RunCli` DI seam.** Tests inject a fake `RunCli` /
  `ExecFileAsync` (`createRunCli`, `createServer(runCliFn)`). Do not remove or
  rename these seams.
- **No persisted-state migration.** Actor context is runtime-only and never
  serialised into snapshots. This plan changes no persisted schema.
- **Type-driven dispatch, no silent mapping.** The provenance value is the
  literal `'mcp'`; do not invent synthetic IDs or remap it.
- **TSDoc on all new/changed exported symbols** (`CLAUDE.md` TSDoc Standards):
  description, `@param`, `@returns`, `@throws` where applicable.
- **Use `getErrorMessage` from `@rundown-org/core`, never `Error.isError`
  directly** (`CLAUDE.md` Testing Conventions). This plan adds no new error
  handling, but any touched code keeps this rule.
- **Spelling/lint/format gate.** `pnpm run verify` must pass before the branch
  is pushed. New literals like `mcp` are already in the codebase vocabulary.

---

## File Structure

Decomposition decisions locked here. This is a small, surgical change confined
to `packages/mcp`.

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/mcp/src/tools.ts` | Builds CLI argv per tool (`buildRundownCommand`) and registers tool handlers. **The single seam where `--actor-source mcp` is prepended.** | Modify: add `ACTOR_SOURCE_MCP` constant + prepend in `buildRundownCommand`. |
| `packages/mcp/__tests__/tools.test.ts` | Unit tests for argv building and handler dispatch. | Modify: assert `--actor-source mcp` leads every command; assert claim threading still works alongside it for tools that support `--claim-id` (`status`, `pass`, `fail`, `goto`, `complete`, `stop`, `collect`). |
| `packages/mcp/__tests__/cli.test.ts` | Unit tests for `runCli` / `createRunCli`. | Modify (one assertion): the existing `execFileAsync` call-shape test now expects the leading `--actor-source mcp` only if the test drives a real built command — but `runCli` is argv-agnostic, so this file needs **no change**. (Documented in Task 3 to prevent accidental edits.) |
| `docs/reference/mcp.md` | Normative MCP spec. | Modify: document that the server forwards `--actor-source mcp` as provenance; record the forward-looking remote-transport caveat. |

**Why `tools.ts` / `buildRundownCommand` is the chosen seam (justification
required by the brief):**

- `cli.ts`'s `execFileAsync` adapter only accepts `{ timeout }`. Adding an `env`
  option there to carry `RD_ACTOR_SOURCE` would **violate `mcp.md §4`** ("CLI
  MUST inherit the server process environment without modification by the MCP
  layer") and would force a widening of the `ExecFileAsync` DI type that all
  tests depend on.
- `buildRundownCommand` is already the one place every tool's argv is
  assembled, and `--actor-source` is a **program-level** flag (precursor) valid
  before any subcommand. Prepending it once, centrally, tags every command with
  a single edit and keeps the change inside the existing argv contract. The
  `npx --no rundown` prefix in `cli.ts` is untouched; only the trailing
  `<args>` gains a leading `--actor-source mcp`.
- Claim metadata is **already** threaded by `buildRundownCommand` via
  `pushClaimId` (`--claim-id`) only for tools that support it: `status`,
  `pass`, `fail`, `goto`, `complete`, `stop`, and `collect`. `delegate` and
  `claim` do not receive `--claim-id`. No new claim plumbing is needed; we only
  pin the existing supported cases with tests that prove they coexist with the
  new provenance flag.

---

## Task 1: Prepend `--actor-source mcp` to every built CLI command

**Files:**
- Modify: `packages/mcp/src/tools.ts` (add `ACTOR_SOURCE_MCP`; prepend in `buildRundownCommand`, lines ~218-298)
- Test: `packages/mcp/__tests__/tools.test.ts` (the `buildRundownCommand` describe block, lines ~11-96)

**Interfaces:**
- Consumes (from precursor CLI plan, must be landed first): program-level
  `--actor-source <direct-cli|plugin|mcp>` flag accepted before any subcommand;
  invalid value is a hard CLI error.
- Consumes (existing, this package): `buildRundownCommand(tool, input): string[]`,
  `pushClaimId(cmd, input)`, `RundownToolName`.
- Produces (for later tasks and the registrar): `buildRundownCommand` now
  returns argv beginning with `['--actor-source', 'mcp', <subcommand>, ...]` for
  every tool. Exported constant `ACTOR_SOURCE_MCP = 'mcp'` (string literal) for
  reuse in tests and docs.

- [ ] **Step 1: Write the failing test**

Add these cases to `packages/mcp/__tests__/tools.test.ts`. Insert a new
`describe` block immediately after the existing `describe('buildRundownCommand', ...)`
block (after line 116, before `describe('inputSchema enforces index requires step', ...)`):

```typescript
describe('buildRundownCommand actor-source provenance', () => {
  it.each([
    ['validate', { file: 'workflow.md' }],
    ['list', { all: true }],
    ['status', {}],
    ['run', { file: 'workflow.md' }],
    ['pass', {}],
    ['fail', {}],
    ['goto', { step: '3' }],
    ['complete', {}],
    ['stop', {}],
    ['delegate', {}],
    ['claim', { token: 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' }],
    ['collect', {}],
  ] satisfies Array<[RundownToolName, Record<string, unknown>]>)(
    '%s leads with --actor-source mcp',
    (tool, input) => {
      expect(buildRundownCommand(tool, input).slice(0, 2)).toEqual([
        '--actor-source',
        'mcp',
      ]);
    },
  );

  it('places --actor-source mcp before the subcommand for status', () => {
    expect(buildRundownCommand('status', {})).toEqual(['--actor-source', 'mcp', 'status']);
  });

  it('keeps --claim-id after the subcommand alongside the provenance flag', () => {
    expect(buildRundownCommand('pass', { claimId: 'claim-1' })).toEqual([
      '--actor-source',
      'mcp',
      'pass',
      '--claim-id',
      'claim-1',
    ]);
  });

  it('exposes ACTOR_SOURCE_MCP as the literal mcp', () => {
    expect(ACTOR_SOURCE_MCP).toBe('mcp');
  });
});
```

Update the import at the top of the test file (lines 2-9) to add
`ACTOR_SOURCE_MCP`:

```typescript
import {
  ACTOR_SOURCE_MCP,
  buildRundownCommand,
  createMcpTextResponse,
  registerRundownTools,
  RUNDOWN_TOOL_DEFINITIONS,
  type RunCli,
  type RundownToolName,
} from '../src/tools.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run from the active repo root (`$PWD`): `pnpm --filter @rundown-org/mcp test -- tools.test.ts`
Expected: FAIL. The new cases fail because argv does not start with
`--actor-source mcp`, and the import of `ACTOR_SOURCE_MCP` is `undefined`
(TypeScript/runtime error: `ACTOR_SOURCE_MCP` is not exported).

- [ ] **Step 3: Write minimal implementation**

In `packages/mcp/src/tools.ts`, add the exported constant just below the
`RunCli` type / before the shape constants (after line 34, near the other
top-level declarations):

```typescript
/**
 * Provenance tag forwarded to the CLI as `--actor-source <value>` for every
 * command this MCP server spawns. Marks the caller as the local stdio MCP
 * front end so actor-context-consuming CLI commands can resolve a trusted
 * run-controller (or claim-controller when supported `--claim-id` evidence is
 * also present) actor context. The MCP layer sets only this ingress tag; it
 * derives no policy.
 *
 * @remarks Assumes the stdio-local transport. If a remote (HTTP/SSE) transport
 * is ever wired, the trust mapping for this source must be revisited.
 */
export const ACTOR_SOURCE_MCP = 'mcp';
```

Then change `buildRundownCommand` so every returned argv is prefixed with the
program-level provenance flag. Replace the function body's `switch` dispatch by
wrapping it: compute the subcommand argv, then prepend. The smallest correct
edit is to introduce a helper and return `withActorSource(...)` at the end.
Replace the existing `buildRundownCommand` (lines ~218-298) with:

```typescript
/**
 * Prefix a subcommand argv with the program-level `--actor-source mcp`
 * provenance flag. The flag is registered at the root program level (see the
 * CLI actor-context ingress plan) and so MUST precede the subcommand token.
 *
 * @param subcommandArgv - CLI argv beginning with the subcommand name.
 * @returns Argv beginning with `--actor-source mcp` followed by the subcommand argv.
 */
function withActorSource(subcommandArgv: string[]): string[] {
  return ['--actor-source', ACTOR_SOURCE_MCP, ...subcommandArgv];
}

/**
 * Build a Rundown CLI argv array for an MCP tool call.
 *
 * The returned argv always begins with the program-level `--actor-source mcp`
 * provenance flag so core can resolve the correct actor context. Claim scoping
 * is threaded via `--claim-id` (see {@link pushClaimId}) and coexists with the
 * provenance flag.
 *
 * @param tool - MCP tool name.
 * @param input - Tool input values.
 * @returns CLI argv array (leading with `--actor-source mcp`) to pass to `runCli`.
 * @throws {Error} If a required string input is missing or invalid.
 */
export function buildRundownCommand(
  tool: RundownToolName,
  input: Record<string, unknown>,
): string[] {
  switch (tool) {
    case 'validate':
      if (typeof input.file !== 'string') {
        throw new Error('validate.file must be a string');
      }
      return withActorSource(['check', input.file]);
    case 'list': {
      const cmd = ['ls'];
      if (input.all === true) cmd.push('--all');
      if (typeof input.tags === 'string') cmd.push('--tags', input.tags);
      return withActorSource(cmd);
    }
    case 'status': {
      const cmd = ['status'];
      pushClaimId(cmd, input);
      return withActorSource(cmd);
    }
    case 'run': {
      const cmd = ['run'];
      if (typeof input.file === 'string') cmd.push(input.file);
      if (input.prompted === true) cmd.push('--prompted');
      pushStepIndex(cmd, input);
      pushRepeatable(cmd, '--input', input.input);
      pushRepeatable(cmd, '--input-json', input.inputJson);
      pushRepeatable(cmd, '--input-file', input.inputFile);
      return withActorSource(cmd);
    }
    case 'pass':
    case 'fail': {
      const cmd = [tool];
      pushStepIndex(cmd, input);
      pushClaimId(cmd, input);
      return withActorSource(cmd);
    }
    case 'goto': {
      if (typeof input.step !== 'string') {
        throw new Error('goto.step must be a string');
      }
      const cmd = ['goto', input.step];
      if (typeof input.index === 'number') cmd.push('--index', String(input.index));
      pushClaimId(cmd, input);
      return withActorSource(cmd);
    }
    case 'complete':
    case 'stop': {
      const cmd = typeof input.message === 'string' ? [tool, input.message] : [tool];
      pushClaimId(cmd, input);
      return withActorSource(cmd);
    }
    case 'delegate': {
      const cmd = ['delegate'];
      if (input.retry === true) cmd.push('--retry');
      if (typeof input.runbook === 'string') cmd.push(input.runbook);
      pushStepIndex(cmd, input);
      pushRepeatable(cmd, '--input', input.input);
      pushRepeatable(cmd, '--input-json', input.inputJson);
      pushRepeatable(cmd, '--input-file', input.inputFile);
      return withActorSource(cmd);
    }
    case 'claim': {
      if (typeof input.token !== 'string') {
        throw new Error('claim.token must be a string');
      }
      const cmd = ['claim', input.token];
      pushRepeatable(cmd, '--input', input.input);
      pushRepeatable(cmd, '--input-json', input.inputJson);
      pushRepeatable(cmd, '--input-file', input.inputFile);
      return withActorSource(cmd);
    }
    case 'collect': {
      const cmd = ['collect'];
      pushStepIndex(cmd, input);
      pushClaimId(cmd, input);
      return withActorSource(cmd);
    }
  }
}
```

Note: the `throw new Error(...)` validation paths fire **before**
`withActorSource` is reached, so a malformed input still throws exactly as
before (pinned by the existing "rejects missing required string inputs" test in
Task 2's regression check).

- [ ] **Step 4: Run test to verify it passes**

Run from the active repo root (`$PWD`): `pnpm --filter @rundown-org/mcp test -- tools.test.ts`
Expected: The new `buildRundownCommand actor-source provenance` block PASSES.
The pre-existing `buildRundownCommand` block (lines 11-96) now FAILS because its
expected argv arrays no longer include the leading `--actor-source mcp`. That is
intended — Task 2 updates those expectations. Do not "fix" by reverting.

- [ ] **Step 5: Leave the partial red state uncommitted**

Do not commit yet. Task 2 updates the existing argv expectations and commits the
integrated passing slice.

---

## Task 2: Update existing argv expectations to include the provenance prefix

**Files:**
- Modify: `packages/mcp/__tests__/tools.test.ts` (the `it.each` table in `describe('buildRundownCommand', ...)`, lines ~12-96)

**Interfaces:**
- Consumes: `buildRundownCommand` now returns `['--actor-source', 'mcp', ...]`
  (Task 1).
- Produces: a green pre-existing regression suite that pins both the provenance
  prefix and the unchanged subcommand/claim/input argv for every tool.

- [ ] **Step 1: Update the now-red existing argv expectations**

Task 1 Step 4 intentionally left the pre-existing block red. Update every
expected argv in the `it.each` table (lines 12-76) and the two standalone argv
assertions (lines 93-96) to lead with `'--actor-source', 'mcp'`.
Replace the `it.each([...])` argument table for the
`'%s builds the matching CLI argv'` test with:

```typescript
  it.each([
    ['validate', { file: 'workflow.md' }, ['--actor-source', 'mcp', 'check', 'workflow.md']],
    [
      'list',
      { all: true, tags: 'release,prod' },
      ['--actor-source', 'mcp', 'ls', '--all', '--tags', 'release,prod'],
    ],
    [
      'status',
      { claimId: 'claim-1' },
      ['--actor-source', 'mcp', 'status', '--claim-id', 'claim-1'],
    ],
    [
      'run',
      { file: 'workflow.md', prompted: true },
      ['--actor-source', 'mcp', 'run', 'workflow.md', '--prompted'],
    ],
    [
      'pass',
      { step: '2.1', index: 3, claimId: 'claim-1' },
      ['--actor-source', 'mcp', 'pass', '--step', '2.1', '--index', '3', '--claim-id', 'claim-1'],
    ],
    [
      'fail',
      { step: '2.1', index: 3, claimId: 'claim-1' },
      ['--actor-source', 'mcp', 'fail', '--step', '2.1', '--index', '3', '--claim-id', 'claim-1'],
    ],
    [
      'goto',
      { step: '3.1', index: 2, claimId: 'claim-1' },
      ['--actor-source', 'mcp', 'goto', '3.1', '--index', '2', '--claim-id', 'claim-1'],
    ],
    [
      'complete',
      { message: 'done', claimId: 'claim-1' },
      ['--actor-source', 'mcp', 'complete', 'done', '--claim-id', 'claim-1'],
    ],
    [
      'stop',
      { message: 'blocked', claimId: 'claim-1' },
      ['--actor-source', 'mcp', 'stop', 'blocked', '--claim-id', 'claim-1'],
    ],
    [
      'delegate',
      { step: '4.1', index: 2 },
      ['--actor-source', 'mcp', 'delegate', '--step', '4.1', '--index', '2'],
    ],
    [
      'delegate',
      { runbook: 'child.md', step: '1', input: ['env=prod'] },
      ['--actor-source', 'mcp', 'delegate', 'child.md', '--step', '1', '--input', 'env=prod'],
    ],
    [
      'delegate',
      { retry: true, step: '4.1', input: ['mode=fast'] },
      ['--actor-source', 'mcp', 'delegate', '--retry', '--step', '4.1', '--input', 'mode=fast'],
    ],
    [
      'delegate',
      { retry: true, step: '4.1', inputJson: ['vars={"mode":"fast"}'], inputFile: ['vars.yaml'] },
      [
        '--actor-source',
        'mcp',
        'delegate',
        '--retry',
        '--step',
        '4.1',
        '--input-json',
        'vars={"mode":"fast"}',
        '--input-file',
        'vars.yaml',
      ],
    ],
    [
      'claim',
      { token: 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', inputJson: ['items=["a"]'] },
      [
        '--actor-source',
        'mcp',
        'claim',
        'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
        '--input-json',
        'items=["a"]',
      ],
    ],
    [
      'collect',
      { step: '5', index: 2, claimId: 'claim-1' },
      ['--actor-source', 'mcp', 'collect', '--step', '5', '--index', '2', '--claim-id', 'claim-1'],
    ],
  ] satisfies Array<
    [RundownToolName, Record<string, unknown>, string[]]
  >)('%s builds the matching CLI argv', (tool, input, expected) => {
    expect(buildRundownCommand(tool, input)).toEqual(expected);
  });
```

Replace the `maps bare pass/fail` test (lines 93-96) with:

```typescript
  it('maps bare pass/fail to CLI argv without a frontend-specific guard', () => {
    expect(buildRundownCommand('pass', {})).toEqual(['--actor-source', 'mcp', 'pass']);
    expect(buildRundownCommand('fail', {})).toEqual(['--actor-source', 'mcp', 'fail']);
  });
```

Leave the "rejects missing required string inputs" `it.each` (lines 83-91)
**unchanged** — those assert `toThrow`, and the throw still fires before the
provenance prefix is applied.

- [ ] **Step 2: Run test to verify it fails first, then passes**

Run from the active repo root (`$PWD`): `pnpm --filter @rundown-org/mcp test -- tools.test.ts`
Expected: PASS for the whole file. (If any case still shows the old expectation,
the diff was applied incompletely — fix the remaining row.)

- [ ] **Step 3: Verify the throw-path regression still holds**

Run from the active repo root (`$PWD`): `pnpm --filter @rundown-org/mcp test -- tools.test.ts -t "rejects missing required string inputs"`
Expected: PASS. Confirms malformed inputs throw before the provenance prefix is
added (the `--actor-source` change did not swallow the validation errors).

- [ ] **Step 4: Commit the integrated implementation + expectation slice**

```bash
git add packages/mcp/src/tools.ts packages/mcp/__tests__/tools.test.ts
git commit -m "feat(mcp): tag spawned CLI commands with --actor-source mcp"
```

---

## Task 3: Pin handler dispatch + envelope invariants with the provenance flag

**Files:**
- Modify: `packages/mcp/__tests__/tools.test.ts` (the `registerRundownTools` describe block, lines ~156-309)
- Read-only confirm: `packages/mcp/__tests__/cli.test.ts` (no change — documented below)

**Interfaces:**
- Consumes: `registerRundownTools(server, runCli)`, `createMcpTextResponse`,
  `buildRundownCommand` (now provenance-prefixed).
- Produces: a test proving a registered handler forwards the provenance-prefixed
  argv into `runCli`, and that the JSON envelope (success + error) is unchanged.

- [ ] **Step 1: Write the failing test**

Update the existing handler-dispatch test
(`'registered handlers invoke runCli with built argv and return CLI JSON'`,
lines 204-235). Replace the `expect(runCli).toHaveBeenCalledWith([...])`
assertion's array (lines 227-234) so it expects the provenance prefix:

```typescript
    expect(runCli).toHaveBeenCalledWith([
      '--actor-source',
      'mcp',
      'delegate',
      'child.md',
      '--step',
      '1.1',
      '--input',
      'env=prod',
    ]);
```

Then add a new test immediately after that one (after line 235) proving a
claim-scoped tool that supports `--claim-id` forwards both the provenance flag
and the claim id, and that the success envelope is a single text block (no
`error` field):

```typescript
  it('forwards provenance + claim id for a claim-scoped collect and keeps the envelope', async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      registerTool: jest.fn(
        (
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) => {
          handlers.set(name, handler);
        },
      ),
    };
    const runCli = jest
      .fn<RunCli>()
      .mockResolvedValue({ success: true, data: { collected: true } });
    registerRundownTools(fakeServer, runCli);

    await expect(handlers.get('collect')?.({ claimId: 'claim-1' })).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ collected: true }, null, 2) }],
    });
    expect(runCli).toHaveBeenCalledWith([
      '--actor-source',
      'mcp',
      'collect',
      '--claim-id',
      'claim-1',
    ]);
  });

  it('forwards provenance for an inspect-only status call with no claim', async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      registerTool: jest.fn(
        (
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) => {
          handlers.set(name, handler);
        },
      ),
    };
    const runCli = jest.fn<RunCli>().mockResolvedValue({ success: true, data: { active: false } });
    registerRundownTools(fakeServer, runCli);

    await handlers.get('status')?.({});

    // Inspect-only tools carry the provenance tag but NO claim. MCP adds no
    // inspect-vs-mutate gate of its own.
    expect(runCli).toHaveBeenCalledWith(['--actor-source', 'mcp', 'status']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run from the active repo root (`$PWD`): `pnpm --filter @rundown-org/mcp test -- tools.test.ts -t "registerRundownTools"`
Expected: The updated `toHaveBeenCalledWith` (delegate) and the two new tests
PASS once Task 1 is in place; if Task 1 is correctly applied they pass
immediately. To prove the assertions are load-bearing, temporarily confirm they
would fail without the prefix: they assert the exact array including
`--actor-source`, so a non-prefixed `buildRundownCommand` (the pre-Task-1 state)
fails. Since Task 1 is applied before this step, expect PASS here.

(If you are running tasks strictly TDD against a fresh Task-1-reverted tree,
these would FAIL with "expected `['--actor-source','mcp',...]` received
`['collect',...]`". With Task 1 applied they PASS.)

- [ ] **Step 3: Confirm `cli.test.ts` needs no change**

`runCli` / `createRunCli` are argv-agnostic — they prepend `npx --no rundown` to
whatever array they are given and never inspect tool semantics. The existing
`cli.test.ts` assertion
`expect(execFileAsync).toHaveBeenCalledWith('npx', ['--no', 'rundown', 'status'], { timeout: 30000 })`
drives `runCli(['status'])` **directly** with a hand-written argv, not via
`buildRundownCommand`, so it stays valid and MUST NOT be edited.

Run from the active repo root (`$PWD`): `pnpm --filter @rundown-org/mcp test -- cli.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 4: Run the full MCP package suite**

Run from the active repo root (`$PWD`): `pnpm --filter @rundown-org/mcp test`
Expected: PASS across `cli.test.ts`, `tools.test.ts`, `index.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/__tests__/tools.test.ts
git commit -m "test(mcp): pin provenance + claim threading through tool handlers"
```

---

## Task 4: Document the provenance flag in the MCP spec

**Files:**
- Modify: `docs/reference/mcp.md` (§4 CLI Delegation Model, ~lines 62-83; add a short provenance subsection)

**Interfaces:**
- Consumes: the behaviour landed in Tasks 1-3.
- Produces: normative documentation that the server forwards `--actor-source mcp`
  and the forward-looking remote-transport caveat. No code interface.

- [ ] **Step 1: Add the provenance row + caveat to §4**

In `docs/reference/mcp.md`, inside the §4 requirements table (the table starting
at line 70 with `| Aspect | Requirement |`), add a new row immediately after the
`Argument passing` row (line 74):

```markdown
| Actor provenance  | The server MUST prepend the program-level flag `--actor-source mcp` to every CLI invocation so actor-context-consuming CLI commands can resolve actor context. The server MUST NOT derive policy or roles from this tag. |
```

Then, immediately after the paragraph ending "...defined by
[docs/reference/security.md](security.md) and
[docs/reference/runtime.md](runtime.md)." (line 83), add:

```markdown
The `--actor-source mcp` provenance tag marks the caller as the local stdio MCP
front end. Under the stdio-local transport this server uses (see [§3](#server-identity)),
the MCP process spawns the local CLI in the same workspace and is
trust-equivalent to a direct CLI invocation; core resolves a trusted
run-controller actor context for actor-context-consuming commands (or a
claim-controller when supported `--claim-id` evidence is also forwarded). The
MCP layer sets only this ingress tag and the supported `--claim-id` flag; it
constructs and derives no actor-context policy itself. If a remote (HTTP/SSE)
transport is ever introduced, the trust mapping for `source=mcp` MUST be
revisited, because a remote caller would no longer be a local workspace process.
```

- [ ] **Step 2: Verify spelling/format gates pass on the doc**

Run from the active repo root (`$PWD`): `pnpm run check:spell && pnpm run check:format`
Expected: PASS. (`actor`, `mcp`, `stdio`, `claim` are existing vocabulary; if
`check:format` rewrites table whitespace, run `pnpm run format` and re-stage.)

- [ ] **Step 3: Commit**

```bash
git add docs/reference/mcp.md
git commit -m "docs(mcp): document --actor-source mcp provenance and remote caveat"
```

---

## Task 5: Full verification gate

**Files:**
- None (verification only)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: green pre-push gate.

- [ ] **Step 1: Build the package to confirm the new export type-checks**

Run from the active repo root (`$PWD`): `pnpm --filter @rundown-org/mcp run build`
Expected: PASS (no TS errors; `ACTOR_SOURCE_MCP` and `withActorSource` compile).

- [ ] **Step 2: Run the MCP unit suite**

Run from the active repo root (`$PWD`): `pnpm --filter @rundown-org/mcp test`
Expected: PASS.

- [ ] **Step 3: Run lint on the package**

Run from the active repo root (`$PWD`): `pnpm run lint`
Expected: PASS. Confirms no `Error.isError` misuse, no complexity regressions in
`tools.ts`.

- [ ] **Step 4: Run the pre-PR verify gate**

Run from the active repo root (`$PWD`): `pnpm run verify`
Expected: PASS (format, spell, lint, test). This is the MUST-pass gate before
push per `CLAUDE.md`.

Also verify the CLI precursor acceptance remains green before treating this MCP
plan as complete: its tests must prove `--actor-source mcp` parses before the
subcommand and that `source=mcp` does not bypass the collection-pending guard.
MCP unit tests alone are not sufficient final acceptance because MCP only
prepends argv; the CLI precursor owns parsing and guard enforcement.

- [ ] **Step 5: Commit any auto-format fixups**

```bash
git status --short
# If `verify` auto-formatted files:
git add -A
git commit -m "chore(mcp): formatting fixups for actor-source provenance"
```

(If `git status --short` is clean, skip the commit.)

---

## Self-Review

**1. Spec coverage (against the frozen brief "Plan 7 CONSUMES" + scope):**

| Requirement (brief) | Task |
| --- | --- |
| MCP sets `source=mcp` on spawned CLI | Task 1 (argv `--actor-source mcp` via `buildRundownCommand`) |
| Pick the cleaner seam (env vs argv) and justify | File Structure justification + Global Constraints (argv, because `mcp.md §4` forbids env modification) |
| Thread claim metadata only where the MCP tool supports it | Tasks 1-3 (`pushClaimId` retained only for `status`/`pass`/`fail`/`goto`/`complete`/`stop`/`collect`; `delegate` and `claim` remain claim-id-free) |
| Inspect-only tools need no claim | Task 3 (`status` no-claim test) |
| No policy logic in MCP | Global Constraints + Task 3 comment; no role/branch added |
| Forward-looking remote-transport note | Threat-model note section + Task 4 doc caveat |
| Preserve `RunCli` DI seam | Global Constraints; Task 3 Step 3 confirms `cli.ts` untouched |
| JSON envelope/error semantics must not regress | Task 3 envelope assertions; `createMcpTextResponse`/`runCli` unchanged |
| No persisted-state migration | Global Constraints (runtime-only) |
| TSDoc on new exports | Task 1 (`ACTOR_SOURCE_MCP`, `withActorSource`, updated `buildRundownCommand`) |
| `getErrorMessage`, never `Error.isError` | Global Constraints; no new error code added |
| Prerequisite precursor stated explicitly | Prerequisite section + pre-Task-1 verify step |
| CLI precursor parsing/guard acceptance is required | Task 5 final verification note |

All brief requirements map to a task. No gaps.

**2. Placeholder scan:** No `TBD`/`TODO`/"add validation"/"similar to Task N".
Every code step shows complete code. Every command has an expected outcome.

**3. Type consistency:** `ACTOR_SOURCE_MCP` (string literal `'mcp'`) is exported
in Task 1 and imported in Tasks 1-3 under the same name. `withActorSource`
(internal helper) is used only inside `tools.ts`. `buildRundownCommand` keeps
its signature `(tool: RundownToolName, input: Record<string, unknown>): string[]`.
`pushClaimId` is reused unchanged. Test imports match the export list
(`ACTOR_SOURCE_MCP`, `buildRundownCommand`, `createMcpTextResponse`,
`registerRundownTools`, `RUNDOWN_TOOL_DEFINITIONS`, `RunCli`, `RundownToolName`).
No naming drift.

---

## Notes on the precursor interface (for plan reconciliation)

The frozen `ActorIngress` interface from the precursor is **sufficient** for
MCP: MCP supplies `source` for every CLI call (via `--actor-source mcp`) and
supplies `claimId` only where the MCP tool schema supports it (`status`, `pass`,
`fail`, `goto`, `complete`, `stop`, `collect`). MCP does not supply claim ids
for `delegate` or `claim`, and it does not supply `tokenHash` or
`controlledRunId` directly — those are resolved CLI-side from the claim evidence
the CLI already owns for commands that consume actor context. One potential seam
gap to confirm during precursor reconciliation: the precursor must accept
`--actor-source` as a **program-level** option that is valid when it precedes any
subcommand token (the position this plan emits). If the precursor registered
`--actor-source` only on a subset of subcommands, this plan's "prepend before
the subcommand" emission would break for the uncovered subcommands — so the
precursor's program-level registration is a hard dependency, surfaced in the
Prerequisite "Verify the precursor has landed" step and Task 5's final
acceptance note.
