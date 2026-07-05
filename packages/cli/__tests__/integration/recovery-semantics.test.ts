import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createRunbook,
  createTestWorkspace,
  findActionOutput,
  getActiveState,
  parseCliJsonObject,
  readRunbookState,
  runCli,
  runCliInProcess,
  type TestWorkspace,
  withRunTarget,
} from '../helpers/test-utils.js';

describe('recovery semantics for delegated command infrastructure stops', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function writePolicyDeniedParentAndChild(): Promise<void> {
    await writeFile(
      join(workspace.cwd, 'parent.runbook.md'),
      createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Delegate work',
            pass: 'CONTINUE',
            fail: 'STOP',
            substeps: [
              {
                title: 'Child',
                delegate: true,
                runbooks: ['child.runbook.md'],
                content: 'Child should be recoverable.',
              },
            ],
          },
          { title: 'Done', pass: 'COMPLETE', content: 'Done.' },
        ],
      }),
    );
    const child = [
      '# Child',
      '',
      '## 1. Denied command',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      '```bash',
      'node -e "console.log(42)"',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'child.runbook.md'), child);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), child);
  }

  it('does not report delegated fail when a child command is policy denied', async () => {
    await writePolicyDeniedParentAndChild();

    const start = runCli('run parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const parentId = (await getActiveState(workspace))!.id;
    const token = (await getActiveState(workspace))!.substepStates?.[0]?.delegation?.token;
    expect(token).toMatch(/^rdtk_/);

    const claim = await runCliInProcess(['claim', String(token), '--deny-all'], workspace);
    expect(claim.exitCode).toBe(1);
    const claimPayload = findActionOutput(claim.stdout);
    const claimId = String(claimPayload!.claim_id);
    const childRunId = String(claimPayload!.run_id);
    expect(claimId).toMatch(/^rdclm_/);

    const child = await readRunbookState(workspace, childRunId);
    expect(child?.lifecycle).toBe('stopped');
    expect(child?.lastAction).toEqual(expect.objectContaining({ type: 'POLICY_DENIED' }));

    const parent = await readRunbookState(workspace, parentId);
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
      (row) => row.agentId === 'delegation',
    );
    expect(rows).toHaveLength(0);
    const entry = parent!.substepStates?.find((state) => state.id === '1');
    expect(entry?.delegation?.childRunId).toBe(childRunId);
    expect(entry?.result).toBeUndefined();
  });

  it('retries after policy-denied child terminal without full parent restart', async () => {
    await writePolicyDeniedParentAndChild();

    const start = runCli('run parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const parentId = (await getActiveState(workspace))!.id;
    const token = String((await getActiveState(workspace))!.substepStates?.[0]?.delegation?.token);

    const claim = await runCliInProcess(['claim', token, '--deny-all'], workspace);
    const claimPayload = findActionOutput(claim.stdout)!;
    expect(String(claimPayload.claim_id)).toMatch(/^rdclm_/);

    const retry = await runCliInProcess(
      await withRunTarget(['delegate', '--retry', token], workspace),
      workspace,
    );

    expect(retry.exitCode).toBe(0);
    const retryPayload = parseCliJsonObject(retry.stdout);
    expect(retryPayload).toEqual(expect.objectContaining({ action: 'retried' }));
    expect(String(retryPayload.token)).toMatch(/^rdtk_/);
    const parent = await readRunbookState(workspace, parentId);
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
      (row) => row.agentId === 'delegation',
    );
    expect(rows).toHaveLength(0);
  });

  it('force-aborts a policy-denied linked child without recording delegated fail', async () => {
    await writePolicyDeniedParentAndChild();

    const start = runCli('run parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const parentId = (await getActiveState(workspace))!.id;
    const token = String((await getActiveState(workspace))!.substepStates?.[0]?.delegation?.token);

    const claim = await runCliInProcess(['claim', token, '--deny-all'], workspace);
    expect(claim.exitCode).toBe(1);
    const claimPayload = findActionOutput(claim.stdout)!;
    const childRunId = String(claimPayload.run_id);
    const child = await readRunbookState(workspace, childRunId);
    expect(child?.lastAction).toEqual(expect.objectContaining({ type: 'POLICY_DENIED' }));

    const abort = await runCliInProcess(['abort', token, '--force'], workspace);
    expect(abort.exitCode).toBe(0);
    expect(`${abort.stdout}${abort.stderr}`).not.toContain('RD-812');

    const parent = await readRunbookState(workspace, parentId);
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
      (row) => row.agentId === 'delegation',
    );
    expect(rows).toHaveLength(0);
    const entry = parent!.substepStates?.find((state) => state.id === '1');
    expect(entry?.delegation?.cancelledAt).not.toBeNull();
  });
});
