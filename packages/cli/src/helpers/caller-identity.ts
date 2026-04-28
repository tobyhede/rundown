import type { AgentOwnerIdentity } from '@rundown-org/core';

/** Result of resolving CLI caller identity from environment variables. */
export type CallerIdentityResult =
  | { readonly kind: 'identified'; readonly identity: AgentOwnerIdentity }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'invalid'; readonly message: string };

/** Environment-like source used to read caller identity variables. */
export interface EnvSource {
  readonly [key: string]: string | undefined;
}

function readTrimmed(env: EnvSource, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  return raw.trim();
}

/**
 * Resolve the current CLI caller identity from canonical agent environment variables.
 *
 * @param env - Environment source containing optional `RD_AGENT_ID` and `RD_SESSION_ID`
 * @returns Caller identity resolution, including validation failures
 */
export function resolveCallerIdentity(env: EnvSource = process.env): CallerIdentityResult {
  const agentId = readTrimmed(env, 'RD_AGENT_ID');
  const sessionId = readTrimmed(env, 'RD_SESSION_ID');

  if (agentId === undefined) {
    if (sessionId === undefined) {
      return { kind: 'anonymous' };
    }
    return { kind: 'invalid', message: 'RD_SESSION_ID requires RD_AGENT_ID' };
  }

  if (agentId === '') {
    return { kind: 'invalid', message: 'RD_AGENT_ID must not be blank when provided' };
  }

  if (sessionId === '') {
    return { kind: 'invalid', message: 'RD_SESSION_ID must not be blank when provided' };
  }

  if (sessionId !== undefined) {
    return {
      kind: 'identified',
      identity: { kind: 'agent-session', agent_id: agentId, session_id: sessionId },
    };
  }

  return { kind: 'identified', identity: { kind: 'agent-only', agent_id: agentId } };
}
