import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { dispatch } from '../src/dispatcher.js';
import type { HookInput } from '../src/shared/index.js';

const TICKET = `rdt_${'C'.repeat(43)}`;

// The plugin's fixed routes (#907): PreToolUse on Agent|Task and on Bash, and
// SubagentStop. Nothing else is routed, and no repository file is consulted.
describe('minimal dispatch contract (delegation hooks, #907)', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'rd-contract-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('PreToolUse(Agent) carrying a Claim Ticket marker is dispatched with the claim instructions', async () => {
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'Agent',
      tool_input: { prompt: `Do work.\nRD_CLAIM_TICKET=${TICKET}` },
    };
    const result = await dispatch(input);
    expect(String(result.updatedInput?.prompt)).toContain(`rundown claim ${TICKET}`);
  });

  it('SubagentStop holds nothing in a project with no Rundown store', async () => {
    const input: HookInput = { hook_event_name: 'SubagentStop', cwd, agent_id: 'agent-1' };
    await expect(dispatch(input)).resolves.toStrictEqual({});
  });

  it('PreToolUse(Bash) passes an ordinary command untouched: the CLI is the authority gate', async () => {
    // A bare `rundown pass` reaches the CLI, which refuses it TOKEN_REQUIRED;
    // the Bash hook only stamps --agent-id on claim and release.
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'Bash',
      agent_id: 'agent-1',
      tool_input: { command: 'rundown pass' },
    };
    await expect(dispatch(input)).resolves.toStrictEqual({});
  });

  it('routes no other event or tool', async () => {
    for (const input of [
      { hook_event_name: 'PostToolUse', cwd, tool_name: 'Bash' },
      { hook_event_name: 'PreToolUse', cwd, tool_name: 'Edit' },
      { hook_event_name: 'Stop', cwd },
    ] satisfies HookInput[]) {
      await expect(dispatch(input)).resolves.toStrictEqual({});
    }
  });
});
