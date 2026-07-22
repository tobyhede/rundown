# 608 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six technically valid review findings with regression-first fixes before resuming the R8 mutation-score campaign.

**Architecture:** Keep delegated authority fail-closed by deriving immutable parent identity from persisted delegation data, serialize store replacement behind per-key disposal promises, and prove recovery cannot re-enter an interrupted effect. Apply three isolated adapter/probe hardenings without changing the state-machine model or persistence compatibility policy.

**Tech Stack:** TypeScript 6, Node 24 `node:sqlite`, sql.js, XState 5, Jest 30, Astro/WebContainer, pnpm.

## Global Constraints

- Follow RED-GREEN-REFACTOR: no production edit before its regression test fails for the expected reason.
- Use `NODE_OPTIONS=--experimental-vm-modules mise exec node@24.18.0 --` for Jest commands.
- Do not restore `parent_linkage_version` or add persisted-state migration code.
- Do not rewrite existing dated prospective plans/specifications.
- Do not add raw compute-error logging or weaken mutation configuration.
- Preserve `.serena`, `.superpowers`, existing untracked prospective docs, and the current uncommitted `packages/core/__tests__/runbook/storage/runbook-store.test.ts` mutation-test additions.

## File Structure

- Create `packages/core/__tests__/runbook/storage/delegated-parent-authority.test.ts`: persisted absent-parent authority regression without colliding with the modified store test.
- Modify `packages/core/src/runbook/storage/runbook-store.ts`: carry delegation JSON into commit-row capture and retain delegated parent authority after FK nulling.
- Modify `packages/core/__tests__/runbook/storage/store-registry.test.ts`: deterministic close/open overlap regression.
- Modify `packages/core/src/runbook/storage/store-registry.ts`: per-key closing-promise serialization.
- Modify `packages/core/__tests__/runbook/execution-recovery-service.test.ts`: persisted mid-command snapshot recovery regression.
- Modify recovery production code only if the regression demonstrates effect replay.
- Modify `packages/core/__tests__/runbook/storage/driver-contract.test.ts` and `native-sqlite-driver.ts`: extended SQLite result-code classification.
- Modify `packages/core/__tests__/runbook/storage/schema.test.ts`: exact application-table assertion.
- Modify `site/src/pages/dev/sqlite-substrate-probe.astro`: await output drain.

---

### Task 1: Refuse delegated authority after parent deletion

**Files:**
- Create: `packages/core/__tests__/runbook/storage/delegated-parent-authority.test.ts`
- Modify: `packages/core/src/runbook/storage/runbook-store.ts`

**Interfaces:**
- Consumes: `RunbookStore.captureAuthority(runId, claimKey)` and persisted `DelegationClaimLinkage` in `claims.delegation_json`.
- Produces: `CommitRow.claimDelegationJson: string | null`; delegated captures retain `CapturedAuthority.parent.runId` even when the joined parent row is absent.

- [ ] **Step 1: Write the failing persisted regression**

Create a native-store integration fixture that creates parent and child runs, inserts an active claim controlling the child with a real delegation linkage, deletes the parent so SQLite sets `parent_run_id` to `NULL`, then calls:

```typescript
const result = await store.captureAuthority(child.id, claim.claimKey);
expect(result.kind).toBe('claim_superseded');
```

Also query the row before capture and assert `parent_run_id === null` while `delegation_json !== null`, proving the intended FK history.

- [ ] **Step 2: Run RED**

Run:

```bash
NODE_OPTIONS=--experimental-vm-modules mise exec node@24.18.0 -- \
  pnpm --filter @rundown-org/core test -- \
  __tests__/runbook/storage/delegated-parent-authority.test.ts --runInBand
```

Expected: FAIL because current capture returns `captured` after `ON DELETE SET NULL` erases the joined parent id.

- [ ] **Step 3: Retain immutable delegation identity in capture**

Extend the selected row with the persisted claim linkage:

```typescript
export interface CommitRow {
  // existing fields
  readonly claimDelegationJson: string | null;
}
```

Select/map `c.delegation_json`, and derive captured parent identity from parsed delegation JSON rather than the nullable joined row:

```typescript
const delegatedParent =
  row.claimDelegationJson === null
    ? undefined
    : parseDelegationLinkage(row.claimDelegationJson, claimKey).parentRunId;
const parent = delegatedParent === undefined ? undefined : { runId: delegatedParent };
```

Keep `CommitRow.parentId` as the live joined parent id. `classifyCommitRow` will then see `parentId === null` versus captured delegated parent and return `claim_superseded`.

- [ ] **Step 4: Run GREEN and related classifier tests**

Run the new test plus `runbook-store.properties.test.ts`; expect all tests to pass.

- [ ] **Step 5: Commit**

Commit only the new test and `runbook-store.ts` as:

```text
fix(core): refuse delegated authority after parent deletion
```

---

### Task 2: Serialize store close and reopen

**Files:**
- Modify: `packages/core/__tests__/runbook/storage/store-registry.test.ts`
- Modify: `packages/core/src/runbook/storage/store-registry.ts`

**Interfaces:**
- Consumes: `openRunbookStore`, `closeRunbookStore`, and `closeRunbookStores`.
- Produces: internal `closingStores: Map<string, Promise<void>>`; opens for a key await its active close.

- [ ] **Step 1: Write a deterministic close/open race test**

Open a native store, spy on its async disposer, and block disposal on a deferred promise. Start `closeRunbookStore(cwd)`, wait until disposal enters, then start `openRunbookStore(cwd)` and assert it remains unsettled through a microtask turn. Release disposal, await both operations, and assert the reopened store differs from the first.

- [ ] **Step 2: Run RED**

Run `store-registry.test.ts --runInBand`. Expected: FAIL because current close deletes `openStores` before disposal, allowing replacement open to resolve concurrently.

- [ ] **Step 3: Add per-key close serialization**

Add:

```typescript
const closingStores = new Map<string, Promise<void>>();
```

At the start of the asynchronous open body, await the closing promise captured for that key before filesystem/database open. Refactor close into one helper that registers the close promise synchronously, disposes best-effort, and deletes `closingStores[key]` only when the registered promise is still the same promise. Make `closeRunbookStores` register every removed entry before awaiting all disposals. If a key has no open entry but is already closing, `closeRunbookStore` awaits that close.

- [ ] **Step 4: Run GREEN and type check**

Run `store-registry.test.ts`, `store-registry-chmod.test.ts`, and core `check:types`; expect exit 0.

- [ ] **Step 5: Commit**

```text
fix(core): serialize store close and reopen
```

---

### Task 3: Prove recovery cannot repeat a persisted effect

**Files:**
- Modify: `packages/core/__tests__/runbook/execution-recovery-service.test.ts`
- Modify only if RED exposes a defect: `packages/core/src/runbook/execution-recovery-service.ts` or the production recovery actor factory.

**Interfaces:**
- Consumes: `compileRunbookToMachine(..., { commandServices })`, persisted XState snapshots, `ExecutionRecoveryService.recover`.
- Produces: regression proof that recovery sends `EXECUTION_OUTCOME_UNKNOWN` without re-invoking command actors.

- [ ] **Step 1: Persist a real command-invoke snapshot**

Compile a runbook with command services whose external command returns a never-resolving promise. Start the actor, send a real `EXECUTE_COMMAND`, wait until the command spy has been called once, capture `actor.getPersistedSnapshot()`, and persist that snapshot in the run state. Mark its attempt `recovery_pending` using the existing real lease/store fixture.

- [ ] **Step 2: Recover with throwing actor callables and run RED**

Construct the recovery actor from the persisted snapshot using command, helper, and delegation callables that increment counters and throw if invoked. Call `recover()` and assert all effect counters remain zero and the committed snapshot has the recovery tag.

Run `execution-recovery-service.test.ts --runInBand`. If the current implementation replays the invoke, expected RED is a nonzero counter/throw. If it already passes, record that the finding was a missing regression only and do not change production.

- [ ] **Step 3: Apply the minimal production correction only if needed**

If RED demonstrates replay, ensure the production recovery factory rehydrates with inert actors and transitions synchronously to `recoveryRequired` before an invoke can execute. Do not retry, suppress, or reinterpret the interrupted effect.

- [ ] **Step 4: Run GREEN and type check**

Run the focused recovery suite and core `check:types`; expect exit 0.

- [ ] **Step 5: Commit**

```text
test(core): prove recovery never repeats persisted effects
```

Use `fix(core): prevent recovery from repeating persisted effects` instead only if production changes are required.

---

### Task 4: Harden adapter contracts and WebContainer output capture

**Files:**
- Modify: `packages/core/__tests__/runbook/storage/driver-contract.test.ts`
- Modify: `packages/core/src/runbook/storage/native-sqlite-driver.ts`
- Modify: `packages/core/__tests__/runbook/storage/schema.test.ts`
- Modify: `site/src/pages/dev/sqlite-substrate-probe.astro`

**Interfaces:**
- Consumes: `isSqliteBusy(error)` and the WebContainer process output stream.
- Produces: extended busy/locked codes classify by primary byte; probe returns only after output EOF.

- [ ] **Step 1: Write RED adapter tests**

Add cases for extended integer codes:

```typescript
expect(isSqliteBusy(Object.assign(new Error('busy snapshot'), {
  code: 'ERR_SQLITE_ERROR',
  errcode: 5 | (2 << 8),
}))).toBe(true);
expect(isSqliteBusy(Object.assign(new Error('locked shared cache'), {
  code: 'ERR_SQLITE_ERROR',
  errcode: 6 | (1 << 8),
}))).toBe(true);
```

Run the focused driver contract. Expected: both extended-code assertions fail.

- [ ] **Step 2: Normalize only valid integer result codes**

Implement:

```typescript
if (typeof errcode !== 'number' || !Number.isInteger(errcode)) return false;
const primary = errcode & 0xff;
return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
```

Rerun the driver contract; expect GREEN.

- [ ] **Step 3: Make the schema assertion exact**

Change the table query to include `name NOT LIKE 'sqlite_%' ORDER BY name`, then assert:

```typescript
expect(tables).toEqual([...EXPECTED_TABLES].sort());
```

Run `schema.test.ts`; expect GREEN. This is test hardening and needs no production change.

- [ ] **Step 4: Await WebContainer output draining**

Retain the reader task:

```typescript
const drain = (async () => {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += value;
  }
})();
const code = await proc.exit;
await drain;
return { out, code };
```

Run:

```bash
mise exec node@24.18.0 -- pnpm --dir site run build
mise exec node@24.18.0 -- pnpm --dir site test -- tests/sqlite-substrate.spec.ts
```

Expected: the Astro build and the focused Playwright probe pass.

- [ ] **Step 5: Commit**

```text
fix: harden SQLite adapter and WebContainer probe
```

---

### Task 5: Integrated verification and mutation handoff

**Files:**
- Verify all files from Tasks 1-4.

- [ ] **Step 1: Run focused suites together**

Run every touched core test under Node 24, core `check:types`, relevant site checks, and `git diff --check`.

- [ ] **Step 2: Review commit boundaries and protected files**

Confirm the four task commits contain only intended files and the pre-existing uncommitted R8 mutation-test additions remain present and unstaged.

- [ ] **Step 3: Resume mutation work**

After review remediation is green, incorporate/review the existing R8 mutation tests, rerun a targeted changed-function campaign, then run the required aggregate campaign only when the targeted suite demonstrates enough additional kills to exceed the configured 70% threshold.
