/**
 * Shared rendering helpers for the sticky mutation PR comment.
 *
 * Three scripts write fragments into that one comment — the changed-scope gate
 * (`scripts/assert-mutation-score.mjs`), the test-only regression comparison
 * (`scripts/assert-mutation-regressions.mjs`) and the shard planner
 * (`scripts/mutation-shard-plan.mjs`) — and every fragment interpolates values it
 * does not control: file paths, mutator replacements, diagnostic text. They must
 * escape those values identically, so the escaper lives here once rather than as a
 * local copy per renderer that can drift.
 *
 * @module scripts/lib/pr-comment
 */

/**
 * Render an interpolated value as inert text for a GitHub PR comment.
 *
 * GitHub renders the comment markdown to HTML, and backslash escapes do NOT work
 * inside a markdown code span, so a backtick in a file path would still break a
 * `...` span. Encoding `, |, <, >, & as HTML entities leaves nothing for the
 * markdown/table parser to misinterpret. Newlines are collapsed to spaces so a
 * value can't break the table row.
 *
 * The pipe is escaped in every fragment, not only the ones that draw a table: a
 * `LogicalOperator` mutant's `replacement` is literally `||`, and `&#124;` renders
 * as a plain `|` in body text, so applying the superset everywhere costs nothing
 * and removes a whole class of near-miss.
 *
 * `&` is replaced first so the entities introduced afterwards are not themselves
 * re-encoded.
 *
 * @param {unknown} value - the value to interpolate.
 * @returns {string} the value as HTML-escaped, single-line text.
 */
export function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '&#96;')
    .replace(/\|/g, '&#124;')
    .replace(/\r?\n/g, ' ');
}
