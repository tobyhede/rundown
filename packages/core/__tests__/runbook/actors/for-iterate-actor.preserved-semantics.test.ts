import { describe, it, expect } from '@jest/globals';
import { createActor } from 'xstate';
import {
  forIterateActor,
  type ForIterateInput,
} from '../../../src/runbook/actors/for-iterate-actor.js';
import type { ForContext } from '../../../src/runbook/types.js';
import { brandInitialTemplateVarsForTest } from '../../helpers/effective-vars.js';

function variableCtx(overrides: Partial<ForContext> = {}): ForContext {
  return {
    stepId: '1',
    iteration: 1,
    start: 1,
    end: 3,
    variable: 'item',
    implicit: false,
    source: { kind: 'variable', name: 'items' },
    ...overrides,
  };
}

async function runActor(input: ForIterateInput) {
  const actor = createActor(forIterateActor, { input });
  const result = new Promise<{
    readonly status: 'done' | 'error';
    output?: unknown;
    error?: unknown;
  }>((resolve) => {
    actor.subscribe({
      next: (snap) => {
        if (snap.status === 'done') resolve({ status: 'done', output: snap.output });
        if (snap.status === 'error') resolve({ status: 'error', error: snap.error });
      },
      error: (error) => {
        resolve({ status: 'error', error });
      },
    });
  });
  actor.start();
  return await result;
}

describe('forIterateActor: preserved semantics — templateVars only', () => {
  it('ignores variables added at runtime (OUTPUTS-captured values must not alter source)', async () => {
    const seedVars = brandInitialTemplateVarsForTest({ items: ['a', 'b', 'c'] });

    const result = await runActor({
      forContext: variableCtx({ iteration: 2 }),
      templateVars: seedVars,
      cwd: '/tmp',
    });

    expect(result.output).toMatchObject({ kind: 'ready', forIndex: 2, forValue: 'b' });
  });

  it('rejects with undefined-variable when source name exists only in runtime view', async () => {
    const result = await runActor({
      forContext: variableCtx({ source: { kind: 'variable', name: 'items' } }),
      templateVars: brandInitialTemplateVarsForTest({}),
      cwd: '/tmp',
    });

    expect(result.status).toBe('error');
    expect((result.error as { code?: string }).code).toBe('undefined-variable');
  });
});
