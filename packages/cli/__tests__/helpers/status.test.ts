import { describe, it, expect } from '@jest/globals';
import { getStatus } from '../../src/helpers/status.js';
import type { Lifecycle } from '@rundown-org/core';

describe('getStatus', () => {
  const makeState = (id: string, lifecycle?: Lifecycle) => ({
    id,
    lifecycle,
  });

  it('returns "active" when state matches active runbook', () => {
    const state = makeState('run-1');
    expect(getStatus(state, { id: 'run-1' }, null)).toBe('active');
  });

  it('returns "stashed" when state matches stashed id', () => {
    const state = makeState('run-2');
    expect(getStatus(state, null, 'run-2')).toBe('stashed');
  });

  it('returns "complete" when state is completed', () => {
    const state = makeState('run-3', 'completed');
    expect(getStatus(state, null, null)).toBe('complete');
  });

  it('returns "stopped" when state is stopped', () => {
    const state = makeState('run-4', 'stopped');
    expect(getStatus(state, null, null)).toBe('stopped');
  });

  it('returns "inactive" when no conditions match', () => {
    const state = makeState('run-5');
    expect(getStatus(state, null, null)).toBe('inactive');
  });

  it('prioritizes active over stashed', () => {
    const state = makeState('run-6');
    expect(getStatus(state, { id: 'run-6' }, 'run-6')).toBe('active');
  });

  it('prioritizes stashed over completed', () => {
    const state = makeState('run-7', 'completed');
    expect(getStatus(state, null, 'run-7')).toBe('stashed');
  });

  it('prioritizes stashed over stopped', () => {
    const state = makeState('run-X', 'stopped');
    expect(getStatus(state, null, 'run-X')).toBe('stashed');
  });

  it('prioritizes completed over stopped (lifecycle field is canonical)', () => {
    const state = makeState('run-8', 'completed');
    expect(getStatus(state, null, null)).toBe('complete');
  });
});
