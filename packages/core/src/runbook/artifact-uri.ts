import * as fs from 'node:fs';
import * as path from 'node:path';
import { SELECTOR_ARTIFACT_KEY_PATTERN } from '@rundown-org/parser';
import { isNodeErrorCode } from '../errors.js';
import { assertSafeId } from '../paths.js';
import { ARTIFACT_ERROR_TEXT } from './artifact-errors.js';
import { RUN_ID_PATTERN } from './run-id.js';
export { RUN_ID_PATTERN } from './run-id.js';
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
  validateExactArtifactKey(identity.key);

  return `rd://artifacts/${encodeURIComponent(identity.contextId)}/${encodeURIComponent(identity.runId)}/${encodeURIComponent(identity.key)}`;
}

/**
 * Parse an artifact URI into an exact reference or selector reference.
 *
 * The exact/selector discriminator is structural: a URI is **exact** iff its
 * run segment is concrete (matches `RUN_ID_PATTERN`), its key segment is an
 * exact key (no `*`/`?`), and it carries no query string. Any wildcard in the
 * run or key segment, or any query string, makes the URI a **selector**.
 *
 * Key validation is by kind: exact URIs require an exact key
 * ({@link assertSafeId}); selector URIs accept an exact OR wildcard key
 * ({@link SELECTOR_ARTIFACT_KEY_PATTERN}). A glob key never yields an exact
 * ref — it forces the selector branch even when the run segment is concrete.
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

  const runConcrete = runId !== '*';
  const keyExact = isExactArtifactKey(key);
  const kind: ArtifactRef['kind'] = runConcrete && keyExact && !hasQuery ? 'exact' : 'selector';

  if (kind === 'exact') {
    validateExactArtifactKey(key);
  } else {
    validateSelectorArtifactKey(key, runConcrete);
  }

  return { kind, contextId, runId, key, query };
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
    rawSegments.length !== 4 ||
    rawSegments[0] !== '' ||
    rawSegments[1] === '' ||
    rawSegments[2] === '' ||
    rawSegments[3] === ''
  ) {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
  }

  return {
    contextId: decodePathSegment(rawSegments[1]),
    runId: decodePathSegment(rawSegments[2]),
    key: decodePathSegment(rawSegments[3]),
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
  if (identitySegments.some((segment) => segment.includes('**'))) {
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
 * @throws {Error} When the run id is not `rd_` plus 32 lowercase hex characters
 */
export function assertConcreteRunId(runId: string): void {
  validateConcreteRunId(runId);
}

/**
 * Test whether a decoded key segment is an exact artifact key — i.e. carries
 * no `*` or `?` glob characters. The full safe-id check is applied separately
 * by {@link validateExactArtifactKey}.
 *
 * @param key - Decoded key segment
 * @returns True when the key contains no glob characters
 */
function isExactArtifactKey(key: string): boolean {
  return !key.includes('*') && !key.includes('?');
}

/**
 * Validate an exact artifact key segment — the producer-surface key check.
 *
 * Reached from the `exact` branch of {@link parseArtifactUri} (where the key is
 * already glob-free by construction) and from {@link buildArtifactUri}, the
 * exact-URI producer builder. The glob guard is the live check for builder
 * callers: a glob key cannot address an exact producer artifact.
 *
 * @param key - Candidate exact artifact key segment
 * @throws {Error} If the key carries glob characters, or is otherwise unsafe
 *   ({@link assertSafeId})
 */
function validateExactArtifactKey(key: string): void {
  if (!isExactArtifactKey(key)) {
    throw new Error(ARTIFACT_ERROR_TEXT.GLOB_KEY_IN_EXACT_URI);
  }
  assertSafeId(key, 'ArtifactKey');
}

/**
 * Validate a selector artifact key segment.
 *
 * A selector key may be exact or carry `*`/`?` globs. Exact selector keys
 * additionally satisfy {@link assertSafeId}; wildcard selector keys satisfy
 * {@link SELECTOR_ARTIFACT_KEY_PATTERN}, which rejects path separators,
 * whitespace, and recursive `**`.
 *
 * @param key - Decoded key segment from a selector URI
 * @param runConcrete - Whether the run segment is concrete
 * @throws {Error} If the key fails both the exact and selector key checks
 */
function validateSelectorArtifactKey(key: string, runConcrete: boolean): void {
  void runConcrete;
  if (isExactArtifactKey(key)) {
    assertSafeId(key, 'ArtifactKey');
    return;
  }
  if (!SELECTOR_ARTIFACT_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid ArtifactKey: ${JSON.stringify(key)}`);
  }
}

/**
 * Parse the selector URI query string into a `Record<key, values>`.
 *
 * Supported keys (`status`, `runbook`, `source`, `latest`) are accepted as
 * documented in `docs/spec/uri.md` and `docs/spec/deferred.md`. Unsupported
 * keys are rejected at parse time.
 *
 * **Caveat — partial enforcement.** The supported keys are PARSED here but
 * are NOT YET enforced by {@link resolveSelector} in
 * `artifact-directive-resolver.ts`. The filtering implementation is deferred
 * to a later batch (see `docs/spec/deferred.md` "Selector URI query
 * parameters"). Until then, a URI that carries query params will be accepted
 * but will return unfiltered selector results.
 *
 * @param searchParams - Query string of an artifact URI as a URLSearchParams
 * @returns Parsed query map keyed by supported query parameter name
 * @throws {Error} When a query key outside the supported set is present
 */
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
