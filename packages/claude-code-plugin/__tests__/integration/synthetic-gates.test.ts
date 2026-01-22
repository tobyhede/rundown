// packages/claude-code-plugin/__tests__/integration/synthetic-gates.test.ts
import { dispatch } from '../../src/dispatcher.js';
import type { HookInput } from '../../src/shared/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('synthetic event gates integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundown-test-synthetic-gates-'));
    fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('dispatches SkillStart through workflow-skill-start gate', async () => {
    const input: HookInput = {
      hook_event_name: 'SkillStart',
      skill: 'rundown:verify',
      cwd: testDir
    };

    // Should not throw - gate handles gracefully when skill not found
    const result = await dispatch(input);

    // No error means gate executed (skill not found is graceful degradation)
    expect(result.blockReason).toBeUndefined();
  });

  it('dispatches SubagentStart through workflow-subagent-start gate', async () => {
    const input: HookInput = {
      hook_event_name: 'SubagentStart',
      agent_id: 'test-agent-123',
      cwd: testDir
    };

    // Should not throw - gate handles gracefully when no workflow active
    const result = await dispatch(input);

    expect(result.blockReason).toBeUndefined();
  });

  it('dispatches SubagentStop through workflow-subagent-stop gate', async () => {
    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      agent_id: 'test-agent-123',
      cwd: testDir
    };

    // Should not throw - gate handles gracefully
    const result = await dispatch(input);

    expect(result.blockReason).toBeUndefined();
  });
});
