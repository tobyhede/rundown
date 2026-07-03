# Delegation Lifecycle — Roadmap 2 (post-C/D/E)

- **Date:** 2026-07-03
- **Supersedes for direction:** the ordering and cluster sequence in
  `2026-07-01-delegation-lifecycle-remaining-work-roadmap.md`. That document's
  per-item audit (items 1–15) remains the traceable baseline; this roadmap
  updates dispositions against merged/landed code and re-sequences the
  remaining work around the Cluster G re-scope.
- **Governing design decision:** the 2026-07-03 Cluster G re-scope —
  **remove ambient trust; everyone names their authority; always-strict for
  agents.** Recorded verbatim in §1 and treated as a non-negotiable constraint
  on every cluster below. Source:
  `2026-07-03-delegation-lifecycle-handoff-explicit-targeting.md`.
- **Method:** trust the code, not prior docs. Every disposition below was
  re-checked against the working tree at branch tip `cluster-e-collect-trust`
  (the C→D→E stack applied). The stack has since **merged to `main`**; the
  load-bearing `file:line` anchors below were re-verified there on 2026-07-03
  and still hold (within ±1 line — e.g. the `direct_cli` grant is
  `actor-context.ts:146`).

---

## 0. State of the world

Five clusters have landed or are in flight since the 2026-07-01 roadmap.

| Cluster | Scope | Issues | PR | State |
|---------|-------|--------|-----|-------|
| A | complete/stop core terminal seam | #510 (items 2,4,8,9) | #523 | **merged to main** |
| B | retry supersession + live-outcome collect readiness | #509-P2/P3 (items 1,10,13) | #528 | **merged to main** |
| C | issuance atomicity + single-source resolution | #508, #496 (items 3,7) | #535 | **merged to main** (2026-07-03) |
| D | explicit-cursor completion-lock span | #500, #499 (items 5,15) | #537 | **merged to main** (2026-07-03) |
| E | collect trust (evidence seam + withhold set) | #509-P1 (item 6) | #539 | **merged to main** (2026-07-03) |

**Immediate operational fact (updated 2026-07-03):** the C/D/E stack **has
merged bottom-up** (#535 → #537 → #539, all to `main` on 2026-07-03), closing
#496, #500, #508, #499, and #509. `main` now carries A+B+C+D+E. The
stacked-merge / #533 shared-lineage caveat is discharged — the next session
starts fresh from `main` at **R0**.

### Verified dispositions (code, at stack tip)

| 2026-07-01 item | Issue | Landed in | Verdict now | Evidence |
|-----------------|-------|-----------|-------------|----------|
| 2, 4, 8, 9 | #510 | A (#523) | **RESOLVED** on main | complete/stop route through core terminal seam; withhold set includes `complete`/`stop` (`subprocess-mutation-boundary.ts:24-39`) |
| 1, 13 | #509-P2 | B (#528) | **RESOLVED** on main | retry supersession derived in core |
| 10 | #509-P3 | B (#528) | **RESOLVED** on main | collect readiness reads live outcomes, not `substepState.status` |
| 3 | #508 | C (#535) | **RESOLVED on main** | issuance under `DelegationLock` read→gate→resolve→mint→persist |
| 7 | #496 | C (#535) | **RESOLVED on main** | one `resolveDelegationIssuance`; positional echoes, RD-804 on different runbook |
| 5, 15 | #500 | D (#537) | **RESOLVED on main** | record+drain under one `CompletionLock`; core-owned cursor + real `buildFrameKey` fixtures (#499) |
| 6 | #509-P1 | E (#539) | **RESOLVED on main** | `collect` takes typed `CallerEvidence`; core maps trust via `actorContextFromEvidence`; `collect` in withhold set |
| 11 | #460 | — | **OPEN → Cluster G** | root cause re-scoped (§1); no barrier shipped |
| 12 | #470 | — | **OPEN → Cluster F** | plugin closure defects untouched |
| 14 | — | — | **OPEN → Cluster H** | `issued→active` link write still CLI-side |

**Closed on stack merge (2026-07-03):** #496, #500, #508, #499 — and **#509**,
whose P1 (E) landed with #539 alongside the already-merged P2/P3 (B). All five
are now `CLOSED` on GitHub; verified against the merge commits, not this table.

### Trust seam as built (the load-bearing fact for Cluster G)

The evidence seam Cluster E generalised is now the single trust chokepoint:

- Frontends supply typed `CallerEvidence` (`actor-context.ts:92-124`): only
  `direct_cli` and `claim` are trust-granting; `plugin`/`mcp`/`unknown` are not.
- Core maps it with `actorContextFromEvidence(evidence, targetRunId)`
  (`actor-context.ts:140-158`). The consequential line:

  ```ts
  case 'direct_cli':
    return trustedRunControllerContext(targetRunId);   // actor-context.ts:145-146
  ```

  `direct_cli` grants **trusted run-controller over whatever `targetRunId`
  resolved to.** For a bare command, `targetRunId` is the ambient default-active
  stack (`resolveCommandTarget` → `getActive()`,
  `command-target-resolver.ts:248-249`). Core therefore trusts the direct CLI as
  controller of whatever is active — and cannot distinguish the orchestrator
  from a lingering child. **That single mapping is the entire #460 defect
  class.** Everything in Cluster G below is the demolition of it.

- Core already has the strict destination: `actor_context_required`
  (`command-target-resolver.ts:88-100, 335-336`) refuses a bare transition when
  the caller supplies no trusted evidence. It is currently unreachable from the
  direct CLI precisely because `direct_cli` manufactures trust over the ambient
  target upstream. Cluster G makes it reachable by removing the ambient grant.

---

## 1. Governing constraint — the Cluster G design decision

Recorded here as the roadmap's controlling design law. **No cluster may
re-introduce ambient trust to buy ergonomics.**

**Decision (user, 2026-07-03):** drop the `handoffPending` barrier. Root-cause
instead — the whole #460 class lives in the **ambient-trust lane**: bare
commands resolving to the shared default-active stack, where core cannot tell
the orchestrator from a lingering child because *no process identity exists*
(fresh shell per command, no inheritable env, children cannot mark parent
shells — see the removed `RD_AGENT_ID` model, #494).

**New design: remove ambient trust. Everyone names their authority.**

- **Tier 1 — names (accident-proof).** Mutating commands and `collect` require
  explicit targeting. Children already do (`--claim-id`). The orchestrator must
  pass the parent run id (`--run <rd_…>`, already printed by `rd run` and
  carried on every event). The default-active stack stops being an authority
  mechanism (status convenience at most). No new persisted state. Kills #460's
  class structurally: post-collect lingering child, pre-collect drift,
  cross-session bare collisions (#533-adjacent).
- **Tier 2 — capabilities (approaching adversarial).** `rd run` mints an
  orchestrator secret (delegation-token pattern — plaintext printed once, hash
  persisted); mutations on delegating runs require it. Also upgrade claim ids
  from *names* to *capabilities* (#540 — today claim ids are plaintext in
  `session.json`, so a child can target a sibling's claim).
- **Evidence seam is ready.** Add a `run-controller` evidence variant keyed on
  the explicit `--run` id and **shrink/remove** `direct_cli`'s "trusted over
  whatever is active" mapping. That mapping is the exact line (`actor-context.ts:145`)
  that makes #460 possible.
- **Ergonomics ruling (user, verbatim intent):** ignore human ergonomics for
  now — secondary. Design **always-strict for agents**. Do **not** build
  strict-on-first-delegation / opt-in modes into the core trust model. If a
  relaxation ever ships it is a UX layer on top, never a trust-model carve-out.
- **Empirical support:** across the C/D/E session, 11 subagents ran hundreds of
  `--claim-id` commands with zero protocol errors; every incident lived on the
  bare-command side. Explicit targeting costs agents nothing.

**Consequences to design through** (sequenced as G-sub-clusters in §2):
inline-composition targeting (`inlineLaunch` already carries `childRunId`;
skills change from bare `rd pass` to "pass the id the event gave you"); the
subprocess withhold sets (Clusters A/E) **demote to defense-in-depth** once core
is strict; large migration surface (skills, plugin hook texts, reference docs,
CLAUDE.md, much of the CLI test suite).

---

## 2. Sequenced remaining work

Ordering rationale is inline. The through-line: **R0 protects the pipeline that
executes everything else; R1/R2 are Cluster G tier 1 + migration; R3 is
independent and parallelisable; R4 is tier 2; R5 is cleanup + docs debt.**

### R0 — Pipeline reliability first (BLOCKS everything)

Every subsequent cluster is *executed through* the `rundown:planning` pipeline.
The pipeline currently corrupts its own long runs. Fix that before building on
it.

- **#536 — mid-verify `lifecycle:stopped` (highest operational priority).**
  3/3 reproduction on multi-minute inline verify gates (Clusters C, D, E). An
  unattributed writer marks the `execute-plan` run `stopped` at step 5 while
  `npm run verify` is still running; verify itself is green every time; no
  transition events follow; `lastAction: {origin: aggregation, GOTO 5}`
  preserved. Ruled out empirically: the test suites themselves, env-based
  state-root escape, killed processes (incidents 2 and 3 had none).
  **First move (from handoff, endorsed): lifecycle-write attribution logging —
  pid + call site on every lifecycle-transition write — then re-run a pipeline
  and read the attribution. Instrument the actual lifecycle-write site, not the
  cleanup flow.** Prime suspects for that write: the collect-driven execution
  loop on long commands, and plugin hook traffic. Kept separate on purpose:
  `cleanupOrphanedActiveStack` (`packages/cli/src/helpers/active-runbook-cleanup.ts`,
  invoked from `terminal-command.ts`) only removes the top `defaultStack` entry
  and deletes that run's state file — it never writes `lifecycle: stopped`, so it
  cannot itself produce #536's symptom (a *surviving* state file marked
  `stopped`). It is the #518 deletion angle, a distinct mechanism; rule it in or
  out separately, not by watching the cleanup path for a lifecycle write.
- **#518 — `cleanupOrphanedActiveStack` can delete a valid active run.**
  Adjacent to #536 (Cluster A widened its blast radius by wiring it into every
  bare terminal command), but a **distinct failure mode**: deletion of a run's
  state file, not a `lifecycle: stopped` write. Investigate alongside #536 — the
  attribution logging will confirm or exclude it — but do not assume it is the
  #536 mechanism.
- **#534 — `rd prune` leaves pruned ids on `defaultStack`** (small; unblocks
  recovery ergonomics). Repair snippet exists in the handoff §5.
- **#531 — `rd status` doesn't surface claim ids** (small; unblocks
  orphaned-claim recovery). Pairs with tier-1 UX but is independently useful
  now.

**Exit criterion for R0:** a full `rundown:planning` pipeline with a
multi-minute inline verify gate completes without a spurious `stopped`, and the
attribution log shows every lifecycle write is accounted for.

### R1 — Cluster G tier 1: explicit targeting, always-strict (core + CLI)

The structural fix for #460. Depends on R0 only operationally (you need a
reliable pipeline to ship it), not on its code.

- Add a `run-controller` (or fold into an explicit-`--run`) `CallerEvidence`
  variant carrying the caller-named run id; map it to
  `trustedRunControllerContext(namedRunId)` in `actorContextFromEvidence`.
- **Remove the ambient grant:** `direct_cli` no longer maps to trust over the
  ambient `getActive()` target. Bare mutations / bare `collect` on a
  **delegating** run resolve to `actor_context_required` (already modelled;
  `command-target-resolver.ts:88-100`) and are refused with a message that
  tells the caller to pass `--run <id>`.
- CLI: add `--run <rd_…>` targeting to the mutating commands and `collect`;
  `readLifecycleCallerEvidence` (`packages/cli/src/helpers/caller-evidence.ts`)
  stops defaulting to `{ kind: 'direct_cli' }` for delegating targets.
- MCP surface: same targeting requirement (MCP already maps to `unknown`; the
  win is a coherent explicit-`--run` path rather than withheld-only).
- The Cluster A/E subprocess withhold sets become **defense-in-depth**, not the
  primary gate. Keep them; document the demotion.

**Non-negotiable:** always-strict. No first-delegation grace mode in core.

### R2 — Cluster G migration (skills, plugin hooks, docs, tests)

Mechanical but large. Sequence after R1 lands so the target API is fixed.

- Skills choreography: `running-runbooks`, `delegating-runbooks`,
  `executing-plans`, `writing-plans` — change orchestrator steps from bare
  `rd pass`/`rd collect` to `--run`-targeted forms; inline composition passes
  the `childRunId` the `inlineLaunch` event already carries.
- Plugin hook texts (claim-instruction injection), reference docs
  (`docs/reference/cli.md`, `docs/reference/security.md`), CLAUDE.md command
  guidance.
- CLI test-suite sweep: large parts assume bare-command trust; update to the
  explicit-targeting contract.

### R3 — Cluster F: plugin delegation closure (#470) — parallelisable

Package-isolated (plugin only); independent of R0–R2 code. Can run any time,
including in parallel with R1/R2 by a separate agent/worktree.

- File-lock the hook RMW loop; verify-before-consume; make the CLI fail
  **closed** on malformed `SubagentStop` payloads (`cli.ts` currently writes
  `{continue:false}` to stderr and exits `1` — non-blocking; the host honours
  a block only on stdout + exit 2, or the documented blocking channel).
- Flip the bug-pinning tests noted in the 2026-07-01 roadmap
  (`session.test.ts:180-199`, `cli.integration.test.ts:55-93`).

### R4 — Cluster G tier 2: capabilities

Adversarial hardening on top of tier 1's accident-proofing.

- **File the sibling-claim issue first** — *done*: it is **#540** ("claim ids
  are names, not capabilities"). (The handoff listed this as unfiled; it has
  since been filed. No new issue needed; start from #540.)
- `rd run` mints an orchestrator secret (delegation-token pattern: plaintext
  once, hash persisted); mutations on delegating runs require it.
- Upgrade claim ids from plaintext names to capabilities (hash-persisted),
  closing #540.

### R5 — Cluster H: architecture cleanup + docs debt

Non-urgent; do after the trust model is settled so docs describe the final
shape.

- Extract a core `linkDelegationChild` primitive (frame-scoped); dispatch from
  CLI (item 14). Consider relocating `cleanupOrphanedActiveStack` into core as
  part of the #518 fix if R0 hasn't already.
- Reconcile the delegation-lifecycle design doc: `issued→active→cancelled`
  with `closed` as a derived overlay, separated from session-level
  `stashed`/`pruned`.
- Docs debt sweep: **#538** (mcp.md §5.9/§5.10 complete/stop staleness — Cluster
  A doc debt), **#522** (`rd delegate` is idempotent confirm/re-issue),
  **#516** (`executing-plans` `--artifacts`).

### Parked pending Cluster G

- **#519** — parent-side liveness/lease detection of a dead child. Tier 2 may
  subsume part (a lease is a natural companion to the orchestrator secret);
  re-evaluate after R4.
- **#521** — inline-composed child left `status: active` after
  `runbook_completed`. Adjacent to #518; the normal-completion marking path is
  untouched by Cluster A. Revisit with R0/R5.
- **#520** — command-step tool-error/timeout (RD-999) unmapped third outcome.
  Out of the delegation-lifecycle line entirely (command-step execution, not
  delegation); schedule independently.

---

## 3. Open-issue inventory (verified against GitHub, 2026-07-03)

**C/D/E stack — now CLOSED on merge (2026-07-03):** #496, #500, #508, #499,
#509.

**R0 (pipeline reliability):** #536 (P0-operational), #518, #534, #531.

**Cluster G / #460 line:** #460 (P0, structural fix = R1/R4), #540 (tier 2),
#519 / #521 (parked).

**Cluster F:** #470.

**Docs debt (R5):** #538, #522, #516.

**Independent / out of line:** #520, #478, #498, #413/#525 (sandbox), #532
(verify lints outside change surface — tactical fix landed on C branch; proper
fix = scope checks to tracked files), #533 (shared-checkout branch race —
mitigate with explicit start-point + HEAD verification until fixed), **#541**
(mutation gate: `delegate.ts` / `lifecycle-seam-factory.ts` score 0.00% —
runtime-only coverage invisible to Stryker; **partially addressed** by merged
PR #542's static edge, issue still open for the proper fix).

**No unfiled items remain** — the previously-unfiled sibling-claim gap is now
#540.

---

## 4. Operational playbook (carry-forward; unchanged where it works)

**Process per cluster (user requirement):** full `rundown:planning` pipeline
end-to-end — plan (delegated write-plan child) → 4-dimension plan review +
collate (delegated) → implement (delegated, TDD, one atomic commit per task) →
code review (delegated) → address findings → verify → PR. File an issue for
every piece of friction (check existing first). Quality bar: strongly typed
idiomatic TS, invalid states unrepresentable, extensive tests, refactor; follow
`docs/internal/xstate-patterns.md` and the CLAUDE.md architectural principles.

**Dispatch pattern that works:** load `rundown:running-runbooks` +
`rundown:delegating-runbooks` (+ `writing-plans`/`executing-plans` per stage);
`rd run rundown:planning`; each DELEGATE step auto-issues tokens (read
`delegateFrontier` from the `step_entered` event); dispatch subagents with
`RD_CLAIM_TOKEN=<token>`, explicit instructions to pass `--claim-id` on every
command and STOP after reporting; `rd collect` after children report.

**Branch discipline (#533):** always
`git checkout -b <branch> <explicit-start-point>` and verify `git log -1`
before any code. Current stack tip: `cluster-e-collect-trust`. Do not start new
work off the stack until it merges to `main`.

**Known hazards (until R0 fixes them):**
- **#536 mid-verify stop** — expect it on every long verify gate. Recovery:
  preserve the run state file → `rd prune` → repair the stack (#534 snippet in
  the handoff §5) → `rd pass --step <n>` on the planning parent (explicit-step
  completion is the sanctioned operator recovery; verify was independently green
  each incident). **Preserve every state dump for the #536 investigation.**
- **Long inline verify:** `rd collect` on the review→verify edge runs
  `npm run verify` INLINE — give it a ≥10-minute timeout. A killed collect
  orphans the verify process tree.
- **Orphaned claimed child (dead session):** claim records live in
  `.rundown/session.json → claims`; adopt with `--claim-id <id>` from any
  session (#531 tracks surfacing this in `rd status`).
- **Env lint noise (#532):** if verify fails on markdown/spell for files you
  didn't touch, check for new untracked files (tactical ignore landed on the C
  branch).

---

## 5. Working-file locations

- C/D/E pipeline artifacts: `.rundown/work/.rd-<ctx>/…` — ContextIds
  `f5af6365` (C), `13ed53a2` (D), `412369aa` (E).
- #536 evidence dumps: session scratchpad
  (`stopped-execute-plan-{,D-,E-}evidence.json`) — **re-preserve into the #536
  issue before the scratchpad is lost**; three preserved state files
  (runs `rd_da8693649fcf…`, `rd_c29102df706c…`, `rd_8fce090b0044…`).
- Untracked-but-intentional at repo root: the 2026-07-03 handoff, the 2026-07-01
  roadmap, the Cluster A plan, this roadmap, `prcomment.md` (user's), `.serena/*`.

---

## 6. First actions for the next session

1. **C/D/E stack is merged** (2026-07-03; #535 → #537 → #539 all on `main`,
   closing #496/#500/#508/#499/#509 — confirmed against the merge commits). No
   merge action remains; start directly from `main`.
2. **Start R0.** Land #536 attribution logging first, run one pipeline, read the
   attribution, then fix #536+#518 together. Ship #534/#531 alongside.
3. Only after R0 gives a reliable pipeline, open **R1** (Cluster G tier 1) as a
   fresh `rundown:planning` run. Kick off **R3** (#470) in parallel if a second
   agent/worktree is available — it shares no code with R0/R1.
