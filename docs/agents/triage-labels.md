# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those
roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the
corresponding label string from this table.

**This table is not an exhaustive replacement set, and applying a triage label
is additive.** The repo carries its own priority and status vocabulary —
`P0: critical` through `P3: low`, `doing`, `security`, and others — which is
orthogonal to triage state. Add the triage label with
`gh issue edit <n> --add-label`, and leave every existing label in place; only
remove a label when swapping one triage role for another (e.g. `needs-info` →
`ready-for-agent`).

Edit the right-hand column to match whatever vocabulary you actually use.
