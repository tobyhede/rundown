#!/usr/bin/env bash
# Fetch PR review comments and write structured JSON to .work/pr-feedback/
set -euo pipefail

REPO="${1:?Usage: fetch-pr-comments.sh <owner/repo> <pr_number>}"
PR="${2:?Usage: fetch-pr-comments.sh <owner/repo> <pr_number>}"
OUTDIR=".work/pr-feedback"
mkdir -p "$OUTDIR"

# Fetch all review comments
gh api "repos/${REPO}/pulls/${PR}/comments" \
  --paginate \
  --jq '.[] | {
    id: .id,
    path: .path,
    line: (.line // .original_line),
    user: .user.login,
    body: .body,
    created_at: .created_at,
    url: .html_url
  }' > "$OUTDIR/raw-comments.jsonl"

echo "Fetched $(wc -l < "$OUTDIR/raw-comments.jsonl" | tr -d ' ') comments to $OUTDIR/raw-comments.jsonl"
