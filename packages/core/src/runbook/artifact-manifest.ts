import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import picomatch from 'picomatch';
import type { ZodIssue } from 'zod';
import { assertSafeId } from '../paths.js';
import { ARTIFACT_ERROR_TEXT, formatArtifactManifestLineError } from './artifact-errors.js';
import { ArtifactRecordSchema, type ArtifactRecord } from './artifact-schema.js';
import { artifactUriToPath, parseArtifactUri, type ArtifactPathOptions } from './artifact-uri.js';
import { RUNBOOK_REF_ERROR_TEXT } from './runbook-ref.js';

/**
 * Manifest row persisted for one exact artifact URI.
 */
export type ArtifactManifestRecord = ArtifactRecord;

/**
 * Artifact selector result paired with its resolved local file path and run terminal time.
 */
export interface ArtifactSelectorMatch {
  /** Validated manifest record that matched the selector. */
  readonly record: ArtifactManifestRecord;
  /** Absolute path for the artifact file on disk. */
  readonly path: string;
  /** Terminal timestamp loaded from the owning run state. */
  readonly terminalAt: string;
}

/**
 * Options for resolving artifact selectors against the context manifest and run state store.
 */
export interface FindArtifactOptions extends ArtifactPathOptions {
  /**
   * Load the lifecycle summary for a concrete run id.
   *
   * @param runId - Concrete run identifier from a manifest row
   * @returns Run lifecycle summary, or null when run state is absent
   */
  readonly loadRunState: (
    runId: string,
  ) => Promise<{ lifecycle?: string; terminalAt?: string } | null>;
}

/**
 * Build the absolute manifest path for a context-scoped artifact log.
 *
 * @param options - Project root and work directory options
 * @param contextId - Context identifier that owns the manifest
 * @returns Absolute path to `.rd-<ContextId>/manifest.jsonl`
 * @throws {Error} If the context id or work path is unsafe
 */
export function manifestPathForContext(options: ArtifactPathOptions, contextId: string): string {
  assertSafeId(contextId, 'contextId');

  const workRoot = resolveContainedWorkRoot(options);
  const manifestPath = path.resolve(workRoot, `.rd-${contextId}`, 'manifest.jsonl');
  assertContained(workRoot, manifestPath);
  return manifestPath;
}

/**
 * Append one validated artifact manifest record using a single JSONL write.
 *
 * The record is parsed with {@link ArtifactRecordSchema} before any path is
 * derived or file is created, so unsafe ids and URI mismatches fail without
 * mutating the manifest. This synchronous API is intended for production
 * template helpers and render paths. Concurrent append ordering is undefined;
 * callers must not depend on manifest file order.
 *
 * @param options - Project root and work directory options
 * @param record - Candidate artifact manifest record
 * @throws {Error} If validation fails or the append cannot be written
 */
export function appendArtifactManifestRecordSync(
  options: ArtifactPathOptions,
  record: unknown,
): void {
  const parsed = ArtifactRecordSchema.parse(record);
  const location = manifestLocationForContext(options, parsed.contextId);
  writeManifestLineSync(location.workRoot, location.manifestPath, parsed);
}

/**
 * Append one validated artifact manifest record using the sync append primitive.
 *
 * This async wrapper exists for tests and setup helpers only; template helpers
 * and render paths should call {@link appendArtifactManifestRecordSync}.
 *
 * @param options - Project root and work directory options
 * @param record - Candidate artifact manifest record
 * @returns Promise resolved after the record is appended
 * @throws {Error} If validation fails or the append cannot be written
 */
export async function appendArtifactManifestRecord(
  options: ArtifactPathOptions,
  record: unknown,
): Promise<void> {
  const parsed = ArtifactRecordSchema.parse(record);
  const location = manifestLocationForContext(options, parsed.contextId);
  writeManifestLineSync(location.workRoot, location.manifestPath, parsed);
}

/**
 * Read and validate all records from a context artifact manifest.
 *
 * Missing manifests, empty files, and whitespace-only files return an empty
 * array. Corrupted manifests throw a line-oriented error and never return
 * partial results.
 *
 * @param options - Project root and work directory options
 * @param contextId - Context identifier that owns the manifest
 * @returns Valid artifact manifest records in manifest order
 * @throws {Error} If any non-empty line is malformed or fails schema checks
 */
export async function readArtifactManifest(
  options: ArtifactPathOptions,
  contextId: string,
): Promise<ArtifactManifestRecord[]> {
  const { workRoot, manifestPath: file } = manifestLocationForContext(options, contextId);
  let content: string;
  try {
    assertNoSymlinkSegments(workRoot, path.dirname(file), { allowMissingTail: true });
    assertNoSymlinkSegments(workRoot, file, { allowMissingTail: false });
    content = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }

  if (content.trim() === '') {
    return [];
  }

  const records: ArtifactManifestRecord[] = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      continue;
    }
    const lineNumber = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(
        formatArtifactManifestLineError(
          file,
          lineNumber,
          ARTIFACT_ERROR_TEXT.INVALID_MANIFEST_JSON,
        ),
      );
    }

    const parsed = ArtifactRecordSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        formatArtifactManifestLineError(file, lineNumber, manifestRecordReason(parsed.error)),
      );
    }
    if (parsed.data.contextId !== contextId) {
      throw new Error(
        formatArtifactManifestLineError(
          file,
          lineNumber,
          ARTIFACT_ERROR_TEXT.INVALID_MANIFEST_RECORD,
        ),
      );
    }
    records.push(parsed.data);
  }

  return records;
}

/**
 * Coalesce repeated manifest rows by context, run, and artifact key.
 *
 * @param records - Manifest records to coalesce
 * @returns Records with duplicate identities reduced to the newest timestamp
 */
export function coalesceManifestRecords(
  records: readonly ArtifactManifestRecord[],
): ArtifactManifestRecord[] {
  const byIdentity = new Map<string, ArtifactManifestRecord>();
  for (const record of records) {
    const identity = `${record.contextId}\0${record.runId}\0${record.key}`;
    const existing = byIdentity.get(identity);
    if (existing === undefined || record.timestamp > existing.timestamp) {
      byIdentity.set(identity, record);
    }
  }
  return [...byIdentity.values()];
}

/**
 * Resolve an artifact selector URI to existing artifact files with run metadata.
 *
 * Exact artifact URIs are rejected; callers must pass a selector URI with a
 * wildcard run id or query string. By default only completed runs are returned.
 *
 * @param selectorUri - Artifact selector URI
 * @param options - Path resolution and run state loading options
 * @returns Matching artifacts sorted by canonical artifact URI
 * @throws {Error} If the selector is exact or the context manifest is corrupt
 */
export async function findArtifactMatches(
  selectorUri: string,
  options: FindArtifactOptions,
): Promise<ArtifactSelectorMatch[]> {
  const selector = parseArtifactUri(selectorUri);
  if (selector.kind === 'exact') {
    throw new Error(ARTIFACT_ERROR_TEXT.EXACT_URI_NOT_SELECTOR);
  }

  const records = coalesceManifestRecords(await readArtifactManifest(options, selector.contextId));
  const includeAnyStatus = selector.query.status?.includes('any') ?? false;
  const runbookFilters = selector.query.runbook ?? [];
  const sourceFilters = selector.query.source ?? [];
  const matches: ArtifactSelectorMatch[] = [];

  for (const record of records) {
    if (
      record.contextId !== selector.contextId ||
      record.key !== selector.key ||
      (selector.runId !== '*' && record.runId !== selector.runId) ||
      !matchesAnyRunbook(record.runbook.path, runbookFilters) ||
      !matchesAnySource(record.runbook.source, sourceFilters)
    ) {
      continue;
    }

    let artifactPath: string;
    try {
      artifactPath = artifactUriToPath(record.uri, options);
    } catch (error) {
      if (error instanceof Error && error.message === ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE) {
        continue;
      }
      throw error;
    }
    const workRoot = resolveContainedWorkRoot(options);
    if (!isExistingRegularContainedFile(workRoot, artifactPath)) {
      continue;
    }

    const runState = await options.loadRunState(record.runId);
    if (runState === null) {
      continue;
    }
    if (!includeAnyStatus && runState.lifecycle !== 'completed') {
      continue;
    }
    if (runState.terminalAt === undefined) {
      continue;
    }

    matches.push({
      record,
      path: artifactPath,
      terminalAt: runState.terminalAt,
    });
  }

  const latestMatches =
    selector.query.latest?.includes('true') === true ? latestByGroup(matches) : matches;

  return latestMatches.sort((left, right) => left.record.uri.localeCompare(right.record.uri));
}

function writeManifestLineSync(
  workRoot: string,
  manifestPath: string,
  record: ArtifactManifestRecord,
): void {
  assertNoSymlinkSegments(workRoot, path.dirname(manifestPath), { allowMissingTail: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  assertNoSymlinkSegments(workRoot, path.dirname(manifestPath), { allowMissingTail: false });
  assertNoSymlinkSegments(workRoot, manifestPath, { allowMissingTail: true });
  const noFollow = 'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
  const flags = fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | noFollow;
  const fd = fs.openSync(manifestPath, flags, 0o600);
  try {
    const line = Buffer.from(`${JSON.stringify(canonicalManifestRecord(record))}\n`, 'utf8');
    const bytesWritten = fs.writeSync(fd, line, 0, line.length);
    if (bytesWritten !== line.length) {
      throw new Error(`Incomplete artifact manifest write to ${manifestPath}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function manifestLocationForContext(
  options: ArtifactPathOptions,
  contextId: string,
): { readonly workRoot: string; readonly manifestPath: string } {
  assertSafeId(contextId, 'contextId');

  const workRoot = resolveContainedWorkRoot(options);
  const manifestPath = path.resolve(workRoot, `.rd-${contextId}`, 'manifest.jsonl');
  assertContained(workRoot, manifestPath);
  return { workRoot, manifestPath };
}

function resolveContainedWorkRoot(options: ArtifactPathOptions): string {
  if (path.isAbsolute(options.workPath)) {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
  }

  const cwdRoot = path.resolve(options.cwd);
  const workRoot = path.resolve(cwdRoot, options.workPath);
  assertContained(cwdRoot, workRoot);
  assertNoSymlinkSegments(cwdRoot, workRoot, { allowMissingTail: true });
  return workRoot;
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function assertNoSymlinkSegments(
  root: string,
  candidate: string,
  options: { readonly allowMissingTail: boolean },
): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  assertContained(resolvedRoot, resolvedCandidate);

  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === '') {
    return;
  }

  let current = resolvedRoot;
  const segments = relative.split(path.sep);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
      }
    } catch (error) {
      if (isNodeErrorCode(error, 'ENOENT') && options.allowMissingTail) {
        return;
      }
      throw error;
    }
  }
}

function isExistingRegularContainedFile(workRoot: string, filePath: string): boolean {
  try {
    assertNoSymlinkSegments(workRoot, filePath, { allowMissingTail: false });
    return fs.lstatSync(filePath).isFile();
  } catch (error) {
    if (
      isNodeErrorCode(error, 'ENOENT') ||
      (error instanceof Error && error.message === ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE)
    ) {
      return false;
    }
    throw error;
  }
}

function canonicalManifestRecord(record: ArtifactManifestRecord): ArtifactManifestRecord {
  return {
    uri: record.uri,
    runId: record.runId,
    contextId: record.contextId,
    runbook: record.runbook,
    key: record.key,
    timestamp: record.timestamp,
  };
}

function manifestRecordReason(error: { issues: readonly ZodIssue[] }): string {
  for (const issue of error.issues) {
    const message = issue.message;
    if (issue.code !== 'invalid_type' && isStableManifestReason(message)) {
      return message;
    }
  }
  return ARTIFACT_ERROR_TEXT.INVALID_MANIFEST_RECORD;
}

function isStableManifestReason(message: string): boolean {
  return (
    Object.values(ARTIFACT_ERROR_TEXT).includes(
      message as (typeof ARTIFACT_ERROR_TEXT)[keyof typeof ARTIFACT_ERROR_TEXT],
    ) ||
    message === RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF ||
    message.startsWith('Invalid contextId:') ||
    message.startsWith('Invalid runId:') ||
    message.startsWith('Invalid ArtifactKey:')
  );
}

function matchesAnyRunbook(pathValue: string, filters: readonly string[]): boolean {
  if (filters.length === 0) {
    return true;
  }
  return filters.some((filter) => picomatch.isMatch(pathValue, filter));
}

function matchesAnySource(source: string, filters: readonly string[]): boolean {
  return filters.length === 0 || filters.includes(source);
}

function latestByGroup(matches: readonly ArtifactSelectorMatch[]): ArtifactSelectorMatch[] {
  const byGroup = new Map<string, ArtifactSelectorMatch>();
  for (const match of matches) {
    const key = `${match.record.runbook.source}\0${match.record.runbook.path}\0${match.record.key}`;
    const existing = byGroup.get(key);
    if (
      existing === undefined ||
      match.terminalAt > existing.terminalAt ||
      (match.terminalAt === existing.terminalAt && match.record.runId > existing.record.runId)
    ) {
      byGroup.set(key, match);
    }
  }
  return [...byGroup.values()];
}
