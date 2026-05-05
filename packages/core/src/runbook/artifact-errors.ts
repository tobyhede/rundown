/**
 * Stable error text for artifact URI, schema, and manifest validation.
 */
export const ARTIFACT_ERROR_TEXT = {
  INVALID_URI_PATH_SHAPE: 'Invalid artifact URI path shape',
  CROSS_CONTEXT_WILDCARD: 'Artifact URI ContextId wildcard is not supported in v1',
  RECURSIVE_WILDCARD: 'Recursive artifact URI wildcards are not supported in v1',
  UNRESOLVED_TEMPLATE_MARKER: 'Artifact URI contains unresolved template marker',
  BARE_BUILTIN_PLACEHOLDER: 'Artifact URI contains bare built-in placeholder',
  INVALID_RUN_ID: 'Invalid RunId: expected wf_<32 lowercase hex chars>',
  INVALID_URI_FRAGMENT: 'Artifact URI fragments are not supported',
  URI_MUST_BE_EXACT: 'uri must be an exact artifact URI',
  URI_CONTEXT_MISMATCH: 'uri contextId does not match contextId',
  URI_RUN_ID_MISMATCH: 'uri runId does not match runId',
  URI_KEY_MISMATCH: 'uri key does not match key',
  INVALID_MANIFEST_JSON: 'Invalid artifact manifest JSON',
  INVALID_MANIFEST_RECORD: 'Invalid artifact manifest record',
  EXACT_URI_NOT_SELECTOR: 'findArtifactMatches requires a selector artifact URI',
} as const;

/**
 * Format a line-oriented artifact manifest validation error.
 *
 * @param manifestPath - Manifest file path being read
 * @param lineNumber - One-based manifest line number
 * @param reason - Human-readable validation failure
 * @returns A compiler-style `<path>:<line>: <reason>` error string
 */
export function formatArtifactManifestLineError(
  manifestPath: string,
  lineNumber: number,
  reason: string,
): string {
  return `${manifestPath}:${lineNumber}: ${reason}`;
}
