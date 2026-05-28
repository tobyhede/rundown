import { coalesceManifestRecords, readArtifactManifest } from './artifact-manifest.js';
import { ArtifactRecordSchema } from './artifact-schema.js';
import { parseArtifactUri, type ArtifactPathOptions } from './artifact-uri.js';
import {
  brandTrustedArtifactArray,
  brandTrustedArtifactRecord,
  type TrustedArtifactArray,
  type TrustedArtifactRecord,
} from './effective-vars.js';

/**
 * Parse a JSON string transport for artifact URI arrays.
 *
 * @param value - Candidate JSON string
 * @returns Parsed URI strings, or null when the string is not a URI-array transport
 */
export function parseJsonArtifactUriArrayTransport(value: string): readonly string[] | null {
  if (!value.trimStart().startsWith('[')) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  if (
    !parsed.every(
      (entry): entry is string => typeof entry === 'string' && entry.startsWith('rd://'),
    )
  ) {
    return null;
  }

  return parsed;
}

/**
 * Read one exact artifact record from the manifest named by the URI identity.
 *
 * @param uri - Exact `rd://artifacts/<context>/<run>/<key>` URI
 * @param options - Artifact path options used to locate the manifest
 * @returns The manifest-backed artifact record, or null when the URI is not exact or absent
 * @throws {Error} When the manifest cannot be read or the matching row cannot
 *   be parsed as an artifact record
 */
export async function readExactArtifactRecordFromManifest(
  uri: string,
  options: ArtifactPathOptions,
): Promise<TrustedArtifactRecord | null> {
  let ref: ReturnType<typeof parseArtifactUri>;
  try {
    ref = parseArtifactUri(uri);
  } catch {
    return null;
  }

  if (ref.kind !== 'exact') {
    return null;
  }

  const records = coalesceManifestRecords(await readArtifactManifest(options, ref.contextId));
  const row = records.find(
    (record) =>
      record.uri === uri &&
      record.contextId === ref.contextId &&
      record.runId === ref.runId &&
      record.key === ref.key,
  );

  if (row === undefined) {
    return null;
  }
  const parsed = ArtifactRecordSchema.parse({ ...row, kind: 'artifact-record' });
  return brandTrustedArtifactRecord(parsed);
}

/**
 * Read an all-or-nothing array of exact artifact records.
 *
 * @param values - Candidate exact artifact URI values
 * @param options - Artifact path options used to locate manifests
 * @returns Artifact records when every URI resolves, otherwise null
 * @throws {Error} When a manifest cannot be read or a matching row cannot be
 *   parsed as an artifact record
 */
export async function readExactArtifactRecordArrayFromManifest(
  values: readonly string[],
  options: ArtifactPathOptions,
): Promise<TrustedArtifactArray | null> {
  if (values.length === 0) {
    return null;
  }

  const records: TrustedArtifactRecord[] = [];
  for (const value of values) {
    const record = await readExactArtifactRecordFromManifest(value, options);
    if (record === null) {
      return null;
    }
    records.push(record);
  }
  // Brand the container too — a forged `[]` slipping through this reader's
  // result would otherwise be indistinguishable from a real zero-match
  // manifest read. Returning `null` for empty inputs above is the
  // existing contract; this brand path covers populated results only.
  return brandTrustedArtifactArray(records);
}
