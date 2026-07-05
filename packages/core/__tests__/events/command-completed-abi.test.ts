import { describe, it, expect } from '@jest/globals';
import { commandCompletedEffect } from '../../src/events/execution-observation.js';

describe('commandCompletedEffect ABI propagation', () => {
  it('copies landlockAbi and enforcementDowngraded into the payload', () => {
    const effect = commandCompletedEffect({
      kind: 'completed',
      command: 'echo hi',
      displayCommand: 'echo hi',
      success: true,
      result: 'pass',
      exitCode: 0,
      sandboxed: true,
      landlockAbi: 3,
      enforcementDowngraded: false,
      networkPolicy: 'deny',
      networkSandboxed: true,
      channels: [],
      position: { current: '1', total: 1 },
    });
    expect(effect.event.type).toBe('COMMAND_COMPLETED');
    if (effect.event.type === 'COMMAND_COMPLETED') {
      expect(effect.event.payload.landlockAbi).toBe(3);
      expect(effect.event.payload.enforcementDowngraded).toBe(false);
      expect(effect.event.payload.networkPolicy).toBe('deny');
      expect(effect.event.payload.networkSandboxed).toBe(true);
    }
  });
});
