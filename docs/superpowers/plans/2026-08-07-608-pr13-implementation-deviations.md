# 608 Controlled Rebuild — PR 13 implementation deviations

**Decided:** 2026-08-07

**Tracks:** [#690](https://github.com/tobyhede/rundown/issues/690)

**Supersedes:** the "Domain-lock scope is unchanged" section (`:134-143`) of
[2026-08-02-608-pr13-ignore-unreleased-json-state-addendum.md](2026-08-02-608-pr13-ignore-unreleased-json-state-addendum.md),
and the corresponding lock-deletion requirements in
[2026-07-23-608-pr13-single-store-cutover.md](2026-07-23-608-pr13-single-store-cutover.md)
(§Task Files block, §Self-Review, §Mandatory Review Checkpoint) and
[2026-08-02-608-pr13-planning-audit-current-status.md](2026-08-02-608-pr13-planning-audit-current-status.md)
(the deletion checklist at `:121-129`).

**Supplements:**
[2026-07-27-608-pr09-pr14-correction-ledger.md](2026-07-27-608-pr09-pr14-correction-ledger.md),
whose supersession rule this doc invokes: "Where they disagree, this ledger wins
until a PR-specific addendum supersedes it" (`:3`).

PR 13 as shipped (#674) diverges from PR 13 as planned in three ways. Each is
recorded here because the governing documents are dated and write-once — CI
enforces `check:docs:dated-immutable` (`.github/workflows/ci.yml:43`), so a
false statement in a shipped plan can only be corrected by a new dated file. The
precedent is
[2026-07-30-608-pr10-implementation-deviations.md](2026-07-30-608-pr10-implementation-deviations.md).

## 1. Two of the four core domain locks survive

The addendum shipped by this same PR states, under a heading titled
"Domain-lock scope is unchanged" (`:134`):

> PR 13 must still wait until PR 12 has made delegate, collect, and abort
> transactional and removed every production `CompletionLock` / `DelegationLock`
> dependency. PR 13 then deletes the four obsolete core domain locks while
> retaining sql.js, artifact-manifest, execution-liveness, and plugin-local file
> locking.
>
> — `2026-08-02-608-pr13-ignore-unreleased-json-state-addendum.md:139-143`

**The second sentence is false about the PR that ships it.** PR 13 deletes two
locks, not four.

| Lock             | Module                                         | Status in #674                   |
| ---------------- | ---------------------------------------------- | -------------------------------- |
| `RunStateLock`   | `packages/core/src/runbook/run-state-lock.ts`  | **Deleted.** Was never exported. |
| `SessionLock`    | `packages/core/src/runbook/session-lock.ts`    | **Deleted.** Export removed.     |
| `CompletionLock` | `packages/core/src/runbook/completion-lock.ts` | **Survives** (`:65`).            |
| `DelegationLock` | `packages/core/src/runbook/delegation-lock.ts` | **Survives** (`:69`).            |

The two survivors are live across six production call sites:

| Site                                                                     | Lock             |
| ------------------------------------------------------------------------ | ---------------- |
| `core/src/runbook/completion-service.ts:1076` `recordManualCompletion`   | `CompletionLock` |
| `core/src/runbook/completion-service.ts:1175` `recordChildCompletion`    | `DelegationLock` |
| `core/src/runbook/completion-service.ts:1450` `drainResolvedCompletions` | `CompletionLock` |
| `cli/src/services/execution.ts:625` `launchInlineChildFromIntent`        | `DelegationLock` |
| `cli/src/commands/run.ts:231` (run-start `afterInit` callback)           | `DelegationLock` |
| `cli/src/helpers/runbook-pipeline.ts:1549` `claimAndLaunch`              | `DelegationLock` |

### Why the deletion was deferred

The addendum's own precondition was never met. It requires PR 13 to "wait until
PR 12 has … removed every production `CompletionLock` / `DelegationLock`
dependency"; PR 12 shipped with all six sites live, so the precondition failed
before PR 13 branched. PR 13 absorbed the gap rather than closing it.

Closing it in PR 13 would mean moving the delegate, collect, and abort workflows
onto aggregate SQLite transactions — a behavioural change to concurrent,
multi-process paths, larger than the cutover it would ride on, and requiring its
own contention, rollback, and committed-before-observation coverage. Deleting
the locks also dissolves the contract of each `*Unlocked` twin
(`recordManualCompletionUnlocked`, `recordChildCompletionUnlocked`,
`drainResolvedCompletionsUnlocked`, `consumeStaleDelegatedOutcomes`), whose
entire specification is "the caller already holds the lock", and disturbs the
`DelegationLock → CompletionLock` ordering edge that the lifecycle seam's
`#drainSubstepObservations` ordering proof is written against.

Deferring is the right engineering call. Shipping a plan document that says the
work was done is not, which is why this record exists.

### What tracks the remaining work

[#690](https://github.com/tobyhede/rundown/issues/690) owns the deletion. Its
inventory was verified against the tree at this commit: the six call sites, the
`DelegationLock → CompletionLock` ordering edge, the `*Unlocked` twins, and the
inherited `DELEGATION_LOCK_TIMEOUT` (RD-810) surface — codes, factory, Zod
schemas, the `claim.ts` and `execution.ts` mappings, the `'lock-timeout'` arm of
the claim-and-launch result union, the fixtures pinning the code, and the public
re-exports from `packages/core/src/runbook/index.ts` (a public API removal).

`CLAUDE.md` § "Concurrent write synchronization" describes the survivors as a
tracked deviation, names all six sites, points at #690, and constrains the
interim: do not add new consumers of either lock, and do not read their survival
as licence to put new run or session state behind a file lock.

Unaffected, and correctly retained per the addendum's own "retaining" clause:
`file-lock.ts` and its scoped-release primitives, the sql.js durable-replacement
lock, artifact-manifest locking, and the plugin-local `PluginSessionLock`
(`packages/claude-code-plugin/src/session-lock.ts`, comment-only change in this
PR).

## 2. Work carried outside PR 13's Files block

Each of the following is present in `git diff main...HEAD` and is not authorized
by any PR 13 planning document. Recorded so PR 14 re-scopes rather than
duplicates, and so the placement question is answered in the repository rather
than in review comments.

### Four new public error codes — PR 14's Modify block

`packages/core/src/errors/codes.ts` and `packages/core/src/errors/factory.ts`
gain four codes and four factories:

| Code     | Key                             | Factory                              |
| -------- | ------------------------------- | ------------------------------------ |
| `RD-306` | `WAL_JOURNAL_MODE_UNAVAILABLE`  | `Errors.walJournalModeUnavailable`   |
| `RD-307` | `STATE_STORE_UNAVAILABLE`       | `Errors.stateStoreUnavailable`       |
| `RD-308` | `CONCURRENT_STATE_MODIFICATION` | `Errors.concurrentStateModification` |
| `RD-309` | `INVALID_PERSISTED_RUN_STATE`   | `Errors.invalidPersistedRunState`    |

PR 13's Files block lists `errors/factory.ts` for exactly one purpose — "add an
`RD-305` legacy-state factory without changing the existing schema-version
factory" (`2026-07-23-608-pr13-single-store-cutover.md:35`) — and the addendum
removed that entire RD-305 scope from PR 13 (`:6`), leaving the file with no
remaining PR 13 authorization. `errors/codes.ts` is not listed at all. PR 14's
Modify block lists both:
`packages/core/src/errors/{codes,factory}.ts`
(`2026-07-23-608-pr14-webcontainer-schemas-docs-release.md:39`).

The ledger's "register a public code in the first PR that can emit it" does not
authorize the placement. It governs where you register a code you already must
emit; it does not authorize creating the emitter. PR 13 is only the first PR
that can emit any of these four because PR 13 invented, or newly exposed, the
condition each one reports.

**Why no existing code fit.** Each code was minted by a different agent, and
each recorded the same finding independently: the 3xx state range had no member
that meant what the condition means, and reusing one would have handed the
operator a recovery instruction that destroys data or does not apply. That
argument is the justification for the deviation, so it is recorded here rather
than left in commit messages.

- **RD-307** — nothing meant "the database would not open". `RD-103` is about
  the `.rundown` directory, `RD-302` is JSON parsing, and `RD-305`/`RD-306` are
  the schema-version and journal-mode special cases. Every unreadable-database
  path — a corrupt file, a directory where the database should be, a host
  without a usable `node:sqlite` — previously escaped untyped.
- **RD-308** — cannot share `RD-307`'s code because the operator actions are
  opposites: repair the host versus simply retry. It also deliberately does not
  collapse into the CLI's existing symbolic `CONCURRENT_MODIFICATION`. They are
  the same condition on two surfaces: a command that receives a
  `StateMutationResult` narrows the `concurrent_modification` arm and renders it
  itself, whereas `RunbookStateManager`'s throwing seam escapes to the top-level
  CLI wrapper, which only speaks `RD-NNN`. A cross-reference comment in
  `codes.ts` exists to stop the two drifting apart.
- **RD-309** — not `RD-305`. That code is the whole database's schema, and its
  description instructs deleting `.rundown/rundown.db`, which would destroy
  every other run; this condition is one run row inside an otherwise healthy
  database. Nor `RD-302`, which names invalid JSON only — one of four causes
  here — and still speaks of a "state file" the cutover removed. It is also the
  code that makes CLAUDE.md § State Persistence's required behaviour reachable
  from the error surface at all: "detect invalid state … and prompt the user to
  finish or prune".

The engineering is sound in each case — the classes mirror
`IncompatibleSchemaError` at every layer, and an unclassifiable throw on any of
these paths reaches the operator as RD-999 on every command, read-only ones
included, because opening the store precedes all of them. The objection is
placement and the absence of a record.

**RD-306's documented cause list was wrong on arrival.** The first version named
"a read-only database file or directory" among the causes of a rollback-journal
fallback. Empirical probing of eleven real conditions (Node 24.18.1 / SQLite
3.53.1, recorded in `packages/core/__tests__/runbook/storage/driver-contract.test.ts`)
found that a read-only database file (errcode 8 `SQLITE_READONLY`), a read-only
directory (errcode 1544 `SQLITE_READONLY_DIRECTORY`), and a clean open
transaction all **throw** rather than return a journal mode — so they land on
`RD-307`, never on `RD-306`. `RD-306` is reached only when SQLite *answers* the
pragma with the mode it kept, which
`sqlite3PagerOkToChangeJournalMode` permits for an open **dirty** write
transaction and for a temporary on-disk database, alongside the documented
network-filesystem case that cannot be probed on a local host. Sending an
operator to `chmod` for a fault that cannot produce the message is the specific
harm. All three surfaces that render the cause list — the driver's error
message, `RD-306`'s `description` in `codes.ts`, and
`Errors.walJournalModeUnavailable`'s message in `factory.ts` — now name the
reachable causes and state explicitly that a read-only file or directory is not
among them, pointing at `RD-307` instead.

### `assertRunId` throws a typed error — core behaviour, not cutover

`packages/core/src/runbook/run-id.ts` adds `InvalidRunIdError` (carrying the
offending `value`) and `assertRunId` now throws it instead of a bare `Error`.

Not part of the cutover. It exists to retire a string match in a hook binary:
the plugin's `rdpath` guard had to test the message fragment `'Invalid run id'`
to decide whether a session-stack read was recoverable, which is exactly the
string-discriminant smell CLAUDE.md § Design Principles forbids — reword the
message and the guard silently becomes dead code. The guard now narrows with
`instanceof InvalidRunIdError`.

Additive: the class extends `Error`, so every `catch` narrowing with
`instanceof Error` is unaffected, and all 21 production call sites were checked
— none catches it, none matches its message. The message retains its original
prefix and appends the offending value, so a prefix or substring match survives
while an exact-equality match on the whole string does not. Announced in the
changeset for that reason.

### `runId` on five public Zod schemas — PR 14's Modify block

`packages/core/src/output/zod-schemas.ts` adds an optional `runId` to
`RunbookContextSchema` (`:286`), `ActionResponseSchema` (`:442`),
`StatusResponseSchema` (`:585`), `StashResponseSchema` (`:1204`), and
`PopResponseSchema` (`:1227`). The file is absent from PR 13's Files block and
present in PR 14's Modify block (same line as above).

This is additive public-contract scope decided inside an implementation PR. The
safety argument — that emitting a claimed child's run id to a caller without
`--claim-id` is acceptable, because run ids are a read-only correlation handle
and no read command accepts one as a mutation selector — currently lives only in
a code comment at `packages/cli/src/helpers/status-builder.ts:57-65` and in
`docs/spec/cli-output.md`. It belongs in a decision record.

### The cold-start WAL race fix — a defect fix, not a cutover line item

`packages/core/src/runbook/storage/native-sqlite-driver.ts` (+171 / -3 across
the branch), in two commits:

- `9fa4e8a9c` introduced `enterWalJournalMode`, converting
  `PRAGMA journal_mode = WAL` from fire-and-forget into a hard refusal of any
  file-backed connection that does not enter WAL.
- `017125f54` added the typed `WalJournalModeUnavailableError`, RD-306, and a
  bounded synchronous `SQLITE_BUSY` retry loop around the conversion
  (`DEFAULT_MAX_BUSY_RETRIES = 10`, `DEFAULT_BUSY_RETRY_BASE_MS = 25`, so 11
  attempts with backoff 25→250 ms).

`main`'s driver issues a bare `this.db.exec('PRAGMA journal_mode = WAL')`
(`native-sqlite-driver.ts:169` on `main`) with no effective-mode check and no
retry. The retry closes a live first-run defect: two `rundown run` invocations
racing to create the database on a fresh project contend on the EXCLUSIVE lock
the conversion takes, and `PRAGMA busy_timeout` does not cover it, so the loser
died with a false "Native SQLite is unavailable" diagnosis.

The driver substrate is PR 1's slice, and
`2026-07-23-608-pr01-sqlite-driver-substrate.md` contains **zero** mentions of
WAL or journal mode (verified case-insensitively). No PR 13 document mentions
either. This is a product-behaviour fix with its own reproduction and its own
user-visible failure mode; it warrants its own issue and its own Impact line
rather than riding a state-authority cutover.

### Site and CI tooling — neither plan

| Path                                   | Change                                       |
| -------------------------------------- | -------------------------------------------- |
| `scripts/verify-site.sh`               | added                                        |
| `site/src/lib/rundown-paths.ts`        | added                                        |
| `site/src/lib/rundown-paths.parity.ts` | added                                        |
| `site/tsconfig.json`                   | modified (`exactOptionalPropertyTypes`)      |
| `site/package.json`                    | modified                                     |
| `package.json` (root)                  | modified (`verify:site`, `check:types:site`) |
| `.github/workflows/ci.yml`             | modified                                     |

PR 14 owns `site/scripts/build-snapshot.ts`, `site/playwright.config.ts`, the
substrate probe page, and the site specs — not these. The work itself is
verified and motivated (two site regressions on this branch reached CI because
`verify` type-checks `site/` but runs none of its behaviour, and Biome, cspell,
and Prettier all exclude the directory), but its placement is unassigned by both
plans.

## 3. Knock-on: PR 14's `CLAUDE.md` instruction is not satisfiable as written

PR 14's plan instructs:

> Update `CLAUDE.md` to remove domain-lock guidance but retain RD-102 scoped
> non-masking release.
>
> — `2026-07-23-608-pr14-webcontainer-schemas-docs-release.md:59`

The RD-102 half is unaffected and still applies. The first half assumes the four
domain locks are gone by PR 14; per §1 they are not, and #690 — not PR 14 — owns
their deletion.

**What PR 14 must do instead.** Remove only the guidance describing the two
locks that were actually deleted, which this branch has already done: `CLAUDE.md`
§ "Concurrent write synchronization" now describes run and session authority as
living in SQLite behind transactions and execution leases, distinguishes the
blocking `BEGIN IMMEDIATE` path from the non-blocking `mutateState` CAS, and
scopes the surviving file-lock guidance to the artifact manifest, the sql.js
durable replacement, and the two surviving domain locks. PR 14 should verify that
text against the merged code and leave it in place.

Deleting the domain-lock guidance outright, and removing the #690 pointer, is the
final acceptance item on #690. PR 14 must not do it, and must not treat
`CLAUDE.md` still carrying that section as unfinished PR 14 work.

## No schema changes

No SQLite schema or persisted `RunbookState` schema version changed.
`RunbookState.schemaVersion` remains `1` and the SQLite schema version remains
`2`. `RunbookState.templateVars` moved from optional to required, which is a
structural tightening enforced as **rejection** at load — the recovery path is
prune and restart, never a migration or a re-parse of the stored source.
