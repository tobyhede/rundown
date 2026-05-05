import { z } from 'zod';
import { assertSafeId } from '../paths.js';

/**
 * Stable error text for canonical runbook reference validation.
 */
export const RUNBOOK_REF_ERROR_TEXT = {
  INVALID_RUNBOOK_REF:
    'Invalid runbook: expected { source, path } with a source-root-relative .runbook.md path',
} as const;

/**
 * Supported source roots for local-disk runbook references.
 */
export const RUNBOOK_SOURCES = ['project', 'plugin', 'bundled'] as const;

/**
 * Zod schema for a supported runbook source root.
 */
export const RunbookSourceSchema = z.enum(RUNBOOK_SOURCES, {
  errorMap: () => ({ message: RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF }),
});

/**
 * Source root for a canonical local-disk runbook reference.
 */
export type RunbookSource = z.infer<typeof RunbookSourceSchema>;

/**
 * Validate a source-root-relative `.runbook.md` path.
 *
 * @param value - Path value to validate
 * @returns True when the path is canonical for a local runbook reference
 */
function isValidRunbookPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    !value.endsWith('.runbook.md')
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
 * Zod schema for canonical local-disk runbook references.
 */
export const RunbookRefSchema = z
  .object(
    {
      source: RunbookSourceSchema,
      path: z.string({
        invalid_type_error: RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF,
        required_error: RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF,
      }),
    },
    {
      invalid_type_error: RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF,
      required_error: RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF,
    },
  )
  .superRefine((ref, ctx) => {
    if (
      !isValidRunbookPath(ref.path) ||
      (ref.source === 'project' && ref.path.startsWith('.rundown/runbooks/'))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF,
        path: ['path'],
      });
    }
  });

/**
 * Canonical local-disk runbook reference shared by run state, events, and artifacts.
 */
export type RunbookRef = z.infer<typeof RunbookRefSchema>;
