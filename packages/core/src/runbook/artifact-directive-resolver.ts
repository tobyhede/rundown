import {
  classifyExpandedArtifactToken,
  formatArtifactTokenRejectReason,
  type ArtifactDeclaration,
  type ParsedArtifactToken,
} from '@rundown-org/parser';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import picomatch from 'picomatch';
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
  type ArtifactRecord,
  type FileArtifactRecord,
  type ArtifactManifestRecord as ArtifactManifestRow,
  type ManagedArtifactManifestRecord,
} from './artifact-schema.js';
import {
  brandTrustedArtifactArray,
  brandTrustedArtifactRecord,
  isTrustedArtifactArray,
  isTrustedArtifactRecord,
  isTrustedArtifactValue,
  type TrustedArtifactArray,
  type TrustedArtifactRecord,
  type TrustedArtifactValue,
} from './effective-vars.js';
import {
  artifactUriToPath,
  parseArtifactUri,
  type ArtifactPathOptions,
  type ArtifactRef,
  type ExactArtifactRef,
  type SelectorArtifactRef,
} from './artifact-uri.js';
import { parseJsonArtifactUriArrayTransport } from './artifact-inputs.js';
import type { RunbookRef } from './runbook-ref.js';
import type { RunId } from './run-id.js';
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
 * Each quoted declaration token is expanded once, classified with the
 * parser-owned ARTIFACTS token classifier, then dispatched by token kind:
 *
 * - **Shorthand** — non-URI, non-path quoted token, e.g. `"plan.json"` or
 *   `"review-*.json"`, optionally with a leading cross-run prefix (an asterisk
 *   then a slash). Per spec §10.1.1, a shorthand token is sugar for an
 *   `rd://artifacts/` URI: the context segment defaults to the current
 *   context; the run segment is the current run (`runScope: 'current'`) or the
 *   selector wildcard `*` (`runScope: 'any'`, set by the cross-run prefix).
 *   The resolver builds the URI and routes it through the same code path as a
 *   `rd://` URI literal. An exact key with the current run produces (appends a
 *   manifest row); a wildcard key or the cross-run prefix queries read-only.
 * - **URI literal exact (current ctx + current run)** — `rawToken` parses
 *   as an exact URI whose `runId` equals the current run. Behaves identically
 *   to the shorthand producer form: appends a manifest row and returns the
 *   {@link ArtifactRecord}.
 * - **URI literal exact (current ctx + other run)** — read-only reference to
 *   an existing manifest row. The resolver looks up the identity-tuple match
 *   and returns it; missing rows produce a hard error (the URI references a
 *   row that does not exist; authors must use a selector to query absence).
 * - **URI literal selector** (`*` runId or query string) — read-only.
 *   Returns `ArtifactRecord` for one match, `ArtifactRecord[]` for many, or
 *   empty `[]` for none. Selectors have no opinion on arity.
 * - **URI literal cross-context** — hard error for keyed declarations.
 *   Cross-context handoff uses trusted variable inputs that are rehydrated
 *   from the source context manifest before naked-form validation.
 * - **Naked form** (`rawToken === null`) — assertion form (§10.1.2). Looks up
 *   `name` in `options.scopeVars`, validates the bound value is artifact-shaped
 *   (`ArtifactRecord`, `ArtifactRecord[]`, URI string, URI string array, or
 *   JSON URI array string). Structured records are accepted as already
 *   provenance-checked values; URI strings resolve against the same-context
 *   manifest. Errors with named reasons (`unbound`, `not-an-artifact`, `unresolvable-uri`,
 *   `partial-resolve`). No manifest writes.
 *
 * Shorthand exact-key-current-run and exact-URI-current-run declarations are
 * the producer surface and create manifest entries. The directive does NOT
 * write the artifact file itself; the agent writes the file at the path
 * mapped from the URI.
 *
 * @param declarations - Parser-owned artifact declarations from one execution unit
 * @param options - Current run identity and path options
 * @returns Artifact variable map for the current execution unit
 * @throws {Error} For corrupt manifests, naked-form assertion failures, malformed
 *   URI literals, cross-context URI literals, missing other-run manifest rows,
 *   invalid classified tokens, or unexpected filesystem failures
 */
export async function resolveArtifactDeclarations(
  declarations: readonly ArtifactDeclaration[],
  options: ResolveArtifactDeclarationsOptions,
): Promise<Record<string, TrustedArtifactValue>> {
  const result: Record<string, TrustedArtifactValue> = {};
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
    const classification = classifyExpandedArtifactToken(rawToken);
    if (!classification.ok) {
      throw new Error(
        `ARTIFACTS declaration "${declaration.name}" has invalid token "${rawToken}": ${formatArtifactTokenRejectReason(classification.reason)}`,
      );
    }

    switch (classification.token.kind) {
      case 'rd-uri':
        result[declaration.name] = await resolveUriLiteralDeclaration(
          declaration.name,
          classification.token.uri,
          options,
          readManifest,
          invalidateManifestCache,
        );
        break;
      case 'shorthand': {
        // A shorthand token is sugar for an `rd://artifacts/` URI. Build the
        // URI and route it through the single URI-literal code path:
        // `runScope: 'current'` + exact key parses as an exact producer URI;
        // a wildcard key or `runScope: 'any'` parses as a selector URI.
        const uri = buildShorthandUri(classification.token, options);
        result[declaration.name] = await resolveUriLiteralDeclaration(
          declaration.name,
          uri,
          options,
          readManifest,
          invalidateManifestCache,
        );
        break;
      }
      case 'abs-path':
      case 'rel-path': {
        const fileRecord = await resolveFileReferenceDeclaration(
          declaration.name,
          classification.token,
          options,
          invalidateManifestCache,
        );
        result[declaration.name] = fileRecord;
        break;
      }
    }
  }

  return result;
}

async function resolveFileReferenceDeclaration(
  name: string,
  token: Extract<ParsedArtifactToken, { kind: 'abs-path' | 'rel-path' }>,
  options: ResolveArtifactDeclarationsOptions,
  invalidateManifestCache: () => void,
): Promise<TrustedArtifactRecord> {
  const candidate = await resolveExistingFileReference(token, options);
  if (candidate === null) {
    throw new Error(
      `ARTIFACTS file reference "${token.path}" for "${name}" was not found in the configured search path`,
    );
  }

  const record: FileArtifactRecord = {
    kind: 'file-artifact-record',
    uri: pathToFileURL(candidate).href,
    runId: options.runId,
    contextId: options.contextId,
    runbook: options.runbook,
    key: token.path,
    timestamp: new Date().toISOString(),
  };
  await appendArtifactManifestRecord(options, record);
  invalidateManifestCache();
  return brandTrustedArtifactRecord(record);
}

async function resolveExistingFileReference(
  token: Extract<ParsedArtifactToken, { kind: 'abs-path' | 'rel-path' }>,
  options: ResolveArtifactDeclarationsOptions,
): Promise<string | null> {
  if (token.kind === 'abs-path') {
    if (!path.isAbsolute(token.path)) {
      throw new Error(
        `ARTIFACTS absolute file reference "${token.path}" uses unsupported absolute path syntax for this platform`,
      );
    }
    const canonical = await canonicalRegularFile(token.path);
    if (canonical === null) return null;
    if (options.allowFileArtifactRead?.(canonical) !== true) {
      throw new Error(`ARTIFACTS absolute file reference "${token.path}" is not allowed by policy`);
    }
    return canonical;
  }

  const roots = [options.cwd, ...(options.fileArtifactSearchRoots ?? [])];
  for (const root of roots) {
    const canonicalRoot = await canonicalDirectory(root);
    if (canonicalRoot === null) continue;
    const candidate = path.resolve(canonicalRoot, token.path);
    const canonical = await canonicalRegularFile(candidate);
    if (canonical === null) continue;
    if (isPathInside(canonicalRoot, canonical)) {
      return canonical;
    }
  }

  return null;
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
    context: {
      kind: 'runnable',
      cwd: options.cwd,
      workPath: options.workPath,
      contextId: options.contextId,
      runId: options.runId,
    },
  });
}

/**
 * Branch on the manifest union and project a managed row into a state
 * record. Producer call sites construct a managed `ArtifactRecord` and
 * write it through {@link appendArtifactManifestRecord}, which returns the
 * canonical row typed as the broader `ArtifactManifestRow` union. Receiving
 * a file-artifact row on a producer path indicates a manifest invariant
 * violation; throw a clear error rather than silently produce a malformed
 * state record.
 *
 * @param row - Canonical manifest row returned from append
 * @param declarationName - Variable name driving the producer call, for diagnostics
 * @returns Tagged state artifact record
 * @throws {Error} If the manifest returned a file-artifact row on a producer path
 */
function projectManagedManifestRow(
  row: ArtifactManifestRow,
  declarationName: string,
): ArtifactRecord {
  // The manifest union narrows on the presence of `kind`: managed rows have
  // no `kind` field, file-artifact rows carry `kind: 'file-artifact-record'`.
  if ('kind' in row) {
    throw new Error(
      `ARTIFACTS producer for "${declarationName}" received an unexpected file-artifact manifest row; managed-artifact identity expected`,
    );
  }
  return toStateArtifactRecord(row);
}

/**
 * Project a managed manifest row into a tagged state artifact record.
 *
 * Manifest rows for managed artifacts carry the six-field shape without a
 * `kind` discriminator (see {@link ManagedArtifactManifestRecord}); state
 * records add `kind: 'artifact-record'`. File-artifact manifest rows
 * already carry `kind: 'file-artifact-record'` and MUST NOT be passed
 * through here — call sites handle them directly as the file record kind.
 *
 * The function tightens its parameter to `ManagedArtifactManifestRecord` and
 * adds a runtime guard rejecting any input that carries a `kind` field. The
 * type narrows compile-time risk; the guard defends against unchecked
 * casts and silent contract violations at runtime (belt and braces).
 *
 * @param record - Managed manifest row without a `kind` discriminator
 * @returns Tagged state artifact record with `kind: 'artifact-record'`
 * @throws {Error} When the input carries a `kind` field (indicates a
 *   call-site bug — file rows must not reach this projection)
 * @throws {z.ZodError} When the constructed record fails schema validation
 */
export function toStateArtifactRecord(record: ManagedArtifactManifestRecord): ArtifactRecord {
  if ('kind' in record && (record as { kind?: unknown }).kind !== undefined) {
    throw new Error(
      `toStateArtifactRecord expected a managed manifest row without 'kind', got kind=${String((record as { kind: unknown }).kind)}`,
    );
  }
  return ArtifactRecordSchema.parse({ kind: 'artifact-record', ...record });
}

/**
 * Build the canonical `rd://artifacts/` URI string for a shorthand ARTIFACTS
 * token.
 *
 * Per spec §10.1.1, a shorthand token is sugar for an artifact URI: the
 * context segment defaults to the current `ContextId`; the run segment is the
 * current `RunId` when `runScope` is `current`, or the selector wildcard `*`
 * when `runScope` is `any`. The key is the shorthand key, which may be exact
 * (producer or current-run query) or carry `*`/`?` globs (selector).
 *
 * Each segment is percent-encoded with {@link encodeURIComponent}. Encoding
 * the key is required, not optional: a literal `?` in a wildcard key would
 * otherwise be parsed as the URI query-string delimiter. The run segment `*`
 * is intentionally NOT encoded — it is the selector wildcard, a structural URI
 * token, not data.
 *
 * @param token - Shorthand classified token carrying `key` and `runScope`
 * @param options - Resolver options carrying the current context and run id
 * @returns Canonical `rd://artifacts/` URI string for the shorthand
 */
function buildShorthandUri(
  token: Extract<ParsedArtifactToken, { kind: 'shorthand' }>,
  options: ResolveArtifactDeclarationsOptions,
): string {
  const contextSegment = encodeURIComponent(options.contextId);
  const runSegment = token.runScope === 'any' ? '*' : encodeURIComponent(options.runId);
  const keySegment = encodeURIComponent(token.key);
  return `rd://artifacts/${contextSegment}/${runSegment}/${keySegment}`;
}

/**
 * Ensure the parent directory for an exact artifact URI exists on disk.
 *
 * Producer declarations (shorthand without glob or cross-run prefix, and exact
 * URI literal for the current ctx + current run) write a manifest row but do
 * NOT write the artifact file itself. The agent writes the file at the path
 * mapped from the URI, typically via shell redirection
 * (`echo ... > {{ path Plan }}`).
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
): Promise<TrustedArtifactValue> {
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
): Promise<TrustedArtifactRecord> {
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
    return brandTrustedArtifactRecord(projectManagedManifestRow(canonical, name));
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
      candidate.kind === 'artifact-record'
    ) {
      return brandTrustedArtifactRecord(candidate);
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
): TrustedArtifactValue {
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
    return brandTrustedArtifactRecord(matches[0]);
  }
  // brandTrustedArtifactArray brands the container AND every element.
  // It MUST also be applied to the empty-array case (zero-match selector
  // result) — otherwise the consumer's container-brand check rejects what
  // is a legitimate trusted outcome. There is no `matches.length === 0`
  // early-return above for selectors, but if the surrounding code adds
  // one, route it through brandTrustedArtifactArray([]) explicitly.
  return brandTrustedArtifactArray(matches);
}

/**
 * Resolve a naked-form declaration (assertion that `name` is bound in scope).
 *
 * Per spec §10.1.2, the bound value MUST be one of:
 * - `ArtifactRecord` — accepted as a provenance-checked value and emitted as-is.
 * - `ArtifactRecord[]` — accepted as provenance-checked values and emitted as a copy.
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
): Promise<TrustedArtifactValue> {
  const scope = options.scopeVars;
  if (scope === undefined || !(name in scope)) {
    throw new Error(`unbound: ARTIFACTS declaration "${name}" is not bound in scope`);
  }
  const value = scope[name];

  if (isTrustedArtifactValue(value)) {
    // Return the trusted value BY REFERENCE so the container/record brand
    // survives. Spreading (`[...value]`) into a new array would copy the
    // element references but lose the container brand — that would force the
    // consumer to re-brand, and re-branding outside a sanctioned producer is
    // exactly what Option D forbids. Returning the same reference is safe
    // because TrustedArtifactValue is readonly at the type level.
    return value;
  }

  // Reject artifact-shaped objects that didn't come from a sanctioned
  // producer. Naked-form trust is provenance-based: a forged ArtifactRecord
  // (or an array of artifact-shaped records that lacks the container brand)
  // sitting in scopeVars must NOT slip through. URI-string rehydration
  // (below) re-mints the brand via the manifest reader.
  if (
    isArtifactRecord(value) ||
    (Array.isArray(value) && value.length > 0 && value.every(isArtifactRecord))
  ) {
    throw new Error(
      `not-an-artifact: ARTIFACTS naked declaration "${name}" carries an unverified artifact-shaped value; pass an artifact URI so Rundown can resolve it.`,
    );
  }

  // URI string or JSON URI[] string transport — resolve via manifest.
  if (typeof value === 'string') {
    const uriArray = parseJsonArtifactUriArrayTransport(value);
    if (uriArray !== null) {
      if (uriArray.length === 0) {
        throw new Error(
          `not-an-artifact: ARTIFACTS naked declaration "${name}" is not artifact-shaped (expected ArtifactRecord, ArtifactRecord[], URI string, URI string[], or JSON URI[] string)`,
        );
      }
      return resolveUriStringArray(name, uriArray, options, await readManifest());
    }
    return resolveUriString(name, value, options, await readManifest());
  }

  // URI[] — each entry must resolve; all-or-nothing. The `value.length > 0`
  // guard is load-bearing: `[].every(isString)` is vacuously true, so a
  // forged `--input-json X='[]'` would otherwise reach resolveUriStringArray
  // and be minted as a branded empty trusted array (the producer brands every
  // container, including empty ones). The naked declaration's URI-string-array
  // transport requires at least one URI to be present; an empty array is not an
  // artifact value here. It falls through to the bottom `not-an-artifact`
  // throw, which is correct — a legitimate zero-match selector result reaches
  // resolveNakedDeclaration via the structured branch above (already
  // container-branded via resolveSelector / resolveUriStringArray), never via
  // this URI-array detector.
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry): entry is string => typeof entry === 'string')
  ) {
    return resolveUriStringArray(name, value, options, await readManifest());
  }

  throw new Error(
    `not-an-artifact: ARTIFACTS naked declaration "${name}" is not artifact-shaped (expected ArtifactRecord, ArtifactRecord[], URI string, URI string[], or JSON URI[] string)`,
  );
}

function resolveUriString(
  name: string,
  uri: string,
  options: ResolveArtifactDeclarationsOptions,
  records: readonly ArtifactManifestRecord[],
): TrustedArtifactValue {
  const resolved = resolveSingleUriAgainstManifest(uri, options, records);
  // Per spec §10.1.2: `unresolvable-uri` covers both "did not parse" (null)
  // and "parsed but matched no manifest row" (empty array). Naked-form
  // resolution is all-or-nothing, so an empty result is an error here.
  if (resolved === null || resolved.length === 0) {
    throw new Error(
      `unresolvable-uri: ARTIFACTS naked declaration "${name}" URI "${uri}" did not parse or matched no manifest row`,
    );
  }
  if (resolved.length === 1) {
    // Single-element path: brandTrustedArtifactRecord is idempotent and
    // resolved[0] is already a TrustedArtifactRecord (from
    // resolveSingleUriAgainstManifest). Re-call defensively so a future
    // refactor that changes the helper's return type still emits a branded
    // value here.
    return brandTrustedArtifactRecord(resolved[0]);
  }
  // Multi-record path: brand the freshly-spread CONTAINER. The elements
  // are already per-record branded; brandTrustedArtifactArray is idempotent
  // and only attaches the container symbol when missing.
  return brandTrustedArtifactArray([...resolved]);
}

function resolveUriStringArray(
  name: string,
  uris: readonly string[],
  options: ResolveArtifactDeclarationsOptions,
  records: readonly ArtifactManifestRecord[],
): TrustedArtifactArray {
  const resolved: TrustedArtifactRecord[] = [];
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
  return brandTrustedArtifactArray(resolved);
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
 * @throws {Error} When `resolveSelector` returns an unbranded value — a
 *   defensive impossibility that indicates a broken sanctioned producer.
 */
function resolveSingleUriAgainstManifest(
  uri: string,
  options: ResolveArtifactDeclarationsOptions,
  records: readonly ArtifactManifestRecord[],
): TrustedArtifactRecord[] | null {
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
        record.kind === 'artifact-record'
      ) {
        return [brandTrustedArtifactRecord(record)];
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
  // resolveSelector returns TrustedArtifactValue — branded by
  // brandTrustedArtifactRecord (single match) or brandTrustedArtifactArray
  // (multi-match including zero-match). Narrow via the runtime guards so
  // the type-narrowing is anchored by an actual brand check, not a cast.
  if (isTrustedArtifactArray(result)) {
    return [...result];
  }
  if (isTrustedArtifactRecord(result)) {
    return [result];
  }
  // Defensive impossibility: if resolveSelector ever returned something
  // unbranded, the type system would catch it at the assignment above. The
  // throw documents the invariant for runtime auditors.
  throw new Error(
    `resolveSelector produced an unbranded result for URI "${uri}"; this indicates a broken sanctioned producer.`,
  );
}
