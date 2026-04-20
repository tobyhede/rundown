import { parseRunbookDocument, areAllStepsResolved } from '@rundown-org/parser';
import type { ResolvedStep } from '../../src/runbook/types.js';

/**
 * Parse a markdown runbook string and return its resolved steps.
 *
 * @param markdown - Runbook markdown content
 * @returns Array of resolved steps suitable for `compileRunbookToMachine`
 * @throws {Error} If the parsed runbook contains unresolved FOR bounds or runbook references
 */
export function createRunbook(markdown: string): ResolvedStep[] {
  const { runbook } = parseRunbookDocument(markdown);
  const steps = runbook.steps;
  if (!areAllStepsResolved(steps)) {
    throw new Error('Test runbook has unresolved FOR bounds or runbook references');
  }
  return steps as ResolvedStep[];
}
