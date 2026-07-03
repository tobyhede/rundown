# Delegation Lifecycle — Session Handoff & Explicit-Targeting Redirection

- **Date:** 2026-07-03
- **Supersedes for direction:** Cluster G section of
  `2026-07-01-delegation-lifecycle-remaining-work-roadmap.md`; the
  `2026-06-16-claim-handoff-barrier.md` plan is now **reference-only,
  superseded in design** (not just stale in code).
- **Audience:** the next session/agent continuing this work with zero context.
- **First task:** write a NEW dated roadmap (see §6). Do not extend the
  2026-07-01 roadmap in place.

---

## 1. State of the world (what shipped)

Three clusters landed as a stacked PR chain. Merge bottom-up; retarget each PR
to `main` as its base merges.

| PR | Branch | Cluster | Closes | Base |
|----|--------|---------|--------|------|
| #535 | `cluster-c-issuance-atomicity` | C — issuance atomicity + single-source resolution | #496, #508 | `main` |
| #537 | `cluster-d-explicit-cursor-lock` | D — explicit-cursor completion-lock span | #500, #499 | #535 branch |
| #539 | `cluster-e-collect-trust` | E — collect trust (evidence seam + withhold set) | #509-P1 | #537 branch |

All three: full `rundown:planning` pipeline (plan → 4-dimension plan review →
collation → TDD implementation → code review → verify), `pnpm run verify`
exit 0, `pnpm run test:integration` green. Clusters A (#523) and B (#528) were
already merged to `main` before this session.

**What the stack changed, in one paragraph each:**

- **C:** `createDelegation` refuses re-mint over a claimed child
  (`delegation_claimed`, RD-811, not when substep is `done`); one pure resolver
  `resolveDelegationIssuance` replaces the three issuance-inference branches
  (positional no-step now echoes instead of RD-813; different runbook → RD-804);
  fresh + retry issuance run under a `DelegationLock`-scoped
  read→gate→resolve→mint→persist (narrow `DelegationLockLike` DI, `heldLock` +
  `await using`, RD-810 timeout as typed outcome). Superseded helpers retained
  `@deprecated`. Emergent: Cluster B's `#supersedePendingOutcome` now runs
  inside both lock spans.
- **D:** explicit-target pass/fail (`--step`/`--index`) records + drains under
  ONE `CompletionLock` scope (`#driveSubstepExplicit`); cursor resolution moved
  into core (`manual-completion-cursor.ts`, real `buildFrameKey` fixtures →
  closes #499); unlocked twins (`recordManualCompletionUnlocked` public,
  `drainResolvedCompletionsUnlocked` new); **terminal side effects returned as
  data and applied after the lock scope closes** (plan review caught the
  CompletionLock→SessionLock ABBA cycle — three reviewers independently);
  `manualTarget` removed from the seam input (`explicitTarget` raw;
  `ManualCompletionCursor` kept as `@deprecated` alias). Disclosed behavior
  changes: entry-bump and FOR-frame drift record at the live frame (pinned).
- **E:** `CollectDelegationOutcomesInput` takes typed
  `callerEvidence: CallerEvidence`; core maps trust via
  `actorContextFromEvidence` before `resolveCommandIntent` (no front end
  constructs trust contexts); `collect` added to the subprocess withhold set
  (union/set/alias record) completing the Cluster A precedent; docs updated
  (incl. mcp.md §8 correction).

**Residuals explicitly pinned during the work:**
- Auto-issuance (`delegationIssueActor`) mints outside the DelegationLock —
  accepted residual, commented on #508.
- CompletionLock hold-time spans the drain loop — documented, unenforced cap.
- mcp.md §5.9/§5.10 complete/stop staleness → #538.

## 2. The direction change: Cluster G re-scoped to explicit targeting

**Decision (user, 2026-07-03):** drop the `handoffPending` barrier approach.
Root-cause instead: the entire #460 defect class lives in the **ambient-trust
lane** — bare commands resolving to the shared default-active stack, where
core cannot distinguish the orchestrator from a lingering child (no process
identity exists: fresh shell per command, no inheritable env, child processes
cannot mark parent shells; see the removed `RD_AGENT_ID` model, #494).

**New design: remove ambient trust. Everyone names their authority.**

- **Tier 1 — names (accident-proof).** Mutating commands and `collect` require
  explicit targeting: children keep `--claim-id`; the orchestrator passes the
  parent run id (e.g. `--run <rd_…>`, already printed by `rd run` / carried on
  every event). The default-active stack stops being an authority mechanism
  (status convenience at most). No new state. Kills #460's class structurally:
  post-collect lingering child, pre-collect drift, cross-session bare
  collisions (#533-adjacent).
- **Tier 2 — capabilities (approaching adversarial).** `rd run` mints an
  orchestrator secret (delegation-token pattern: plaintext printed once, only
  hash persisted); mutations on delegating runs require it. Also upgrade claim
  ids from *names* to *capabilities* — today claim ids are plaintext in
  `session.json`, so a child can target a sibling's claim (latent hole,
  observed during recovery work; not yet filed as an issue — file it).
- **Evidence seam is ready:** Cluster E routed collect through
  `CallerEvidence`; add a `run-controller` evidence variant and shrink/remove
  `direct_cli`'s "trusted over whatever is active" mapping — that mapping is
  the exact line that makes #460 possible.
- **Ergonomics ruling (user, verbatim intent):** ignore human ergonomics for
  now — secondary concern. Design **always-strict for agents**; iterate UX to
  relax constraints later rather than hack or compromise the design for an
  audience that is effectively not a concern. (i.e. do NOT build
  strict-on-first-delegation / opt-in modes into the core design; if a
  relaxation ever ships it is a UX layer, not a trust-model carve-out.)
- **Consequences to design through:** inline composition targeting (the
  `inlineLaunch` event already carries `childRunId`; skills' choreography
  changes from "bare `rd pass`" to "pass the id the event gave you"); the
  subprocess withhold sets (Clusters A/E) demote to defense-in-depth; huge
  migration surface (skills, plugin hook texts, reference docs, CLAUDE.md,
  large parts of the CLI test suite) — sequence it in the new roadmap, likely
  as multiple clusters (G1 = core + CLI strict targeting; G2 = migration of
  skills/docs/tests; G3 = tier-2 capabilities).
- **Empirical support for "no effort for agents":** this session, 11 subagents
  ran hundreds of `--claim-id` commands with zero protocol errors; every
  incident lived on the bare-command side.

## 3. Open issues inventory (as of this handoff)

**Filed this session (all from real friction):**
- #531 — `rd status` doesn't surface claim ids (blocked orphaned-claim
  recovery; adoption via `session.json` worked). Pairs with tier-1 UX.
- #532 — verify lints files outside the change surface; tactical fix landed on
  the C branch (`.prettierignore`/`cspell.json`: `.claude/worktrees/**`,
  `prcomment.md`); proper fix = scope checks to tracked files.
- #533 — shared-checkout branch race: implementer branched off another
  session's lineage (Cluster C was rebased onto main + fully re-verified).
  Mitigation used since: `git checkout -b <branch> <explicit-start-point>` +
  verify HEAD. Proper fixes proposed in the issue (pin base ref in skills,
  worktree isolation for implementers, base assertion step).
- #534 — `rd prune` leaves pruned ids on `defaultStack`; status/pass then
  resolve nothing. Repair snippet in §5.
- #536 — **highest operational priority**: execute-plan runs marked
  `lifecycle: stopped` mid-verify by an unattributed writer. **3/3
  reproduction** on multi-minute inline verify gates (Clusters C, D, E).
  Verify itself green every time; no transition events after command output;
  `lastAction: GOTO 5` preserved. Evidence dumps preserved (3 state files).
  Ruled out empirically: the test suites themselves (live-sentinel runs of
  core/cli/root suites — untouched), env-based state-root escape (none
  exists), killed processes (incidents 2 and 3 had none). Suspects:
  `cleanupOrphanedActiveStack` (#518 family), the collect-driven execution
  loop on long-running commands, plugin hook traffic. **Recommended first
  move: lifecycle-write attribution logging (pid + call site on every
  lifecycle transition write), then re-run a pipeline.**
- #538 — mcp.md §5.9/§5.10 complete/stop staleness (Cluster A doc debt).

**Pre-existing, still open, relevant:**
- #518 — `cleanupOrphanedActiveStack` can delete a valid active run; roadmap
  said "fix before/with Cluster A"; Cluster A merged anyway → widened blast
  radius; possibly #536's mechanism.
- #460 — the defect Cluster G now solves structurally (P0). #519 (parent-side
  liveness/lease), #520 (RD-999 third outcome), #521 (inline child left
  active), #522 (delegate docs), #470 (plugin closure = Cluster F), #516
  (executing-plans `--artifacts` docs), #478, #498.
- Comment trail: #508 (auto-issuance residual), #519 (failure-mode-2 evidence
  + cross-session claim adoption).

**Filed as #540 (claim ids are names, not capabilities):** claim ids are
plaintext names in `session.json` — sibling-claim targeting possible (see §2
tier 2). Start from #540; do not re-file.

## 4. First task for the next session: NEW ROADMAP

Write `docs/superpowers/plans/2026-07-XX-delegation-lifecycle-roadmap-2.md`
(new dated file; never edit the 2026-07-01 one beyond its existing addendum
pattern). It should:

1. **Re-audit against post-C/D/E code** (trust the code, not prior docs — the
   2026-07-01 roadmap's method). Confirm dispositions: items 3,7 (C), 5,15 (D),
   6 (E), 1,10,13 (B), 2,4,8,9 (A). Mark #496/#500/#508/#499 closeable on
   merge; #509 partially (P1 done, confirm P2/P3 state).
2. **Sequence the remaining work.** Recommended order (rationale inline):
   - **R0 — pipeline reliability first:** #536 instrumentation + root-cause,
     and #518 (likely the same family). These corrupt every long pipeline run;
     everything else is executed THROUGH the pipeline. Include #534 and #531
     (small, unblock recovery ergonomics).
   - **R1 — Cluster G tier 1** (explicit targeting, always-strict): core
     `run-controller` evidence + `--run` targeting; refuse bare mutations and
     bare collect on delegating runs; CLI/MCP surface.
   - **R2 — G migration:** skills, plugin hook texts, docs, test-suite sweep.
   - **R3 — Cluster F** (#470 plugin closure) — package-isolated, can run any
     time / in parallel with R1-R2.
   - **R4 — G tier 2** (orchestrator capability secret; claim-id
     capability upgrade; file the sibling-claim issue first).
   - **R5 — Cluster H** (architecture cleanup: `linkDelegationChild` into core,
     lifecycle-status docs reconciliation) + docs debt sweep (#522, #516,
     #538).
   - **Parked pending G:** #519 (liveness/lease — tier 2 may subsume part),
     #521, #520.
3. **Record the Cluster G design decision** (§2 above) as the roadmap's
   governing constraint, including the always-strict ruling.

## 5. Operational playbook (hard-won; read before running the pipeline)

**Process per cluster (user requirement, unchanged):**
`rundown:planning` pipeline end-to-end — plan (delegated write-plan child) →
4-dimension plan review + collate (delegated) → implement (delegated, TDD, one
atomic commit per task) → code review (delegated) → address findings → verify →
PR. File issues for every piece of friction (check existing first). Quality
bar: strongly typed idiomatic TS, extensive tests, refactor; follow
`docs/internal/xstate-patterns.md` and CLAUDE.md architectural principles.

**Dispatch pattern that works:** load `rundown:running-runbooks` +
`rundown:delegating-runbooks` (+ `writing-plans`/`executing-plans` per stage);
`rd run rundown:planning`; each DELEGATE step auto-issues tokens (read
`delegateFrontier` from the step_entered event); dispatch subagents with
`RD_CLAIM_TOKEN=<token>` in the prompt (plugin injects claim instructions),
explicit instructions to pass `--claim-id` on every command and STOP after
reporting; `rd collect` after children report. Reviewer/implementer prompt
recipes: see the agent prompts in this session's transcript — they include
per-dimension review priorities that repeatedly caught real defects (D's ABBA
cycle at plan stage; D's surviving mutant at code-review stage).

**Branch discipline (#533):** always
`git checkout -b <branch> <explicit-start>` and verify `git log -1` before any
code. Current stack tip: `cluster-e-collect-trust`.

**Known hazards and recovery drills:**
- **#536 mid-verify stop** (expect it on every long verify gate until fixed):
  symptom — execute-plan run `lifecycle: stopped` at step 5, `lastAction:
  GOTO 5`, verify output green, no trailing transition events. Recovery:
  (1) preserve the run state file; (2) `rd prune`; (3) repair the stack (#534):
  ```python
  import json, os
  p='.rundown/session.json'; s=json.load(open(p))
  runs=set(f[:-5] for f in os.listdir('.rundown/runs'))
  s['defaultStack']=[r for r in s['defaultStack'] if r in runs]
  json.dump(s, open(p,'w'), indent=2)
  ```
  (4) `rd pass --step 3.1` on the planning parent (explicit-step completion is
  the sanctioned operator recovery; verify was independently green each time).
- **Long inline verify:** `rd collect` on the review→verify edge executes
  `npm run verify` INLINE — run it with a ≥10-minute timeout. A killed collect
  orphans the verify process tree (incident 1's confounder).
- **Orphaned claimed child (dead session):** claim records live in
  `.rundown/session.json` → `claims`; adopt with `--claim-id <id>` from any
  session (#531 tracks surfacing this in `rd status`).
- **Stale-state warnings from `rd ls`:** schema-invalid runs are prunable
  noise; `rd prune --all` when no active work.
- **Env lint noise:** fixed on the C branch (#532); if verify fails on
  markdown/spell for files you didn't touch, check for new untracked files.

## 6. Working-file locations

- Plans/artifacts from this session's pipelines: `.rundown/work/.rd-<ctx>/…`
  (plan.json + review JSONs per cluster; ContextIds `f5af6365` (C),
  `13ed53a2` (D), `412369aa` (E)).
- #536 evidence dumps: session scratchpad (`stopped-execute-plan-{,D-,E-}evidence.json`) —
  re-preserve into the repo or the issue if the scratchpad is gone.
- Untracked-but-intentional files at repo root: this handoff, the 2026-07-01
  roadmap + cluster A plan docs, `prcomment.md` (user's), `.serena/*`.
