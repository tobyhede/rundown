/**
 * Size budget for the WebContainer snapshot asset.
 *
 * `public/rundown-snapshot.bin` is ONE static file and Cloudflare Pages rejects
 * any single file over 25 MiB. That ceiling used to be enforced by Cloudflare
 * after merge — a failed deploy, logged behind their dashboard, while every
 * GitHub check went green. This budget moves the failure to the build that
 * produces the asset, far enough below the wall that hitting it is a
 * conversation about weight rather than an outage.
 *
 * See issue #639.
 *
 * @module site/scripts/snapshot-budget
 */

/** Cloudflare Pages' documented per-file ceiling. */
export const CLOUDFLARE_PAGES_FILE_LIMIT_BYTES = 25 * 1024 * 1024;

/**
 * Where the build refuses. Kept close to the asset it guards (~9.4 MiB), not
 * just below the cap: a budget far above the asset lets ten quiet megabytes
 * accrete before anyone hears about it, when the point is that a sql.js-sized
 * addition trips the check in the PR that adds it. Retune deliberately when the
 * asset itself moves.
 */
export const SNAPSHOT_BUDGET_BYTES = 12 * 1024 * 1024;

/**
 * Format a byte count for a build log.
 *
 * @param {number} bytes - Size in bytes.
 * @returns {string} Size in MiB to two decimals.
 */
function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/**
 * Refuse a snapshot that has outgrown its budget.
 *
 * @param {number} byteLength - Size of the built snapshot.
 * @returns {void}
 * @throws {Error} When the snapshot exceeds {@link SNAPSHOT_BUDGET_BYTES}.
 */
export function assertSnapshotWithinBudget(byteLength) {
  if (byteLength <= SNAPSHOT_BUDGET_BYTES) {
    return;
  }

  // One multiline template literal; the `\` line continuations keep the thrown
  // message a single flat line despite the wrapped source (pinned exactly by
  // snapshot-budget.test.mjs).
  throw new Error(
    `WebContainer snapshot is ${formatMiB(byteLength)}, over its \
${formatMiB(SNAPSHOT_BUDGET_BYTES)} budget (Cloudflare Pages rejects any single file over \
${formatMiB(CLOUDFLARE_PAGES_FILE_LIMIT_BYTES)}, so this fails the deploy long before it fails \
a test). Every runtime dependency of @rundown-org/cli is paid for twice: once as a dependency \
and again as weight in this asset. Either drop what was added, or split the asset so no single \
file approaches the limit — see issue #639.`,
  );
}
