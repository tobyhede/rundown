#!/usr/bin/env bash
# Fetch PR review comments and write structured JSON to .work/pr-feedback/
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME [options] <owner/repo> <pr_number>

  Fetch PR review comments and write structured JSON to .work/pr-feedback/

Options:
  -h, --help  Show this help

Examples:
  $SCRIPT_NAME tobyhede/rundown 11
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -*)        echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)         break ;;
  esac
done

command -v gh >/dev/null || { echo "Error: gh (GitHub CLI) required" >&2; exit 2; }

if [[ $# -lt 2 ]]; then
  echo "Error: missing required arguments" >&2
  usage >&2
  exit 1
fi

REPO="$1"
PR="$2"
OUTDIR=".work/pr-feedback"
mkdir -p "$OUTDIR"

# Fetch all inline review comments
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

# Fetch general review comments (non-inline)
gh api "repos/${REPO}/pulls/${PR}/reviews" \
  --paginate \
  --jq '.[] | select(.body != null) | {
    id: .id,
    path: null,
    line: null,
    user: .user.login,
    body: .body,
    created_at: .created_at,
    url: .html_url
  }' >> "$OUTDIR/raw-comments.jsonl"

echo "Fetched $(wc -l < "$OUTDIR/raw-comments.jsonl" | tr -d ' ') comments to $OUTDIR/raw-comments.jsonl"
