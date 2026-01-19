# Rundown Patterns

Canonical patterns demonstrating Rundown runbook features. Browse the subdirectories to discover patterns by category.

## Scenario Naming Taxonomy

To ensure clarity and consistency across all pattern examples, we follow a holistic naming strategy where the **filename** and **scenario name** work together to describe the intent.

### Holistic Strategy

1.  **The "Default" Rule**: If a runbook demonstrates a single primary path, use `completed`. This is concise and avoids repeating words from the filename.
2.  **The "Variation" Rule**: When a runbook has multiple paths to the same result, the scenario name describes the **differentiating branch or condition** (e.g., `via-named` vs `via-static`).
3.  **The "Choice" Rule**: If the runbook centers on a specific decision point (like a failure transition), use the **action taken** as the scenario name (e.g., `continue` vs `stop`).
4.  **Remove Redundancy**: Do not include "success", "failure", or the core topic of the filename in the scenario name. The `result` field already indicates the outcome.

### Coherent Taxonomy

| Category | Scenario Name | Focus |
| :--- | :--- | :--- |
| **Simple** | `completed`, `stopped` | Standard primary outcomes. |
| **Branching** | `via-[name]`, `skipped-[name]` | Destination or path taken. |
| **Retries** | `immediate`, `after-retry` | Timing of success. |
| **Exhaustion** | `continue`, `stop`, `goto-[name]` | Action taken after retry limit reached. |
| **Dynamic** | `single`, `multiple`, `batch` | Volume of iterations. |
| **Composition** | `completed`, `agent-fails`, `child-fails` | Failure mode in delegation. |

## Pattern Categories

| Directory | Description |
|-----------|-------------|
| `sequential/` | Linear runbooks with numbered steps |
| `dynamic/` | Runtime-determined iteration using `{N}` placeholder |
| `named/` | Steps identified by name instead of number |
| `substeps/` | Nested steps within parent steps |
| `navigation/` | GOTO patterns for jumping between steps |
| `transition/` | PASS/FAIL logic and state transitions |
| `retries/` | Retry logic and exhaustion handling |
| `prompts/` | User prompts and input handling |
| `composition/` | Parent runbooks, agents, and delegation |
| `tests/` | Core functionality and edge case verification |
| `featured/` | Real-world use cases |

## Creating New Patterns

1. Choose the appropriate category directory
2. Use descriptive filename: `feature-variant.runbook.md`
3. Add scenarios following the naming taxonomy above
4. Include `result: pass` or `result: fail` in scenario metadata

## See Also

- [SPEC.md](../../docs/SPEC.md) - Full specification
- [FORMAT.md](../../docs/FORMAT.md) - BNF grammar
