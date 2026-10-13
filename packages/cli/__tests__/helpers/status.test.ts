import { describe, it, expect } from '@jest/globals';
import { getStatus } from '../../src/helpers/status.js';

describe('getStatus', () => {
  it('returns "running" for a state without a lifecycle (legacy default)', () => {
    expect(getStatus({})).toBe('running');
  });

  it('returns "running" when lifecycle is running', () => {
    expect(getStatus({ lifecycle: 'running' })).toBe('running');
  });

  it('returns "complete" when state is completed', () => {
    expect(getStatus({ lifecycle: 'completed' })).toBe('complete');
  });

  it('returns "stopped" when state is stopped', () => {
    expect(getStatus({ lifecycle: 'stopped' })).toBe('stopped');
  });

  it('returns "abandoned" when state is abandoned', () => {
    expect(getStatus({ lifecycle: 'abandoned' })).toBe('abandoned');
  });
});
