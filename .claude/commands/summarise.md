# Best Practices for Token-Efficient Summaries for AI Agents

## Skill: Managing README and Markdown Content (Claude Code CLI)

Create **schema’d summaries** (machine-usable, not prose) plus
**multi‑granularity summary indexes** for README.md and similar docs—optimized
for:

- **Minimal tokens**
- **High factual fidelity**
- **Fast retrieval later**

### Hard rules

- **Never invent details.** If unsure → omit.
- Prefer **short noun phrases**; drop filler and commentary.
- Preserve exactly: **names, IDs, numeric values, file paths, commands,
  constraints**.
- Commands must be **lossless or near‑lossless** (verbatim code blocks).

---

## Agent discovery (how agents find and use the summaries)

Agents only benefit from these JSON summary artifacts if discovery is
**deterministic**.

### Discovery convention (recommended)

For any Markdown doc `X.md`, write summary artifacts **adjacent to the source**:

- `X.agent.summary.json`
- `X.agent.sections.jsonl`
- `X.agent.commands.jsonl`

Example for `README.md`:

- `README.agent.summary.json`
- `README.agent.sections.jsonl`
- `README.agent.commands.jsonl`

### Agent consumption order (required)

1. Load `X.agent.summary.json` first.
2. If a task maps to an anchor in `toc[]`, load the matching section object(s)
   from `X.agent.sections.jsonl`.
3. If code is required, load command objects from `X.agent.commands.jsonl` by
   `id`.
4. Fall back to raw Markdown only if summaries are missing/insufficient.

### README note to make this discoverable (paste into README)

```md
### Agent-friendly summaries

This repo includes machine-readable summaries for token-efficient agent workflows:

- `README.agent.summary.json` (doc overview + ToC + command refs)
- `README.agent.sections.jsonl` (per-section summaries)
- `README.agent.commands.jsonl` (verbatim code blocks)

When using an LLM/agent, prefer these files for fast, high-fidelity retrieval before reading the full README.
```

### Optional marker (low-token, unambiguous)

```md
<!-- agent-summaries: README.agent.summary.json -->
```

---

## Inputs

- `README.md` (or any Markdown doc with headings, links, and fenced code
  blocks).

---

## Outputs (multi‑granularity summary indexes)

Write **three artifacts** per doc (no extra tools required; plain files
in-repo):

1. **Doc summary (tiny, retrieval-first)** `README.agent.summary.json`

2. **Section index (one record per section)** `README.agent.sections.jsonl`
   _(JSON Lines; 1 object per line)_

3. **Commands index (lossless code blocks; referenced by ID)**
   `README.agent.commands.jsonl` _(JSON Lines; 1 object per line)_

### Retrieval intent

- Agents load **(1)** first.
- Only fetch **(2)** for a specific anchor/topic.
- Only fetch **(3)** when a task needs commands/snippets.

---

## Proposed summary structures (reference)

### 1) `README.agent.summary.json` (doc-level)

```json
{
  "tldr": "≤2 lines.",
  "outline": ["noun phrase", "noun phrase"],
  "constraints": ["hard limits / caveats"],
  "toc": [{"h": "Section heading", "a": "#url-anchor"}],
  "commands": [
    {"id": "cmd_001", "a": "#section-anchor", "lang": "bash", "label": "short noun phrase"}
  ]
}
```

**Field meanings**

- `tldr`: 1–2 lines. What this doc is and why it matters.
- `outline[]`: major topics only (usually ToC headings). Noun phrases.
- `constraints[]`: explicit caveats/limits/anti-patterns/known gaps.
- `toc[]`: section headings + anchors (for targeted fetch).
- `commands[]`: _references_ to commands by ID (not the code itself).

---

### 2) `README.agent.sections.jsonl` (per-section)

Each line is one JSON object:

```json
{"a":"#setup-api","tldr":"≤1 line","outline":["..."],"constraints":["..."],"command_ids":["cmd_001","cmd_004"]}
```

**Field meanings**

- `a`: anchor for the section (e.g. `#installation`, `#api`).
- `tldr`: ≤1 line summary of the section.
- `outline[]`: 3–7 bullets max. Noun phrases.
- `constraints[]`: only constraints stated in this section.
- `command_ids[]`: IDs of code blocks within this section.

---

### 3) `README.agent.commands.jsonl` (lossless code blocks)

Each line is one JSON object:

```json
{"id":"cmd_001","a":"#setup-api","lang":"typescript","label":"setup() typed entry","code":"<verbatim fenced block contents>"}
```

**Field meanings**

- `id`: stable identifier (see ID rules).
- `a`: closest enclosing section anchor.
- `lang`: fence language (e.g. `bash`, `ts`, `json`), or empty string.
- `label`: short noun phrase describing purpose.
- `code`: verbatim block contents (no rewriting, no normalization).

---

## ID conventions (repeatability)

- Commands are numbered in **file order**:
  - `cmd_001`, `cmd_002`, …
- If a README changes, keep IDs stable when possible by:
  - matching identical code blocks and preserving their IDs
  - only renumbering when unavoidable

---

## Extraction procedure (agent steps)

### Step 0 — Establish scope

- Identify the document’s purpose and audience.
- Identify whether the doc includes:
  - a Markdown ToC (preferred for fidelity)
  - headings that imply sections even without a ToC

### Step 1 — Build `toc[]`

- If the doc includes a ToC list of links, **copy it** into `toc[]`:
  - `h`: the visible heading text
  - `a`: the URL anchor target (e.g. `#installation`)
- If no ToC exists:
  - derive from headings (`#`, `##`, `###`)
  - use the doc’s existing anchor style if present

### Step 2 — Write `tldr`

- ≤2 lines, factual.
- Include **version numbers** and **dates** only if explicitly present.
- Avoid marketing language.

### Step 3 — Write `outline[]`

- Use ToC headings as bullets.
- Keep each bullet ≤ ~6 words.
- Prefer nouns: “Typed setup API”, “Migration notes”, “Tooling”.

### Step 4 — Extract code blocks → `commands` index

For every fenced code block:

1. Assign next `cmd_###`.
2. Capture the fence language (`lang`).
3. Associate with nearest enclosing section anchor `a`.
4. Store the code **verbatim** in `README.agent.commands.jsonl`.
5. Add a reference entry to doc summary (`commands[]`) and section record
   (`command_ids[]`).

**Do not:**

- reformat code
- compress code by removing whitespace
- paraphrase command arguments

### Step 5 — Extract `constraints[]`

Constraints are explicit statements of:

- limitations
- non-goals
- gaps in type-safety / validation
- “does not” / “won’t” / “not enforced”
- situations that break inference or correctness
- required invariants (e.g. “must use X entry point”)

Write each constraint as a short, factual sentence or noun phrase.

### Step 6 — Write per-section records

For each ToC section anchor:

- `tldr`: 1 line
- `outline[]`: 3–7 items
- `constraints[]`: only those in-section
- `command_ids[]`: all command IDs in-section

---

## Token minimization tactics (without extra tooling)

- Prefer **IDs and anchors** over repeating text.
- Keep section `outline[]` short; omit low-signal prose.
- Use noun phrases; remove adjectives unless required to disambiguate.
- Store full code only once (in `commands` index).

---

## Retrieval protocol (how agents should consume later)

1. Load `README.agent.summary.json` first.
2. Map the task to a `toc[].a` anchor.
3. Load matching section object(s) from `README.agent.sections.jsonl`.
4. If code is required, load command objects from `README.agent.commands.jsonl`
   by `id`.
5. Only fall back to raw README if summaries don’t contain needed facts.

---

## Quality bar (definition of done)

- Anchors in `toc[]` match the doc’s link targets.
- `tldr` is ≤2 lines; section `tldr` is ≤1 line.
- No invented details; omissions are preferred over guesses.
- All fenced blocks are captured in `commands` index and referenced by ID.
- Constraints list contains only explicit caveats/limits stated in the doc.
- Summaries remain useful when skimmed alone (without raw README).

---

## Notes for Claude Code CLI usage

- Treat this as a **repeatable transformation**: read Markdown → emit three
  artifacts.
- When updating summaries, prefer **diff-friendly** edits:
  - stable ordering (`toc` order)
  - stable IDs (`cmd_###`)
  - minimal churn
