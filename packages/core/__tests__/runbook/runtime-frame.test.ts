import { describe, expect, it } from '@jest/globals';
import type { ForClause, ResolvedStep } from '@rundown-org/parser';
import {
  buildContextVars,
  buildStepVariables,
  createJsonArrayStream,
  validateForVariables,
} from '../../src/runbook/index.js';
import type { ForContext } from '../../src/runbook/types.js';

describe('runtime frame construction', () => {
  it('builds current step aliases for a base step', () => {
    expect(buildStepVariables({ stepId: 'Deploy', templateVars: { env: 'prod' } })).toEqual({
      env: 'prod',
      Step: 'Deploy',
      step: 'Deploy',
      'context.current.step': 'Deploy',
      'context.current.at': 'Deploy',
    });
  });

  it('builds substep and sourced FOR aliases from the active forStack frame', () => {
    const frame: ForContext = {
      stepId: '2',
      start: 1,
      iteration: 3,
      variable: 'item',
      source: { kind: 'variable', name: 'items' },
      currentValue: { name: 'api', retries: 2 },
      implicit: false,
    };

    expect(
      buildStepVariables({
        stepId: '2',
        substepId: '1',
        forStack: [frame],
        templateVars: { items: [{ name: 'api', retries: 2 }] },
      }),
    ).toMatchObject({
      Step: '2.1',
      step: '2.1',
      Index: '3',
      index: '3',
      item: { name: 'api', retries: 2 },
      'context.current.step': '2.1',
      'context.current.substep': '1',
      'context.current.index': '3',
      'context.current.at': '2.3.1',
    });
  });

  it('uses a sourced FOR bootstrap frame for JSON arrays before the actor snapshot is available', () => {
    const forClause: ForClause = { variable: 'item', start: 2, end: 4, source: 'items' };

    expect(
      buildStepVariables({
        stepId: '3',
        substepId: '1',
        forClause,
        templateVars: { items: ['first', 'second', 'third'] },
      }),
    ).toMatchObject({
      Index: '2',
      index: '2',
      item: 'second',
      'context.current.at': '3.2.1',
    });
  });

  it('builds context.vars aliases from the full effective user variable map', () => {
    expect(buildContextVars({ env: 'prod', port: 443 })).toEqual({
      'context.vars.env': 'prod',
      'context.vars.port': 443,
    });
  });

  it('validates sourced FOR variables as JsonArray or JsonArrayStream', () => {
    const steps = [
      {
        kind: 'for',
        name: '1',
        description: 'Loop',
        forClause: { variable: 'item', start: 1, end: 2, source: 'items' },
        substeps: [],
      },
    ] as unknown as readonly ResolvedStep[];

    expect(() => {
      validateForVariables(steps, { items: ['a', 'b'] });
    }).not.toThrow();
    expect(() => {
      validateForVariables(steps, { items: createJsonArrayStream('/tmp/items.jsonl') });
    }).not.toThrow();
    expect(() => {
      validateForVariables(steps, { items: 'not iterable' });
    }).toThrow('FOR loop variable "{{items}}" is not iterable');
    expect(() => {
      validateForVariables(steps, {});
    }).toThrow('FOR loop references undefined variable "{{items}}"');
  });

  it('defers a FOR source produced by an earlier step (does not reject at launch)', () => {
    const steps = [
      {
        kind: 'command',
        name: '1',
        description: 'Produce',
        outputs: [{ name: 'Tasks' }],
      },
      {
        kind: 'for',
        name: '2',
        description: 'Loop',
        forClause: { variable: 'task', start: 1, end: 2, source: 'Tasks' },
        substeps: [],
      },
    ] as unknown as readonly ResolvedStep[];

    // Tasks is absent from launch vars but produced by step 1 → must NOT throw.
    expect(() => {
      validateForVariables(steps, {});
    }).not.toThrow();
  });

  it('rejects a FOR source produced only by a later step (deferral is earlier-step only)', () => {
    const steps = [
      {
        kind: 'for',
        name: '1',
        description: 'Loop',
        forClause: { variable: 'task', start: 1, end: 2, source: 'Tasks' },
        substeps: [],
      },
      {
        kind: 'command',
        name: '2',
        description: 'Produce',
        outputs: [{ name: 'Tasks' }],
      },
    ] as unknown as readonly ResolvedStep[];

    // Tasks is produced only by the later step 2, so it cannot be available when
    // the step 1 FOR runs → must reject at launch rather than defer.
    expect(() => {
      validateForVariables(steps, {});
    }).toThrow('FOR loop references undefined variable "{{Tasks}}"');
  });

  it('still rejects a FOR source that is neither provided nor produced (typo)', () => {
    // cspell:ignore Taks -- deliberate misspelling exercising the rejection path
    const steps = [
      {
        kind: 'for',
        name: '1',
        description: 'Loop',
        forClause: { variable: 'task', start: 1, end: 2, source: 'Taks' },
        substeps: [],
      },
    ] as unknown as readonly ResolvedStep[];

    expect(() => {
      validateForVariables(steps, {});
    }).toThrow('FOR loop references undefined variable "{{Taks}}"');
  });
});
