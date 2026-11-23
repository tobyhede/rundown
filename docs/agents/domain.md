# Domain Docs

How the engineering skills should consume this repo's domain documentation when
exploring the codebase.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the repo root — it points at one `GLOSSARY.md` per
  package. Read each one relevant to the topic.
- **`docs/adr/`** — system-wide architectural decisions. Read the ADRs that
  touch the area you're about to work in.
- **`packages/<package>/docs/adr/`** — package-scoped decisions. Check these too
  when working inside a single package.

If any of these files don't exist, **proceed silently**. Don't flag their
absence; don't suggest creating them upfront. The `/domain-modeling` skill
(reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates
them lazily when terms or decisions actually get resolved.

## File structure

```text
/
├── GLOSSARY-MAP.md
├── docs/adr/                           ← system-wide decisions
└── packages/
    ├── core/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                   ← package-specific decisions
    ├── cli/
    │   ├── GLOSSARY.md
    │   └── docs/adr/
    ├── parser/
    ├── mcp/
    └── claude-code-plugin/
```

The five packages are the contexts. They are not independent systems — `cli`,
`mcp`, and `claude-code-plugin` are thin front ends onto the `core` state
machine — but each owns vocabulary the others don't (policy flags and output
formatting in `cli`, AST and diagnostics in `parser`, the state machine and
lifecycle in `core`). Shared, cross-package terms belong in `GLOSSARY-MAP.md`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal,
a hypothesis, a test name), use the term as defined in the relevant
`GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

`CLAUDE.md` already fixes part of this vocabulary and takes precedence over any
`GLOSSARY.md` that contradicts it — in particular the **Conceptual Model** table
(RESULT / HANDLER / ACTION are three distinct layers and must never be
conflated) and the **Architectural Principles** section. Treat those as
authoritative glossary entries.

If the concept you need isn't in the glossary yet, that's a signal — either
you're inventing language the project doesn't use (reconsider) or there's a real
gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than
silently overriding. Illustrative shape only — substitute the real ADR:

> _Contradicts `<ADR-ID>` (`<decision>`) — but worth reopening because…_
