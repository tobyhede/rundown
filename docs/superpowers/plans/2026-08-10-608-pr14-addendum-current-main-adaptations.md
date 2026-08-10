# 608 Controlled Rebuild — PR 14 addendum: adaptations to current `main`

**Amends:**
[2026-07-23-608-pr14-webcontainer-schemas-docs-release.md](2026-07-23-608-pr14-webcontainer-schemas-docs-release.md),
subject to
[2026-07-27-608-pr09-pr14-correction-ledger.md](2026-07-27-608-pr09-pr14-correction-ledger.md).

**Tracked in:** [#648](https://github.com/tobyhede/rundown/issues/648), whose
`## Post-PR13 audit corrections — 2026-08-10` block is the authoritative scope
statement this addendum implements.

**Base:** `origin/main` @ `a7a99c566fb4a4cd20c689a5c12e43463ebf96b9` (merge of
#709). Branch `issue-608/pr14-descriptive-docs`.

`check:docs:dated-immutable` forbids editing the PR 14 plan in place, so this
file records every departure from it. It is itself write-once: append-only after
first commit.

## Why this addendum exists

PR 14's plan was written on 2026-07-23, before PRs 8–13 landed. Of its ~22
decomposed tasks, **7 are already done**, **7 are invalidated** (by the
correction ledger, by a later PR solving the same problem differently, or by a
maintainer decision), and **8 remain**. Executing the plan literally would
re-do merged work, re-register codes that already exist, run mutation campaigns
the ledger forbids, and cut a release that has been withdrawn.

## Task disposition

### Already done before this PR (7)

| Plan task                                                                        | Where it actually landed                                                                                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle sql.js JS/WASM into the WebContainer snapshot                             | Already true. `sql.js` is a hard `dependency` of `@rundown-org/core`; `site/scripts/prune-sqljs.mjs` throws when a declared entry point or a retained loader's `.wasm` is missing. Ledger §141-144 called this correctly. |
| Cherry-pick `4859a9c08`'s probe + awaited output drain                           | PR 1 landed the probe; the awaited drain is on `main`. Only the `git mv` to `dev/` remains (below).                                                             |
| Register `EXECUTION_IN_PROGRESS` / `RECOVERY_REQUIRED`                           | PR 9 (#667), per ledger §49.                                                                                                                                    |
| Register `CLAIM_SUPERSEDED` / `CONCURRENT_MODIFICATION`                          | PR 11 (#669), per ledger §49.                                                                                                                                   |
| Remove `runbook_started.statePath`; make the event storage-agnostic              | PR 13 (#674), per ledger §138 (`statePath` removal assigned once, to PR 13). PR 14 verifies parity only.                                                        |
| Typed `RD-305` and the SQLite-vs-`RunbookState` schema-version distinction in the runtime reference | Already on `main`: `docs/reference/runtime.md` §7.4 carries both version checks as a table and states `RunbookState.schemaVersion` MUST be `1`.                |
| Update `CLAUDE.md` for the store cutover and the surviving locks                 | Already on `main`: § State Persistence names `.rundown/rundown.db`, and § Concurrent write synchronization documents the two surviving domain locks, their six call sites, #690, and the RD-102 non-masking release policy. |

### Invalidated (7)

| Plan task                                                                    | Why it is not done                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Register a generic lowercase `missing` result code                           | Forbidden by ledger §50: "never emit generic lowercase `missing`". `missing` exists only as an internal discriminant on `GuardedMutationResult`, which is correct.                                                                |
| The four whole-file scoped Stryker campaigns in the plan's §61-81 block      | Superseded by ledger §23-29. Current policy is `pnpm run test:mutate:changed`, which derives its own scopes from the diff — see [§ Mutation evidence](#mutation-evidence) for what it actually ran.                              |
| The eight-hour unscoped `pnpm run test:mutate`                              | Explicitly forbidden by ledger §31.                                                                                                                                                                                                |
| Add final implementation targets to `packages/{core,cli}/stryker.config.mjs` | The configs' `mutate` arrays are already package globs; per-PR scoping is now done by `scripts/lib/mutation-scope.mjs`, not by editing configs. Editing them would encode a scope the runner no longer reads.                     |
| The "path-check staging" two-stage cherry-pick gate                          | Moot — `4859a9c08`'s content is already merged, so there is no cherry-pick to stage. Only the rename survives.                                                                                                                     |
| `packages/core/src/output/zod-schemas.ts`, `packages/cli/src/{schemas/output-schemas,services/schema-service}.ts` edits | The plan wanted these to *register* the five result codes. That registration already happened in PR 9 and PR 11, and RD-306..309 flow into `RundownErrorCodeValues` derivationally, so documenting them needs no schema edit. (`codes.ts` and `factory.ts` **were** edited on this branch, for an unrelated reason — see [§ `ccfb2e69b`](#deviation--pr-14-carries-a-packages-change-ccfb2e69b).) |
| Cut a 2.0.0 release; merge release PR #636; validate and clean up salvage    | **Withdrawn by maintainer decision, 2026-08-10.** See below.                                                                                                                                                                       |

### Remaining, and implemented here (8)

1. Rewrite `docs/internal/architecture.md` so it describes the SQLite
   substrate. Two statements on it are actively false, not merely silent:
   `| **Persistence** | JSON files |` and the overview diagram's
   `[CLI Commands] <---- [Persisted JSON]`.
2. Document RD-306..309 in `docs/spec/cli-output.md` — which is what arms the
   `docs-error-code-drift.repo-asset.test.ts` guard, since that guard reads
   only that file and only its ` ```json ` fences.
3. Add RD-306..309 to the ungoverned prose table in `docs/reference/cli.md`.
4. Rescope the no-migration MUST NOT in `docs/spec/language.md` §12, which
   binds `.rundown/runs/` — post-cutover that directory holds only captured
   outputs, so the normative rule does not bind the database at all.
5. Make `site/tests/sqlite-substrate.spec.ts` prove the **built** snapshot runs
   sql.js offline, rather than mounting its own files (ledger §144).
6. Extend `site/tests/runbook-runner.spec.ts` to assert the snapshot bundles
   sql.js JS **and** WASM and that run/pass/fail/goto work with no runtime
   install.
7. `git mv site/src/pages/sqlite-substrate-probe.astro` →
   `site/src/pages/dev/sqlite-substrate-probe.astro`, repointing the spec's
   `goto`, leaving no duplicate page, and keeping the comment that warns against
   an `_`-prefixed filename (Astro excludes those from routing).
8. This addendum.

## Withdrawn release scope

Cutting 2.0.0 is **withdrawn by maintainer decision on 2026-08-10**: Rundown is
not near release, and treating changesets as a gate generates noise rather than
signal. Nothing under `.changeset/` is touched by this PR, no changeset is
added, release PR #636 is untouched, and no release command is run.

Recorded so it is not rediscovered when the release track resumes:

- `.changeset/` holds **five** changesets (not four — #706 added
  `claim-arm-open-children-guard.md` on 2026-08-09).
- All five packages sit in one `fixed` group, so everything lands on the same
  version.
- Release PR **#636** already contains the generated output. **Do not merge it**
  until the release track is deliberately resumed.
- Coverage is **5 changesets against 372 merge PRs** since
  `@rundown-org/core@1.0.0` (`e2dbb00cc`, 2026-01-20), with **14 of 15
  breaking-marked commits uncovered**.
- #701's `!` breaking marker was erased by the squash-merge (branch commit
  `aedbf2d50` carries it; the merged title does not), so conventional-commit
  breaking markers are not durable in this repo's merge flow.

## Carried to linked issues, not done inline

Per #648's own instruction. Bodies are drafted in the PR description; the issues
themselves are created by the maintainer.

1. **`exec_start_id` / `owner_start_id` are declared and `CHECK`-constrained but
   never written.** `schema.ts:106,200` declare them; `schema.ts:113-116`
   constrains execution identity as all-or-nothing while leaving
   `exec_start_id` optional. Every production write is NULL
   (`execution-lease.ts:448,488,663`, `runbook-store.ts:1666,1844` all clear
   it; nothing sets it). Recovery therefore compares PID only, so PID reuse
   means a dead owner is never recovered. Confirmed **not** redundant:
   `recoverDeadOwner` returns `{kind:'alive'}` at `execution-lease.ts:578`
   (`:577` is the `isProcessAlive` guard above it, which is what the audit
   block cites) and never reaches the token/epoch CAS at `:662-668`.
   `isProcessAlive` compounds it by failing *toward* alive on any non-`ESRCH`
   error (`file-lock.ts:106`).
   Failure mode is a permanent stall, not a safety break.
2. **Every typed error ships a dead documentation link.**
   `rundown-error.ts:88` emits `https://rundown.dev/docs/errors/<slug>`, and
   `wrapper.ts:178` puts it in the default JSON error envelope's `details`.
   `rundown.dev` does not resolve; `site/astro.config.mjs:20` sets
   `site: 'https://rundown.cool'`. The fix is the URL, not a site route.
3. **`docs/reference/cli.md`'s `RECOVERY_REQUIRED` row prescribes a command
   that does not exist.** It tells operators to "Resolve the interrupted attempt
   through recovery before retrying the command", but there is no
   `rundown recover`, and recovery is automatic — performed by the command that
   emits the error (`effectful-actor-mutation-runner.ts:300-320`).
   Documentation-parity defect.

## Deviation — PR 14 carries a `packages/` change (`ccfb2e69b`)

**This supersedes the "no `packages/` source change" statement made throughout
this PR's earlier working notes and reports.** Those are obsolete. PR 14 ships
seven `packages/` files.

`ccfb2e69b` ("fix: correct SQLite state error guidance") landed on this branch
from concurrent work while the documentation task was in progress, and the
maintainer's decision on 2026-08-10 is that it **stays**. `origin/main` is
unchanged at `a7a99c566` and remains this branch's base; the commit is not
rebased away, dropped, or moved.

That is a departure from the PR 14 plan's scope, which lists no `packages/`
source edit, and from the #648 audit block's re-derived four-item scope.

**Why it is acceptable here.** It is error-message and doc-comment text with no
logic change — no control flow, no types, no exported surface. More to the
point, it is *the same factual correction this PR's documentation work applied
at the other layer*. Splitting them would ship one PR whose prose contradicts
the other's strings until both landed, which is precisely the drift the
descriptive-docs rule exists to prevent.

Two claims are corrected, both of which this PR had documented faithfully
because they came from `codes.ts`:

| Claim | Why it was wrong |
| --- | --- |
| RD-306: "only WAL serializes writes across processes" | SQLite serializes cross-process **writers** in rollback-journal mode too, through file locking. What WAL adds is reader/writer **concurrency**. The old wording implied a correctness hazard that is not there. |
| RD-307: "reaches every command, read-only ones included" | Commands that never open the store — `rundown check` — cannot reach it. The refusal reaches commands that access persisted run state. |

The corrected text also makes RD-307's lock-contention arm explicitly
retryable, where the old wording said the recovery was "not retrying the
command".

`docs/internal/architecture.md` was checked against both corrections and
contradicts neither: it never claimed WAL was the only cross-process
serializer, and its multi-process statements are about the **adapter**
(`capabilities.multiProcess: false`), not about journal modes.

<a id="mutation-evidence"></a>

## Mutation evidence

`ccfb2e69b` makes the mutation gate load-bearing for this PR, so
`pnpm run test:mutate:changed` was run and its findings acted on. It plans four
source campaigns:

| Scope | Instrumented | Result |
| --- | --- | --- |
| `core src/errors/codes.ts:132,140` | **0 mutants** | Structural — see below |
| `core src/errors/factory.ts:65-78,84-93` | 14 mutants | 14 survived on the first run; killed by new tests |
| `core src/runbook/storage/native-sqlite-driver.ts:155-156,176-186` | 13 mutants | 0 survived |
| `cli src/helpers/wrapper.ts:74-76` | **0 mutants** | Comment-only change |

Two of the four instrument zero mutants, and **neither is a gap the gate can
close**:

- **`codes.ts` is unmutable by construction.** The whole file is one
  `export const ErrorCodes = { … } as const;`. Stryker does not mutate literals
  under a `const` assertion, because the mutated literal would not satisfy the
  inferred literal type. Verified by widening the scope: an entire error-code
  entry (`:119-134`) and then the whole file both report
  `Instrumented 1 source file(s) with 0 mutant(s)`. No test can change this —
  the registered descriptions are instead pinned directly by
  `__tests__/errors/rundown-error.test.ts`.
- **`wrapper.ts:74-76` is a comment.** `ccfb2e69b` reworded the doc comment
  above the RD-307 arm and changed no code there. Zero mutants is the correct
  answer, not a silent no-op — though note the `--print` plan labels it
  `[source changed]`, which does not distinguish a comment edit from a code
  edit.

**The 14 `factory.ts` survivors were real and are now killed.** They were not a
`--testFiles` scoping artefact: `__tests__/errors/factory.test.ts` had **no
test at all** for `walJournalModeUnavailable` or `stateStoreUnavailable`, and
`ccfb2e69b` added its wording assertions to `rundown-error.test.ts`, which pins
the registered `description` rather than the message the factory builds. The
survivors covered the new `modeOutcome` branch (3 conditional mutants), both of
its arms, the error-code key, and six template chunks of the message.

Six tests were added to `factory.test.ts` covering both branches, the `??`
fallback rendering an absent mode as `unknown` rather than `undefined`, the
corrected WAL wording, the three enumerated causes with the read-only exclusion,
and RD-307's driver-diagnosis/`driverCode`/`cause` passthrough. Writing tests in
`packages/` is in scope for this PR by the same decision that keeps
`ccfb2e69b`.

## Deviations taken while implementing

Recorded as they arose. Anything below is a departure from either the PR 14
plan or the #648 audit block, not from this addendum.

- **"Rewrite" `docs/internal/architecture.md` is executed as a targeted
  correction plus a new substrate section, not a from-scratch replacement.**
  Roughly 1000 of its 1130 lines describe the XState machine, the CLI/core event
  boundary, and the lifecycle command seam, and those are accurate. Discarding
  them to satisfy the word "rewrite" would delete correct descriptive
  documentation to fix false documentation. What is replaced is the
  architecture-overview table row and diagram, and what is added is a
  `## State Persistence and Concurrency` section describing the substrate as it
  exists.
- **`docs/internal/architecture.md` is not the only file touched for item 1.**
  Its `WebContainer Environment` section is extended with the driver-selection
  rule, because that is where a reader looking for "what runs in the browser"
  arrives.
- **`packages/core/src/runbook/storage/schema.ts` declares
  `SCHEMA_VERSION = 2`**, not 3. The ledger's PR 10 correction (§85) *permitted*
  advancing to 3 "when the database shape changes"; the shape did not require
  it. Documentation states 2 and, more durably, points at the constant rather
  than repeating the number.
- **The audit's line-number citations have drifted in three places**, recorded
  so the next auditor does not re-derive them: `codes.ts` RD-306..309 sit at
  key-name lines 127/135/150/172 with their `code:` fields on 128/136/151/173;
  `language.md`'s MUST NOT is at 872-878 (the audit's `:872-874` covers only its
  first three lines, and the sentence that needs rescoping ends on 878);
  `effectful-actor-mutation-runner.ts`'s automatic recovery spans 300-320, not
  300-315.
- **#698 (`rdpath.ts` unreachable by mutation testing) is explicitly carved
  out.** It poisons only the unscoped `pnpm run test:mutate`, which ledger §31
  forbids PR 14 from running, and PR 14 touches no plugin source.
- **`ESRCH` was added to `cspell-dictionary.txt`.** `EPERM`, `EACCES`,
  `ENOENT`, `ELOOP`, and `errno` were already there; `ESRCH` had never been
  spell-checked because its only prose occurrences were under
  `docs/superpowers/`, which cspell ignores. Adding it is the smallest change
  that keeps `verify` green without weakening the check. `unbypassable` was
  rephrased rather than dictionary-added.
- **No new normative keyword was added to `docs/spec/language.md`.** The review
  finding was that one recovery SHOULD covered two failures with different
  scopes; the fix is the scope/recovery table. A drafted
  `MUST NOT offer either recovery for the other's failure` was **withdrawn**
  before commit. Its store-level half is unarguable — pruning a run cannot
  repair a store this build refuses — but its run-level half is not: discarding
  the store *does* remove one bad run, and a user with no other active runs may
  legitimately choose it, so "disproportionate" is not "forbidden". A spec-level
  MUST NOT also constrains implementations' recovery UX, which is not what §12
  governs, and nothing in the conformance fixtures could enforce it. The
  asymmetry is now stated descriptively instead, which carries the same
  reasoning without adding unenforceable normative surface.
- **`page.route` in `site/tests/runbook-runner.spec.ts` matches by predicate,
  not `'**/*'`.** The first draft intercepted every request and tested the URL
  inside the handler. That put Playwright's interception layer in front of a
  ~10 MiB snapshot stream and a WebContainer boot on a cross-origin-isolated
  page — far more surface than the assertion needs. A URL predicate leaves
  everything unmatched on the normal path. Behaviourally identical for the
  assertion, and it removes the most plausible source of `verify:site`
  flakiness.

## Findings that correct the 2026-08-10 audit block

The audit instructed that PR 14 describe "PID-identity recovery" as a live
mechanism. Reading the source to write that description turned up two facts the
block does not record. Both are documented in `architecture.md` as they are,
because `docs/internal/` describes what exists.

1. **The dead-owner recovery path has no production caller.**
   `recoverDeadOwner` is reached only from `withWait`
   (`storage/execution-lease.ts:759`), which returns at `:752-753` unless a
   `LeaseWaitPolicy` was supplied. No caller in `packages/*/src` supplies one —
   the only `wait:` occurrences are two conditional pass-throughs in
   `effectful-actor-mutation-runner.ts` (`:298`, `:508`), and no production
   caller sets `input.wait`. So `isProcessAlive`, both exact-tuple CAS
   statements, `reclaimed_pre_effect`, and `unresolved` are exercised only by
   tests. This makes carved issue 1 **latent**, not live — its failure mode is
   real but currently unreachable, which is worth knowing before prioritising
   it.
2. **A SIGKILL-stranded execution owner has no in-product recovery.**
   `deleteRun` guards on `exec_token IS NULL`
   (`storage/runbook-store.ts:1741`) and raises `execution_in_progress`
   otherwise, so `rundown prune` refuses a run whose owner was hard-killed —
   the same refusal every mutation gets. Combined with finding 1, the only exit
   is deleting `.rundown/rundown.db`. The 2026-08-08 block's phrasing implies
   pruning is available here; it is not.

Two smaller corrections:

- **`SCHEMA_VERSION` is `2`.** The ledger's PR 10 correction permitted 3; the
  shape never required it.
- **`recoverDeadOwner`'s `{kind:'alive'}` return is line 578**, not 577 — 577 is
  the `isProcessAlive` guard above it. Its token/epoch CAS is `:662-668`, not
  `:660-666`.
