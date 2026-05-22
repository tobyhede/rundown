import { SELECTOR_ARTIFACT_KEY_PATTERN } from './schemas.js';

/**
 * Run scope for a shorthand ARTIFACTS token.
 *
 * - `current` — bare token; the run segment defaults to the current `RunId`.
 * - `any` — the token carried a leading cross-run prefix (an asterisk then a
 *   slash); the run segment is the selector wildcard `*` (query across all
 *   runs in the current context).
 */
export type ArtifactRunScope = 'current' | 'any';

/**
 * Typed reason explaining why an ARTIFACTS token was rejected by the parser
 * classifier.
 */
export type ArtifactTokenRejectReason =
  | 'empty'
  | 'dot-segment'
  | 'recursive-wildcard'
  | 'unresolved-template'
  | 'invalid-shorthand-key';

/** Parsed ARTIFACTS token classified by syntactic dispatch kind. */
export type ParsedArtifactToken =
  | {
      /**
       * Shorthand managed-artifact token. Sugar for an `rd://artifacts/` URI
       * whose context segment defaults to the current `ContextId`. The run
       * segment is the current `RunId` when `runScope` is `current` or the
       * selector wildcard `*` when `runScope` is `any`.
       */
      readonly kind: 'shorthand';
      /** Original token text supplied to the classifier. */
      readonly raw: string;
      /** Artifact key (exact or wildcard); the URI key segment. */
      readonly key: string;
      /** Run scope: `current` for produce/current-run query, `any` for cross-run query. */
      readonly runScope: ArtifactRunScope;
    }
  | {
      /** Rundown artifact URI token. */
      readonly kind: 'rd-uri';
      /** Original token text supplied to the classifier. */
      readonly raw: string;
      /** URI text. */
      readonly uri: string;
    }
  | {
      /** Absolute filesystem path token. */
      readonly kind: 'abs-path';
      /** Original token text supplied to the classifier. */
      readonly raw: string;
      /** Path text. */
      readonly path: string;
    }
  | {
      /** Relative filesystem path token. */
      readonly kind: 'rel-path';
      /** Original token text supplied to the classifier. */
      readonly raw: string;
      /** Path text. */
      readonly path: string;
    };

/**
 * Classification result for an ARTIFACTS token.
 *
 * Successful results carry a discriminated token suitable for resolver
 * dispatch; rejected results preserve the raw text and a typed reason.
 */
export type ArtifactTokenClassificationResult =
  | { readonly ok: true; readonly token: ParsedArtifactToken }
  | { readonly ok: false; readonly reason: ArtifactTokenRejectReason; readonly raw: string };

/** Prefix that overrides a shorthand token's run scope to query all runs. */
const CROSS_RUN_PREFIX = '*/';

/**
 * Classify a raw ARTIFACTS token as it appears in the runbook source.
 *
 * Raw classification performs shared reject-first safety checks but allows
 * template markers because they are expanded later by core at runtime.
 *
 * @param raw - Unquoted ARTIFACTS token text from the parser
 * @returns Classified token or typed rejection reason
 */
export function classifyRawArtifactToken(raw: string): ArtifactTokenClassificationResult {
  const sharedRejection = rejectUnsafeArtifactToken(raw);
  if (sharedRejection !== null) return { ok: false, reason: sharedRejection, raw };
  return classifyAcceptedArtifactToken(raw, { allowTemplateMarkers: true });
}

/**
 * Classify a runtime-expanded ARTIFACTS token.
 *
 * Expanded classification performs the same shared safety checks as raw
 * classification and additionally rejects unresolved `{{...}}` template
 * markers before final dispatch.
 *
 * @param raw - Runtime-expanded ARTIFACTS token text
 * @returns Classified token or typed rejection reason
 */
export function classifyExpandedArtifactToken(raw: string): ArtifactTokenClassificationResult {
  const sharedRejection = rejectUnsafeArtifactToken(raw);
  if (sharedRejection !== null) return { ok: false, reason: sharedRejection, raw };
  if (hasTemplateMarker(raw)) return { ok: false, reason: 'unresolved-template', raw };
  return classifyAcceptedArtifactToken(raw, { allowTemplateMarkers: false });
}

/**
 * Format an ARTIFACTS token rejection reason for diagnostics.
 *
 * @param reason - Typed classifier rejection reason
 * @returns Human-readable diagnostic fragment
 */
export function formatArtifactTokenRejectReason(reason: ArtifactTokenRejectReason): string {
  switch (reason) {
    case 'empty':
      return 'token must not be empty';
    case 'dot-segment':
      return 'dot and traversal path segments are not allowed';
    case 'recursive-wildcard':
      return "recursive wildcard '**' is not allowed";
    case 'unresolved-template':
      return 'unresolved template marker remains after expansion';
    case 'invalid-shorthand-key':
      return "shorthand keys must match selector_artifact_key (alphanumerics, dots, underscores, hyphens, '*', and '?'), optionally with a leading '*/' cross-run prefix";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function classifyAcceptedArtifactToken(
  raw: string,
  options: { readonly allowTemplateMarkers: boolean },
): ArtifactTokenClassificationResult {
  const hasTemplates = options.allowTemplateMarkers && hasTemplateMarker(raw);

  if (raw.startsWith('rd://')) {
    return { ok: true, token: { kind: 'rd-uri', raw, uri: raw } };
  }

  if (isAbsoluteArtifactPath(raw)) {
    if (!hasTemplates && (raw.includes('*') || raw.includes('?'))) {
      return { ok: false, reason: 'invalid-shorthand-key', raw };
    }
    return { ok: true, token: { kind: 'abs-path', raw, path: raw } };
  }

  // Cross-run shorthand: a leading `*/` prefix overrides the run segment to
  // the selector wildcard. The remainder must be a single key segment (no
  // further slashes) and must satisfy the selector-key shape.
  if (raw.startsWith(CROSS_RUN_PREFIX)) {
    const key = raw.slice(CROSS_RUN_PREFIX.length);
    if (!isValidShorthandKey(key, hasTemplates)) {
      return { ok: false, reason: 'invalid-shorthand-key', raw };
    }
    return { ok: true, token: { kind: 'shorthand', raw, key, runScope: 'any' } };
  }

  // A path-shaped token (contains a separator) that is NOT the cross-run
  // shorthand. A concrete token carrying glob characters is neither a valid
  // key nor a valid file reference — reject it. A templated token is exempt:
  // its final shape is unknown until runtime expansion, so raw classification
  // accepts it permissively and `classifyExpandedArtifactToken` re-checks the
  // expanded value. Otherwise it is a plain file reference.
  if (raw.includes('/') || raw.includes('\\')) {
    if (!hasTemplates && (raw.includes('*') || raw.includes('?'))) {
      return { ok: false, reason: 'invalid-shorthand-key', raw };
    }
    return { ok: true, token: { kind: 'rel-path', raw, path: raw } };
  }

  // Bare shorthand: no separators. The key may be exact or carry globs; the
  // run segment defaults to the current run.
  if (!isValidShorthandKey(raw, hasTemplates)) {
    return { ok: false, reason: 'invalid-shorthand-key', raw };
  }
  return { ok: true, token: { kind: 'shorthand', raw, key: raw, runScope: 'current' } };
}

/**
 * Validate a shorthand key segment.
 *
 * Templated keys bypass the regex (they are expanded later); concrete keys
 * must satisfy {@link SELECTOR_ARTIFACT_KEY_PATTERN} — a single segment with
 * no separators, optionally carrying `*`/`?` globs.
 *
 * @param key - Candidate shorthand key segment
 * @param hasTemplates - Whether raw classification found template markers
 * @returns True when the key is acceptable for deferred or concrete shorthand
 *   classification
 */
function isValidShorthandKey(key: string, hasTemplates: boolean): boolean {
  if (hasTemplates) return true;
  return SELECTOR_ARTIFACT_KEY_PATTERN.test(key);
}

function rejectUnsafeArtifactToken(raw: string): ArtifactTokenRejectReason | null {
  if (raw.length === 0) return 'empty';
  if (raw === '.' || raw === '..') return 'dot-segment';
  if (raw.includes('**')) return 'recursive-wildcard';
  if (hasDotSegment(raw)) return 'dot-segment';
  return null;
}

function hasTemplateMarker(raw: string): boolean {
  const open = raw.indexOf('{{');
  if (open === -1) return false;
  return raw.includes('}}', open + 2);
}

function hasDotSegment(raw: string): boolean {
  return splitPathSegments(raw).some((segment) => segment === '.' || segment === '..');
}

function splitPathSegments(raw: string): string[] {
  return raw.split(/[\\/]+/).filter(Boolean);
}

function isAbsoluteArtifactPath(raw: string): boolean {
  return raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
}
