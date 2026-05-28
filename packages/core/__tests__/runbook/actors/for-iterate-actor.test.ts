import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createActor } from 'xstate';
import {
  forIterateActor,
  type ForIterateInput,
} from '../../../src/runbook/actors/for-iterate-actor.js';
import { MAX_FILE_ITERATIONS } from '../../../src/runbook/compiler.js';
import { createJsonArrayStream, type ForContext } from '../../../src/runbook/types.js';
import { computeFileSnapshot } from '../../../src/runbook/file-provider.js';
import { canonicalProjectRootSyncForTest } from '../../helpers/canonical-paths.js';
import { brandEffectiveVarsForTest } from '../../../src/testing/effective-vars.js';

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
      error: (error) => {
        resolve({ status: 'error', error });
      },
    });
  });
  actor.start();
  return await result;
}

describe('forIterateActor', () => {
  it('emits kind=ready with forValue and forIndex for range source', async () => {
    const result = await runActor({
      forContext: rangeCtx({ iteration: 3 }),
      templateVars: brandEffectiveVarsForTest({}),
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
      templateVars: brandEffectiveVarsForTest({ items: ['a', 'b', 'c'] }),
      cwd: '/tmp',
    });

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({ kind: 'ready', forIndex: 2, forValue: 'b' });
  });

  it('emits kind=ready with total populated when array length is known', async () => {
    const result = await runActor({
      forContext: variableCtx({ iteration: 1 }),
      templateVars: brandEffectiveVarsForTest({ items: ['a', 'b', 'c'] }),
      cwd: '/tmp',
    });

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({ kind: 'ready', total: 3 });
  });

  it('emits kind=exhausted when array depleted', async () => {
    const result = await runActor({
      forContext: variableCtx({ iteration: 4, end: 10 }),
      templateVars: brandEffectiveVarsForTest({ items: ['a', 'b', 'c'] }),
      cwd: '/tmp',
    });

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ kind: 'exhausted', forIndex: 4 });
  });

  it('rejects with ForResolutionError code preserved on undefined variable', async () => {
    const result = await runActor({
      forContext: variableCtx({ source: { kind: 'variable', name: 'items' } }),
      templateVars: brandEffectiveVarsForTest({}),
      cwd: '/tmp',
    });

    expect(result.status).toBe('error');
    expect((result.error as { code?: string }).code).toBe('undefined-variable');
  });

  it('short-circuits when currentValue is already populated (rehydration idempotency)', async () => {
    const result = await runActor({
      forContext: variableCtx({ iteration: 2, currentValue: 'b' }),
      templateVars: brandEffectiveVarsForTest({ items: ['a', 'b', 'c'] }),
      cwd: '/tmp',
    });

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({ kind: 'ready', forIndex: 2, forValue: 'b' });
  });

  it('short-circuits implicit 1..1 loops without consulting templateVars', async () => {
    const result = await runActor({
      forContext: variableCtx({ iteration: 1, implicit: true }),
      templateVars: brandEffectiveVarsForTest({}),
      cwd: '/tmp',
    });

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({ kind: 'ready', forIndex: 1, forValue: '1' });
  });

  it('is idempotent: same input produces equal output on repeated invocation', async () => {
    const input = {
      forContext: variableCtx({ iteration: 2 }),
      templateVars: brandEffectiveVarsForTest({ items: ['a', 'b', 'c'] }),
      cwd: '/tmp',
    };
    const a = await runActor(input);
    const b = await runActor(input);

    expect(a).toEqual(b);
  });
});

describe('forIterateActor: iteration cap (defense in depth)', () => {
  it('delegates high absolute JsonArray iterations to the resolver when the relative window is bounded', async () => {
    const highOffset = MAX_FILE_ITERATIONS + 2;
    const items = Array.from({ length: highOffset }, (_, index) => `item-${String(index + 1)}`);

    const result = await runActor({
      forContext: variableCtx({
        start: highOffset,
        iteration: highOffset,
        end: highOffset + 2,
      }),
      templateVars: brandEffectiveVarsForTest({ items }),
      cwd: '/tmp',
    });

    expect(result.status).toBe('done');
    expect(result.output).toEqual({
      kind: 'ready',
      forIndex: highOffset,
      forValue: `item-${String(highOffset)}`,
      total: highOffset,
    });
  });

  it('does not short-circuit at iteration === MAX_FILE_ITERATIONS', async () => {
    const result = await runActor({
      forContext: variableCtx({ iteration: MAX_FILE_ITERATIONS }),
      templateVars: brandEffectiveVarsForTest({}),
      cwd: '/tmp',
    });

    expect(result.status).toBe('error');
    expect((result.error as { code?: string }).code).toBe('undefined-variable');
  });

  describe('JsonArrayStream file source', () => {
    it('emits snapshot for JsonArrayStream sources', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-for-actor-stream-'));
      try {
        const projectRoot = canonicalProjectRootSyncForTest(tmpDir);
        const file = path.join(projectRoot, 'items.jsonl');
        fs.writeFileSync(file, '"first"\n"second"\n');

        const result = await runActor({
          forContext: variableCtx({
            iteration: 1,
            end: undefined,
            source: { kind: 'variable', name: 'items' },
          }),
          templateVars: brandEffectiveVarsForTest({ items: createJsonArrayStream(file) }),
          cwd: projectRoot,
        });

        expect(result.status).toBe('done');
        expect(result.output).toMatchObject({
          kind: 'ready',
          forIndex: 1,
          forValue: 'first',
          snapshot: {
            lastLine: 1,
          },
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('delegates high absolute JsonArrayStream iterations to the resolver when the relative window is bounded', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-iter-cap-'));
      try {
        const cwd = canonicalProjectRootSyncForTest(tmp);
        const highOffset = MAX_FILE_ITERATIONS + 2;
        const filePath = path.join(tmp, 'data.jsonl');
        const lines = Array.from({ length: highOffset }, (_, index) =>
          JSON.stringify({ n: index + 1 }),
        );
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`);

        const result = await runActor({
          forContext: variableCtx({
            start: highOffset,
            iteration: highOffset,
            end: highOffset + 2,
          }),
          templateVars: brandEffectiveVarsForTest({
            items: createJsonArrayStream(filePath),
          }),
          cwd,
        });

        expect(result.status).toBe('done');
        expect(result.output).toMatchObject({
          kind: 'ready',
          forIndex: highOffset,
          forValue: { n: highOffset },
          snapshot: {
            lastLine: highOffset,
          },
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('consults the resolver at iteration === MAX_FILE_ITERATIONS', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-iter-cap-'));
      try {
        const cwd = canonicalProjectRootSyncForTest(tmp);
        const filePath = path.join(tmp, 'data.jsonl');
        // Short stream — at iteration === MAX_FILE_ITERATIONS the resolver
        // should be consulted and report exhaustion based on the file
        // contents, not the safety cap.
        fs.writeFileSync(filePath, `${JSON.stringify({ n: 1 })}\n`);

        // A snapshot is required for iteration > start (fail-closed guard).
        // Compute one from the unchanged file to satisfy drift validation.
        const snapshot = await computeFileSnapshot(filePath, MAX_FILE_ITERATIONS - 1);
        const result = await runActor({
          forContext: variableCtx({ iteration: MAX_FILE_ITERATIONS, snapshot }),
          templateVars: brandEffectiveVarsForTest({
            items: createJsonArrayStream(filePath),
          }),
          cwd,
        });

        expect(result.status).toBe('done');
        expect(result.output).toMatchObject({ kind: 'exhausted' });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
