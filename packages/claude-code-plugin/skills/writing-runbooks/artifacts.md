# ARTIFACTS Reference

Deep reference for the step/substep `ARTIFACTS` directive — token forms, rendering helpers, and producer/consumer patterns. The [SKILL.md](SKILL.md#stepsubstep-artifacts) carries the summary; this file is the lookup material.

## The `ARTIFACTS` directive

`ARTIFACTS` declares structured artifact aliases for the step or substep being entered. It is valid only on H2 steps and H3 substeps, never in frontmatter, and must be the first directive after the heading.

````markdown
## 2. Write plan
- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE
- FAIL STOP

```bash
printf '{"ok":true}\n' > "{{ path PlanPath }}"
```
````

`ARTIFACTS` resolves at step/substep entry, writes structured artifact variables and manifest rows, and emits the resolved records on `STEP_ENTERED.artifacts`. It does not write artifact file contents. Producers write managed artifact content to the local path rendered by `{{ path Alias }}`.

## Token forms

- `Name` — naked assertion/rehydration for an already-bound artifact reference; not shorthand creation.
- `Name "plan.json"` — managed artifact key for the current context/run.
- `Name "review-*.json"` — wildcard selector; read-only, does not create records. May resolve to `[]`, one record, or many records.
- `Name "schemas/file.json"` — existing file reference.
- `Name "/abs/path/file.json"` — absolute file reference.
- `Name "rd://artifacts/<ctx>/<run>/<key>"` — exact artifact URI or selector URI.

Tokens are double-quoted only. Missing, denied, or out-of-root path-like references fail visibly at resolution. Same-name `ARTIFACTS` and `OUTPUTS` are allowed, but `OUTPUTS` overwrites the structured artifact value after command completion, so avoid that as a default pattern.

## Rendering helpers

| Template | Renders |
|----------|---------|
| `{{ Alias }}` | Local filesystem path value(s) (direct alias) |
| `{{ path Alias }}` | Local filesystem path value(s) |
| `{{ artifact Alias }}` | Artifact URI value(s) |
| `{{ path "file.json" }}` | Local path only; does not create a manifest row |

For wildcard aliases that resolve to arrays, `{{ path Reviews }}` renders a JSON array of paths. Arrays can be used as `FOR` data sources when that matches the workflow.

## Producer example

````markdown
## 1. Produce plan
- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE
- FAIL STOP

```bash
printf '{"ok":true}\n' > "{{ path PlanPath }}"
```
````

## Consumer / rehydration example

````markdown
## 1. Review plan
- ARTIFACTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP

Read the inherited plan from `{{ path PlanPath }}`.
````
