/**
 * Structural validation functions for implementation plans.
 *
 * These validators enforce quality requirements beyond JSON schema compliance.
 * A plan can be schema-valid but structurally flawed (e.g., missing TDD cycle,
 * inconsistent file references).
 *
 * Path format and code block language checks are enforced at the schema level
 * (see {@link ../plan-schema.js}).
 *
 * Each check function takes a validated {@link Plan} and returns an array of
 * {@link StructuralIssue} objects. The aggregator {@link validatePlanStructure}
 * runs all checks and returns a summary result.
 *
 * @module plan-validators
 */

import type { Plan } from './plan-schema.js';

/**
 * A single structural issue found in a plan.
 */
export interface StructuralIssue {
  /** Rule identifier, e.g. 'no-absolute-paths', 'tdd-cycle'. */
  rule: string;
  /** Error = must fix, warning = should fix. */
  severity: 'error' | 'warning';
  /** JSON-pointer-style location, e.g. 'tasks/0/subtasks/2'. */
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
 * Check that tasks with files follow a TDD subtask pattern.
 *
 * Looks for subtask names suggesting: write test, run to confirm failure,
 * implement, run to verify. Tasks with empty files arrays are skipped
 * (research/config tasks).
 *
 * @param plan - Validated plan to check
 * @returns Warnings for tasks missing TDD pattern
 */
export function checkTddCycle(plan: Plan): StructuralIssue[] {
  const issues: StructuralIssue[] = [];

  const writeTestPattern = /\b(write|add|create)\b.*\b(fail|test)\b/i;
  const runFailPattern = /\b(run|execute)\b.*\b(fail|confirm)\b/i;
  const implementPattern = /\b(implement|add.*implementation|build\s+the)\b/i;
  const verifyPattern = /\b(run|verify|pass|green|confirm.*pass)\b.*\b(test|pass|verify)\b/i;

  for (let t = 0; t < plan.tasks.length; t++) {
    const task = plan.tasks[t];
    if (task.files.length === 0) continue;

    const names = task.subtasks.map((s) => s.name);
    const hasWriteTest = names.some((n) => writeTestPattern.test(n));
    const hasRunFail = names.some((n) => runFailPattern.test(n));
    const hasImplement = names.some((n) => implementPattern.test(n));
    const hasVerify = names.some((n) => verifyPattern.test(n));

    if (!hasWriteTest && !hasRunFail && !hasImplement && !hasVerify) {
      issues.push({
        rule: 'tdd-cycle',
        severity: 'warning',
        path: `tasks/${String(t)}`,
        message: `Task "${task.name}" has files but no subtasks suggesting a TDD cycle`,
      });
    }
  }

  return issues;
}

/**
 * Check that tasks with files have a commit step.
 *
 * @param plan - Validated plan to check
 * @returns Warnings for tasks missing commit steps
 */
export function checkCommitSteps(plan: Plan): StructuralIssue[] {
  const issues: StructuralIssue[] = [];

  for (let t = 0; t < plan.tasks.length; t++) {
    const task = plan.tasks[t];
    if (task.files.length === 0) continue;
    if (!task.commit) {
      issues.push({
        rule: 'commit-required',
        severity: 'warning',
        path: `tasks/${String(t)}`,
        message: `Task "${task.name}" has files but no commit step`,
      });
    }
  }

  return issues;
}

/**
 * Check that every path in a task's commit.files appears in the plan-level files array.
 *
 * @param plan - Validated plan to check
 * @returns Errors for commit files not found in plan files
 */
export function checkCommitFileConsistency(plan: Plan): StructuralIssue[] {
  const issues: StructuralIssue[] = [];
  const planPaths = new Set(plan.files.map((f) => f.path));

  for (let t = 0; t < plan.tasks.length; t++) {
    const task = plan.tasks[t];
    if (!task.commit) continue;

    for (let c = 0; c < task.commit.files.length; c++) {
      const commitPath = task.commit.files[c];
      if (!planPaths.has(commitPath)) {
        issues.push({
          rule: 'commit-file-consistency',
          severity: 'error',
          path: `tasks/${String(t)}/commit/files/${String(c)}`,
          message: `Commit file "${commitPath}" not in plan-level files`,
        });
      }
    }
  }

  return issues;
}

/**
 * Check that no subtask descriptions or code content reference line numbers.
 *
 * Detects patterns like "line 42", "L42", "lines 10-20". Uses word boundaries
 * to avoid false positives on "inline", "command-line", etc.
 *
 * @param plan - Validated plan to check
 * @returns Errors for line number references found
 */
export function checkNoLineNumbers(plan: Plan): StructuralIssue[] {
  const issues: StructuralIssue[] = [];

  // Word boundary patterns to avoid matching "inline", "command-line", "pipeline"
  const patterns = [/\bline\s+\d+/i, /\bL\d+\b/, /\blines\s+\d+\s*[-–]\s*\d+/i];

  for (let t = 0; t < plan.tasks.length; t++) {
    const task = plan.tasks[t];
    for (let s = 0; s < task.subtasks.length; s++) {
      const subtask = task.subtasks[s];
      const textsToCheck: Array<{ text: string; suffix: string }> = [];

      if (subtask.description) {
        textsToCheck.push({ text: subtask.description, suffix: 'description' });
      }
      if (subtask.code?.content) {
        textsToCheck.push({ text: subtask.code.content, suffix: 'code/content' });
      }

      for (const { text, suffix } of textsToCheck) {
        for (const pattern of patterns) {
          if (pattern.test(text)) {
            issues.push({
              rule: 'no-line-numbers',
              severity: 'error',
              path: `tasks/${String(t)}/subtasks/${String(s)}/${suffix}`,
              message: `Line number reference found: "${text.match(pattern)?.[0] ?? ''}"`,
            });
            break; // One issue per text field is enough
          }
        }
      }
    }
  }

  return issues;
}

/**
 * Check that every file path in task-level files appears in the plan-level files array.
 *
 * @param plan - Validated plan to check
 * @returns Errors for task files not found in plan-level files
 */
export function checkFileConsistency(plan: Plan): StructuralIssue[] {
  const issues: StructuralIssue[] = [];
  const planPaths = new Set(plan.files.map((f) => f.path));

  for (let t = 0; t < plan.tasks.length; t++) {
    const task = plan.tasks[t];
    for (let f = 0; f < task.files.length; f++) {
      const file = task.files[f];
      if (!planPaths.has(file.path)) {
        issues.push({
          rule: 'file-consistency',
          severity: 'error',
          path: `tasks/${String(t)}/files/${String(f)}`,
          message: `Task file "${file.path}" not in plan-level files`,
        });
      }
    }
  }

  return issues;
}

/**
 * Check that no file entries in the plan include line or end_line fields.
 *
 * The shared location schema allows line numbers for use in reviews,
 * but plans describe future work where line numbers are meaningless.
 * This validator rejects them in plan context.
 *
 * @param plan - Validated plan to check
 * @returns Errors for file entries with line number fields
 */
export function checkNoLocationLineNumbers(plan: Plan): StructuralIssue[] {
  const issues: StructuralIssue[] = [];

  for (let f = 0; f < plan.files.length; f++) {
    const file = plan.files[f];
    if (file.line !== undefined || file.end_line !== undefined) {
      issues.push({
        rule: 'no-line-numbers',
        severity: 'error',
        path: `files/${String(f)}`,
        message: `File entry "${file.path}" must not include line numbers`,
      });
    }
  }

  for (let t = 0; t < plan.tasks.length; t++) {
    const task = plan.tasks[t];
    for (let f = 0; f < task.files.length; f++) {
      const file = task.files[f];
      if (file.line !== undefined || file.end_line !== undefined) {
        issues.push({
          rule: 'no-line-numbers',
          severity: 'error',
          path: `tasks/${String(t)}/files/${String(f)}`,
          message: `File entry "${file.path}" must not include line numbers`,
        });
      }
    }
  }

  return issues;
}

// ── Aggregator ───────────────────────────────────────────────────────────────

/**
 * Run all structural validation checks against a plan.
 *
 * Returns `valid: true` when there are zero errors (warnings are allowed).
 *
 * @param plan - Validated plan to check
 * @returns Aggregated validation result with all issues
 */
export function validatePlanStructure(plan: Plan): StructuralValidationResult {
  const checks = [
    checkTddCycle,
    checkCommitSteps,
    checkCommitFileConsistency,
    checkNoLineNumbers,
    checkNoLocationLineNumbers,
    checkFileConsistency,
  ];

  const issues = checks.flatMap((fn) => fn(plan));

  return {
    valid: issues.filter((i) => i.severity === 'error').length === 0,
    issues,
  };
}
