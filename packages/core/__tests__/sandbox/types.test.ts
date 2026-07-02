import { describe, it, expect } from '@jest/globals';
import type { SandboxAvailability, SandboxExecutionResult } from '../../src/sandbox/types.js';

describe('sandbox DTO ABI fields', () => {
  it('SandboxAvailability carries the negotiated ABI', () => {
    const a: SandboxAvailability = {
      available: true,
      mechanism: 'landlock',
      platform: 'linux',
      supportsReadRestrictions: true,
      supportsWriteRestrictions: true,
      supportsDenyPaths: false,
      landlockAbi: 3,
    };
    expect(a.landlockAbi).toBe(3);
  });

  it('SandboxExecutionResult carries ABI + downgrade flag', () => {
    const r: SandboxExecutionResult = {
      success: true,
      exitCode: 0,
      sandboxed: true,
      landlockAbi: 3,
      enforcementDowngraded: false,
    };
    expect(r.landlockAbi).toBe(3);
    expect(r.enforcementDowngraded).toBe(false);
  });
});
