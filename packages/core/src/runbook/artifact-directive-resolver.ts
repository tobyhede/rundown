import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ArtifactDeclaration,
  ExactArtifactDeclaration,
  WildcardArtifactDeclaration,
} from '@rundown-org/parser';
import picomatch from 'picomatch';
import {
  appendArtifactManifestRecord,
  coalesceManifestRecords,
  isExistingRegularArtifactFile,
  readArtifactManifest,
  type ArtifactManifestRecord,
} from './artifact-manifest.js';
import type { ArtifactRecord } from './artifact-schema.js';
import { artifactUriToPath, buildArtifactUri, type ArtifactPathOptions } from './artifact-uri.js';
import type { RunbookRef } from './runbook-ref.js';
import { assertRunId, type RunId } from './run-id.js';
import type { ArtifactVarValue } from './types.js';

/**
 * Run eligibility for ARTIFACTS wildcard matching.
 *
 * Returned by `loadRunEligibility` ONLY for completed sibling runs (different
 * `runId` from the resolver's current run). The current run is short-circuited
 * inside the resolver before the loader is consulted, so there is no
 * `'current-run'` variant. Incomplete sibling runs are signalled by `null`.
 */
export interface ArtifactRunEligibility {
  /** Sibling completed run id, branded. */
  readonly runId: RunId;
  /** ISO-8601 timestamp at which the sibling run reached a terminal state. */
  readonly terminalAt: string;
}

/**
 * Options for resolving one ARTIFACTS block.
 */
export interface ResolveArtifactDeclarationsOptions extends ArtifactPathOptions {
  /** Current context identifier. */
  readonly contextId: string;
  /** Current run identifier. */
  readonly runId: RunId;
  /** Resolved runbook identity for the current run. */
  readonly runbook: RunbookRef;
  /** Clock used for newly-appended exact manifest records. */
  readonly now?: () => string;
  /**
   * Loads eligibility for non-current run ids found in the manifest. Return
   * `null` for incomplete or unknown sibling runs; return an
   * {@link ArtifactRunEligibility} for completed sibling runs. The resolver
   * never calls this loader with the current run's id.
   */
  readonly loadRunEligibility: (runId: RunId) => Promise<ArtifactRunEligibility | null>;
}

/**
 * Resolve a step/substep ARTIFACTS block.
 *
 * Exact declarations are processed before wildcard declarations regardless of
 * source order, so a same-block wildcard can match an artifact created by an
 * exact declaration in the same block. Exact declarations append or reuse
 * manifest records; wildcard declarations only read the manifest.
 *
 * Reads the manifest once up front and, when any exact declaration ran, once
 * again before wildcard resolution so wildcards observe same-block exact rows.
 *
 * @param declarations - Parser-owned artifact declarations from one execution unit
 * @param options - Current run identity, path options, clock, and run eligibility loader
 * @returns Artifact variable map for the current execution unit
 * @throws {Error} For corrupt manifests, invalid artifact records, invalid path options,
 *                 or unexpected filesystem failures
 */
export async function resolveArtifactDeclarations(
  declarations: readonly ArtifactDeclaration[],
  options: ResolveArtifactDeclarationsOptions,
): Promise<Record<string, ArtifactVarValue>> {
  const result: Record<string, ArtifactVarValue> = {};
  const exacts: ExactArtifactDeclaration[] = [];
  const wildcards: WildcardArtifactDeclaration[] = [];

  for (const declaration of declarations) {
    if (declaration.kind === 'exact') {
      exacts.push(declaration);
    } else {
      wildcards.push(declaration);
    }
  }

  let recordsForExacts = coalesceManifestRecords(
    await readArtifactManifest(options, options.contextId),
  );

  for (const declaration of exacts) {
    const record = await resolveExactDeclaration(declaration, options, recordsForExacts);
    result[declaration.name] = record;
    recordsForExacts = coalesceManifestRecords([...recordsForExacts, record]);
  }

  // The reread observes external concurrent manifest writes; that timing isn't
  // injectable through the resolver API, so the two branches are equivalent
  // under deterministic unit tests. See notes/mutation-survivors.md.
  const recordsForWildcards =
    exacts.length > 0
      ? coalesceManifestRecords(await readArtifactManifest(options, options.contextId))
      : recordsForExacts;

  // Memoize sibling-run eligibility for the duration of one resolve pass so
  // a manifest containing many records from the same sibling run only loads
  // that run's state once.
  const eligibilityCache = new Map<RunId, ArtifactRunEligibility | null>();

  for (const declaration of wildcards) {
    result[declaration.name] = await resolveWildcardDeclaration(
      declaration,
      options,
      recordsForWildcards,
      eligibilityCache,
    );
  }

  return result;
}

async function resolveExactDeclaration(
  declaration: ExactArtifactDeclaration,
  options: ResolveArtifactDeclarationsOptions,
  records: readonly ArtifactManifestRecord[],
): Promise<ArtifactRecord> {
  const existing = findExistingExactRecord(declaration.key, options, records);
  if (existing !== undefined) {
    await ensureArtifactParentDirectory(existing.uri, options);
    return existing;
  }

  const record: ArtifactRecord = {
    uri: buildArtifactUri({
      contextId: options.contextId,
      runId: options.runId,
      key: declaration.key,
    }),
    runId: options.runId,
    contextId: options.contextId,
    runbook: options.runbook,
    key: declaration.key,
    timestamp: options.now?.() ?? new Date().toISOString(),
  };
  await ensureArtifactParentDirectory(record.uri, options);
  await appendArtifactManifestRecord(options, record);
  return record;
}

function findExistingExactRecord(
  key: string,
  options: ResolveArtifactDeclarationsOptions,
  records: readonly ArtifactManifestRecord[],
): ArtifactManifestRecord | undefined {
  return records.find(
    (record) =>
      // Defense-in-depth: readArtifactManifest already rejects rows whose
      // contextId differs (artifact-manifest.ts readArtifactManifest). Kept
      // here so a refactor of the manifest reader cannot silently weaken
      // the resolver's identity check. See notes/mutation-survivors.md.
      record.contextId === options.contextId &&
      record.runId === options.runId &&
      record.runbook.source === options.runbook.source &&
      record.runbook.path === options.runbook.path &&
      record.key === key,
  );
}

async function resolveWildcardDeclaration(
  declaration: WildcardArtifactDeclaration,
  options: ResolveArtifactDeclarationsOptions,
  records: readonly ArtifactManifestRecord[],
  eligibilityCache: Map<RunId, ArtifactRunEligibility | null>,
): Promise<ArtifactRecord[]> {
  const matcher = picomatch(declaration.key, { dot: true });
  const matches: ArtifactRecord[] = [];

  for (const record of records) {
    // Defense-in-depth on contextId: readArtifactManifest already rejects
    // mismatched rows; this guard catches a contract weakening in the reader.
    // See notes/mutation-survivors.md.
    if (record.contextId !== options.contextId || !matcher(record.key)) {
      continue;
    }
    if (!(await isEligibleWildcardRecord(record, options, eligibilityCache))) {
      continue;
    }
    if (!isExistingRegularArtifactFile(record.uri, options)) {
      continue;
    }
    matches.push(record);
  }

  return matches.sort((left, right) => left.uri.localeCompare(right.uri));
}

async function isEligibleWildcardRecord(
  record: ArtifactManifestRecord,
  options: ResolveArtifactDeclarationsOptions,
  eligibilityCache: Map<RunId, ArtifactRunEligibility | null>,
): Promise<boolean> {
  if (record.runId === options.runId) {
    return true;
  }
  const runId = assertRunId(record.runId);
  let eligibility = eligibilityCache.get(runId);
  if (eligibility === undefined) {
    eligibility = await options.loadRunEligibility(runId);
    eligibilityCache.set(runId, eligibility);
  }
  // Validate the loader response: only accept rows whose eligibility record
  // refers back to the requested runId. Defends against a loader that
  // returns cached data for a different sibling run.
  return eligibility !== null && eligibility.runId === runId;
}

async function ensureArtifactParentDirectory(
  uri: string,
  options: ArtifactPathOptions,
): Promise<void> {
  const file = artifactUriToPath(uri, options);
  await fsp.mkdir(path.dirname(file), { recursive: true });
}
