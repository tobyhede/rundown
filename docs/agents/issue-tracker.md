# Issue tracker: GitHub

Issues, roadmaps and follow-up work for this repo live as GitHub issues. Use the
`gh` CLI for all operations against them.

**This does not relocate prospective documentation.** Per `CLAUDE.md`, dated
specs, implementation plans and design notes stay in `docs/superpowers/`, and
the current design stays in `docs/internal/`. A skill that publishes a _spec_
writes it there; only trackable issues and follow-up work become GitHub issues.
`docs/README.md` remains the documentation index.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a
  heredoc for multi-line bodies.
- **Read an issue**: one call returns body, labels and comments together — no
  separate label fetch needed.

  ```bash
  gh issue view <number> \
    --json number,title,body,labels,comments \
    --jq '{number, title, body, labels: [.labels[].name],
           comments: [.comments[].body]}'
  ```

- **List issues**: with appropriate `--label` and `--state` filters. **Always
  pass `--limit` explicitly** — it defaults to 30 and truncates silently, with
  no indication that results were dropped.

  ```bash
  gh issue list --state open --limit 200 \
    --json number,title,body,labels,comments \
    --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'
  ```

  `gh issue list` has no `--paginate`; it fetches up to `--limit` in one call.
  If the row count comes back equal to the limit, treat the result as truncated
  and re-run with a higher limit (or narrow with `--label` / `--state` /
  `--search`) until it returns fewer rows than the limit.

- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` /
  `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run
inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external
PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using
the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for
  the diff.
- **List external PRs for triage**: author association is **not** available
  through `gh pr list --json` or `gh pr view --json` — both reject
  `authorAssociation` with `Unknown JSON field`. Go through the REST endpoint,
  which returns it as `author_association`:

  ```bash
  gh api 'repos/{owner}/{repo}/pulls?state=open&per_page=100' --paginate \
    --jq '.[]
      | select(.user.type != "Bot")
      | select(.author_association
          | IN("CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"))
      | {number, title, body, author_association, author: .user.login,
         labels: [.labels[].name]}'
  ```

  Keep only associations of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`,
  `FIRST_TIMER`, or `NONE`; drop `OWNER`, `MEMBER`, and `COLLABORATOR`.

  **Filter bots out explicitly**, as above — association alone does not do it.
  On this repo `dependabot[bot]` reports `CONTRIBUTOR` and `github-actions[bot]`
  reports `NONE`, so both survive the association filter and land in the triage
  queue looking like external human PRs.

  The REST list carries no comment bodies (only a `comments_url`). Fetch those
  per PR with `gh pr view <number> --comments` once triage has narrowed the set.

- **Comment / label / close**: `gh pr comment`,
  `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be
either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run the **Read an issue** command above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as
tickets.

- **Bootstrap the labels first.** None of the `wayfinder:*` labels exist on this
  repo yet, and `gh issue create --label <name>` fails outright on an unknown
  label — so run this before the first map or child ticket is created. It is
  idempotent: `|| true` swallows the "already exists" error on re-runs.

  ```bash
  for L in map research prototype grilling task; do
    gh label create "wayfinder:$L" --description "Wayfinder $L" || true
  done
  ```

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes /
  Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue —
  `gh issue edit <map> --add-sub-issue <child>` (or
  `gh issue edit <child> --parent <map>`). Where sub-issues aren't enabled, add
  the child to a task list in the map body and put `Part of #<map>` at the top
  of the child body. Labels: `wayfinder:<type>`
  (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is
  assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical,
  UI-visible representation. `gh` speaks this directly, by issue **number**:

  ```bash
  gh issue edit <child> --add-blocked-by <blocker>
  ```

  `--add-blocking`, `--remove-blocked-by` and `--remove-blocking` are the
  matching operations.

  _Fallback for older `gh` or a host without those flags_ — the raw REST call,
  which needs the blocker's numeric **database id**, not its `#number` or
  `node_id`:

  ```bash
  BLOCKER_ID=$(gh api 'repos/{owner}/{repo}/issues/<blocker>' --jq .id)
  gh api --method POST \
    'repos/{owner}/{repo}/issues/<child>/dependencies/blocked_by' \
    -F "issue_id=$BLOCKER_ID"
  ```

  Where dependencies aren't available at all, fall back to a
  `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is
  unblocked when every blocker is closed.

- **Frontier query**: read the children **off the map**, not from a repo-wide
  issue list — a repo-wide list returns unrelated issues and is subject to the
  `--limit` truncation above. `subIssues` preserves map order.

  ```bash
  gh issue view <map> --json subIssues \
    --jq '[.subIssues.nodes[] | select(.state == "OPEN") | .number] | .[]'
  ```

  Then inspect each child and keep the first eligible one:

  ```bash
  gh issue view <child> --json number,state,assignees,blockedBy \
    --jq '{number, state, assignees: [.assignees[].login],
           openBlockers: [.blockedBy.nodes[] | select(.state == "OPEN") | .number]}'
  ```

  Drop any child that is closed, has an assignee, or has a non-empty
  `openBlockers`; the first survivor in map order wins.

  Two shape traps. `blockedBy` and `subIssues` are `{nodes, totalCount}`
  **objects**, not bare arrays — `.blockedBy[]` is a jq type error. And **filter
  `nodes` by state rather than gating on `totalCount`**: the count includes
  closed blockers, so a child whose blockers have all been closed would
  otherwise stay blocked forever. Connection nodes carry `id`, `number`,
  `state`, `title` and `url`, which is what makes the inline filter possible.

  Where dependency data is unavailable, fall back to reading the child's
  `Blocked by: #<n>` line and checking those issues' states the same way.

- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**, in this order:
  1. `gh issue comment <n> --body "<answer>"`.
  2. Append the context pointer (gist + link) to the map's Decisions-so-far,
     then re-read the map body and confirm the pointer is present.
  3. Only then `gh issue close <n>`.

  Closing last is what makes a partial failure recoverable: a resolved-but-open
  ticket is visibly unfinished and the step can simply be re-run, whereas
  closing first can strand a closed ticket whose pointer never reached the map.
  Make the append idempotent — check for the pointer's URL in the map body
  before adding it, so a re-run after a failed verify doesn't double-write.
