#!/usr/bin/env bash
# Parse raw comments into structured findings with severity extraction
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME [options]

  Parse raw PR comments into structured findings with severity extraction.
  Reads from \$OUTDIR/raw-comments.jsonl (run fetch-pr-comments.sh first).
  Output directory defaults to \$OUTDIR or \$WORK_PATH/pr-feedback, falling back
  to .rundown/work/pr-feedback.

Options:
  -h, --help  Show this help

Environment:
  OUTDIR       Explicit output directory (overrides WORK_PATH).
  WORK_PATH    Base work directory; pr-feedback is read from it.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -*)        echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)         break ;;
  esac
done

command -v jq >/dev/null || { echo "Error: jq required" >&2; exit 2; }

OUTDIR="${OUTDIR:-${WORK_PATH:-.rundown/work}/pr-feedback}"
RAW="$OUTDIR/raw-comments.jsonl"

[ -f "$RAW" ] || { echo "Error: $RAW not found. Run fetch-pr-comments.sh first." >&2; exit 1; }

# Extract CodeRabbit severity from body, classify source
jq -r '
  def classify_source:
    if .user | test("coderabbit") then "coderabbit"
    elif .user | test("\\[bot\\]") then "bot"
    else "human"
    end;

  def extract_severity:
    if .body | test("🔴 Critical") then "critical"
    elif .body | test("🟠 Major") then "major"
    elif .body | test("🟡 Minor") then "minor"
    elif .body | test("🔵 Trivial") then "trivial"
    else "unknown"
    end;

  def extract_category:
    if .body | test("Potential issue") then "issue"
    elif .body | test("Refactor suggestion") then "refactor"
    elif .body | test("Nitpick") then "nitpick"
    else "comment"
    end;

  def is_addressed:
    .body | test("✅ Addressed");

  {
    id: .id,
    path: .path,
    line: .line,
    source: classify_source,
    severity: extract_severity,
    category: extract_category,
    addressed: is_addressed,
    user: .user,
    url: .url
  }
' "$RAW" > "$OUTDIR/findings.jsonl"

# Print summary table
echo "=== PR Feedback Summary ==="
echo ""
echo "Total findings: $(grep -c '' < "$OUTDIR/findings.jsonl")"
echo ""
echo "By severity:"
jq -r '.severity' "$OUTDIR/findings.jsonl" | sort | uniq -c | sort -rn
echo ""
echo "By source:"
jq -r '.source' "$OUTDIR/findings.jsonl" | sort | uniq -c | sort -rn
echo ""
echo "Already addressed:"
jq -r 'select(.addressed) | .path' "$OUTDIR/findings.jsonl" | grep -c '' || echo "0"
echo ""
echo "Actionable (not addressed):"
jq -r 'select(.addressed | not) | "\(.severity)\t\(.path):\(.line)\t\(.category)"' "$OUTDIR/findings.jsonl"
