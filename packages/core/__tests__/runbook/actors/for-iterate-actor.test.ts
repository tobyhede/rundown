import { describe, it, expect } from '@jest/globals';
import { createActor } from 'xstate';
import {
  forIterateActor,
  type ForIterateInput,
} from '../../../src/runbook/actors/for-iterate-actor.js';
import { MAX_FILE_ITERATIONS } from '../../../src/runbook/compiler.js';
import type { ForContext } from '../../../src/runbook/types.js';
import { brandInitialTemplateVarsForTest } from '../../helpers/effective-vars.js';

function rangeCtx(overrides: Partial<ForContext> = {}): ForContext {
  return {
    stepId: '1',
    iteration: 2,
    start: 1,
    end: 5,
    variable: 'i',
    implicit: false,
    source: { kind: 'range' },
    ...overrides,
  };
}

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

interface RunResult {
  readonly status: 'done' | 'error';
  readonly output?: unknown;
  readonly error?: unknown;
}

async function runActor(input: ForIterateInput): Promise<RunResult> {
  const actor = createActor(forIterateActor, { input });
  const result = new Promise<RunResult>((resolve) => {
    actor.subscribe({
      next: (snap) => {
        if (snap.status === 'done') resolve({ status: 'done', output: snap.output });
        if (snap.status === 'error') resolve({ status: 'error', error: snap.error });
      },
      error: (error) => resolve({ status: 'error', error }),
    });
  });
  actor.start();
  return await result;
}

describe('forIterateActor', () => {
  it('emits kind=ready with forValue and forIndex for range source', async () => {
    const result = await runActor({
      forContext: rangeCtx({ iteration: 3 }),
      templateVars: brandInitialTemplateVarsForTest({}),
      cwd: '/tmp',
    });

    expect(result.status).toBe('done');
    expect(result.output).toEqual({
      kind: 'ready',
      forIndex: 3,
      forValue: '3',
    });
  });

  it('emits kind=ready with array value at 1-based forIndex', async () => {
    const result = await runActor({
      forContext: variableCtx({ iteration: 2 }),
      templateVars: brandInitialTemplateVarsForTest({ items: ['a', 'b', 'c'] }),
      cwd: '/tmp',
    });

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({ kind: 'ready', forIndex: 2, forValue: 'b' });
  });

  it('emits kind=ready with total populated when array length is known', async () => {
    const result = await runActor({
      forContext: variableCtx({ iteration: 1 }),
      templateVars: brandInitialTemplateVarsForTest({ items: ['a', 'b', 'c'] }),
      cwd: '/tmp',
    });

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({ kind: 'ready', total: 3 });
  });

  it('emits kind=exhausted when array depleted', async () => {
    const result = await runActor({
      forContext: variableCtx({ iteration: 4, end: 10 }),
      templateVars: brandInitialTemplateVarsForTest({ items: ['a', 'b', 'c'] }),
      cwd: '/tmp',
    });

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ kind: 'exhausted', forIndex: 4 });
  });

  it('rejects with ForResolutionError code preserved on undefined variable', async () => {
    const result = await runActor({
      forContext: variableCtx({ source: { kind: 'variable', name: 'items' } }),
      templateVars: brandInitialTemplateVarsForTest({}),
      cwd: '/tmp',
    });

    expect(result.status).toBe('error');
    expect((result.error as { code?: string }).code).toBe('undefined-variable');
  });

  it('short-circuits when currentValue is already populated (rehydration idempotency)', async () => {
    const result = await runActor({
      forContext: variableCtx({ iteration: 2, currentValue: 'b' }),
      templateVars: brandInitialTemplateVarsForTest({ items: ['a', 'b', 'c'] }),
      cwd: '/tmp',
    });

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({ kind: 'ready', forIndex: 2, forValue: 'b' });
  });

  it('short-circuits implicit 1..1 loops without consulting templateVars', async () => {
    const result = await runActor({
      forContext: variableCtx({ iteration: 1, implicit: true }),
      templateVars: brandInitialTemplateVarsForTest({}),
      cwd: '/tmp',
    });

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({ kind: 'ready', forIndex: 1, forValue: '1' });
  });

  it('is idempotent: same input produces equal output on repeated invocation', async () => {
    const input = {
      forContext: variableCtx({ iteration: 2 }),
      templateVars: brandInitialTemplateVarsForTest({ items: ['a', 'b', 'c'] }),
      cwd: '/tmp',
    };
    const a = await runActor(input);
    const b = await runActor(input);

    expect(a).toEqual(b);
  });
});

describe('forIterateActor: iteration cap (defence in depth)', () => {
  it('returns kind=exhausted without consulting the resolver when iteration > MAX_FILE_ITERATIONS', async () => {
    const result = await runActor({
      forContext: variableCtx({ iteration: MAX_FILE_ITERATIONS + 1 }),
      templateVars: brandInitialTemplateVarsForTest({ items: ['a', 'b', 'c'] }),
      cwd: '/tmp',
    });

    expect(result.status).toBe('done');
    expect(result.output).toEqual({
      kind: 'exhausted',
      forIndex: MAX_FILE_ITERATIONS + 1,
    });
  });

  it('does not short-circuit at iteration === MAX_FILE_ITERATIONS', async () => {
    const result = await runActor({
      forContext: variableCtx({ iteration: MAX_FILE_ITERATIONS }),
      templateVars: brandInitialTemplateVarsForTest({}),
      cwd: '/tmp',
    });

    expect(result.status).toBe('error');
    expect((result.error as { code?: string }).code).toBe('undefined-variable');
  });
});
