# Plugin Actor Context (Plan 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag only `rd` commands spawned by the Claude Code plugin helper with `RD_ACTOR_SOURCE=plugin`, preserving the plugin as a thin frontend that does not derive roles, route Bash lifecycle commands, or implement lifecycle policy.

**Architecture:** This plan has a deliberately narrow scope: `packages/claude-code-plugin/src/workflow/hooks/rundown.ts` is the plugin's direct `rd` spawn helper, so it is the only production chokepoint that receives the provenance tag. Agent-run lifecycle commands such as `rd pass`, `rd fail`, `rd delegate`, `rd collect`, `rd stop`, and `rd complete` are run through the agent's Bash tool, and current plugin hook routing intentionally does not route `PreToolUse(Bash)`; this plan does not change that. The CLI precursor owns actor-context construction and lifecycle policy; the plugin only supplies provenance for plugin-spawned helper calls.

**Tech Stack:** TypeScript (ESM), Jest, `execFileSync` injection tests, `@rundown-org/claude-code-plugin`, `pnpm` workspace.

---

## Authoritative Inputs

- `docs/superpowers/specs/2026-06-17-claim-delegation-lifecycle-design.md`
- `docs/superpowers/plans/2026-06-26-cli-actor-context-ingress.md`
- Live plugin and CLI code/tests in this worktree

Do not use `docs/internal/*` as evidence for this plan. The plan must be implementable from the files above and the live code/tests only.

## Scope

In scope:

- Add `RD_ACTOR_SOURCE=plugin` to child-process environment for commands spawned through `rundown(args, cwd, execOptions?)`.
- Preserve existing caller env layering and legacy delegation-env non-leak assertions.
- Pin that the dispatcher still does not route `PreToolUse(Bash)`.
- Verify the plugin has not imported or implemented role derivation, actor-context construction, or lifecycle policy.

Out of scope:

- Tagging agent-run Bash lifecycle commands as plugin-sourced. This plan does not add hook manifest routing, dispatcher routing, or env injection for `PreToolUse(Bash)`.
- Changing delegation-dispatch prompt semantics. Existing `rd claim <token>` and `--claim-id <claim_id>` instructions remain as-is, but the plugin does not convert them into roles.
- Adding plugin-level collection-pending integration coverage. The CLI precursor owns the source-independent collection-pending invariant for `pass`/`fail`/`delegate`, including `delegate`; this plugin plan does not duplicate those tests.
- Changing `complete`, `stop`, or `claim` actor-context behavior. Per the CLI precursor scope, `resolveActorContext` is consumed by `pass`, `fail`, `delegate`, and `collect`; `complete`, `stop`, and `claim` remain construction-free unless a later plan explicitly changes policy.

## Global Constraints

- **Prerequisite:** `docs/superpowers/plans/2026-06-26-cli-actor-context-ingress.md` must land first. This plugin plan consumes only the CLI precursor's `RD_ACTOR_SOURCE` env bridge and accepted source value `plugin`.
- **No Bash claim:** Do not say or imply that agent-run Bash lifecycle commands become `source=plugin`. They do not under this plan.
- **No hook-routing changes:** Do not modify the hook manifest, `packages/claude-code-plugin/src/dispatcher.ts`, or routing tests to intercept `PreToolUse(Bash)`.
- **Thin plugin boundary:** The plugin must not derive roles, construct actor contexts, call core policy resolvers, or branch on actor-context kind. It sets an env tag for helper-spawned commands only.
- **No persisted-state migration:** No snapshot, session, run-state, or schema shape changes.
- **TSDoc:** Any changed exported symbol keeps valid TSDoc. Avoid adding plugin source comments that name CLI/core construction symbols; verification checks imports and policy code precisely.
- **Test helper API:** Plugin `runCli` returns `{ stdout, stderr, exitCode }`, not `{ code }`. This plan does not need `runCli`; if an executor adds a sanity check, use `exitCode`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/claude-code-plugin/src/workflow/hooks/rundown.ts` | Single plugin helper that spawns the local `rd` CLI. Owns the `RD_ACTOR_SOURCE=plugin` default for plugin-spawned helper calls. | Modify |
| `packages/claude-code-plugin/__tests__/workflow/hooks/rundown.test.ts` | Unit tests for helper spawn arguments and env layering. | Modify |
| `packages/claude-code-plugin/__tests__/minimal-dispatch.contract.test.ts` | Existing contract proving `PreToolUse(Bash)` is not routed. | Read/verify only |

No other files are part of this plan. In particular, do not modify `delegation-dispatch.ts`, dispatcher routing, hook manifests, CLI code, core code, or docs.

---

## Task 1: Add failing provenance-env tests for the plugin spawn helper

**Files:**
- Modify: `packages/claude-code-plugin/__tests__/workflow/hooks/rundown.test.ts`

**Intent:** Prove the helper always supplies `RD_ACTOR_SOURCE=plugin` for plugin-spawned `rd` commands, while still allowing explicit caller env overrides.

- [ ] **Step 1: Add the failing tests**

Insert these tests in `packages/claude-code-plugin/__tests__/workflow/hooks/rundown.test.ts`, inside `describe('rundown', ...)`, immediately after the existing `merges env overrides into execSync options` test:

```typescript
  it('tags plugin-spawned rd commands with RD_ACTOR_SOURCE=plugin by default', () => {
    const mockExec = mockExecFileSync('ok');
    setExecSync(mockExec);

    rundown(['status'], '/some/project');

    expect(mockExec).toHaveBeenCalledWith(
      'node',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ RD_ACTOR_SOURCE: 'plugin' }),
      }),
    );
  });

  it('keeps RD_ACTOR_SOURCE=plugin while layering caller env overrides', () => {
    const mockExec = mockExecFileSync('ok');
    setExecSync(mockExec);

    rundown(['status'], '/some/project', { env: { RUNDOWN_TEST_ENV: 'session-a' } });

    const lastCall = mockExec.mock.calls[mockExec.mock.calls.length - 1] as unknown as [
      string,
      readonly string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(lastCall[2].env.RD_ACTOR_SOURCE).toBe('plugin');
    expect(lastCall[2].env.RUNDOWN_TEST_ENV).toBe('session-a');
  });

  it('lets an explicit caller RD_ACTOR_SOURCE override the plugin default', () => {
    const mockExec = mockExecFileSync('ok');
    setExecSync(mockExec);

    rundown(['status'], '/some/project', { env: { RD_ACTOR_SOURCE: 'direct-cli' } });

    const lastCall = mockExec.mock.calls[mockExec.mock.calls.length - 1] as unknown as [
      string,
      readonly string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(lastCall[2].env.RD_ACTOR_SOURCE).toBe('direct-cli');
  });
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
pnpm --filter @rundown-org/claude-code-plugin test -- rundown.test.ts
```

Expected before implementation: FAIL. The first new test fails because `rundown()` currently omits `env` entirely when `execOptions.env` is absent.

- [ ] **Step 3: Leave the failing test uncommitted for Task 2**

Do not commit yet. Task 2 adds the implementation and commits the integrated
passing slice.

---

## Task 2: Set the plugin provenance env in `rundown()`

**Files:**
- Modify: `packages/claude-code-plugin/src/workflow/hooks/rundown.ts`

**Intent:** Always construct the child-process environment in the plugin helper. Layering order is `process.env`, plugin default, caller overrides.

- [ ] **Step 1: Add the minimal implementation**

In `packages/claude-code-plugin/src/workflow/hooks/rundown.ts`, insert this constant after the `RundownExecOptions` interface:

```typescript
const PLUGIN_ACTOR_SOURCE = 'plugin' as const;
```

Then replace the current `rundown` function with:

```typescript
/**
 * Execute a rundown CLI command.
 *
 * Uses execFileSync to avoid shell interpretation and prevent command injection.
 *
 * Plugin-spawned commands carry `RD_ACTOR_SOURCE=plugin` as provenance for the
 * CLI actor-source ingress. The tag is applied only to commands spawned through
 * this helper; agent-run Bash commands are outside this helper and are not
 * affected.
 *
 * @param args - Command arguments as array (e.g., ['pass', '--agent', 'abc123'])
 * @param cwd - Working directory for the command
 * @param execOptions - Optional execution settings such as environment overrides
 * @returns Command output as string
 */
export function rundown(args: string[], cwd: string, execOptions: RundownExecOptions = {}): string {
  const cliPath = getRundownCliPath();
  const options: ExecFileSyncOptions = {
    cwd,
    env: {
      ...process.env,
      RD_ACTOR_SOURCE: PLUGIN_ACTOR_SOURCE,
      ...(execOptions.env ?? {}),
    },
    stdio: 'pipe',
    encoding: 'utf-8',
  };
  return execFileSyncImpl('node', [cliPath, ...args], options) as string;
}
```

- [ ] **Step 2: Run the focused test and confirm it passes**

Run:

```bash
pnpm --filter @rundown-org/claude-code-plugin test -- rundown.test.ts
```

Expected: PASS. Existing env tests still pass because they use `objectContaining` for expected env keys and still assert only that legacy `RD_AGENT_ID` / `RD_SESSION_ID` do not leak.

- [ ] **Step 3: Commit the integrated test + implementation slice**

```bash
git add packages/claude-code-plugin/src/workflow/hooks/rundown.ts packages/claude-code-plugin/__tests__/workflow/hooks/rundown.test.ts
git commit -m "feat(plugin): tag helper-spawned rd commands as plugin sourced"
```

---

## Task 3: Verify Bash lifecycle commands are still not routed

**Files:**
- Read/verify: `packages/claude-code-plugin/__tests__/minimal-dispatch.contract.test.ts`

**Intent:** Prevent accidental expansion from helper-spawn provenance into agent Bash lifecycle interception.

- [ ] **Step 1: Confirm the existing contract test is present**

Run:

```bash
rg -n "PreToolUse\\(Bash\\) is no longer routed|tool_name: 'Bash'|rd pass" packages/claude-code-plugin/__tests__/minimal-dispatch.contract.test.ts
```

Expected: all three patterns are found in the existing test named `PreToolUse(Bash) is no longer routed (delegation closure is enforced by core)`.

- [ ] **Step 2: Run the contract test**

Run:

```bash
pnpm --filter @rundown-org/claude-code-plugin test -- minimal-dispatch.contract.test.ts
```

Expected: PASS. The `PreToolUse(Bash)` case returns `{}`, proving this plan has not added Bash routing or env injection.

- [ ] **Step 3: Do not commit**

No files change in this task. If the test fails because an implementation changed Bash routing, revert that implementation and keep this plan narrow.

---

## Task 4: Verify no role or policy logic leaked into the plugin

**Files:** none unless formatting/lint tools change files

**Intent:** Keep the plugin boundary thin and avoid the previous grep contradiction. This check looks for imports and policy/construction code, not ordinary prose strings in docs.

- [ ] **Step 1: Check for forbidden plugin policy imports or construction helpers**

Run:

```bash
rg -n "from '@rundown-org/core'|deriveEffectiveRole|trustedRunControllerContext|claimControllerContext|UNKNOWN_ACTOR_CONTEXT|resolveCommandIntent|resolveTransitionTarget|resolveActorContext" packages/claude-code-plugin/src
```

Expected: NO matches. If there is a match, remove the policy/construction dependency from plugin source. The plugin may set `RD_ACTOR_SOURCE`; it must not derive roles or construct actor contexts.

- [ ] **Step 2: Run the plugin test suite**

Run:

```bash
pnpm --filter @rundown-org/claude-code-plugin test
```

Expected: PASS.

- [ ] **Step 3: Run repository verification**

Run:

```bash
pnpm run verify
```

Expected: PASS. If spelling or formatting changes are required, keep fixes limited to files already changed by this plan unless the verifier explicitly requires a central allowlist update; do not edit unrelated docs or code.

- [ ] **Step 4: Commit verifier fixups only if files changed**

If Step 3 changed files:

```bash
git add packages/claude-code-plugin/src/workflow/hooks/rundown.ts packages/claude-code-plugin/__tests__/workflow/hooks/rundown.test.ts
git commit -m "chore(plugin): apply verifier fixups for actor-source tagging"
```

If Step 3 changed no files, skip this step.

---

## Self-Review

- The plan no longer relies on `docs/internal/*`.
- The prerequisite matches the CLI precursor scope: `resolveActorContext` is consumed by `pass`, `fail`, `delegate`, and `collect`; `complete`, `stop`, and `claim` are construction-free in the precursor unless a later plan changes policy.
- The plan does not claim Bash lifecycle commands become `source=plugin`.
- The plan does not add Bash hook routing. The existing `PreToolUse(Bash)` non-routing contract remains authoritative for plugin behavior.
- The verification grep is precise enough to allow harmless prose in docs while still catching plugin source imports or role/policy construction code.
- The plan uses `exitCode` if plugin `runCli` is ever referenced; no stale `{ code }` API remains.
- There are no placeholder-based tests.
- The collection-pending invariant for `pass`/`fail`/`delegate`, including `delegate`, stays in the CLI precursor where it is actually implemented and tested.
- The plugin remains a thin frontend: no role derivation, no lifecycle policy, no actor-context construction.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-26-plugin-actor-context.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
