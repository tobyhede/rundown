import { describe, it, expect } from '@jest/globals';
import { getStatus } from '../../src/helpers/status.js';

describe('getStatus', () => {
  const makeState = (id: string, opts: { completed?: boolean; stopped?: boolean } = {}) => ({
    id,
    variables: { completed: opts.completed, stopped: opts.stopped },
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
    const state = makeState('run-3', { completed: true });
    expect(getStatus(state, null, null)).toBe('complete');
  });

  it('returns "stopped" when state is stopped', () => {
    const state = makeState('run-4', { stopped: true });
    expect(getStatus(state, null, null)).toBe('stopped');
  });

  it('returns "inactive" when no conditions match', () => {
    const state = makeState('run-5');
    expect(getStatus(state, null, null)).toBe('inactive');
  });

  it('prioritises active over stashed', () => {
    const state = makeState('run-6');
    expect(getStatus(state, { id: 'run-6' }, 'run-6')).toBe('active');
  });

  it('prioritises stashed over completed', () => {
    const state = makeState('run-7', { completed: true });
    expect(getStatus(state, null, 'run-7')).toBe('stashed');
  });

  it('prioritises completed over stopped', () => {
    const state = makeState('run-8', { completed: true, stopped: true });
    expect(getStatus(state, null, null)).toBe('complete');
  });
});
