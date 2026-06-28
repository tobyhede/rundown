# Rundown Patterns

Canonical patterns demonstrating Rundown runbook features. Browse the
subdirectories to discover patterns by category.

## Scenario Naming Taxonomy

To ensure clarity and consistency across all pattern examples, we follow a
holistic naming strategy where the **filename** and **scenario name** work
together to describe the intent.

### Holistic Strategy

1.  **The "Default" Rule**: If a runbook demonstrates a single primary path, use
    `completed`. This is concise and avoids repeating words from the filename.
2.  **The "Variation" Rule**: When a runbook has multiple paths to the same
    result, the scenario name describes the **differentiating branch or
    condition** (e.g., `via-named` vs `via-static`).
3.  **The "Choice" Rule**: If the runbook centers on a specific decision point
    (like a failure transition), use the **action taken** as the scenario name
    (e.g., `continue` vs `stop`).
4.  **Remove Redundancy**: Do not include "success", "failure", or the core
    topic of the filename in the scenario name. The `result` field already
    indicates the outcome.

### Coherent Taxonomy

| Category        | Scenario Name                             | Focus                                   |
| :-------------- | :---------------------------------------- | :-------------------------------------- |
| **Simple**      | `completed`, `stopped`                    | Standard primary outcomes.              |
| **Branching**   | `via-[name]`, `skipped-[name]`            | Destination or path taken.              |
| **Retries**     | `immediate`, `after-retry`                | Timing of success.                      |
| **Exhaustion**  | `continue`, `stop`, `goto-[name]`         | Action taken after retry limit reached. |
| **Dynamic**     | `single`, `multiple`, `batch`             | Volume of iterations.                   |
| **Composition** | `completed`, `agent-fails`, `child-fails` | Failure mode in delegation.             |

## Pattern Categories

| Directory      | Description                                            |
| -------------- | ------------------------------------------------------ |
| `transitions/` | PASS/FAIL logic, state transitions, and code execution |
| `retries/`     | Retry logic and exhaustion handling                    |
| `goto/`        | GOTO patterns for jumping between steps                |
| `examples/`    | Real-world use cases                                   |
| `for-loops/`   | FOR loop iteration patterns                            |
| `substeps/`    | Nested steps within parent steps                       |
| `named-steps/` | Steps identified by name instead of number             |
| `prompts/`     | User prompts and input handling                        |
| `composition/` | Parent runbooks, agents, and delegation                |
| `delegation/`  | Delegate/claim patterns for child runbooks             |
| `stash-pop/`   | Stash/pop enforcement control                          |
| `variables/`   | Template variables, built-ins, and context             |

## Creating New Patterns

1. Choose the appropriate category directory
2. Use descriptive filename: `feature-variant.runbook.md`
3. Add scenarios following the naming taxonomy above
4. Include `result: COMPLETE` or `result: STOP` in scenario metadata (or use
   `expect:` block for step-level assertions)
5. Rebuild the CLI (`npm run build -w packages/cli`) before running any
   cross-referenced runbook through `rd scenario run` — the scenario runner
   reads from `packages/cli/dist/runbooks/`, which is refreshed by the
   post-build `scripts/copy-runbooks.js` hook. Skipping this produces
   `RD-805 Child runbook not found` at delegation time.

Use `expect.entered` when the behavior under test is entry-only, especially
inline runbook-list composition. A non-DELEGATE runbook-list entry enters a
generated substep such as `Runbook: child.runbook.md` and may auto-launch the
child before the parent emits a transition.

## Path Assembly with `rdpath`

Runbooks must never hardcode artifact paths. Use the `rdpath` CLI tool to
assemble paths with consistent date-prefixed filenames and optional context
scoping.

### Artifact vs Work Product

| Category                     | Description                               | rdpath flags                            | Example output                                              |
| ---------------------------- | ----------------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| **Artifact** (durable)       | Final deliverables kept long-term         | `--dir <base> --file <name>`            | `.rundown/work/feature/2026-03-16-plan.md`                  |
| **Work product** (transient) | Intermediate files scoped to an execution | `--dir <base> --ctx <id> --file <name>` | `.rundown/work/feature/.rd-a3b8c1d2/2026-03-16-findings.md` |

### Runbook Patterns

**Write a durable artifact:**

```markdown
Resolve the output path with: `rdpath --dir {{ WorkPath }} --file plan.md`
```

**Write transient work product (scoped to execution context):**

```markdown
Ensure the output directory exists:

\`\`\`bash
mkdir -p "$(rdpath --dir {{ WorkPath }} --ctx {{ ContextId }})"
\`\`\`

Write findings to the path resolved by `rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file findings.md`.
```

**Read from context directory (glob):**

```markdown
\`\`\`bash
ls "$(rdpath --dir {{ WorkPath }} --ctx {{ ContextId }})"/*-pass*.md
\`\`\`
```

### How ContextId Flows

`ContextId` is a built-in variable generated once per execution. Children in a
delegation tree inherit the parent's `ContextId` automatically via `--input`, so
all runbooks in the same delegation tree share the same context directory. This
allows the synthesis step to find all review findings without knowing which
children produced them.

## Authoring DELEGATE Steps

Use the `- DELEGATE` annotation to mark a step's substeps for delegation — when
the step is entered, the engine auto-issues a token per substep and the
orchestrating agent dispatches a subagent for each. This is the recommended
pattern for any step that delegates more than one substep.

Three equivalent forms are available. Pick whichever reads best for the step:

```markdown
## 1. Step-level — propagates to every H3 substep
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP
### 1.1 First task
- child-a.runbook.md
```

```markdown
## 1. Per-substep — annotate only the delegated H3 substeps
### 1.1 First task
- DELEGATE
- child-a.runbook.md
```

```markdown
## 1. Runbook-list shorthand — nested under each entry
- child-a.runbook.md
  - DELEGATE
- child-b.runbook.md
  - DELEGATE
```

Worked examples for each form live in `delegation/delegate-keyword-*.runbook.md`
(e.g., `delegate-keyword-h2-propagation.runbook.md`,
`delegate-keyword-h3-explicit.runbook.md`,
`delegate-keyword-runbook-shorthand.runbook.md`). See
[docs/spec/language.md §7](../docs/spec/language.md#7-delegation) for syntax
rules and
[docs/guides/agent-orchestration.md](../docs/guides/agent-orchestration.md#delegate-annotation)
for the auto-issuance lifecycle and `rd collect`.

A DELEGATE target must resolve to a runbook reference. Prompt-only delegated
substeps and bare H3 substeps with no runbook reference are invalid. Conversely,
a runbook-list entry without nested `- DELEGATE` is inline composition: the
runtime auto-launches the child in-session and propagates its terminal result to
the parent substep. Add nested `- DELEGATE` only when the child should be
claimed by an out-of-process subagent.

For `RETRY` + DELEGATE examples, see
`delegation/delegate-keyword-retry-recovers.runbook.md` and
`delegation/delegate-keyword-retry-exhausts.runbook.md`.
`delegation/delegation-child-fail-once.runbook.md` uses a filesystem marker
pattern for stateful fail-then-pass behavior; see its description for details.

## See Also

- [docs/spec/language.md](../docs/spec/language.md) - Full specification
- [docs/spec/grammar.md](../docs/spec/grammar.md) - BNF grammar
