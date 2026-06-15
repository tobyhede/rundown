# Runbook Entrypoint / Bootstrap Skills — Design

**Date:** 2026-06-15
**Status:** Partially superseded — see Decision update
**Package:** `@rundown-org/claude-code-plugin`

> **Decision update (agent-driven start).** The principle is now: *the
> orchestrating agent always starts the runbook; nothing auto-starts behind it.*
> This supersedes Part 2 below, which proposed reusing the `SkillStart`
> auto-start gate (skill `runbook:` frontmatter). What shipped:
>
> - **Kept:** the generic `rundown` launcher (Part 1a) and the broadened
>   `running-runbooks` trigger (Part 1b) — both already agent-driven.
> - **Kept (rewritten):** the `writing-runbooks` "Companion Bootstrap Skill"
>   guidance, now describing agent-driven bootstrap skills (the skill body tells
>   the agent to run `rd run`), not the `runbook:` frontmatter gate.
> - **Reverted:** the `planning` migration to `runbook:` frontmatter (Part 2b);
>   `planning` keeps its agent-driven start.
> - **Follow-up:** remove the auto-start gate entirely — tracked in
>   [#454](https://github.com/tobyhede/rundown/issues/454).

## Problem

A user authors a runbook (e.g. `planning.runbook.md`) and wants to run it with
Claude using natural language. Today that path is incomplete:

- `running-runbooks`'s `description` triggers when a runbook is **already
  active** or when CLI output appears — not on a cold-start request like
  "run the planning runbook".
- There is no generic, name-addressable entrypoint (the `/rundown <runbook>`
  ergonomic the user wants).
- The per-runbook bootstrap pattern exists in exactly one place (`planning`),
  hand-rolled with a manual `<important>` block, and is not documented for
  authors to reproduce.

A runbook is "runnable by Claude" when it is **discoverable** (`rd ls --all`
finds it), **invocable** (Claude knows to issue `rd run`), and **executable**
(Claude knows the pass/fail protocol). The gap is the bridge from a user's
intent to `rd run` + protocol.

## Key Discovery — the machinery already exists

The plugin ships **zero commands**; it is skills-only. The bootstrap mechanism
is already built but unused:

- **`SkillStart` gate** (`packages/claude-code-plugin/src/gates/on-skill-start.ts`,
  wired through `src/dispatcher.ts`): when any skill starts, if that skill's
  `SKILL.md` declares a `runbook:` frontmatter field, the gate runs
  `rd run <runbook>` and injects context:

  ```
  ## RUNBOOK ACTIVE: <runbook>
  Invoke the running-runbooks skill: `Skill(skill: "rundown:running-runbooks")`
  <cli output>
  ```

- **No skill uses `runbook:` frontmatter today.** The `planning` skill
  replicates this behaviour by hand with an `<important>` block telling Claude
  to `rd run rundown:planning` then invoke `running-runbooks`.

- Runbooks already carry the reverse pointer: `skill:` frontmatter
  (`write-plan` → `writing-plans`, `execute-plan`, `address-review`,
  `implement-plan`, `convert-skill`). It is schema-validated and tracked in
  state (`active_skill`); it is not used to auto-inject a skill.

Therefore this work is primarily **conventions + a cold-start launcher +
author guidance**, not new machinery.

## Design

Three layers, two of which are new conventions over existing mechanism.

| Layer | Triggers on | Job |
|-------|------------|-----|
| Per-runbook bootstrap skill (e.g. `planning`) | domain intent ("plan this feature") | bootstrap *that* runbook + name its sibling skills |
| Generic `rundown` launcher | "run the X runbook" / `/rundown X` | resolve any runbook by name, `rd run`, hand off |
| `running-runbooks` | runbook active / CLI output | the pass/fail execution protocol |

### Part 1 — Generic entrypoint

**1a. New `rundown` launcher skill** (`skills/rundown/SKILL.md`).

- Thin. `description` triggers on natural-language "run/start the X runbook";
  invocable as `/rundown <runbook>` with the runbook name as argument.
- Job: resolve the name (via `rd ls --all` / `namespace:name` syntax),
  issue `rd run <name>`, then defer to `running-runbooks` for execution.
- No protocol duplication — it launches and hands off. Once `rd run` succeeds a
  runbook is active and the protocol layer owns the rest.

**1b. Broaden `running-runbooks` description.** Widen the trigger so a cold
"run/start the X runbook" still routes to the protocol when the launcher does
not apply. Scope the wording so the launcher is the primary cold-start trigger
and `running-runbooks` complements rather than double-fires (launcher = front
door; `running-runbooks` = protocol once active).

### Part 2 — Per-runbook bootstrap skills

> **⚠ Superseded — historical.** The `runbook:` frontmatter gate described in
> this part did **not** ship. Per the Decision update above, bootstrap skills are
> agent-driven: the skill body instructs the agent to run `rd run <name>`; there
> is no auto-start frontmatter. Part 2a's guidance was rewritten accordingly in
> `writing-runbooks`, and Part 2b (the `planning` migration) was reverted. The
> text below is retained as a record of the original approach.

**2a. Document the pattern in `writing-runbooks`.** Add a "Companion bootstrap
skill" section: a concise `SKILL.md` template plus heuristics for which sibling
skills the bootstrap skill should reference.

A bootstrap skill is a `SKILL.md` with:

- `runbook: <name>` frontmatter — fires the existing `SkillStart` gate, which
  auto-runs the runbook and injects the `running-runbooks` invocation.
- a domain-intent `description` (what user need this runbook serves).
- a short body naming the runbook and its sibling skills.

Sibling-skill heuristics:

- **Always** → `running-runbooks` (the gate already injects this).
- Runbook contains `- DELEGATE` → reference `delegating-runbooks`.
- Runbook is a plan pipeline (writes/reviews/executes a plan) → reference
  `writing-plans` / `executing-plans`.
- (Extend the heuristic table as more skills warrant it.)

**2b. Migrate the `planning` skill** to the documented pattern: add
`runbook: rundown:planning` frontmatter, drop the manual `<important>` block,
and rely on the gate for the auto-run + `running-runbooks` injection. This both
removes the inconsistency and serves as the acceptance test (below).

### Part 3 — Direct-CLI injection (deferred)

When a user runs `rd run` directly in the terminal (not via a skill), the same
`RUNBOOK ACTIVE → running-runbooks` context could be injected via a
PostToolUse hook on `Bash rd run`. **Deferred.** Parts 1+2 cover the
"Claude runs the runbook" story; a second injection path risks conflicting with
the gate's output. Revisit once the core is proven.

## Acceptance — `planning` as the real-world test

> **⚠ Superseded — historical.** The acceptance criterion below assumes the
> reverted `runbook:` frontmatter + `SkillStart` gate path. As shipped,
> `planning` keeps its agent-driven start (the agent runs `rd run
> rundown:planning`); the pipeline still runs **plan → review → execute**
> end-to-end, just without the auto-start gate. The criteria below are retained
> as a record of the original approach.

The design is not complete until the `planning` skill, driven through
`runbook:` frontmatter + the `SkillStart` gate (with the manual block removed),
runs its full **plan → review → execute** pipeline end-to-end exactly as it
does today. Precedent: the repo already validates shipped example runbooks
(commit `018447763`).

Concretely:

1. Invoking the `planning` skill auto-starts `rundown:planning` via the gate.
2. The injected context invokes `running-runbooks`.
3. The pipeline runs through all three gated stages with no manual `rd run`.
4. The generic launcher can independently start an arbitrary fresh runbook by
   name (e.g. a freshly authored `.rundown/runbooks/<x>.runbook.md`).

## Components & boundaries

- `skills/rundown/SKILL.md` — new launcher (Part 1a). Depends on `rd` CLI
  discovery and `running-runbooks`.
- `skills/running-runbooks/SKILL.md` — description-only change (Part 1b).
- `skills/writing-runbooks/SKILL.md` — new authoring section (Part 2a). Depends
  on the `runbook:`/`SkillStart` contract.
- `skills/planning/SKILL.md` — frontmatter migration, block removal (Part 2b).
- No changes to `on-skill-start.ts` or the dispatcher — the gate is reused
  as-is.

## Testing

- **Skill frontmatter/structure tests** (`__tests__/skills/`): assert the
  `rundown` launcher and migrated `planning` skill have the expected
  frontmatter (`runbook:` present on `planning`; launcher description shape).
- **Gate behaviour**: existing `on-skill-start` tests already cover the
  `runbook:` path; add a case asserting `planning` resolves to
  `rundown:planning`.
- **End-to-end** (`__tests__/runbooks/` / e2e): the `planning` pipeline runs
  via the skill-triggered gate path.
- `rd check` on any runbooks touched.

## Out of scope / YAGNI

- An `rd bootstrap <runbook>` generator (rejected — authoring guidance in
  `writing-runbooks` covers it without new tooling).
- Bespoke per-runbook skills beyond `planning` (created on demand using the
  documented pattern).
- Part 3 direct-CLI injection (deferred).

## Future work

- Direct-CLI `rd run` context injection (Part 3).
- Heuristic expansion in `writing-runbooks` as new sibling skills appear.
