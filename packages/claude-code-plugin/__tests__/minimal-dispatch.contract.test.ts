import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashDelegationToken } from '@rundown-org/core';

// ESM under ts-jest: bare __dirname is undefined, so derive it from import.meta.url
// BEFORE any path.resolve(__dirname, ...) or top-level await import.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The dispatcher resolves its fixed gates relative to CLAUDE_PLUGIN_ROOT.
// Capture the original so we can restore it (shared Jest workers run files
// sequentially in one process — an unrestored mutation can bleed across suites).
const ORIGINAL_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
process.env.CLAUDE_PLUGIN_ROOT = path.resolve(__dirname, '..');
const { dispatch } = await import('../src/dispatcher.js');
const { Session } = await import('../src/session.js');
import type { HookInput } from '../src/shared/index.js';

const TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

afterAll(() => {
  if (ORIGINAL_PLUGIN_ROOT === undefined) {
    delete process.env.CLAUDE_PLUGIN_ROOT;
  } else {
    process.env.CLAUDE_PLUGIN_ROOT = ORIGINAL_PLUGIN_ROOT;
  }
});

describe('minimal dispatch contract (run + delegate)', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'rd-contract-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function markDelegated(agentId = 'agent-1'): Promise<void> {
    const session = new Session(cwd);
    await session.set('metadata', {
      delegation_active_tokens: {
        [agentId]: {
          kind: 'delegation-active-token',
          agent_id: agentId,
          tokenHash: hashDelegationToken(TOKEN),
          createdAt: '2026-06-08T00:00:00.000Z',
        },
      },
    });
  }

  it('PreToolUse(Agent) carrying a delegation token injects claim context', async () => {
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'Agent',
      tool_input: { prompt: `Do work. RD_CLAIM_TOKEN=${TOKEN}` },
    };
    const result = await dispatch(input);
    expect(result.context ?? '').toMatch(/rd claim/);
    expect(result.blockReason).toBeUndefined();
  });

  it('SubagentStop with an unclosed delegation and no rundown state blocks for closure', async () => {
    await markDelegated();
    const input: HookInput = { hook_event_name: 'SubagentStop', cwd, agent_id: 'agent-1' };
    const result = await dispatch(input);
    expect(result.blockReason).toMatch(/rd status|claim-id|close/i);
  });

  it('PreToolUse(Bash) is no longer routed (delegation closure is enforced by core)', async () => {
    // The plugin intentionally does NOT intercept Bash anymore. Core's
    // resolveTransitionTarget is the authoritative refusal for a bare parent
    // transition while delegated children are open. Even with an active
    // delegation marked on the session, a bare `rd pass` Bash command must pass
    // through the plugin untouched — no block, no context, no stop.
    await markDelegated();
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'Bash',
      agent_id: 'agent-1',
      tool_input: { command: 'rd pass' },
    };
    const result = await dispatch(input);
    expect(result).toEqual({});
  });
});
