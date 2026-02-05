---
name: create-worktree
description: Create a new git worktree for isolated development
tags:
  - workflow
  - git
---

# Create Git Worktree

Create an isolated worktree for focused development work.

**OBJECTIVE:** Set up a new git worktree with proper branch configuration.

**DONE WHEN:** Worktree is created and ready for development.

## 1 Verify Git Repository
- PASS: CONTINUE
- FAIL: STOP "Not in a git repository."

Verify we're in a valid git repository.

```bash
git rev-parse --git-dir
```

## 2 Create Worktree
- PASS: CONTINUE
- FAIL: STOP "Failed to create worktree."

Create the new worktree with the specified branch.

```bash
rd echo git worktree add -b feature/new-work ../new-worktree
```

## 3 Verify Setup

- PASS: COMPLETE "Worktree created successfully."
- FAIL: STOP "Worktree verification failed."

Confirm the worktree was created correctly.

```bash
git worktree list
```
