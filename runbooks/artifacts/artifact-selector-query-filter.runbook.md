---
name: artifact-selector-query-filter
description: Fixture demonstrating rd:// selector query filters end-to-end through the CLI.
tags: [test, artifacts]
scenarios:
  query-filters-gate-current-context-artifacts:
    description: >-
      A produced project artifact is returned by matching source/runbook/created
      filters and excluded by non-matching ones, proving each filter runs.
    commands:
      - rd run artifact-selector-query-filter.runbook.md --allow-all
    expect:
      result: COMPLETE
      artifacts:
        # Matching filters resolve the produced record (single match → 1).
        - at: "2"
          alias: MatchedSource
          key: plan-a.json
          count: 1
          exists: true
        - at: "2"
          alias: MatchedCreated
          key: plan-a.json
          count: 1
          exists: true
        # Excluding filters resolve the trusted empty set — proving the filter
        # actually ran rather than being ignored (which would return the record).
        - at: "2"
          alias: ExcludedSource
          count: 0
        - at: "2"
          alias: ExcludedCreated
          count: 0
---
# Artifact Selector Query Filter

Selectors only address the current run's context, so this fixture produces an
artifact in step 1 and then filters it in step 2 through the run's own
`{{ ContextId }}`. A single run-wildcard `*` with an exact key keeps each literal
URI free of a markdown-emphasis `*...*` pair.

## 1. Produce plan

- ARTIFACTS
  - PlanA "plan-a.json"
- PASS CONTINUE
- FAIL STOP

```bash
printf '{}' > "{{ path PlanA }}"
```

## 2. Filter the produced artifact

- ARTIFACTS
  - MatchedSource "rd://artifacts/{{ ContextId }}/*/plan-a.json?source=project"
  - ExcludedSource "rd://artifacts/{{ ContextId }}/*/plan-a.json?source=plugin"
  - MatchedCreated "rd://artifacts/{{ ContextId }}/*/plan-a.json?createdAfter=2020-01-01T00:00:00.000Z"
  - ExcludedCreated "rd://artifacts/{{ ContextId }}/*/plan-a.json?createdBefore=2020-01-01T00:00:00.000Z"
- PASS COMPLETE

```bash
rd echo --result pass
```
