import { coalesceManifestRecords, readArtifactManifest } from './artifact-manifest.js';
import { ArtifactRecordSchema, type ArtifactRecord } from './artifact-schema.js';
import { parseArtifactUri, type ArtifactPathOptions } from './artifact-uri.js';

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
 */
export async function readExactArtifactRecordFromManifest(
  uri: string,
  options: ArtifactPathOptions,
): Promise<ArtifactRecord | null> {
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

  return row === undefined ? null : ArtifactRecordSchema.parse({ ...row, kind: 'artifact-record' });
}

/**
 * Read an all-or-nothing array of exact artifact records.
 *
 * @param values - Candidate exact artifact URI values
 * @param options - Artifact path options used to locate manifests
 * @returns Artifact records when every URI resolves, otherwise null
 */
export async function readExactArtifactRecordArrayFromManifest(
  values: readonly string[],
  options: ArtifactPathOptions,
): Promise<readonly ArtifactRecord[] | null> {
  if (values.length === 0) {
    return null;
  }

  const records: ArtifactRecord[] = [];
  for (const value of values) {
    const record = await readExactArtifactRecordFromManifest(value, options);
    if (record === null) {
      return null;
    }
    records.push(record);
  }
  return records;
}
