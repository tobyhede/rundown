# Runbook House Style

Idiomatic conventions distilled from the canonical plugin runbooks — `packages/claude-code-plugin/runbooks/end-to-end-test/*` and `packages/claude-code-plugin/runbooks/planning/*`. These runbooks are the reference style; mirror them.

`SKILL.md` documents the *syntax* of each directive. This guide documents how the pieces *combine* — the patterns to reach for first when authoring a new runbook. When in doubt, open a sibling runbook in those directories and match it. For *inter*-runbook composition (pipelines, gate loops, the leaf-delegate / orchestrator-compose discipline) see [docs/guides/composing-runbooks.md](../../../../docs/guides/composing-runbooks.md).

## The core idiom: schema-first artifact pipeline

Almost every artifact-producing ("leaf") runbook follows the same four-phase shape:

1. **Bind the schema** — first step is read-only, binds a `*SchemaPath` artifact (or shows the schema in a `prompt` block). Body: "The schema defines the expected output structure."
2. **Rehydrate inputs** — naked `ARTIFACTS` aliases pull inherited input artifacts in for reading.
3. **Write the output** — bind the managed output artifact (`Alias "file.json"`) and write to `{{ path Alias }}` against the schema.
4. **Validate and loop back** — final step runs the validator with `PASS COMPLETE` / `FAIL GOTO <write-step>`, forming a self-correcting produce → validate → retry loop.

Worked example — a complete leaf runbook in house style:

````markdown
---
name: review-file
description: Read the plan artifact and write one nested review artifact.
tags:
  - meta
  - e2e
INPUTS:
  - PlanPath
REQUIRED:
  - PlanPath
OUTPUTS:
  - ReviewPath
---

# End-to-End Test Review

Review the plan and provide structured feedback.

## 1. Read the output schema
- ARTIFACTS
  - ReviewSchemaPath "schemas/review.schema.json"
- PASS CONTINUE
- FAIL STOP

The schema defines the expected feedback output structure.

## 2. Read and review the plan
- ARTIFACTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP

Review the plan at `{{ path PlanPath }}` against the criteria.

## 3. Write review
- ARTIFACTS
  - PlanPath
  - ReviewSchemaPath
  - ReviewPath "end-to-end-test-review.json"
- PASS CONTINUE
- FAIL STOP

Write a JSON review to `{{ path ReviewPath }}`.
Follow the output schema from `{{ path ReviewSchemaPath }}`.

## 4. Check Schema
- PASS COMPLETE
- FAIL GOTO 3

```bash
rdx {{ path ReviewPath }} --validate --schema review
```
````

The validate step is also written `{{ validateSchema ReviewPath }}` — a built-in helper that renders the complete `rdx --validate <path>` command. Use the helper when the schema is embedded in the artifact (`"$schema"` field); use the explicit `rdx ... --schema <name>` form when naming the schema directly.

## Conventions

### One runbook, one artifact

Keep runbooks small and single-purpose. Each produces one artifact and declares the full contract in frontmatter: `INPUTS` / `REQUIRED` for what it consumes, `OUTPUTS` for what it publishes. A parent composes these leaves; it does not re-derive their paths.

| Runbook | Consumes | Produces |
|---------|----------|----------|
| `write-file` | — | `PlanPath` |
| `review-file` | `PlanPath` | `ReviewPath` |
| `collate-files` | `PlanPath`, `ReviewPaths` (wildcard) | `CollatedReviewPath` |
| parent | `CollatedReviewPath` | `FeedbackPath` |

### Artifacts

| Role | Form | Use |
|------|------|-----|
| Producer | `Alias "file.json"` | Create/bind the managed artifact, then write to `{{ path Alias }}` |
| Consumer | `Alias` (naked) | Rehydrate an inherited artifact for reading |
| Schema | `Alias "schemas/x.schema.json"` | Read-only file reference, bound in step 1 |
| Collection | `Alias "*/file.json"` | Wildcard selector; gathers many → `{{ path Alias }}` renders a JSON array |

- Always reference `{{ path Alias }}` in bodies and commands — never hardcode a path.
- Alias names are PascalCase ending in `Path` / `Paths` (`PlanPath`, `ReviewSchemaPath`, `ReviewPaths`, `CollatedReviewPath`, `FeedbackPath`).
- Schema files are named `<thing>.schema.json` and validated with `--schema <thing>`.
- A dedicated `## N. Output Path` step that binds the managed artifact (`- ARTIFACTS` / `Alias "file.json"`) with a body of just `{{ Alias }}` is idiomatic when you want the path surfaced before a separate write step.

### Steps & layout

- Step 1 binds the schema; the last step validates. Everything else sits between.
- Blank line after the heading, the directive block, a blank line, then the prose body. Two blank lines between steps.
- State aggregation explicitly on composition/delegation steps even when it is the default: `- PASS ALL CONTINUE` / `- FAIL ANY STOP`.
- Bodies are short and imperative. Verification/review criteria are `-` bullet lists or `- [ ]` checklists.

### Transitions

- **Produce → validate → retry:** the validate step uses `PASS COMPLETE` (or `CONTINUE`) and `FAIL GOTO <write-step>` so a malformed artifact loops back to be rewritten.
- **Review/record steps use `FAIL CONTINUE`:** a step that records findings (rather than gating) proceeds whether the assessment passed or failed — `- PASS CONTINUE` / `- FAIL CONTINUE`. The finding is captured in the output artifact, not enforced by stopping.
- **Terminal messages:** include a human-readable reason on `STOP` / `COMPLETE` in human-facing runbooks (`FAIL STOP "CI builds must pass before review."`). Artifact-pipeline steps that are not human-driven use bare `STOP` / `COMPLETE`.

### Composition & delegation

Run child runbooks by listing their paths in an H2 step body:

```markdown
## 2. Write
- PASS ALL CONTINUE
- FAIL ANY STOP

- end-to-end-test/write-file.runbook.md
```

Add bare `- DELEGATE` to push the children to subagents instead of running inline. The idiomatic shape is a wrapper that **delegates the fan-out review, then delegates collation** as a second step — never collate from the parent:

```markdown
## 1. Delegate subagents to review
- ARTIFACTS
  - PlanPath
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- review-plan-technical-accuracy.runbook.md
- review-plan-structural-integrity.runbook.md
- review-plan-build-runtime.runbook.md
- review-plan-risk-safety.runbook.md

## 2. Collate review findings
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

- review-plan-collate.runbook.md
```

The collation runbook gathers siblings with a **cross-run wildcard artifact selector** (`Reviews "*/review-plan-*.json"`), merges, deduplicates equivalent findings, and validates against the shared schema. The selector desugars to `rd://artifacts/{{ContextId}}/*/review-plan-*.json` and resolves the sibling runs' *produced* artifact rows read-only from the shared-context manifest — no filesystem globbing. ARTIFACTS is the canonical discovery mechanism; do **not** reach for `rdpath find` to discover sibling artifacts.

### Validation & discovery helpers

| Helper | Renders / does |
|--------|----------------|
| `{{ validateSchema Alias }}` | Complete `rdx --validate <path>` command (schema from the artifact's `"$schema"`) |
| `rdx {{ path Alias }} --validate --schema <name>` | Explicit-schema validation |
| `Alias "*/<glob>"` (cross-run ARTIFACTS selector) | Resolves matching sibling-run artifacts from the shared-context manifest read-only — the canonical discovery mechanism. An empty set means "nothing to collate"; no filesystem globbing or `rdpath` |

### Skills as steps

A runbook can require a skill: declare `skill: <name>` in frontmatter and make step 1 invoke it (`Skill: rundown:writing-plans`) so the agent internalizes the guidance before producing the artifact.

## Common house-style mistakes

| Mistake | House style |
|---------|-------------|
| Hardcoding an output path in a command | Bind the artifact, write to `{{ path Alias }}` |
| Multi-purpose runbook producing several artifacts | One runbook, one artifact; compose leaves from a parent |
| Write step with no validation | Always end with a `Check Schema` step that `GOTO`s back to the write step on failure |
| `FAIL STOP` on a review/record step | Use `FAIL CONTINUE` — record the finding, don't gate |
| Collating from the parent runbook | Delegate review, then delegate a dedicated collation runbook |
| Re-deriving child artifact paths in the parent | Consume the child's declared `OUTPUTS`; do not add artifact-only steps |
| Omitting the frontmatter contract | Declare `INPUTS` / `REQUIRED` / `OUTPUTS` on every composed/delegated runbook |
