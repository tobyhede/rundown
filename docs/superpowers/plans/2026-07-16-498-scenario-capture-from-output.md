# Scenario Capture-From-Output Seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scenario harness's fabricated-URI artifact seeding with a
single capture-from-command-output mechanism, retiring the `${ARTIFACT:}`
grammar and the `seed:` directive.

**Architecture:** A scenario that needs a pre-existing artifact runs a real
producer runbook fixture (`scenario-seed-artifacts.runbook.md`) as its first
command; the artifact is created through the genuine `ARTIFACTS` →
artifact-service → manifest path, and the already-existing
`${CAPTURE_ARTIFACT[_ARRAY]:<key>}` grammar hands its `rd://` URI to the
consuming command. The change is a new YAML fixture, one scenario migration, two
scenario deletions, deletions of the retired grammar, and **two deliberate
production additions**, both fail-fast guards rather than behaviour: a
**tombstone** that makes the retired grammar fail loudly rather than pass through
silently (Task 3), and a **quoting guard** that enforces the surviving array
form's shell-quoting requirement instead of leaving it to author convention
(Task 4).

**Tech Stack:** TypeScript (ESM, Node), Zod 4 schemas, Jest (`jest.config.mjs`,
`unstable_mockModule`), fast-check 4, pnpm workspaces, Rundown scenario harness.

**Design spec:**
[`docs/superpowers/specs/2026-07-16-scenario-capture-from-output-design.md`](../specs/2026-07-16-scenario-capture-from-output-design.md)
— read it first. It records the resolved design questions (the seeder is a
runbook fixture, not a CLI command; `seed:` is removed rather than reshaped and
its removal is *enforced*, not merely silent; `ScenarioContext` threading is a
deferred follow-up) and the rejected alternatives.

**Issue:** [#498](https://github.com/tobyhede/rundown/issues/498)

**Scope honesty — this is a partial fix, deliberately.** #498's "Why it's
fragile" lists four items. This plan lands items 2 (synthetic fidelity), 3 (two
placeholder grammars), and 4 (duplication of core). It does **not** land item 1
(command-text-layer splicing / splice-then-reparse): after this change
`${CAPTURE_ARTIFACT}` is still spliced into command text and re-parsed by
`parseRdCommandWithEnv` (`command-sequence.ts:1652` calls it on the spliced
string; `:349` runs `shellParse` on it), exactly as its four sibling grammars
are. Two reasons this tracks the issue's scope rather than shrinking it, and one
reason it is the right sequencing — all three in spec §1.3 and §3.3:

1. #498's own "Proposed direction" marks `ScenarioContext` **optional**, and none
   of its four acceptance criteria mention it. The plan discharges every stated
   criterion.
2. The deferred work's real cost was that the harness has **two injection
   mechanisms with different temporal models**. This change collapses that to
   one, which is most of what made the follow-up expensive (spec §3.3).
3. Fixing item 1 for artifacts alone, while `${TOKEN}`, `${CLAIM_ID}`,
   `${RUN_CLAIM_ID}`, and `${RUN_ID}` keep splicing strings, buys inconsistency
   rather than type safety.

**Bounding the residual hazard honestly.** The splice hazard that survives is
**one usability defect on one grammar**, consistent with #498's `P3: low` label.
Verified by execution (Task 4 records the transcript): the **scalar** form is
structurally immune — `assertSafeId` (`packages/core/src/paths.ts:34`) confines
ids to `[A-Za-z0-9._-]` and `rd://` URIs add only `/` and `:`, so no resolved
scalar can carry a shell metacharacter. Only the **array** form is exposed, and
only when the author omits single quotes. It then **throws**: the shell strips
the JSON's `"` as quoting, yielding the *unparseable* `[rd://a,rd://b]`, so the
`--artifacts-json` value fails to parse. It is **not** silent corruption — the
failure is loud, but it names a value the author never wrote. Task 4 converts
that convention into an enforced guard, which is what keeps the residual hazard
at zero for every command the harness will accept. Task 6 files the follow-up
issue that owns item 1 — deferred work with no issue number is deleted work.

## Global Constraints

- **`pnpm run verify` MUST pass before every push.** It runs format, spell, lint,
  and test.
- **Scenario changes require a build.** `pnpm run test:scenarios:raw` executes the
  built CLI from `dist/`. Always run `pnpm run build` first, or use
  `pnpm run test:scenarios` which builds for you.
- **Every verification grep MUST exclude build output.** The mandated build
  populates `packages/cli/dist/` and mutation runs populate
  `packages/cli/.stryker-tmp/sandbox-*/`. Both are gitignored (`.gitignore:44`)
  but present on disk, and a bare `grep -rn` over `packages/` returns ~49 hits
  from them alone. Always pass
  `--exclude-dir=dist --exclude-dir=.stryker-tmp --exclude-dir=node_modules`
  (or use `git grep`, which only sees tracked files).
- **Never migrate persisted runbook state.** Not applicable to this change (no
  state shape is touched). No compatibility shim for old `seed:` scenarios may be
  added — but note that "no shim" means **reject loudly**, not "accept silently".
  A retired grammar that passes through unnoticed is the failure mode #498 exists
  to prevent (see Task 3, Step 1).
- **The CLI is a thin wrapper.** Do not add a CLI command, flag, or helper that
  mints artifacts. Artifacts are produced only by running a runbook.
- **No fabricated `rd://` URIs and no hand-built manifest rows** — in harness
  code *or* authored in scenario YAML. Core owns `buildArtifactUri`
  (`packages/core/src/runbook/artifact-uri.ts:109-115`) and the manifest row
  shape.
- **TSDoc on all exported symbols** — description, `@param` for every parameter,
  `@returns` if non-void, `@throws` if it can throw.
- **CLI tests default to JSON output.** Do not add `--text` to scenario commands.
- Artifact keys must satisfy `assertSafeId`
  (`packages/core/src/paths.ts:34-41`): non-empty, not `.` or `..`, matching
  `SAFE_ID_PATTERN`.
- **Fixture runbooks ship to end users.** `packages/cli/scripts/copy-runbooks.js`
  copies `runbooks/**` into `packages/cli/dist/runbooks/`, and
  `packages/cli/package.json:11-14` publishes `files: ["dist"]`. Anything added
  under `runbooks/` appears in `rundown ls --all` as a **bundled** runbook for
  every installed user. Name new fixtures so a confused user is not invited to
  run them (hence `scenario-seed-artifacts`, not `seed-artifacts`).

---

### Task 1: Deterministic seeder fixture + migrate `consume-plan-artifact`

Adds the producer runbook that replaces `seedScenarioArtifacts`, and migrates the
repository's only `seed:` user onto it. The seeder emits **both** keys needed by
the artifact fixtures (`PlanPath` and `plan.json`) so the migrated assertion
stays byte-identical — that identity is the evidence the migration preserves
behaviour.

No harness change is needed to stage the seeder: `extractRunbookReferences`
(`packages/cli/src/helpers/command-sequence.ts:1459-1475`) scans command strings
for `*.runbook.md` and both harnesses stage what it finds
(`packages/cli/src/helpers/scenario-workflow.ts:372,405-409` and
`packages/cli/__tests__/integration/scenario-runner.test.ts:301-313`).

**Naming.** The fixture is `scenario-seed-artifacts.runbook.md`, not
`seed-artifacts.runbook.md`. It publishes to end users as a bundled runbook (see
Global Constraints); `seed-artifacts` reads like a general-purpose user-facing
utility, `scenario-seed-artifacts` reads like what it is. Existing fixtures
already ship, so this is not a new exposure — but it is a new, invitingly-named
one unless scoped. `copy-runbooks.js:44-51` throws on a duplicate relative path;
`find runbooks -name '*seed*'` currently returns nothing, so there is no
collision.

**Files:**

- Create: `runbooks/artifacts/scenario-seed-artifacts.runbook.md`
- Modify: `runbooks/artifacts/execute-plan.runbook.md:7-20`
- Test: the runbooks *are* the tests — exercised by
  `pnpm run test:scenarios:raw` and by
  `packages/cli/__tests__/integration/scenario-runner.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `runbooks/artifacts/scenario-seed-artifacts.runbook.md`, a runbook
  staged by filename reference from any scenario `commands:` entry. Running
  `rd run scenario-seed-artifacts.runbook.md --allow-all` appends exactly two
  manifest rows and terminates `COMPLETE`:
  - key `PlanPath` (alias `PlanPathSeed`), file content `{"seeded":true}`
  - key `plan.json` (alias `PlanJsonSeed`), file content `{"seeded":true}`

  No later task depends on the `plan.json` key (Task 2 deletes its only would-be
  consumer), but the seeder emits it anyway: it is the natural companion key, it
  costs one line, and it keeps the fixture usable by any future scenario that
  needs a seeded `plan.json` without reopening this design.

- [ ] **Step 1: Write the failing scenario — create the seeder fixture**

The seeder's own scenario (`seeds-two-artifacts`) is the failing test: it asserts
the seeder really produces both keys through the production path, with backing
files on disk.

Create `runbooks/artifacts/scenario-seed-artifacts.runbook.md`:

````markdown
---
name: scenario-seed-artifacts
description: Deterministic producer fixture that seeds artifacts through the real ARTIFACTS production path.
tags: [test, artifacts]
scenarios:
  seeds-two-artifacts:
    description: Seeder produces both seed artifact keys with backing files.
    commands:
      - rd run scenario-seed-artifacts.runbook.md --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: PlanPathSeed
          key: PlanPath
          runbook: scenario-seed-artifacts.runbook.md
          exists: true
        - at: "1"
          alias: PlanJsonSeed
          key: plan.json
          runbook: scenario-seed-artifacts.runbook.md
          exists: true
---
# Scenario Seed Artifacts

Producer fixture for scenarios that need a pre-existing artifact. Consumers run
this first and reference the produced artifact with
`${CAPTURE_ARTIFACT:<key>}` — never by fabricating an `rd://` URI.

## 1. Seed artifacts

- ARTIFACTS
  - PlanPathSeed "PlanPath"
  - PlanJsonSeed "plan.json"
- PASS COMPLETE

```bash
printf '{"seeded":true}' > "{{ path PlanPathSeed }}"
printf '{"seeded":true}' > "{{ path PlanJsonSeed }}"
```
````

- [ ] **Step 2: Run the seeder scenario to verify it passes**

Run:

```bash
pnpm run build && pnpm run test:scenarios:raw
```

Expected: PASS, including `scenario-seed-artifacts.runbook.md` /
`seeds-two-artifacts`. Both `exists: true` assertions must match — that is the
proof the seeder wrote real files at the paths core projected, rather than at a
hand-derived path.

If `exists: false` is reported, the `{{ path ... }}` projection is not resolving;
compare against the working producer at
`runbooks/artifacts/artifact-variable-write-plan.runbook.md:65-73`.

- [ ] **Step 3: Commit the seeder**

```bash
git add runbooks/artifacts/scenario-seed-artifacts.runbook.md
git commit -m "test(scenarios): add deterministic artifact seeder fixture (#498)"
```

- [ ] **Step 4: Migrate `consume-plan-artifact` off `seed:` / `${ARTIFACT:}`**

In `runbooks/artifacts/execute-plan.runbook.md`, replace the frontmatter
`scenarios:` block (lines 7-20) so it runs the seeder and captures its output.
The `expect:` block is **unchanged** — `key: PlanPath` still holds because the
seeder emits that exact key.

Replace:

```yaml
scenarios:
  consume-plan-artifact:
    description: a boundary --artifacts value is consumed by a naked ARTIFACTS step
    seed:
      - artifact: PlanPath
    commands:
      - "rd run execute-plan.runbook.md --artifacts PlanPath=${ARTIFACT:PlanPath}"
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: PlanPath
          key: PlanPath
          exists: true
```

With:

```yaml
scenarios:
  consume-plan-artifact:
    description: a boundary --artifacts value is consumed by a naked ARTIFACTS step
    commands:
      - rd run scenario-seed-artifacts.runbook.md --allow-all
      - "rd run execute-plan.runbook.md --artifacts PlanPath=${CAPTURE_ARTIFACT:PlanPath}"
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: PlanPath
          key: PlanPath
          exists: true
```

**Why the assertion still binds to the consumer, precisely.** The consuming step
is a *naked* `ARTIFACTS` alias fed an exact `rd://` URI: it surfaces the
**injected record's** key (`PlanPath`) while the record's **provenance** stays
the *producer's* (the seeder's runbook path). So `key: PlanPath` matches for the
right reason, but do not reach for a `runbook:` filter to disambiguate under a
mistaken model of what it filters: **`runbook:` filters the emitting event's
runbook, not the record's provenance.** This entry deliberately carries **no**
`runbook:` filter, and that is what makes it insensitive to the seeder's
provenance appearing on the row. Disambiguation here comes from `alias`: the
seeder's step exposes `PlanPathSeed` / `PlanJsonSeed`, never `PlanPath`, so the
first `step_entered` at `1` with alias `PlanPath` is unambiguously the
consumer's.

- [ ] **Step 5: Run the migrated scenario to verify it passes**

Run:

```bash
pnpm run build && pnpm run test:scenarios:raw
```

Expected: PASS for `execute-plan.runbook.md` / `consume-plan-artifact`.

Then verify the second harness agrees:

```bash
pnpm --filter @rundown-org/cli exec jest __tests__/integration/scenario-runner.test.ts
```

Expected: PASS.

A `Command references ${CAPTURE_ARTIFACT...} but no resolveCapturedArtifact
resolver was provided` failure means a harness lost its resolver wiring — both
harnesses wire it today (`packages/cli/src/helpers/scenario-workflow.ts:488-489`,
`packages/cli/__tests__/integration/scenario-runner.test.ts:375-376`).

- [ ] **Step 6: Commit**

```bash
git add runbooks/artifacts/execute-plan.runbook.md
git commit -m "test(scenarios): migrate consume-plan-artifact to capture-from-output (#498)"
```

---

### Task 2: Delete two scenarios that test nothing

Two scenarios are deleted rather than migrated. Both deletions are removals of
**false coverage signal**, and the commit message must say what unique coverage
is lost: in both cases, none.

**2a. `direct-uri-input`** (`artifact-variable-review-plan.runbook.md:8-21`) is
`seedScenarioArtifacts` transcribed into YAML: its `node -e` one-liner
(`:12`) hardcodes `run='rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'` and
`ctx='producer-context'`, concatenates `'rd://artifacts/'+ctx+'/'+run+'/'+key`,
re-derives `.rundown/work/.rd-<ctx>/<run>` by hand, and writes a manifest row
literal. Deleting `seedScenarioArtifacts` while leaving this transcription in
place would satisfy the issue's letter and none of its intent (spec §1.2).

But migrating it is not the answer either. **Migrated, it becomes an exact
duplicate.** Point it at a real producer and it is character-for-character
`review-plan-uri-input`
(`runbooks/artifacts/artifact-variable-write-plan.runbook.md:19-31`) apart from
*which* producer runs first — and post-migration both producers are "a real
producer runbook", a distinction with no behavioural content. Its entire reason
to exist was exercising a **fabricated** row against the consume path. Delete the
fabrication and the scenario has no remaining job. Delete it.

Note this does **not** transfer from spec §3.1's "don't reuse
`artifact-variable-write-plan` as the seeder" reasoning, which is sound but is
about **Task 1**: there, reuse would force `consume-plan-artifact`'s
`key: PlanPath` assertion to change (write-plan emits only `plan.json`, and the
injected record's key wins), destroying the byte-identical-assertion evidence.
Nothing analogous is at stake in Task 2 — the scenario is not being preserved,
it is being retired.

**2b. `review-plan-cross-context-uri-input`**
(`artifact-variable-write-plan.runbook.md:33-45`) is **pre-existing duplication
this plan initially missed**. It is byte-identical to `review-plan-uri-input`
(`:19-31`) — same two commands, same `expect` block, zero differences outside the
`description:` string. It has never tested cross-context anything; both of its
`rd run` invocations execute in the *same* context, which is exactly why it is
identical.

**Decision: delete it.** The alternative — give it a genuinely distinct producer
context — is rejected on two grounds. First, there is no scenario-layer
affordance to force a distinct context: no `--context` flag exists on any command
(`grep -rn "'--context" packages/cli/src` returns nothing), so making the
scenario honest requires new production surface, i.e. building a feature to serve
a test. Second, and decisively, **the behaviour it purports to cover is already
pinned where it actually lives**: `resolveCapturedArtifactFromManifest`'s
cross-context recency and ambiguity handling is unit-tested at
`packages/cli/__tests__/helpers/scenario-artifacts.test.ts:54` (cross-context
same-timestamp scalar pick throws ambiguous), `:74` (genuinely-latest URI wins
across contexts), and `:95` (array form returns all cross-context collisions).
Those tests can construct the multi-context manifest the scenario layer cannot.
A scenario whose name claims coverage its body does not provide is worse than no
scenario: it will be cited as evidence in a review.

**Files:**

- Modify: `runbooks/artifacts/artifact-variable-review-plan.runbook.md:8-21`
  (delete `direct-uri-input`)
- Modify: `runbooks/artifacts/artifact-variable-write-plan.runbook.md:33-45`
  (delete `review-plan-cross-context-uri-input`)

**Interfaces:**

- Consumes: nothing. (Notably **not** the seeder — nothing here is migrated onto
  it.)
- Produces: nothing later tasks rely on. After this task, no runbook references
  `${ARTIFACT:}`, which is Task 3's precondition.

- [ ] **Step 1: Delete `direct-uri-input`**

In `runbooks/artifacts/artifact-variable-review-plan.runbook.md`, delete lines
8-21 in their entirety — the `direct-uri-input:` key and its whole body:

```yaml
  direct-uri-input:
    description: Review-plan receives an exact rd:// Plan input from a seeded manifest row.
    commands:
      - >-
        node -e "const fs=require('fs'),p=require('path');const run='rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',ctx='producer-context',key='plan.json';const dir=p.join('.rundown','work','.rd-'+ctx,run);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,key),'{}');const row={uri:'rd://artifacts/'+ctx+'/'+run+'/'+key,runId:run,contextId:ctx,runbook:{source:'project',path:'artifact-variable-write-plan.runbook.md'},key,timestamp:'2026-05-25T00:00:00.000Z'};fs.writeFileSync(p.join('.rundown','work','.rd-'+ctx,'manifest.jsonl'),JSON.stringify(row)+'\n');"
      - rd run artifact-variable-review-plan.runbook.md --artifacts Plan=${CAPTURE_ARTIFACT:plan.json} --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: Plan
          key: plan.json
          runbook: artifact-variable-review-plan.runbook.md
          exists: true
```

`scenarios:` (line 7) keeps `forged-file-record-rejected` as its sole remaining
entry, so the `scenarios:` key itself stays.

**Leave `forged-file-record-rejected` (lines 22-32) untouched.** Its `node -e`
looks like the same fabrication but is not: it writes an **intentionally forged**
artifact record as a *public input* in order to assert the input channel
**rejects** it (`expect.errors[0].error: 'Artifact record input for "Plan" is not
trusted'`). The forgery *is* the assertion. Replacing it with a real producer
would delete the test.

- [ ] **Step 2: Delete `review-plan-cross-context-uri-input`**

In `runbooks/artifacts/artifact-variable-write-plan.runbook.md`, delete lines
33-45 in their entirety:

```yaml
  review-plan-cross-context-uri-input:
    description: Review-plan receives a producer-context exact rd:// Plan input and treats it as the producer artifact.
    commands:
      - rd run artifact-variable-write-plan.runbook.md --allow-all
      - rd run artifact-variable-review-plan.runbook.md --artifacts Plan=${CAPTURE_ARTIFACT:plan.json} --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: Plan
          key: plan.json
          runbook: artifact-variable-review-plan.runbook.md
          exists: true
```

Leave `write-plan-produces-artifact` (`:5-17`), `review-plan-uri-input`
(`:19-31`), and `bundled-write-review-collate-artifacts` (`:47-61`) untouched.
`review-plan-uri-input` is the surviving twin and retains 100% of the deleted
scenario's coverage.

- [ ] **Step 3: Confirm the surviving twin is genuinely identical before trusting
      the deletion**

Do not take the plan's word for it. Run:

```bash
git show HEAD:runbooks/artifacts/artifact-variable-write-plan.runbook.md \
  | sed -n '21,31p' > /tmp/rd498-a.txt
git show HEAD:runbooks/artifacts/artifact-variable-write-plan.runbook.md \
  | sed -n '35,45p' > /tmp/rd498-b.txt
diff /tmp/rd498-a.txt /tmp/rd498-b.txt
```

Expected: no output (empty diff) — the two scenario bodies, excluding their
`description:` lines, are identical. If the diff is non-empty, **stop**: the
deletion rationale does not hold and the scenario carries real coverage. Report
the difference rather than proceeding.

- [ ] **Step 4: Run both harnesses to verify nothing else regressed**

Run:

```bash
pnpm run build && pnpm run test:scenarios:raw
```

Expected: PASS. `direct-uri-input` and `review-plan-cross-context-uri-input` no
longer appear in the output; every other scenario still passes.

```bash
pnpm --filter @rundown-org/cli exec jest __tests__/integration/scenario-runner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Verify no fabricated URIs remain in runbooks**

Run:

```bash
grep -rn --exclude-dir=dist --exclude-dir=.stryker-tmp --exclude-dir=node_modules \
  "rd://artifacts/" runbooks/
```

Expected: no output. Any hit is a surviving hand-built URI.

```bash
grep -rn --exclude-dir=dist --exclude-dir=.stryker-tmp --exclude-dir=node_modules \
  "manifest.jsonl" runbooks/
```

Expected: no output.

- [ ] **Step 6: Commit**

The commit message must name the coverage each deletion gives up, so a future
reader does not have to re-derive it:

```bash
git add runbooks/artifacts/artifact-variable-review-plan.runbook.md \
        runbooks/artifacts/artifact-variable-write-plan.runbook.md
git commit -m "test(scenarios): delete two artifact scenarios that test nothing (#498)" -m \
"direct-uri-input existed to exercise a *fabricated* manifest row against the
consume path. With fabrication retired, a migrated version would be
character-for-character review-plan-uri-input apart from which real producer runs
first. Unique coverage lost: none.

review-plan-cross-context-uri-input is already byte-identical to
review-plan-uri-input (same commands, same expect; only the description differs).
It has never exercised cross-context resolution — both runs share one context,
and no --context flag exists to separate them. That behaviour is covered where it
can actually be constructed, in packages/cli/__tests__/helpers/scenario-artifacts.test.ts
lines 54, 74 and 95. Unique coverage lost: none."
```

---

### Task 3: Retire the `${ARTIFACT:}` grammar and `seed:` directive, and make their return fail loudly

With both users gone, remove the fabricating code and the second grammar. This is
the task that discharges the issue's core acceptance criteria.

**The deletion is not sufficient on its own, and this is the crux of the task.**
`ScenarioSchema` (`packages/cli/src/schemas/scenarios.ts:143-185`) is
`z.object({...}).refine(...).refine(...)` with no `.strict()`, on Zod 4
(`packages/cli/package.json:51`, `"zod": "^4.4.3"`), where unknown keys are
**stripped by default**. So a naive delete produces this:

1. A scenario still carrying `seed:` parses **successfully** — `seed:` is
   silently dropped.
2. Its command still carrying `${ARTIFACT:PlanPath}` has no substituter left, so
   the literal text `${ARTIFACT:PlanPath}` is passed through to `--artifacts`.
3. The run fails with a confusing `INVALID_ARTIFACT_INPUT`.

That is **verbatim** the failure described in #498's "Why it's fragile" §1 — the
defect the issue exists to prevent. A silent-stripping deletion re-creates it.

The codebase already rejects exactly this pattern one function away:
`CAPTURE_ARTIFACT_PLACEHOLDER` (`command-sequence.ts:542`, used at
`command-sequence.ts:1642`) exists for no other purpose than ensuring an
unresolvable capture placeholder **throws** rather than leaking into the executed
command. The retired grammar deserves the same treatment.

**This is a tombstone, not a shim.** CLAUDE.md's no-migration rule forbids
compatibility shims, fallback parsers, and warning-only adapters — code that
keeps old input *working*. A detector that makes old input **fail with a message
naming the retirement** is the opposite: it is the "detect invalid input and
prompt explicit user action" behaviour the rule mandates. Failing loudly *serves*
the no-migration rule.

Two layers, covering two different surfaces:

- **Schema layer** (`z.strictObject`): rejects the `seed:` *field* at scenario
  load, with Zod's own unrecognized-key error.
- **Command layer** (`RETIRED_ARTIFACT_PLACEHOLDER`): rejects the `${ARTIFACT:}`
  *grammar* in command text, with a message naming #498 and pointing at the
  survivor. A scenario could carry the placeholder without ever carrying `seed:`,
  so the schema layer does not subsume this.

**Files:**

- Modify: `packages/cli/src/helpers/scenario-artifacts.ts:1-71` (delete
  `seedScenarioArtifacts` and its now-unused imports; keep
  `resolveCapturedArtifactFromManifest`)
- Modify: `packages/cli/src/helpers/command-sequence.ts:454-479` (delete
  `substituteArtifactUris`), `:542` (add `RETIRED_ARTIFACT_PLACEHOLDER`
  alongside), `:1642` (add the throw)
- Modify: `packages/cli/src/schemas/scenarios.ts:1,113-141,143-149` (delete
  `ScenarioSeedSchema`, `ScenarioSeed`, the `seed` field, and the now-unused core
  import; make the object strict)
- Modify: `packages/cli/src/helpers/scenario-workflow.ts:57,65-68,454-459`
- Test: `packages/cli/__tests__/helpers/command-sequence.test.ts:14,882-908`
- Test: `packages/cli/__tests__/schemas/scenarios.test.ts:4,134-188`
- Test: `packages/cli/__tests__/helpers/scenario-workflow.test.ts:115`
- Test: `packages/cli/__tests__/integration/scenario-runner.test.ts:37,46,336-355`

**Interfaces:**

- Consumes: Tasks 1 and 2 — no scenario may reference `seed:` or `${ARTIFACT:}`
  when this task runs, or the strict schema will reject it at load.
- Produces: `packages/cli/src/helpers/scenario-artifacts.ts` exporting exactly
  two symbols — `ScenarioArtifactLocation` (interface, `{ readonly cwd: string }`)
  and `resolveCapturedArtifactFromManifest(location: ScenarioArtifactLocation,
  key: string, asArray: boolean): Promise<string>`, both unchanged in signature.
  `packages/cli/src/schemas/scenarios.ts` no longer exports `ScenarioSeedSchema`
  or `ScenarioSeed`, and `Scenario` no longer carries a `seed` property.
  `command-sequence.ts` gains a module-private `RETIRED_ARTIFACT_PLACEHOLDER`
  (not exported; exercised through `executeCommandSequence`).

- [ ] **Step 1: Write the failing tests — assert both retirements are *rejected***

Two real negative tests. Neither asserts Zod's default stripping — asserting that
`seed:` is silently dropped would institutionalise the exact outcome this task
must prevent.

In `packages/cli/__tests__/schemas/scenarios.test.ts`, replace the whole
`describe('ScenarioSeedSchema', ...)` block (lines 134-188) with:

```typescript
describe('retired seed directive (#498)', () => {
  it('rejects a scenario still carrying the retired seed field', () => {
    const result = ScenarioSchema.safeParse({
      seed: [{ artifact: 'PlanPath' }],
      commands: ['rd run scenario-seed-artifacts.runbook.md --allow-all'],
      result: 'COMPLETE',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('seed');
    }
  });

  it('still accepts a scenario with no seed field', () => {
    const result = ScenarioSchema.safeParse({
      commands: ['rd run scenario-seed-artifacts.runbook.md --allow-all'],
      result: 'COMPLETE',
    });
    expect(result.success).toBe(true);
  });
});
```

Then remove `ScenarioSeedSchema` from the import block at the top of the file
(line 4).

In `packages/cli/__tests__/helpers/command-sequence.test.ts`, replace the whole
`describe('substituteArtifactUris', ...)` block (lines 882-908) with:

```typescript
describe('retired ${ARTIFACT:} grammar (#498)', () => {
  it('throws naming the retirement rather than passing the placeholder through', async () => {
    await expect(
      executeCommandSequence({
        commands: ['rd run x.runbook.md --artifacts PlanPath=${ARTIFACT:PlanPath}'],
        cwd: process.cwd(),
        execute: () => {
          throw new Error('command must never be executed with a retired placeholder');
        },
      }),
    ).rejects.toThrow(/\$\{ARTIFACT:\}.*retired.*#498/s);
  });

  it('does not mistake the surviving ${CAPTURE_ARTIFACT:} grammar for the retired one', async () => {
    const resolved = await substituteCapturedArtifacts(
      'rd run x --artifacts Plan=${CAPTURE_ARTIFACT:plan.json}',
      async () => 'rd://artifacts/c/rd_1/plan.json',
    );
    expect(resolved).toBe('rd run x --artifacts Plan=rd://artifacts/c/rd_1/plan.json');
  });
});
```

The second test is the guard on the guard: `RETIRED_ARTIFACT_PLACEHOLDER` must
not fire on `${CAPTURE_ARTIFACT:…}`, whose text contains `ARTIFACT:` but not
`${ARTIFACT:`.

Then remove `substituteArtifactUris` from the import block (line 14) — leave
`substituteCapturedArtifacts` and `executeCommandSequence`, which are already
imported there.

> **Note for the implementer:** `executeCommandSequence`'s exact option object
> differs across call sites. Copy the option shape from an existing
> `executeCommandSequence` test in the same file rather than trusting the
> illustrative `cwd`/`execute` fields above; only the `commands` entry and the
> `rejects.toThrow` matcher are load-bearing.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
pnpm --filter @rundown-org/cli exec jest __tests__/schemas/scenarios.test.ts \
  __tests__/helpers/command-sequence.test.ts
```

Expected: FAIL.

- `rejects a scenario still carrying the retired seed field` fails with
  `expect(false).toBe(false)` receiving `true` — `ScenarioSchema` still declares
  `seed` and accepts it.
- `throws naming the retirement...` fails because `substituteArtifactUris` still
  exists and no retirement detector is wired.

(A `ScenarioSeedSchema is not exported` / `substituteArtifactUris is not
exported` TS error also counts as the expected failure if the import edits are
applied first.)

- [ ] **Step 3: Delete `ScenarioSeedSchema`, `ScenarioSeed`, and the `seed` field,
      and make `ScenarioSchema` strict**

In `packages/cli/src/schemas/scenarios.ts`:

Delete the entire block at lines 113-141 — the `ScenarioSeedSchema` TSDoc, the
schema, and the `ScenarioSeed` type export.

Delete the `seed` field from `ScenarioSchema` (lines 148-149):

```typescript
    /** Optional manifest rows to seed before commands run (exposes ${ARTIFACT:<name>}) */
    seed: z.array(ScenarioSeedSchema).optional(),
```

Change the object constructor (line 143-144) from `z.object` to `z.strictObject`:

```typescript
export const ScenarioSchema = z
  .strictObject({
```

Add this TSDoc line to the block already documenting `ScenarioSchema`
(`scenarios.ts:105-112`), immediately before its closing ` */`:

```
 * Strict: unknown keys are rejected, not stripped. The retired `seed:` directive
 * (#498) must fail at load rather than be silently dropped — a dropped `seed:`
 * leaves its `${ARTIFACT:…}` command text unsubstituted and surfaces as a
 * confusing `INVALID_ARTIFACT_INPUT` at run time.
```

Delete line 1 entirely — `isValidVariableName` and `VALID_IDENTIFIER` were used
only by `ScenarioSeedSchema`:

```typescript
import { isValidVariableName, VALID_IDENTIFIER } from '@rundown-org/core';
```

`import { z } from 'zod';` stays.

`z.strictObject` is used rather than the deprecated `.strict()` method because
`.strict()` cannot be chained after the two `.refine(...)` calls (they return a
non-object schema type), and `z.strictObject` is the Zod 4 idiom. The repo's
existing strict schemas (`packages/claude-code-plugin/src/plan-schema.ts`) use
the older `.strict()` on unrefined objects; do not copy that form here.

- [ ] **Step 4: Run the schema test to verify it passes**

Run:

```bash
pnpm --filter @rundown-org/cli exec jest __tests__/schemas/scenarios.test.ts
```

Expected: PASS.

Then run the whole scenario suite — strictness is repo-wide now:

```bash
pnpm run build && pnpm run test:scenarios:raw
```

Expected: PASS. If a scenario **unrelated to `seed:`** now fails to parse, do not
weaken the schema: strictness has surfaced a genuine latent typo in that
scenario's YAML that stripping was hiding. Fix the typo and note it in the commit
body.

- [ ] **Step 5: Delete `substituteArtifactUris` and add the retirement tombstone**

In `packages/cli/src/helpers/command-sequence.ts`, delete lines 454-479 — the
TSDoc and the function:

```typescript
export function substituteArtifactUris(
  cmd: string,
  artifactUris: Readonly<Record<string, string | undefined>>,
): string {
  return cmd.replace(/\$\{ARTIFACT:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match: string, name: string) => {
    const uri = artifactUris[name];
    if (uri === undefined) {
      throw new Error(
        `Artifact placeholder ${match} references an unseeded artifact (seed it via the scenario "seed" directive)`,
      );
    }
    return uri;
  });
}
```

Immediately after `CAPTURE_ARTIFACT_PLACEHOLDER` (`command-sequence.ts:542`), add
its tombstone counterpart:

```typescript
/**
 * Non-global detector for the **retired** `${ARTIFACT:<name>}` grammar (#498).
 *
 * `${ARTIFACT:…}` and its `seed:` directive were removed in favour of a single
 * capture-from-output mechanism. Without this detector the retired placeholder
 * has no substituter left, so it would pass through verbatim into `--artifacts`
 * and surface as an opaque `INVALID_ARTIFACT_INPUT` — the precise confusion the
 * retirement exists to prevent. This is a tombstone, not a compatibility shim:
 * it makes the retired grammar fail loudly and name its replacement, rather than
 * keeping it working.
 *
 * Deliberately matches `[^}]+` rather than the retired grammar's narrower
 * identifier pattern, so a *malformed* retired placeholder is caught too. It
 * cannot match `${CAPTURE_ARTIFACT…}`, whose text contains `ARTIFACT:` but never
 * the required `${` immediately before it.
 */
const RETIRED_ARTIFACT_PLACEHOLDER = /\$\{ARTIFACT:[^}]+\}/;
```

In `executeCommandSequence`, immediately **before** the existing
`CAPTURE_ARTIFACT_PLACEHOLDER` check (`command-sequence.ts:1642`), add:

```typescript
    // The `${ARTIFACT:<name>}` grammar and its `seed:` directive were retired in
    // #498. No substituter remains, so fail here and name the replacement rather
    // than letting the raw placeholder leak into the executed command.
    if (RETIRED_ARTIFACT_PLACEHOLDER.test(tokenSubstituted)) {
      throw new Error(
        `Command uses the retired \${ARTIFACT:} grammar, removed in #498: ${tokenSubstituted}\n` +
          `Run a producer runbook first and use \${CAPTURE_ARTIFACT:<key>} to capture its artifact ` +
          `(see runbooks/artifacts/scenario-seed-artifacts.runbook.md).`,
      );
    }
```

It must run before the capture check so the more specific diagnosis wins, and
after token substitution so it sees the final command text.

Update the TSDoc on `substituteCapturedArtifacts` (`command-sequence.ts:493-507`)
— its comparison to the deleted grammar is now dangling. Change:

```
 * `${CAPTURE_ARTIFACT:<key>}` is replaced by the `rd://` URI of the most recent
 * manifest row for `<key>`; `${CAPTURE_ARTIFACT_ARRAY:<key>}` is replaced by a
 * JSON array of all such URIs. Unlike `${ARTIFACT:…}` (pre-seeded), these are
 * resolved at execution time from rows a prior command produced, so a scenario
 * can hand a produced artifact to a later run via `--artifacts` /
 * `--artifacts-json`. Scenario-harness only; the resolver reads the manifest.
```

To:

```
 * `${CAPTURE_ARTIFACT:<key>}` is replaced by the `rd://` URI of the most recent
 * manifest row for `<key>`; `${CAPTURE_ARTIFACT_ARRAY:<key>}` is replaced by a
 * JSON array of all such URIs. This is the sole artifact grammar: values are
 * resolved at execution time from rows a prior command actually produced, so a
 * scenario hands a real produced artifact to a later run via `--artifacts` /
 * `--artifacts-json`. A scenario needing a pre-existing artifact runs a producer
 * runbook first (see `runbooks/artifacts/scenario-seed-artifacts.runbook.md`)
 * rather than fabricating a URI. Scenario-harness only; the resolver reads the
 * manifest.
```

- [ ] **Step 6: Run the command-sequence test to verify it passes**

Run:

```bash
pnpm --filter @rundown-org/cli exec jest __tests__/helpers/command-sequence.test.ts
```

Expected: PASS — including both tests from Step 1.

- [ ] **Step 7: Delete `seedScenarioArtifacts` and its now-unused imports**

In `packages/cli/src/helpers/scenario-artifacts.ts`, delete lines 30-71 — the
TSDoc, `seedScenarioArtifacts`, and the `WORK_PATH`-adjacent seed code. Keep
`const WORK_PATH = '.rundown/work';` (line 28) —
`resolveCapturedArtifactFromManifest` uses it at lines 109-111.

Replace the import block (lines 13-20):

```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendArtifactManifestRecordSync,
  assertRunId,
  readAllArtifactManifestRecords,
} from '@rundown-org/core';
import type { Scenario } from '../schemas/scenarios.js';
```

With:

```typescript
import { readAllArtifactManifestRecords } from '@rundown-org/core';
```

> The implementer must keep whichever of `join` / `node:path` survives if
> `resolveCapturedArtifactFromManifest` still uses it at lines 109-111 — verify
> against the file rather than deleting the import blind. TypeScript's
> `noUnusedLocals` will flag an over-deletion at build; a missing import is a
> compile error either way.

Replace the module TSDoc (lines 1-11):

```typescript
/**
 * Scenario-harness artifact capture resolution.
 *
 * Resolves the `${CAPTURE_ARTIFACT[_ARRAY]:<key>}` grammar — the harness's sole
 * artifact mechanism — for both the in-process jest scenario runner and the
 * standalone `rd scenario run` command, so the two harnesses share one
 * implementation instead of drifting. A scenario that needs a pre-existing
 * artifact runs a real producer runbook first (see
 * `runbooks/artifacts/scenario-seed-artifacts.runbook.md`) and captures the
 * `rd://` URI that producer emitted; the harness never fabricates a URI or
 * hand-writes a manifest row. Scenario-harness only — never part of runbook
 * execution.
 *
 * @module helpers/scenario-artifacts
 */
```

- [ ] **Step 8: Unwire seeding from the `rd scenario run` workflow**

In `packages/cli/src/helpers/scenario-workflow.ts`:

Remove `substituteArtifactUris,` from the `./command-sequence.js` import list
(line 57).

Replace the `./scenario-artifacts.js` import (lines 65-68):

```typescript
import {
  resolveCapturedArtifactFromManifest,
  seedScenarioArtifacts,
} from './scenario-artifacts.js';
```

With:

```typescript
import { resolveCapturedArtifactFromManifest } from './scenario-artifacts.js';
```

Delete the seeding block (lines 454-459):

```typescript
    // Seed any artifacts declared by the scenario's `seed:` directive, then expose
    // each seeded row's rd:// URI as a ${ARTIFACT:<name>} substitution token, so a
    // command can consume a pre-seeded artifact via --artifacts. This mirrors the
    // in-process jest harness; both share the helpers in ./scenario-artifacts.js.
    const artifactUris = seedScenarioArtifacts(scenario, { cwd: tmpDir });
    const commands = scenario.commands.map((cmd) => substituteArtifactUris(cmd, artifactUris));
```

Then change the `executeCommandSequence` call (line 466) from `commands,` to:

```typescript
      commands: scenario.commands,
```

In `packages/cli/__tests__/helpers/scenario-workflow.test.ts`, delete line 115
from the mock factory:

```typescript
  substituteArtifactUris: actualCommandSequence.substituteArtifactUris,
```

- [ ] **Step 9: Unwire seeding from the jest scenario runner**

In `packages/cli/__tests__/integration/scenario-runner.test.ts`:

Remove `substituteArtifactUris,` from the `../../src/helpers/command-sequence.js`
import list (line 37) and `seedScenarioArtifacts,` from the
`../../src/helpers/scenario-artifacts.js` import list (line 46).

Replace the comment block at lines 336-339:

```typescript
// `seedScenarioArtifacts` and `resolveCapturedArtifactFromManifest` are the
// production scenario-harness helpers (also used by `rd scenario run`), imported
// above from ../../src/helpers/scenario-artifacts.js so both harnesses share one
// implementation.
```

With:

```typescript
// `resolveCapturedArtifactFromManifest` is the production scenario-harness
// helper (also used by `rd scenario run`), imported above from
// ../../src/helpers/scenario-artifacts.js so both harnesses share one
// implementation.
```

Delete the seeding block (lines 351-355):

```typescript
  // Seed any artifacts declared by the scenario's `seed:` directive, then expose
  // each seeded row's rd:// URI as a ${ARTIFACT:<name>} substitution token. This
  // lets a boundary-channel scenario write `--artifacts PlanPath=${ARTIFACT:PlanPath}`.
  const artifactUris = seedScenarioArtifacts(scenario, workspace);
  const commands = scenario.commands.map((cmd) => substituteArtifactUris(cmd, artifactUris));
```

Then change the `executeCommandSequence` call (line 370) from `commands,` to:

```typescript
    commands: scenario.commands,
```

- [ ] **Step 10: Verify the grammar and the seeder are fully gone**

Every grep excludes build output — see Global Constraints. A bare grep here
returns ~49 false hits from `packages/cli/dist/` and
`packages/cli/.stryker-tmp/sandbox-*/`, both gitignored (`.gitignore:44`) but
populated by the mandated build.

Run:

```bash
grep -rn 'ARTIFACT:' --include='*.ts' --include='*.md' \
  --exclude-dir=dist --exclude-dir=.stryker-tmp --exclude-dir=node_modules \
  packages/ runbooks/ docs/internal/ \
  | grep -v CAPTURE_ARTIFACT \
  | grep -v RETIRED_ARTIFACT_PLACEHOLDER
```

Expected: only hits inside the tombstone's own TSDoc/message and its two tests in
`__tests__/helpers/command-sequence.test.ts` — every one of which is *about* the
retirement. No hit may be a live use of the grammar.

```bash
grep -rn 'seedScenarioArtifacts\|substituteArtifactUris\|ScenarioSeedSchema' \
  --exclude-dir=dist --exclude-dir=.stryker-tmp --exclude-dir=node_modules \
  packages/ runbooks/
```

Expected: no output.

- [ ] **Step 11: Run the full gate**

Run:

```bash
pnpm run verify
```

Expected: PASS. TypeScript is the backstop here — any missed reference to a
deleted symbol is a compile error, not a silent pass.

Then both scenario harnesses:

```bash
pnpm run build && pnpm run test:scenarios:raw
```

Expected: PASS.

```bash
pnpm --filter @rundown-org/cli exec jest __tests__/integration/scenario-runner.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/cli/src packages/cli/__tests__
git commit -m "refactor(cli): retire \${ARTIFACT:} grammar and seed: directive (#498)" -m \
"Deletes substituteArtifactUris, seedScenarioArtifacts, ScenarioSeedSchema and
the seed: field, and replaces them with fail-fast tombstones rather than silent
removal: ScenarioSchema becomes strict so seed: is rejected instead of stripped,
and RETIRED_ARTIFACT_PLACEHOLDER throws on \${ARTIFACT:} in command text naming
#498 and pointing at \${CAPTURE_ARTIFACT:<key>}. Zod 4 strips unknown keys by
default, so a bare deletion would have let seed: parse silently and leaked the
literal placeholder into --artifacts as a confusing INVALID_ARTIFACT_INPUT — the
exact defect #498 exists to prevent."
```

---

### Task 4: Enforce the array form's quoting requirement, and property-test the now-sole artifact grammar

Task 3 promotes `substituteCapturedArtifacts` (`command-sequence.ts:508-533`)
from "one of two artifact grammars" to **the** artifact grammar, and adds no
coverage to it. This task pins it — but at the boundary that actually carries
risk, which is **not** where a first draft of this plan aimed.

**Where the risk is not: the splice arithmetic.** `substituteCapturedArtifacts`
is hand-rolled index arithmetic over `matchAll` (`:525-532`) — a running `last`
offset, `match.index` starts, manual `cmd.slice` concatenation. It looks like the
fragile part. It is not: that arithmetic is correct today, nothing in this plan
touches it, and no reviewer has disputed it. Properties asserting it are green on
the first run, which makes them **evidence for an undisputed claim**. They are
worth keeping — they are cheap and they pin the splice against future edits — but
they are not this task's point.

**Where the risk is: the handoff across `shellParse`.** `substituteCapturedArtifacts`
does not own its output. It splices a value into command text and hands it to
`parseRdCommandWithEnv` (`command-sequence.ts:1652`), which runs `shellParse`
(`:349`). The value must survive **that** tokenizer. The invariant that matters is
therefore **composed**, not internal:

```
∀ resolved value v accepted by the quoting guard, ∀ placeholder position:
  parseRdCommandWithEnv(await substituteCapturedArtifacts(cmd, () => v))
    contains v as exactly one argv entry, byte-identical
```

**The precondition is load-bearing and must be honest.** Without
"accepted by the guard" this property is **unconditionally red** — the unquoted
array form falsifies it. The precondition is not a fudge to make the suite green;
it is the exact statement of which commands the harness will accept, which is why
Step 1 builds the guard *before* Step 4 writes the property. A precondition that
excluded the array form entirely would make the property vacuous; this one does
not — it admits every scalar placeholder in any position, plus every correctly
quoted array placeholder, which is 100% of the legal grammar and 100% of the
real call sites.

#### The defect the guard closes — verified by execution, not inference

`resolveCapturedArtifactFromManifest` returns `JSON.stringify(...)` for the array
form (`scenario-artifacts.ts:130`) — a value containing `"` characters. Running
`shell-quote`'s `parse` on the two spellings:

| Form | Command text | `shellParse` argv payload | Result |
| ---- | ------------ | ------------------------- | ------ |
| Quoted | `--artifacts-json 'R=["rd://a","rd://b"]'` | `R=["rd://a","rd://b"]` | JSON intact, byte-identical |
| Unquoted | `--artifacts-json R=["rd://a","rd://b"]` | `R=[rd://a,rd://b]` | **JSON destroyed** |

Both produce one argv entry and `hasOperators` is `false` for both, so no
operator or glob path intervenes — the quotes are simply consumed as *shell*
quoting. The unquoted payload is **invalid JSON**, so it throws.

**Severity, stated accurately.** This is a **usability defect on one grammar**,
matching #498's `P3: low` label — not silent corruption. The value does not
quietly change meaning; the command fails, with an error naming a value the
author never wrote. The **scalar form is structurally immune**: `assertSafeId`
(`packages/core/src/paths.ts:34`) confines ids to `[A-Za-z0-9._-]`, and `rd://`
URIs add only `/` and `:`, so no resolved scalar value can carry a shell
metacharacter. Do not justify this task by overstating the hazard.

**Why it must be enforced rather than conventional.** Correctness of the sole
surviving artifact grammar currently rests on authors remembering single quotes.
Both existing array call sites do quote —
`runbooks/artifacts/artifact-variable-write-plan.runbook.md:52` and
`artifact-variable-collate.runbook.md:13` — by convention, with nothing checking
them. Task 3 establishes the fail-fast tombstone pattern for exactly this class
of "retired/illegal input must not pass through silently". The quoting
requirement gets the same treatment.

**Rejected: make the resolver emit shell-escaped JSON.** Escaping a value to
survive a tokenizer *we control and invoke ourselves* is the wrong direction: it
bakes the splice-then-reparse hazard deeper into the design at the moment the
follow-up intends to remove it, and it would make the resolved value differ from
the value the consumer receives.

#### This guard is deliberate throwaway — say so, don't discover it later

Under the deferred parse-then-substitute refactor (spec §3.3, Task 6's issue),
resolved values are injected into an already-parsed argv and **never reach
`shellParse`**. The quoting requirement then evaporates and this guard becomes
dead code that the follow-up deletes. That is **~10 lines of accepted waste, not
an oversight** — it buys enforced correctness for the interval during which
splice-then-reparse is real, which is an interval of unknown length. Task 6's
issue body names this guard as something the refactor removes, so the waste is
tracked rather than fossilised.

**Files:**

- Modify: `packages/cli/src/helpers/command-sequence.ts` (add
  `CAPTURE_ARTIFACT_ARRAY_PLACEHOLDER`, `ARRAY_QUOTING_PROBE`, and
  `assertArrayCapturesAreShellQuoted` next to `RETIRED_ARTIFACT_PLACEHOLDER` at
  `:542`; call it in `executeCommandSequence` at `:1642`)
- Test: `packages/cli/__tests__/helpers/command-sequence.test.ts` (guard's
  example-based tests)
- Create: `packages/cli/__tests__/helpers/command-sequence.properties.test.ts`

**Interfaces:**

- Consumes: `substituteCapturedArtifacts(cmd: string, resolve:
  CapturedArtifactResolver): Promise<string>` and
  `parseRdCommandWithEnv(cmd: string): ParsedRdCommand | null`, both from
  `packages/cli/src/helpers/command-sequence.ts` and both unchanged by this plan.
  `parseRdCommandWithEnv` returns `null` for a non-`rd` shell command and
  otherwise an object with an `args: string[]` property.
- Produces: a module-private `assertArrayCapturesAreShellQuoted(cmd: string):
  void` in `command-sequence.ts` — not exported, exercised through
  `executeCommandSequence`. Nothing later tasks rely on.

- [ ] **Step 1: Write the failing guard tests**

In `packages/cli/__tests__/helpers/command-sequence.test.ts`, add to the
`describe('retired ${ARTIFACT:} grammar (#498)', ...)` block's file — as a new
sibling `describe` — the following. Copy the `executeCommandSequence` option
shape from an existing `executeCommandSequence` test in the same file rather
than trusting the illustrative `cwd`/`execute`/`resolveCapturedArtifact` fields
below; only the `commands` entries and the matchers are load-bearing.

```typescript
describe('${CAPTURE_ARTIFACT_ARRAY:} shell-quoting guard (#498)', () => {
  const neverExecute = (): never => {
    throw new Error('command must never be executed with an unquoted array capture');
  };

  it('rejects an unquoted array capture, naming the key and the fix', async () => {
    await expect(
      executeCommandSequence({
        commands: ['rd run x.runbook.md --artifacts-json R=${CAPTURE_ARTIFACT_ARRAY:review.json}'],
        cwd: process.cwd(),
        resolveCapturedArtifact: async () => '["rd://artifacts/c/rd_1/review.json"]',
        execute: neverExecute,
      }),
    ).rejects.toThrow(/review\.json.*single-quote/s);
  });

  it('accepts the real quoted call-site spelling, where the whole assignment is quoted', async () => {
    const seen: string[] = [];
    await executeCommandSequence({
      commands: [
        "rd run x.runbook.md --artifacts-json 'Reviews=${CAPTURE_ARTIFACT_ARRAY:review.json}' --allow-all",
      ],
      cwd: process.cwd(),
      resolveCapturedArtifact: async () => '["rd://artifacts/c/rd_1/review.json"]',
      execute: (cmd: string) => {
        seen.push(cmd);
        return { stdout: '{}', code: 0 };
      },
    });
    expect(seen[0]).toContain('["rd://artifacts/c/rd_1/review.json"]');
  });

  it('does not fire on the scalar form, which needs no quoting', async () => {
    const seen: string[] = [];
    await executeCommandSequence({
      commands: ['rd run x.runbook.md --artifacts P=${CAPTURE_ARTIFACT:plan.json}'],
      cwd: process.cwd(),
      resolveCapturedArtifact: async () => 'rd://artifacts/c/rd_1/plan.json',
      execute: (cmd: string) => {
        seen.push(cmd);
        return { stdout: '{}', code: 0 };
      },
    });
    expect(seen[0]).toContain('rd://artifacts/c/rd_1/plan.json');
  });
});
```

The second test is the one that matters most, and it is not hypothetical: it
encodes the **actual** spelling both real call sites use (see Step 3).

- [ ] **Step 2: Run the guard tests to verify they fail**

Run:

```bash
pnpm --filter @rundown-org/cli exec jest __tests__/helpers/command-sequence.test.ts \
  -t 'shell-quoting guard'
```

Expected: FAIL — `rejects an unquoted array capture` receives a resolved
promise, because no guard exists yet. The other two tests pass already (they
assert current behaviour); they are regression pins for Step 3.

- [ ] **Step 3: Implement the guard — use the tokenizer as the oracle, not a regex**

**Read this before writing the code — the obvious implementation is wrong.** The
tempting guard is a regex asserting the placeholder is wrapped in single quotes,
e.g. `/'\$\{CAPTURE_ARTIFACT_ARRAY:[^}]+\}'/`. **It false-rejects both real call
sites.** They quote the *whole assignment*, not the placeholder:

```
--artifacts-json 'Reviews=${CAPTURE_ARTIFACT_ARRAY:review.json}'
```

The character before the placeholder is `=`, not `'`. Verified by execution: that
adjacency regex returns `false` on `artifact-variable-collate.runbook.md:13`.
Chasing this with a smarter regex means reimplementing shell quoting rules —
precisely the fragile string analysis this plan exists to reduce.

**Instead, ask the real tokenizer.** Substitute a **probe** value with the same
shell-hazardous shape as real resolved JSON, run it through the very `shellParse`
the command is about to face, and check the probe survived intact. The oracle is
the tokenizer itself, so the guard cannot disagree with it.

`shellParse` is already imported at `command-sequence.ts:18`
(`import { parse as shellParse } from 'shell-quote';`) — no new dependency.

Immediately after `RETIRED_ARTIFACT_PLACEHOLDER` (added in Task 3 at `:542`),
add:

```typescript
/** Global matcher for the array form, used to locate placeholders to probe. */
const CAPTURE_ARTIFACT_ARRAY_PLACEHOLDER = /\$\{CAPTURE_ARTIFACT_ARRAY:([^}]+)\}/g;

/**
 * Stand-in for a resolved array value, used to ask `shellParse` whether a real
 * resolved value would survive at the same position.
 *
 * Covers every shell-significant character a real value can contain. A resolved
 * array is `JSON.stringify` of `rd://` URIs (`scenario-artifacts.ts:130`), whose
 * character set is closed under `assertSafeId` (`[A-Za-z0-9._-]`, `paths.ts:34`)
 * plus the URI's `/` and `:` and JSON's `[`, `]`, `"`, `,`. Of those, only `"`
 * and `[`/`]` are shell-significant, and the probe contains all three — so a
 * probe that survives implies a real value survives.
 */
const ARRAY_QUOTING_PROBE = '["rd://s"]';

/**
 * Reject an `${CAPTURE_ARTIFACT_ARRAY:<key>}` placeholder that is not shell-quoted.
 *
 * The array form resolves to JSON containing `"` characters, which are spliced
 * into command text and then re-tokenised by `shellParse` via
 * {@link parseRdCommandWithEnv}. Unquoted, the shell consumes those quotes and
 * `["rd://a","rd://b"]` arrives as the unparseable `[rd://a,rd://b]`, failing
 * with an error naming a value the author never wrote. The scalar form needs no
 * such guard: its resolved values cannot contain a shell metacharacter.
 *
 * Implemented by probing the real tokenizer rather than by matching quotes with
 * a regex: authors quote the whole assignment (`'K=${...}'`), not the
 * placeholder, so an adjacency regex false-rejects every real call site.
 *
 * Deliberately throwaway: under the deferred parse-then-substitute refactor
 * (#498 follow-up) resolved values never reach `shellParse` and this guard is
 * deleted with the hazard it guards.
 *
 * @param cmd - Command text after token substitution, placeholders still intact
 * @throws {Error} When any array placeholder would not survive shell tokenisation
 */
function assertArrayCapturesAreShellQuoted(cmd: string): void {
  const keys = [...cmd.matchAll(CAPTURE_ARTIFACT_ARRAY_PLACEHOLDER)].map((m) => m[1]);
  if (keys.length === 0) return;
  const probe = cmd.replace(CAPTURE_ARTIFACT_ARRAY_PLACEHOLDER, ARRAY_QUOTING_PROBE);
  let survived: number;
  try {
    // Count probe *occurrences*, not entries containing one: two placeholders
    // can legitimately land in a single quoted argv entry.
    survived = shellParse(probe)
      .filter((entry): entry is string => typeof entry === 'string')
      .reduce((n, entry) => n + entry.split(ARRAY_QUOTING_PROBE).length - 1, 0);
  } catch {
    survived = -1;
  }
  if (survived !== keys.length) {
    throw new Error(
      `Command uses \${CAPTURE_ARTIFACT_ARRAY:${keys[0]}} without shell quoting: ${cmd}\n` +
        `The array form resolves to JSON containing double quotes; unquoted, the shell strips ` +
        `them and the value arrives as invalid JSON. Single-quote the assignment, e.g. ` +
        `--artifacts-json 'Key=\${CAPTURE_ARTIFACT_ARRAY:${keys[0]}}'.`,
    );
  }
}
```

In `executeCommandSequence`, immediately **after** the `RETIRED_ARTIFACT_PLACEHOLDER`
throw added in Task 3 and **before** the `CAPTURE_ARTIFACT_PLACEHOLDER` check
(`command-sequence.ts:1642`), add:

```typescript
    // The array capture resolves to JSON with double quotes and is re-tokenised
    // by shellParse below; reject it here if it would not survive, rather than
    // failing later against a value the author never wrote.
    assertArrayCapturesAreShellQuoted(tokenSubstituted);
```

It runs on `tokenSubstituted` — after token substitution, so it sees final
command text, and before capture substitution, so it can still name the
placeholder rather than the resolved value.

- [ ] **Step 4: Run the guard tests to verify they pass**

Run:

```bash
pnpm --filter @rundown-org/cli exec jest __tests__/helpers/command-sequence.test.ts
```

Expected: PASS — all three guard tests, plus Task 3's tombstone tests.

Then confirm the guard does not reject the repository's real scenarios:

```bash
pnpm run build && pnpm run test:scenarios:raw
```

Expected: PASS, including `bundled-write-review-collate-artifacts`
(`artifact-variable-write-plan.runbook.md:47-61`) and
`artifact-variable-collate.runbook.md`'s scenario — the two real array call
sites. A rejection here means the guard is over-tight; fix the guard, **not**
the scenarios.

- [ ] **Step 5: Write the property tests**

`packages/cli/__tests__/services/renderers/json-renderer.properties.test.ts` is
the CLI package's only existing fast-check file — follow its
`import * as fc from 'fast-check';` convention and `*.properties.test.ts` naming.
fast-check is already a CLI devDependency (`packages/cli/package.json:60`,
`"fast-check": "^4.9.0"`).

Create `packages/cli/__tests__/helpers/command-sequence.properties.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import {
  substituteCapturedArtifacts,
  parseRdCommandWithEnv,
} from '../../src/helpers/command-sequence.js';

/** A placeholder key: the shape `assertSafeId` admits, kept short for shrinking. */
const keyArb = fc.stringMatching(/^[A-Za-z0-9_.]{1,12}$/);

/**
 * Literal command text guaranteed to contain no placeholder. Mapping `$` away is
 * used rather than filtering so no generated value is ever rejected. Length 0 is
 * allowed on purpose — it is what produces adjacent placeholders and
 * placeholders at the very start/end of the command.
 */
const literalArb = fc
  .string({ maxLength: 12 })
  .map((s) => s.replaceAll('$', 'S').replaceAll('{', '(').replaceAll('}', ')'));

interface Placeholder {
  readonly key: string;
  readonly asArray: boolean;
}

interface Command {
  readonly placeholders: readonly Placeholder[];
  readonly literals: readonly string[];
}

/** N placeholders interleaved with exactly N+1 literal segments. */
const commandArb: fc.Arbitrary<Command> = fc
  .array(fc.record({ key: keyArb, asArray: fc.boolean() }), { maxLength: 5 })
  .chain((placeholders) =>
    fc
      .array(literalArb, {
        minLength: placeholders.length + 1,
        maxLength: placeholders.length + 1,
      })
      .map((literals) => ({ placeholders, literals })),
  );

function renderPlaceholder(p: Placeholder): string {
  return `\${CAPTURE_ARTIFACT${p.asArray ? '_ARRAY' : ''}:${p.key}}`;
}

function buildCommand({ placeholders, literals }: Command): string {
  return placeholders.reduce(
    (acc, p, i) => acc + renderPlaceholder(p) + literals[i + 1],
    literals[0],
  );
}

/**
 * The resolved value for the nth resolver call. Deliberately contains `}` and
 * `${` — if the implementation re-scanned its own output, these would be
 * re-parsed as placeholder syntax and the oracle would diverge.
 */
function resolvedValue(n: number, key: string, asArray: boolean): string {
  return `<${String(n)}:${key}:${asArray ? 'A' : 'S'}}\${>`;
}

/**
 * A resolved value the harness can really produce: a `rd://` URI whose segments
 * are `assertSafeId`-shaped (`paths.ts:34`), so the arbitrary generates exactly
 * the domain `resolveCapturedArtifactFromManifest` returns and no wider.
 */
const uriArb = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z0-9._-]{1,8}$/),
    fc.stringMatching(/^[A-Za-z0-9._-]{1,8}$/),
    fc.stringMatching(/^[A-Za-z0-9._-]{1,8}$/),
  )
  .map(([ctx, run, key]) => `rd://artifacts/${ctx}/rd_${run}/${key}`);

/** The array form's resolved value: `JSON.stringify` of URIs, per scenario-artifacts.ts:130. */
const arrayValueArb = fc.array(uriArb, { maxLength: 3 }).map((uris) => JSON.stringify(uris));

/** Count argv entries containing `value` after substitution + the real rd parse. */
async function argvEntriesContaining(cmd: string, value: string): Promise<number> {
  const substituted = await substituteCapturedArtifacts(cmd, async () => value);
  const parsed = parseRdCommandWithEnv(substituted);
  if (!parsed) throw new Error(`expected an rd command, got: ${substituted}`);
  return parsed.args.filter((arg) => arg.includes(value)).length;
}

describe('substituteCapturedArtifacts (properties)', () => {
  // ---------------------------------------------------------------------------
  // The load-bearing property: composed across the shellParse boundary that
  // substituteCapturedArtifacts hands off to. Its precondition — "accepted by
  // the quoting guard" — is expressed by only generating command shapes the
  // guard admits: scalars anywhere, arrays single-quoted. Without it the
  // property is unconditionally red (see the unquoted-array case below, which
  // is asserted as a *known* falsification rather than hidden).
  // ---------------------------------------------------------------------------
  it('a resolved SCALAR survives the rd parse as exactly one argv entry, byte-identical', async () => {
    await fc.assert(
      fc.asyncProperty(uriArb, async (uri) => {
        // Scalars are immune regardless of quoting, so both spellings hold.
        expect(
          await argvEntriesContaining('rd run x.runbook.md --artifacts P=${CAPTURE_ARTIFACT:k}', uri),
        ).toBe(1);
        expect(
          await argvEntriesContaining(
            "rd run x.runbook.md --artifacts P='${CAPTURE_ARTIFACT:k}'",
            uri,
          ),
        ).toBe(1);
      }),
    );
  });

  it('a resolved ARRAY survives the rd parse byte-identically when the assignment is quoted', async () => {
    await fc.assert(
      fc.asyncProperty(arrayValueArb, async (value) => {
        // The real call-site spelling: the whole assignment is single-quoted
        // (artifact-variable-collate.runbook.md:13).
        expect(
          await argvEntriesContaining(
            "rd run x.runbook.md --artifacts-json 'R=${CAPTURE_ARTIFACT_ARRAY:k}' --allow-all",
            value,
          ),
        ).toBe(1);
      }),
    );
  });

  it('documents WHY the guard precondition is required: unquoted arrays falsify the property', async () => {
    // This is the defect Task 4's guard rejects. Pinned as a known falsification
    // so the precondition above is visibly non-arbitrary — and so this test goes
    // red (telling us to delete it) if the hazard is ever removed at the source.
    const value = JSON.stringify(['rd://artifacts/c/rd_1/plan.json']);
    const survived = await argvEntriesContaining(
      'rd run x.runbook.md --artifacts-json R=${CAPTURE_ARTIFACT_ARRAY:k}',
      value,
    );
    expect(survived).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Internals: cheap, and they pin the splice arithmetic against future edits.
  // These are NOT evidence that this change is correct — they were green before
  // it and are green after.
  // ---------------------------------------------------------------------------
  it('splices every placeholder at the right offset and preserves literals verbatim', async () => {
    await fc.assert(
      fc.asyncProperty(commandArb, async (command) => {
        const cmd = buildCommand(command);
        const calls: Placeholder[] = [];
        let n = 0;
        const resolve = async (key: string, asArray: boolean): Promise<string> => {
          calls.push({ key, asArray });
          return resolvedValue(n++, key, asArray);
        };

        const result = await substituteCapturedArtifacts(cmd, resolve);

        const expected = command.placeholders.reduce(
          (acc, p, i) => acc + resolvedValue(i, p.key, p.asArray) + command.literals[i + 1],
          command.literals[0],
        );
        // Offset correctness across every match, literal text preserved verbatim,
        // resolved values never re-scanned, adjacent placeholders handled.
        expect(result).toBe(expected);
        // N placeholders produce exactly N resolver calls, in match order, with
        // the array flag carried through.
        expect(calls).toEqual(
          command.placeholders.map((p) => ({ key: p.key, asArray: p.asArray })),
        );
      }),
    );
  });

  it('returns placeholder-free commands verbatim without calling the resolver', async () => {
    await fc.assert(
      fc.asyncProperty(literalArb, async (cmd) => {
        let calls = 0;
        const resolve = async (): Promise<string> => {
          calls++;
          return 'unused';
        };

        expect(await substituteCapturedArtifacts(cmd, resolve)).toBe(cmd);
        expect(calls).toBe(0);
      }),
    );
  });

  it('never re-scans a resolved value that itself looks like a placeholder', async () => {
    let calls = 0;
    const resolve = async (): Promise<string> => {
      calls++;
      return '${CAPTURE_ARTIFACT:injected}';
    };

    const result = await substituteCapturedArtifacts('a ${CAPTURE_ARTIFACT:real} b', resolve);

    expect(result).toBe('a ${CAPTURE_ARTIFACT:injected} b');
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 6: Run the property tests**

Run:

```bash
pnpm --filter @rundown-org/cli exec jest __tests__/helpers/command-sequence.properties.test.ts
```

Expected: PASS — all six.

These characterise **existing** behaviour, so they pass on the first run; this is
the one place in this plan where a red step is not expected. If one fails, that
is a **real defect**, not a bad test: read the fast-check counterexample and use
superpowers:systematic-debugging. Do not weaken a property to make it green — in
particular, do not widen the guard's precondition.

- [ ] **Step 7: Verify the properties can actually fail**

A property test that cannot fail is worse than none. Confirm the **composed**
property bites — not just the internals one. Temporarily change
`command-sequence.ts:530` from:

```typescript
    result += cmd.slice(last, start) + replacements[index];
```

To:

```typescript
    result += cmd.slice(last, start + 1) + replacements[index];
```

Run:

```bash
pnpm --filter @rundown-org/cli exec jest __tests__/helpers/command-sequence.properties.test.ts
```

Expected: FAIL on the scalar/array composed properties **and** on the splice
property, each with a shrunk counterexample. **Revert**
(`git checkout -- packages/cli/src/helpers/command-sequence.ts`) and re-run to
confirm PASS before committing.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/helpers/command-sequence.ts \
        packages/cli/__tests__/helpers/command-sequence.test.ts \
        packages/cli/__tests__/helpers/command-sequence.properties.test.ts
git commit -m "test(cli): enforce and property-test array capture shell-quoting (#498)" -m \
"The array form resolves to JSON containing double quotes, which are spliced into
command text and re-tokenised by shellParse. Unquoted, the shell consumes them
and [\"rd://a\",\"rd://b\"] arrives as the invalid [rd://a,rd://b], throwing with a
value the author never wrote. Both existing call sites quote by convention only.

assertArrayCapturesAreShellQuoted probes the real tokenizer rather than matching
quotes with a regex: authors quote the whole assignment ('K=\${...}'), not the
placeholder, so an adjacency regex false-rejects every real call site.

The scalar form is structurally immune (assertSafeId confines ids to
[A-Za-z0-9._-]; rd:// adds only / and :), so this is one grammar's usability
defect, not silent corruption.

The guard is deliberate throwaway: under the deferred parse-then-substitute
refactor, resolved values never reach shellParse and it is deleted with the
hazard."
```

---

### Task 5: Document the single capture mechanism

`docs/internal/scenarios.md` is the descriptive doc for the scenario schema. It
documents `commands`, `expect`, and every assertion type, but has never
documented either artifact grammar —
`grep -n 'seed\|CAPTURE_ARTIFACT' docs/internal/scenarios.md` returns **nothing**
(exit status 1). Now that there is exactly one grammar, it is documentable in a
way two competing grammars were not — and the "run a producer, never fabricate a
URI" rule needs a home a scenario author will actually find.

**Files:**

- Modify: `docs/internal/scenarios.md` (insert after the "Matching Semantics"
  section)

**Interfaces:**

- Consumes: the mechanism established by Tasks 1-4.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Add the artifact capture section**

In `docs/internal/scenarios.md`, add a new `## Artifact Capture` section
immediately after the `### Matching Semantics` section:

````markdown
## Artifact Capture

A scenario command receives an artifact `rd://` URI by **capturing it from a
prior command's output**. This is the only mechanism — there is no seed
directive, and scenarios must never fabricate an `rd://` URI or hand-write a
manifest row. Core owns URI construction (`buildArtifactUri`) and the manifest
row shape; a scenario that duplicates either will drift silently when core
changes.

| Placeholder                      | Resolves to                                          |
| -------------------------------- | ---------------------------------------------------- |
| `${CAPTURE_ARTIFACT:<key>}`      | The most recent `rd://artifacts/...` URI for `<key>`  |
| `${CAPTURE_ARTIFACT_ARRAY:<key>}`| A JSON array of every matching URI for `<key>`        |

**The array form must be single-quoted.** It resolves to JSON containing double
quotes, and placeholders are substituted into command text that is then
tokenised by the shell. Unquoted, the shell strips those quotes and
`["rd://a","rd://b"]` arrives as the invalid `[rd://a,rd://b]`. Quote the whole
assignment:

```yaml
- rd run collate.runbook.md --artifacts-json 'Reviews=${CAPTURE_ARTIFACT_ARRAY:review.json}' --allow-all
```

This is enforced, not advisory — an unquoted array placeholder is rejected before
the command runs. The scalar form needs no quoting: its values cannot contain a
shell metacharacter.

Both are resolved from the artifact manifest immediately before each command
runs, so they see rows that earlier commands in the same scenario actually
produced. Recency is by manifest row `timestamp`, with within-context append
order breaking ties; a scalar pick whose latest-timestamp rows span more than one
context is ambiguous and raises an error rather than guessing.

An earlier `${ARTIFACT:<name>}` grammar and its `seed:` directive were retired in
[#498](https://github.com/tobyhede/rundown/issues/498). Both are now rejected
outright — `seed:` fails scenario validation as an unknown key, and
`${ARTIFACT:…}` in a command throws before execution — rather than being ignored.

### Seeding a pre-existing artifact

When a scenario needs an artifact to "already exist", run a real producer runbook
as its first command and capture the artifact it emits:

```yaml
scenarios:
  consume-plan-artifact:
    commands:
      - rd run scenario-seed-artifacts.runbook.md --allow-all
      - "rd run execute-plan.runbook.md --artifacts PlanPath=${CAPTURE_ARTIFACT:PlanPath}"
    expect:
      result: COMPLETE
```

`runbooks/artifacts/scenario-seed-artifacts.runbook.md` is the shared
deterministic seeder; it emits keys `PlanPath` and `plan.json` through the real
`ARTIFACTS` production path. Any producer runbook works — the seeder is a
convenience, not a special case. The producer needs `--allow-all` because it
writes its backing files from a bash block.

The producer runbook is staged automatically: the harness scans command strings
for `*.runbook.md` references and copies them into the scenario workspace.

### Asserting on a captured artifact

A naked `ARTIFACTS` alias fed an exact `rd://` URI surfaces the **injected
record's key**, while the record's **provenance stays the producer's**. Two
consequences for `expect.artifacts` entries:

- `key:` matches the consumer's alias mapping, as authored in the consuming
  runbook.
- `runbook:` filters the **emitting event's** runbook — *not* the record's
  provenance. Adding `runbook: <consumer>` to an assertion over an injected
  record does not scope it "to the consumer's row"; the row's provenance is the
  producer's either way. Disambiguate consumer from producer by `alias:` instead,
  and give the seeder's aliases distinct names from the consumer's.
````

- [ ] **Step 2: Verify docs pass the gate**

Run:

```bash
pnpm run verify
```

Expected: PASS — this includes the format and spell checks that the new prose
must satisfy.

- [ ] **Step 3: Commit**

```bash
git add docs/internal/scenarios.md
git commit -m "docs(scenarios): document capture-from-output artifact seeding (#498)"
```

---

### Task 6: File the `ScenarioContext` follow-up issue

Deferred work with no issue number is deleted work. Spec §3.3 defers
`ScenarioContext` threading for good reasons, but that deferral leaves #498's
fragility item 1 (splice-then-reparse) unaddressed. It gets an issue, not a
bullet under "Out of scope".

**Files:**

- None. This task creates a GitHub issue; per CLAUDE.md, trackable follow-up work
  belongs in GitHub issues, not in-repo docs.

**Interfaces:**

- Consumes: the completed state after Tasks 1-5 — the issue body's claim that
  exactly one artifact grammar remains must be true when it is filed.
- Produces: an issue number to reference from the PR description. Final task.

- [ ] **Step 1: Create the follow-up issue**

Run:

```bash
gh issue create \
  --title "Scenario harness: thread a typed ScenarioContext through executeCommandSequence" \
  --body "$(cat <<'EOF'
Follow-up to #498.

#498 retired the `${ARTIFACT:}` grammar and the `seed:` directive, landing its
fragility items 2 (synthetic fidelity), 3 (two placeholder grammars) and 4
(duplication of core). It deliberately did **not** land item 1:
**command-text-layer splicing**. Values are still spliced into command strings
and re-parsed by `parseRdCommandWithEnv` (`command-sequence.ts:1652`), which runs
`shellParse` (`:349`).

## The concrete defect this removes

Not an abstract fragility argument — a verified failing case. The array capture
resolves to `JSON.stringify(...)` of `rd://` URIs
(`packages/cli/src/helpers/scenario-artifacts.ts:130`), a value containing `"`.
Running `shell-quote`'s `parse` on the two spellings:

| Form | Command text | argv payload | Result |
| ---- | ------------ | ------------ | ------ |
| Quoted | `--artifacts-json 'R=["rd://a","rd://b"]'` | `R=["rd://a","rd://b"]` | JSON intact |
| Unquoted | `--artifacts-json R=["rd://a","rd://b"]` | `R=[rd://a,rd://b]` | **invalid JSON — throws** |

Both yield one argv entry with `hasOperators: false`; the shell simply consumes
the JSON's quotes as *shell* quoting.

**Scoped honestly.** This is a **usability defect on one grammar**, not silent
corruption — it throws, but names a value the author never wrote. The **scalar
form is structurally immune**: `assertSafeId` (`packages/core/src/paths.ts:34`)
confines ids to `[A-Za-z0-9._-]` and `rd://` adds only `/` and `:`, so no
resolved scalar can carry a shell metacharacter. That bounded blast radius is
why #498 could defer this at `P3: low` rather than block on it.

## What this issue deletes

`assertArrayCapturesAreShellQuoted` and its `ARRAY_QUOTING_PROBE` /
`CAPTURE_ARTIFACT_ARRAY_PLACEHOLDER` constants
(`packages/cli/src/helpers/command-sequence.ts`, added by #498). That guard
enforces the array form's shell-quoting requirement by probing `shellParse`.
Under parse-then-substitute, resolved values are injected into an already-parsed
argv and **never reach `shellParse`** — the quoting requirement evaporates and
the guard becomes dead code. #498 accepted it as ~10 lines of deliberate
throwaway, tracked here rather than fossilised. Deleting it is part of this
issue's definition of done.

## Why deferring was right, and why it is now cheaper

Artifacts are one of **five** structurally identical string-splicing grammars in
`executeCommandSequence` (`command-sequence.ts:1629-1649`):

| Grammar | Substituter | Location |
| --- | --- | --- |
| `${TOKEN}` | `substituteTokens` | `command-sequence.ts:442` |
| `${CLAIM_ID}` | `substituteClaimIds` | `command-sequence.ts:554` |
| `${RUN_CLAIM_ID}` | `substituteRunClaimIds` | `command-sequence.ts:575` |
| `${RUN_ID}` | `substituteRunIds` | `command-sequence.ts:606` |
| `${CAPTURE_ARTIFACT[_ARRAY]}` | `substituteCapturedArtifacts` | `command-sequence.ts:508` |

Threading a typed `ScenarioContext` (captured values + cwd/env) for artifacts
alone, while its four neighbours keep splicing strings, buys inconsistency rather
than type safety and leaves the splice-then-reparse hazard fully intact. The
refactor is worth doing across all five at once — a different change with a
different blast radius.

**#498 made this materially cheaper, which is the point of the sequencing.**
Before #498 the harness had **two injection mechanisms with different temporal
models**: seeds were known *before* execution (a pre-built `name → URI` map
handed to a synchronous substituter), captures only *during* it (resolved from
the manifest by a prior command's output, asynchronously). A typed
`ScenarioContext` had to model **both**, with different failure modes and
different detection points — a seed can be missing at construction, a capture can
only fail at resolution. #498 collapses this to **one** temporal model: every
artifact value is capture-from-output, resolved during execution by one resolver.
Most of what made this refactor look expensive is already gone.

## Acceptance test — already written

`packages/cli/__tests__/helpers/command-sequence.properties.test.ts` (added by
#498) states the invariant this refactor must establish:

```
∀ resolved value v accepted by the quoting guard, ∀ placeholder position:
  parseRdCommandWithEnv(await substituteCapturedArtifacts(cmd, () => v))
    contains v as exactly one argv entry, byte-identical
```

Under parse-then-substitute this becomes **true by construction** — a value
injected into an already-parsed argv is one entry, byte-identical, trivially. So
these properties are **inherited, not obsoleted**: they are this refactor's
acceptance test, and the precondition should be *dropped* (not the property) once
the guard is deleted, since every value then satisfies it. The file also pins a
deliberate known-falsification test naming the unquoted-array case; that test
should go red under this refactor, which is the signal to delete it.

Design context: `docs/superpowers/specs/2026-07-16-scenario-capture-from-output-design.md` §3.3.
EOF
)"
```

- [ ] **Step 2: Record the issue number in the spec's deferral**

Take the issue number `gh issue create` printed. In
`docs/superpowers/specs/2026-07-16-scenario-capture-from-output-design.md`, in
§3.3, replace:

```markdown
**Follow-up issue:** filed by the implementation plan's final task — record the
number here on landing.
```

With the same line naming the number, e.g.:

```markdown
**Follow-up issue:** [#NNN](https://github.com/tobyhede/rundown/issues/NNN).
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-16-scenario-capture-from-output-design.md
git commit -m "docs(spec): record ScenarioContext follow-up issue number (#498)"
```

---

## Verification

Before opening the PR, confirm every acceptance criterion from
[#498](https://github.com/tobyhede/rundown/issues/498). **Every grep below
excludes `dist/`, `.stryker-tmp/`, and `node_modules/`** — all three are
gitignored (`.gitignore:44`) but populated on disk by the build these tasks
mandate, and a bare grep returns ~49 hits from them alone. `git grep` is an
equally good alternative, since it only sees tracked files.

- [ ] **Dated design spec** —
      `docs/superpowers/specs/2026-07-16-scenario-capture-from-output-design.md`
      exists.
- [ ] **Single placeholder/capture mechanism; `${ARTIFACT:}` retired** —

      ```bash
      grep -rn 'ARTIFACT:' --include='*.ts' --include='*.md' \
        --exclude-dir=dist --exclude-dir=.stryker-tmp --exclude-dir=node_modules \
        packages/ runbooks/ \
        | grep -v CAPTURE_ARTIFACT \
        | grep -v RETIRED_ARTIFACT_PLACEHOLDER
      ```

      Every remaining hit must be part of the retirement tombstone (its TSDoc,
      its error message, or its two tests). No hit may be a live use.

- [ ] **The retirement fails loudly, not silently** — `seed:` is rejected by
      `ScenarioSchema` (strict) and `${ARTIFACT:}` in a command throws before
      execution. Pinned by
      `packages/cli/__tests__/schemas/scenarios.test.ts` and
      `packages/cli/__tests__/helpers/command-sequence.test.ts`.
- [ ] **No fabricated URIs or hand-built manifest rows** —

      ```bash
      grep -rn 'rd://artifacts/' \
        --exclude-dir=dist --exclude-dir=.stryker-tmp --exclude-dir=node_modules \
        runbooks/
      grep -rn 'manifest.jsonl' \
        --exclude-dir=dist --exclude-dir=.stryker-tmp --exclude-dir=node_modules \
        runbooks/
      ```

      Both return nothing.

- [ ] **No dead symbols** —

      ```bash
      grep -rn 'seedScenarioArtifacts\|substituteArtifactUris\|ScenarioSeedSchema' \
        --exclude-dir=dist --exclude-dir=.stryker-tmp --exclude-dir=node_modules \
        packages/ runbooks/
      ```

      Returns nothing.

- [ ] **Scenarios migrated and green under both harnesses** —
      `pnpm run build && pnpm run test:scenarios:raw` passes, and
      `pnpm --filter @rundown-org/cli exec jest __tests__/integration/scenario-runner.test.ts`
      passes.
- [ ] **The sole surviving grammar is property-tested at the boundary that
      matters** —
      `packages/cli/__tests__/helpers/command-sequence.properties.test.ts` exists
      and passes, and includes the **composed** properties (substitute →
      `parseRdCommandWithEnv` → argv), not only the internal splice properties.
- [ ] **The array form's quoting requirement is enforced, not conventional** —
      `assertArrayCapturesAreShellQuoted` rejects an unquoted
      `${CAPTURE_ARTIFACT_ARRAY:…}` before execution, and **accepts** the real
      call-site spelling `'Key=${CAPTURE_ARTIFACT_ARRAY:key}'` (whole assignment
      quoted). Pinned by
      `packages/cli/__tests__/helpers/command-sequence.test.ts`.
- [ ] **The deferral has an issue number** — Task 6's issue exists and is linked
      from the PR description and from spec §3.3.
- [ ] **`pnpm run verify` passes.**

## Out of scope

- **`forged-file-record-rejected`**
  (`runbooks/artifacts/artifact-variable-review-plan.runbook.md:22-32`). Its
  `node -e` writes an intentionally forged artifact record as a public input to
  assert the input channel **rejects** it
  (`expect.errors[0].error: 'Artifact record input for "Plan" is not trusted'`).
  The forgery is the assertion, not a seeding shortcut. Untouched.
- **`review-plan-uri-input`** and **`bundled-write-review-collate-artifacts`**
  (`runbooks/artifacts/artifact-variable-write-plan.runbook.md:19-31,47-61`).
  Already on the target mechanism.
- **`ScenarioContext` threading / #498 fragility item 1.** Deferred — but *not*
  simply out of scope: Task 6 files the issue that owns it. See spec §3.3.
