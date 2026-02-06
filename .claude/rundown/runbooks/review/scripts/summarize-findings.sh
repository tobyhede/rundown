#!/usr/bin/env bash
# Parse raw comments into structured findings with severity extraction
set -euo pipefail

OUTDIR=".work/pr-feedback"
RAW="$OUTDIR/raw-comments.jsonl"

[ -f "$RAW" ] || { echo "No comments file found. Run fetch first."; exit 1; }

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
echo "Total findings: $(wc -l < "$OUTDIR/findings.jsonl" | tr -d ' ')"
echo ""
echo "By severity:"
jq -r '.severity' "$OUTDIR/findings.jsonl" | sort | uniq -c | sort -rn
echo ""
echo "By source:"
jq -r '.source' "$OUTDIR/findings.jsonl" | sort | uniq -c | sort -rn
echo ""
echo "Already addressed:"
jq -r 'select(.addressed) | .path' "$OUTDIR/findings.jsonl" | wc -l | tr -d ' '
echo ""
echo "Actionable (not addressed):"
jq -r 'select(.addressed | not) | "\(.severity)\t\(.path):\(.line)\t\(.category)"' "$OUTDIR/findings.jsonl"
