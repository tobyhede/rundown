# Scenario harness: capture-from-output seeding — design

**Issue:** [#498](https://github.com/tobyhede/rundown/issues/498) — Scenario
harness: replace fabricated-URI seeding with capture-from-output

**Status:** proposed

**Date:** 2026-07-16

## 1. Problem

The scenario harness gives a scenario command a "pre-existing artifact" by
**fabricating** one. `seedScenarioArtifacts`
(`packages/cli/src/helpers/scenario-artifacts.ts:42-71`) does all of the
following by hand:

1. Hardcodes an identity — `seedContextId = 'scenario-seed-context'` and
   `seedRunId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`
   (`scenario-artifacts.ts:47-48`).
2. String-builds the URI —
   `` const uri = `rd://artifacts/${seedContextId}/${seedRunId}/${entry.artifact}` ``
   (`scenario-artifacts.ts:50`) — rather than calling core's
   `buildArtifactUri` (`packages/core/src/runbook/artifact-uri.ts:109-115`),
   which is the canonical constructor and applies `assertSafeId` /
   `validateConcreteRunId` / `validateExactArtifactKey`.
3. Hand-writes the manifest row via `appendArtifactManifestRecordSync`, inventing
   a `runbook: { source: 'project', path: 'producer.runbook.md' }` provenance for
   a producer runbook that does not exist, and a frozen
   `timestamp: '2026-05-25T00:00:00.000Z'` (`scenario-artifacts.ts:51-61`).
4. Materialises a fake backing file containing `{"seeded":true}` at a
   **re-derived** local path,
   `` join(location.cwd, WORK_PATH, `.rd-${seedContextId}`, seedRunId) ``
   (`scenario-artifacts.ts:65-67`) — a second, independent copy of the
   URI→path mapping that core owns in `artifactUriToPath`
   (`artifact-uri.ts:197-229`).

The returned `name → URI` map is then spliced into command text by
`substituteArtifactUris` (`packages/cli/src/helpers/command-sequence.ts:466-479`)
resolving the `${ARTIFACT:<name>}` grammar.

### 1.1 Why this is fragile

- **Duplication of core.** Steps 2 and 4 above are hand-rolled reimplementations
  of `buildArtifactUri` and `artifactUriToPath`. Step 3 hand-rolls the manifest
  row's provenance shape. If any of the three change in core, the harness drifts
  silently — the seed keeps "working" while no longer resembling what production
  emits.
- **Synthetic fidelity.** No real `rd` command ever emits a row like this. The
  consume path (`--artifacts PlanPath=<uri>` → naked `ARTIFACTS` step) is
  therefore tested against an approximation of its own input.
- **Two placeholder grammars.** `${ARTIFACT:<name>}`
  (`command-sequence.ts:470`, synchronous, map-backed) and
  `${CAPTURE_ARTIFACT[_ARRAY]:<key>}` (`command-sequence.ts:515`, async,
  manifest-backed) each carry their own regex and resolver, plus a third
  non-global detector `CAPTURE_ARTIFACT_PLACEHOLDER` (`command-sequence.ts:542`)
  that must stay in sync with the second. Two grammars for one concept —
  "give this command an artifact URI" — is one too many.
- **Command-text-layer splicing.** Values are spliced into command strings and
  re-parsed by `parseRdCommandWithEnv`. This is exactly how `${ARTIFACT:PlanPath}`
  collapsed to the empty string and produced `INVALID_ARTIFACT_INPUT` when the
  production `rundown scenario run` path lacked the substitution wiring — the defect
  whose unblock fix this issue follows up.

### 1.2 The same defect, authored in YAML

The fabrication is not confined to the harness. `direct-uri-input` in
`runbooks/artifacts/artifact-variable-review-plan.runbook.md:8-21` performs the
identical hand-fabrication from inside a scenario, as a `node -e` one-liner
(`artifact-variable-review-plan.runbook.md:12`): it hardcodes
`run='rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'`, `ctx='producer-context'`, builds
`'rd://artifacts/'+ctx+'/'+run+'/'+key` by concatenation, re-derives
`.rundown/work/.rd-<ctx>/<run>` by hand, and writes a manifest row literal
including `timestamp:'2026-05-25T00:00:00.000Z'`.

This spec treats that scenario as in scope. Deleting `seedScenarioArtifacts`
while leaving a copy of it transcribed into YAML would satisfy the letter of the
issue's acceptance criterion ("no fabricated URIs or hand-built manifest rows in
the harness") and none of its intent.

### 1.3 What this design does and does not fix

\#498's "Why it's fragile" lists four items. This design lands **three**:

| # | Item                        | Landed? |
| - | --------------------------- | ------- |
| 1 | Command-text-layer splicing | **No** — deferred to the §3.3 follow-up |
| 2 | Synthetic fidelity          | Yes — §3.1 |
| 3 | Two placeholder grammars    | Yes — §3.2 |
| 4 | Duplication of core         | Yes — §3.1 |

This is a **partial fix**, stated plainly rather than elided. After this change
`${CAPTURE_ARTIFACT}` is still spliced into command text and re-parsed by
`parseRdCommandWithEnv` (`command-sequence.ts:1652`, which runs `shellParse` at
`:349`), exactly as its four sibling grammars are.

Three arguments carry the deferral. The first two say this **tracks the issue's
scope rather than shrinking it**; the third is the sequencing argument.

1. **The issue itself marks the deferred work optional.** #498's "Proposed
   direction" introduces `ScenarioContext` with "**Optionally** thread a typed
   `ScenarioContext`…", and **none** of its four acceptance criteria mention it.
   Item 1 maps onto no acceptance criterion. This design discharges every stated
   criterion (§5).
2. **The foundation value is real, not rhetorical — see §3.3.** Today the harness
   has two injection mechanisms with **different temporal models**. This design
   collapses them to one, which is most of what made the deferred work expensive.
   That is a genuine prerequisite, not a convenient postponement.
3. **Fixing item 1 for artifacts alone is net-negative** while four structurally
   identical neighbours keep splicing strings (§3.3).

### 1.3.1 The residual hazard, sized honestly

Item 1's surviving hazard must not be overstated to justify the work, nor
understated to excuse the deferral. Verified by execution:

- **The scalar form is structurally immune.** `assertSafeId`
  (`packages/core/src/paths.ts:34`) confines ids to `[A-Za-z0-9._-]`, and `rd://`
  URIs add only `/` and `:`. No resolved scalar value can carry a shell
  metacharacter, at any placeholder position, quoted or not.
- **Only the array form is exposed.** `resolveCapturedArtifactFromManifest`
  returns `JSON.stringify(...)` for it (`scenario-artifacts.ts:130`) — a value
  containing `"`. `shell-quote`'s `parse` on
  `--artifacts-json R=["rd://a","rd://b"]` yields the payload
  `R=[rd://a,rd://b]`: one argv entry, `hasOperators: false`, quotes consumed as
  shell quoting, **JSON destroyed**. The quoted spelling
  `--artifacts-json 'R=["rd://a","rd://b"]'` survives byte-identically.
- **It errors; it does not silently corrupt.** The unquoted payload is *invalid
  JSON*, so it throws. The defect is that the error names a value the author
  never wrote — a **usability defect on one grammar**, consistent with #498's
  `P3: low` label.

That bounded blast radius is what makes deferring item 1 defensible at all. It is
also why §3.7 enforces the array form's quoting requirement now rather than
waiting: the hazard is small, but it is currently held off by author convention
alone.

## 2. Goal

One mechanism: **capture-from-command-output**. A scenario that needs a
pre-existing artifact runs a real producer command whose artifact is created
through the real production path, then references it with the surviving
`${CAPTURE_ARTIFACT[_ARRAY]:<key>}` grammar.

## 3. Design decisions

### 3.1 The "built-in deterministic seeder" is a producer **runbook fixture**, not CLI machinery

The issue leaves open whether the seeder is "a real producer command or a
runbook". It is a runbook.

A new fixture, `runbooks/artifacts/scenario-seed-artifacts.runbook.md`, declares
an `ARTIFACTS` block with explicit keys and writes deterministic content into the
projected paths. Running it
(`rundown run scenario-seed-artifacts.runbook.md --allow-all`) drives the genuine
production path — `ARTIFACTS` directive resolution → artifact service →
`buildArtifactUri` → manifest append — so the seeded row is, by construction,
exactly what production emits. There is nothing left to keep in sync.

**The name is scoped deliberately.** `packages/cli/scripts/copy-runbooks.js`
copies `runbooks/**` into `packages/cli/dist/runbooks/`, and
`packages/cli/package.json:11-14` publishes `files: ["dist"]` — so this fixture
**ships to every installed user** and appears in `rundown ls --all` as a bundled
runbook. Existing fixtures already ship, so this is not a new class of exposure;
but a bundled runbook called `seed-artifacts` reads like a general-purpose
utility and invites a confused user to run it, where `artifact-variable-write-plan`
does not. `scenario-seed-artifacts` names what it is. `copy-runbooks.js:44-51`
throws on a duplicate relative path; no `*seed*` runbook exists today, so there
is no collision.

**Rejected: a bespoke `rundown seed-artifact` CLI command.** CLAUDE.md is explicit
that the CLI is a thin wrapper and that runbook logic does not live in it. A
harness-only command that mints artifacts outside the state machine would be a
parallel artifact-production path — precisely the "shadow implementation"
the architectural principles forbid, and precisely the fidelity gap this issue
exists to close. A runbook fixture needs **zero** new production code.

**Rejected: reusing `artifact-variable-write-plan.runbook.md` as the seeder.**
It is already a real producer (`artifact-variable-write-plan.runbook.md:65-73`,
producing key `plan.json`), and `review-plan-uri-input`
(`artifact-variable-write-plan.runbook.md:19-31`) already consumes it via
`${CAPTURE_ARTIFACT:plan.json}` — so the pattern is proven. But it produces only
`plan.json`, whereas `consume-plan-artifact` asserts `key: PlanPath`
(`execute-plan.runbook.md:19`) — and a naked `ARTIFACTS` alias fed an exact URI
surfaces the **injected record's** key, so the assertion cannot be satisfied by a
`plan.json` row. Reusing write-plan would force that assertion to change, coupling
two unrelated fixtures and obscuring whether the migration preserved behaviour. A
dedicated seeder that emits **both** keys lets `consume-plan-artifact`'s
assertion stay byte-identical, which is the evidence that the migration is
behaviour-preserving.

**This reasoning is specific to `consume-plan-artifact` and does not generalise.**
It is an argument for a dedicated seeder where a scenario is being *preserved*
across a migration. It says nothing about scenarios being *retired* — see §3.5,
where `direct-uri-input` is deleted rather than migrated precisely because
nothing about it is worth preserving once fabrication is gone.

The seeder emits two keys from one step:

| Alias           | Key         | Consumer                                          |
| --------------- | ----------- | ------------------------------------------------- |
| `PlanPathSeed`  | `PlanPath`  | `execute-plan.runbook.md` `consume-plan-artifact` |
| `PlanJsonSeed`  | `plan.json` | None today (see §3.5). Emitted as the natural companion key, at a cost of one line, so a future scenario needing a seeded `plan.json` does not reopen this design. |

Both keys satisfy `assertSafeId` (`packages/core/src/paths.ts:34-41`) — `PlanPath`
is the key the current seed already uses, so it is known-safe.

### 3.2 `seed:` is **removed**, not reshaped

The issue asks for "the new `seed:` schema shape". The answer is that there
isn't one.

Once seeding means "run a producer command and capture its output", `seed:` is a
strictly less capable spelling of two lines that scenarios can already write:

```yaml
commands:
  - rundown run scenario-seed-artifacts.runbook.md --allow-all
  - "rundown run execute-plan.runbook.md --artifacts PlanPath=${CAPTURE_ARTIFACT:PlanPath}"
```

A `seed:` field redefined as "a producer command to run first" would be an alias
for "put the producer command first in `commands:`" — a second way to say one
thing, which is what the issue is trying to eliminate. `ScenarioSeedSchema`
(`packages/cli/src/schemas/scenarios.ts:121-141`) and the `seed` field
(`scenarios.ts:148-149`) are deleted.

The reasonable counter-argument, recorded and rejected: scenarios double as
copy/paste user documentation, and `seed:` marked a precondition as *setup*
rather than as part of the demonstrated flow, keeping `commands:` free of
scaffolding. That distinction is real but unpaid-for — the harness has no
separate rendering for setup (`executeScenario` in
`scenario-workflow.ts:458-491` seeds and then executes one flat command list),
so the only thing `seed:` buys is a shorter `commands:` block. Against that: a
reader of the migrated scenario sees the actual, runnable sequence that produces
the precondition, which is *more* honest documentation, not less. YAGNI wins.

**No harness change is needed to stage the producer.** `extractRunbookReferences`
(`command-sequence.ts:1459-1475`) scans command strings for `*.runbook.md`, and
both harnesses stage what it finds (`scenario-workflow.ts:372,405-409`;
`scenario-runner.test.ts:301-313`). Adding
`rundown run scenario-seed-artifacts.runbook.md --allow-all` to `commands:`
auto-stages the seeder. The migration is pure YAML plus deletions.

#### 3.2.1 Removal must be **enforced**, not silent

Deleting the code is not sufficient, and this is the subtlest point in the
design. `ScenarioSchema` (`packages/cli/src/schemas/scenarios.ts:143-185`) is
`z.object({...}).refine(...).refine(...)` with **no** `.strict()`, on Zod 4
(`packages/cli/package.json:51`, `"zod": "^4.4.3"`), where unknown keys are
**stripped by default**. A naive deletion therefore produces exactly this:

1. A scenario still carrying `seed:` parses **successfully** — `seed:` is
   silently dropped.
2. Its command still carrying `${ARTIFACT:PlanPath}` has no substituter left, so
   the literal placeholder text is passed through to `--artifacts`.
3. The run fails with an opaque `INVALID_ARTIFACT_INPUT`.

That is **verbatim** §1.1's last bullet — the defect this issue exists to
prevent. Silently deleting the grammar re-creates it.

The codebase already rejects this pattern one function away:
`CAPTURE_ARTIFACT_PLACEHOLDER` (`command-sequence.ts:542`, used at
`command-sequence.ts:1642`) exists for no purpose other than making an
unresolvable capture placeholder **throw** rather than leak into the executed
command. The retired grammar gets the same treatment, on two surfaces:

| Surface        | Mechanism                                                    | Rejects                          |
| -------------- | ------------------------------------------------------------ | -------------------------------- |
| Scenario schema | `z.strictObject` on `ScenarioSchema`                         | the `seed:` **field**, at load   |
| Command text    | `RETIRED_ARTIFACT_PLACEHOLDER = /\$\{ARTIFACT:[^}]+\}/`, thrown in `executeCommandSequence` | the `${ARTIFACT:}` **grammar**, before execution |

Both are needed: a scenario can carry the placeholder without ever carrying
`seed:`, so the schema layer does not subsume the command layer. The thrown
message names the retirement (#498) and points at `${CAPTURE_ARTIFACT:<key>}`.

`z.strictObject` is used rather than the deprecated `.strict()` method because
`.strict()` cannot be chained after the two `.refine(...)` calls, which return a
non-object schema type.

**This is a tombstone, not a shim.** CLAUDE.md's no-migration rule forbids
compatibility shims, fallback parsers, and warning-only adapters — code that
keeps retired input *working*. A detector that makes retired input **fail with a
message naming its replacement** is the opposite, and is precisely the "detect
invalid input and prompt explicit user action" behaviour that rule mandates.
Failing loudly *serves* the no-migration rule; failing silently defeats it.

A side benefit of strictness: it stops silently swallowing typo'd scenario keys
repo-wide. If enabling it surfaces a parse failure in a scenario unrelated to
`seed:`, that is a genuine latent defect stripping was hiding, and the fix is the
scenario, not the schema.

### 3.3 `ScenarioContext` threading is **out of scope** — follow-up

The issue floats "optionally thread a typed `ScenarioContext` (seeded map +
capture state + cwd/env) into `executeCommandSequence` instead of string
substitution".

Deferred, and it should be a separate issue. After this change there is exactly
**one** artifact grammar — but `executeCommandSequence`
(`command-sequence.ts:1629-1649`) still string-splices four sibling grammars that
this issue does not touch: `${TOKEN}` (`substituteTokens`,
`command-sequence.ts:442-452`), `${CLAIM_ID}` (`substituteClaimIds`,
`command-sequence.ts:554-562`), `${RUN_CLAIM_ID}` (`substituteRunClaimIds`,
`command-sequence.ts:575-588`), and `${RUN_ID}` (`substituteRunIds`,
`command-sequence.ts:606-614`). Threading a typed context for artifacts alone,
while its four structurally identical neighbours keep splicing strings, buys
inconsistency rather than type safety, and leaves the actual splice-then-reparse
hazard fully intact.

A `ScenarioContext` refactor is worth doing across all five grammars at once.
That is a different change with a different blast radius, and folding it in here
would couple a mechanical consolidation to a harness-wide redesign.

#### 3.3.1 The real foundation argument: this design collapses two temporal models into one

The "four sibling grammars" point above is a **convenience** argument — it says
the refactor is cheaper done together. It is true, but it is not the strongest
reason to sequence this design first. The stronger one is that this design
removes a genuine obstacle:

Today the harness has **two injection mechanisms with different temporal
models**, not merely two grammars:

| Mechanism | Value known | Shape | Failure mode | Detected |
| --------- | ----------- | ----- | ------------ | -------- |
| `${ARTIFACT:<name>}` (seed) | **Before** execution | Pre-built `name → URI` map, built by `seedScenarioArtifacts` | Name absent from the map | At substitution, synchronously |
| `${CAPTURE_ARTIFACT[_ARRAY]:<key>}` | **During** execution | Resolved from the manifest a prior command wrote | No matching row; ambiguous latest row | At resolution, asynchronously, per command |

A typed `ScenarioContext` must model **both** — a static seeded map *and* an
evolving capture state — with two failure modes surfacing at two different
points, and a type that admits both. That dual-temporality is most of what made
the deferred work look expensive.

This design collapses it to **one** temporal model: every artifact value is
capture-from-output, resolved during execution by a single resolver
(`resolveCapturedArtifactFromManifest`), with one failure mode at one detection
point. The follow-up then threads *one* uniform notion of a resolved value, not a
union of two.

So the sequencing is not "defer the hard part" — it is "remove the thing that
made the hard part hard". Being honest about what it still costs: deferring means
\#498's fragility item 1 is **not fixed** by this change (§1.3). The deferral is
defensible, and now cheaper to discharge, but it is not free.

#### 3.3.2 The §3.7 quoting guard is deliberate throwaway

§3.7 adds `assertArrayCapturesAreShellQuoted` to enforce the array form's
shell-quoting requirement. Under parse-then-substitute, resolved values are
injected into an already-parsed argv and **never reach `shellParse`** — the
quoting requirement evaporates and that guard becomes dead code this follow-up
deletes.

This is recorded as **~10 lines of accepted waste, not an oversight**. It buys
enforced correctness over an interval of unknown length, during which
splice-then-reparse is real and the requirement is otherwise held off by author
convention alone. The follow-up issue names the guard among the things it
removes, so the waste is tracked rather than fossilised.

**Follow-up issue:** [#604](https://github.com/tobyhede/rundown/issues/604).

### 3.4 What survives

`resolveCapturedArtifactFromManifest` (`scenario-artifacts.ts:98-148`),
`substituteCapturedArtifacts` (`command-sequence.ts:508-533`), and
`CAPTURE_ARTIFACT_PLACEHOLDER` (`command-sequence.ts:542`) are unchanged. The
capture resolver already reads the manifest through core's
`readAllArtifactManifestRecords`, so the row shape lives in one place
(`scenario-artifacts.ts:107-112`); its recency ordering and cross-context
ambiguity guard (`scenario-artifacts.ts:127-147`) are the behaviour this design
leans on and does not modify.

### 3.5 Two scenarios are **deleted**, not migrated

#### `direct-uri-input` — migrating it would produce an exact duplicate

§1.2 establishes that `direct-uri-input`
(`artifact-variable-review-plan.runbook.md:8-21`) cannot stay as authored. But
migrating it onto the seeder is equally wrong: **post-migration it is
character-for-character `review-plan-uri-input`**
(`artifact-variable-write-plan.runbook.md:19-31`) apart from *which* producer
runs first — and once both producers are real producer runbooks, that is a
distinction with no behavioural content. Its entire reason to exist was
exercising the consume path against a **fabricated** row. Remove the fabrication
and it has no remaining job.

Delete it. The commit must name the unique coverage lost: none.

Note the asymmetry with §3.1, which is not an inconsistency. There, a dedicated
seeder is justified so `consume-plan-artifact`'s assertion stays byte-identical
— an argument about *preserving* a scenario across a migration. Nothing is being
preserved here.

#### `review-plan-cross-context-uri-input` — pre-existing duplication, silently testing nothing

`review-plan-cross-context-uri-input`
(`artifact-variable-write-plan.runbook.md:33-45`) is **byte-identical** to
`review-plan-uri-input` (`:19-31`): same two commands, same `expect` block, zero
differences outside the `description:` string. It has never exercised
cross-context anything. Both of its `rundown run` invocations execute in the
*same*
context — which is exactly why it is identical. This predates #498 and is
unrelated to seeding; it is in scope only because this design is the first thing
to look closely at these fixtures.

**Delete it.** The alternative — give it a genuinely distinct producer context —
is rejected on two grounds:

1. **No affordance exists.** There is no `--context` flag on any command, so the
   scenario layer cannot force two runs into different contexts. Making the
   scenario honest would require new production surface: building a feature to
   serve a test.
2. **The behaviour is already covered where it can actually be constructed.**
   `resolveCapturedArtifactFromManifest`'s cross-context handling is unit-tested
   at `packages/cli/__tests__/helpers/scenario-artifacts.test.ts:54`
   (cross-context same-timestamp scalar pick throws ambiguous), `:74`
   (genuinely-latest URI wins across contexts), and `:95` (array form returns all
   cross-context collisions). Those tests build the multi-context manifest
   directly.

A scenario whose name claims coverage its body does not provide is worse than no
scenario: it gets cited as evidence in review.

### 3.6 The surviving grammar gets a property test — at the composed boundary

This design promotes `substituteCapturedArtifacts` (`command-sequence.ts:508-533`)
from one of two artifact grammars to **the** artifact grammar, and every migrated
scenario now depends on it. Promoting it to load-bearing without adding coverage
would trade one fragility for another. But *what* to pin matters more than
whether to pin something, and the obvious target is the wrong one.

**Rejected: properties over the splice arithmetic alone.** The function is
hand-rolled index arithmetic over `matchAll` (`:525-532`) — a running `last`
offset, `match.index` starts, manual `cmd.slice` concatenation — so it looks like
the fragile part. It is not. That arithmetic is correct today, this design does
not touch it, and nobody has disputed it. Properties asserting offsets, N→N
resolver calls, and no-re-scan are **green before this change and green after**:
they are evidence for an undisputed claim. They are worth keeping — they are
cheap and they pin the splice against future edits — but they are not the point.

**The load-bearing invariant is composed.** `substituteCapturedArtifacts` does
not own its output: it splices a value into command text and hands it to
`parseRdCommandWithEnv` (`command-sequence.ts:1652`), which runs `shellParse`
(`:349`). The value must survive **that** tokenizer:

```text
∀ resolved value v accepted by the §3.7 quoting guard, ∀ placeholder position:
  parseRdCommandWithEnv(await substituteCapturedArtifacts(cmd, () => v))
    contains v as exactly one argv entry, byte-identical
```

**The precondition is required, and is not a fudge.** Without "accepted by the
guard" the property is **unconditionally red** — the unquoted array form
falsifies it (§1.3.1). The precondition states exactly which commands the harness
accepts, which is why §3.7's guard is part of this design rather than a nicety.
It is also not vacuous: it admits every scalar placeholder in any position plus
every correctly quoted array placeholder — 100% of the legal grammar and 100% of
the real call sites. The unquoted-array falsification is pinned as an explicit
known-failure test, so the precondition is visibly non-arbitrary rather than
tuned until green.

Under the §3.3 follow-up the composed property becomes **true by construction**
(a value injected into an already-parsed argv is trivially one byte-identical
entry). These properties are therefore **inherited by that refactor, not
obsoleted by it**: they are its acceptance test, and it should drop the
*precondition*, not the property.

`packages/cli/__tests__/services/renderers/json-renderer.properties.test.ts` is
the CLI package's only existing fast-check file (`fast-check` is already a CLI
devDependency, `packages/cli/package.json:60`); the new test follows its
conventions.

### 3.7 The array form's quoting requirement is **enforced**, not conventional

§1.3.1 establishes the defect: the array form resolves to JSON containing `"`,
and unquoted, `shellParse` consumes those quotes and delivers invalid JSON.
Correctness of the sole surviving artifact grammar therefore rests on authors
remembering single quotes. Both existing array call sites do quote —
`runbooks/artifacts/artifact-variable-write-plan.runbook.md:52` and
`artifact-variable-collate.runbook.md:13` — by convention, with nothing checking
them.

§3.2.1 already establishes the fail-fast tombstone pattern for "illegal input
must not pass through silently". The quoting requirement gets the same treatment:
`assertArrayCapturesAreShellQuoted` in `command-sequence.ts`, thrown from
`executeCommandSequence` before the command runs.

**Rejected: make the resolver emit shell-escaped JSON.** Escaping a value to
survive a tokenizer *we control and invoke ourselves* is the wrong direction. It
bakes the splice-then-reparse hazard deeper into the design at the exact moment
§3.3's follow-up intends to remove it, and it makes the resolved value differ
from the value the consumer receives.

**Rejected: a regex asserting the placeholder is single-quoted.** Detecting "is
this placeholder quoted" by matching quotes in raw text is itself the fragile
string analysis this design reduces — and the naive form is not merely fragile,
it is **wrong**. Verified by execution: `/'\$\{CAPTURE_ARTIFACT_ARRAY:[^}]+\}'/`
returns `false` on `artifact-variable-collate.runbook.md:13`, because authors
quote the **whole assignment** (`--artifacts-json 'Reviews=${…}'`), not the
placeholder — the character before it is `=`. It would false-reject **both** real
call sites. A "smarter" regex means reimplementing shell quoting rules.

**Chosen: probe the real tokenizer.** Replace each array placeholder with a probe
value carrying the same shell-significant characters as real resolved JSON
(`["rd://s"]`), run the probe command through the very `shellParse` it is about to
face, and require the probe to survive intact once per placeholder. The oracle is
the tokenizer itself, so the guard cannot disagree with it, and no quoting rule is
reimplemented. `shellParse` is already imported (`command-sequence.ts:18`), so
this adds no dependency.

Soundness of the probe: a resolved array is `JSON.stringify` of `rd://` URIs, so
its character set is closed under `assertSafeId`'s `[A-Za-z0-9._-]`
(`paths.ts:34`) plus `/`, `:`, and JSON's `[`, `]`, `"`, `,`. The only
shell-significant members are `"`, `[`, and `]` — all present in the probe.
Occurrences are counted rather than matching argv entries, since two placeholders
can legitimately share one quoted entry.

Verified by execution against `shell-quote`: the guard accepts the canonical
quoted form, a placeholder inside a longer quoted region, two placeholders in one
quoted entry, two separately quoted placeholders, and the scalar form; it rejects
the unquoted form, the double-quoted form (genuinely broken for JSON), and a
mixed quoted/unquoted pair.

This guard is **deliberate throwaway** — see §3.3.2.

## 4. Scope

**Removed:**

| Symbol                                        | Location                                    |
| --------------------------------------------- | ------------------------------------------- |
| `seedScenarioArtifacts`                       | `packages/cli/src/helpers/scenario-artifacts.ts:42-71` |
| `substituteArtifactUris` (`${ARTIFACT:}`)     | `packages/cli/src/helpers/command-sequence.ts:454-479` |
| `ScenarioSeedSchema`, `ScenarioSeed`          | `packages/cli/src/schemas/scenarios.ts:113-141` |
| `seed` field on `ScenarioSchema`              | `packages/cli/src/schemas/scenarios.ts:148-149` |
| Seed wiring (`rundown scenario run`)               | `packages/cli/src/helpers/scenario-workflow.ts:454-459` |
| Seed wiring (jest runner)                     | `packages/cli/__tests__/integration/scenario-runner.test.ts:351-355` |

**Added:**

| Item                                                                  | Why                       |
| --------------------------------------------------------------------- | ------------------------- |
| `runbooks/artifacts/scenario-seed-artifacts.runbook.md`               | The producer fixture, §3.1 |
| `z.strictObject` on `ScenarioSchema` (`packages/cli/src/schemas/scenarios.ts:143`) | Reject `seed:`, §3.2.1 |
| `RETIRED_ARTIFACT_PLACEHOLDER` + its throw (`packages/cli/src/helpers/command-sequence.ts:542,1642`) | Reject `${ARTIFACT:}`, §3.2.1 |
| `assertArrayCapturesAreShellQuoted` + `ARRAY_QUOTING_PROBE` + `CAPTURE_ARTIFACT_ARRAY_PLACEHOLDER` (`packages/cli/src/helpers/command-sequence.ts`) | Enforce array-form quoting, §3.7. **Deliberate throwaway** — deleted by the §3.3 follow-up (§3.3.2) |
| `packages/cli/__tests__/helpers/command-sequence.properties.test.ts`   | Pin the sole grammar at the composed boundary, §3.6 |

The design's production additions are **two fail-fast guards and nothing else** —
no behaviour changes. Both are small and neither is optional: §3.2.1 explains why
deleting the retired grammar without a tombstone re-creates the very bug being
fixed, and §3.7 explains why leaving the surviving grammar's quoting requirement
to author convention leaves the sole artifact mechanism resting on a habit.

**Migrated:**

| Scenario                | File                                              | From                     |
| ----------------------- | ------------------------------------------------- | ------------------------ |
| `consume-plan-artifact` | `runbooks/artifacts/execute-plan.runbook.md:8-20` | `seed:` + `${ARTIFACT:}` |

**Deleted (§3.5):**

| Scenario                              | File                                                               | Unique coverage lost |
| ------------------------------------- | ------------------------------------------------------------------ | -------------------- |
| `direct-uri-input`                    | `runbooks/artifacts/artifact-variable-review-plan.runbook.md:8-21`  | None — migrated, it duplicates `review-plan-uri-input` |
| `review-plan-cross-context-uri-input` | `runbooks/artifacts/artifact-variable-write-plan.runbook.md:33-45`  | None — already byte-identical to `review-plan-uri-input` |

These are the complete set: `runbooks/artifacts/execute-plan.runbook.md:10` is
the only `seed:` in the repository, and `${ARTIFACT:}` appears in no other
runbook. The remaining `${CAPTURE_ARTIFACT[_ARRAY]:}` users
(`artifact-variable-write-plan.runbook.md:23,51,52` after the §3.5 deletion) are
already on the target mechanism and are not touched.
`forged-file-record-rejected`
(`artifact-variable-review-plan.runbook.md:22-32`) is also untouched: its `node -e`
writes an intentionally forged record to assert the input channel **rejects** it.
The forgery is the assertion, not a seeding shortcut.

## 5. Acceptance

Mapped from the issue:

- [x] Dated design spec — this document.
- [ ] Single placeholder/capture mechanism; `${ARTIFACT:}` grammar retired —
      §3.2, §4 — and its retirement **enforced** rather than silent, §3.2.1.
- [ ] No fabricated URIs or hand-built manifest rows in the harness — §3.1, and
      §1.2 extends this to the YAML-authored copy.
- [ ] Existing artifact scenarios migrated and green under both
      `pnpm run test:scenarios:raw` and the jest scenario runner
      (`packages/cli/__tests__/integration/scenario-runner.test.ts`) — §4.

Every stated acceptance criterion is discharged. #498's fragility item 1 is not
(§1.3) — it maps onto no acceptance criterion, is marked **optional** in the
issue's own "Proposed direction", and is owned by the §3.3 follow-up issue. Its
residual hazard is bounded and enforced against in the interim (§1.3.1, §3.7).

**Verification note.** Every grep used to check these criteria must pass
`--exclude-dir=dist --exclude-dir=.stryker-tmp --exclude-dir=node_modules` (or
use `git grep`). All three are gitignored (`.gitignore:44`) but are populated on
disk by the build the scenario harness requires, and a bare
`grep -rn 'ARTIFACT:' packages/` returns ~49 hits from build output alone.

## 6. Risks

- **`--allow-all` on the seeder command.** The seeder writes its backing files
  from a bash block, so its `rundown run` needs `--allow-all`, matching
  `artifact-variable-write-plan.runbook.md:9`. The consumer command keeps its
  existing (absent) policy flags. This widens the seeder command's policy only.
- **The seeder publishes to end users.** It lands in `dist/runbooks/` and
  `rundown ls --all` for every install (§3.1). Mitigated by the scoped name, not
  eliminated; eliminating it would mean a fixtures-excluded publish path, which is
  a separate change affecting every existing fixture equally.
- **`z.strictObject` is repo-wide.** Making `ScenarioSchema` strict can surface
  parse failures in scenarios unrelated to `seed:` — any unknown key that
  stripping was silently swallowing. Treated as a benefit, not a regression
  (§3.2.1): the fix is the typo'd scenario, never a weakened schema. The blast
  radius is bounded — scenario YAML only, caught at load, in the harness.
- **The §3.7 quoting guard could be over-tight.** It rejects commands, so a false
  rejection breaks a legitimate scenario. Bounded by construction — it probes the
  real `shellParse` rather than reimplementing quoting rules, so it can only
  disagree with the tokenizer if the probe's character coverage is wrong (§3.7
  argues it is not). The acceptance evidence is that the repository's two real
  array call sites (`artifact-variable-write-plan.runbook.md:52`,
  `artifact-variable-collate.runbook.md:13`) still pass under
  `pnpm run test:scenarios:raw`. If it ever false-rejects, the fix is the guard,
  never the scenario. It is also throwaway (§3.3.2), so its long-run cost is
  bounded by the follow-up.
- **Capture ambiguity.** `resolveCapturedArtifactFromManifest` throws on an
  equal-timestamp scalar pick spanning multiple contexts
  (`scenario-artifacts.ts:142-146`). Each migrated scenario produces exactly one
  row per key from one seeder run, so no tie exists.
- **Loss of a negative test.** `ScenarioSeedSchema`'s reserved-name /
  path-traversal guards (`scenarios.ts:132-137`) and their tests
  (`packages/cli/__tests__/schemas/scenarios.test.ts:134-188`) are deleted with
  the schema. This is not a coverage regression: the guards existed *because* the
  harness joined an author-supplied name into a URI and a filesystem path. With
  the join gone, so is the attack surface. Artifact keys now originate from the
  `ARTIFACTS` directive and are validated by core's `assertSafeId` /
  `validateExactArtifactKey` (`artifact-uri.ts:364-369`) on the real production
  path.
