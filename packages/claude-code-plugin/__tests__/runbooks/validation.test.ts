/**
 * Unit tests for built-in runbook validation.
 * Uses @rundown-org/parser directly for fast validation.
 * Pattern: similar to packages/cli/__tests__/check.test.ts but without CLI
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isResolvedForClause,
  isSourced,
  parseRunbookDocument,
  stepHasSubsteps,
} from '@rundown-org/parser';
import type { ArtifactDeclaration, Step } from '@rundown-org/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const runbooksDir = join(__dirname, '..', '..', 'runbooks');
const projectRoot = join(__dirname, '..', '..');

/**
 * Recursively find all .runbook.md files in a directory.
 *
 * @param dir - Directory to search
 * @returns Array of absolute paths to runbook files
 */
function findRunbooks(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const runbooks: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      runbooks.push(...findRunbooks(fullPath));
    } else if (entry.endsWith('.runbook.md')) {
      runbooks.push(fullPath);
    }
  }
  return runbooks;
}

function readRunbook(relativePath: string) {
  const runbookPath = join(runbooksDir, relativePath);
  return parseRunbookDocument(readFileSync(runbookPath, 'utf-8'), runbookPath).runbook;
}

function expectSubstepRunbook(
  step: Step,
  expectedRunbooks: readonly string[],
  expectedDelegate: boolean,
): void {
  expect(stepHasSubsteps(step)).toBe(true);
  if (!stepHasSubsteps(step)) return;

  expect(step.substeps).toHaveLength(expectedRunbooks.length);
  expect(step.substeps.map((substep) => substep.runbooks?.[0])).toEqual(expectedRunbooks);
  expect(step.substeps.map((substep) => substep.delegate === true)).toEqual(
    expectedRunbooks.map(() => expectedDelegate),
  );
}

function artifactsForStep(relativePath: string, stepName: string): readonly ArtifactDeclaration[] {
  const runbook = readRunbook(relativePath);
  const step = runbook.steps.find((candidate) => candidate.name === stepName);
  if (!step) {
    throw new Error(`Expected ${relativePath} to contain step ${stepName}`);
  }
  return step.artifacts ?? [];
}

function artifactNamesForStep(relativePath: string, stepName: string): readonly string[] {
  return artifactsForStep(relativePath, stepName).map((artifact) => artifact.name);
}

function frontmatterOutputNames(relativePath: string): readonly string[] {
  const runbookPath = join(runbooksDir, relativePath);
  const { frontmatter } = parseRunbookDocument(readFileSync(runbookPath, 'utf-8'), runbookPath);
  return frontmatter?.outputs?.map((output) => output.name) ?? [];
}

describe('Built-in Runbook Validation', () => {
  const runbooks = findRunbooks(runbooksDir);

  it('runbooks directory is not empty', () => {
    expect(runbooks.length).toBeGreaterThan(0);
  });

  if (runbooks.length === 0) return;

  // Use relative paths for cleaner test names
  const runbookEntries = runbooks.map((p) => [relative(projectRoot, p), p] as const);

  describe.each(runbookEntries)('%s', (_relativePath, runbookPath) => {
    const content = readFileSync(runbookPath, 'utf-8');
    const { runbook, diagnostics } = parseRunbookDocument(content, runbookPath);

    it('parses without syntax errors', () => {
      expect(runbook).toBeDefined();
    });

    it('passes validation checks', () => {
      expect(diagnostics).toEqual([]);
    });

    it('has required metadata', () => {
      expect(runbook.name).toBeDefined();
      expect(typeof runbook.name).toBe('string');
    });

    it('has at least one step', () => {
      expect(runbook.steps.length).toBeGreaterThan(0);
    });
  });

  it('does not use removed rdx --check mode', () => {
    const offenders = runbookEntries
      .map(([relativePath, runbookPath]) => ({
        relativePath,
        content: readFileSync(runbookPath, 'utf-8'),
      }))
      .filter(({ content }) => /rdx --check\b/.test(content))
      .map(({ relativePath }) => relativePath);

    expect(offenders).toEqual([]);
  });

  it('does not double-quote schema helper templates in command blocks', () => {
    const shellFence = /```(?:bash|sh|shell)[^\n]*\n([\s\S]*?)\n```/g;
    const quotedValidateSchema = /"\{\{\s*validateSchema\s+[^}]+\s*\}\}"/;
    const offenders = runbookEntries
      .map(([relativePath, runbookPath]) => ({
        relativePath,
        content: readFileSync(runbookPath, 'utf-8'),
      }))
      .filter(({ content }) =>
        Array.from(content.matchAll(shellFence)).some((match) =>
          quotedValidateSchema.test(match[1]),
        ),
      )
      .map(({ relativePath }) => relativePath);

    expect(offenders).toEqual([]);
  });

  describe('end-to-end test workflow', () => {
    it('mirrors the planning workflow with local write/review and delegated nested review/collation', () => {
      const runbook = readRunbook('end-to-end-test/end-to-end-test.runbook.md');

      expect(runbook.name).toBe('end-to-end-test');
      expect(runbook.steps.map((step) => step.description)).toEqual([
        'Read the output schema',
        'Write',
        'Review',
        'Write the feedback',
        'Check Schema',
      ]);

      const [, writeStep, reviewStep] = runbook.steps;
      expectSubstepRunbook(writeStep, ['end-to-end-test/write-file.runbook.md'], false);
      expectSubstepRunbook(reviewStep, ['end-to-end-test/review-and-collate.runbook.md'], false);

      const reviewRunbook = readRunbook('end-to-end-test/review-and-collate.runbook.md');
      expect(reviewRunbook.steps.map((step) => step.description)).toEqual([
        'Delegate subagents to review',
        'Delegate subagent to collate reviews',
      ]);

      const [nestedReviewStep, collateStep] = reviewRunbook.steps;
      expect(frontmatterOutputNames('end-to-end-test/review-and-collate.runbook.md')).toEqual([
        'ReviewPath',
        'CollatedReviewPath',
      ]);
      expect(artifactNamesForStep('end-to-end-test/review-and-collate.runbook.md', '1')).toEqual([
        'PlanPath',
      ]);
      expectSubstepRunbook(nestedReviewStep, ['end-to-end-test/review-file.runbook.md'], true);
      expectSubstepRunbook(collateStep, ['end-to-end-test/collate-files.runbook.md'], true);

      expect(artifactNamesForStep('end-to-end-test/end-to-end-test.runbook.md', '4')).toEqual([
        'ReviewSchemaPath',
        'CollatedReviewPath',
        'FeedbackPath',
      ]);
    });

    it('provides review.schema.json as an ARTIFACT in review output schema steps', () => {
      for (const relativePath of [
        'end-to-end-test/review-file.runbook.md',
        'end-to-end-test/collate-files.runbook.md',
      ]) {
        expect(artifactsForStep(relativePath, '1')).toContainEqual({
          name: 'ReviewSchemaPath',
          rawToken: 'schemas/review.schema.json',
        });
      }
    });

    it('keeps end-to-end review and collation artifacts on the step that uses them', () => {
      const review = readRunbook('end-to-end-test/review-file.runbook.md');
      expect(review.steps.map((step) => step.description)).toEqual([
        'Read the output schema',
        'Read and review the plan',
        'Write review',
        'Check Schema',
      ]);
      expect(artifactNamesForStep('end-to-end-test/review-file.runbook.md', '3')).toEqual([
        'PlanPath',
        'ReviewSchemaPath',
        'ReviewPath',
      ]);

      const collate = readRunbook('end-to-end-test/collate-files.runbook.md');
      expect(collate.steps.map((step) => step.description)).toEqual([
        'Read the output schema',
        'Write collated review',
        'Check Schema',
      ]);
      expect(artifactNamesForStep('end-to-end-test/collate-files.runbook.md', '2')).toEqual([
        'PlanPath',
        'ReviewSchemaPath',
        'ReviewPaths',
        'CollatedReviewPath',
      ]);
    });
  });

  describe('planning execute pipeline', () => {
    function frontmatterText(relativePath: string): string {
      return readFileSync(join(runbooksDir, relativePath), 'utf-8');
    }

    it('implement-plan is a delegated leaf that invokes the executing-plans skill', () => {
      const rel = 'planning/implement-plan.runbook.md';
      const runbook = readRunbook(rel);
      expect(runbook.name).toBe('implement-plan');
      // Leaf: no substeps anywhere (cannot delegate).
      expect(runbook.steps.every((step) => !stepHasSubsteps(step))).toBe(true);
      expect(runbook.steps.map((step) => step.description)).toEqual([
        'Invoke the Executing Plans skill',
        'Read the plan',
        'Implement every task',
      ]);
      expect(frontmatterText(rel)).toMatch(/^skill:\s*executing-plans\s*$/m);
    });

    it('code-review is a leaf producing a validated CodeReviewPath', () => {
      const rel = 'planning/code-review.runbook.md';
      const runbook = readRunbook(rel);
      expect(runbook.name).toBe('code-review');
      expect(runbook.steps.every((step) => !stepHasSubsteps(step))).toBe(true);
      expect(frontmatterOutputNames(rel)).toEqual(['CodeReviewPath']);
      // Output path step binds the managed artifact; write step precedes validate.
      expect(artifactNamesForStep(rel, '4')).toEqual(['CodeReviewPath']);
      expect(runbook.steps.find((s) => s.name === '5')?.description).toBe('Write the review');
      // The review step records rather than gates.
      expect(runbook.steps.find((s) => s.name === '3')?.description).toBe(
        'Review the implemented changes',
      );
    });

    it('code-review owns its verdict via a final prompted gate (no jq)', () => {
      const rel = 'planning/code-review.runbook.md';
      const runbook = readRunbook(rel);

      const byId = (id: string) => {
        const step = runbook.steps.find((s) => s.name === id);
        if (!step) throw new Error(`expected step ${id}`);
        return step;
      };

      // Schema check no longer terminates the runbook — it continues to the gate.
      const schemaCheck = byId('6');
      expect(schemaCheck.kind).toBe('command');
      expect(schemaCheck.transitions.pass.action).toEqual({ type: 'CONTINUE' });
      expect(schemaCheck.transitions.fail.action).toMatchObject({
        type: 'GOTO',
        target: { step: '5' },
      });

      // The final step is a prompted (agent-judgment) gate, not a command.
      // A clean review COMPLETEs the runbook (-> parent pass); a dirty review
      // STOPs it (-> parent fail), so the review owns its own verdict.
      const gate = byId('7');
      expect(gate.kind).toBe('base');
      expect(gate.transitions.pass.action).toEqual({ type: 'COMPLETE' });
      expect(gate.transitions.fail.action).toEqual({ type: 'STOP' });
      // The gate rehydrates the recorded review so the agent can judge it.
      expect(artifactNamesForStep(rel, '7')).toEqual(['CodeReviewPath']);

      // The verdict is agent judgment, not a machine count — no jq anywhere.
      expect(readFileSync(join(runbooksDir, rel), 'utf-8')).not.toMatch(/\bjq\b/);
    });

    it('address-review is a leaf requiring the plan and the recorded review', () => {
      const rel = 'planning/address-review.runbook.md';
      const runbook = readRunbook(rel);
      expect(runbook.name).toBe('address-review');
      expect(runbook.steps.every((step) => !stepHasSubsteps(step))).toBe(true);
      const fm = frontmatterText(rel);
      expect(fm).toMatch(/^skill:\s*executing-plans\s*$/m);
      // Requires both the plan and the review it must resolve.
      expect(fm).toMatch(/REQUIRED:[\s\S]*?-\s*PlanPath/);
      expect(fm).toMatch(/REQUIRED:[\s\S]*?-\s*CodeReviewPath/);
    });

    it('execute-plan delegates implement/review and loops the review-verdict gate', () => {
      const rel = 'planning/execute-plan.runbook.md';
      const runbook = readRunbook(rel);
      expect(runbook.name).toBe('execute-plan');
      expect(runbook.steps.map((step) => step.description)).toEqual([
        'Invoke the Executing Plans skill',
        'Implement the plan',
        'Code review',
        'Address review findings',
        'Verify',
      ]);
      expect(frontmatterOutputNames(rel)).toEqual(['CodeReviewPath']);

      const byId = (id: string) => {
        const step = runbook.steps.find((s) => s.name === id);
        if (!step) throw new Error(`expected step ${id}`);
        return step;
      };
      // The three delegate frontiers.
      expectSubstepRunbook(byId('2'), ['implement-plan.runbook.md'], true);
      expectSubstepRunbook(byId('3'), ['code-review.runbook.md'], true);
      expectSubstepRunbook(byId('4'), ['address-review.runbook.md'], true);
      // Verify is a command gate with no substeps.
      expect(stepHasSubsteps(byId('5'))).toBe(false);

      // The code-review verdict drives flow directly — there is no jq gate step
      // in the parent. A clean review (child COMPLETE -> pass) jumps to Verify;
      // a dirty review (child STOP -> fail) falls through to Address.
      expect(byId('3').transitions.pass.action).toMatchObject({
        type: 'GOTO',
        target: { step: '5' },
      });
      expect(byId('3').transitions.fail.action).toEqual({ type: 'CONTINUE' });
      // Address loops back to re-review on success; stops if it cannot resolve.
      expect(byId('4').transitions.pass.action).toMatchObject({
        type: 'GOTO',
        target: { step: '3' },
      });
      expect(byId('4').transitions.fail.action).toEqual({ type: 'STOP' });
      // Verify completes the workflow when green; red routes back to Address.
      expect(byId('5').transitions.pass.action).toEqual({ type: 'COMPLETE' });
      expect(byId('5').transitions.fail.action).toMatchObject({
        type: 'GOTO',
        target: { step: '4' },
      });

      // The whole point of the change: the parent never inspects the review JSON.
      expect(readFileSync(join(runbooksDir, rel), 'utf-8')).not.toMatch(/\bjq\b/);
    });

    it('planning composes write(delegate) -> review -> execute', () => {
      const rel = 'planning/planning.runbook.md';
      const runbook = readRunbook(rel);
      expect(runbook.name).toBe('planning');
      expect(runbook.steps.map((step) => step.description)).toEqual([
        'Write the plan',
        'Review the plan',
        'Execute the plan',
      ]);
      // Leaf-delegate, orchestrator-compose: write delegates, review + execute compose.
      expectSubstepRunbook(runbook.steps[0], ['planning/write-plan.runbook.md'], true);
      expectSubstepRunbook(runbook.steps[1], ['planning/review-plan.runbook.md'], false);
      expectSubstepRunbook(runbook.steps[2], ['planning/execute-plan.runbook.md'], false);
      expect(frontmatterOutputNames(rel)).toEqual(['PlanPath', 'ReviewPlanPath', 'CodeReviewPath']);
    });

    it('house-style links to the composing-runbooks guide', () => {
      const houseStyle = readFileSync(
        join(projectRoot, 'skills', 'writing-runbooks', 'house-style.md'),
        'utf-8',
      );
      expect(houseStyle).toMatch(/composing-runbooks\.md/);
    });
  });

  describe('patterns/iterate-and-delegate (#435)', () => {
    it('iterate-and-delegate: step 2 is a data-source FOR delegating a single leaf', () => {
      const rb = readRunbook('patterns/iterate-and-delegate.runbook.md');
      const forStep = rb.steps.find((s) => s.name === '2');
      expect(forStep?.kind).toBe('for');
      // Narrow via the parser guards rather than casting; assert each guard
      // separately so a failure points at the specific clause expectation.
      // The guards must run in order: isResolvedForClause narrows
      // ParsedForClause -> ForClause, which isSourced then requires.
      if (forStep?.kind !== 'for') throw new Error('expected a FOR step');
      expect(isResolvedForClause(forStep.forClause)).toBe(true);
      if (!isResolvedForClause(forStep.forClause))
        throw new Error('expected a resolved FOR clause');
      expect(isSourced(forStep.forClause)).toBe(true);
      if (!isSourced(forStep.forClause)) throw new Error('expected a data-source FOR clause');
      expect(forStep.forClause.source).toBe('Items');
      expectSubstepRunbook(forStep, ['process-one-item.runbook.md'], true);
    });

    it('process-one-item requires the inherited item', () => {
      const runbookPath = join(runbooksDir, 'patterns/process-one-item.runbook.md');
      const { frontmatter } = parseRunbookDocument(readFileSync(runbookPath, 'utf-8'), runbookPath);
      expect(frontmatter?.required).toContain('item');
    });
  });
});
