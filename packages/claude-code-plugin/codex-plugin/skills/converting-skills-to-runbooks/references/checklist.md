# Conversion Verification Checklist

Run this checklist on every converted runbook before considering it done. It
adapts the superpowers writing-plans self-review to the skill-to-runbook
transform: the "no placeholders" scan becomes a "no duplication" scan.

## 1. Backbone coverage

- [ ] Every load-bearing phase in the source skill maps to a step — or is
      deliberately dropped because it is pure context (note which).
- [ ] Steps are in the skill's intended order.

## 2. No-duplication scan (primary gate)

- [ ] Step 1 invokes and reads the source skill; the `skill:` frontmatter field
      is set.
- [ ] No step body restates the skill's rules, syntax, rationale, or examples.
- [ ] Bodies are pointers or checklists, not explanations. If a body teaches,
      move it back to the skill and leave a pointer.

## 3. Contract consistency

- [ ] Frontmatter `INPUTS` / `REQUIRED` / `OUTPUTS` match what the steps
      actually consume and produce.
- [ ] `REQUIRED` is a subset of `INPUTS`.
- [ ] `ARTIFACTS` aliases are consistent across steps (same PascalCase name for
      the same artifact).
- [ ] Every artifact reference uses `{{ path Alias }}` — no hardcoded paths.

## 4. House-style shape

- [ ] Produce → validate → retry loop present (validate step `FAIL GOTO` the
      write step).
- [ ] Fan-out, if any, uses `- DELEGATE` + delegate-then-collate (never collate
      from the parent).
- [ ] Review-type steps use `FAIL CONTINUE` (record-don't-gate).
- [ ] One runbook, one artifact (or a parent composing leaves).

## 5. Machine validation

- [ ] `rundown check <file>` passes.
- [ ] `rundown resolve <file> --input <REQUIRED>=…` passes once required inputs
      are supplied (skip if the runbook has no required inputs).
