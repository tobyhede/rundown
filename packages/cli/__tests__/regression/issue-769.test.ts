import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
  requireLatestFrontierToken,
  findActionOutput,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import {
  patchPersistedRunState,
  seedSession,
} from '@rundown-org/core/testing/session-fixtures';

describe("issue #769: text status agrees with JSON for a terminal claim", () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function setupTerminalClaim() {
    const parentRunbook = [
      '# Parent Secret',
      '',
      '## 1. Fan out',
      '',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Child',
      '',
      '- DELEGATE',
      '',
      'Do child.',
      '',
      '- runbooks/child-secret.runbook.md',
      '',
    ].join('\n');
    const childRunbook = [
      '# Child Secret',
      '',
      '## 1. Work',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      'Do child work.',
      '',
    ].join('\n');

    await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
    await writeFile(join(workspace.cwd, 'runbooks', 'parent-secret.md'), parentRunbook);
    await writeFile(join(workspace.cwd, 'runbooks', 'child-secret.runbook.md'), childRunbook);

    await runCliInProcess('run --prompted runbooks/parent-secret.md', workspace);
    const token = requireLatestFrontierToken(workspace, '1.1');
    const claimed = await runCliInProcess(`claim ${token}`, workspace);
    const claimOutput = findActionOutput(claimed.stdout);
    if (!claimOutput || typeof claimOutput.run_id !== 'string') {
      throw new Error('Expected claim output to include run_id');
    }
    if (typeof claimOutput.claim_id !== 'string') {
      throw new Error('Expected claim output to include claim_id');
    }
    const childRunId = claimOutput.run_id;
    const claimId = claimOutput.claim_id;

    // Do NOT stash; just return the claimed terminal child
    return { childRunId, claimId };
  }

  it('--text reports terminal claim as completed, not "No active runbook"', async () => {
    const { childRunId, claimId } = await setupTerminalClaim();
    await patchPersistedRunState(workspace.cwd, childRunId, {
      lifecycle: 'completed',
    });

    const status = await runCliInProcess(['status', '--claim-id', claimId, '--text'], workspace);

    expect(status.exitCode).toBe(0);
    expect(status.stdout).not.toContain('No active runbook');
    expect(status.stdout).toContain('COMPLETE');
  });
});
