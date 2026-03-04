---
name: pr-feedback
description: Fetch, validate, and collate PR review feedback into actionable tasks
---

# PR Feedback Collation

This runbook guides you through fetching PR feedback from GitHub, validating each item against the current codebase, and producing a prioritized task list.

## 1. Fetch PR Metadata

- PASS CONTINUE
- FAIL STOP "Failed to fetch PR metadata. Verify PR number and repository access."

Fetch the PR metadata including title, state, and review decision. Required variable: `{{pr_number}}`. Record the PR title and review status for the output file.

```bash
gh pr view {{pr_number}} --json number,title,state,reviewDecision,url
```

## 2. Fetch Review Comments

- PASS CONTINUE
- FAIL STOP "Failed to fetch review comments."

Fetch all inline review comments (line-specific feedback). Parse the JSON response and extract: `path` (file path), `line` or `original_line` (line number), `body` (comment content), `user.login` (reviewer name), `created_at` (timestamp).

```bash
gh api repos/:owner/:repo/pulls/{{pr_number}}/comments
```

## 3. Fetch Review Summaries

- PASS CONTINUE
- FAIL STOP "Failed to fetch review summaries."

Fetch overall review summaries (non-inline feedback). Extract review bodies that contain feedback not tied to specific lines.

```bash
gh api repos/:owner/:repo/pulls/{{pr_number}}/reviews
```

## 4. Deep Validate Feedback

- PASS CONTINUE
- FAIL STOP "Validation could not be completed."

For each feedback item, perform deep validation against the current codebase.

**Validation Process** - For each item with a file reference:
1. **File Check:** Verify the file exists at the referenced path
2. **Line Check:** Verify line number is within file bounds
3. **Content Analysis:** Read code around the line and check if the issue is present
4. **Fix Assessment:** Evaluate if the suggested fix would apply cleanly
5. **Related Code:** Check if related code has changed

**Validation Status:** Assign one of: `VALID` (file/line exists, issue present, fix applicable), `INVALID` (referenced code doesn't exist or issue doesn't apply), `ALREADY_FIXED` (issue addressed in commits after review), `NEEDS_DISCUSSION` (complex tradeoff, multiple valid approaches), `PARTIAL` (some aspects addressed, others remain).

**Severity Classification:** Categorize each VALID item as: Critical (security issues, missing dependencies, breaking changes), Major (type safety, logic errors, missing error handling), Minor (documentation, style, test coverage), or Nitpick (suggestions, preferences, alternatives).

Present your validation findings before proceeding.

## 5. Collate Task List

- PASS COMPLETE "Task list created at .work/{date}-pr-{{pr_number}}-feedback.md"
- FAIL STOP "Failed to create task list."

Create a prioritized task list from validated feedback. Write to `.work/{date}-pr-{{pr_number}}-feedback.md`. Use the template at `packages/claude-code-plugin/templates/pr-feedback.template.md` as a guide.

Include: (1) Header with PR metadata (number, title, review status, date), (2) Summary table with counts by severity, (3) Critical Issues section with full details and checkboxes, (4) Major Issues section with full details and checkboxes, (5) Minor Issues as bullet list, (6) Nitpicks as bullet list, (7) Skipped Items section noting INVALID/ALREADY_FIXED items with reasons.

For Critical/Major items use format: `### {file}:{line}` with Issue, Suggested Fix, Validation status, and `- [ ] TODO` checkbox. For Minor/Nitpick items use: `- {file}:{line} - {description} ({status})`.
