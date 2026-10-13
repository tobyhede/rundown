import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const LEGACY_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

afterAll(() => {
  if (ORIGINAL_PLUGIN_ROOT === undefined) {
    delete process.env.CLAUDE_PLUGIN_ROOT;
  } else {
    process.env.CLAUDE_PLUGIN_ROOT = ORIGINAL_PLUGIN_ROOT;
  }
});

describe('minimal dispatch contract (inert delegation hooks, #901)', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'rd-contract-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /** Plant the pre-#901 per-agent token map a stale workspace might still carry. */
  async function plantStaleDelegationMetadata(agentId = 'agent-1'): Promise<void> {
    const session = new Session(cwd);
    await session.set('metadata', {
      delegation_active_tokens: {
        [agentId]: {
          kind: 'delegation-active-token',
          agent_id: agentId,
          tokenHash: `sha256:${'a'.repeat(64)}`,
          createdAt: '2026-06-08T00:00:00.000Z',
        },
      },
    });
  }

  it('PreToolUse(Agent) carrying a claim marker is allowed with no context (TODO #907)', async () => {
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'Agent',
      tool_input: { prompt: `Do work. RD_CLAIM_TOKEN=${LEGACY_TOKEN}` },
    };
    const result = await dispatch(input);
    expect(result).toStrictEqual({});
  });

  it('SubagentStop is allowed even over stale delegation metadata (TODO #907)', async () => {
    await plantStaleDelegationMetadata();
    const input: HookInput = { hook_event_name: 'SubagentStop', cwd, agent_id: 'agent-1' };
    const result = await dispatch(input);
    expect(result).toStrictEqual({});
  });

  it('PreToolUse(Bash) is not routed: a bare `rundown pass` reaches the CLI untouched', async () => {
    // The CLI is the authority gate (TOKEN_REQUIRED on a bare mutation). The
    // plugin does not intercept Bash in T1; #907 adds the claim/release
    // `--agent-id` stamping hook, which is a rewrite, not a refusal.
    await plantStaleDelegationMetadata();
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'Bash',
      agent_id: 'agent-1',
      tool_input: { command: 'rundown pass' },
    };
    const result = await dispatch(input);
    expect(result).toStrictEqual({});
  });
});
