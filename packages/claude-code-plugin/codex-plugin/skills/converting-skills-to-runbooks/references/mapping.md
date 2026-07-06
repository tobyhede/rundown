# Mapping: Skill Elements → Runbook Constructs

How each part of a `SKILL.md` maps into a house-style runbook. Read alongside
[../../writing-runbooks/house-style.md](../../writing-runbooks/house-style.md).

## Element mapping

| Skill element                          | Runbook construct                                                     |
| -------------------------------------- | --------------------------------------------------------------------- |
| The skill itself (its guidance)        | Step 1: "Invoke and read the `<skill>` skill" + `skill:` frontmatter  |
| An ordered phase / numbered section    | One H2 step with `PASS`/`FAIL` transitions                            |
| A gate ("only proceed if…")            | A step whose `FAIL` is `STOP` (or `GOTO` a fix step)                  |
| "Repeat for each item"                 | `FOR var IN {{ source }}` on an H2 step with H3 substeps              |
| "Dispatch a subagent per item"         | `- DELEGATE` step + a separate collation runbook                      |
| A produced file (plan, review, report) | `ARTIFACTS Alias "file.json"` + write to `{{ path Alias }}`           |
| A consumed/inherited file              | Naked `ARTIFACTS Alias` rehydration + frontmatter `INPUTS`/`REQUIRED` |
| A structured-output schema             | Read-only `ARTIFACTS SchemaPath "schemas/x.schema.json"` bound early  |
| A "self-review" / "verify" section     | A final step: validate + `PASS COMPLETE` / `FAIL GOTO <write-step>`   |
| Rules, rationale, syntax, examples     | **Nothing** — stays in the skill; reference it, do not copy it        |

## Mapping rules

1. **Skill-invocation step first.** Step 1 invokes and reads the source skill
   and sets the `skill:` frontmatter field. Every later body can then assume the
   skill is in context and stay terse.
2. **Bind schema/contract early.** If the skill produces a structured artifact,
   bind its schema (read-only) before the write step.
3. **One backbone phase → one H2 step.** Body is a terse pointer or checklist,
   never the explanation.
4. **Artifacts via `ARTIFACTS` + `{{ path Alias }}`.** PascalCase `*Path` /
   `*Paths`; never hardcode a path.
5. **Produce → validate → retry.** Final steps validate (`rundown check`, or
   `rdx --validate --schema` / `{{ validateSchema Alias }}` for JSON artifacts)
   with `PASS COMPLETE` / `FAIL GOTO <write-step>`.
6. **Fan-out → delegate-then-collate.** Model parallel sub-work as `- DELEGATE`
   steps with a separate collation runbook; never collate from the parent.
7. **One runbook, one artifact.** If the skill produces several artifacts or has
   independent sub-workflows, split into a parent + leaf runbooks composed from
   the parent.
8. **Record-don't-gate.** Review-type steps use `FAIL CONTINUE` so findings are
   recorded without halting the run.

## Decision: split or single?

- Single runbook if the skill produces one artifact through one linear backbone.
- Parent + leaves if the skill has independent sub-workflows, fans out, or emits
  multiple artifacts. The parent composes leaves by listing their paths in a
  step body; it does not re-derive their artifact paths — it consumes each
  leaf's frontmatter `OUTPUTS`.
