import { WILDCARD_ARTIFACT_KEY_PATTERN, type ArtifactDeclaration } from '@rundown-org/parser';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import picomatch from 'picomatch';
import { SAFE_ID_PATTERN } from '../paths.js';
import {
  appendArtifactManifestRecord,
  coalesceManifestRecords,
  isExistingRegularArtifactFile,
  readArtifactManifest,
  type ArtifactManifestRecord,
} from './artifact-manifest.js';
import {
  ArtifactRecordSchema,
  isArtifactRecord,
  isArtifactValue,
  type ArtifactRecord,
  type FileArtifactRecord,
  type ArtifactManifestRecord as ArtifactManifestRow,
} from './artifact-schema.js';
import {
  artifactUriToPath,
  buildArtifactUri,
  parseArtifactUri,
  type ArtifactPathOptions,
  type ArtifactRef,
  type ExactArtifactRef,
  type SelectorArtifactRef,
} from './artifact-uri.js';
import type { RunbookRef } from './runbook-ref.js';
import type { RunId } from './run-id.js';
import type { ArtifactVarValue } from './types.js';
import { substituteText } from './template-renderer.js';

/**
 * In-scope variable map consulted for the naked-form ARTIFACTS assertion.
 *
 * Keys are variable names; values are the structured artifact values, URI
 * strings, URI string arrays, or JSON URI array strings the resolver may
 * rehydrate. The shape is
 * intentionally `unknown` so callers can pass merged effective vars (which
 * carry mixed string/object values from `templateVars` and `variables`
 * together) without an upfront cast.
 */
export type ArtifactScopeVars = Readonly<Record<string, unknown>>;

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
  /**
   * In-scope variables consulted by naked-form (`Plan`) declarations. Merged
   * effective vars (templateVars + variables) are typical. Optional —
   * naked-form declarations against an empty/absent scope produce an
   * `unbound` error.
   */
  readonly scopeVars?: ArtifactScopeVars;
  /**
   * Additional roots searched for relative file references after `cwd`.
   *
   * CLI callers supply plugin and bundled roots through the machine actor input
   * closure. The current project root (`cwd`) is always searched first.
   */
  readonly fileArtifactSearchRoots?: readonly string[];
  /**
   * Optional read-policy gate for explicit absolute file references.
   *
   * Relative project/plugin/bundled references are constrained to their source
   * roots; explicit absolute paths additionally require this callable to return
   * true.
   */
  readonly allowFileArtifactRead?: (filePath: string) => boolean;
}

/**
 * Resolve a step/substep ARTIFACTS block.
 *
 * Each declaration's `rawToken` is classified at resolve time:
 *
 * - **Bare key shortcut** — non-URI quoted token, e.g. `"plan.json"`. Per
 *   spec §10.1.1, this is syntactic sugar for an exact URI in the current
 *   context and current run. The resolver validates the key (no glob chars,
 *   matches `exact_artifact_key`), builds the exact URI, **appends a manifest
 *   row** for the producer identity tuple, and returns the resulting
 *   {@link ArtifactRecord}.
 * - **URI literal exact (current ctx + current run)** — `rawToken` parses
 *   as an exact URI whose `runId` equals the current run. Behaves identically
 *   to the bare-key form: appends a manifest row and returns the
 *   {@link ArtifactRecord}.
 * - **URI literal exact (current ctx + other run)** — read-only reference to
 *   an existing manifest row. The resolver looks up the identity-tuple match
 *   and returns it; missing rows produce a hard error (the URI references a
 *   row that does not exist; authors must use a selector to query absence).
 * - **URI literal selector** (`*` runId or query string) — read-only.
 *   Returns `ArtifactRecord` for one match, `ArtifactRecord[]` for many, or
 *   empty `[]` for none. Selectors have no opinion on arity.
 * - **URI literal cross-context** — hard error per spec §9 (cross-context
 *   flow is not supported).
 * - **Naked form** (`rawToken === null`) — assertion form (§10.1.2). Looks up
 *   `name` in `options.scopeVars`, validates the bound value is artifact-shaped
 *   (`ArtifactRecord`, `ArtifactRecord[]`, URI string, URI string array, or
 *   JSON URI array string), and
 *   resolves URI strings against the same-context manifest. Errors with named
 *   reasons (`unbound`, `not-an-artifact`, `unresolvable-uri`,
 *   `partial-resolve`). No manifest writes.
 *
 * Bare-key and exact-URI-current-run declarations are the producer surface
 * and create manifest entries. The directive does NOT write the artifact
 * file itself; the agent writes the file at the path mapped from the URI.
 *
 * @param declarations - Parser-owned artifact declarations from one execution unit
 * @param options - Current run identity and path options
 * @returns Artifact variable map for the current execution unit
 * @throws {Error} For corrupt manifests, naked-form assertion failures, malformed
 *   URI literals, cross-context URI literals, missing other-run manifest rows,
 *   invalid bare-key tokens, or unexpected filesystem failures
 */
export async function resolveArtifactDeclarations(
  declarations: readonly ArtifactDeclaration[],
  options: ResolveArtifactDeclarationsOptions,
): Promise<Record<string, ArtifactVarValue>> {
  const result: Record<string, ArtifactVarValue> = {};
  // Cache the coalesced manifest read once per resolve pass. Producer-side
  // writes invalidate the cache so subsequent reads observe the appended row.
  let cachedManifest: ArtifactManifestRecord[] | null = null;
  const readManifest = async (): Promise<ArtifactManifestRecord[]> => {
    cachedManifest ??= coalesceManifestRecords(
      await readArtifactManifest(options, options.contextId),
    );
    return cachedManifest;
  };
  const invalidateManifestCache = (): void => {
    cachedManifest = null;
  };

  for (const declaration of declarations) {
    if (declaration.rawToken === null) {
      result[declaration.name] = await resolveNakedDeclaration(
        declaration.name,
        options,
        readManifest,
      );
      continue;
    }

    const rawToken = expandArtifactToken(declaration, options);

    if (rawToken.startsWith('rd://')) {
      result[declaration.name] = await resolveUriLiteralDeclaration(
        declaration.name,
        rawToken,
        options,
        readManifest,
        invalidateManifestCache,
      );
      continue;
    }

    // Bare-key dispatch (spec §10.1.1):
    // - With glob characters (`*` or `?`) — selector form: read-only discovery
    //   across the current context and sibling runs. The exact_artifact_key
    //   character class (uri.md §5.3) explicitly excludes these characters,
    //   so a bare-key string carrying them cannot be an exact URI key — it
    //   MUST be classified as the selector form.
    // - Without glob characters — producer form: build the exact URI for the
    //   current context and current run, write a manifest row, return the
    //   resulting ArtifactRecord.
    // Templates MUST already be expanded by the caller.
    if (rawToken.includes('*') || rawToken.includes('?')) {
      validateBareKeyGlob(declaration.name, rawToken);
      const selector = buildImplicitBareKeySelector(rawToken, options.contextId);
      result[declaration.name] = resolveSelector(selector, options, await readManifest());
      continue;
    }

    // Dispatch gate: only path-like tokens are probed as file references.
    // Bare non-path tokens (no '/' or '\\', not absolute) flow straight to the
    // managed-artifact producer so that a same-named file at the search root
    // cannot silently shadow the producer intent (see issue: silent shadowing
    // of managed-artifact producer).
    if (isPathLikeArtifactToken(rawToken)) {
      const fileRecord = await resolveFileReferenceDeclaration(
        declaration.name,
        rawToken,
        options,
        invalidateManifestCache,
      );
      if (fileRecord !== null) {
        result[declaration.name] = fileRecord;
        continue;
      }
    }

    result[declaration.name] = await resolveBareKeyProducer(
      declaration.name,
      rawToken,
      options,
      invalidateManifestCache,
    );
  }

  return result;
}

async function resolveFileReferenceDeclaration(
  name: string,
  rawToken: string,
  options: ResolveArtifactDeclarationsOptions,
  invalidateManifestCache: () => void,
): Promise<FileArtifactRecord | null> {
  const candidate = await resolveExistingFileReference(rawToken, options);
  if (candidate === null) {
    if (isPathLikeArtifactToken(rawToken)) {
      throw new Error(
        `ARTIFACTS file reference "${rawToken}" for "${name}" was not found in the configured search path`,
      );
    }
    return null;
  }

  const record: FileArtifactRecord = {
    kind: 'file-artifact-record',
    uri: pathToFileURL(candidate).href,
    runId: options.runId,
    contextId: options.contextId,
    runbook: options.runbook,
    key: rawToken,
    timestamp: new Date().toISOString(),
  };
  await appendArtifactManifestRecord(options, record);
  invalidateManifestCache();
  return record;
}

async function resolveExistingFileReference(
  rawToken: string,
  options: ResolveArtifactDeclarationsOptions,
): Promise<string | null> {
  if (path.isAbsolute(rawToken)) {
    const canonical = await canonicalRegularFile(rawToken);
    if (canonical === null) return null;
    if (options.allowFileArtifactRead?.(canonical) !== true) {
      throw new Error(`ARTIFACTS absolute file reference "${rawToken}" is not allowed by policy`);
    }
    return canonical;
  }

  const roots = [options.cwd, ...(options.fileArtifactSearchRoots ?? [])];
  for (const root of roots) {
    const canonicalRoot = await canonicalDirectory(root);
    if (canonicalRoot === null) continue;
    const candidate = path.resolve(canonicalRoot, rawToken);
    const canonical = await canonicalRegularFile(candidate);
    if (canonical === null) continue;
    if (isPathInside(canonicalRoot, canonical)) {
      return canonical;
    }
  }

  return null;
}

function isPathLikeArtifactToken(rawToken: string): boolean {
  return path.isAbsolute(rawToken) || rawToken.includes('/') || rawToken.includes('\\');
}

async function canonicalDirectory(rawPath: string): Promise<string | null> {
  try {
    const canonical = await fsp.realpath(rawPath);
    const stat = await fsp.stat(canonical);
    return stat.isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

async function canonicalRegularFile(rawPath: string): Promise<string | null> {
  try {
    const canonical = await fsp.realpath(rawPath);
    const stat = await fsp.stat(canonical);
    return stat.isFile() ? canonical : null;
  } catch {
    return null;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function expandArtifactToken(
  declaration: ArtifactDeclaration,
  options: ResolveArtifactDeclarationsOptions,
): string {
  if (declaration.rawToken === null) {
    throw new Error(`ARTIFACTS declaration "${declaration.name}" has no quoted token to expand`);
  }
  return substituteText(declaration.rawToken, options.scopeVars ?? {}, undefined, {
    cwd: options.cwd,
  });
}

function toStateArtifactRecord(record: ArtifactManifestRow): ArtifactRecord {
  return ArtifactRecordSchema.parse({ kind: 'artifact-record', ...record });
}

/**
 * Build the implicit selector reference for a bare-key declaration that
 * carries glob characters (`*` or `?`).
 *
 * Per spec §10.1.1, a bare key with glob characters expands to a selector URI
 * targeting the current context, any run, and the original token as a key
 * glob: `rd://artifacts/<currentCtx>/*\/<rawToken>`. The selector pathway in
 * {@link resolveSelector} matches the `key` field of each record using
 * picomatch, so this helper just stitches together a {@link SelectorArtifactRef}
 * with the raw token as the key glob — there is no need to materialize the
 * URI string.
 *
 * @param rawToken - Bare-key token (post template expansion) carrying `*` or `?`
 * @param contextId - Current context identifier the selector is scoped to
 * @returns Selector reference suitable for {@link resolveSelector}
 */
function buildImplicitBareKeySelector(rawToken: string, contextId: string): SelectorArtifactRef {
  return {
    kind: 'selector',
    contextId,
    runId: '*',
    key: rawToken,
    query: {},
  };
}

/**
 * Validate a bare-key token that carries glob characters (`*` or `?`) before
 * it dispatches to the selector pathway.
 *
 * The parser used to enforce `wildcard_artifact_key` directly on these tokens
 * but has been relaxed; the resolver is now the gate. This helper restores
 * what the parser used to enforce — the token must match
 * {@link WILDCARD_ARTIFACT_KEY_PATTERN} (alphanumerics plus `.`, `_`, `-`,
 * `*`, `?`, with at least one wildcard character) and MUST NOT be the
 * recursive `**` form (per spec §10.1.1 / uri.md §5.3). Slashes and
 * traversal segments are rejected by virtue of the character class.
 *
 * @param name - Variable name being declared, used in error messages
 * @param rawToken - Bare-key token (post template expansion) carrying `*` or `?`
 * @throws {Error} When the token violates `wildcard_artifact_key`
 */
function validateBareKeyGlob(name: string, rawToken: string): void {
  // Reject recursive `**` explicitly. The wildcard pattern's character class
  // would otherwise admit the literal token `**`.
  if (rawToken.includes('**')) {
    throw new Error(
      `ARTIFACTS bare-key declaration "${name}" has invalid glob "${rawToken}"; recursive '**' is not permitted (spec §10.1.1 / uri.md §5.3)`,
    );
  }
  if (!WILDCARD_ARTIFACT_KEY_PATTERN.test(rawToken)) {
    throw new Error(
      `ARTIFACTS bare-key declaration "${name}" has invalid glob "${rawToken}"; keys must match wildcard_artifact_key (alphanumerics, '.', '_', '-', '*', '?'); slashes and traversal are forbidden`,
    );
  }
}

/**
 * Ensure the parent directory for an exact artifact URI exists on disk.
 *
 * Producer declarations (bare-key without glob, and exact URI literal for the
 * current ctx + current run) write a manifest row but do NOT write the
 * artifact file itself. The agent writes the file at the path mapped from
 * the URI, typically via shell redirection (`echo ... > {{ path Plan }}`).
 * Without an existing parent directory those redirections fail with ENOENT.
 *
 * Called BEFORE `appendArtifactManifestRecord` so a failing `mkdir` (e.g.
 * EACCES, ENOTDIR) does not leave an orphan manifest row pointing at an
 * unwritable directory.
 *
 * @param uri - Canonical exact artifact URI
 * @param options - Worktree path resolution options
 * @throws {Error} When the directory cannot be created (e.g. EACCES, ENOTDIR)
 */
async function ensureArtifactParentDir(uri: string, options: ArtifactPathOptions): Promise<void> {
  const filePath = artifactUriToPath(uri, options);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Resolve a bare-key declaration in producer form (no glob characters).
 *
 * Per spec §10.1.1, `Plan "plan.json"` is sugar for the exact URI in the
 * current context and current run. The resolver validates the key, builds
 * the URI, appends a manifest row, and returns the resulting record.
 *
 * The caller is responsible for ensuring `rawToken` does NOT contain glob
 * characters (`*`, `?`); bare keys with globs dispatch to the selector
 * pathway upstream and never reach this helper.
 *
 * @param name - Variable name being declared
 * @param rawToken - Bare-key token (post template expansion), no glob characters
 * @param options - Resolver options carrying current identity and path config
 * @param invalidateManifestCache - Invalidates the per-pass coalesced read cache
 * @returns The newly-written {@link ArtifactRecord}
 * @throws {Error} If the key fails `exact_artifact_key` validation
 */
async function resolveBareKeyProducer(
  name: string,
  rawToken: string,
  options: ResolveArtifactDeclarationsOptions,
  invalidateManifestCache: () => void,
): Promise<ArtifactRecord> {
  // Validate the key satisfies exact_artifact_key. SAFE_ID_PATTERN matches the
  // character class; `assertSafeId` would also reject `.` and `..` but rejects
  // other valid bare-key shapes when called via buildArtifactUri's helpers.
  // We validate here with a clearer error; buildArtifactUri's internal
  // validation acts as a defense-in-depth check.
  if (rawToken === '.' || rawToken === '..' || !SAFE_ID_PATTERN.test(rawToken)) {
    throw new Error(
      `ARTIFACTS bare-key declaration "${name}" has invalid key "${rawToken}"; keys must match exact_artifact_key (alphanumerics, '.', '_', '-')`,
    );
  }

  const uri = buildArtifactUri({
    contextId: options.contextId,
    runId: options.runId,
    key: rawToken,
  });
  // Ensure the parent directory exists so the agent can write the artifact
  // file via shell redirection. Must precede the manifest write so a failing
  // mkdir does not leave an orphan manifest row.
  await ensureArtifactParentDir(uri, options);
  const record: ArtifactRecord = {
    kind: 'artifact-record',
    uri,
    runId: options.runId,
    contextId: options.contextId,
    runbook: options.runbook,
    key: rawToken,
    timestamp: new Date().toISOString(),
  };
  const canonical = await appendArtifactManifestRecord(options, record);
  invalidateManifestCache();
  return toStateArtifactRecord(canonical);
}

/**
 * Resolve a URI literal declaration.
 *
 * Dispatches by URI form after parsing and the cross-context guard:
 *
 * - Exact, current ctx + current run: producer surface — append a manifest
 *   row and return the resulting record.
 * - Exact, current ctx + other run: read-only reference — return the
 *   matching manifest row, or hard error when no row exists.
 * - Selector: read-only — route through the shared selector pathway.
 *
 * @param name - Variable name being declared
 * @param rawToken - URI literal (post template expansion)
 * @param options - Resolver options carrying current identity and path config
 * @param readManifest - Lazy manifest snapshot loader
 * @param invalidateManifestCache - Invalidates the per-pass coalesced read cache
 * @returns Producer record (write branch), other-run record, or selector result
 * @throws {Error} For malformed URIs, cross-context URIs, or missing other-run rows
 */
async function resolveUriLiteralDeclaration(
  name: string,
  rawToken: string,
  options: ResolveArtifactDeclarationsOptions,
  readManifest: () => Promise<ArtifactManifestRecord[]>,
  invalidateManifestCache: () => void,
): Promise<ArtifactVarValue> {
  let ref: ArtifactRef;
  try {
    ref = parseArtifactUri(rawToken);
  } catch (error) {
    throw new Error(
      `ARTIFACTS URI literal "${rawToken}" for "${name}" is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Cross-context guard (uri.md §9). The manifest reader rejects cross-context
  // rows; surfacing the error here gives a clearer diagnostic than a quiet
  // "no match".
  if (ref.contextId !== options.contextId) {
    throw new Error(
      `ARTIFACTS URI literal targets context "${ref.contextId}" but the current context is "${options.contextId}"; cross-context flow is not supported`,
    );
  }

  if (ref.kind === 'exact') {
    return await resolveExactUriDeclaration(
      name,
      rawToken,
      ref,
      options,
      readManifest,
      invalidateManifestCache,
    );
  }

  return resolveSelector(ref, options, await readManifest());
}

/**
 * Resolve an exact URI literal declaration.
 *
 * When `ref.runId === options.runId`, this is the producer surface for an
 * already-canonical URI: append a manifest row and return the resulting
 * record. When `ref.runId` names a different run, this is a read-only
 * reference: look up the existing row and return it; error when no row
 * exists (the URI names a manifest entry that must already be present —
 * authors must use a selector to query absence).
 *
 * @param name - Variable name being declared
 * @param rawToken - The original URI literal, used in error messages
 * @param ref - Parsed exact artifact reference
 * @param options - Resolver options carrying current identity and path config
 * @param readManifest - Lazy manifest snapshot loader
 * @param invalidateManifestCache - Invalidates the per-pass coalesced read cache
 * @returns Producer record or other-run record from the manifest
 * @throws {Error} When an other-run URI has no matching manifest row
 */
async function resolveExactUriDeclaration(
  name: string,
  rawToken: string,
  ref: ExactArtifactRef,
  options: ResolveArtifactDeclarationsOptions,
  readManifest: () => Promise<ArtifactManifestRecord[]>,
  invalidateManifestCache: () => void,
): Promise<ArtifactRecord> {
  if (ref.runId === options.runId) {
    // Producer surface: write the manifest row using the URI's identity.
    // The URI was parsed and is canonical, so we can reuse it directly.
    // Ensure the parent directory exists so the agent can write the artifact
    // file via shell redirection. Must precede the manifest write so a failing
    // mkdir does not leave an orphan manifest row.
    await ensureArtifactParentDir(rawToken, options);
    const record: ArtifactRecord = {
      kind: 'artifact-record',
      uri: rawToken,
      runId: options.runId,
      contextId: options.contextId,
      runbook: options.runbook,
      key: ref.key,
      timestamp: new Date().toISOString(),
    };
    const canonical = await appendArtifactManifestRecord(options, record);
    invalidateManifestCache();
    return toStateArtifactRecord(canonical);
  }

  // Read-only reference to an other-run row. Look up by identity tuple and
  // gate through the file-existence check that selector matching also applies.
  const records = await readManifest();
  for (const candidate of records) {
    if (
      candidate.contextId === ref.contextId &&
      candidate.runId === ref.runId &&
      candidate.key === ref.key &&
      isExistingRegularArtifactFile(candidate.uri, options) &&
      isArtifactRecord(candidate)
    ) {
      return candidate;
    }
  }
  throw new Error(
    `ARTIFACTS URI literal "${rawToken}" for "${name}" references an other-run artifact that does not exist in the manifest; use a selector URI to query for absent artifacts`,
  );
}

/**
 * Resolve a selector against the manifest snapshot.
 *
 * Returns one {@link ArtifactRecord} when the selector yields exactly one
 * match, an array (possibly empty) otherwise. The same-context guard and the
 * per-row file-existence check are the active safety mechanisms for cross-run
 * results; selector matching does not filter on sibling-run lifecycle.
 *
 * **Deferred — selector query-string filtering.** `selector.query` is
 * currently parsed (status, runbook, source, latest) but IGNORED here. The
 * filtering implementation is deferred to a later batch; see
 * `docs/spec/deferred.md` "Selector URI query parameters" for the gating
 * criteria. Until that lands, selectors that carry query params will receive
 * the same unfiltered results as a bare selector — authors should NOT rely
 * on query-param filtering yet.
 *
 * @param selector - Selector reference (from URI literal selector form)
 * @param options - Current run identity and path options
 * @param records - Coalesced manifest snapshot for the current context
 * @returns Single matching record or array of matches (possibly empty)
 */
function resolveSelector(
  selector: SelectorArtifactRef,
  options: ResolveArtifactDeclarationsOptions,
  records: readonly ArtifactManifestRecord[],
): ArtifactVarValue {
  const matcher = picomatch(selector.key, { dot: true });
  const matches: ArtifactRecord[] = [];

  for (const record of records) {
    // Skip file-reference rows: their `key` is a declaration token (a path
    // fragment), not a content-addressable identifier, so it is not safe to
    // run through a picomatch selector. See `FileArtifactRecord.key` TSDoc.
    if (record.kind === 'file-artifact-record') continue;
    // Defense-in-depth on contextId: readArtifactManifest already rejects
    // mismatched rows; this guard catches a contract weakening in the reader.
    if (record.contextId !== selector.contextId) continue;
    if (selector.runId !== '*' && record.runId !== selector.runId) continue;
    if (!matcher(record.key)) continue;
    if (!isExistingRegularArtifactFile(record.uri, options)) continue;
    matches.push(record);
  }

  matches.sort((left, right) => left.uri.localeCompare(right.uri));

  if (matches.length === 1) {
    return matches[0];
  }
  return matches;
}

/**
 * Resolve a naked-form declaration (assertion that `name` is bound in scope).
 *
 * Per spec §10.1.2, the bound value MUST be one of:
 * - `ArtifactRecord` — validated same-context and emitted as-is.
 * - `ArtifactRecord[]` — validated same-context and emitted as a copy.
 * - URI string (`rd://...`) — resolved against the same-context manifest.
 * - URI string array — each URI resolved; all-or-nothing.
 * - JSON URI array string — decoded only when every entry is an `rd://` URI
 *   string, then resolved as a URI string array.
 *
 * @param name - Variable name to look up in `options.scopeVars`
 * @param options - Resolver options carrying `scopeVars` and manifest context
 * @param readManifest - Lazy manifest loader, called only when URI rehydration is needed
 * @returns Validated/rehydrated artifact value
 * @throws {Error} With a named reason: `unbound`, `not-an-artifact`, `unresolvable-uri`, or `partial-resolve`
 */
async function resolveNakedDeclaration(
  name: string,
  options: ResolveArtifactDeclarationsOptions,
  readManifest: () => Promise<ArtifactManifestRecord[]>,
): Promise<ArtifactVarValue> {
  const scope = options.scopeVars;
  if (scope === undefined || !(name in scope)) {
    throw new Error(`unbound: ARTIFACTS declaration "${name}" is not bound in scope`);
  }
  const value = scope[name];

  if (isArtifactValue(value)) {
    if (isArtifactRecord(value)) {
      assertSameContextRecord(name, value, options.contextId);
      return value;
    }
    for (const record of value) {
      assertSameContextRecord(name, record, options.contextId);
    }
    return [...value];
  }

  // URI string or JSON URI[] string transport — resolve via manifest.
  if (typeof value === 'string') {
    const uriArray = parseJsonArtifactUriArrayTransport(value);
    if (uriArray !== null) {
      return resolveUriStringArray(name, uriArray, options, await readManifest());
    }
    return resolveUriString(name, value, options, await readManifest());
  }

  // URI[] — each entry must resolve; all-or-nothing.
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')) {
    return resolveUriStringArray(name, value, options, await readManifest());
  }

  throw new Error(
    `not-an-artifact: ARTIFACTS naked declaration "${name}" is not artifact-shaped (expected ArtifactRecord, ArtifactRecord[], URI string, URI string[], or JSON URI[] string)`,
  );
}

function assertSameContextRecord(name: string, record: ArtifactRecord, contextId: string): void {
  if (record.contextId !== contextId) {
    throw new Error(
      `ARTIFACTS naked declaration "${name}" targets context "${record.contextId}" but the current context is "${contextId}"; cross-context flow is not supported`,
    );
  }
}

function parseJsonArtifactUriArrayTransport(value: string): readonly string[] | null {
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

function resolveUriString(
  name: string,
  uri: string,
  options: ResolveArtifactDeclarationsOptions,
  records: readonly ArtifactManifestRecord[],
): ArtifactVarValue {
  const resolved = resolveSingleUriAgainstManifest(uri, options, records);
  // Per spec §10.1.2: `unresolvable-uri` covers both "did not parse" (null)
  // and "parsed but matched no manifest row" (empty array). Naked-form
  // resolution is all-or-nothing, so an empty result is an error here.
  if (resolved === null || resolved.length === 0) {
    throw new Error(
      `unresolvable-uri: ARTIFACTS naked declaration "${name}" URI "${uri}" did not parse or matched no manifest row`,
    );
  }
  // Return one record when the resolver matched exactly one; otherwise the
  // array (which spec §10.1.2 emits as ArtifactRecord[]).
  return resolved.length === 1 ? resolved[0] : [...resolved];
}

function resolveUriStringArray(
  name: string,
  uris: readonly string[],
  options: ResolveArtifactDeclarationsOptions,
  records: readonly ArtifactManifestRecord[],
): ArtifactRecord[] {
  const resolved: ArtifactRecord[] = [];
  for (const uri of uris) {
    const matches = resolveSingleUriAgainstManifest(uri, options, records);
    if (matches === null || matches.length === 0) {
      throw new Error(
        `partial-resolve: ARTIFACTS naked declaration "${name}" URI "${uri}" did not resolve; URI[] resolution is all-or-nothing`,
      );
    }
    for (const match of matches) {
      resolved.push(match);
    }
  }
  return resolved;
}

/**
 * Resolve a single URI string against the manifest snapshot.
 *
 * Returns `null` when the URI is malformed or names a context other than the
 * resolver's current context. Returns the matching records (possibly empty)
 * otherwise. The caller maps `null` and `[]` into the appropriate named
 * error per spec §10.1.2.
 *
 * @param uri - URI string to resolve
 * @param options - Resolver options carrying current context identity
 * @param records - Coalesced manifest snapshot for the current context
 * @returns Matching records, or `null` when the URI is malformed or cross-context
 */
function resolveSingleUriAgainstManifest(
  uri: string,
  options: ResolveArtifactDeclarationsOptions,
  records: readonly ArtifactManifestRecord[],
): ArtifactRecord[] | null {
  let ref: ArtifactRef;
  try {
    ref = parseArtifactUri(uri);
  } catch {
    return null;
  }
  if (ref.contextId !== options.contextId) {
    return null;
  }
  if (ref.kind === 'exact') {
    // Find the record by exact identity (contextId, runId, key) and gate
    // through the file-existence check that selector matching also applies.
    for (const record of records) {
      if (
        record.contextId === ref.contextId &&
        record.runId === ref.runId &&
        record.key === ref.key &&
        isExistingRegularArtifactFile(record.uri, options) &&
        isArtifactRecord(record)
      ) {
        return [record];
      }
    }
    return [];
  }
  // Selector form — dispatch through the shared selector pathway.
  const selector: SelectorArtifactRef = {
    kind: 'selector',
    contextId: ref.contextId,
    runId: ref.runId,
    key: ref.key,
    query: ref.query,
  };
  const result = resolveSelector(selector, options, records);
  if (Array.isArray(result)) {
    return [...(result as readonly ArtifactRecord[])];
  }
  return [ArtifactRecordSchema.parse(result)];
}
