# Scenario Snapshot Tests Design

**Date:** 2026-04-21
**Status:** Approved

## Summary

Add snapshot test coverage for runbook scenario CLI output. Tests capture raw CLI output in both JSON (NDJSON) and `--text` format from a curated set of purpose-built fixture runbooks, normalise volatile values, and compare against Jest `.snap` files. MVP is a small curated set; the structure is designed to expand to comprehensive coverage later.

## Goals

- Detect regressions in CLI output shape and content across both output modes
- Cover the core output patterns (simple flows, retries, multi-level delegation + outputs)
- Establish the infrastructure for expanding to full scenario coverage later

## Non-Goals

- Comprehensive coverage of all runbooks in `runbooks/` (that's the long-term target)
- Testing business logic correctness (that's already handled by `scenario-runner.test.ts`)

## Architecture

Three components:

### 1. `normalizeCliOutput(output: string, cwd: string): string`

A helper function added to `packages/cli/__tests__/helpers/test-utils.ts`. Applied to all CLI output before snapshotting. Replaces volatile values with stable placeholders:

| Pattern | Placeholder |
|---|---|
| Run IDs (8-char hex) | `<runId>` |
| ISO 8601 timestamps | `<timestamp>` |
| `cwd` (temp workspace path) | `<workdir>` |
| Any other `/tmp/...` path | `<tmpdir>` |

For JSON output: applied to the raw NDJSON string (after `NO_COLOR=1` is already stripping ANSI). For text output: applied to the rendered string directly.

### 2. Fixture runbooks — `packages/cli/__tests__/fixtures/snapshots/`

Purpose-built minimal `.runbook.md` files. Each has exactly the steps needed for the scenario being snapshotted — no extra noise. Each carries a `scenarios:` frontmatter block so `rd scenario run` can drive it.

### 3. `packages/cli/__tests__/integration/scenario-snapshots.test.ts`

Explicit `it()` blocks — one per scenario per output format. Each test:
1. Creates an isolated test workspace (via existing `createTestWorkspace()`)
2. Runs `rd scenario run <fixture> <scenario>` via `runCliInProcess()`
3. Calls `normalizeCliOutput(result.stdout, workspace.cwd)`
4. Calls `expect(normalised).toMatchSnapshot()`

JSON and text variants are separate `it()` blocks with distinct names.

## MVP Fixture Set

### Simple fixtures

| File | Scenario | Covers |
|---|---|---|
| `snapshot-simple-complete.runbook.md` | `pass` | Single step → PASS → COMPLETE |
| `snapshot-simple-stop.runbook.md` | `fail` | Single step → FAIL → STOP |
| `snapshot-multi-step.runbook.md` | `all-pass` | Three steps, all PASS → COMPLETE |
| `snapshot-retry.runbook.md` | `retry-pass` | Step fails, retries, passes on second attempt |

### Complex fixture — delegation with outputs

Two files required:

**`snapshot-delegation-outputs.runbook.md`** (parent):
```yaml
---
name: snapshot-delegation-outputs
description: Parent delegates to child; parent OUTPUTS consumed by child via INPUTS
scenarios:
  complete:
    commands:
      - rd run snapshot-delegation-outputs.runbook.md
      - rd delegate snapshot-child.runbook.md --step 1.1
      - rd claim ${TOKEN}
    result: COMPLETE
---
# Delegation with Outputs
## 1. Parent step
- PASS ALL COMPLETE
- FAIL ANY STOP
- OUTPUTS
  - Message "hello from snapshot parent"
### 1.1 Child task
Delegated to child runbook.
```

**`snapshot-child.runbook.md`** (child):
```yaml
---
name: snapshot-child
description: Child runbook that consumes INPUTS from parent delegation
---
# Snapshot Child
## 1. Child step
- PASS COMPLETE
- FAIL STOP
- INPUTS
  - Message
The message is: {{Message}}
```

Scenario command sequence uses `${TOKEN}` variable substitution (existing infrastructure in `executeScenario()`). The snapshot captures the full multi-level event stream: parent steps, delegation event, child execution, claim resolution.

## Test File Structure

```typescript
// packages/cli/__tests__/integration/scenario-snapshots.test.ts

describe('scenario output snapshots', () => {
  let workspace: TestWorkspace;

  beforeAll(async () => {
    workspace = await createTestWorkspace([
      'snapshot-simple-complete.runbook.md',
      'snapshot-simple-stop.runbook.md',
      'snapshot-multi-step.runbook.md',
      'snapshot-retry.runbook.md',
      'snapshot-delegation-outputs.runbook.md',
      'snapshot-child.runbook.md',
    ]);
  });

  afterAll(() => workspace.cleanup());

  it('simple-complete — JSON', async () => { ... });
  it('simple-complete — text', async () => { ... });
  it('simple-stop — JSON', async () => { ... });
  it('simple-stop — text', async () => { ... });
  it('multi-step — JSON', async () => { ... });
  it('multi-step — text', async () => { ... });
  it('retry-pass — JSON', async () => { ... });
  it('retry-pass — text', async () => { ... });
  it('delegation-outputs — JSON', async () => { ... });
  it('delegation-outputs — text', async () => { ... });
});
```

## Expansion Path

When expanding to comprehensive coverage:

1. Add fixture runbooks to `__tests__/fixtures/snapshots/` — one per scenario shape
2. Add a data-driven loop in a sibling test file (`scenario-snapshots-full.test.ts`) that auto-discovers all fixtures and generates snapshot tests — same normalisation helper, same `toMatchSnapshot()` call
3. The explicit MVP tests in `scenario-snapshots.test.ts` remain as documented regression anchors for the key patterns

## Updating Snapshots

Use Jest's standard flag:

```bash
npx jest scenario-snapshots --updateSnapshot
# or
npx jest scenario-snapshots -u
```

Review the diff in `.snap` files carefully before committing — snapshot updates are the signal that output has changed.

## File Layout

```
packages/cli/
  __tests__/
    fixtures/
      snapshots/                          ← new
        snapshot-simple-complete.runbook.md
        snapshot-simple-stop.runbook.md
        snapshot-multi-step.runbook.md
        snapshot-retry.runbook.md
        snapshot-delegation-outputs.runbook.md
        snapshot-child.runbook.md
    helpers/
      test-utils.ts                       ← add normalizeCliOutput()
    integration/
      scenario-snapshots.test.ts          ← new
      scenario-runner.test.ts             ← unchanged
```
