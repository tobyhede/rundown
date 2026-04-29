import { describe, it, expect } from '@jest/globals';
import { resolveCallerIdentity } from '../../src/helpers/caller-identity.js';

describe('resolveCallerIdentity', () => {
  it('returns anonymous when no agent env is present', () => {
    expect(resolveCallerIdentity({})).toEqual({ kind: 'anonymous' });
  });

  it('returns agent-session identity when agent and session are present', () => {
    expect(resolveCallerIdentity({ RD_AGENT_ID: 'agent-a', RD_SESSION_ID: 'session-a' })).toEqual({
      kind: 'identified',
      identity: { kind: 'agent-session', agent_id: 'agent-a', session_id: 'session-a' },
    });
  });

  it('returns agent-only identity when only agent is present', () => {
    expect(resolveCallerIdentity({ RD_AGENT_ID: 'agent-a' })).toEqual({
      kind: 'identified',
      identity: { kind: 'agent-only', agent_id: 'agent-a' },
    });
  });

  it('rejects blank agent id', () => {
    expect(resolveCallerIdentity({ RD_AGENT_ID: '   ' })).toEqual({
      kind: 'invalid',
      message: 'RD_AGENT_ID must not be blank when provided',
    });
  });

  it('rejects session id without agent id', () => {
    expect(resolveCallerIdentity({ RD_SESSION_ID: 'session-a' })).toEqual({
      kind: 'invalid',
      message: 'RD_SESSION_ID requires RD_AGENT_ID',
    });
  });

  it('rejects whitespace-only session id when agent id is present', () => {
    expect(resolveCallerIdentity({ RD_AGENT_ID: 'agent-a', RD_SESSION_ID: '   ' })).toEqual({
      kind: 'invalid',
      message: 'RD_SESSION_ID must not be blank when provided',
    });
  });
});
