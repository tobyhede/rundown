# 608 PR 6 addendum — adaptations to current `main`

**Amends:** [2026-07-23-608-pr06-claim-liveness-single-controller.md](2026-07-23-608-pr06-claim-liveness-single-controller.md). That plan is write-once and unchanged; read it first, then apply the deltas below. Where the two disagree, this file wins.

**Tracked in:** [#648](https://github.com/tobyhede/rundown/issues/648).

**Why this exists:** the PR 6 plan was written against the salvage history, where `6e9ff79f3` sits directly on top of PR 5's `fb2619d4d`. PR 5 (#651) did not land as a pure replay — it resolved eight collisions and adaptations toward `main` — so three of PR 6's five owned commits no longer apply as-is. A full trial replay of `6e9ff79f3 2d0656b24 eec5246d3 6cf18277c 68bdbf62c` onto #651's head (`e2fcc5923`) produced five merge conflicts and thirteen failing tests across both packages.

Nothing here relaxes the parent plan's constraints. The commit ownership block, the derived allowlist, the named-test commands, the scoped Stryker command, and `corepack pnpm run verify` all stand exactly as written.

**Base.** PR 6 branches from `origin/main` *after* #651 merges. This trial used #651's head (`e2fcc5923`), which is what that merge produces. Re-derive the SHA at branch time; nothing below depends on the exact value.

**The headline.** One correction — Delta 4 — accounts for ten of the thirteen failures. The plan already names it in a single clause and gives no mechanism; a pure cherry-pick does not perform it, and three of the owned commits actively rewrite `main`'s assertions to match the *uncorrected* behaviour. Read Delta 4 before touching anything.

## Delta 1 — union the three import-block conflicts

`6e9ff79f3` conflicts on the import block of three files. All three are pure unions: `HEAD` carries imports added by PR 3/PR 5, the incoming side adds PR 6's. Keep both.

| File | Resolution |
| --- | --- |
| `packages/core/__tests__/runbook/claim-seen.test.ts` | Add `claimLiveDelegation` to the `./claim-test-helpers.js` import; keep PR 5's `patchPersistedClaim` import. |
| `packages/core/__tests__/runbook/lifecycle-command-service.test.ts` | Identical resolution. |
| `packages/core/src/runbook/storage/runbook-store.ts` | Merge `classifyDelegationLiveness` into the existing `../targeting.js` import alongside `assertFrameKey`; keep `assertDelegationTokenHash`, `getErrorMessage`, and `logger`. |

## Delta 2 — keep `resolveControllingClaim` on `SqlReadTransaction`, take the incoming body

`2d0656b24` conflicts on `resolveControllingClaim`'s signature and first statement. The incoming side widens the query to `LIMIT 2` and throws when two active controllers exist — that body is the point of the commit and must be kept. But it also reverts the parameter type to `SqlTransaction`, which PR 5 had already widened to `SqlReadTransaction` (its recorded adaptation B) because the function is called inside `driver.read(...)`.

Resolve by taking **both**: `HEAD`'s `SqlReadTransaction` parameter, the incoming `const rows = tx` and everything below it. The body only prepares and reads, so the narrow type is sufficient. Taking the incoming signature is a hard `tsc` error — the same class as PR 4's Delta 3.

## Delta 3 — merge `applySession`, do not take either side whole

`2d0656b24` conflicts on `RunbookStore.applySession`. This is the only conflict in PR 6 where neither side is correct on its own.

The incoming side restructures the reconciler into two phases — collect the inserts, tombstone the stale claims, *then* insert — with an explanatory comment. That ordering is **load-bearing and must be kept**: this same commit adds the partial unique index `claims_one_active_per_run`, so a rotated claim (new key, same `controlled_run`) collides with its still-active predecessor unless the predecessor is tombstoned first.

The incoming side also reintroduces the `?? 0` generation fallback that PR 5 rejected on merits — it silently inserts a claim against a run that no longer exists, where `main` skips with a logged warning. That rejection stands.

Resolve as a genuine merge:

- Take the incoming two-phase structure and its comment.
- Phase 1 collects records only; it no longer reads the generation.
- Phase 2 tombstones the stale keys.
- Phase 3 reads each record's generation and keeps `main`'s warn-and-skip when the run is gone. Use `record.claimKey` for the log field, since the map key is out of scope by then.

Read the generation in phase 3, **after** the tombstones, not in phase 1. Each tombstone is a `status` UPDATE, which fires `claims_bump_gen_update` and bumps the controlled run's `claim_generation`; reading before them records an issuance generation the same transaction has already superseded. The incoming side gets this right and it is easy to lose while removing the `?? 0`.

## Delta 4 — the R2 terminal-retention correction

The amended plan names this in one clause: *"Correct the R2 historical behavior while resolving: invalidation retains claims for `completed`/`stopped` controlled children."* It gives no mechanism, a pure cherry-pick does not do it, and **three of the five owned commits rewrite `main`'s assertions to match the uncorrected behaviour**. This is the delta that matters.

### The defect

`6e9ff79f3`'s `RunbookStore.invalidateClosedDelegatedClaims` classifies every active delegated claim against the committed parent state and supersedes each one that reads closed. It never consults the *controlled child's* lifecycle. Completing a child sets its parent-side substep to `done`, so `classifyDelegationLiveness` returns `{ kind: 'closed', reason: 'resolved' }` and the child's claim is tombstoned — and `loadSession` surfaces only active claims. The terminal claim disappears from the session.

That breaks the plan's own shared constraint (*"a completed or stopped child remains resolvable as terminal evidence"*) and collapses `terminal-child` into `CLAIMED_RUNBOOK_UNAVAILABLE`.

### The fix

In `invalidateClosedDelegatedClaims`, join `runs` on `claims.controlled_run`, select `runs.lifecycle`, and `continue` past any claim whose controlled child is `completed` or `stopped` — **before** classification. Order matters: every terminal child also reads closed on the parent side, so a check placed after `classifyDelegationLiveness` never fires. Four lines of production code in an already-allowlisted file.

### What it accounts for

Ten failures across eight suites, all on this one cause:

| Suite | Failures |
| --- | --- |
| `cli/__tests__/commands/pass.test.ts` | 2 |
| `cli/__tests__/commands/fail.test.ts` | 2 |
| `cli/__tests__/commands/stop.test.ts` | 1 |
| `cli/__tests__/commands/prune.test.ts` | 1 |
| `cli/__tests__/commands/delegate.test.ts` | 1 |
| `cli/__tests__/commands/claim.test.ts` | 1 |
| `cli/__tests__/commands/status.test.ts` | 1 |
| `core/__tests__/runbook/claim-seen.test.ts` | 1 |

The first five suites are **not** in the allowlist and need no edits — they fail against the uncorrected latch and pass once it is fixed. Treat the named CLI command returning to its exact 248-test baseline as the signal that Delta 4 is correctly applied.

### Three assertions the owned commits invert — restore `main`'s

These are in allowlisted files, so the cherry-pick lands them silently. Each replaces a `main` assertion that already states the correct behaviour, with a comment describing the uncorrected latch.

**`core/__tests__/runbook/claim-seen.test.ts` › `attributes terminal liveness to caller A rather than selected claim B (AC5)`.** `6e9ff79f3` rewrites `expect(after.claims[recordB.claimKey].lastSeenAt).toBe(recordB.lastSeenAt)` into `expect(after.claims[recordB.claimKey]).toBeUndefined()`. Restore `main`'s. It is also the stronger assertion: `toBeUndefined()` passes just as well if B *had* been refreshed and then dropped, which is the exact failure AC5 exists to catch. Keep the commit's switch to the new `claimLiveDelegation` helper.

**`cli/__tests__/commands/claim.test.ts` › `does not pop the parent when an identified child auto-completes`.** `6e9ff79f3` inverts `toContainEqual` to `not.toContainEqual`. `main`'s comment states the reason outright: *"The auto-completed child's claim is retained as a terminal tombstone (not deleted) so `rd pass/fail --claim-id` can confirm-or-conflict and `rd prune` can later GC it."* Restore it.

**`cli/__tests__/commands/status.test.ts` › `reports delegated child completion to the parent (uncollected)`.** `2d0656b24` performs the same inversion on `main`'s *"Item 4: the terminal claim is RETAINED as a tombstone (release with `retainClaimsAsTerminal`) so a later `--claim-id` can confirm/conflict again."* Restore it.

## Delta 5 — two main-era tests collide with `claims_one_active_per_run`

The new partial unique index makes states unrepresentable that main-era tests (written by PR 5, after the salvage baseline) construct directly. Same class as PR 4's Delta 2. Both in `packages/core/__tests__/runbook/storage/runbook-store.test.ts`:

**`surfaces active claim records in full and omits tombstones`.** Inserts two active claims on one run, then tombstones one. Reorder to insert the dead claim, tombstone it, then insert the active one. The assertions are unchanged, and the reordering is the same rule Delta 3 encodes in production.

**`inserts a genuinely new session claim at its controlled run current generation`.** Saves a session holding two active claims on the same run. Split across two runs: the persisted claim holds run A (still exercising the "already persisted → skipped" branch), the fresh claim targets run B. Churn B's generation first — mint a claim on it and tombstone that — so the "current generation is already non-zero" property the test exists for is preserved. Assert `before > 0` explicitly so the churn cannot silently stop working.

## Delta 6 — three allowlist expansions

All three are stop-and-review events under the parent plan, recorded here and required on the PR description and #648. Same class as PR 5's single expansion.

**`packages/cli/__tests__/helpers/runbook-pipeline.test.ts`.** This suite mocks `@rundown-org/core` with an explicit `jest.unstable_mockModule` factory, so the new `classifyDelegationLiveness` import in `runbook-pipeline.ts` (an allowlisted production file this commit changes) is unresolvable and the entire suite fails to load with `SyntaxError: … does not provide an export named 'classifyDelegationLiveness'`. It then needs a second edit: the file's `beforeEach` calls `jest.resetAllMocks()`, which strips factory implementations, so every mock is re-stubbed there and this one must be too — otherwise the classifier returns `undefined` and 16 tests die on `Cannot read properties of undefined (reading 'kind')`.

`6e9ff79f3` applies **exactly this two-part fix** to the sibling suite `claim-and-launch.test.ts` — factory default plus `beforeEach` re-stub, both defaulting to `{ kind: 'live' }`, with comments explaining that the classifier is covered by the core targeting suite. It simply missed the second suite that mocks core. Copy the pattern verbatim.

This is not a coverage loss: defaulting to `live` keeps the 4a′ precheck inert, and `claim-and-launch.test.ts` overrides it per-test to exercise the superseded path.

**`packages/cli/__tests__/integration/delegation-propagation.test.ts` › `handles propagation when parent is already completed`.** Asserts `rd claim <token>` exits 0 against a completed parent. That is precisely what PR 6 exists to refuse — the plan's shared constraint lists *"parent deletion/terminalization"* among the events that supersede mutation authority. Verified by probe: the command now emits exit 1 with

```json
{ "kind": "error", "code": "DELEGATION_SUPERSEDED",
  "error": "The parent has moved past this delegation. Do not retry this token; report the superseded delegation to the orchestrator." }
```

Rewrite the test to assert the refusal, and assert `details.parentRunId` names the parent — `DELEGATION_SUPERSEDED` rather than a missing/unavailable code is the property worth pinning, since the plan forbids collapsing it into `missing`.

**`cspell-dictionary.txt`.** `check:spell` is part of `verify`, and the owned commits introduce three words it does not know: `upserts` (`claim-test-helpers.ts`), `terminalization` (`session-service.test.ts`), and `disambiguator` (`schema.ts`, in `2d0656b24`'s `claims_one_active_per_run` comment). The Delta 6 rewrite above adds a fourth, `terminalized`. Append all four; the file is append-ordered, not sorted, and already carries `terminalizes`. Without this, `verify` fails on work the replay itself brings in.

## Delta 7 — two allowlist notes

**`packages/core/src/runbook/storage/mutation-result.ts` is not touched.** The plan's Files section names it among "required implementation paths", but none of the five owned commits modify it and the trial needed no change there. The derived allowlist is authoritative, as the plan itself says; the prose overstates.

**`packages/core/__tests__/runbook/storage/driver-contract.test.ts` is allowlisted but nets to zero.** `2d0656b24` changes its `user_version` assertion from 1 to 2 and `68bdbf62c` changes it back. Expect `comm -3` to report this one path as allowlisted-but-unchanged; that is correct, not a miss. `SCHEMA_VERSION` ends at 1.

## Procedural note — rebuild before running CLI tests

CLI suites resolve `@rundown-org/core` to its built `dist`, so `corepack pnpm run build` must run **after** the replay and before any CLI test command. Building only at branch time hides new core exports and produces a module-resolution error that looks like a missing export rather than a stale artifact. The plan's step list does not mention this; the revised list below does.

## Revised step list

Replaces the six checkboxes in the amended plan. Everything else in that plan — shared constraints, commit ownership, interfaces, self-review checklist — is unchanged.

- [ ] Fetch `origin/main` after #651 merges, record the SHA, and branch from it. Run the plan's two baseline commands and record the counts (this trial: core 119 / 2 suites, CLI 248 / 6 suites).
- [ ] Derive the allowlist: `for c in 6e9ff79f3 2d0656b24 eec5246d3 6cf18277c 68bdbf62c; do git diff-tree --no-commit-id --name-only -r "$c"; done | sort -u > /tmp/rd608-pr6-allowed`. Expect 33 paths.
- [ ] Cherry-pick `--no-commit`, one commit at a time so conflicts stay attributable, in order: `6e9ff79f3` (3 conflicts → Delta 1), `2d0656b24` (2 conflicts → Deltas 2 and 3), `eec5246d3`, `6cf18277c`, `68bdbf62c` (clean).
- [ ] Apply Delta 4 (terminal retention plus the three restored assertions), Delta 5 (two index collisions), and Delta 6 (three allowlist expansions).
- [ ] Confirm `git diff --name-only --diff-filter=U` prints nothing and `git diff --check` exits 0. `comm -3` against the allowlist must report exactly four paths: `driver-contract.test.ts` untouched per Delta 7, and the three Delta 6 expansions. Any fifth is a stop-and-review event.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec tsc --noEmit -p tsconfig.json`. Expected: exit 0. Delta 2 is the only reason this fails.
- [ ] Run `corepack pnpm run build`. Required before any CLI test command — see the procedural note.
- [ ] Run the plan's two named test commands. Expected: core 217 / 3 suites, CLI 248 / 6 suites. The CLI count returning to its exact baseline is the Delta 4 signal.
- [ ] Run both full suites. Expected: core 4599 passed / 1 skipped / 201 suites; CLI 3027 passed / 143 suites.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/storage/runbook-store.ts,src/runbook/session-service.ts,src/runbook/command-target-resolver.ts --testFiles __tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/session-service.test.ts,__tests__/runbook/command-target-resolver.test.ts`. Delete `reports/stryker-incremental.json` first. Scope judgement to changed line ranges, not the whole-file aggregate. **Hand-verify Delta 4's retention branch**: the named `--testFiles` do not reach the CLI terminal-evidence tests that kill it, so Stryker will report it as a survivor or as no-coverage. Neuter the `continue` and confirm the CLI suites fail.
- [ ] Run `corepack pnpm run verify`; commit `fix(core): enforce delegated claim liveness and one controller`; open and merge PR 6. Record all seven deltas in the PR description and on #648.

## Trial-replay evidence

Measured on a throwaway worktree at `e2fcc5923` (#651 head) with all deltas applied.

| Gate | Result |
| --- | --- |
| Merge conflicts | 5, across 3 files, all in `6e9ff79f3` and `2d0656b24` |
| `tsc --noEmit` on `@rundown-org/core` | exit 0, no output |
| `corepack pnpm run lint` | exit 0 (2 warnings, both pre-existing and outside the changed set) |
| `check:format`, `check:md`, `check:spell` | all exit 0 (spell only after Delta 6's dictionary words) |
| Named core tests (3 suites) | 217 passed |
| Named CLI tests (6 suites) | 248 passed — exactly the pre-replay baseline |
| Full `@rundown-org/core` suite | 4599 passed, 1 skipped, 201 suites |
| Full `@rundown-org/cli` suite | 3110 passed, 143 suites |
| Changed paths | 35: 32 of the 33 allowlisted, plus the 3 Delta 6 expansions |

**Known flake, not a regression.** `session-service.process.test.ts › converges with no duplicate or resurrected entries when releases and pops race` failed its `expectOverlap` barrier once under full-suite load, then passed 5/5 on three consecutive isolated runs and again on the next full run. That witness asserts at least two child processes' mutation windows were genuinely in flight together; it starves when the whole suite is competing for cores. Unrelated to PR 6 — re-run it in isolation before treating it as a finding.

Not exercised in the trial: the scoped Stryker command and `corepack pnpm run verify`. Both remain mandatory gates on the real PR.
