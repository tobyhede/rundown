import { describe, expect, it } from '@jest/globals';
import type { RunbookFrontmatter, Step } from '@rundown-org/parser';
import {
  analyzeForSources,
  collectProducedNames,
  forSourceWarnings,
} from '../../src/runbook/for-source-analysis.js';

// Fixtures are parser-tier `Step` objects (what `rd check` passes). The minimal
// `as unknown as Step` keeps the literals terse — these are test-only doubles,
// not the production traversal (which is fully cast-free).
const forStep = (source: string, refs: number): Step =>
  ({
    kind: 'for',
    name: '2',
    description: 'Loop',
    forClause: { variable: 'task', start: 1, end: 2, source },
    substeps: Array.from({ length: refs }, (_unused, i) => ({
      id: String(i + 1),
      description: `Runbook: child-${String(i)}.runbook.md`,
      delegate: true,
      runbooks: [`child-${String(i)}.runbook.md`],
    })),
  }) as unknown as Step;

// A pure numeric-range FOR (no `source`): must never appear in sourcedFors.
const rangeForStep = (refs: number): Step =>
  ({
    kind: 'for',
    name: '3',
    description: 'Pass counter',
    forClause: { variable: 'pass', start: 1, end: 3 },
    substeps: Array.from({ length: refs }, (_unused, i) => ({
      id: String(i + 1),
      description: `Runbook: child-${String(i)}.runbook.md`,
      delegate: true,
      runbooks: [`child-${String(i)}.runbook.md`],
    })),
  }) as unknown as Step;

const producerStep = (name: string): Step =>
  ({
    kind: 'command',
    name: '1',
    description: 'Produce',
    outputs: [{ name }],
  }) as unknown as Step;

const fm = (inputs: string[]): RunbookFrontmatter => ({ inputs }) as unknown as RunbookFrontmatter;

describe('analyzeForSources', () => {
  it('collects produced names from step OUTPUTS', () => {
    expect([...collectProducedNames([producerStep('Tasks'), forStep('Tasks', 1)])]).toEqual([
      'Tasks',
    ]);
  });

  it('excludes naked ARTIFACTS assertions (rawToken null binds no name)', () => {
    const step = {
      kind: 'command',
      name: '1',
      description: 'Mixed',
      outputs: [{ name: 'Bound' }],
      artifacts: [
        { name: 'NamedArtifact', rawToken: 'plan.json' },
        { name: 'NakedAssertion', rawToken: null },
      ],
    } as unknown as Step;
    expect([...collectProducedNames([step])].sort()).toEqual(['Bound', 'NamedArtifact']);
  });

  it('collects sourced FOR facts with delegated ref counts', () => {
    const facts = analyzeForSources([producerStep('Tasks'), forStep('Tasks', 2)], fm([]));
    expect(facts.sourcedFors).toEqual([{ stepName: '2', source: 'Tasks', delegatedRefCount: 2 }]);
    expect(facts.producedNames.has('Tasks')).toBe(true);
  });

  it('tolerates null frontmatter (rd check supplies RunbookFrontmatter | null)', () => {
    const facts = analyzeForSources([forStep('Tasks', 1)], null);
    expect(facts.declaredInputs.size).toBe(0);
    expect(forSourceWarnings(facts)).toContain(
      'Step 2: FOR source "Tasks" is neither a declared input nor produced by a step — ensure it is provided at runtime.',
    );
  });

  it('warns when a FOR source is neither declared nor produced', () => {
    const facts = analyzeForSources([forStep('Tasks', 1)], fm([]));
    expect(forSourceWarnings(facts)).toEqual([
      'Step 2: FOR source "Tasks" is neither a declared input nor produced by a step — ensure it is provided at runtime.',
    ]);
  });

  it('does not warn when the source is produced by a step', () => {
    const facts = analyzeForSources([producerStep('Tasks'), forStep('Tasks', 1)], fm([]));
    expect(forSourceWarnings(facts)).toEqual([]);
  });

  it('does not warn when the source is a declared input (suppression branch)', () => {
    const facts = analyzeForSources([forStep('Tasks', 1)], fm(['Tasks']));
    expect(facts.declaredInputs.has('Tasks')).toBe(true);
    expect(forSourceWarnings(facts)).toEqual([]);
  });

  it('warns on a data-source FOR with multiple delegated refs (shared binding)', () => {
    const facts = analyzeForSources([producerStep('Tasks'), forStep('Tasks', 2)], fm([]));
    expect(forSourceWarnings(facts)).toContain(
      'Step 2: FOR "Tasks" delegates 2 references per iteration; the loop item is shared across all of them (not paired). Use a single delegated reference for per-item-per-worker.',
    );
  });

  it('never warns on a numeric-range FOR, even with multiple delegated refs', () => {
    // Pins the spec/impl agreement: a range FOR has no source, so it is never a
    // sourcedFor and the shared-binding warning cannot fire (language spec §10.4).
    const facts = analyzeForSources([rangeForStep(3)], fm([]));
    expect(facts.sourcedFors).toEqual([]);
    expect(forSourceWarnings(facts)).toEqual([]);
  });
});
