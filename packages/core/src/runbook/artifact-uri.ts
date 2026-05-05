import * as path from 'node:path';
import { assertSafeId } from '../paths.js';
import { ARTIFACT_ERROR_TEXT } from './artifact-errors.js';

const RUN_ID_PATTERN = /^wf_[a-f0-9]{32}$/;
const TEMPLATE_MARKER_PATTERN = /{{.*}}/;
const BARE_BUILTIN_PLACEHOLDERS = new Set(['ContextId', 'RunId']);

/**
 * Identity fields that uniquely address a concrete artifact.
 */
export interface ArtifactIdentity {
  /** Context identifier that owns the artifact run scope. */
  readonly contextId: string;
  /** Concrete run identifier, or `*` in selector refs returned by the parser. */
  readonly runId: string;
  /** Artifact key, stored as a safe filename segment. */
  readonly key: string;
}

/**
 * Parsed exact artifact URI with a concrete run identifier and no query string.
 */
export interface ExactArtifactRef extends ArtifactIdentity {
  /** Discriminator for producer URIs that point to one exact artifact. */
  readonly kind: 'exact';
  /** Parsed query parameters. Always empty for exact refs. */
  readonly query: Record<string, readonly string[]>;
}

/**
 * Parsed selector artifact URI with a wildcard run selector or query string.
 */
export interface SelectorArtifactRef extends ArtifactIdentity {
  /** Discriminator for artifact search selectors. */
  readonly kind: 'selector';
  /** Parsed query parameters, grouped by key in source order. */
  readonly query: Record<string, readonly string[]>;
}

/**
 * Parsed artifact URI reference.
 */
export type ArtifactRef = ExactArtifactRef | SelectorArtifactRef;

/**
 * Options for mapping artifact URIs to local worktree paths.
 */
export interface ArtifactPathOptions {
  /** Project root for path resolution. */
  readonly cwd: string;
  /** Project-root-relative work directory, typically `.rundown/work`. */
  readonly workPath: string;
}

/**
 * Build a canonical exact artifact URI from concrete identity parts.
 *
 * @param identity - Artifact identity with concrete context, run, and key
 * @returns Canonical `rd://artifacts/...` URI
 * @throws {Error} If any identity segment is unsafe or the run id is not concrete
 */
export function buildArtifactUri(identity: ArtifactIdentity): string {
  assertSafeId(identity.contextId, 'contextId');
  validateConcreteRunId(identity.runId);
  validateArtifactKey(identity.key);

  return `rd://artifacts/${encodeURIComponent(identity.contextId)}/runs/${encodeURIComponent(
    identity.runId,
  )}/${encodeURIComponent(identity.key)}`;
}

/**
 * Parse an artifact URI into an exact reference or selector reference.
 *
 * @param uri - Artifact URI to parse
 * @returns Parsed artifact reference
 * @throws {Error} If the URI is malformed or contains unsupported selectors
 */
export function parseArtifactUri(uri: string): ArtifactRef {
  const url = parseArtifactUrl(uri);
  if (url.hash !== '') {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_FRAGMENT);
  }

  const { contextId, runId, key } = parseArtifactPath(url);
  validateDecodedSegments(contextId, runId, key);

  const query = parseQuery(url.searchParams);
  const hasQuery = url.search !== '';

  if (runId !== '*') {
    validateConcreteRunId(runId);
  }
  validateArtifactKey(key);

  return {
    kind: runId === '*' || hasQuery ? 'selector' : 'exact',
    contextId,
    runId,
    key,
    query,
  };
}

/**
 * Parse a producer URI into exact artifact identity parts.
 *
 * Schema-level URI errors are intentionally opaque in this helper: it returns
 * `null` for parse or selector failures. Callers that need diagnostics should
 * use {@link parseArtifactUri}.
 *
 * @param uri - Artifact URI to parse
 * @returns Exact artifact identity, or null when the URI is not exact
 */
export function parseExactArtifactUriParts(uri: string): ArtifactIdentity | null {
  try {
    const ref = parseArtifactUri(uri);
    if (ref.kind !== 'exact') {
      return null;
    }
    return {
      contextId: ref.contextId,
      runId: ref.runId,
      key: ref.key,
    };
  } catch {
    return null;
  }
}

/**
 * Map an exact artifact URI to its local work artifact path.
 *
 * @param uri - Exact artifact URI to map
 * @param options - Worktree path resolution options
 * @returns Absolute path under the configured work directory
 * @throws {Error} If the URI is not exact or the resolved path escapes workPath
 */
export function artifactUriToPath(uri: string, options: ArtifactPathOptions): string {
  const identity = parseExactArtifactUriParts(uri);
  if (identity === null) {
    throw new Error(ARTIFACT_ERROR_TEXT.URI_MUST_BE_EXACT);
  }

  const workRoot = path.resolve(options.cwd, options.workPath);
  const artifactPath = path.resolve(
    workRoot,
    `.rd-${identity.contextId}`,
    'runs',
    identity.runId,
    identity.key,
  );

  const relative = path.relative(workRoot, artifactPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
  }

  return artifactPath;
}

function parseArtifactUrl(uri: string): URL {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
  }

  if (url.protocol !== 'rd:' || url.hostname !== 'artifacts') {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
  }

  return url;
}

function parseArtifactPath(url: URL): ArtifactIdentity {
  const rawSegments = url.pathname.split('/');
  if (
    rawSegments.length !== 5 ||
    rawSegments[0] !== '' ||
    rawSegments[2] !== 'runs' ||
    rawSegments[1] === '' ||
    rawSegments[3] === '' ||
    rawSegments[4] === ''
  ) {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
  }

  return {
    contextId: decodePathSegment(rawSegments[1]),
    runId: decodePathSegment(rawSegments[3]),
    key: decodePathSegment(rawSegments[4]),
  };
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
  }
}

function validateDecodedSegments(contextId: string, runId: string, key: string): void {
  const identitySegments = [contextId, runId, key];
  if (identitySegments.includes('**')) {
    throw new Error(ARTIFACT_ERROR_TEXT.RECURSIVE_WILDCARD);
  }
  if (identitySegments.some((segment) => TEMPLATE_MARKER_PATTERN.test(segment))) {
    throw new Error(ARTIFACT_ERROR_TEXT.UNRESOLVED_TEMPLATE_MARKER);
  }
  if (identitySegments.some((segment) => BARE_BUILTIN_PLACEHOLDERS.has(segment))) {
    throw new Error(ARTIFACT_ERROR_TEXT.BARE_BUILTIN_PLACEHOLDER);
  }
  if (contextId === '*') {
    throw new Error(ARTIFACT_ERROR_TEXT.CROSS_CONTEXT_WILDCARD);
  }

  assertSafeId(contextId, 'contextId');
  if (runId !== '*') {
    assertSafeId(runId, 'runId');
  }
}

function validateConcreteRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_RUN_ID);
  }
}

function validateArtifactKey(key: string): void {
  assertSafeId(key, 'ArtifactKey');
}

function parseQuery(searchParams: URLSearchParams): Record<string, readonly string[]> {
  const query: Record<string, string[]> = {};
  for (const [name, value] of searchParams) {
    query[name] ??= [];
    query[name].push(value);
  }
  return query;
}
