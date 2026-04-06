/**
 * Structural validation functions for reviews.
 *
 * These validators enforce consistency requirements beyond JSON schema
 * compliance. A review can be schema-valid but structurally inconsistent
 * (e.g., status says "ok" but blocking findings exist).
 *
 * Each check function takes a validated {@link Review} and returns an array of
 * {@link StructuralIssue} objects. The aggregator {@link validateReviewStructure}
 * runs all checks and returns a summary result.
 *
 * @module review-validators
 */

import type { Review } from './review-schema.js';

/**
 * A single structural issue found in a review.
 *
 * Reuses the same shape as plan-validators for consistency.
 */
export interface StructuralIssue {
  /** Rule identifier, e.g. 'status-consistency', 'blocking-count'. */
  rule: string;
  /** Error = must fix, warning = should fix. */
  severity: 'error' | 'warning';
  /** JSON-pointer-style location, e.g. 'status'. */
  path: string;
  /** Human-readable description of the issue. */
  message: string;
}

/**
 * Aggregated result of structural validation.
 */
export interface StructuralValidationResult {
  /** True when there are zero errors (warnings are allowed). */
  valid: boolean;
  /** All issues found across all checks. */
  issues: StructuralIssue[];
}

// ── Individual Checks ────────────────────────────────────────────────────────

/**
 * Check that status is consistent with findings.
 *
 * Status "ok" requires zero blocking findings. Status "blocked" requires
 * at least one blocking finding.
 *
 * @param review - Validated review to check
 * @returns Errors for status/findings mismatches
 */
export function checkStatusConsistency(review: Review): StructuralIssue[] {
  const blockingCount = review.findings.filter((f) => f.severity === 'blocking').length;

  if (review.status === 'ok' && blockingCount > 0) {
    return [
      {
        rule: 'status-consistency',
        severity: 'error',
        path: 'status',
        message: `Status is "ok" but ${String(blockingCount)} blocking finding(s) exist`,
      },
    ];
  }

  if (review.status === 'blocked' && blockingCount === 0) {
    return [
      {
        rule: 'status-consistency',
        severity: 'error',
        path: 'status',
        message: 'Status is "blocked" but no blocking findings exist',
      },
    ];
  }

  return [];
}

/**
 * Check that blocking_count matches the actual number of blocking findings.
 *
 * @param review - Validated review to check
 * @returns Errors for count mismatches
 */
export function checkBlockingCount(review: Review): StructuralIssue[] {
  const actual = review.findings.filter((f) => f.severity === 'blocking').length;

  if (review.blocking_count !== actual) {
    return [
      {
        rule: 'blocking-count',
        severity: 'error',
        path: 'blocking_count',
        message: `blocking_count is ${String(review.blocking_count)} but ${String(actual)} blocking finding(s) exist`,
      },
    ];
  }

  return [];
}

// ── Aggregator ───────────────────────────────────────────────────────────────

/**
 * Run all structural validation checks against a review.
 *
 * Returns `valid: true` when there are zero errors (warnings are allowed).
 *
 * @param review - Validated review to check
 * @returns Aggregated validation result with all issues
 */
export function validateReviewStructure(review: Review): StructuralValidationResult {
  const checks = [checkStatusConsistency, checkBlockingCount];

  const issues = checks.flatMap((fn) => fn(review));

  return {
    valid: issues.filter((i) => i.severity === 'error').length === 0,
    issues,
  };
}
