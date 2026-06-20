import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  getActiveState,
  parseCliJsonObject,
  parseConcatenatedJson,
  readRunbookState,
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

  it('ordinary abort (no --force) closes the delegation without a fail outcome or pending collection', async () => {
    const token = await setupDelegation();

    // Ordinary cancel of a pending (issued, not yet claimed) delegation.
    const abort = runCli(`abort ${token}`, workspace);
    expect(abort.exitCode).toBe(0);

    const parent = await getActiveState(workspace);
    // No delegation outcome row recorded — ordinary cancel synthesizes no fail.
    // This preserves the cancellation split (ordinary cancel != force-abort).
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
      (c) => c.agentId === 'delegation',
    );
    expect(rows).toHaveLength(0);

    // The delegating run is NOT collection pending: a bare advance is not
    // refused with DELEGATION_COLLECTION_PENDING (it may be refused for an
    // unrelated reason, but never for a pending reported outcome that does not
    // exist).
    const advance = runCli('pass', workspace);
    expect(`${advance.stdout}${advance.stderr}`).not.toContain('DELEGATION_COLLECTION_PENDING');
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

  it('claimed abort with --force records a fail outcome and leaves collection pending', async () => {
    const token = await setupDelegation();
    const parentId = (await getActiveState(workspace))!.id;

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

    // Plan 5 (report-only): force-abort records a FAIL outcome on the delegating
    // run and stops — it does NOT drain/apply/cascade. The recorded row leaves
    // the delegating run collection pending and does NOT advance it.
    const parent = await readRunbookState(workspace, parentId);
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
      (c) => c.agentId === 'delegation',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('fail');
    expect(parent!.step).toBe('1');

    // Collection pending: a bare advance is refused until `rd collect`.
    const blocked = runCli('pass', workspace);
    expect(blocked.exitCode).toBe(1);
    expect(`${blocked.stdout}${blocked.stderr}`).toContain('DELEGATION_COLLECTION_PENDING');
  });

  it('force abort inside a FOR iteration leaves that iteration frame collection pending', async () => {
    await writeChildRunbook();
    // A FOR step that fans out a single delegated substep per iteration. The
    // delegation linkage carries the iteration-scoped frame key, so the recorded
    // fail outcome (and the collection-pending guard) must key on that frame.
    const parentContent = [
      '# For Abort',
      '',
      '## 1. Process items',
      '',
      '- FOR i IN 1 TO 1',
      '  - PASS ALL CONTINUE',
      '  - FAIL ANY STOP',
      '- DELEGATE',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Work {{i}}',
      '',
      '- child.runbook.md',
      '',
      '## 2. Done',
      '',
      '- PASS COMPLETE',
      '',
      'All done.',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'for-abort.runbook.md'), parentContent);

    const start = runCli('run --prompted for-abort.runbook.md --text', workspace);
    expect(start.exitCode).toBe(0);

    // The FOR step has entered iteration 1; substep 1.1 auto-issued a token in
    // the iteration frame.
    const entered = await getActiveState(workspace);
    const parentId = entered!.id;
    const iterationSubstep = entered?.substepStates?.find((ss) => ss.delegation?.token);
    const token = iterationSubstep?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    if (typeof token !== 'string') throw new Error('Expected delegation token');

    // Claim (in-flight), then force abort.
    let result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    result = runCli(`abort ${token} --force`, workspace);
    expect(result.exitCode).toBe(0);

    const parent = await readRunbookState(workspace, parentId);
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
      (c) => c.agentId === 'delegation',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('fail');
    // The recorded row is keyed on the ITERATION frame, not a bare step frame.
    const recordedFrameSubstep = parent?.substepStates?.find((ss) => ss.id === '1');
    expect(rows[0]?.targetFrameKey).toBe(recordedFrameSubstep?.frameKey);

    // Bare advance refused — the iteration frame is collection pending.
    const blocked = runCli('pass', workspace);
    expect(blocked.exitCode).toBe(1);
    expect(`${blocked.stdout}${blocked.stderr}`).toContain('DELEGATION_COLLECTION_PENDING');
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
