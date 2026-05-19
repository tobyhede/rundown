import { EXACT_ARTIFACT_KEY_PATTERN, WILDCARD_ARTIFACT_KEY_PATTERN } from './schemas.js';

/**
 * Typed reason explaining why an ARTIFACTS token was rejected by the parser
 * classifier.
 */
export type ArtifactTokenRejectReason =
  | 'empty'
  | 'dot-segment'
  | 'recursive-wildcard'
  | 'unresolved-template'
  | 'invalid-bare-key'
  | 'invalid-wildcard-key';

/** Parsed ARTIFACTS token classified by syntactic dispatch kind. */
export type ParsedArtifactToken =
  | {
      /** Exact managed artifact key token. */
      readonly kind: 'bare-key';
      /** Original token text supplied to the classifier. */
      readonly raw: string;
      /** Artifact key text. */
      readonly key: string;
    }
  | {
      /** Managed artifact wildcard selector key token. */
      readonly kind: 'wildcard-key';
      /** Original token text supplied to the classifier. */
      readonly raw: string;
      /** Wildcard key pattern text. */
      readonly key: string;
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
    case 'invalid-bare-key':
      return 'bare keys must match exact_artifact_key (alphanumerics, dots, underscores, and hyphens)';
    case 'invalid-wildcard-key':
      return "wildcard keys must match wildcard_artifact_key (alphanumerics, dots, underscores, hyphens, '*', and '?')";
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
    return {
      ok: true,
      token: {
        kind: 'rd-uri',
        raw,
        uri: raw,
      },
    };
  }

  if (raw.includes('*') || raw.includes('?')) {
    if (!hasTemplates && !WILDCARD_ARTIFACT_KEY_PATTERN.test(raw)) {
      return { ok: false, reason: 'invalid-wildcard-key', raw };
    }
    return { ok: true, token: { kind: 'wildcard-key', raw, key: raw } };
  }

  if (isAbsoluteArtifactPath(raw)) {
    return {
      ok: true,
      token: {
        kind: 'abs-path',
        raw,
        path: raw,
      },
    };
  }

  if (raw.includes('/') || raw.includes('\\')) {
    return {
      ok: true,
      token: {
        kind: 'rel-path',
        raw,
        path: raw,
      },
    };
  }

  if (!hasTemplates && !EXACT_ARTIFACT_KEY_PATTERN.test(raw)) {
    return { ok: false, reason: 'invalid-bare-key', raw };
  }
  return { ok: true, token: { kind: 'bare-key', raw, key: raw } };
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
