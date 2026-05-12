import * as path from 'node:path';
import { z } from 'zod';
import { assertSafeId } from '../paths.js';

/**
 * Stable error text for canonical runbook reference validation.
 */
export const RUNBOOK_REF_ERROR_TEXT = {
  INVALID_RUNBOOK_REF:
    'Invalid runbook: expected { source, path } with a safe source-root-relative Markdown path or normalized absolute external Markdown path',
} as const;

/**
 * Supported source roots for local-disk runbook references.
 */
export const RUNBOOK_SOURCES = ['project', 'plugin', 'bundled', 'external'] as const;

/**
 * Zod schema for a supported runbook source root.
 */
export const RunbookSourceSchema = z.enum(RUNBOOK_SOURCES, {
  error: () => RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF,
});

/**
 * Source root for a canonical local-disk runbook reference.
 */
export type RunbookSource = z.infer<typeof RunbookSourceSchema>;

/**
 * Validate a source-root-relative Markdown path.
 *
 * @param value - Path value to validate
 * @returns True when the path is canonical for a local runbook reference
 */
function isValidSourceRootRelativeRunbookPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    !value.endsWith('.md')
  ) {
    return false;
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return false;
  }

  for (const segment of segments) {
    try {
      assertSafeId(segment, 'runbook');
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Validate a normalized absolute Markdown path for an external runbook.
 *
 * @param value - Path value to validate
 * @returns True when the path can be persisted and rehydrated directly
 */
function isValidExternalRunbookPath(value: string): boolean {
  if (
    value.length === 0 ||
    !path.isAbsolute(value) ||
    value.includes('\\') ||
    /[\r\n\0]/.test(value) ||
    !value.endsWith('.md') ||
    path.normalize(value) !== value
  ) {
    return false;
  }

  const root = path.parse(value).root;
  const segments = value.slice(root.length).split(path.sep);
  return !segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..');
}

/**
 * Zod schema for canonical local-disk runbook references.
 */
export const RunbookRefSchema = z
  .object(
    {
      source: RunbookSourceSchema,
      path: z.string({
        error: RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF,
      }),
    },
    {
      error: RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF,
    },
  )
  .superRefine((ref, ctx) => {
    const validPath =
      ref.source === 'external'
        ? isValidExternalRunbookPath(ref.path)
        : isValidSourceRootRelativeRunbookPath(ref.path);
    if (!validPath) {
      ctx.addIssue({
        code: 'custom',
        message: RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF,
        path: ['path'],
      });
    }
  });

/**
 * Canonical local-disk runbook reference shared by run state, events, and artifacts.
 */
export type RunbookRef = z.infer<typeof RunbookRefSchema>;
