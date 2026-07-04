# Delegation Lifecycle — Roadmap 3 (post-R0/R1)

- **Date:** 2026-07-04
- **Supersedes for direction:**
  `2026-07-03-delegation-lifecycle-roadmap-2.md`. Roadmap-2's per-cluster
  audit remains the traceable baseline; this roadmap records what R0 and R1
  actually shipped (which differs from roadmap-2's predictions in
  load-bearing ways), adds the governing decisions ratified during that work,
  and re-sequences the remainder.
- **Method:** trust the code, not prior docs. Every disposition below was
  verified against `main` at `e576cda6f` and the `r1-explicit-targeting`
  branch tip `6b42f024b` (PR #557, CI green, awaiting merge) on 2026-07-04.

---

## 0. State of the world

| Cluster | Scope | Issues | PR | State |
| ------- | ----- | ------ | --- | ----- |
| A–E | prior stack (see roadmap-2 §0) | — | #523/#528/#535/#537/#539 | merged |
| Hotfix | macOS Seatbelt probe execs nonexistent `/bin/true` | #544 | #548 | **merged** |
| R0 | pipeline reliability | #536, #518, #534, #531 | #554 | **merged** (2026-07-03) |
| R1 | Cluster G tier 1 — explicit targeting, always-strict | #460 | #557 | **CI green, awaiting merge** |

### R0 as shipped — and where it diverged from roadmap-2

Roadmap-2 prescribed durable lifecycle-write attribution logging (pid + call
site) as the first move, then a fix informed by the data. What happened:

1. The instrument **found the #536 writer on its first run**: the driving
   `rundown collect` process itself, via `waitForMachineEffects` — the
   `__execute-command` state carried `PENDING_MACHINE_EFFECT_TAG`, so the
   entire shell command was bounded by the 30s machine-effect budget; on
   timeout the effects-failure handler persisted `lifecycle: 'stopped'`
   mid-command with no transition events. Every multi-minute command step
   failed this way (3/3 historical reproduction explained).
2. **Fix:** command execution got its own `PENDING_COMMAND_EXECUTION_TAG`,
   waited on without a timeout (command duration semantics belong to the
   command layer, cf. #520); transient machine effects keep the 30s budget;
   a compiler invariant enforces the split per side-effect leaf
   (`packages/core/src/runbook/compiler.ts`, `actor-service.ts`).
3. **The attribution subsystem was then deliberately removed** (see §1
   decision 2). What remains is a `logger.debug('lifecycle-write', …)` line
   at the two persistence chokepoints (`RunbookStateManager.saveUnlocked` /
   `delete`) — `RUNDOWN_LOG_LEVEL=debug` re-arms the trail.

Also in R0: #518 (cleanup verifies the stack top is unusable before deleting;
recoverability classified by type via the new `LegacySnapshotError`), #534
(prune releases session ids before deleting state files; interrupted prune
converges), #531 (`claimId` on claimed delegations in `rd status` JSON).
Exit criterion met live: a multi-minute sandboxed verify gate completed with
no spurious stop.

### R1 as shipped (PR #557)

The structural fix for #460. On `main`+#557:

- **Every run-driving command names its authority.** Children: `--claim-id`
  (unchanged). Orchestrators: `--run <rd_…>` — selects the target run AND
  supplies the new `run_controller` `CallerEvidence` variant.
- **The ambient grant is gone.** `direct_cli` evidence grants run-controller
  trust only on `standalone`-classified targets
  (`packages/core/src/runbook/actor-context.ts`); on a delegation-exposed run
  it resolves to the `actor_context_required` refusal, whose remediation
  names both lanes and never echoes the target run id. The `--step`
  role-gate bypass is removed (a step name is not authority).
- **`classifyDelegationExposure`** (`delegation-exposure.ts`): pure,
  six clauses — authored DELEGATE substeps, open claims, collection-pending,
  sticky delegation history, inline parent-linkage, static inline
  runbook-list composition. Sticky: claim closure and prune cannot flip a
  run back to standalone. OR-composition and monotonic stickiness are
  property-tested.
- **`goto`** is gated behind a new `run-navigation` policy intent and routed
  through a core seam (`RunbookLifecycleCommandService.resolveRunNavigation`)
  — no parallel authorization path remains in the CLI.
- **`--run` resolution is single-sourced**
  (`SessionService.resolveRunningStackMember`); a named run must be a
  *running default-stack member*, which is one of the two walls keeping
  `--run` away from claimed children.
- MCP mutating tools take explicit `runId` (schema-refined mutually
  exclusive with `claimId`); the A/E subprocess withhold sets remain as
  defense-in-depth.
- 37 bundled scenario runbooks + `runbooks/scenario-suite.yaml` migrated to
  `${RUN_ID}` placeholders; `explicit-run-targeting.test.ts` pins the #460
  reproduction, the no-echo property, claimed-child unreachability, and the
  clause-six grandchild scenario.

**Dogfood evidence:** the flip refused the orchestrator's own bare
`rundown collect` mid-pipeline on the very pipeline that built it; `--run`
targeting drove that pipeline to completion.

---

## 1. Governing decisions (cumulative; none negotiable per-PR)

1. **Remove ambient trust; everyone names their authority; always-strict for
   agents** (user, 2026-07-03 — carried from roadmap-2 §1). Now **live
   code**, not a plan. No grace modes, no env escapes, no
   strict-on-first-delegation. Any ergonomic relaxation is a UX layer, never
   a trust-model carve-out.
2. **Attribution is domain identity, not process forensics** (user,
   2026-07-04). "Claim-id IS the attribution system." Durable attribution of
   mutations flows through claim ids and typed `CallerEvidence` — never
   through argv/pid/call-site capture. Forensic instrumentation is
   *scaffolding*: it ships with a demolition condition ("remove when X is
   diagnosed") and is torn down when the target bug dies. Corollary: never
   build a durable log that requires redacting user input; allowlist typed
   fields instead of denylisting captured strings.
3. **Plans label instrumentation as scaffolding or product at write time**
   (process rule from the R0 retrospective). Reviews check the label; the
   demolition condition is part of the plan.
4. **Derived inline-chain authority** (ratified via #557 review sign-off):
   `--run` naming any member of a contiguous inline composition chain
   carries controller authority over the walked-to root. Two walls: claimed
   children never join the default stack, and the chain walk stops at
   delegation boundaries. Documented in `docs/internal/architecture.md`.
5. **Names are not capabilities — yet.** Tier 1 is accident-proofing; run
   ids and claim ids are printed openly. The capability upgrade (hashes,
   secrets) is R4/#540, and when it lands it must convert every surface that
   prints claim ids (status output, any logs) in the same change.

---

## 2. Sequenced remaining work

**Through-line:** R2 is release-blocking for R1 and mechanical — do it
immediately. R3 stays package-isolated and parallelisable. SB (new) removes
a tax every sandboxed gate pays. R4 is the adversarial tier. R5 absorbs the
inline-lifecycle hygiene family that grew this session.

### R2 — Cluster G migration: skills, plugin hooks, docs (RELEASE-BLOCKING)

R1 made the shipped guidance actively wrong: the `running-runbooks` /
`delegating-runbooks` skills and plugin hook texts still teach bare
`rundown pass` / `rd collect` choreography that core now refuses on
delegating runs. This stopped being theoretical — the R1 pipeline itself hit
the refusal mid-run. **R1 must not ship in a release without R2.**

Scope (the R1 plan's Context carries the full handoff list):

- Skills: `running-runbooks`, `delegating-runbooks`, `executing-plans`,
  `writing-plans` — orchestrator steps become `--run`-targeted; the
  "capture the run id from `rundown run` / `runbookId`" step becomes
  explicit; inline-composition guidance updated (bare pass on inline units
  is refused when the composition is delegation-exposed).
- Plugin hook texts (claim-instruction injection) and
  `templates/`/pattern-runbook prose under `runbooks/` (the executable
  fixtures were already migrated in R1).
- Reference docs: `docs/reference/cli.md` (done for flags via generated
  help; prose sections need the choreography), `docs/reference/mcp.md`
  (**fold #538 here** — §5.9/§5.10 staleness), `docs/spec/cli-output.md`
  (new refusal codes), CLAUDE.md command guidance.
- Fold the small doc-debt issues: **#538**, **#522** (`rd delegate` is
  idempotent confirm/re-issue), **#516** (`executing-plans` `--artifacts`).
- The refusal-message UX already names both lanes; R2 is documentation
  convergence, not code.

### R3 — Cluster F: plugin delegation closure (#470) — parallelisable

Unchanged from roadmap-2: file-lock the hook RMW loop; verify-before-consume;
CLI fails **closed** on malformed `SubagentStop` payloads; flip the
bug-pinning tests. Package-isolated; can run in a worktree alongside R2.
(R1 touched only comments in the plugin hook file — no real overlap
remains.)

### SB — Sandbox/policy enforcement coherence (NEW cluster)

Filed from live failures during R0/R1; every sandboxed command step
(schema-validation gates, `npm run verify` gates) currently needs a
hand-built policy file to work. One cluster, three defects plus a decision:

- **#550** — `--allow-*` CLI grants never reach the OS sandbox profile
  (`policyToSandboxOptions` reads `getEffectiveRules`, which excludes
  `cliGrants`). Every denial message suggesting `--allow-*` is misleading
  until fixed.
- **#552** — grant paths are not realpath-resolved: `{tmp}` expands to the
  `/var/folders/…` symlink; Seatbelt matches `/private/var/folders/…`, so
  the default policy's tmp write grant never applies (all `mkdtemp` in
  sandboxed tests EPERM).
- **#549** — Seatbelt profile lacks `file-read-metadata` on `/Users`
  ancestors, breaking Node module resolution for any repo under a home
  directory.
- **Decision to take:** whether verify-style build gates should be runnable
  under the default policy (repo-write opt-in story) or whether runbooks
  carrying build steps must ship policy requirements. Until SB lands, the
  session workaround is a policy file granting `read /Users/**`,
  `write {repo}/**`, and `write /private/var/folders/**` +
  `/var/folders/**`.
- Add the integration matrix the three issues share: grant → actual syscall
  success per platform mapper.

### R4 — Cluster G tier 2: capabilities

- **#540** — claim ids become capabilities (plaintext once, hash persisted).
  Must simultaneously convert `rd status` claimId output (#531 surface) and
  any other printing surface (§1 decision 5).
- Orchestrator secret minted by `rd run` (delegation-token pattern);
  mutations on delegating runs require it — closes the "any same-cwd
  process can read the run id off status" residue of tier 1.
- Revisit **#519** (parent-side liveness/lease) — a lease is a natural
  companion to the orchestrator secret.

### R5 — Cluster H: inline lifecycle hygiene + architecture cleanup

The family grew this session; all three share one fix locus — inline-child
terminal reporting must route through the core lifecycle seam so ANY driver
(execution loop, goto, pass/fail, terminals) propagates identically:

- **#553** — goto-driven inline child completion does not propagate to the
  parent substep (parent stuck `running` on a completed child).
- **#556** — collect-driven inline stage terminal leaves the completed stage
  on the `defaultStack` (stale active top) until pushed over or pruned.
- **#521** — inline-composed child left `status: active` after
  `runbook_completed` (pre-existing member of the family).
- Item 14 (roadmap-1): extract a core `linkDelegationChild` primitive;
  `issued→active` link writes still live CLI-side.
- Reconcile the delegation-lifecycle design doc
  (`issued→active→cancelled` + derived `closed`, split from session-level
  `stashed`/`pruned`).
- Residual ambient lane ruling: `stash`/`pop`/`prune` remain ungated by R1
  (documented scope decision). Decide here whether they stay session-hygiene
  or join the named-authority model.

### Independent / recovery-surface debt (schedule opportunistically)

- **#545** — policy denial on a command step terminally stops a delegated
  run, auto-resolving the claim fail; **#520** — RD-999 tool-error/timeout
  unmapped. Same family: command-step outcomes beyond pass/fail need typed
  modelling with handler semantics (no silent mapping). Both burned real
  pipelines.
- **#547** — resolved-fail delegation with linked child is unrecoverable
  (RD-823 → "abort --force" → RD-812 catch-22); recovery cost a full
  pipeline restart in R0.
- **#546** (claim-time `{{Var}}` warning noise), **#551** (documented scoped
  Stryker invocation broken), **#532**, **#533**, **#541**, **#498**,
  **#478**, **#413**/**#525** (Linux sandbox line) — unchanged standing.

---

## 3. Open-issue inventory (verified against GitHub, 2026-07-04)

- **Closing with #557 merge:** #460.
- **Closed since roadmap-2:** #536, #518, #534, #531 (R0/#554); #544
  (hotfix #548).
- **R2:** #538, #522, #516 (folded).
- **R3:** #470.
- **SB:** #549, #550, #552.
- **R4:** #540, #519.
- **R5:** #553, #556, #521, item 14.
- **Independent:** #545, #520, #547, #546, #551, #532, #533, #541, #498,
  #478, #413, #525, #510 (verify state — may be closable).

---

## 4. Operational playbook (updated for the post-R1 world)

**Per-cluster process (unchanged, user requirement):** full
`rundown:planning` pipeline — delegated write-plan → 4-dimension plan
review and collate (delegated) → revise → delegated TDD implement (atomic
commit per task) → delegated code review → address → verify → PR. File an
issue for
every piece of friction (check existing first). The review stages keep
earning their keep: R1's plan review found 5 error-level findings including
a genuine classifier bypass; the code-review gate adversarially cleared a
trust-model deviation.

**Post-R1 dispatch choreography (BREAKING change from roadmap-2 §4):**

- `rundown run rundown:planning` → **capture the run id** (printed at start;
  `runbookId` on every event).
- Orchestrator commands are `--run`-targeted: `rd collect --run <id>`,
  `rd pass --run <id>`, `rd goto <n> --run <id>`. Bare mutating commands on
  the pipeline refuse with `ACTOR_CONTEXT_REQUIRED`.
- Children are unchanged: claim the token, `--claim-id` on every command,
  STOP after reporting.
- Read-only commands (`status`, `ls`) stay bare.

**Verify gates under sandbox (until SB lands):** run the collect that owns a
verify command step with a policy file granting `read /Users/**`,
`write {repo}/**`, `write /private/var/folders/**` and `/var/folders/**`;
give it a ≥10-minute timeout. The #536 kill window is gone — long commands
no longer self-destruct at 30s.

**Subagent operations (carried lessons):**

- Preserve full command output to files; **never pipe a pipeline-driving
  command through `tail`/`grep`** — it eats the event stream and launders
  exit codes (bit twice).
- Long-running implementer agents stall on silent long test runs: mandate
  one-file-at-a-time sweeps with per-file progress lines; on a stall, resume
  the same agent with a verified state recap (branch, commits, staged work)
  rather than redispatching cold.
- Typed lint (`eslint .` at root) needs `--max-old-space-size=8192` (pinned
  in the script since #557).
- Worktree-isolated agents may start from `main` rather than the feature
  branch tip — have them verify `git log -1` and fast-forward before work.

---

## 5. Working-file locations

- R1 pipeline artifacts: `.rundown/work/.rd-38435268/…` (plan
  `rd_603888853…/plan.json`, collated review, code reviews). R0:
  `.rundown/work/.rd-aaeee80f/…`.
- Consolidated human review of #557: `.work/PR-557-review-1.md` (user's).
- Untracked-but-intentional at repo root: `prcomment.md`, `.serena/*`.

---

## 6. First actions for the next session

1. **Merge #557** if not already merged (CI green; disposition comment
   carries the full review response).
2. **Start R2 immediately** as a `rundown:planning` pipeline — it is
   mechanical, release-blocking, and the choreography it documents is the
   one the pipeline itself now uses. Kick off **R3 (#470)** in a parallel
   worktree if a second agent is available.
3. Then **SB** (sandbox coherence) before the next heavy-verify cluster, or
   **R4** if adversarial hardening is the priority — SB first is
   recommended: it deletes a per-gate operational tax and its issues are
   already root-caused.
