import * as fs from 'node:fs';
import * as path from 'node:path';
import { isNodeErrorCode } from '../errors.js';
import { assertSafeId } from '../paths.js';
import { ARTIFACT_ERROR_TEXT } from './artifact-errors.js';

/**
 * Concrete run identifier syntax used by artifact producer URIs and metadata.
 */
export const RUN_ID_PATTERN = /^wf_[a-f0-9]{32}$/;
const TEMPLATE_MARKER_PATTERN = /{{.*}}/;
const BARE_BUILTIN_PLACEHOLDERS = new Set(['ContextId', 'RunId']);
const SUPPORTED_SELECTOR_QUERY_KEYS = new Set(['status', 'runbook', 'source', 'latest']);

type ArtifactQuery = Record<string, readonly string[] | undefined>;

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
  readonly query: ArtifactQuery;
}

/**
 * Parsed selector artifact URI with a wildcard run selector or query string.
 */
export interface SelectorArtifactRef extends ArtifactIdentity {
  /** Discriminator for artifact search selectors. */
  readonly kind: 'selector';
  /** Parsed query parameters, grouped by key in source order. */
  readonly query: ArtifactQuery;
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

  if (path.isAbsolute(options.workPath)) {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
  }

  const workRoot = path.resolve(options.cwd, options.workPath);
  const cwdRoot = path.resolve(options.cwd);
  const workRelativeToCwd = path.relative(cwdRoot, workRoot);
  if (escapesRoot(workRelativeToCwd)) {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
  }
  assertNoSymlinkSegments(cwdRoot, workRoot);

  const artifactPath = path.resolve(
    workRoot,
    `.rd-${identity.contextId}`,
    'runs',
    identity.runId,
    identity.key,
  );

  const relative = path.relative(workRoot, artifactPath);
  if (escapesRoot(relative)) {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
  }
  assertNoSymlinkSegments(cwdRoot, artifactPath);

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

function escapesRoot(relativePath: string): boolean {
  return (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

function assertNoSymlinkSegments(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '') {
    return;
  }

  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
      }
    } catch (error) {
      if (isNodeErrorCode(error, 'ENOENT')) {
        return;
      }
      throw error;
    }
  }
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

/**
 * Validate that a run id names one concrete run.
 *
 * @param runId - Candidate run identifier
 * @throws {Error} When the run id is not `wf_` plus 32 lowercase hex characters
 */
export function assertConcreteRunId(runId: string): void {
  validateConcreteRunId(runId);
}

function validateArtifactKey(key: string): void {
  assertSafeId(key, 'ArtifactKey');
}

function parseQuery(searchParams: URLSearchParams): Record<string, readonly string[]> {
  const query: Record<string, string[]> = {};
  for (const [name, value] of searchParams) {
    if (!SUPPORTED_SELECTOR_QUERY_KEYS.has(name)) {
      throw new Error(`Unsupported artifact URI query parameter: ${name}`);
    }
    query[name] ??= [];
    query[name].push(value);
  }
  return query;
}
