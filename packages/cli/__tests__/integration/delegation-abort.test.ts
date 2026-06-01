import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  getActiveState,
  parseCliJsonObject,
  parseConcatenatedJson,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Delegation abort integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function writeParentRunbook(): Promise<void> {
    const content = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Review',
          pass: 'CONTINUE',
          substeps: [
            {
              title: 'Code review',
              delegate: true,
              content: 'Do code review.',
              runbooks: ['child.runbook.md'],
            },
            {
              title: 'Security review',
              delegate: true,
              content: 'Do security review.',
              runbooks: ['child.runbook.md'],
            },
          ],
        },
        { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
  }

  async function writeChildRunbook(): Promise<void> {
    const content = createRunbook({
      title: 'Child',
      steps: [{ title: 'Execute', pass: 'COMPLETE', content: 'Run the child task.' }],
    });
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), content);
  }

  /** Helper: start parent, delegate, return token. */
  async function setupDelegation(): Promise<string> {
    await writeParentRunbook();
    await writeChildRunbook();

    const result = runCli('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);

    const state = await getActiveState(workspace);
    const token = state?.substepStates?.[0]?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    return token!;
  }

  it('rejects invalid token format', () => {
    const result = runCli('abort bad-token', workspace);
    expect(result.exitCode).toBe(1);
    const envelope = parseCliJsonObject(result.stdout || result.stderr);
    expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-807' }));
  });

  it('rejects unknown token', () => {
    // cspell:disable-next-line
    const result = runCli('abort rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', workspace);
    expect(result.exitCode).toBe(1);
    const envelope = parseCliJsonObject(result.stdout || result.stderr);
    expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-808' }));
  });

  it('renders text output for pending abort', async () => {
    const token = await setupDelegation();

    const result = runCli(`abort ${token} --text`, workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/CANCELLED/i);
  });

  it('claim after abort fails with RD-809', async () => {
    const token = await setupDelegation();

    // Abort the delegation
    let result = runCli(`abort ${token}`, workspace);
    expect(result.exitCode).toBe(0);

    // Try to claim — should fail
    result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(1);
    const envelope = parseCliJsonObject(result.stdout || result.stderr);
    expect(envelope).toEqual(
      expect.objectContaining({ kind: 'error', code: 'DELEGATION_CANCELLED' }),
    );
  });

  it('claimed abort without --force fails with RD-811', async () => {
    const token = await setupDelegation();

    // Claim the token
    let result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);

    // Try to abort without force — should fail
    result = runCli(`abort ${token}`, workspace);
    expect(result.exitCode).toBe(1);
    const envelope = parseCliJsonObject(result.stdout || result.stderr);
    expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-811' }));
  });

  it('claimed abort with --force succeeds', async () => {
    const token = await setupDelegation();

    // Claim the token
    let result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);

    // Force abort
    result = runCli(`abort ${token} --force`, workspace);
    expect(result.exitCode).toBe(0);
    const output = parseConcatenatedJson(result.stdout).find(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' &&
        value !== null &&
        (value as { action?: unknown }).action === 'abort',
    );
    expect(output).toBeDefined();
    expect(output).toEqual(expect.objectContaining({ action: 'abort', status: 'cancelled' }));
  });

  it('idempotent on already-cancelled', async () => {
    const token = await setupDelegation();

    // Abort twice
    let result = runCli(`abort ${token}`, workspace);
    expect(result.exitCode).toBe(0);

    result = runCli(`abort ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const output = parseCliJsonObject(result.stdout);
    expect(output).toEqual(
      expect.objectContaining({ action: 'abort', status: 'already_cancelled' }),
    );
  });

  it('JSON output structure', async () => {
    const token = await setupDelegation();

    const result = runCli(`abort ${token}`, workspace);
    expect(result.exitCode).toBe(0);

    const output = parseCliJsonObject(result.stdout);
    expect(output.action).toBe('abort');
    expect(output.status).toBe('cancelled');
    expect(output.token).toBeDefined();
    expect(output.substep).toBeDefined();
    expect(output.runbook).toContain('child.runbook.md');
    expect(output.parentRunId).toBeDefined();
  });
});
