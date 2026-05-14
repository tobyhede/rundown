/**
 * Safety limit for file-backed data sources with open iteration windows.
 *
 * When a FOR loop iterates over a file source without an explicit end bound,
 * this constant prevents runaway iteration if source exhaustion is not observed
 * promptly.
 */
export const MAX_FILE_ITERATIONS = 10_000;
