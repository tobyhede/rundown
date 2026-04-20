import { parseRunbookDocument, areAllStepsResolved } from '@rundown-org/parser';
import type { ResolvedStep } from '../../src/runbook/types.js';

/**
 * Parse a markdown runbook string and return its resolved steps.
 * Throws if the runbook contains unresolved FOR bounds or runbook references.
 *
 * @param markdown - Runbook markdown content
 * @returns Array of resolved steps suitable for `compileRunbookToMachine`
 */
export function createRunbook(markdown: string): ResolvedStep[] {
  const { runbook } = parseRunbookDocument(markdown);
  const steps = runbook.steps;
  if (!areAllStepsResolved(steps)) {
    throw new Error('Test runbook has unresolved FOR bounds or runbook references');
  }
  return steps as ResolvedStep[];
}
