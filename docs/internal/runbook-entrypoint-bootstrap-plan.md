# Runbook Entrypoint / Bootstrap Skills Implementation Plan

> **Decision update (agent-driven start).** Tasks 1–3 shipped (Task 3's docs were
> rewritten to the agent-driven model). **Tasks 4 and 5 were reverted**: the
> orchestrating agent always starts the runbook, so `planning` keeps its
> agent-driven start rather than migrating to the `SkillStart` auto-start gate.
> Removing the gate is tracked in
> [#454](https://github.com/tobyhede/rundown/issues/454). The references to the
> `SkillStart` gate / `runbook:` frontmatter below are retained as historical
> record of the original approach.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make any authored runbook runnable by Claude from a cold-start natural-language request, and document the per-runbook companion-skill pattern, reusing the existing `SkillStart` gate.

**Architecture:** Three skill layers — a generic `rundown` launcher (cold-start, name-addressable), the existing `running-runbooks` protocol (broadened to catch cold-start), and per-runbook bootstrap skills that declare a `runbook:` frontmatter field consumed by the already-built `SkillStart` gate (`src/gates/on-skill-start.ts`). No machinery changes; this is conventions + author guidance + migrating `planning` onto the gate as the real-world acceptance test.

**Tech Stack:** Markdown skill files (`SKILL.md`), Jest (`@jest/globals`) structural tests that `readFileSync` a `SKILL.md` and assert with regex, the plugin's `SkillStart` gate (TypeScript, unchanged).

**Spec:** `docs/internal/runbook-entrypoint-bootstrap-design.md`

---

## Background the engineer needs

- The plugin is **skills-only** (zero commands). Skills live in `packages/claude-code-plugin/skills/<name>/SKILL.md` and are auto-discovered — no registration file to update.
- Each `SKILL.md` starts with YAML frontmatter: `name:` (kebab-case, must equal the directory name), `description:` (the trigger text Claude matches against intent). Body is markdown.
- **The `SkillStart` gate already exists and is wired in** (`src/gates/on-skill-start.ts`, dispatched from `src/dispatcher.ts` `case 'SkillStart'`). On every skill start it looks up that skill's `SKILL.md`, parses a `runbook:` frontmatter field via `parseRunbookFromFrontmatter` (`src/shared/frontmatter.ts`), and if present runs `rd run <value>` and injects:
  ```
  ## RUNBOOK ACTIVE: <value>
  Invoke the running-runbooks skill: `Skill(skill: "rundown:running-runbooks")`
  <cli output>
  ```
  The `<value>` is passed **verbatim** to `rd run`, so `runbook: rundown:planning` runs `rd run rundown:planning`.
- **No skill uses `runbook:` frontmatter today.** The `planning` skill hand-rolls the same effect with a manual `<important>` block. This plan moves `planning` onto the gate.
- Skill structural test pattern (copy this shape — from `__tests__/skills/planning.test.ts`):
  ```typescript
  import { describe, expect, it } from '@jest/globals';
  import { readFileSync } from 'node:fs';
  import * as path from 'node:path';
  import { fileURLToPath } from 'node:url';

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const skillPath = path.join(__dirname, '..', '..', 'skills', '<skill>', 'SKILL.md');

  function readSkill(): string {
    return readFileSync(skillPath, 'utf-8');
  }
  ```
- Run a single plugin test file with:
  `npm test --workspace @rundown-org/claude-code-plugin -- <test-file-basename>`
  (e.g. `-- rundown.test.ts`). If that invocation form fails in the environment, fall back to the package's configured jest runner shown in `packages/claude-code-plugin/package.json` `scripts.test`.

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `packages/claude-code-plugin/skills/rundown/SKILL.md` | Generic cold-start launcher: resolve a runbook by name, `rd run`, hand off to protocol | Create |
| `packages/claude-code-plugin/__tests__/skills/rundown.test.ts` | Pin launcher frontmatter + body conventions | Create |
| `packages/claude-code-plugin/skills/running-runbooks/SKILL.md` | Execution protocol; broaden description to catch cold-start | Modify (frontmatter `description` only) |
| `packages/claude-code-plugin/__tests__/skills/running-runbooks.test.ts` | Pin the broadened trigger | Create |
| `packages/claude-code-plugin/skills/writing-runbooks/SKILL.md` | Add "Companion bootstrap skill" authoring section + heuristics | Modify (append section) |
| `packages/claude-code-plugin/__tests__/skills/writing-runbooks-bootstrap.test.ts` | Pin the new authoring section + heuristics | Create |
| `packages/claude-code-plugin/skills/planning/SKILL.md` | Migrate to `runbook:` frontmatter; drop manual block | Modify |
| `packages/claude-code-plugin/__tests__/skills/planning.test.ts` | Update assertions for the migration | Modify |

---

## Task 1: Generic `rundown` launcher skill

**Files:**
- Create: `packages/claude-code-plugin/skills/rundown/SKILL.md`
- Test: `packages/claude-code-plugin/__tests__/skills/rundown.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/claude-code-plugin/__tests__/skills/rundown.test.ts`:

```typescript
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.join(__dirname, '..', '..', 'skills', 'rundown', 'SKILL.md');

function readSkill(): string {
  return readFileSync(skillPath, 'utf-8');
}

describe('rundown launcher skill', () => {
  it('declares kebab-case name matching its directory', () => {
    expect(readSkill()).toMatch(/^name:\s*rundown\s*$/m);
  });

  it('has a description that triggers on a cold-start request to run a runbook', () => {
    const skill = readSkill();
    const descMatch = /^description:\s*(.+)$/m.exec(skill);
    expect(descMatch).not.toBeNull();
    const description = descMatch![1].toLowerCase();
    expect(description).toMatch(/run|start/);
    expect(description).toContain('runbook');
  });

  it('is a generic launcher, not a per-runbook bootstrap (no fixed runbook: frontmatter)', () => {
    const skill = readSkill();
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? '';
    expect(frontmatter).not.toMatch(/^runbook:/m);
  });

  it('resolves the runbook by name and starts it via the CLI', () => {
    const skill = readSkill();
    expect(skill).toMatch(/rd ls --all/);
    expect(skill).toMatch(/rd run /);
  });

  it('hands off to the running-runbooks protocol', () => {
    expect(readSkill()).toMatch(/running-runbooks/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @rundown-org/claude-code-plugin -- rundown.test.ts`
Expected: FAIL — `ENOENT` reading `skills/rundown/SKILL.md` (file does not exist yet).

- [ ] **Step 3: Create the launcher skill**

Create `packages/claude-code-plugin/skills/rundown/SKILL.md`:

````markdown
---
name: rundown
description: Use when asked to run or start a Rundown runbook by name (e.g. "run the planning runbook", "start the deploy runbook") and no runbook is active yet. The launcher that resolves a runbook and begins execution. Invocable as /rundown <runbook>.
---

# Rundown Launcher

The entrypoint for starting a runbook from a cold start. This skill resolves a
runbook by name, starts it, and hands off to the execution protocol. It does not
contain the protocol itself.

## When to Use

- A user asks to "run"/"start the X runbook" and no runbook is active yet.
- Invoked directly as `/rundown <runbook>` with a runbook name.

## When NOT to Use

- A runbook is already active or CLI output asks for pass/fail — use
  [running-runbooks](../running-runbooks/SKILL.md).
- Authoring or editing a runbook file — use
  [writing-runbooks](../writing-runbooks/SKILL.md).
- A runbook has its own bootstrap skill (e.g. `planning`) — invoke that skill;
  it starts itself.

## Steps

1. **Resolve the runbook.** If the name is ambiguous or you are unsure it
   exists, list discoverable runbooks:

   ```bash
   rd ls --all
   ```

   Names support `namespace:name` (e.g. `rundown:planning` for the plugin
   source). A bare name resolves via the priority chain (project → plugin →
   bundled).

2. **Start it.**

   ```bash
   rd run <name>
   ```

   Pass inputs if the runbook requires them:

   ```bash
   rd run <name> --input key=value
   ```

   If `rd run` reports missing required inputs, supply them and re-run.

3. **Hand off.** Once the runbook is active, follow the
   [running-runbooks](../running-runbooks/SKILL.md) protocol: respond to each
   step with `rd pass` / `rd fail` and trust Rundown for transitions.

## Reference

- [running-runbooks](../running-runbooks/SKILL.md) — the execution protocol
- [writing-runbooks](../writing-runbooks/SKILL.md) — authoring runbooks
````

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @rundown-org/claude-code-plugin -- rundown.test.ts`
Expected: PASS (5 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/skills/rundown/SKILL.md \
        packages/claude-code-plugin/__tests__/skills/rundown.test.ts
git commit -m "feat(plugin): add generic rundown launcher skill"
```

---

## Task 2: Broaden `running-runbooks` to catch cold-start

**Files:**
- Modify: `packages/claude-code-plugin/skills/running-runbooks/SKILL.md` (frontmatter `description` line only)
- Test: `packages/claude-code-plugin/__tests__/skills/running-runbooks.test.ts`

Current description (line 3):
`description: Use when a Rundown runbook is active, when receiving delegation instructions with a claim token, or when rd/rundown CLI commands appear in step output`

- [ ] **Step 1: Write the failing test**

Create `packages/claude-code-plugin/__tests__/skills/running-runbooks.test.ts`:

```typescript
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.join(__dirname, '..', '..', 'skills', 'running-runbooks', 'SKILL.md');

function readDescription(): string {
  const skill = readFileSync(skillPath, 'utf-8');
  const match = /^description:\s*(.+)$/m.exec(skill);
  expect(match).not.toBeNull();
  return match![1];
}

describe('running-runbooks skill description', () => {
  it('still triggers on an active runbook', () => {
    expect(readDescription()).toMatch(/active/i);
  });

  it('also triggers on a cold-start request to run or start a runbook', () => {
    const description = readDescription().toLowerCase();
    expect(description).toMatch(/run|start/);
  });

  it('still covers delegation claim tokens', () => {
    expect(readDescription()).toMatch(/claim token/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @rundown-org/claude-code-plugin -- running-runbooks.test.ts`
Expected: FAIL on the cold-start assertion — the current description has no "run"/"start" verb (it says "active", "receiving", "appear").

- [ ] **Step 3: Broaden the description**

In `packages/claude-code-plugin/skills/running-runbooks/SKILL.md`, replace line 3:

```
description: Use when a Rundown runbook is active, when receiving delegation instructions with a claim token, or when rd/rundown CLI commands appear in step output
```

with:

```
description: Use when running or stepping through a Rundown runbook — when one is active or has just been started, when asked to run/start a runbook with no active launcher, when receiving delegation instructions with a claim token, or when rd/rundown CLI commands appear in step output
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @rundown-org/claude-code-plugin -- running-runbooks.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/skills/running-runbooks/SKILL.md \
        packages/claude-code-plugin/__tests__/skills/running-runbooks.test.ts
git commit -m "feat(plugin): broaden running-runbooks trigger to cold-start"
```

---

## Task 3: Document the companion bootstrap skill in `writing-runbooks`

**Files:**
- Modify: `packages/claude-code-plugin/skills/writing-runbooks/SKILL.md` (append a section before `## Reference`)
- Test: `packages/claude-code-plugin/__tests__/skills/writing-runbooks-bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/claude-code-plugin/__tests__/skills/writing-runbooks-bootstrap.test.ts`:

```typescript
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.join(__dirname, '..', '..', 'skills', 'writing-runbooks', 'SKILL.md');

function readSkill(): string {
  return readFileSync(skillPath, 'utf-8');
}

describe('writing-runbooks companion bootstrap skill guidance', () => {
  it('documents how to create a companion bootstrap skill', () => {
    expect(readSkill()).toMatch(/## Companion Bootstrap Skill/);
  });

  it('shows the runbook: frontmatter that fires the SkillStart gate', () => {
    expect(readSkill()).toMatch(/runbook:\s*<runbook-name>/);
  });

  it('explains the gate auto-runs the runbook and invokes running-runbooks', () => {
    const skill = readSkill();
    expect(skill).toMatch(/SkillStart/);
    expect(skill).toMatch(/running-runbooks/);
  });

  it('lists the sibling-skill heuristics including delegation', () => {
    const skill = readSkill();
    expect(skill).toMatch(/DELEGATE.*delegating-runbooks/s);
    expect(skill).toMatch(/writing-plans/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @rundown-org/claude-code-plugin -- writing-runbooks-bootstrap.test.ts`
Expected: FAIL — the `## Companion Bootstrap Skill` heading does not exist yet.

- [ ] **Step 3: Append the authoring section**

In `packages/claude-code-plugin/skills/writing-runbooks/SKILL.md`, insert the
following section immediately **before** the final `## Reference` section:

````markdown
## Companion Bootstrap Skill

A runbook becomes runnable from natural language by giving it a **companion
bootstrap skill** — a small `SKILL.md` whose `runbook:` frontmatter field is
read by the plugin's `SkillStart` gate. When the skill is invoked, the gate
auto-runs the runbook and injects the `running-runbooks` invocation. You write
no glue code.

Create one for common, named runbooks (e.g. `planning`). One-off project
runbooks don't need their own skill — the generic `rundown` launcher starts any
runbook by name.

### Template

Place at `skills/<skill-name>/SKILL.md` (directory name must equal `name:`):

```markdown
---
name: <skill-name>
description: Use when <the user need this runbook serves, in trigger terms>.
runbook: <runbook-name>
---

# <Skill Title>

<One or two sentences: what this runbook does and when to reach for it.>

## When to Use
- <intent that should start this runbook>

## When NOT to Use
- <neighbouring intent that belongs to a sibling skill>

## Reference
- [running-runbooks](../running-runbooks/SKILL.md) — the execution protocol
<plus sibling skills per the heuristics below>
```

The `runbook:` value is passed verbatim to `rd run`. Use the `namespace:name`
form (e.g. `rundown:planning`) when the runbook ships with the plugin. Do **not**
restate the runbook's steps in the skill — the runbook owns the sequence; the
skill names the intent and points at the craft skills.

### Sibling-skill heuristics

Decide which skills the bootstrap skill references by what the runbook contains:

| If the runbook… | Reference |
|-----------------|-----------|
| (always) | [running-runbooks](../running-runbooks/SKILL.md) — the gate injects this automatically |
| contains a `- DELEGATE` directive | [delegating-runbooks](../delegating-runbooks/SKILL.md) |
| writes, reviews, or executes a plan (plan pipeline) | [writing-plans](../writing-plans/SKILL.md) / [executing-plans](../executing-plans/SKILL.md) |

Extend this table as new craft skills are added. The rule: reference the skill
that owns the *craft* for each thing the runbook does; never duplicate it.
````

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @rundown-org/claude-code-plugin -- writing-runbooks-bootstrap.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/skills/writing-runbooks/SKILL.md \
        packages/claude-code-plugin/__tests__/skills/writing-runbooks-bootstrap.test.ts
git commit -m "docs(plugin): document companion bootstrap skill in writing-runbooks"
```

---

## Task 4: Migrate `planning` skill onto the `runbook:` frontmatter (real-world test)

**Files:**
- Modify: `packages/claude-code-plugin/skills/planning/SKILL.md`
- Modify: `packages/claude-code-plugin/__tests__/skills/planning.test.ts`

Current `planning/SKILL.md` frontmatter + manual block (lines 1–14):

```markdown
---
name: planning
description: Use when running the full plan → review → execute pipeline — write the plan, review it, then implement it behind review and verify gates. The top-level entrypoint that orchestrates writing-plans, plan review, and executing-plans end to end.
use_when: Driving a body of work from a spec through to merged implementation.
---

# Planning

<important>
## Runbook-Orchestrated Skill
Start the runbook: `rd run rundown:planning`
Then invoke the running-runbooks skill: `Skill(skill: "rundown:running-runbooks")`
</important>
```

- [ ] **Step 1: Update the test to expect the migrated shape**

In `packages/claude-code-plugin/__tests__/skills/planning.test.ts`, replace the
second `it(...)` block (the one titled *"declares the runbook entrypoint and
running-runbooks invocation"*, currently asserting the manual block strings)
with:

```typescript
  it('declares the runbook via frontmatter so the SkillStart gate starts it', () => {
    const skill = readSkill();
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? '';
    expect(frontmatter).toMatch(/^runbook:\s*rundown:planning\s*$/m);
  });

  it('does not hand-roll the runbook start (gate owns it now)', () => {
    const skill = readSkill();
    expect(skill).not.toMatch(/Start the runbook:\s*`rd run/);
    expect(skill).not.toContain('<important>');
  });
```

Leave the first test (`declares kebab-case name and a description`) and the
third (`cross-links the stage skills`) unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @rundown-org/claude-code-plugin -- planning.test.ts`
Expected: FAIL — the skill still has the manual `<important>` block and no
`runbook:` frontmatter.

- [ ] **Step 3: Migrate the skill**

In `packages/claude-code-plugin/skills/planning/SKILL.md`:

a. Add the `runbook:` field to the frontmatter (after `use_when:`):

```markdown
---
name: planning
description: Use when running the full plan → review → execute pipeline — write the plan, review it, then implement it behind review and verify gates. The top-level entrypoint that orchestrates writing-plans, plan review, and executing-plans end to end.
use_when: Driving a body of work from a spec through to merged implementation.
runbook: rundown:planning
---
```

b. Remove the entire manual block so the heading is followed directly by the
`## Overview` section:

```markdown
# Planning

## Overview
```

(Delete the `<important> … </important>` block, lines 9–14 of the original.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @rundown-org/claude-code-plugin -- planning.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Verify no other references to the removed block**

Run:
```bash
grep -rn "rd run rundown:planning" packages/claude-code-plugin --include=*.md --include=*.ts \
  | grep -v node_modules | grep -v dist
```
Expected: no matches in `skills/planning/SKILL.md` and no test still asserting
it. If any other doc references the manual start, update it to note the skill
self-starts via the gate. (The `rundown` launcher and `running-runbooks` skills
legitimately mention `rd run` generically — that is fine.)

- [ ] **Step 6: Run the gate tests to confirm the mechanism resolves planning**

Run: `npm test --workspace @rundown-org/claude-code-plugin -- on-skill-start.test.ts`
Expected: PASS — the existing gate tests still cover the `runbook:` path
(`parseRunbookFromFrontmatter` extracting the field, `execute` running it and
injecting `RUNBOOK ACTIVE` + the `running-runbooks` invocation). The migrated
`planning` skill now exercises that same path in production.

- [ ] **Step 7: Commit**

```bash
git add packages/claude-code-plugin/skills/planning/SKILL.md \
        packages/claude-code-plugin/__tests__/skills/planning.test.ts
git commit -m "refactor(plugin): start planning via SkillStart gate frontmatter"
```

---

## Task 5: Acceptance — planning resolves through the gate, full verify

**Files:**
- Create: `packages/claude-code-plugin/__tests__/skills/planning-bootstrap.integration.test.ts`

This task pins the real-world test the design calls out: the `planning` skill,
through its `runbook:` frontmatter, resolves to `rundown:planning` exactly as the
gate would feed it to `rd run`.

- [ ] **Step 1: Write the acceptance test**

Create `packages/claude-code-plugin/__tests__/skills/planning-bootstrap.integration.test.ts`:

```typescript
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunbookFromFrontmatter } from '../../src/shared/frontmatter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const planningSkill = path.join(__dirname, '..', '..', 'skills', 'planning', 'SKILL.md');

describe('planning bootstrap resolves through the SkillStart gate', () => {
  it('frontmatter runbook resolves to the planning runbook the gate will run', () => {
    const content = readFileSync(planningSkill, 'utf-8');
    const runbook = parseRunbookFromFrontmatter(content);
    // This is the verbatim value the gate passes to `rd run <value>`.
    expect(runbook).toBe('rundown:planning');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test --workspace @rundown-org/claude-code-plugin -- planning-bootstrap.integration.test.ts`
Expected: PASS (1 passing). (This is verify-first: the field was added in Task 4,
so this asserts the contract holds end-to-end through the real parser.)

- [ ] **Step 3: Run the full plugin test suite**

Run: `npm test --workspace @rundown-org/claude-code-plugin`
Expected: PASS — all skill, gate, and runbook tests green.

- [ ] **Step 4: Run the pre-PR verification gate**

Run: `npm run verify`
Expected: format, spell, lint, and tests all pass. Fix any spell-check failures
by adding new terms to the project dictionary if they are legitimate (follow the
existing dictionary convention surfaced by the failure).

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/__tests__/skills/planning-bootstrap.integration.test.ts
git commit -m "test(plugin): pin planning bootstrap resolution through the gate"
```

---

## Self-Review

**Spec coverage:**
- Part 1a (new `rundown` launcher) → Task 1. ✓
- Part 1b (broaden `running-runbooks`) → Task 2. ✓
- Part 2a (companion bootstrap section + heuristics in `writing-runbooks`) → Task 3. ✓
- Part 2b (migrate `planning` to `runbook:` frontmatter, drop manual block) → Task 4. ✓
- Acceptance (`planning` as real-world test through the gate) → Tasks 4 (Step 6) + 5. ✓
- Part 3 (direct-CLI injection) → deferred per spec; no task. ✓
- "No machinery changes / gate reused as-is" → no task touches `on-skill-start.ts` or the dispatcher. ✓

**Placeholder scan:** No TBD/TODO; every skill body and test is shown in full;
`<runbook-name>`/`<skill-name>` inside the Task 3 template are intentional
template literals that the test asserts verbatim, not plan placeholders.

**Type/string consistency:** The verbatim value `rundown:planning` is identical
across Task 4 (frontmatter, test assertion `^runbook:\s*rundown:planning`) and
Task 5 (`expect(runbook).toBe('rundown:planning')`). `parseRunbookFromFrontmatter`
is the real exported symbol from `src/shared/frontmatter.ts` (verified). The
injected strings `RUNBOOK ACTIVE` and `Skill(skill: "rundown:running-runbooks")`
match the gate's `formatRunbookOutput` exactly. Test file invocation form is
consistent across all tasks.

## Out of scope / future work
- `rd bootstrap <runbook>` generator (rejected — guidance covers it).
- Direct-CLI `rd run` context injection (Part 3, deferred).
- Bespoke per-runbook skills beyond `planning` (created on demand via Task 3's pattern).
