---
name: Vanta Security Patch
description: Automated workflow for remediating Vanta security vulnerabilities via Linear issues.
tags:
  - featured
scenarios:
  full-workflow:
    description: Complete flow - discover, prepare, patch, complete, and resolve one issue
    commands:
      - rd run --prompted vanta-security-patch.runbook.md
      - rd pass  # 1 Discover Issues
      - rd no    # 2 Consolidate Duplicates - GOTO PrepareIssue
      - rd pass  # PrepareIssue
      - rd pass  # 4 Apply Patch
      - rd pass  # 5 Complete Issue
      - rd no    # 6 More Issues - CONTINUE
      - rd pass  # 7 Wait for CI
      - rd pass  # 8 Resolve PRs - COMPLETE
    result: COMPLETE
  already-patched:
    description: Package already at target version (Dependabot handled it)
    commands:
      - rd run --prompted vanta-security-patch.runbook.md
      - rd pass  # 1 Discover Issues
      - rd no    # 2 Consolidate Duplicates - GOTO PrepareIssue
      - rd pass  # PrepareIssue
      - rd pass  # 4 Apply Patch
      - rd fail  # 5 Complete Issue - GOTO AlreadyPatched
      - rd pass  # AlreadyPatched - GOTO MoreIssuesAfterSkip
      - rd no    # MoreIssuesAfterSkip - COMPLETE
    result: COMPLETE
  batch-processing:
    description: Process multiple issues in sequence
    commands:
      - rd run --prompted vanta-security-patch.runbook.md
      - rd pass  # 1 Discover Issues
      - rd yes   # 2 Consolidate Duplicates - CONTINUE
      - rd pass  # 3 Mark Duplicates
      - rd pass  # PrepareIssue (first issue)
      - rd pass  # 4 Apply Patch
      - rd pass  # 5 Complete Issue
      - rd yes   # 6 More Issues - GOTO PrepareIssue
      - rd pass  # PrepareIssue (second issue)
      - rd pass  # 4 Apply Patch
      - rd pass  # 5 Complete Issue
      - rd no    # 6 More Issues - CONTINUE
      - rd pass  # 7 Wait for CI
      - rd pass  # 8 Resolve PRs - COMPLETE
    result: COMPLETE
---

# Vanta Security Patch

Automated workflow for remediating security vulnerabilities identified by Vanta and tracked in Linear.

## 1. Discover Issues

- PASS: CONTINUE
- FAIL: STOP "Failed to fetch Vanta issues from Linear"

Fetch all outstanding Vanta security patch issues from Linear. Review the output to identify primary issues to process first.

```bash
./scripts/fetch-vanta-issues.sh --consolidate --verbose
```

## 2. Consolidate Duplicates

- YES: CONTINUE
- NO: GOTO PrepareIssue

Are there duplicate issues to mark in Linear? (Lower version issues superseded by higher versions)

## 3. Mark Duplicates

- PASS: CONTINUE
- FAIL: RETRY 1

Mark duplicate issues in Linear with superseded information.

```bash
./scripts/fetch-vanta-issues.sh --consolidate | ./scripts/mark-duplicate-issues.sh
```

## PrepareIssue. Prepare Issue for Patching

- PASS: CONTINUE
- FAIL: STOP "Failed to prepare issue - check Linear ID and repository access"

Prepare the issue for patching. Replace CIP-XXXX with the actual issue ID. This parses the package/version, detects the repository and language, creates a feature branch (`fix/cip-xxxx-{package}-patch`), and outputs the exact patching command to run.

```bash
./scripts/prepare-vanta-issue.sh CIP-XXXX
```

## 4. Apply Patch

- PASS: CONTINUE
- FAIL: RETRY 2 GOTO ApplyPatchFailed

Run the patching command from the prepare output. For JavaScript/TypeScript use `pnpm add {package}@{version}`, for Rust use `cargo update {package} --precise {version}`. Verify the lock file was updated.

```bash prompt
pnpm add {package}@{version}
```

## 5. Complete Issue

- PASS: CONTINUE
- FAIL: GOTO AlreadyPatched

Validate, commit, push, and create PR for the patched issue. This validates the patch, creates a commit (`fix(deps): patch {package} to {version}`), pushes the branch, creates a GitHub PR, and updates Linear with the PR link.

```bash
./scripts/complete-vanta-issue.sh --yes CIP-XXXX
```

## 6. More Issues

- YES: GOTO PrepareIssue
- NO: CONTINUE

Are there more issues to process in this session?

## 7. Wait for CI

- PASS: CONTINUE
- FAIL: GOTO CIFailed

Wait for GitHub Actions CI to complete on all open PRs. Verify all checks pass before merging.

```bash
gh pr list --state open --author @me
```

## 8. Resolve PRs

- PASS: COMPLETE "All Vanta issues resolved successfully."
- FAIL: RETRY 1

After PRs are merged, resolve the Linear issues. Replace with actual PR URLs.

```bash
./scripts/resolve-pr.sh https://github.com/org/repo/pull/XXX
```

## AlreadyPatched. Package Already Patched

- PASS: GOTO MoreIssuesAfterSkip

Package is already at target version (likely patched by Dependabot). The complete script has already updated Linear with this information.

```bash
rd echo "Package already patched - Linear issue updated automatically"
```

## MoreIssuesAfterSkip. Continue With Remaining Issues

- YES: GOTO PrepareIssue
- NO: COMPLETE "Session complete - some issues were already patched."

Continue with remaining issues?

## ApplyPatchFailed. Handle Patch Failure

- PASS: GOTO PrepareIssue
- FAIL: STOP "Manual intervention required for patch application"

Patch application failed. Common causes: package not found, version conflict with other dependencies, or network issues. Check the error output and retry, or investigate manually.

```bash
rd echo "Check package registry and dependency tree for conflicts"
```

## CIFailed. Handle CI Failure

- PASS: GOTO PrepareIssue
- FAIL: STOP "CI failures require manual investigation"

CI checks failed. Review the GitHub Actions logs, fix the issues, and push updates to the PR branch.

```bash
gh run view --log-failed
```
