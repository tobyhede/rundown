import {
  isArtifactValue,
  toPublicArtifactRecord,
  toPublicArtifactVarValue,
  type PublicArtifactRecord,
} from './artifact-schema.js';
import { readExactArtifactRecordFromManifest } from './artifact-inputs.js';
import type { ArtifactPathOptions } from './artifact-uri.js';
import { mergeEffectiveVars } from './effective-vars.js';
import type { RunbookState } from './types.js';

export type ArtifactAliasEntry = PublicArtifactRecord & {
  /** Artifact alias from the effective variable map. */
  readonly alias: string;
};

export interface ArtifactAliasArrayEntry {
  readonly alias: string;
  readonly items: readonly PublicArtifactRecord[];
}

export type ArtifactAliasListEntry = ArtifactAliasEntry | ArtifactAliasArrayEntry;

/**
 * List artifact aliases visible from a runbook state's effective variable map.
 *
 * @param state - Runbook state to inspect
 * @param options - Project root and work path for local path projection
 * @returns Public artifact projections keyed by alias
 */
export function listArtifactAliases(
  state: RunbookState,
  options: ArtifactPathOptions,
): ArtifactAliasListEntry[] {
  const entries: ArtifactAliasListEntry[] = [];
  for (const [alias, value] of Object.entries(mergeEffectiveVars(state))) {
    if (!isArtifactValue(value)) continue;
    const projected = toPublicArtifactVarValue(value, options);
    if (Array.isArray(projected)) {
      entries.push({ alias, items: projected as readonly PublicArtifactRecord[] });
    } else {
      entries.push({ alias, ...(projected as PublicArtifactRecord) });
    }
  }
  return entries;
}

/**
 * Resolve one artifact alias from a runbook state's effective variable map.
 *
 * @param state - Runbook state to inspect
 * @param alias - Artifact alias
 * @param options - Project root and work path for local path projection
 * @returns Public artifact projection for the alias, or null when absent
 */
export function getArtifactByAlias(
  state: RunbookState,
  alias: string,
  options: ArtifactPathOptions,
): ArtifactAliasListEntry | null {
  return listArtifactAliases(state, options).find((entry) => entry.alias === alias) ?? null;
}

/**
 * Project an alias or exact artifact URI to its local path-bearing public record.
 *
 * Exact URIs are resolved through the manifest to preserve provenance.
 *
 * @param state - Runbook state to inspect for aliases
 * @param aliasOrUri - Artifact alias or exact `rd://` URI
 * @param options - Project root and work path for local path projection
 * @returns Alias projection or manifest-backed public artifact record
 * @throws {Error} When the alias or exact URI cannot be resolved
 */
export async function projectArtifactPath(
  state: RunbookState,
  aliasOrUri: string,
  options: ArtifactPathOptions,
): Promise<ArtifactAliasListEntry | PublicArtifactRecord> {
  if (aliasOrUri.startsWith('rd://')) {
    return inspectArtifactReference(state, aliasOrUri, options);
  }
  const entry = getArtifactByAlias(state, aliasOrUri, options);
  if (!entry) throw new Error(`Artifact alias not found: ${aliasOrUri}`);
  return entry;
}

/**
 * Project an alias to its URI-bearing public record.
 *
 * @param state - Runbook state to inspect
 * @param alias - Artifact alias
 * @param options - Project root and work path for local path projection
 * @returns Alias projection including URI and path
 * @throws {Error} When the alias cannot be resolved
 */
export function projectArtifactUri(
  state: RunbookState,
  alias: string,
  options: ArtifactPathOptions,
): ArtifactAliasListEntry {
  const entry = getArtifactByAlias(state, alias, options);
  if (!entry) throw new Error(`Artifact alias not found: ${alias}`);
  return entry;
}

/**
 * Inspect an artifact alias or manifest-backed exact artifact URI.
 *
 * @param state - Runbook state to inspect for aliases
 * @param aliasOrUri - Artifact alias or exact `rd://` URI
 * @param options - Project root and work path for local path projection
 * @returns Alias projection or manifest-backed public artifact record
 * @throws {Error} When neither alias nor exact manifest-backed URI resolves
 */
export async function inspectArtifactReference(
  state: RunbookState,
  aliasOrUri: string,
  options: ArtifactPathOptions,
): Promise<ArtifactAliasListEntry | PublicArtifactRecord> {
  const aliasEntry = getArtifactByAlias(state, aliasOrUri, options);
  if (aliasEntry) return aliasEntry;
  if (!aliasOrUri.startsWith('rd://')) throw new Error(`Artifact alias not found: ${aliasOrUri}`);
  const record = await readExactArtifactRecordFromManifest(aliasOrUri, options);
  if (!record) throw new Error(`Artifact URI not found in manifest: ${aliasOrUri}`);
  return toPublicArtifactRecord(record, options);
}
