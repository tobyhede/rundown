/**
 * Which agent runs `rundown claim` / `rundown release` (#907, ADR 0005).
 *
 * The front end hands core every `--agent-id` the command line carried and
 * whether it runs inside Claude Code (the CLI reads `CLAUDECODE`); core
 * decides what they mean.
 */
import { describe, expect, it } from '@jest/globals';
import { resolveDelegationAgent } from '../../src/runbook/delegation-agent.js';

describe('resolveDelegationAgent', () => {
  it('takes the one --agent-id the command carried', () => {
    for (const insideClaudeCode of [false, true]) {
      for (const command of ['claim', 'release'] as const) {
        expect(
          resolveDelegationAgent({ agentIds: ['agent-1'], insideClaudeCode, command }),
        ).toEqual({ kind: 'resolved', agent: { kind: 'agent', agentId: 'agent-1' } });
      }
    }
  });

  it('is anonymous without one outside Claude Code (a person, Codex, MCP, the harness)', () => {
    for (const command of ['claim', 'release'] as const) {
      expect(resolveDelegationAgent({ agentIds: [], insideClaudeCode: false, command })).toEqual({
        kind: 'resolved',
        agent: { kind: 'anonymous' },
      });
    }
  });

  it('refuses a claim without one inside Claude Code AGENT_ID_REQUIRED, naming the plugin', () => {
    const refused = resolveDelegationAgent({
      agentIds: [],
      insideClaudeCode: true,
      command: 'claim',
    });
    expect(refused).toMatchObject({ kind: 'refused', code: 'AGENT_ID_REQUIRED' });
    expect(refused.kind === 'refused' && refused.message).toMatch(/plugin/);
    expect(refused.kind === 'refused' && refused.message).toMatch(/--agent-id/);
  });

  it('lets a release without one inside Claude Code match only a claim that recorded none', () => {
    expect(
      resolveDelegationAgent({ agentIds: [], insideClaudeCode: true, command: 'release' }),
    ).toEqual({ kind: 'resolved', agent: { kind: 'anonymous' } });
  });

  it('refuses more than one --agent-id INVALID_SYNTAX, never taking the last', () => {
    for (const agentIds of [
      ['sub-2', 'sub-1'],
      ['sub-1', 'sub-1'],
    ]) {
      const refused = resolveDelegationAgent({
        agentIds,
        insideClaudeCode: false,
        command: 'release',
      });
      expect(refused).toMatchObject({ kind: 'refused', code: 'INVALID_SYNTAX' });
      expect(refused.kind === 'refused' && refused.message).not.toContain('sub-1');
    }
  });

  it('refuses an empty --agent-id INVALID_SYNTAX', () => {
    expect(
      resolveDelegationAgent({ agentIds: [' '], insideClaudeCode: false, command: 'claim' }),
    ).toMatchObject({ kind: 'refused', code: 'INVALID_SYNTAX' });
  });
});
