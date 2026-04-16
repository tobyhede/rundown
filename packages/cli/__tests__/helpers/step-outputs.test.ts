import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers';

jest.unstable_mockModule('@rundown-org/core', () => ({
  storeContextOutputs: jest.fn().mockResolvedValue(undefined),
  logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
  ...mockErrorHelpers,
}));

jest.unstable_mockModule('../../src/services/template-renderer', () => ({
  evaluateOutputExpression: jest.fn(),
}));

const core = await import('@rundown-org/core');
const { evaluateOutputExpression } = await import('../../src/services/template-renderer');
const { storeStepOutputs, storeFrontmatterOutputs } = await import(
  '../../src/helpers/step-outputs'
);

describe('storeStepOutputs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores evaluated outputs to context when all expressions succeed', async () => {
    (evaluateOutputExpression as jest.Mock).mockReturnValue('value');
    await storeStepOutputs([{ name: 'A', value: '{{ x }}' }], { ContextId: 'c' }, '/cwd');
    expect(core.storeContextOutputs).toHaveBeenCalledWith('/cwd', 'c', { A: 'value' });
  });

  it('skips storage and emits ERROR_OCCURRED when every expression fails', async () => {
    (evaluateOutputExpression as jest.Mock).mockImplementation(() => {
      throw new Error('bad expr');
    });
    const emitter = { emit: jest.fn() };
    await storeStepOutputs(
      [{ name: 'A', value: '{{ bad }}' }],
      { ContextId: 'c' },
      '/cwd',
      emitter as any,
    );
    expect(core.storeContextOutputs).not.toHaveBeenCalled();
    expect(emitter.emit).toHaveBeenCalledWith(
      'ERROR_OCCURRED',
      expect.objectContaining({
        code: 'OUTPUTS_EVAL_FAILED',
        message: expect.stringMatching(/OUTPUTS evaluation failed for "A"/),
      }),
    );
    // Final summary emit when nothing was stored
    expect(emitter.emit).toHaveBeenCalledWith(
      'ERROR_OCCURRED',
      expect.objectContaining({
        code: 'OUTPUTS_EVAL_FAILED',
        message: expect.stringMatching(/all OUTPUTS declarations failed/),
      }),
    );
  });

  it('partial failure still stores successful outputs and emits per-failure events', async () => {
    (evaluateOutputExpression as jest.Mock).mockImplementation((value: string) => {
      if (value === 'good') return 'ok';
      throw new Error('bad expr');
    });
    const emitter = { emit: jest.fn() };
    await storeStepOutputs(
      [
        { name: 'OK', value: 'good' },
        { name: 'BAD', value: 'bad' },
      ],
      { ContextId: 'c' },
      '/cwd',
      emitter as any,
    );
    expect(core.storeContextOutputs).toHaveBeenCalledWith('/cwd', 'c', { OK: 'ok' });
    // Exactly one per-expression failure event, no final summary
    expect(emitter.emit).toHaveBeenCalledTimes(1);
    expect(emitter.emit).toHaveBeenCalledWith(
      'ERROR_OCCURRED',
      expect.objectContaining({
        message: expect.stringMatching(/OUTPUTS evaluation failed for "BAD"/),
      }),
    );
  });

  it('does not throw when emitter omitted (backward-compatible)', async () => {
    (evaluateOutputExpression as jest.Mock).mockImplementation(() => {
      throw new Error('bad expr');
    });
    await expect(
      storeStepOutputs([{ name: 'A', value: 'x' }], { ContextId: 'c' }, '/cwd'),
    ).resolves.toBeUndefined();
  });

  it('skips entries with undefined value (naked form guard)', async () => {
    (evaluateOutputExpression as jest.Mock).mockReturnValue('val');
    await storeStepOutputs(
      [{ name: 'NakedEntry' }], // no value — step-level naked is invalid; guarded defensively
      { ContextId: 'c' },
      '/cwd',
    );
    expect(core.storeContextOutputs).not.toHaveBeenCalled();
    expect(evaluateOutputExpression).not.toHaveBeenCalled();
  });
});

describe('storeFrontmatterOutputs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores naked-form value from templateVars', async () => {
    await storeFrontmatterOutputs(
      [{ name: 'PlanPath' }],
      { ContextId: 'c', PlanPath: '/tmp/plan.json' },
      '/cwd',
    );
    expect(core.storeContextOutputs).toHaveBeenCalledWith('/cwd', 'c', {
      PlanPath: '/tmp/plan.json',
    });
  });

  it('stores with-value form by evaluating expression', async () => {
    (evaluateOutputExpression as jest.Mock).mockReturnValue('/evaluated/path');
    await storeFrontmatterOutputs(
      [{ name: 'Out', value: '{{ path "result.json" }}' }],
      { ContextId: 'c' },
      '/cwd',
    );
    expect(evaluateOutputExpression).toHaveBeenCalled();
    expect(core.storeContextOutputs).toHaveBeenCalledWith('/cwd', 'c', {
      Out: '/evaluated/path',
    });
  });

  it('skips naked entry when variable is absent from templateVars', async () => {
    await storeFrontmatterOutputs([{ name: 'Missing' }], { ContextId: 'c' }, '/cwd');
    expect(core.storeContextOutputs).not.toHaveBeenCalled();
  });

  it('skips naked entry when variable is null', async () => {
    await storeFrontmatterOutputs([{ name: 'NullVar' }], { ContextId: 'c', NullVar: null }, '/cwd');
    expect(core.storeContextOutputs).not.toHaveBeenCalled();
  });

  it('skips naked entry for non-scalar (object) value', async () => {
    await storeFrontmatterOutputs(
      [{ name: 'Obj' }],
      { ContextId: 'c', Obj: { nested: true } },
      '/cwd',
    );
    expect(core.storeContextOutputs).not.toHaveBeenCalled();
  });

  it('converts numeric naked value to string', async () => {
    await storeFrontmatterOutputs([{ name: 'Port' }], { ContextId: 'c', Port: 3000 }, '/cwd');
    expect(core.storeContextOutputs).toHaveBeenCalledWith('/cwd', 'c', { Port: '3000' });
  });

  it('converts boolean naked value to string', async () => {
    await storeFrontmatterOutputs([{ name: 'Flag' }], { ContextId: 'c', Flag: true }, '/cwd');
    expect(core.storeContextOutputs).toHaveBeenCalledWith('/cwd', 'c', { Flag: 'true' });
  });

  it('returns early when templateVars is undefined', async () => {
    await storeFrontmatterOutputs([{ name: 'PlanPath' }], undefined, '/cwd');
    expect(core.storeContextOutputs).not.toHaveBeenCalled();
  });

  it('returns early when ContextId is missing', async () => {
    await storeFrontmatterOutputs([{ name: 'PlanPath' }], { PlanPath: '/tmp/p' }, '/cwd');
    expect(core.storeContextOutputs).not.toHaveBeenCalled();
  });

  it('emits ERROR_OCCURRED and skips entry when expression evaluation fails', async () => {
    (evaluateOutputExpression as jest.Mock).mockImplementation(() => {
      throw new Error('bad template');
    });
    const emitter = { emit: jest.fn() };
    await storeFrontmatterOutputs(
      [{ name: 'Out', value: '{{ bad }}' }],
      { ContextId: 'c' },
      '/cwd',
      emitter as any,
    );
    expect(core.storeContextOutputs).not.toHaveBeenCalled();
    expect(emitter.emit).toHaveBeenCalledWith(
      'ERROR_OCCURRED',
      expect.objectContaining({ code: 'OUTPUTS_EVAL_FAILED' }),
    );
  });

  it('emits ERROR_OCCURRED and does not throw when persistence fails', async () => {
    (core.storeContextOutputs as jest.Mock).mockRejectedValue(new Error('disk full'));
    const emitter = { emit: jest.fn() };
    await storeFrontmatterOutputs(
      [{ name: 'PlanPath' }],
      { ContextId: 'c', PlanPath: '/tmp/plan.json' },
      '/cwd',
      emitter as any,
    );
    expect(emitter.emit).toHaveBeenCalledWith(
      'ERROR_OCCURRED',
      expect.objectContaining({ code: 'OUTPUTS_PERSIST_FAILED' }),
    );
  });
});
