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
const { storeStepOutputs } = await import('../../src/helpers/step-outputs');

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
});
