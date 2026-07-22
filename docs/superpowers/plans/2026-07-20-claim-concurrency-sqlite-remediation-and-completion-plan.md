# Claim Concurrency SQLite — Remediation and Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Supersedes:** `docs/superpowers/plans/2026-07-19-claim-concurrency-sqlite-implementation-plan.md`
**Evidence base:** `docs/superpowers/notes/2026-07-20-608-audit-findings.md` (seven-auditor independent review of `5fdf7379c..53534f388`)
**Branch:** `608-sqlite-claim-concurrency` (worktree `.worktrees/608-atomic-claim-commit`)
**Base:** `63077ea8f`

**Goal:** Correct the defects the audit confirmed in Tasks 1–6, finish Task 6 honestly, and complete the SQLite cutover through the superseded plan's Tasks 7–10.

**Architecture:** One transactional SQLite store, generation/state CAS, and a fail-closed per-run execution protocol. This successor adds remediation Tasks R0–R8 ahead of carried-forward Tasks 7–10, plus binding amendments where verified implementation details changed the older task text.

**Tech Stack:** TypeScript 6, XState 5, Node `node:sqlite`, `sql.js` WASM, Jest 30, fast-check, Playwright/WebContainer, pnpm workspaces.

## Why this plan replaces the previous one

The superseded plan is sound in design and its Task 7/8 partition is correct — the audit confirmed this explicitly. It is replaced rather than amended because three things are now true that its text cannot express:

1. **It records no state.** All 100 checkboxes are `- [ ]` while Tasks 1–5 are substantially built. The plan cannot be used to answer "what is done".
2. **Confirmed defects have no owner in it.** The FK pragma gap, the unenforced controlling-claim invariant, the dropped `CHILD_LINKAGE_MISMATCH` coverage, and the `runGuardedParentAdvance` regression are not tasks in it.
3. **One of its own instructions was violated and needs a deliberate replacement**, not a re-statement: Task 6 required `runGuardedParentAdvance`'s TOCTOU guard to survive unchanged; the implementation removed it. R2 adds the durable claim latch, and the Task 8 amendment restores check/write atomicity inside `commitOwnedState`.

**Task numbering 7–10 is preserved deliberately.** Those numbers are referenced by commits, the audit note, and the handoff. Remediation work is numbered R0–R8 so nothing renumbers.

---

## Decided design questions

Three questions surfaced by the verified review register (`docs/superpowers/notes/2026-07-20-608-plan-review-register.md`). They are decided below and incorporated into the affected tasks; execution must not reopen them implicitly or mix the rejected alternatives back into the implementation.

**Q1 — Durable claim-record latch (decided).** R2 uses a two-sided durable latch. A claim transaction validates that the exact delegation is still live before inserting or refreshing a claim; every authoritative parent state commit tombstones active delegated claims whose linkage is no longer live in the committed state. The second half is essential: a claim-row latch alone cannot block an insert when no row existed at the parent commit. This ordering closes insert-before-advance, advance-before-insert, reset revival, and the top-level cursor-advance path. It also preserves #519: tombstoning changes authorization state and therefore bumps claim generation, while `lastSeenAt` remains metadata-only.

**Q2 — Typed legacy-state refusal (decided).** Task 9 must reject detected legacy JSON state through the default JSON error envelope. It reuses R3's `INCOMPATIBLE_STATE_SCHEMA` definition and therefore exposes `RD-305`, with `details.context` identifying the legacy paths and the only supported remedies: finish/prune with the pre-cutover binary, or remove the obsolete state and restart. It must not call `warnIfLegacyStateExists`, parse/import the files, or add dual-read compatibility.

**Q3 — Remove the vacuous linkage-version branch; keep atomic initial linking (decided).** The authoritative design requires invalidation when parent liveness or linkage changes, but the current product has no A→B relink operation: `claimAndLaunch` returns early when `freshDelegation.childRunId` exists, and RETRY creates a new token whose parent-state write is already handled by R2. `updateStepDelegationChildRunId` only establishes or clears the initial child link. R8 therefore removes `parent_linkage_version` and its impossible CAS branch, and replaces the CLI's split claim-then-link write with one core-owned initial claim/link transaction. Parent terminalization and token reissue remain R2 invalidation cases.

---

## Actual state of the superseded plan's Tasks 1–6

Audited verdicts, not prior claims. Cite `2026-07-20-608-audit-findings.md` for evidence.

| Task | Verdict | Outstanding |
| --- | --- | --- |
| 1 Storage substrate | Done | FK pragma gap on the sql.js adapter → **R1** |
| 2 SQL repository | Mostly done | Linkage-bump property + CAS-zero-row property → **R6**; unenforced controlling-claim invariant → **R3** |
| 3 Execution ownership | Done | None |
| 4 XState recovery | Done | Upward recovery projection still open → assigned to **Task 8** below |
| 5 Compute/commit seam | Partially done | Built but unwired (correct staging — Task 7 wires it); `lifecycle: 'stopped'` bullet not done → **Task 7** |
| 6 State-only + claim ops | Partially done | durable delegation-claim latch → **R2**; refusal taxonomy → **R4**; `execution_in_progress`/`recovery_required` → **R6**; atomic initial claim/link and removal of vacuous linkage versioning → **R8** |
| 7–10 | Not started | Carried forward below |

**Deleted without plan authorisation:** `runbooks/delegation/delegate-claim-corruption.runbook.md`. Half its coverage was rehomed; the `CHILD_LINKAGE_MISMATCH` half was not → **R4**.

---

## Global Constraints

Every constraint from the superseded plan's § Global Constraints remains in force verbatim. Reproduced here so this document is self-contained, with additions marked **NEW**.

- The design specification is `docs/superpowers/specs/2026-07-18-claim-concurrency-sqlite-design.md`; it is authoritative except for this successor's dated R8 correction to its `c.parent_linkage_version` sketch. The spec required invalid/moved parent linkage to refuse and the child generation to bump, but the implemented product has no operation that can advance that counter. R2 now enforces the same safety property with exact live-delegation validation plus one active→superseded claim UPDATE at the parent commit; R8 removes the vacuous field/CAS branch rather than inventing relinking behavior.
- Persisted run state is never migrated. Existing `.rundown/runs/*.json` or `.rundown/session.json` causes a typed incompatible-state refusal at cutover; there is no import, dual-read, fallback parser, or compatibility shim.
- Runbook lifecycle and recovery behavior lives in the XState machine. Storage and CLI code may detect an interrupted execution, but must send the typed `EXECUTION_OUTCOME_UNKNOWN` event rather than synthesizing `recovery_required` state.
- The CLI, MCP server, and Claude Code plugin remain thin frontends. They invoke core mutation APIs and render typed outcomes; they do not reproduce claim, lease, retry, or recovery rules.
- SQLite write transactions are short. No process spawn, command, helper call, delegation preparation, filesystem discovery, or actor-effect wait occurs inside `BEGIN IMMEDIATE`.
- A random execution token identifies one acquisition. Monotonic `exec_epoch` orders attempts. Neither guarantees exactly-once external effects.
- `runs.claim_generation` is authoritative. Claim rows carry immutable issuance generation only; delegated acquire/commit also re-check parent lifecycle and linkage.
- Claim-generation bump writers and state-version writers structurally respect active execution ownership. Parent terminalization updates each linked active claim to `superseded`; that single claim trigger owns the child generation bump.
- A live or conservatively unknown PID is never age-reclaimed. `ESRCH` is dead; `EPERM` and unknown results are treated as alive.
- `effect_started` interrupted attempts become machine-owned `recovery_required`; they are never automatically re-executed. Only a `claimed` pre-effect attempt may be reclaimed and retried automatically.
- `recoveryRequired` is a non-final top-level machine state with persisted lifecycle still `running`; child-to-parent projection is open with reason `recovery_required`.
- All affected runs in a multi-run operation are acquired in one all-or-none transaction. Exact row counts are mandatory; partial acquisition never commits.
- Project/session stack and stash read-modify-write operations remain inside one transaction. Any future cross-transaction session RMW requires a `session_version` CAS.
- Database lease conflicts refuse immediately. Any optional wait retries the whole short transaction outside SQLite with a finite budget; no transaction or trigger waits.
- Default contention policy is decided before Task 7 and is agent-visible. The new default is immediate `execution_in_progress`/`concurrent_modification` refusal. The finite opt-in wait is specified and tested in Task 3.
- Every mutation-result refusal variant carries `runId: RunId` and, where operator-facing, a `message`. Payload-free refusal discriminants are rejected in review.
- Recovery is modelled as both an XState state and a tag. `'recovery'` is in `setup({ types: { tags } })`; every "is this run recovering?" query is `snapshot.hasTag('recovery')`.
- Execution-identity credentials are branded. `exec_token` is `ExecutionToken`. Recovery `reason` is a closed literal union. Do not retain a branded linkage counter when no production operation can advance it.
- Scenario coverage is a required test level. The scenario runner is in-process/sequential and cannot express a true two-process race; those races stay in Jest integration.
- The native and WASM adapters execute the same schema and SQL. `sql.js` additionally holds the retained file lock only across each short `load → transaction → export → file fsync → rename → directory fsync` cycle.
- Runtime selection is positive: `sql.js` only for a positively identified WebContainer. Native SQLite unavailability on a normal multi-process host is a startup error.
- All exported symbols require TSDoc. Use `isError()`, `isNodeError()`, and `getErrorMessage()` rather than direct `Error.isError()`.
- Every behavior-bearing task follows red-green-refactor and ends with focused tests plus `pnpm --filter @rundown-org/core run check:types` where core types changed.
- Only Task 1 is independently mergeable to the release branch. Remaining tasks form a stacked integration sequence released together at Task 9's cutover.
- **NEW — Driver parity is a tested property, not a shared-code assumption.** Any behaviour depending on connection-level SQLite state (pragmas, especially `foreign_keys`) must be asserted against **both** adapters in `driver-contract.test.ts`. Shared DDL does not imply shared runtime enforcement.
- **NEW — An invariant asserted in prose must be enforced by the schema or checked at the read.** Where neither is practical, the consumer refuses on ambiguity rather than selecting a representative row. `ORDER BY … LIMIT 1` over a set assumed to be a singleton is rejected in review.
- **NEW — A safety argument in a comment cites the mechanism that actually enforces it.** Where a guard's correctness depends on a predicate holding at a later time, the comment states what re-establishes it, and a test pins that. Derived predicates over mutable state are not treated as latches.
- **NEW — Concurrency tests carry a contention witness.** A cross-process race test asserts that **mutation attempts were concurrently in flight**; a test that would pass identically under serial execution is not evidence of a concurrency property. The wording matters: **SQLite is single-writer, so exclusive critical sections cannot overlap in wall time by construction.** `immediate()` (`native-sqlite-driver.ts:161-181`) wraps `BEGIN IMMEDIATE` in a `SQLITE_BUSY` retry loop with backoff atop `PRAGMA busy_timeout`, so a measured `[t0, t1]` interval brackets lock contention + backoff + retries + one exclusive transaction. Overlapping intervals therefore witness overlapping *attempts*, which is exactly the property required — that the barrier worked and the children were genuinely simultaneous. An assertion phrased as "the critical sections overlapped" is unsatisfiable and must not be written.
- **NEW — Deleting a defensive branch requires the premise be enforced, not argued.** Removing a typed refusal on the grounds that its condition is unreachable requires a schema constraint or test proving unreachability, on every supported driver.

---

## File Structure

The superseded plan's File Structure table (§ File Structure) stands unchanged. Files this plan adds or re-scopes:

| File | Responsibility |
| --- | --- |
| `packages/core/src/runbook/storage/sqljs-driver.ts` | **Re-scoped (R1):** applies connection pragmas on every `load()`, not once at construction — each write cycle builds a fresh `Database`. |
| `packages/core/src/runbook/storage/schema.ts` | **Re-scoped (R3, R8):** R3 adds the partial unique active-controller index and takes SQLite `SCHEMA_VERSION` to `2`; R8 removes the vacuous `parent_linkage_version` column and takes it to `3`. Rundown `CURRENT_SCHEMA_VERSION` stays `1`. |
| `packages/cli/src/helpers/wrapper.ts` | **Re-scoped (R3):** `toRundownError` gains an `IncompatibleSchemaError` branch so the schema rejection surfaces as a typed code rather than `RD-999`. |
| `packages/core/src/runbook/claim-id.ts` | **Re-scoped (R2, R8):** claim results gain durable delegation-supersession and atomic claim/link variants. |
| `packages/core/src/runbook/session-service.ts` | **Re-scoped (R2, R6, R8):** `claimRunbook` validates live delegation identity; session mutators return the common ownership-refusal union; initial claim and parent link commit together. |
| `packages/core/src/runbook/storage/runbook-store.ts` | **Re-scoped (R2, R3, R6, R8):** owns the central post-state-write invalidation hook, controller uniqueness, ambient recovery reads, and atomic initial linking. |
| `packages/cli/src/helpers/runbook-pipeline.ts` | **Re-scoped (R2, R8):** renders the optional-child supersession details contract and deletes the direct parent-state initial-link writer. |
| `packages/core/__tests__/runbook/storage/driver-contract.test.ts` | **Re-scoped (R1):** gains FK-enforcement parity coverage across both adapters. |
| `packages/core/__tests__/runbook/storage/fixtures/session-writer-child.ts` | **Re-scoped (R5):** emits a contention witness (`t0`/`t1`) alongside its result. |

---

### Task R0: Restore the `pnpm run verify` gate

**`pnpm run verify` currently fails on this branch.** `CLAUDE.md` makes it the mandatory pre-push gate, so this blocks every commit below. `pnpm run lint` and `pnpm run check:types` pass; `pnpm run check:spell` reports **75 issues across 13 files**, all introduced by this branch (every `storage/*.ts` file is `A` in `git diff --name-status 63077ea8f..HEAD`).

All 19 distinct words are legitimate technical vocabulary, not typos: `sqljs`/`Sqljs` (26), `effectful`/`Effectful` (19), `errcode` (6), `tombstoned`/`Tombstoned` (5), `dbname` (4), `neighbour` (3), `WEBCONTAINER` (2), `fsyncs` (2), plus `untargetable`, `unserialized`, `unbindable`, `unawaited`, `terminalizes`, `rowids`, `defence`.

**Files:**
- Modify: `cspell-dictionary.txt` — the repo's sole writable dictionary. `cspell.json:4-8` defines it as the `rundown` dictionary with `path: "./cspell-dictionary.txt"` and `addWords: true`, and `dictionaries: ["rundown"]` at `:11` is the only entry. **`package.json` has no `cspell` config key** — its only `cspell` mentions are the `check:spell` script (`:49`) and the devDependency (`:106`). Do not edit `cspell.json` or `package.json`.

- [ ] **Step 1: Confirm the failure and capture the baseline**

```bash
pnpm run check:spell
```

Expected: `Issues found: 75 in 13 files`, exit 1.

- [ ] **Step 2: Add the technical vocabulary to the dictionary**

Add the words listed above to `cspell-dictionary.txt`. Two are a deliberate choice rather than a dictionary gap: `defence` and `neighbour` are British spellings in new code. Check the surrounding codebase's convention and either normalise the source to US spelling or add them — do not add them reflexively without looking. **The convention is already established:** `neighbouring` is present at `cspell-dictionary.txt:145`, so British spellings are accepted in this repo and adding `neighbour` is consistent rather than novel.

- [ ] **Step 3: Confirm the gate is green**

```bash
pnpm run check:spell && pnpm run verify
```

Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add cspell-dictionary.txt
git commit -m "chore: add SQLite storage vocabulary to the spell dictionary"
```

---

### Task R1: Enforce foreign keys on the sql.js adapter

The audit's most severe confirmed finding. `native-sqlite-driver.ts:130` sets `PRAGMA foreign_keys = ON`; the sql.js adapter sets no pragma, and SQLite defaults it **OFF per connection**. `deleteRun` (`runbook-store.ts:1074-1077`) delegates all claim cleanup to `ON DELETE CASCADE`, so under WebContainer a run delete leaves orphan claims and the next `claimRunbook` throws a hard inconsistency error.

**The fix is not a constructor pragma.** `SqljsDriver.load()` builds a **fresh `new this.sql.Database(...)` on every write cycle**, so the pragma must be applied per load.

**Files:**
- Modify: `packages/core/src/runbook/storage/sqljs-driver.ts:319-329`
- Modify: `packages/core/__tests__/runbook/storage/driver-contract.test.ts`

**Interfaces:**
- Consumes: `SqlDriver` (`storage/sql-driver.ts`), the existing both-adapter parametrisation in `driver-contract.test.ts`.
- Produces: no signature change. Behavioural guarantee that FK constraints enforce identically on both adapters.

- [ ] **Step 1: Write the failing parity test**

Add to `packages/core/__tests__/runbook/storage/driver-contract.test.ts`, inside the existing `describe.each(ADAPTERS)` block (`:54`), which genuinely parametrises `native` and `sqljs`. Note the conventions this block already uses: each test opens its own driver via `await using driver = await adapter.open()`; writes go through `immediate()` — **there is no `driver.write`**; and the `runs` table has **no `schema_version` column** (version lives in `PRAGMA user_version`).

```typescript
it('cascades claim rows when their controlled run is deleted', async () => {
  await using driver = await adapter.open();
  const now = '2026-07-20T00:00:00.000Z';

  await driver.immediate((tx) => {
    ensureSchema(tx);
    tx.prepare(
      `INSERT INTO runs (id, state_version, claim_generation, lifecycle,
         state_json, created_at, updated_at)
       VALUES (:id, 1, 1, 'running', '{}', :now, :now)`,
    ).run({ id: 'rd_cascade', now });
    tx.prepare(
      `INSERT INTO claims (key, controlled_run, secret_hash, issued_generation,
         status, grants_json, issued_at, updated_at, last_seen_at)
       VALUES (:key, :run, 'hash', 1, 'active', '{}', :now, :now, :now)`,
    ).run({ key: 'rdclk_cascade', run: 'rd_cascade', now });
  });

  await driver.immediate((tx) => {
    tx.prepare('DELETE FROM runs WHERE id = :id').run({ id: 'rd_cascade' });
  });

  const remaining = await driver.read((tx) =>
    tx.prepare('SELECT COUNT(*) AS n FROM claims').get<{ readonly n: number }>(),
  );
  expect(remaining?.n).toBe(0);
});

it('reports foreign_keys as enabled', async () => {
  await using driver = await adapter.open();
  const pragma = await driver.read((tx) =>
    tx.prepare('PRAGMA foreign_keys').get<{ readonly foreign_keys: number }>(),
  );
  expect(pragma?.foreign_keys).toBe(1);
});
```

- [ ] **Step 2: Run the test and confirm it fails on sqljs only**

```bash
cd packages/core && pnpm test -- __tests__/runbook/storage/driver-contract.test.ts
```

Expected: both new tests PASS for the native adapter and FAIL for the sqljs adapter (`Expected: 0, Received: 1` on the cascade test; `Expected: 1, Received: 0` on the pragma test).

- [ ] **Step 3: Apply the pragma on every load**

In `packages/core/src/runbook/storage/sqljs-driver.ts`, replace the body of `load()` (`:320-330`). Use the `private` keyword, not a `#` field — the file uses `private` exclusively (15 occurrences) and has no ECMAScript-private members. `Database` is already imported as a type (`:30`), and `isNodeError` is already imported (`:31`).

```typescript
  private async load(): Promise<Database> {
    try {
      const bytes = await fs.readFile(this.dbPath);
      return this.withConnectionPragmas(new this.sql.Database(bytes));
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return this.withConnectionPragmas(new this.sql.Database());
      }
      throw err;
    }
  }

  /**
   * Apply connection-scoped pragmas to a freshly constructed database.
   *
   * sql.js rebuilds the in-memory database on every load cycle, and SQLite
   * scopes `foreign_keys` to the connection rather than the file. Without this,
   * every FK constraint in the schema — notably `claims.controlled_run`'s
   * `ON DELETE CASCADE` — is silently inert on this adapter while enforcing
   * normally on the native one.
   *
   * @param db - Newly constructed in-memory database.
   * @returns The same database, with connection pragmas applied.
   */
  private withConnectionPragmas(db: Database): Database {
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  }
```

Both `read()` (`:221`) and `immediate()` (`:241`) call `load()` before `BEGIN`, so this covers every cycle.

- [ ] **Step 4: Run the test and confirm both adapters pass**

```bash
cd packages/core && pnpm test -- __tests__/runbook/storage/driver-contract.test.ts
```

Expected: PASS for both adapters.

- [ ] **Step 5: Pin the outcome at the production consumer, not just hand-written DELETE SQL**

The two driver tests prove the pragma is on and that cascades fire for hand-written SQL. Neither pins `RunbookStore.deleteRun`, the actual consumer that delegates claim cleanup to the cascade.

Add a third test inside the existing `describe.each(ADAPTERS)` block in `driver-contract.test.ts`: construct `RunbookStore` with that block's opened driver, insert a schema-valid run and claim through `store.createRun` / `store.transaction(txn => txn.insertClaim(...))`, call the public `await store.deleteRun(runId)`, and query through the same driver to assert the claim count is zero. This is executable on both adapters without pretending the native-only `runbook-store.test.ts` fixture is parametrised. The follow-on `claimRunbook` assertion is unnecessary and would require a second independently opened manager/store; the absence of the claim row is the production-consumer invariant.

- [ ] **Step 6: Run the full storage suite and type check**

```bash
cd packages/core && pnpm test -- __tests__/runbook/storage/
pnpm --filter @rundown-org/core run check:types
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runbook/storage/sqljs-driver.ts \
        packages/core/__tests__/runbook/storage/driver-contract.test.ts
git commit -m "fix(core): enforce foreign keys on the sqljs adapter"
```

---

### Task R2: Latch delegated-claim supersession at the parent commit

The decided design is not a read-side `status === 'done'` heuristic. It is a two-sided durable latch:

1. `claimRunbook` refuses an insert or refresh unless the exact delegation is live in the parent state read inside the claim transaction.
2. Every authoritative parent state commit tombstones every active delegated claim that is no longer live in the newly committed state, in the same transaction as that state write.

Those halves establish a total order. If claim insertion commits first, the parent commit tombstones it. If the parent commit lands first, the claim-side validation refuses insertion. A later RETRY/GOTO can create a new delegation identity, but resetting a prior row to `pending` cannot resurrect the tombstoned bearer. This covers substep completion and the top-level `#driveTopLevel` cursor advance; it does not depend on a `done` row being written.

**Files:**

- Modify: `packages/core/src/runbook/targeting.ts`
- Modify: `packages/core/src/runbook/storage/runbook-store.ts`
- Modify: `packages/core/src/runbook/claim-id.ts`
- Modify: `packages/core/src/runbook/session-service.ts`
- Modify: `packages/cli/src/helpers/runbook-pipeline.ts`
- Modify: `packages/cli/src/commands/claim.ts`
- Modify: `packages/core/src/errors/codes.ts`
- Modify: `packages/core/src/output/zod-schemas.ts`
- Test: `packages/core/__tests__/runbook/targeting.test.ts`
- Test: `packages/core/__tests__/runbook/storage/runbook-store.test.ts`
- Test: `packages/core/__tests__/runbook/storage/runbook-store.properties.test.ts`
- Test: `packages/core/__tests__/runbook/session-service.test.ts`
- Test: `packages/core/__tests__/runbook/completion-service.test.ts`
- Test: `packages/cli/__tests__/helpers/claim-and-launch.test.ts`
- Test: `packages/cli/__tests__/commands/claim.test.ts`
- Create: `runbooks/delegation/delegate-claim-superseded.runbook.md`
- Modify: `docs/reference/cli.md`
- Modify: `packages/claude-code-plugin/skills/delegating-runbooks/SKILL.md`
- Modify: `packages/claude-code-plugin/skills/running-runbooks/SKILL.md`

**Interfaces:**

```typescript
export type DelegationLiveness =
  | { readonly kind: 'live'; readonly substep: SubstepState }
  | { readonly kind: 'closed'; readonly reason: 'parent-ended' | 'cursor-advanced' | 'resolved' | 'token-reissued' }
  | { readonly kind: 'parent-unreadable' };

export function classifyDelegationLiveness(
  parent: RunbookState | null,
  linkage: Pick<
    DelegationClaimLinkage,
    'parentStep' | 'parentStepId' | 'parentFrameKey' | 'parentEntry' | 'tokenHash'
  >,
): DelegationLiveness;

export interface RunbookStoreTxn {
  // Existing members omitted.
  invalidateClosedDelegatedClaims(parent: RunbookState): readonly ClaimLookupKey[];
}

export type ClaimRunbookResult =
  | { readonly status: 'claimed'; readonly claimId: ClaimId; readonly claim: ClaimRecord }
  | { readonly status: 'already-claimed'; readonly childRunId: RunId; readonly claim: ClaimRecord }
  | { readonly status: 'missing-child'; readonly childRunId: RunId }
  | { readonly status: 'terminal-child'; readonly childRunId: RunId; readonly lifecycle: 'completed' | 'stopped' }
  | { readonly status: 'linkage-mismatch'; readonly childRunId: RunId; readonly incoming: DelegationLinkage; readonly persisted: RunbookState['parentLinkage'] }
  | {
      readonly status: 'delegation-superseded';
      readonly parentRunId: RunId;
      readonly parentStepId: string;
      readonly childRunId?: RunId;
    };
```

`classifyDelegationLiveness` is one pure source of truth used by both transaction paths. A delegation is live only when:

- the parent exists and is not terminal;
- `parent.step === linkage.parentStep`;
- the matching `SubstepState` exists at `parentStepId + parentFrameKey`;
- that row still carries the same `tokenHash`, is not cancelled, and is not `done`; and
- its entry identity still matches `parentEntry` where the persisted frame carries an entry.

Do not reduce this to `status !== 'done'`: that recreates the top-level hole. Do not treat `parent-unreadable` as live or fall through; it is a hard database-integrity error.

- [ ] **Step 1: Pin the classifier before wiring it**

Add table-driven tests for live, parent missing, parent terminal, cursor advanced without a `done` row, done substep, token replacement, frame mismatch, entry mismatch, cancellation, and a RETRY/GOTO-created new token. Run:

```bash
pnpm --filter @rundown-org/core test -- __tests__/runbook/targeting.test.ts
```

Expected: FAIL because `classifyDelegationLiveness` does not exist.

- [ ] **Step 2: Implement the pure classifier**

Place it beside `findSubstepState` in `targeting.ts`, use `state.substepStates ?? []`, and preserve the three-way result. Export it through the existing runbook barrel. Run Step 1 again; expected PASS.

- [ ] **Step 3: Pin both transaction orderings and reset durability**

Write store/session integration tests for:

1. claim commits, then parent advances: the claim row becomes `status = 'superseded'` and the controlled child's `claim_generation` increments exactly once;
2. parent advances, then claim: `claimRunbook` returns `delegation-superseded` and inserts no active claim;
3. parent advances through `#driveTopLevel` without producing a `done` row: the same refusal occurs;
4. an actual machine RETRY/GOTO invokes `resetReopenedSubsteps`, preserves the delegation payload, and does not reactivate the old bearer; a newly issued token can be claimed;
5. refreshing `lastSeenAt` does not change claim status or generation;
6. two transaction-barrier orderings of claim versus parent commit always end with no active stale claim;
7. `RunbookStateManager.updateWithState` reaches the same invalidation path; and
8. `CompletionService.recordManualCompletion` writes `done` through `updateWithState`, tombstones the child claim in that same transaction, and increments the child's `claim_generation` exactly once.

Use the native and sql.js driver contract harness for the store-level cases. Do not hand-write a `pending` row as a substitute for the RETRY/GOTO test.

- [ ] **Step 4: Add one central post-state-write invalidation hook**

`invalidateClosedDelegatedClaims(parent)` selects active claims with `parent_run_id = parent.id`, parses their persisted delegation linkage at the repository edge, classifies each against `parent`, and performs one idempotent `UPDATE claims SET status = 'superseded' WHERE key = :key AND status = 'active'` for every `closed` result. A row whose persisted linkage is malformed is invalid state and aborts the transaction. The status UPDATE fires `claims_bump_gen_update` exactly once; no caller increments `claim_generation` directly.

Create one private repository hook, `afterAuthoritativeStateWrite(tx, next)`, that writes resolved completions and calls `invalidateClosedDelegatedClaims(next)`. Invoke that hook exactly once after a run UPDATE changes exactly one row in **all three** write implementations:

- `writeStateAtVersion`, used by `RunbookStore.mutateState` and therefore by `RunbookStateManager.update`, `updateWithState`, and `updateWithStateReturning`;
- `applyStateUpdate`, used by `saveState`; and
- `commitOwnedState`, after its exact owner UPDATE and before the attempt is marked committed.

Replace the existing direct `writeResolvedCompletions` calls at those three successful-write sites with the hook; do not call both. Never run the hook after a zero-row/stale/owned outcome. Do not put it in CLI lifecycle code. This central placement is required because `recordManualCompletion` persists through `manager.updateWithState` → `store.mutateState` → `writeStateAtVersion`, not through `saveState` or `commitOwnedState`.

- [ ] **Step 5: Make claim insertion fail closed in the same session transaction**

At the start of `claimRunbook`'s `mutate` callback, read `linkage.parentRunId` through `ctx.readState` and classify the exact linkage before existing-claim refresh or new insertion:

```typescript
const parent = ctx.readState(linkage.parentRunId);
const liveness = classifyDelegationLiveness(parent, {
  ...linkage,
  tokenHash: linkage.tokenHash,
});
if (liveness.kind === 'parent-unreadable') {
  throw new Error(
    `Parent run ${linkage.parentRunId} is missing while claiming delegation ${linkage.parentStepId}; the runbook database is inconsistent.`,
  );
}
if (liveness.kind === 'closed') {
  return {
    status: 'delegation-superseded',
    parentRunId: linkage.parentRunId,
    parentStepId: linkage.parentStepId,
    childRunId,
  };
}
```

This explicit throw is required. The existing missing-child integrity throw is nested under `existingForDelegation` and cannot catch a missing parent on the fresh-claim path.

- [ ] **Step 6: Map the typed refusal without inventing a child id**

Define free RD-825 as `ErrorCodes.DELEGATION_SUPERSEDED` and register CLI symbolic `DELEGATION_SUPERSEDED`. The broader name is deliberate: the durable latch also covers top-level cursor advance, not only a persisted `done` substep. Map `ClaimRunbookResult.status === 'delegation-superseded'` to pipeline reason `delegation-superseded`.

The common envelope details contract is:

```typescript
type DelegationSupersededDetails = {
  readonly parentRunId: RunId;
  readonly stepId: string;
  readonly childRunId?: RunId;
};
```

Existing-child and orphan-adoption paths include `childRunId`. The fresh prelaunch path omits it because no child has been created; no code may synthesize or predict one. Add envelope tests for both shapes. The message is:

> The parent has moved past this delegation. Do not retry this token; report the superseded delegation to the orchestrator.

- [ ] **Step 7: Keep the CLI pre-check diagnostic-only**

Immediately after the `!freshDelegation` bail, call the same classifier on `freshParent` and the token-validated linkage fields. Return `delegation-superseded` with `parentRunId` and `stepId`, omitting `childRunId`. Core Step 5 remains authoritative for replay, orphan, and post-launch races.

- [ ] **Step 8: Add operator documentation and a real scenario**

Use `rundown`, never `rd`, in the new runbook. Add a frontmatter scenario that advances the parent before claiming and expects `DELEGATION_SUPERSEDED`; add a second scenario proving a freshly re-issued token after RETRY is claimable. Update the CLI reference and both delegation skills with the exact remedy from Step 6.

Run the single scenario with its required file and case arguments:

```bash
rundown scenario run   runbooks/delegation/delegate-claim-superseded.runbook.md   claim-after-parent-advanced
```

Expected: PASS.

- [ ] **Step 9: Run affected tests, all scenario runbooks, and mutation testing**

```bash
pnpm --filter @rundown-org/core test --   __tests__/runbook/targeting.test.ts   __tests__/runbook/storage/runbook-store.test.ts   __tests__/runbook/session-service.test.ts   __tests__/runbook/completion-service.test.ts
pnpm --filter @rundown-org/cli test --   __tests__/helpers/claim-and-launch.test.ts   __tests__/commands/claim.test.ts
pnpm run build
pnpm run test:scenarios:raw
pnpm --filter @rundown-org/core run check:types
pnpm --filter @rundown-org/cli run check:types
pnpm --filter @rundown-org/core exec stryker run   --mutate src/runbook/targeting.ts   --mutate src/runbook/storage/runbook-store.ts   --mutate src/runbook/session-service.ts   --testFiles __tests__/runbook/targeting.test.ts   --testFiles __tests__/runbook/storage/runbook-store.test.ts   --testFiles __tests__/runbook/session-service.test.ts   --testFiles __tests__/runbook/completion-service.test.ts
```

Expected: all green; the Stryker instrumentation line reports non-zero source files and mutants. Clear a stale incremental report before trusting the score.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src packages/core/__tests__   packages/cli/src packages/cli/__tests__   packages/claude-code-plugin/skills   docs/reference/cli.md   runbooks/delegation/delegate-claim-superseded.runbook.md
git commit -m "fix(core): latch superseded delegation claims"
```

---

### Task R3: Enforce one active controlling claim per run

`resolveControllingClaim` (`runbook-store.ts:452-462`) selects `ORDER BY key LIMIT 1` from active claims, on a TSDoc-asserted invariant that nothing enforces. `key` is random hex, so selection is uncorrelated with issuance order or legitimacy; with two active claims it returns an arbitrary one and `captureRunAuthority` fences against the wrong claim silently.

Bump `SCHEMA_VERSION` rather than adding the index alone: an existing version-1 database would otherwise silently lack the constraint. `ensureSchema` already hard-rejects unknown versions with `IncompatibleSchemaError`, which is the required no-migration *behaviour* — but reaching that behaviour usefully **does require new code**, and Steps 8–10 below provide it.

**Which constant.** Two similarly named constants exist and only one moves. `SCHEMA_VERSION` (`storage/schema.ts:27`, currently `1`) is the **SQLite** schema version written to `PRAGMA user_version`; R3 takes it to **`2`**. `CURRENT_SCHEMA_VERSION` (`state.ts:50`, currently `1`) is the **Rundown persisted-state** schema version carried on `RunbookState.schemaVersion`; it **stays `1`** and is untouched by this task. Conflating them corrupts correct documentation — see the Task 10 amendment.

**Every developer and CI checkout loses its `.rundown/rundown.db` at R3.** The version bump is a hard reject, not a migration: any database created before this task becomes unopenable by any command, including read-only ones. That is the intended and correct no-migration behaviour, but it is a real cost that must be announced rather than discovered. Note it in the R3 commit body and in the branch's PR description.

**Files:**
- Modify: `packages/core/src/runbook/storage/schema.ts:27, 117-118` (index + `SCHEMA_VERSION` → `2`), and `:37-58` (`IncompatibleSchemaError`)
- Modify: `packages/core/src/runbook/storage/runbook-store.ts:433-462`
- Modify: `packages/core/src/errors/codes.ts` (new `ErrorCodes.INCOMPATIBLE_STATE_SCHEMA`)
- Modify: `packages/core/src/index.ts` and `packages/core/src/runbook/index.ts` (export `IncompatibleSchemaError`)
- Modify: `packages/cli/src/helpers/wrapper.ts:29-52` (`toRundownError` branch)
- Modify: `packages/core/__tests__/runbook/storage/runbook-store.test.ts`
- Modify: `packages/core/__tests__/runbook/storage/runbook-store.properties.test.ts`
- Modify: `packages/core/__tests__/runbook/storage/driver-contract.test.ts:252` — `expect(version).toBe(1)` is the **only hardcoded version literal in the tree and WILL fail at R3**. Update it to `2`.
- Modify: `packages/core/__tests__/runbook/storage/schema.test.ts:30` — title text only (`'installs schema version 1 with all six coordinated tables'`). Update the wording; no assertion changes.
- **Do not modify** `packages/core/__tests__/runbook/state-schema-version.test.ts`. It is entirely about the *Rundown* version and must keep asserting `1`.
- Test: `packages/cli/__tests__/` — new CLI test for the incompatible-schema envelope (Step 10)

**Interfaces:**
- Consumes: `SCHEMA_VERSION`, `ensureSchema`, `IncompatibleSchemaError` (`storage/schema.ts`).
- Produces: SQLite schema version `2`; `resolveControllingClaim` **throws a hard-inconsistency error on ambiguity** rather than returning an arbitrary row (Step 6). It does **not** return `null` on ambiguity — `null` already means "no active controlling claim" to its only consumer, and reusing it would report corruption as a routine refusal.
- Produces: `ErrorCodes.INCOMPATIBLE_STATE_SCHEMA` with the verified-free state code `RD-305`; `IncompatibleSchemaError` exported from `@rundown-org/core`.

**Production safety verified:** no path mints two active claims on one run today. `mintRunControlClaim` (`session-service.ts:355-386`) deletes any pre-existing claim for the run before inserting; `claimRunbook` early-returns `already-claimed`/`linkage-mismatch` rather than appending; delegated children launch with `sessionActivation: { kind: 'none' }` (`runbook-pipeline.ts:1669`) so they never hold a run-control claim alongside a bearer. The index is write-side enforcement of an invariant already checked read-side by `SessionDataSchema.superRefine` — not a new rule.

- [ ] **Step 1: Write the failing constraint test**

`insertActiveClaim` does not exist. The real helper is `async function mintClaim(runId: RunId, keyHex: string)` (`runbook-store.test.ts:65-73`), which goes through `txn.insertClaim(record, gen)` — `RunbookStoreTxn` exposes no raw SQL. Keys are `rdclk_` + **32 hex chars**, enforced by `assertClaimLookupKey`.

```typescript
it('rejects a second active claim on the same controlled run', async () => {
  const state = await newState();
  await store.createRun(state);
  await mintClaim(state.id, 'a'.repeat(32));
  await expect(mintClaim(state.id, 'b'.repeat(32))).rejects.toThrow(/UNIQUE/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd packages/core && pnpm test -- __tests__/runbook/storage/runbook-store.test.ts -t "second active claim"
```

Expected: FAIL — the second insert succeeds.

- [ ] **Step 3: Add the partial unique index and bump the schema version**

In `packages/core/src/runbook/storage/schema.ts`, after the existing claims indexes (line 118):

```sql
-- At most one active claim may control a run. `resolveControllingClaim` and
-- `captureRunAuthority` select the run's controller without a disambiguator;
-- without this constraint a second active row makes that selection arbitrary.
-- Superseded tombstones are unconstrained.
CREATE UNIQUE INDEX claims_one_active_per_run
  ON claims(controlled_run)
  WHERE status = 'active';
```

Change line 27:

```typescript
export const SCHEMA_VERSION = 2;
```

- [ ] **Step 4: Run and confirm the constraint holds**

```bash
cd packages/core && pnpm test -- __tests__/runbook/storage/runbook-store.test.ts
```

Expected: the new test PASSES. **`runbook-store.test.ts:290-300` ("refuses claim_superseded when the claim generation moved") will now fail** — it double-mints without tombstoning. Rewrite it to supersede the first claim before minting the second, which is what the production rotate path does. `:361-367` tombstones first and survives unchanged.

- [ ] **Step 5: Guard against a neighbouring test passing vacuously**

`runbook-store.test.ts:322-331` mints `'5'` then expects `mintClaim('6')` to reject with `/execution_in_progress/`. Under the new index that rejection could come from a UNIQUE violation instead of the trigger. SQLite fires `BEFORE INSERT` triggers ahead of index checks, so it likely still passes for the right reason — **but assert that explicitly** rather than assuming. Pin the rejection *message* to the trigger's `execution_in_progress`, so the test cannot silently start pinning the index.

- [ ] **Step 6: Make ambiguity distinguishable, not silent**

Belt-and-braces for any path that bypasses the index. Change `resolveControllingClaim` to `LIMIT 2` and replace the TSDoc invariant assertion with a reference to `claims_one_active_per_run`.

**Do not return `null` on two rows.** The only consumer, `captureRunAuthority` (`runbook-store.ts:618-635`), maps `null` to `{ kind: 'claim_superseded', message: 'Run … has no active controlling claim.' }` — so a corruption signal would surface as a false routine refusal, satisfying this plan's own ambiguity constraint in letter but not spirit. Throw the same hard-inconsistency error the codebase already uses for FK-violation states (`session-service.ts:712-718`), so the operator sees "two active claims", not "none".

- [ ] **Step 7: Add a property test over operation orderings**

The invariant is violated (or not) by *sequences* — rotate-then-supersede vs supersede-then-rotate, release/re-mint, prune. A two-insert example pins none of that, and no test exercises the rotate path under the new index. Add to `runbook-store.properties.test.ts`, alongside the existing `structural counter properties` block (`:114-143`):

> **Property:** for an arbitrary sequence of `mint | rotate | release | tombstone` against one run, `SELECT COUNT(*) FROM claims WHERE controlled_run = :id AND status = 'active'` is always ≤ 1, and `resolveControllingClaim` never returns a key whose row is not `active`.
> **Generator:** `fc.array(fc.constantFrom('mint','rotate','release','tombstone'), { minLength: 1, maxLength: 10 })`, replayed through the real store, tolerating typed refusals but never a UNIQUE violation on a legitimate production path.

- [ ] **Step 8: Make the schema-version rejection reachable, typed, and actionable**

The bump is worthless as a safety mechanism if the resulting failure is indistinguishable from a crash. Today it is exactly that:

- `IncompatibleSchemaError` (`schema.ts:37-58`) extends `Error`, **not** `RundownError`.
- It is exported from **neither** `packages/core/src/index.ts` nor `packages/core/src/runbook/index.ts`, so the CLI cannot catch it by type.
- `toRundownError` (`packages/cli/src/helpers/wrapper.ts:29-52`) has no branch for it. It falls through the `RundownError` / `isNodeError` / `RunbookSyntaxError` checks to `Errors.unknown` (`factory.ts:167`) → **`RD-999` / "An unexpected error occurred."**
- `ensureSchema` runs inside `openRunbookDriver` (`driver-factory.ts:117-125`) on **every** store open, so read-only commands fail too — `status`, `ls`, `check`.

Do all four:

1. Define `ErrorCodes.INCOMPATIBLE_STATE_SCHEMA` in `packages/core/src/errors/codes.ts`, in the same object shape as its neighbours (`code`, `category`, `title`, `description`, `docSlug`), with `code: 'RD-305'` and `category: ErrorCategory.STATE`. `RD-305` is unused in the current registry.
2. Export `IncompatibleSchemaError` from `packages/core/src/runbook/index.ts` and `packages/core/src/index.ts`.
3. Add a branch to `toRundownError` mapping it to the new code, ahead of the generic wrap. Keep `foundVersion` / `expectedVersion` on the envelope details.
4. Do **not** register a symbolic alias. `RundownErrorCodeValues` is derived from `ErrorCodes`, so adding `RD-305` to `ErrorCodes` automatically admits the envelope code. `CLISymbolicErrorCodeValues` is only for command-specific symbolic envelopes that do not flow through `RundownError`.

- [ ] **Step 9: Rewrite the error message to name a remedy that actually works**

The current message (`schema.ts:50-54`) ends *"finish, stop, or prune the active runs and restart from source."* **All three of those commands open the store and throw this same error.** The recovery instruction is circular — it directs the operator into the failure they are already in.

The real remedy is deleting the database. Rewrite the message to say so plainly, naming the path:

> Incompatible runbook database schema: found version N, expected M. Rundown never migrates persisted state. Any in-flight runs in this database are unrecoverable — delete `.rundown/rundown.db` and restart your runbooks from source.

Keep `foundVersion` and `expectedVersion` as fields. Do not soften "unrecoverable": there is no path that reads a version-1 database after R3, and implying otherwise invites someone to write one.

- [ ] **Step 10: Add a CLI test asserting the code and the actionability**

Create a database with `PRAGMA user_version = 1`, run a command against it, and assert on **default JSON output**: the envelope carries `RD-305` (not `RD-999` and not the symbolic key `INCOMPATIBLE_STATE_SCHEMA`), `details.category === 'STATE'`, `details.context` retains `foundVersion` and `expectedVersion`, and the message names `.rundown/rundown.db`. Assert the same for a read-only command such as `status`, since `ensureSchema` runs on every open — the read-only case is the one an operator hits first and the one most likely to be mistaken for a bug.

- [ ] **Step 11: Run the storage suite, mutation pass, and type check**

```bash
cd packages/core && pnpm test -- __tests__/runbook/storage/
pnpm --filter @rundown-org/core run check:types
pnpm --filter @rundown-org/core exec stryker run \
  --mutate src/runbook/storage/runbook-store.ts \
  --testFiles __tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/storage/runbook-store.properties.test.ts
```

`runbook-store.properties.test.ts` is **required** in `--testFiles`: Step 7 adds the ordering property to that file specifically to pin this invariant, and omitting it means the property never runs against a mutant. Confirm the mutation score covers `resolveControllingClaim`.

Package-relative paths only — `exec` runs with cwd = the package dir, and a repo-relative path matches nothing while **exiting 0**, producing a gate that cannot fail. **Check the `Instrumented N source file(s) with M mutant(s)` line reports non-zero before trusting any score**, and clear a stale `reports/stryker-incremental.json` first — with `incremental: true` it can print a plausible aggregate over a zero-mutant run.

(The partial index's `WHERE status = 'active'` clause lives in `schema.ts`, which is **not** in `--mutate` here. It is pinned by Step 1's example test and Step 7's property, not by this mutation pass.)

- [ ] **Step 12: Commit**

```bash
git add packages/core/src packages/core/__tests__ packages/cli/src packages/cli/__tests__
git commit -m "fix(core): enforce one active controlling claim per run"
```

Record in the commit body that `SCHEMA_VERSION` moves to `2` and every existing `.rundown/rundown.db` — including every developer's and CI's — becomes unopenable and must be deleted.

---

### Task R4: Restore dropped refusal coverage and re-decide the deleted branches

Two related regressions, both resting on the FK premise R1 corrects.

**Files:**
- Modify: `packages/cli/__tests__/commands/claim.test.ts`
- Modify: `packages/cli/src/commands/claim.ts:106`
- Modify: `packages/core/src/runbook/session-service.ts:585-596, 709-719, 1172-1183`
- Modify: `packages/core/src/runbook/command-target-resolver.ts`
- Modify: `packages/cli/src/commands/pop.ts`
- Modify: `packages/core/__tests__/runbook/command-target-resolver.test.ts`

- [ ] **Step 1: Re-pin the end-to-end `CHILD_LINKAGE_MISMATCH` refusal**

Deleted with `runbooks/delegation/delegate-claim-corruption.runbook.md` in `e5f0b2154` and never rehomed; nothing in the tree asserts the code today. Mirror the `CHILD_RUN_MISSING` pin at `claim.test.ts:905-941`, using `patchPersistedRunState` to corrupt `parentLinkage.tokenHash`, and assert default JSON output carries `CHILD_LINKAGE_MISMATCH`.

**Record the scenario-level decision explicitly.** This rehoming moves the behaviour from the scenario level to the CLI-test level and does not restore it at the scenario level. That is defensible — the deleted scenario's `node -e` read `.rundown/session.json` and `.rundown/runs/*.json`, both genuinely dead post-cutover, and `FAULT_INJECTION_ALLOWLIST` (`scenario-authoring.test.ts:70-76`) is matched by set equality so a restoration needs a new entry with a ≥40-char reason. But the Global Constraints reproduce "Scenario coverage is a required test level" verbatim, and silently dropping a level is exactly how the original regression happened.

Record the reasoned exception in the commit body: scenario coverage is unavailable for this corruption-only behaviour because no public command can create it and scenarios must not read or mutate the SQLite database. Pin it at the CLI integration layer with `patchPersistedRunState`; do not add SQL, a DB-aware command, or a database fault injector to a runbook.

- [ ] **Step 2: Fix the stale operator guidance**

`packages/cli/src/commands/claim.ts:106` tells the user to inspect `.rundown/runs/${childRunId}.json`, which no longer exists. Point at the recovery/prune commands instead.

- [ ] **Step 3: Restore the three typed refusals**

`claimRunbook` (`session-service.ts:585-596`), `getActiveForClaimId` (`:709-719`), and `unstashForClaimId` (`:1172-1183`) were converted from typed refusals to thrown `Error`s on the FK-cascade "unreachable" argument. With R1 landed the premise holds on both drivers — but the superseded plan's § Task 6 requires the exact caller-visible refusal taxonomy. Restore `missing-child` for claim/unstash, `stale` for claim-id resolution, the corresponding `UnstashForClaimIdResult` arm (`session-service.ts:158`), and the deleted test *"returns stale for a claim whose child state is missing"*.

- [ ] **Step 4: Restore the resolution branches**

Restore `case 'stale'` in `command-target-resolver.ts` and `case 'missing-child'` in `pop.ts`, plus the two deleted test table rows (`command-target-resolver.test.ts:290-294, 618-623`). These are the typed handlers for the statuses Step 3 restores; without them the union is handled inconsistently — `missing-child` is still produced at `session-service.ts:624` and handled at `runbook-pipeline.ts:1206`.

- [ ] **Step 5: Run the affected suites**

```bash
cd packages/core && pnpm test -- __tests__/runbook/session-service.test.ts __tests__/runbook/command-target-resolver.test.ts
cd ../cli && pnpm test -- __tests__/commands/claim.test.ts __tests__/commands/pop.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/core packages/cli
git commit -m "fix(core): restore typed claim refusals and linkage-mismatch coverage"
```

---

### Task R5: Give the cross-process race tests a contention witness

The tests are genuine — a lossy `pushRunbook` loses 4 of 5 pushes and a lossy shared `mutate` fails all five properties. Two quality gaps remain.

**Files:**
- Modify: `packages/core/__tests__/runbook/storage/fixtures/session-writer-child.ts:96`
- Modify: `packages/core/__tests__/runbook/session-service.process.test.ts:36-37`

- [ ] **Step 1: Emit timing from the child fixture, on both arms**

The fixture's function is `run(service)`, not `runMutation()`. Emit timing from the **`catch` branch too** — a child that legitimately throws otherwise yields no timestamps, and `BigInt(undefined)` would throw inside the witness, converting a real signal into an unrelated crash.

Use an epoch-based clock, not `process.hrtime.bigint()`. Node documents hrtime as relative to "an arbitrary time in the past"; cross-process comparability is not part of its contract. It happens to map to a machine-global monotonic clock on Linux and macOS, but that is precisely the undocumented dependency this branch was already caught relying on elsewhere (`ASTRO_DEV_BACKGROUND`).

```typescript
const t0 = performance.timeOrigin + performance.now();
// … run(service) …
const t1 = performance.timeOrigin + performance.now();
```

- [ ] **Step 2: Widen `ChildResult` and assert overlap**

`ChildResult` (`session-service.process.test.ts:64-67`) is `{ ok: true; value } | { ok: false; error }` — it has no timing fields, so the helper must widen it and narrow before access:

```typescript
type ChildResult =
  | { readonly ok: true; readonly value: unknown; readonly t0: number; readonly t1: number; readonly pid: number }
  | { readonly ok: false; readonly error: string; readonly t0: number; readonly t1: number; readonly pid: number };

/**
 * Assert at least two children's mutation attempts were concurrently in flight.
 *
 * @param results - Child outcomes collected from the race.
 * @throws {Error} Via `expect` when no interval pair overlaps — the race
 *   degenerated to serial execution and proves no concurrency property.
 */
function expectOverlap(results: readonly ChildResult[]): void {
  const overlapping = results.some((a, i) =>
    results.some((b, j) => i !== j && a.t0 < b.t1 && b.t0 < a.t1),
  );
  expect(overlapping).toBe(true);
}
```

Call it in all five properties. Measured overlap is reliable — 10/10 instrumented trials overlapped — so this will not flake.

**Scope note:** overlap proves the mutation attempts *raced*. It does not and cannot prove that SQLite's exclusive critical sections overlapped; single-writer critical sections are serialized by construction. It also does not prove the interleaving was one that *exposes* a lost update. These are distinct properties, and the audit's measured 3% miss was the latter. Step 3 addresses that; do not treat this step as closing it.

- [ ] **Step 3: Widen property 4 and specify its cohort**

Property 4 (`:270-295`) races exactly 2 children where properties 1/3 race 5 and property 2 races 4, and under a completely broken implementation it reported green 1 run in 30. "Raise to 4" is under-specified because the property is asymmetric (1 `recordClaimSeen` + 1 `pushRunbook`) and its assertions destructure `const [seen] = values(results)` (`:288`).

Specify: **1 `recordClaimSeen` + 3 `pushRunbook`**, asserting all three pushes survive **and** `lastSeenAt` survives. Rewrite the destructuring accordingly.

- [ ] **Step 4: Correct the false timing claim where it actually lives**

The "sub-millisecond" claim is **not** in `session-service.process.test.ts`. Grepping the tree returns one unrelated hit (`file-lock.test.ts:190`); the comment at `:33-38` reads *"There are no timing assumptions in any assertion…"*, which is accurate and needs no edit. The phrase appears only in commit `b9e23b561`'s body, which is immutable history.

So there is no file to correct. If the measured figure is worth recording, add it as a **new** comment near the barrier setup — median 4.7 ms, max 82 ms across 10 instrumented trials — rather than "replacing" text that isn't there.

- [ ] **Step 5: Verify sensitivity with adequate statistical power**

Patch `pushRunbook` to a lossy read-modify-write and confirm the tests fail.

**20 runs cannot validate a fix for a measured 1-in-30 miss** — at that residual rate, 20 clean runs occur ~50% of the time, so the verification would declare success on a still-broken test as often as not. Run **≥100 iterations under the lossy `mutate` patch**, targeting 100/100 detection on every property — the same protocol the audit used to find the defect.

```bash
cd packages/core && pnpm test -- __tests__/runbook/session-service.process.test.ts
```

Then revert the mutation and confirm `git status` is clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/__tests__/runbook
git commit -m "test(core): assert genuine contention in cross-process race tests"
```

---

### Task R6: Finish state-only session mutation ownership refusals

**Depends on R1, R3, and R4.** R1 supplies adapter parity, R3 constrains active claim writes, and R4 restores the domain refusal variants that become values inside the common mutation result.

The result design is decided here. Every ownership-sensitive session mutation returns one outer discriminated union; domain-specific results are values of the committed arm. No widened method retains `null` as an ownership signal, and no caller catches raw SQLite text.

```typescript
export type SessionMutationResult<T> =
  | { readonly status: 'committed'; readonly value: T }
  | {
      readonly status: 'execution-in-progress';
      readonly runId: RunId;
      readonly message: string;
    }
  | {
      readonly status: 'recovery-required';
      readonly runId: RunId;
      readonly epoch: ExecutionEpoch;
      readonly message: string;
    };
```

For a multi-run mutation, preflight run ids in caller-supplied order and return the first refusal. This makes `runId` deterministic while the transaction remains all-or-none. Existing domain unions such as `ClaimRunbookResult`, `ReleaseRunbookResult`, and `UnstashForClaimIdResult` are not flattened into this outer union.

`recordClaimSeen` is explicitly exempt: `last_seen_at` and `updated_at` are excluded from `claims_guard_update` and `claims_bump_gen_update`, and its documented total/best-effort contract must remain intact. `resetForPruneAll` is also exempt because it is the explicit invalid-state recovery operation and must remain usable to clear targeting state. Pure stack-only `pushRunbook` remains `Promise<void>`; it touches no claim/stash guarded row. Every other method below is widened.

**Files:**

- Modify: `packages/core/src/runbook/session-service.ts`
- Modify: `packages/core/src/runbook/storage/runbook-store.ts`
- Modify: `packages/core/src/runbook/index.ts`
- Modify callers: `packages/core/src/runbook/collection-service.ts`
- Modify callers: `packages/core/src/runbook/inline-parent-advance.ts`
- Modify callers: `packages/core/src/runbook/lifecycle-command-service.ts`
- Modify callers: `packages/cli/src/commands/pop.ts`
- Modify callers: `packages/cli/src/commands/prune.ts`
- Modify callers: `packages/cli/src/commands/stash.ts`
- Modify callers: `packages/cli/src/helpers/active-runbook-cleanup.ts`
- Modify callers: `packages/cli/src/helpers/runbook-pipeline.ts`
- Modify callers: `packages/cli/src/helpers/transition-orchestrator.ts`
- Modify callers: `packages/cli/src/services/execution.ts`
- Test: `packages/core/__tests__/runbook/session-service.test.ts`
- Test: affected collection, inline-parent, and lifecycle service tests
- Test: affected CLI command, pipeline, transition, cleanup, and execution tests
- Test: `packages/core/__tests__/runbook/storage/driver-contract.test.ts`
- Test: `packages/core/__tests__/runbook/storage/runbook-store.properties.test.ts`

**Methods widened in one commit:**

- `issueRunControlClaim`
- `pushRunbookWithRunControlClaim`
- `claimRunbook`
- `releaseRunbook`
- `releaseRunbooks`
- `pruneClaimsForChildren`
- `popRunbook`
- `stash`
- `stashRunbook`
- `unstashForClaimId`
- `unstash`

The production caller inventory above is from the current tree. Re-run the following search immediately before implementation and add any newly landed caller to the same commit:

```bash
rg -n 'sessionService\.(issueRunControlClaim|pushRunbookWithRunControlClaim|claimRunbook|releaseRunbook|releaseRunbooks|pruneClaimsForChildren|popRunbook|stash|stashRunbook|unstashForClaimId|unstash)\('   packages/core/src packages/cli/src
```

- [ ] **Step 1: Write red contract and caller-exhaustiveness tests**

For each widened method, test a committed domain value, `execution-in-progress`, and `recovery-required`. For multi-run release/prune, assert the first refused input run is returned and no row changes. Add compile-time/exhaustive switches at every production caller; a refusal must never be consumed as `null`, ignored after `await`, or rendered by synthesizing a new reason.

- [ ] **Step 2: Add the ambient-transaction recovery read**

Add `RunbookStoreTxn.pendingRecovery(runId): { epoch: ExecutionEpoch } | null`, issuing the existing `execution_attempts WHERE run_id = :runId AND phase = 'recovery_pending'` query on `txn.tx`. Do not call `RunbookStore.readPendingRecovery` from inside a transaction because it opens a separate driver read.

Preflight each affected run before changing `ctx.session`. A hit returns `recovery-required`; otherwise perform the mutation. The trigger catch can produce only `execution-in-progress`: `commitRecovery` clears `exec_token`, so a committed recovery cannot fire an ownership trigger.

- [ ] **Step 3: Normalize trigger aborts at the repository boundary**

Both drivers expose `error.message === 'execution_in_progress'`; only node:sqlite additionally provides `ERR_SQLITE_ERROR`. Pin both shapes in `driver-contract.test.ts`, classify by exact message, and return `execution-in-progress` with the affected run id. Re-throw every other error. Do not parse a message to infer `recovery-required`.

- [ ] **Step 4: Convert all methods and callers together**

Wrap every successful legacy value in `{ status: 'committed', value }`. Convert core orchestration callers first, then CLI renderers. Core callers propagate the refusal as a typed lifecycle/command outcome; CLI callers render the existing symbolic `execution_in_progress` or `recovery_required` contract with redacted claim identifiers. No frontend may retry inside SQLite.

Keep these special meanings inside the committed value:

- `RunId | null` for empty stack/stash;
- `ClaimLookupKey[]` for pruned keys;
- the existing claim/release/unstash domain unions.

- [ ] **Step 5: Add the missing CAS property**

Add the CAS-zero-row property over arbitrary stale `state_version` and `claim_generation`: after classification succeeds, a zero-row authoritative update always aborts and rolls back the whole transaction. The parent-linkage property belongs to R8 and must not be placed here before its mechanism exists.

- [ ] **Step 6: Re-run preserved-invariant suites**

Re-run tests for `applyOp`, trusted artifact/completion validation, `patchSnapshotSubstepStates`, active frame derivation, and `JsonArrayStream` stripping. Diff their production bodies against `63077ea8f`; this task must not alter them.

- [ ] **Step 7: Verify core and CLI surfaces**

```bash
pnpm --filter @rundown-org/core test -- __tests__/runbook/
pnpm --filter @rundown-org/cli test --   __tests__/commands/pop.test.ts   __tests__/commands/prune.test.ts   __tests__/commands/stash.test.ts   __tests__/helpers/claim-and-launch.test.ts
pnpm --filter @rundown-org/core run check:types
pnpm --filter @rundown-org/cli run check:types
```

Expected: all green and every widened result switch is exhaustive.

- [ ] **Step 8: Commit all signature and caller changes together**

```bash
git add packages/core/src packages/core/__tests__   packages/cli/src packages/cli/__tests__
git commit -m "fix(core): type session ownership refusals"
```

---

### Task R7: Correct comments that are affirmatively wrong

Scoped tightly: **only** statements that assert something false about current behaviour. Cosmetic staleness stays with Task 9 (its verbatim body below), and the ~15 stale `SessionLock` mentions are **not** in scope here — they were raised with the user and no direction was given.

**Files:**
- Modify: `packages/core/src/runbook/collection-service.ts:468-469`
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts:2392-2431`
- Modify: `packages/core/src/runbook/state.ts:291, 716, 799-802`
- Modify: `CLAUDE.md:112-115`

- [ ] **Step 1: Fix the false lock-acquisition claim**

`collection-service.ts:468-469` states `recordClaimSeen` "self-acquires the session lock, which is not reentrant". It calls `this.mutate(...)` → `manager.mutateSession(work)` — a SQLite transaction, no lock. Restate in terms of the transaction, preserving whatever non-reentrancy conclusion still holds.

- [ ] **Step 2: Correct the half-dismantled lock rank**

`lifecycle-command-service.ts:2392-2431` presents an ABBA proof citing a `SessionLock → CompletionLock` edge that no longer exists, while `CompletionLock` and `DelegationLock` remain live. This block is the stated justification for `guardOpenChildren === false` on the explicit-target path, so it must describe the real remaining rank.

- [ ] **Step 3: Fix the JSON-persistence assertions**

`state.ts:291` still says "State is persisted to `.rundown/runs/` as JSON files"; `state.ts:716` carries a matching stale TSDoc; `loadSession`'s `@throws` at `state.ts:799-802` documents a #519 legacy-format throw that can no longer occur.

- [ ] **Step 4: Fix the normative project instruction**

`CLAUDE.md:112-115` documents `RunbookStateManager.withRunStateLock` as the live `RunStateLockLike` consumer. That method no longer exists in any source file. This is normative instruction, not a comment — correct it now rather than at Task 10.

- [ ] **Step 5: Verify no behavioural change**

```bash
pnpm run lint && pnpm run check:types
```

- [ ] **Step 6: Commit**

```bash
git add packages/core CLAUDE.md
git commit -m "docs(core): correct comments contradicting current behaviour"
```

---

### Task R8: Make initial claim/link atomic and remove vacuous linkage versioning

**Depends on R2, R3, and R6.** R2 supplies live-delegation validation and the central post-state-write invalidation hook; R3 supplies one-active-controller enforcement and SQLite schema version 2; R6 supplies the common session mutation refusal wrapper.

**Verified premise.** The product has no A→B relink operation. `claimAndLaunch` returns from the `freshDelegation.childRunId` branch before `updateStepDelegationChildRunId`; RETRY cancels/reissues a fresh token rather than replacing the child under one live token. The helper at `runbook-pipeline.ts:1132-1154` only establishes an initial/adopted child link or clears that link during rollback. Therefore `parent_linkage_version` can never legitimately advance, and retaining it solely to make its CAS branch non-vacuous would invent unsupported behavior.

The real defect is the split initial claim/link sequence. R8 moves that sequence into core and removes the unused counter, column, and comparison. Parent terminalization and token reissue invalidate the old claim through R2's single status UPDATE, producing exactly one child-generation bump.

**Files:**

- Modify: `packages/core/src/runbook/storage/schema.ts` (remove `claims.parent_linkage_version`; `SCHEMA_VERSION` 2 → 3)
- Modify: `packages/core/src/runbook/storage/mutation-result.ts` (remove `LinkageVersion` and the captured parent counter)
- Modify: `packages/core/src/runbook/storage/runbook-store.ts` (remove linkage-version row/query/classifier fields; add atomic initial link)
- Modify: `packages/core/src/runbook/session-service.ts`
- Modify: `packages/core/src/runbook/claim-id.ts`
- Modify: `packages/cli/src/helpers/runbook-pipeline.ts` (delete `updateStepDelegationChildRunId`)
- Modify: `packages/core/__tests__/runbook/storage/driver-contract.test.ts` (SQLite version 3)
- Modify: `packages/core/__tests__/runbook/storage/runbook-store.test.ts`
- Modify: `packages/core/__tests__/runbook/storage/runbook-store.properties.test.ts`
- Modify: `packages/core/__tests__/runbook/session-service.test.ts`
- Modify: `packages/cli/__tests__/helpers/claim-and-launch.test.ts`

**Interfaces:**

```typescript
export interface ClaimAndInitialLinkInput {
  readonly childRunId: RunId;
  readonly linkage: DelegationLinkage;
}

export type ClaimAndInitialLinkResult =
  | ClaimRunbookResult
  | {
      readonly status: 'parent-concurrent-modification';
      readonly parentRunId: RunId;
      readonly message: string;
    };

export class SessionService {
  claimAndInitialLink(
    input: ClaimAndInitialLinkInput,
  ): Promise<SessionMutationResult<ClaimAndInitialLinkResult>>;

  rollbackInitialLink(
    input: ClaimAndInitialLinkInput,
  ): Promise<SessionMutationResult<{ readonly status: 'rolled-back' | 'already-absent' }>>;
}
```

`claimAndInitialLink` is valid only while the matching parent delegation has `childRunId === null`. Inside one immediate transaction it:

1. reads and validates the parent, child, exact token, frame, entry, and R2 liveness;
2. refuses an already-linked parent as the existing replay/domain outcome rather than overwriting it;
3. inserts the child's controlling claim;
4. rewrites only that matching parent delegation's `childRunId` under the observed parent `state_version`;
5. calls R2's `afterAuthoritativeStateWrite` once for the successful parent UPDATE; and
6. commits all writes or none.

The already-linked replay branch continues to call ordinary `claimRunbook`; it never rewrites the parent. Orphan adoption and fresh-child `afterCreate` use `claimAndInitialLink`. `rollbackInitialLink` clears the link only when both token and child id still match and tombstones the just-created claim in the same transaction; a later/different link is left untouched.

- [ ] **Step 1: Write red atomic-initial-link tests**

Pin all three relevant histories:

- fresh child: claim row and parent `childRunId` appear together;
- orphan adoption: the existing child is claimed and linked together;
- injected failure after claim insertion or on the parent state-version CAS: neither active claim nor parent link commits.

Add replay coverage proving an existing `childRunId` returns through `claimRunbook` without invoking the initial-link writer. Add rollback coverage proving it cannot clear a newer token/child link.

- [ ] **Step 2: Remove the unsupported linkage counter**

Delete `LinkageVersion`, `assertLinkageVersion`, `claims.parent_linkage_version`, its insert/update bindings, `CommitRow.parentLinkageVersion`, and the comparison from `classifyCommitRow`. Parent validity remains:

- claim row exists and is active;
- controlled child generation matches capture;
- persisted parent id matches;
- parent exists and is non-terminal; and
- R2 has not tombstoned the claim after cursor advance, completion, cancellation, or token reissue.

Because this changes the SQLite schema, bump `SCHEMA_VERSION` from 2 to 3 and update the driver-contract version assertion. Apply the same hard-rejection/no-migration announcement and `RD-305` behavior established in R3.

- [ ] **Step 3: Add the core transaction and remove the CLI shadow write**

Implement `claimAndInitialLink` and `rollbackInitialLink` in the repository/session seam. Assert exactly one parent UPDATE; a zero-row CAS rolls back claim insertion, session reconciliation, and link mutation. Route only orphan adoption and fresh-child creation through the new method. Delete `updateStepDelegationChildRunId`; the CLI must not reconstruct or patch `SubstepState`.

- [ ] **Step 4: Pin exactly-once invalidation separately**

Using a real RETRY/token-reissue state update, assert R2's central hook changes the old claim from active to superseded in one SQL UPDATE and the old child's `claim_generation` advances exactly once. Then claim/link the newly issued token and assert its claim remains active. Add a separate parent-terminal test with the same exactly-one bump. Neither test mentions or expects a linkage-version counter.

- [ ] **Step 5: Add structural properties**

Add properties that:

- claim insertion and initial parent linking are all-or-none under arbitrary injected CAS failure;
- repeating the same initial-link request is idempotent and does not bump generation;
- a different child cannot replace an existing live link;
- arbitrary token reissues tombstone each old claim once and leave only the newest successfully claimed token active;
- unrelated parent writes and `lastSeenAt` refreshes do not bump child generation; and
- terminalization uses the same one-status-UPDATE invalidation path.

Run the storage properties against native and sql.js adapters.

- [ ] **Step 6: Verify and mutate the actual paths**

```bash
pnpm --filter @rundown-org/core test -- \
  __tests__/runbook/storage/driver-contract.test.ts \
  __tests__/runbook/storage/runbook-store.test.ts \
  __tests__/runbook/storage/runbook-store.properties.test.ts \
  __tests__/runbook/session-service.test.ts
pnpm --filter @rundown-org/cli test -- \
  __tests__/helpers/claim-and-launch.test.ts
pnpm --filter @rundown-org/core run check:types
pnpm --filter @rundown-org/cli run check:types
pnpm --filter @rundown-org/core exec stryker run \
  --mutate src/runbook/storage/runbook-store.ts \
  --mutate src/runbook/session-service.ts \
  --testFiles __tests__/runbook/storage/runbook-store.test.ts \
  --testFiles __tests__/runbook/storage/runbook-store.properties.test.ts \
  --testFiles __tests__/runbook/session-service.test.ts
```

Expected: all green and non-zero Stryker instrumentation.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src packages/core/__tests__ \
  packages/cli/src packages/cli/__tests__
git commit -m "fix(core): make delegated claim and initial link atomic"
```

---

## Carried-forward Tasks 7–10

### Task 7: Migrate simple effectful commands as the vertical slice

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts`
- Modify: `packages/core/src/runbook/execution-lifecycle-service.ts`
- Modify: `packages/cli/src/helpers/transitions.ts`
- Modify: `packages/cli/src/helpers/goto-workflow.ts`
- Modify: `packages/cli/src/helpers/terminal-command.ts`
- Modify: `packages/cli/__tests__/commands/pass.test.ts`
- Modify: `packages/cli/__tests__/commands/fail.test.ts`
- Modify: `packages/cli/__tests__/commands/goto.test.ts`
- Modify: `packages/cli/__tests__/commands/complete.test.ts`
- Modify: `packages/cli/__tests__/commands/stop.test.ts`
- Create: `packages/cli/__tests__/scenarios/execution-recovery.scenario.md` (frontmatter scenario for the single-process recovery UX)

- [ ] Start with one end-to-end `pass` fixture whose transition enters a shell-command step. Race a second process (using the Task 3 deterministic interleaving barrier, not a sleep) and prove one effect, one committed state transition, and an `execution_in_progress` loser.
- [ ] Pin the fail-closed guarantee end-to-end at three of the six crash boundaries through the real CLI, not only at the core layer: (a) kill-after-`claimed`/pre-effect must reclaim-and-retry so the effect runs exactly once; (b) kill-after-`effect_started`/before-commit must surface `recovery_required` and a repeated bare/claim command must NOT re-run the effect; (c) kill-after-commit/clear must not re-run the effect. Assert default JSON output for (b) is `recovery_required`.
- [ ] Route capture, acquire, effect boundary, compute, and guarded commit through `EffectfulMutationExecutor`. Frontends call one typed core API and only render its discriminated result.
- [ ] **Key the migrated claim-activity recording off the captured authority, not a re-introduced caller field (#613).** `runTransition`'s recording (`recordClaimSeen`) must derive from the single `CapturedAuthority.claimKey`; assert with a red test that the caller/target claim split does not reappear once recording moves into the transactional commit.
- [ ] Convert fail, goto, complete, and stop through the same core primitive. Keep command-specific policy/result mapping typed; do not branch on raw action strings in the frontend.
- [ ] Cover JSON and text rendering separately, including immediate `execution_in_progress` and `recovery_required` with redacted claim identifiers. If an explicit wait option is included, test its finite budget, backoff, cancellation, and progress diagnostics separately; never wait inside SQLite.
- [ ] Add a scenario (frontmatter `scenarios:` and/or a scenario-suite entry) covering the single-process recovery UX: an interrupted execution injected via the scenario fault-injection allowlist (`docs/internal/scenarios.md`), asserting `recovery_required` output and a reconcile/retry/stop transition leaving the state. Scenarios run in-process/sequentially and do not replace the two-process Jest races above.
- [ ] Run focused core and CLI command suites, the new scenario, plus core/CLI type checks.
- [ ] Commit: `feat(core): route lifecycle commands through execution fencing`.

### Task 8: Migrate multi-record workflows and remove lock-domain twins

**Files:**
- Modify: `packages/core/src/runbook/completion-service.ts`
- Modify: `packages/core/src/runbook/collection-service.ts`
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts`
- Modify: `packages/core/src/runbook/abort-command-service.ts`
- Modify: `packages/core/src/runbook/inline-parent-advance.ts` (#603: return the linkage-cycle trip instead of the `OnLinkageCycle` sink)
- Modify: `packages/core/src/runbook/index.ts` (re-exports the propagation seam types)
- Modify: `packages/cli/src/helpers/delegation-completion.ts` (`buildLinkageCycleDiagnostic` — CLI adapter for the returned trip)
- Modify: `packages/cli/src/commands/delegate.ts`
- Modify: `packages/cli/src/commands/collect.ts`
- Modify: `packages/cli/src/commands/abort.ts`
- Modify: `packages/cli/src/services/execution.ts`
- Modify: `packages/cli/src/helpers/runbook-pipeline.ts`
- Modify: `packages/core/__tests__/runbook/completion-service.test.ts`
- Modify: `packages/core/__tests__/runbook/collection-service.test.ts`
- Modify: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`
- Modify: `packages/core/__tests__/runbook/inline-propagation-guard.properties.test.ts` (migrate `fire-iff-cycle` to the returned-trip shape — do not delete)
- Modify: `packages/cli/__tests__/commands/delegate.test.ts`
- Modify: `packages/cli/__tests__/commands/collect.test.ts`
- Modify: `packages/cli/__tests__/commands/abort.test.ts`

- [ ] Write failure-injection tests proving delegate retry's supersede/child release/issued-substep persistence is all-or-none and collect's target-run multi-completion drain/advance commits once.
- [ ] Write overlapping multi-run races for operations that genuinely own multiple affected runs and assert no partial lease ownership or partial domain writes remain after refusal/crash. Do not lease completed child runs merely because collect consumes reports already stored on the target.
- [ ] Move expensive `createDelegation`, child resolution, variable preparation, and helper/filesystem work outside transactions; pass only validated results into the final SQL commit.
- [ ] Replace completion and collection lock-held twins with transaction-local repository functions callable only from the owning aggregate operation. **Carry the domain bodies over verbatim** — `resolveAgainstCurrentCursor` cursor validation/branding, `buildCompletionKey` exact/sentinel fallback, `projectDelegationTerminalOutcome`, the must-not-split atomic `resolvedCompletions`+`substepStates` write, the collection authority/policy gate ordering (`resolveMutationAuthority → verifiedClaimContext → resolveCommandIntent`), readiness (live completion row OR `substepState.status === 'done'`), terminal reload→release→propagate ordering, and `#revalidatePresentedClaim` (#586/#608). Replace `runGuardedParentAdvance`'s split TOCTOU check with the transaction-local open-child recheck described in the Task 8 amendment below. If collect terminalizes its target, include session release and linked-child invalidation in that transaction; report the committed outcome to its own parent in a separate idempotent parent transaction.
- [ ] Route abort through core mutation APIs; remove CLI ownership of DelegationLock and direct state mutation.
- [ ] **Fold #603 into this rewrite:** convert `propagateTerminalChildUpward` to return the `LinkageCycleTrip` on a `{ kind: 'linkage-cycle'; trip }` arm; delete `OnLinkageCycle`, the `collection-service.ts` `onLinkageCycle` deps field, and its stub sites; move `buildLinkageCycleDiagnostic` into the CLI adapter over the returned trip; migrate the `inline-propagation-guard.properties.test.ts` `fire-iff-cycle` property to assert the returned trip rather than sink-call count. Preserve the byte-identical `INLINE_PARENT_CYCLE` envelope.
- [ ] **Preserve #617 terminal-cleanup gate:** the `#driveTerminalBare` already-terminal release path runs `releaseRunbooks` only when `callerEvidence.kind !== 'claim_bearer' || presenterAuthorized`; a refused bearer must not gain teardown a bare caller is denied. Carry this authorization gate through the terminal-path rewrite verbatim.
- [ ] **Preserve #602 inline cycle/depth guard:** the `propagateTerminalChildUpward` visited-set back-edge check, `MAX_INLINE_PROPAGATION_CHAIN` depth cap, and `'linkage-cycle'` severity-precedence collapse survive the collection rewrite unchanged (coordinated with the #603 return-shape change above). This is distinct from `runGuardedParentAdvance`'s TOCTOU guard, which is also preserved.
- [ ] Cover JSON and text rendering separately for delegate/collect/abort's new `execution_in_progress` and `recovery_required` outcomes with redacted claim identifiers, matching the Task 7 split.
- [ ] Add scenario coverage for post-migration delegate/claim/abort/collect happy-path and refusal sequences (frontmatter `scenarios:` or a scenario-suite entry). Update existing `runbooks/delegation/*` scenarios for any changed outcomes so the living-documentation layer stays green.
- [ ] Run completion/collection/delegation properties, focused CLI integration tests, the new/updated scenarios, and type checks.
- [ ] Commit: `refactor(core): make delegation and collection workflows transactional`.

### Task 9: Perform the single production cutover and delete old locks

**Files:**
- Delete: `packages/core/src/runbook/run-state-lock.ts`
- Delete: `packages/core/src/runbook/session-lock.ts`
- Delete: `packages/core/src/runbook/completion-lock.ts`
- Delete: `packages/core/src/runbook/delegation-lock.ts`
- Delete: corresponding `packages/core/__tests__/runbook/*-lock.test.ts`
- Modify: `packages/core/src/runbook/file-lock.ts`
- Modify: `packages/core/src/paths.ts`
- Modify: `packages/core/src/runbook/index.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/helpers/lifecycle-seam-factory.ts`
- Modify: every constructor site returned by `rg -n "new RunbookStateManager|new SessionService|new RunbookActorService" packages`
- Modify: `packages/core/__tests__/runbook/state-schema-version.test.ts`
- Modify: CLI/MCP/plugin fixtures that write JSON state directly
- Test: relevant command-contract suites under `packages/mcp/__tests__/` and `packages/claude-code-plugin/__tests__/`

- [ ] Add a cutover test that starts with legacy JSON state and no DB; assert default JSON `RD-305`, identify the legacy paths, instruct use of the pre-cutover binary or deliberate removal/restart, and assert no JSON import or DB creation occurs.
- [ ] Add a clean-install test that creates only `.rundown/rundown.db`; assert no `session.json` or `runs/*.json` authority files are written.
- [ ] Add a concurrent first-init test: two processes race to create/initialize `.rundown/rundown.db` on a clean install (Task 3 interleaving barrier); assert exactly one schema install wins, the other observes the installed schema, and no torn/duplicate DB results.
- [ ] Wire every frontend/service graph to one capability-selected driver/store. Remove constructor paths that silently instantiate independent managers for one command.
- [ ] Delete all four domain locks and every lock-only twin. Retain `file-lock.ts` for sql.js persistence and the existing artifact-manifest synchronization; preserve the `await using` non-masking release policy for those remaining consumers.
- [ ] Search for stale imports, `.rundown/session.json`, `.rundown/runs/*.json`, old lock-rank comments, and direct JSON test fixtures; update user-facing paths to the DB/recovery commands where applicable.
- [ ] Run the scenario and scenario-suite tests (including every `runbooks/delegation/*` scenario this change touches) and confirm they pass post-cutover; update any whose asserted outcomes changed.
- [ ] Run `pnpm test`, `pnpm run test:integration`, `pnpm run test:property`, the scenario/scenario-suite run, `pnpm run check:types`, and `pnpm run lint`.
- [ ] Commit: `feat: cut runbook state authority over to SQLite`.

### Task 10: Bundle WebContainer support, document current architecture, and verify release

**Files:**
- Modify: `site/scripts/build-snapshot.ts`
- Modify: `site/tests/runbook-runner.spec.ts`
- Modify: `docs/internal/architecture.md`
- Modify: `CLAUDE.md`
- Modify: `docs/reference/cli.md`
- Modify: `docs/spec/cli-output.md`
- Modify: `packages/core/src/errors/codes.ts`
- Modify: `packages/core/src/errors/factory.ts`
- Modify: `packages/core/src/output/zod-schemas.ts` (#615: register new codes in `CLISymbolicErrorCodeValues` / `RundownErrorCodeValues` so the docs↔enum drift check matches them)
- Modify: `packages/core/stryker.config.mjs` (add the new storage/executor files to the package-relative `mutate` array)
- Modify: `packages/cli/stryker.config.mjs` (add the ownership-refusal rendering switches)
- Modify: `packages/cli/src/schemas/output-schemas.ts`
- Modify: `packages/cli/src/services/schema-service.ts`

- [ ] Add WebContainer smoke coverage for run/pass/fail/goto on sql.js and verify the bundled snapshot contains sql.js JavaScript and WASM without runtime installation.
- [ ] Add CLI contract tests for the recovery UX selected during implementation. Reconcile/retry/stop must be typed machine transitions; no generic command automatically crosses the gate. A false-live PID force-reconcile path displays recorded process identity and the effect-ambiguity warning and never silently executes the original effect.
- [ ] Rewrite `docs/internal/architecture.md` descriptively: one SQLite authority store, short state-only/effectful boundaries, structural lease respect, cross-run parent invalidation, execution phases, exact-tuple PID recovery, sql.js file-lock exception, and no exactly-once-effect claim.
- [ ] Rewrite root `CLAUDE.md` concurrent-write guidance: remove deleted domain-lock examples, retain artifact-manifest/sql.js file-lock guidance and RD-102 non-masking cleanup, and point run/session state writers to the transactional store.
- [ ] Update reference JSON schemas and human rendering for the two new refusal/recovery outcomes. Register every new symbolic outcome code (`execution_in_progress`, `concurrent_modification`, `recovery_required`, `claim_superseded`, `missing`) in `packages/core/src/output/zod-schemas.ts`, not only CLI `output-schemas.ts`. No docs↔enum drift check exists in the current tree; run one only if #615 lands before this task.
- [ ] In the `architecture.md` / `CLAUDE.md` rewrite, note that the SQLite migration supersedes #609 (the deleted domain locks make the total lock-order documentation moot); the old lock-order proof block in `lifecycle-command-service.ts` is removed with the locks.
- [ ] Run the checked-in WebContainer probe and homepage Playwright suite.
- [ ] Register the eight core targets and eight CLI rendering targets named in the Task 10 amendment in their respective package-relative `mutate` arrays. Core is excluded from the per-PR advisory matrix, so the explicit core run remains mandatory.
- [ ] Run the implementation-and-consumer scoped mutation command in the Task 10 amendment below. Do not use `--allowEmpty`; confirm every named source file and a non-zero mutant count are instrumented, and clear a stale incremental report first.
- [ ] Run `pnpm run verify`, then `pnpm run test:all`. Record exact pass/failure counts in the PR description; do not claim release readiness from a partial suite.
- [ ] Commit: `docs: describe SQLite concurrency and execution recovery`.

## Binding amendments to carried-forward Tasks 7–10

These amendments override conflicting text in the reproduced task bodies.

### Task 7 amendments

- Add `packages/core/src/runbook/execution-recovery-service.ts`, `packages/core/src/runbook/index.ts`, and the CLI resume/acquire service to the file list. `EffectfulMutationExecutor` returning `recovery_required` from storage is insufficient: call `ExecutionRecoveryService.recover()` so the machine receives `EXECUTION_OUTCOME_UNKNOWN`, then assert `snapshot.hasTag(RECOVERY_TAG)`.
- The crash-boundary JSON assertion uses the existing symbolic command outcome `recovery_required`; it is distinct from R3's thrown schema error `RD-305`.
- Re-run all R6 caller tests because Task 7 consumes `SessionMutationResult<T>`.

### Task 8 amendments

- Replace the instruction to preserve `runGuardedParentAdvance` unchanged. The machine drive stays outside SQLite as `compute()`; re-run the open-children query inside `commitOwnedState` immediately before the decisive parent UPDATE. The query and UPDATE share one transaction. R2's durable claim latch remains the insert-before/after backstop.
- Recovery projection is a distinct discriminant: `{ kind: 'recovery_required'; runId: RunId; epoch: ExecutionEpoch }`. Do not widen `{ kind: 'not_terminal' }` with an ignored reason; both completion consumers must switch exhaustively.
- The initial claim/link write has already moved to core in R8. Task 8 must reuse `claimAndInitialLink`; it must not recreate `updateStepDelegationChildRunId` in the CLI.

### Task 9 amendments

- The legacy JSON check is a typed refusal, not a warning. Reuse `ErrorCodes.INCOMPATIBLE_STATE_SCHEMA` / `RD-305`; include the detected legacy paths in `details.context`; do not create the SQLite DB after refusing.
- Because the current binary cannot open a future schema, the actionable remedies are: finish/prune with the pre-cutover binary, or deliberately remove the obsolete state and restart. The new binary must not claim that its own finish/stop/prune commands can open incompatible state.
- Do not extend `warnIfLegacyStateExists`, import JSON, parse a fallback, or create a dual-read period.
- Remove or replace the required `runbook_started.statePath` JSON contract in `packages/core/src/events/types.ts` and `docs/spec/cli-output.md`; it currently promises `.rundown/runs/<id>.json`, which cannot survive the SQLite cutover. Prefer a storage-agnostic `runbookId`/runbook source contract rather than exposing `.rundown/rundown.db` as a mutable implementation path.

### Task 10 amendments

- Distinguish `storage/schema.ts::SCHEMA_VERSION` from `state.ts::CURRENT_SCHEMA_VERSION`. The SQLite value is `3` after R8 removes the vacuous linkage-version column; Rundown persisted `RunbookState.schemaVersion` stays `1`. Leave the correct version-1 references in `docs/reference/runtime.md`, `CLAUDE.md`, and `state-schema-version.test.ts` unchanged.
- There is currently no #615 docs↔enum drift check. Register codes in the correct enum because their output schema requires it, and verify the actual check only if #615 lands before execution.
- Scope mutation testing to every promised implementation and outcome-switch file. Run:

```bash
pnpm --filter @rundown-org/core exec stryker run \
  --mutate src/runbook/storage/execution-lease.ts \
  --mutate src/runbook/storage/runbook-store.ts \
  --mutate src/runbook/effectful-mutation-executor.ts \
  --mutate src/runbook/execution-recovery-service.ts \
  --mutate src/runbook/session-service.ts \
  --mutate src/runbook/lifecycle-command-service.ts \
  --mutate src/runbook/collection-service.ts \
  --mutate src/runbook/inline-parent-advance.ts \
  --testFiles __tests__/runbook/storage/execution-lease.test.ts \
  --testFiles __tests__/runbook/storage/runbook-store.test.ts \
  --testFiles __tests__/runbook/actor-service-execution-fence.test.ts \
  --testFiles __tests__/runbook/execution-recovery-service.test.ts \
  --testFiles __tests__/runbook/session-service.test.ts \
  --testFiles __tests__/runbook/lifecycle-command-service.test.ts \
  --testFiles __tests__/runbook/collection-service.test.ts \
  --testFiles __tests__/runbook/inline-parent-advance.test.ts
```

The first four targets cover the repository/lease/executor/recovery implementation. The final four cover the core mutation-result consumers introduced or widened by R6 and carried into Tasks 7–8; without them, the promise to mutate outcome switches is false.

Run the CLI rendering switches in the CLI package campaign:

```bash
pnpm --filter @rundown-org/cli exec stryker run \
  --mutate src/commands/claim.ts \
  --mutate src/commands/pop.ts \
  --mutate src/commands/prune.ts \
  --mutate src/commands/stash.ts \
  --mutate src/helpers/runbook-pipeline.ts \
  --mutate src/helpers/active-runbook-cleanup.ts \
  --mutate src/helpers/transition-orchestrator.ts \
  --mutate src/services/execution.ts \
  --testFiles __tests__/commands/claim.test.ts \
  --testFiles __tests__/commands/stash-pop.test.ts \
  --testFiles __tests__/commands/prune.test.ts \
  --testFiles __tests__/helpers/claim-and-launch.test.ts \
  --testFiles __tests__/helpers/active-runbook-cleanup.test.ts \
  --testFiles __tests__/helpers/transition-orchestrator.test.ts \
  --testFiles __tests__/services/execution.test.ts
```

Do not use `--allowEmpty`. Confirm the instrumentation lines report all eight core and all eight CLI source files with non-zero mutant counts; clear stale incremental reports first.

## Review and Release Checkpoints

0. **Remediation review after R8:** confirm R1 FK enforcement on both adapters; R2's central post-write hook across all three state-write paths, both claim/advance orderings, manual completion, and top-level cursor advance; R3's unique active controller plus default JSON `RD-305`; R4's typed refusals and linkage-mismatch pin; R5's concurrent-attempt witness; R6's common result union at every core and CLI caller; and R8's atomic initial claim/link, guarded rollback, removal of the vacuous linkage counter, idempotence, and exactly-one invalidation bump. Do not begin Task 7 until this passes.
1. **Substrate review after Task 1:** approve driver parity, sql.js durability, dependency/bundle cost, and positive environment selection before domain work begins.
2. **Protocol review after Task 4:** adversarially review crash histories, machine ownership of recovery, PID/process-tree limitations, token versus epoch language, and automatic-retry prohibitions.
3. **Vertical-slice review after Task 7:** demonstrate a real effect under two processes and all three named crash boundaries, then prove machine recovery with `RECOVERY_TAG`.
4. **Atomic-workflow review after Task 8:** inspect delegate/collect/abort transaction boundaries, the transaction-local open-child check, all-or-none acquisition, and absence of frontend shadow writes.
5. **Cutover review after Task 9:** prove one authority store, typed `RD-305` legacy refusal, no mixed mode, and preservation of #519, #617, #602, #603, and #613.
6. **Release review after Task 10:** full verification, WebContainer parity, docs, CLI schemas, non-zero mutation signal over all eight scoped core files plus the CLI outcome-rendering campaign, scenario parity, and explicit recovery UX.

## Dependency and Execution Order

```text
R0 spell gate
  ↓
R1 adapter parity
  ├──→ R3 active-controller constraint
  └──→ R4 refusal restoration
R2 durable claim latch (after R1)
R5 contention witness (after R1)
R6 session refusal unions (after R1 + R3 + R4)
R7 comment corrections (after R6)
R8 atomic initial claim/link + linkage-counter removal (after R2 + R3 + R6)
  ↓ remediation review
Task 7 effectful vertical slice
  ↓
Task 8 multi-record workflows
  ↓
Task 9 production cutover
  ↓
Task 10 WebContainer, docs, and release verification
```

Tasks that share `runbook-store.ts`, `session-service.ts`, driver contract tests, claim surfaces, or CLI pipeline code must not be assigned in parallel in one worktree. Safe concurrency is limited to work with genuinely disjoint files—for example R0 and the initial R5 fixture/test edit—followed by a merge and focused re-verification. The ordering above is the default execution order.

## Final verification contract

Before declaring the implementation complete:

```bash
pnpm run verify
pnpm run test:all
pnpm run test:scenarios:all
```

Record exact pass/failure counts in the PR description. A known environment limitation is reported as such; it is never rewritten as a pass.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-20-claim-concurrency-sqlite-remediation-and-completion-plan.md`. Execute it with `superpowers:subagent-driven-development` task by task, stopping at every checkpoint.
