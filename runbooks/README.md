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

| Category       | Scenario Name                     | Focus                                   |
| :------------- | :-------------------------------- | :-------------------------------------- |
| **Simple**     | `completed`, `stopped`            | Standard primary outcomes.              |
| **Branching**  | `via-[name]`, `skipped-[name]`    | Destination or path taken.              |
| **Retries**    | `immediate`, `after-retry`        | Timing of success.                      |
| **Exhaustion** | `continue`, `stop`, `goto-[name]` | Action taken after retry limit reached. |
| **Dynamic**    | `single`, `multiple`, `batch`     | Volume of iterations.                   |

## Pattern Categories

| Directory          | Description                                             |
| ------------------ | ------------------------------------------------------- |
| `transitions/`     | PASS/FAIL logic, state transitions, and code execution  |
| `retries/`         | Retry logic and exhaustion handling                     |
| `goto/`            | GOTO patterns for jumping between steps                 |
| `examples/`        | Real-world use cases                                    |
| `for-loops/`       | FOR loop iteration patterns                             |
| `substeps/`        | Nested steps within parent steps                        |
| `named-steps/`     | Steps identified by name instead of number              |
| `prompts/`         | User prompts and input handling                         |
| `variables/`       | Template variables, built-ins, and context              |
| `artifacts/`       | Artifact capture and resolution                         |
| `context-passing/` | OUTPUTS directives and frontmatter `outputs:`/`inputs:` |
| `composition/`     | Inline child runbooks driven by the parent's token      |
| `delegation/`      | Delegated children claimed by ticket and Collected      |

`composition/` holds the Inline Child fixtures (#903): parents whose
runbook-list substeps run their children on the parent's Owner Token, including
a two-deep chain, GOTO re-entry, FOR + inline, and an inline child that itself
delegates. `delegation/` holds the Delegation fixtures (#904): a step entry
lists each child's Claim Ticket, `rd claim` starts the child under its own Owner
Token, and the parent's `rd collect` applies the Child Results — single pass and
fail, a fan-out of four Collected in any order, FOR + DELEGATE, outputs flowing
to the parent, and one scenario per agent-confusion refusal (`ALREADY_CLAIMED`,
`PARENT_RUN_FINISHED`, `DELEGATION_CANCELLED`, `INVALID_STEP`). The
`agent-dispatch/` and `stash-pop/` directories were removed with the one-writer
rebuild (#901) and have no replacement.

## Scenario Command Shape

Every run has exactly one owner, proven by its Owner Token. `rd run` prints the
token as `owner_token` on the `runbook_started` event, and the scenario runner
captures it as `${TOKEN}`. Every mutating command in a scenario names that
token:

```yaml
scenarios:
  completed:
    commands:
      - rd run --prompted my-runbook.runbook.md
      - rd pass --token ${TOKEN} --step 1
      - rd fail --token ${TOKEN} --step 2.1
      - rd pass --token ${TOKEN} --step 2.2
    result: COMPLETE
```

- `rd pass` / `rd fail` (and the aliases `rd yes`, `rd ok`, `rd no`) take
  `--token ${TOKEN}` and a required `--step <position>`. The position must name
  the active step exactly: `1` for a top-level step with no active substep,
  `2.1` for a substep, or a named step such as `ErrorHandler` or `1.Cleanup`. A
  bare `--step 2` is refused while a substep of step 2 is active.
- Inside a FOR frame, add `--index <iteration>` naming the active iteration:
  `rd pass --token ${TOKEN} --step 1.1 --index 2`. `--index` is refused when the
  active step is not a FOR frame.
- `rd goto`, `rd stop`, and `rd complete` take `--token ${TOKEN}` and no
  `--step`: `rd stop --token ${TOKEN} "operator stopped"`.
- `rd run` and read-only commands (`rd status`, `rd ls`) stay bare. `--run` is a
  read-only target selector and is never combined with `--token`.

- Delegation (#904): a delegated step's `step_entered` lists each child with its
  Claim Ticket, captured in order as `${TICKET}`, `${TICKET_2}`, ….
  `rd claim ${TICKET}` (optionally `--agent-id <id>`) starts the child and
  prints its own `owner_token`, captured as `${CHILD_TOKEN}` (its run id as
  `${CHILD_RUN}`); the child is driven with `--token ${CHILD_TOKEN}`. The
  parent's owner applies the children's results with
  `rd collect --token ${TOKEN}`, and `expect.collected` asserts the children
  each collect reported (`step`, `index`, `status`, `result`), in order.

Nothing is written on a refusal, so a wrong `--step` leaves the run where it
was; the error message names the current position.

## Creating New Patterns

1. Choose the appropriate category directory
2. Use descriptive filename: `feature-variant.runbook.md`
3. Add scenarios following the naming taxonomy above and the command shape in
   [Scenario Command Shape](#scenario-command-shape)
4. Include `result: COMPLETE` or `result: STOP` in scenario metadata (or use
   `expect:` block for step-level assertions)
5. Rebuild the CLI (`npm run build -w packages/cli`) before running a runbook
   that references another runbook through `rd scenario run` — the scenario
   runner reads from `packages/cli/dist/runbooks/`, which is refreshed by the
   post-build `scripts/copy-runbooks.js` hook.

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

`ContextId` is a built-in variable generated once per execution. Pass it
explicitly with `--input ContextId=...` when a second runbook should write into
the same context directory (see `context-passing/outputs-inputs.runbook.md`).
Automatic inheritance across a parent/child run tree returns with delegation in
#904.

## See Also

- [docs/spec/language.md](../docs/spec/language.md) - Full specification
- [docs/spec/grammar.md](../docs/spec/grammar.md) - BNF grammar
