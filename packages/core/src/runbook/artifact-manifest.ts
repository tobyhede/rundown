import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import picomatch from 'picomatch';
import type { z } from 'zod';
import { isNodeErrorCode } from '../errors.js';
import { assertSafeId } from '../paths.js';
import { ARTIFACT_ERROR_TEXT, formatArtifactManifestLineError } from './artifact-errors.js';
import {
  ArtifactManifestRecordSchema,
  type ArtifactManifestRecord as ArtifactManifestRow,
  type ArtifactRecord,
} from './artifact-schema.js';
import { artifactUriToPath, parseArtifactUri, type ArtifactPathOptions } from './artifact-uri.js';
import {
  acquireFileLock,
  acquireFileLockSync,
  releaseFileLock,
  releaseFileLockSync,
} from './file-lock.js';
import { RUNBOOK_REF_ERROR_TEXT } from './runbook-ref.js';

/**
 * In-memory artifact record loaded from a manifest row.
 *
 * Disk rows remain the documented six-field {@link ArtifactManifestRow} shape;
 * readers add the state discriminator after validation so resolver outputs can
 * still be persisted in runbook state.
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
 * The record is parsed with {@link ArtifactManifestRecordSchema} before any
 * path is derived or file is created, so unsafe ids and URI mismatches fail
 * without mutating the manifest.
 *
 * **Use in tests and single-process helpers only.** This path does not acquire
 * a cross-process file lock, so concurrent CLI processes writing to the same
 * manifest may produce duplicate rows. Production actor code must use the
 * async {@link appendArtifactManifestRecord}, which holds a file lock across
 * the idempotency check and the append.
 *
 * **Idempotency.** Two records are considered equivalent when they share
 * `(uri, contextId, runId, key, runbook.source, runbook.path)` — timestamps
 * are NOT part of equivalence. If the manifest already contains an
 * equivalent row, the write is skipped and the existing row's timestamp is
 * preserved as the canonical one. This is the fix for Issue 2: re-entries
 * through `__parent-entry::*` re-invoke the producer resolver on every
 * PASS / GOTO / RETRY / NEXT / BREAK traversal, and without write-layer
 * idempotency every traversal would multiply rows for the same identity.
 *
 * @param options - Project root and work directory options
 * @param record - Candidate artifact manifest record
 * @returns The canonical manifest record on disk after the call — either the
 *   newly appended row, or the pre-existing equivalent row when the write was
 *   skipped. The returned timestamp is therefore always the one persisted.
 * @throws {Error} If validation fails or the append cannot be written
 */
export function appendArtifactManifestRecordSync(
  options: ArtifactPathOptions,
  record: unknown,
): ArtifactManifestRow {
  const parsed = ArtifactManifestRecordSchema.parse(record);
  const location = manifestLocationForContext(options, parsed.contextId);
  const workRoot = location.workRoot;

  const locksDir = path.resolve(workRoot, '.rundown/locks');
  const lockFile = path.resolve(locksDir, `.rd-${parsed.contextId}.manifest.lock`);

  acquireFileLockSync(lockFile, locksDir);
  try {
    return writeManifestLineSync(workRoot, location.manifestPath, parsed);
  } finally {
    releaseFileLockSync(lockFile);
  }
}

/**
 * Append one validated artifact manifest record — the production path for actor code.
 *
 * Acquires a cross-process file lock for the duration of the append to ensure
 * concurrent CLI writer safety. The lock is held from the idempotency check
 * through the manifest write, preventing interleaved reads and writes that
 * could produce duplicate or corrupted rows.
 *
 * Idempotency semantics mirror {@link appendArtifactManifestRecordSync}.
 *
 * @param options - Project root and work directory options
 * @param record - Candidate artifact manifest record
 * @returns Promise resolved with the canonical manifest record on disk after the call
 * @throws {Error} If validation fails or the append cannot be written
 */
export async function appendArtifactManifestRecord(
  options: ArtifactPathOptions,
  record: unknown,
): Promise<ArtifactManifestRow> {
  const parsed = ArtifactManifestRecordSchema.parse(record);
  const location = manifestLocationForContext(options, parsed.contextId);
  const workRoot = location.workRoot;

  // Construct lock path: .rundown/locks/.rd-<contextId>.manifest.lock
  const locksDir = path.resolve(workRoot, '.rundown/locks');
  const lockFile = path.resolve(locksDir, `.rd-${parsed.contextId}.manifest.lock`);

  await acquireFileLock(lockFile, locksDir);
  try {
    return writeManifestLineSync(workRoot, location.manifestPath, parsed);
  } finally {
    await releaseFileLock(lockFile);
  }
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
    content = await readVerifiedUtf8File(workRoot, file);
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

    const parsed = ArtifactManifestRecordSchema.safeParse(value);
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
    records.push(toArtifactRecord(parsed.data));
  }

  return records;
}

/**
 * Coalesce repeated manifest rows by artifact identity.
 *
 * **Identity:** `(contextId, runId, runbook.source, runbook.path, key)`.
 *
 * **Selection rule:** the newest `timestamp` wins.
 *
 * **Tie-break rule:** when two rows share the same identity AND the same
 * timestamp, the row appearing LATER in the input order wins. This is
 * implemented by the `>=` comparison below (not `>`); equal timestamps
 * deliberately allow the later row to overwrite the earlier one. This rule
 * is observable to callers and stable: it lets a caller append a duplicate
 * identity row to the manifest and have the new row take precedence on the
 * next coalesced read.
 *
 * @param records - Manifest records to coalesce
 * @returns Records with duplicate identities reduced to the winning row
 */
export function coalesceManifestRecords(
  records: readonly ArtifactManifestRecord[],
): ArtifactManifestRecord[] {
  const byIdentity = new Map<string, ArtifactManifestRecord>();
  for (const record of records) {
    const identity = [
      record.contextId,
      record.runId,
      record.runbook.source,
      record.runbook.path,
      record.key,
    ].join('\0');
    const existing = byIdentity.get(identity);
    // `>=` (not `>`) implements the tie-break rule documented above:
    // equal timestamps allow the later row to overwrite the earlier one.
    if (existing === undefined || record.timestamp >= existing.timestamp) {
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

  const latestMatches = selector.query.latest?.includes('true') ? latestByGroup(matches) : matches;

  return latestMatches.sort((left, right) => left.record.uri.localeCompare(right.record.uri));
}

/**
 * Check whether an exact artifact URI resolves to an existing regular file
 * contained under the configured work root.
 *
 * Returns `false` for missing files, non-directories, symlinks, and invalid
 * artifact path shapes. Throws only for unexpected filesystem failures.
 *
 * @param uri - Exact artifact URI to check
 * @param options - Project root and work directory options
 * @returns `true` when the artifact is an existing contained regular file
 * @throws {Error} For unexpected filesystem failures while opening the file
 */
export function isExistingRegularArtifactFile(uri: string, options: ArtifactPathOptions): boolean {
  let artifactPath: string;
  try {
    artifactPath = artifactUriToPath(uri, options);
  } catch (error) {
    if (error instanceof Error && error.message === ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE) {
      return false;
    }
    throw error;
  }
  const workRoot = resolveContainedWorkRoot(options);
  return isExistingRegularContainedFile(workRoot, artifactPath);
}

function writeManifestLineSync(
  workRoot: string,
  manifestPath: string,
  record: ArtifactManifestRow,
): ArtifactManifestRow {
  const manifestDir = path.dirname(manifestPath);
  assertExistingAncestorsInsideRoot(workRoot, manifestDir);
  fs.mkdirSync(manifestDir, { recursive: true });
  assertVerifiedDirectoryInsideRoot(workRoot, manifestDir);

  // Idempotency check: skip the append when an equivalent row already
  // exists. Equivalence is `(uri, contextId, runId, key, runbook.source,
  // runbook.path)` — timestamps are not part of identity. The cost of the
  // read is irrelevant in production traffic: manifests stay small.
  const existing = findEquivalentManifestRow(workRoot, manifestPath, record);
  if (existing !== undefined) {
    return existing;
  }

  const flags =
    fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | noFollowFlag();
  const fd = fs.openSync(manifestPath, flags, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    validateOpenedPathInsideRoot(workRoot, manifestPath, stat);
    if (!stat.isFile()) {
      throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
    }
    const line = Buffer.from(`${JSON.stringify(canonicalManifestRecord(record))}\n`, 'utf8');
    const bytesWritten = fs.writeSync(fd, line, 0, line.length);
    if (bytesWritten !== line.length) {
      throw new Error(`Incomplete artifact manifest write to ${manifestPath}`);
    }
  } finally {
    fs.closeSync(fd);
  }
  return record;
}

/**
 * Read the manifest synchronously and return the first row whose identity
 * tuple `(uri, contextId, runId, key, runbook.source, runbook.path)` matches
 * `candidate`. Missing manifest files and empty manifests return `undefined`.
 *
 * Validation errors are intentionally NOT surfaced here: the production read
 * path ({@link readArtifactManifest}) is the canonical place to enforce
 * manifest invariants, and reusing its error reporting would couple a write
 * primitive to an async API. A malformed row is treated as "no equivalent
 * record"; the subsequent append will produce a manifest that the production
 * read path can still detect as corrupt.
 *
 * @param workRoot - Absolute, contained work root
 * @param manifestPath - Absolute manifest path inside `workRoot`
 * @param candidate - Validated manifest row whose identity is being looked up
 * @returns Matching existing row, or `undefined` when none exists
 * @throws {Error} Propagates unexpected filesystem errors (non-`ENOENT`)
 */
function findEquivalentManifestRow(
  workRoot: string,
  manifestPath: string,
  candidate: ArtifactManifestRow,
): ArtifactManifestRow | undefined {
  let content: string;
  try {
    content = readVerifiedUtf8FileSync(workRoot, manifestPath);
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }

  if (content.trim() === '') {
    return undefined;
  }

  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = ArtifactManifestRecordSchema.safeParse(value);
    if (!parsed.success) continue;
    if (isEquivalentManifestRow(parsed.data, candidate)) {
      return parsed.data;
    }
  }

  return undefined;
}

function isEquivalentManifestRow(left: ArtifactManifestRow, right: ArtifactManifestRow): boolean {
  return (
    left.uri === right.uri &&
    left.contextId === right.contextId &&
    left.runId === right.runId &&
    left.key === right.key &&
    left.runbook.source === right.runbook.source &&
    left.runbook.path === right.runbook.path
  );
}

function readVerifiedUtf8FileSync(workRoot: string, filePath: string): string {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const stat = fs.fstatSync(fd);
    validateOpenedPathInsideRoot(workRoot, filePath, stat);
    if (!stat.isFile()) {
      throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
    }
    return fs.readFileSync(fd, 'utf8');
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
  assertExistingAncestorsInsideRoot(cwdRoot, workRoot);
  if (fs.existsSync(workRoot)) {
    assertVerifiedDirectoryInsideRoot(cwdRoot, workRoot);
  }
  return workRoot;
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
  }
}

function assertExistingAncestorsInsideRoot(root: string, candidate: string): void {
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
      assertVerifiedDirectoryInsideRoot(resolvedRoot, current);
    } catch (error) {
      if (isNodeErrorCode(error, 'ENOENT')) {
        return;
      }
      throw error;
    }
  }
}

function isExistingRegularContainedFile(workRoot: string, filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openVerifiedRegularFileSync(workRoot, filePath, fs.constants.O_RDONLY | noFollowFlag());
    return true;
  } catch (error) {
    if (
      isNodeErrorCode(error, 'ENOENT') ||
      isNodeErrorCode(error, 'ENOTDIR') ||
      isNodeErrorCode(error, 'ELOOP') ||
      (error instanceof Error && error.message === ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE)
    ) {
      return false;
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

async function readVerifiedUtf8File(workRoot: string, filePath: string): Promise<string> {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const stat = await handle.stat();
    validateOpenedPathInsideRoot(workRoot, filePath, stat);
    if (!stat.isFile()) {
      throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function openVerifiedRegularFileSync(workRoot: string, filePath: string, flags: number): number {
  assertContained(path.resolve(workRoot), path.resolve(filePath));
  const fd = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(fd);
    validateOpenedPathInsideRoot(workRoot, filePath, stat);
    if (!stat.isFile()) {
      throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function assertVerifiedDirectoryInsideRoot(root: string, directoryPath: string): void {
  assertContained(path.resolve(root), path.resolve(directoryPath));
  let fd: number;
  try {
    fd = fs.openSync(directoryPath, fs.constants.O_RDONLY | directoryFlag() | noFollowFlag());
  } catch (error) {
    if (isNodeErrorCode(error, 'ELOOP') || isNodeErrorCode(error, 'ENOTDIR')) {
      throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    validateOpenedPathInsideRoot(root, directoryPath, stat);
    if (!stat.isDirectory()) {
      throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function validateOpenedPathInsideRoot(root: string, filePath: string, openedStat: fs.Stats): void {
  const rootRealPath = fs.realpathSync(root);
  const targetRealPath = fs.realpathSync(filePath);
  assertContained(rootRealPath, targetRealPath);

  const currentPathStat = fs.statSync(targetRealPath);
  if (!sameFile(openedStat, currentPathStat)) {
    throw new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
  }
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function noFollowFlag(): number {
  return 'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
}

function directoryFlag(): number {
  return 'O_DIRECTORY' in fs.constants ? fs.constants.O_DIRECTORY : 0;
}

function canonicalManifestRecord(record: ArtifactManifestRow): ArtifactManifestRow {
  return {
    uri: record.uri,
    runId: record.runId,
    contextId: record.contextId,
    runbook: record.runbook,
    key: record.key,
    timestamp: record.timestamp,
  };
}

function toArtifactRecord(record: ArtifactManifestRow): ArtifactRecord {
  return {
    kind: 'artifact-record',
    uri: record.uri,
    runId: record.runId,
    contextId: record.contextId,
    runbook: record.runbook,
    key: record.key,
    timestamp: record.timestamp,
  };
}

function manifestRecordReason(error: { issues: readonly z.core.$ZodIssue[] }): string {
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
