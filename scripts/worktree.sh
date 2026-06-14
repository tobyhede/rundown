#!/usr/bin/env bash
# worktree.sh — Create a git worktree under .worktrees/ with deps installed
# Usage: ./scripts/worktree.sh <name> [base-ref]
#        npm run worktree -- <name> [base-ref]
#
# Creates .worktrees/<name> on a new branch <name>, branched from [base-ref]
# (default: main), then runs `npm install` inside it so the workspace is
# immediately buildable/testable.
#
# A fresh `git worktree add` checks out only git-tracked files — node_modules
# is gitignored, so a new worktree has no dependencies until installed. Skipping
# that step makes `npm run build`/tests fail with confusing cross-package type
# errors (the worktree typechecks against an unbuilt/absent core). This wrapper
# removes that footgun. Idempotent-ish: re-running with an existing name fails
# fast on the `git worktree add` step rather than clobbering anything.
set -euo pipefail

name="${1:-}"
base="${2:-main}"

if [[ -z "$name" ]]; then
  echo "Usage: $0 <name> [base-ref]" >&2
  echo "  e.g. $0 my-feature        # branch 'my-feature' from main" >&2
  echo "       $0 my-fix release-1  # branch 'my-fix' from release-1" >&2
  exit 1
fi

# Resolve repo root so the script works from any CWD.
root="$(git rev-parse --show-toplevel)"
dir="$root/.worktrees/$name"

echo "→ Creating worktree '$name' (branch '$name' from '$base') at $dir"
git -C "$root" worktree add -b "$name" "$dir" "$base"

echo "→ Installing dependencies in $dir"
npm --prefix "$dir" install

echo "✓ Worktree ready: $dir"
echo "  cd $dir && npm run build"
