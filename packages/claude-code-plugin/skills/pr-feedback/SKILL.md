---
name: pr-feedback
description: Fetch, validate, and collate PR review feedback into actionable tasks
workflow: pr-feedback.runbook.md
use_when: When you need to check PR feedback, address reviewer comments, or prepare a PR for merge
---

# PR Feedback Collation

This skill provides a systematic approach to processing pull request review feedback from GitHub. It fetches all feedback, validates each item against the current codebase state, and produces a prioritized task list for addressing reviewer comments.

## Overview

The PR feedback workflow consists of four phases:

1. **Fetch** - Retrieve PR metadata, reviews, and inline comments from GitHub
2. **Validate** - Deep-validate each feedback item against current code
3. **Collate** - Organize validated items by severity and location
4. **Output** - Generate actionable task list in `.work/` directory

## When to Use

- After receiving PR review feedback
- Before addressing reviewer comments
- When preparing a PR for final merge
- To track progress on PR feedback resolution

## Fetching Feedback

Use the GitHub CLI to retrieve PR data:

```bash
# PR metadata and review decision
gh pr view <number> --json title,body,state,reviewDecision,comments,reviews

# Inline review comments (line-specific feedback)
gh api repos/{owner}/{repo}/pulls/{pr}/comments

# Review summaries (overall review comments)
gh api repos/{owner}/{repo}/pulls/{pr}/reviews
```

### Data Sources

| Source | Contains | Command |
|--------|----------|---------|
| PR View | Title, body, state, review decision | `gh pr view --json` |
| Review Comments | Inline code comments with file/line refs | `gh api pulls/{pr}/comments` |
| Reviews | Overall review summaries | `gh api pulls/{pr}/reviews` |

## Deep Validation

Each feedback item undergoes validation to determine if it's still relevant:

### Validation Checks

1. **File Check** - Verify referenced file still exists
2. **Line Check** - Verify line number is within file bounds
3. **Content Analysis** - Read surrounding code to verify issue presence
4. **Fix Assessment** - Evaluate if suggested fix is applicable
5. **Dependency Check** - Identify related code that may be affected

### Validation Outcomes

| Status | Meaning | Action |
|--------|---------|--------|
| `VALID` | Issue confirmed present, fix applicable | Include in task list |
| `INVALID` | Issue doesn't apply to current code | Skip with note |
| `ALREADY_FIXED` | Issue addressed in subsequent commits | Skip with note |
| `NEEDS_DISCUSSION` | Complex tradeoff requiring decision | Flag for discussion |
| `PARTIAL` | Part of issue addressed, some remains | Include remaining items |

### Validation Heuristics

When validating feedback:

- **Check git blame** - Was the line modified after the review?
- **Search for patterns** - Does the issue description match current code?
- **Test suggested fix** - Would the fix apply cleanly?
- **Consider context** - Has surrounding code changed significantly?

## Severity Classification

Feedback is categorized by severity for prioritization:

### Critical (Must Fix)

- Security vulnerabilities
- Breaking API changes
- Data corruption risks
- Missing critical dependencies

**Example:** "Add Handlebars to package.json dependencies - runtime error if missing"

### Major (Should Fix)

- Type safety issues
- Logic errors
- Performance problems
- Missing error handling

**Example:** "Type `steps` as `Step[]` to catch type errors at compile time"

### Minor (Nice to Fix)

- Documentation gaps
- Code style inconsistencies
- Missing test coverage
- Refactoring suggestions

**Example:** "Document parse errors from parseRunbookDocument"

### Nitpick (Optional)

- Stylistic preferences
- Minor improvements
- Suggestions for future
- Alternative approaches

**Example:** "Consider using helper function for cleaner code"

## Output Format

The skill produces a markdown file in `.work/` with:

- Summary table of feedback by severity
- Detailed sections for Critical and Major items
- Bullet lists for Minor and Nitpick items
- Task checkboxes for tracking progress
- Validation status for each item

Output location: `.work/{date}-pr-{number}-feedback.md`

## Related Skills

- `code-review` - Creating PR reviews (complementary workflow)
- `verification` - Verifying code changes after fixes
- `commit` - Committing feedback fixes

## Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `pr_number` | Pull request number | Yes |
| `repo` | Repository (owner/repo format) | No (defaults to current) |
