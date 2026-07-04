import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { buildFrameKey, DelegateResponseSchema, ErrorResponseSchema } from '@rundown-org/core';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  createTestWorkspace,
  extractToken,
  injectDelegationOutcomeForActiveRun,
  runCliInProcess,
  getActiveState,
  type TestWorkspace,
  createRunbook,
  parseCliJsonObject,
  parseConcatenatedJson,
  withRunTarget,
} from '../helpers/test-utils.js';

/**
 * Locate the `{ kind: 'error' }` envelope among the (possibly concatenated)
 * JSON objects a command emits — the fresh-issue path can prepend execution
 * events before the error object, so a single `JSON.parse` is not safe.
 */
function findErrorEnvelope(stdout: string): Record<string, unknown> | undefined {
  return parseConcatenatedJson(stdout).find(
    (o): o is Record<string, unknown> =>
      typeof o === 'object' && o !== null && (o as { kind?: string }).kind === 'error',
  );
}
// Static import of the command module under test. The behavioural tests below
// drive the command through `runCliInProcess`, which reaches it via a *dynamic*
// `import('../cli.js')` — an edge Stryker's `enableFindRelatedTests` (Jest's
// static inverse-module graph) cannot see. Without a static import here, a
// per-mutant `jest --findRelatedTests src/commands/delegate.ts` matches no test
// file, so Stryker runs zero tests per mutant and every mutant falsely survives
// (0.00% score). This static edge links the file into the graph so the covering
// tests actually run against each mutant.
import { registerDelegateCommand } from '../../src/commands/delegate.js';

describe('delegate command wiring', () => {
  it('registers the delegate command with its documented flags, descriptions, and defaults', () => {
    const program = new Command();
    registerDelegateCommand(program);

    const delegate = program.commands.find((c) => c.name() === 'delegate');
    expect(delegate).toBeDefined();
    expect(delegate?.description()).toBe('Create a delegation token for a child runbook');

    const byLong = new Map(delegate!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(
      expect.arrayContaining([
        '--step',
        '--index',
        '--retry',
        '--input',
        '--input-json',
        '--input-file',
        '--artifacts',
        '--artifacts-json',
        '--text',
      ]),
    );

    // Pin each option's help text so a mutated description string is killed.
    expect(byLong.get('--step')?.description).toBe(
      'Step to delegate (e.g., 1.1 or 1.2.1 for step.iteration.substep)',
    );
    expect(byLong.get('--index')?.description).toBe(
      'FOR loop iteration to target (requires --step)',
    );
    expect(byLong.get('--retry')?.description).toBe(
      'Retry an existing delegation: cancel and re-issue with a fresh token',
    );
    expect(byLong.get('--input')?.description).toBe(
      'Set input for child context (repeatable, omit =value to inherit from env)',
    );
    expect(byLong.get('--input-json')?.description).toBe('Set input with JSON value (repeatable)');
    expect(byLong.get('--input-file')?.description).toBe('Load inputs from YAML file (repeatable)');
    expect(byLong.get('--artifacts')?.description).toBe(
      'Supply an input artifact by rd:// URI (repeatable)',
    );
    expect(byLong.get('--artifacts-json')?.description).toBe(
      'Supply input artifacts as a JSON array of rd:// URIs (repeatable)',
    );
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');

    // The five repeatable input/artifact channels default to an empty array so
    // the argParsers accumulate; pin the default so a mutated `.default([])` dies.
    // They also share the 'Input options:' help group; pin that so a mutated
    // `.helpGroup(...)` heading is killed.
    for (const long of [
      '--input',
      '--input-json',
      '--input-file',
      '--artifacts',
      '--artifacts-json',
    ]) {
      const opt = byLong.get(long) as { defaultValue?: unknown; helpGroupHeading?: string };
      expect(opt.defaultValue).toEqual([]);
      expect(opt.helpGroupHeading).toBe('Input options:');
    }
  });
});

describe('delegate command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function mirrorActiveSubstepStatesIntoSnapshot(): Promise<void> {
    const state = await getActiveState(workspace);
    if (!state) throw new Error('Expected active state');
    const snapshot =
      state.snapshot && typeof state.snapshot === 'object'
        ? (state.snapshot as Record<string, unknown>)
        : {};
    const context =
      snapshot.context && typeof snapshot.context === 'object'
        ? (snapshot.context as Record<string, unknown>)
        : {};
    const stateFile = join(workspace.statePath(), `${state.id}.json`);
    await writeFile(
      stateFile,
      JSON.stringify(
        {
          ...state,
          snapshot: {
            ...snapshot,
            context: {
              ...context,
              substepStates: state.substepStates,
            },
          },
        },
        null,
        2,
      ),
    );
  }

  /** Start a prompted runbook with substeps and create a child runbook. */
  async function setupDelegation(): Promise<void> {
    // Create a child runbook in the workspace
    const childContent = createRunbook({
      steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

    const parentContent = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Main step',
          pass: 'CONTINUE',
          substeps: [
            {
              title: 'Substep A',
              delegate: true,
              runbooks: ['runbooks/child.runbook.md'],
            },
            { title: 'Substep B', content: 'Second substep.' },
          ],
        },
        { title: 'Complete', pass: 'COMPLETE', command: 'rd echo --result pass' },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'delegate-parent.runbook.md'), parentContent);

    // Start the substeps runbook in prompted mode
    const startResult = await runCliInProcess(
      'run --prompted runbooks/delegate-parent.runbook.md --text',
      workspace,
    );
    if (startResult.exitCode !== 0) {
      throw new Error(`setup run failed:\n${startResult.stdout}\n${startResult.stderr}`);
    }
    const state = await getActiveState(workspace);
    const autoToken = state?.substepStates?.find((substep) => substep.id === '1')?.delegation
      ?.token;
    if (!autoToken) {
      throw new Error('setup run did not persist an auto-issued delegation token');
    }
    const abortResult = await runCliInProcess(['abort', autoToken], workspace);
    if (abortResult.exitCode !== 0) {
      throw new Error(`setup abort failed:\n${abortResult.stdout}\n${abortResult.stderr}`);
    }
  }

  /**
   * Start a prompted DELEGATE runbook and leave the auto-issued frontier token
   * in place (no abort), so bare `rd delegate` lands on an already-issued
   * frontier. Returns the auto-issued token for sanity assertions.
   */
  async function setupAutoIssuedDelegation(): Promise<string> {
    const childContent = createRunbook({
      steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

    const parentContent = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Main step',
          pass: 'CONTINUE',
          substeps: [
            { title: 'Substep A', delegate: true, runbooks: ['runbooks/child.runbook.md'] },
            { title: 'Substep B', content: 'Second substep.' },
          ],
        },
        { title: 'Complete', pass: 'COMPLETE', command: 'rd echo --result pass' },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'delegate-parent.runbook.md'), parentContent);

    const startResult = await runCliInProcess(
      'run --prompted runbooks/delegate-parent.runbook.md --text',
      workspace,
    );
    if (startResult.exitCode !== 0) {
      throw new Error(`setup run failed:\n${startResult.stdout}\n${startResult.stderr}`);
    }
    const state = await getActiveState(workspace);
    const autoToken = state?.substepStates?.find((substep) => substep.id === '1')?.delegation
      ?.token;
    if (!autoToken) {
      throw new Error('setup run did not persist an auto-issued delegation token');
    }
    return autoToken;
  }

  it('rejects --claim-id-looking delegate input before delegation logic runs', async () => {
    const result = await runCliInProcess(
      ['delegate', 'child.md', '--input-file', '--claim-id=foo'],
      workspace,
    );

    expect(result.exitCode).toBe(1);
    const raw = JSON.parse(result.stdout);
    expect(ErrorResponseSchema.safeParse(raw).success).toBe(true);
    expect(raw).toMatchObject({
      code: 'INVALID_DELEGATE_CLAIM_ID',
      error: expect.stringContaining('does not accept --claim-id'),
    });
  });

  describe('collection-pending guard', () => {
    it('refuses bare delegate while a delegated outcome is waiting for collection', async () => {
      await setupAutoIssuedDelegation();
      const completionKey = await injectDelegationOutcomeForActiveRun(workspace);

      const result = await runCliInProcess(await withRunTarget(['delegate'], workspace), workspace);

      expect(result.exitCode).toBe(1);
      const raw = JSON.parse(result.stdout);
      // Validate the full envelope against the published error contract so the
      // DELEGATION_COLLECTION_PENDING response cannot drift from the schema.
      expect(ErrorResponseSchema.safeParse(raw).success).toBe(true);
      const payload = raw as {
        code?: string;
        details?: { outcomeCompletionKeys?: string[] };
      };
      expect(payload.code).toBe('DELEGATION_COLLECTION_PENDING');
      expect(payload.details?.outcomeCompletionKeys).toEqual([completionKey]);
    });

    it('refuses a positional delegate (no --step) while a delegated outcome is waiting for collection', async () => {
      // A positional `rd delegate <child>` with no --step confirms the
      // already-pending delegate substep; it is the bare path, not a step
      // target, so it MUST stay subject to the collection-pending guard. (The
      // seam previously treated a positional runbook arg as `targeted`, which
      // bypassed the guard — regressing positional confirmations past it.)
      await setupAutoIssuedDelegation();
      const completionKey = await injectDelegationOutcomeForActiveRun(workspace);

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const raw = JSON.parse(result.stdout);
      expect(ErrorResponseSchema.safeParse(raw).success).toBe(true);
      const payload = raw as {
        code?: string;
        details?: { outcomeCompletionKeys?: string[] };
      };
      expect(payload.code).toBe('DELEGATION_COLLECTION_PENDING');
      expect(payload.details?.outcomeCompletionKeys).toEqual([completionKey]);
    });

    it('exempts a targeted delegate --step from the collection-pending guard', async () => {
      // A `--step` target is a deliberate delegation, not a bare parent advance,
      // so it bypasses the collection-pending guard (which gates bare issuance
      // only) and reaches real delegation logic. In this same pending state bare
      // `delegate` returns DELEGATION_COLLECTION_PENDING (see the test above);
      // the targeted form instead reaches the delegation logic and idempotently
      // echoes the substep's already in-flight auto-issued delegation. The
      // success (exit 0, `already-delegated`) — never DELEGATION_COLLECTION_PENDING
      // — is the proof that the guard was skipped.
      await setupAutoIssuedDelegation();
      await injectDelegationOutcomeForActiveRun(workspace);

      const result = await runCliInProcess(
        await withRunTarget(['delegate', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const json = parseCliJsonObject(result.stdout);
      expect(json).toMatchObject({ kind: 'delegate', action: 'already-delegated', step: '1.1' });
      expect(json.code).not.toBe('DELEGATION_COLLECTION_PENDING');
    });

    it('exempts a targeted delegate --retry from the collection-pending guard and supersedes the pending outcome', async () => {
      // `--retry` re-issues a SPECIFIC delegation, so — like `--step` — it is a
      // targeted operation that bypasses the collection-pending guard (which
      // gates bare issuance only). Two invariants are asserted: (1) the retry
      // succeeds rather than surfacing DELEGATION_COLLECTION_PENDING, and (2) it
      // SUPERSEDES the reported-but-uncollected outcome — re-issuing is a fresh
      // attempt, so the prior attempt's `resolvedCompletions` row is consumed and
      // the substep reset (Cluster B, roadmap item 1b/13). This is the reverse of
      // the earlier "retry never touches resolvedCompletions" decision: a later
      // `rd collect` must NOT drain the stale outcome, so it cannot survive the
      // retry.
      const autoToken = await setupAutoIssuedDelegation();
      const completionKey = await injectDelegationOutcomeForActiveRun(workspace);

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', autoToken], workspace),
        workspace,
      );

      expect(retry.exitCode).toBe(0);
      const retryOutput = JSON.parse(retry.stdout) as {
        action?: string;
        token?: string;
        code?: string;
      };
      expect(retryOutput.code).not.toBe('DELEGATION_COLLECTION_PENDING');
      expect(retryOutput.action).toBe('retried');
      expect(retryOutput.token?.startsWith('rdtk_')).toBe(true);
      expect(retryOutput.token).not.toBe(autoToken);

      // The stale outcome is superseded by the retry — its row is consumed so a
      // later `rd collect` cannot drain the prior attempt's result.
      const after = await getActiveState(workspace);
      expect(Object.keys(after?.resolvedCompletions ?? {})).not.toContain(completionKey);
    });
  });

  describe('delegate --run', () => {
    it('issues delegation against the named run', async () => {
      await setupDelegation();
      const parent = await getActiveState(workspace);
      if (!parent) throw new Error('Expected active parent run');

      const result = await runCliInProcess(['delegate', '--run', parent.id], workspace);

      expect(result.exitCode).toBe(0);
      expect(extractToken(result.stdout)).toBeDefined();
    });

    it('refuses a well-formed foreign run id with RUN_TARGET_UNAVAILABLE', async () => {
      await setupDelegation();
      const foreign = `rd_${'f'.repeat(32)}`;

      const result = await runCliInProcess(['delegate', '--run', foreign], workspace);

      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).toBe('RUN_TARGET_UNAVAILABLE');
    });

    it('rejects a malformed --run id with INVALID_RUN_ID', async () => {
      await setupDelegation();

      const result = await runCliInProcess(['delegate', '--run', 'not-a-run-id'], workspace);

      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).toBe('INVALID_RUN_ID');
    });
  });

  describe('idempotent bare delegate', () => {
    it('echoes the auto-issued frontier token instead of RD-813 (JSON)', async () => {
      const autoToken = await setupAutoIssuedDelegation();

      const result = await runCliInProcess(await withRunTarget(['delegate'], workspace), workspace);

      expect(result.exitCode).toBe(0);
      const json = parseCliJsonObject(result.stdout);
      expect(json).toMatchObject({ kind: 'delegate', action: 'already-delegated', step: '1.1' });
      expect(typeof json.token).toBe('string');
      expect((json.token as string).startsWith('rdtk_')).toBe(true);
      expect(json.token).toBe(autoToken);
    });

    it('echoes the auto-issued frontier token in text mode', async () => {
      await setupAutoIssuedDelegation();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', '--text'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ALREADY');
      expect(result.stdout).toContain('rdtk_');
      expect(result.stdout).toContain('RD_CLAIM_TOKEN=');
    });
  });

  describe('idempotent positional delegate (#496)', () => {
    it('rd delegate <matching-runbook> (no --step) echoes the auto-issued token — parity with bare', async () => {
      const autoToken = await setupAutoIssuedDelegation();

      const bare = await runCliInProcess(await withRunTarget(['delegate'], workspace), workspace);
      expect(bare.exitCode).toBe(0);
      const bareJson = parseCliJsonObject(bare.stdout);
      expect(bareJson).toMatchObject({ kind: 'delegate', action: 'already-delegated' });

      const positional = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md'], workspace),
        workspace,
      );

      expect(positional.exitCode).toBe(0);
      const json = parseCliJsonObject(positional.stdout);
      expect(json).toMatchObject({ kind: 'delegate', action: 'already-delegated', step: '1.1' });
      expect(json.token).toBe(autoToken);
      expect(json.token).toBe(bareJson.token);
    });

    it('rd delegate <different-runbook> (no --step) conflicts with RD-804 against the in-flight frontier', async () => {
      await setupAutoIssuedDelegation();

      const childBContent = createRunbook({
        steps: [{ title: 'Child B step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child-b.runbook.md'), childBContent);

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child-b.runbook.md'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-804' }));
      expect(JSON.stringify(envelope)).toContain('in-flight delegation for a different runbook');
      expect(JSON.stringify(envelope)).toContain('runbooks/child-b.runbook.md');
      expect(JSON.stringify(envelope)).toContain('runbooks/child.runbook.md');
      expect(JSON.stringify(envelope)).not.toMatch(/rdtk_/);
    });
  });

  describe('frame-scoped delegate echo (FOR iterations)', () => {
    it('echoes at the issued --index and mints fresh at a different --index', async () => {
      // FOR parent whose delegate substep hosts one delegation per iteration.
      const parentContent = createRunbook({
        title: 'FOR Parent',
        steps: [
          {
            title: 'Process items',
            for: { variable: 'i', start: 1, end: 3 },
            pass: 'CONTINUE',
            substeps: [
              {
                title: 'Handle item',
                delegate: true,
                runbooks: ['runbooks/child.runbook.md'],
                content: 'Handle item {{i}}.',
              },
            ],
          },
          { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'for-parent.runbook.md'), parentContent);
      const childContent = createRunbook({
        steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

      const startResult = await runCliInProcess(
        'run --prompted runbooks/for-parent.runbook.md --text',
        workspace,
      );
      expect(startResult.exitCode).toBe(0);
      // Clear the live iteration's auto-issued delegation so the explicit
      // --index issuance below is the only delegation in play.
      const stateAfterStart = await getActiveState(workspace);
      const autoTokens =
        stateAfterStart?.substepStates
          ?.map((substep) => substep.delegation?.token)
          .filter((token): token is string => typeof token === 'string') ?? [];
      for (const token of autoTokens) {
        const abort = await runCliInProcess(['abort', token], workspace);
        expect(abort.exitCode).toBe(0);
      }

      const issued = await runCliInProcess(
        await withRunTarget(
          ['delegate', 'runbooks/child.runbook.md', '--step', '1.1', '--index', '2'],
          workspace,
        ),
        workspace,
      );
      expect(issued.exitCode).toBe(0);
      const issuedJson = parseCliJsonObject(issued.stdout);
      expect(issuedJson.action).toBe('delegated');

      // Repeating the same frame-scoped target echoes the in-flight token.
      const repeat = await runCliInProcess(
        await withRunTarget(
          ['delegate', 'runbooks/child.runbook.md', '--step', '1.1', '--index', '2'],
          workspace,
        ),
        workspace,
      );
      expect(repeat.exitCode).toBe(0);
      const repeatJson = parseCliJsonObject(repeat.stdout);
      expect(repeatJson).toMatchObject({ action: 'already-delegated', step: '1.1' });
      expect(repeatJson.token).toBe(issuedJson.token);

      // A different iteration is a different frame: no echo, fresh mint.
      const other = await runCliInProcess(
        await withRunTarget(
          ['delegate', 'runbooks/child.runbook.md', '--step', '1.1', '--index', '3'],
          workspace,
        ),
        workspace,
      );
      expect(other.exitCode).toBe(0);
      const otherJson = parseCliJsonObject(other.stdout);
      expect(otherJson.action).toBe('delegated');
      expect(otherJson.token).not.toBe(issuedJson.token);
    });
  });

  describe('claimed delegation re-mint refusal (RD-811)', () => {
    it('rd delegate --step over a claimed child refuses with the RD-811 envelope', async () => {
      const autoToken = await setupAutoIssuedDelegation();

      // A child claims the token (the bundled child auto-completes, leaving the
      // delegation linked: childRunId set, cancelledAt null, outcome awaiting
      // collection — the substep is not yet done).
      const claim = await runCliInProcess(['claim', autoToken], workspace);
      expect(claim.exitCode).toBe(0);

      const stateBefore = await getActiveState(workspace);
      const delegationBefore = stateBefore?.substepStates?.find((ss) => ss.id === '1')?.delegation;
      expect(delegationBefore?.childRunId).not.toBeNull();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-811' }));

      // The claimed delegation is untouched: same tokenHash, same linked child.
      const stateAfter = await getActiveState(workspace);
      const delegationAfter = stateAfter?.substepStates?.find((ss) => ss.id === '1')?.delegation;
      expect(delegationAfter?.tokenHash).toBe(delegationBefore?.tokenHash);
      expect(delegationAfter?.childRunId).toBe(delegationBefore?.childRunId);
    });
  });

  describe('idempotent targeted delegate', () => {
    it('rd delegate --step 1.1 echoes the in-flight auto-issued token (req #1)', async () => {
      const autoToken = await setupAutoIssuedDelegation();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const json = parseCliJsonObject(result.stdout);
      expect(json).toMatchObject({ kind: 'delegate', action: 'already-delegated', step: '1.1' });
      expect(json.token).toBe(autoToken);
      expect((json.token as string).startsWith('rdtk_')).toBe(true);
    });

    it('rd delegate <matching-runbook> --step 1.1 echoes the in-flight token (req #2)', async () => {
      const autoToken = await setupAutoIssuedDelegation();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const json = parseCliJsonObject(result.stdout);
      expect(json).toMatchObject({ kind: 'delegate', action: 'already-delegated', step: '1.1' });
      expect(json.token).toBe(autoToken);
    });

    it('rd delegate <different-runbook> --step 1.1 conflicts with RD-804 (req #3)', async () => {
      await setupAutoIssuedDelegation();

      const childBContent = createRunbook({
        steps: [{ title: 'Child B step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child-b.runbook.md'), childBContent);

      const result = await runCliInProcess(
        await withRunTarget(
          ['delegate', 'runbooks/child-b.runbook.md', '--step', '1.1'],
          workspace,
        ),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-804' }));
      expect(JSON.stringify(envelope)).toContain('in-flight delegation for a different runbook');
      expect(JSON.stringify(envelope)).toContain('runbooks/child-b.runbook.md');
      expect(JSON.stringify(envelope)).toContain('child.runbook.md');
      expect(JSON.stringify(envelope)).toContain('sha256:');
      expect(JSON.stringify(envelope)).not.toMatch(/rdtk_/);
    });

    it('rd delegate <unresolvable-runbook> --step 1.1 conflicts with RD-804 when in-flight', async () => {
      // An unresolvable requested runbook on a substep that already carries an
      // in-flight delegation surfaces the RD-804 conflict (core returns
      // `conflict`), distinct from the RD-822 mismatch raised when no delegation
      // is in flight (see the `setupDelegation()`-based test below).
      await setupAutoIssuedDelegation();

      const result = await runCliInProcess(
        await withRunTarget(
          ['delegate', 'runbooks/made-up-child.runbook.md', '--step', '1.1'],
          workspace,
        ),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-804' }));
      expect(JSON.stringify(envelope)).not.toMatch(/rdtk_/);
    });

    it('echoes even after the authored child runbook file is removed (strong idempotency)', async () => {
      // The echo path must not re-resolve the authored target, so deleting the
      // child runbook on disk cannot break idempotency. Pins the reorder that
      // runs the echo decision before authored-runbook resolution.
      const autoToken = await setupAutoIssuedDelegation();

      await rm(join(workspace.cwd, 'runbooks', 'child.runbook.md'));
      await rm(join(workspace.runbooksDir(), 'child.runbook.md'));

      const result = await runCliInProcess(
        await withRunTarget(['delegate', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const json = parseCliJsonObject(result.stdout);
      expect(json).toMatchObject({ kind: 'delegate', action: 'already-delegated', step: '1.1' });
      expect(json.token).toBe(autoToken);
    });
  });

  describe('successful delegation', () => {
    it('renders text output for successful delegation', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(
          ['delegate', 'runbooks/child.runbook.md', '--step', '1.1', '--text'],
          workspace,
        ),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('DELEGATED');
      expect(result.stdout).toContain('Token:');
      expect(result.stdout).toContain('rdtk_');
      expect(result.stdout).toContain('RD_CLAIM_TOKEN=');
    });

    it('token has correct format (rdtk_ prefix, length 37)', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const output = parseCliJsonObject(result.stdout);
      const token = output.token as string;
      expect(token.startsWith('rdtk_')).toBe(true);
      expect(token.length).toBe(37);
    });

    it('updates state with delegation on substep', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(result.exitCode).toBe(0);
      const output = parseCliJsonObject(result.stdout);

      const state = await getActiveState(workspace);
      const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
      expect(substepStates).toBeDefined();

      const ss1 = substepStates?.find((ss) => ss.id === '1');
      expect(ss1?.delegation).toBeDefined();

      const delegation = ss1?.delegation as Record<string, unknown>;
      expect(delegation.tokenHash).toBeDefined();
      expect((delegation.tokenHash as string).startsWith('sha256:')).toBe(true);
      expect(delegation.token).toBe(output.token);
      expect(delegation.childRunId).toBeNull();
    });

    it('status shows delegation info', async () => {
      await setupDelegation();

      const delegated = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(delegated.exitCode).toBe(0);
      const token = parseCliJsonObject(delegated.stdout).token as string;

      const statusResult = await runCliInProcess('status', workspace);
      expect(statusResult.exitCode).toBe(0);

      const statusOutput = parseCliJsonObject(statusResult.stdout);
      const delegations = statusOutput.delegations as Array<Record<string, unknown>> | undefined;
      expect(delegations).toBeDefined();
      expect(delegations).toHaveLength(1);
      expect(delegations?.[0]?.substep).toBe('1');
      expect(delegations?.[0]?.state).toBe('pending');
      expect(delegations?.[0]?.token).toBe(token);
      expect(delegations?.[0]?.tokenHash).toEqual(expect.stringMatching(/^sha256:[a-f0-9]{64}$/));
    });

    it('removes the raw recovery token after claim', async () => {
      await setupDelegation();

      const delegated = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(delegated.exitCode).toBe(0);
      const token = parseCliJsonObject(delegated.stdout).token as string;

      const claimed = await runCliInProcess(`claim ${token}`, workspace);
      expect(claimed.exitCode).toBe(0);

      const state = await getActiveState(workspace);
      const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
      const ss1 = substepStates?.find((ss) => ss.id === '1');
      const delegation = ss1?.delegation as Record<string, unknown>;
      expect(delegation.childRunId).toEqual(expect.stringMatching(/^rd_[a-f0-9]{32}$/));
      expect(delegation.tokenHash).toEqual(expect.stringMatching(/^sha256:[a-f0-9]{64}$/));
      expect(delegation.token).toBeUndefined();
      // Persisted childRunbookRef must be a structured RunbookRef object, not
      // just a path string. A regression to path-only persistence would break
      // source-aware claim resolution for plugin/bundled/external children.
      // Path is source-root-relative for the explicit runbooks/child.runbook.md
      // argument used to create this delegation.
      expect(delegation.childRunbookRef).toEqual({
        source: 'project',
        path: 'runbooks/child.runbook.md',
      });

      const statusResult = await runCliInProcess('status', workspace);
      expect(statusResult.exitCode).toBe(0);
      const statusOutput = parseCliJsonObject(statusResult.stdout);
      const delegations = statusOutput.delegations as Array<Record<string, unknown>>;
      expect(delegations[0]?.state).toBe('claimed');
      expect(delegations[0]?.token).toBeUndefined();
    });

    it('removes the raw recovery token from persisted snapshot after claim', async () => {
      await setupDelegation();

      const delegated = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(delegated.exitCode).toBe(0);
      const token = parseCliJsonObject(delegated.stdout).token as string;
      await mirrorActiveSubstepStatesIntoSnapshot();

      const claimed = await runCliInProcess(`claim ${token}`, workspace);
      expect(claimed.exitCode).toBe(0);

      const parent = await getActiveState(workspace);
      if (!parent) throw new Error('Expected parent state');
      const persisted = JSON.parse(
        await readFile(join(workspace.statePath(), `${parent.id}.json`), 'utf-8'),
      ) as {
        snapshot?: {
          context?: { substepStates?: Array<{ delegation?: Record<string, unknown> }> };
        };
      };
      const snapshotDelegation = persisted.snapshot?.context?.substepStates?.[0]?.delegation;
      expect(snapshotDelegation?.tokenHash).toEqual(expect.stringMatching(/^sha256:[a-f0-9]{64}$/));
      expect(snapshotDelegation?.token).toBeUndefined();
    });

    it('emits the JSON success contract', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const output = parseCliJsonObject(result.stdout) as {
        kind: string;
        action: string;
        step: string;
        runbook: string;
        token: string;
        token_hash: string;
        parent_run_id: string;
      };

      expect(output).toEqual(
        expect.objectContaining({
          kind: 'delegate',
          action: 'delegated',
          step: '1.1',
          runbook: 'runbooks/child.runbook.md',
          token: expect.stringMatching(/^rdtk_/),
          token_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          parent_run_id: expect.any(String),
        }),
      );
    });
  });

  describe('inference', () => {
    /**
     * Setup a runbook whose first step is manual, leaving a later DELEGATE
     * runbook-list substep available for bare `rd delegate` inference.
     */
    async function setupDelegationWithPendingDelegateRunbookRef(): Promise<void> {
      const parentContent = [
        '# Delegation Test',
        '',
        '## 1. Gate',
        '',
        'Manual gate.',
        '',
        '## 2. Main step',
        '',
        '- PASS ALL COMPLETE',
        '- FAIL ANY STOP',
        '',
        '### 2.1 Child task',
        '',
        '- DELEGATE',
        '- child.runbook.md',
      ].join('\n');
      await writeFile(
        join(workspace.cwd, 'runbooks', 'with-delegate-ref.runbook.md'),
        parentContent,
      );

      const childContent = createRunbook({
        steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

      const startResult = await runCliInProcess(
        'run --prompted runbooks/with-delegate-ref.runbook.md --text',
        workspace,
      );
      expect(startResult.exitCode).toBe(0);

      const gotoResult = await runCliInProcess(
        await withRunTarget(['goto', '2'], workspace),
        workspace,
      );
      expect(gotoResult.exitCode).toBe(0);
    }

    /**
     * Setup a runbook whose active substep has a runbook reference without
     * DELEGATE. This is an inline-launch substep, but explicit `--step`
     * delegation may still use its authored runbook reference.
     */
    async function setupActiveInlineRunbookRef(): Promise<void> {
      const parentContent = [
        '# Delegation Test',
        '',
        '## 1. Main step',
        '',
        '- PASS ALL COMPLETE',
        '- FAIL ANY STOP',
        '',
        '### 1.1 Child task',
        '',
        '- child.runbook.md',
      ].join('\n');
      await writeFile(join(workspace.cwd, 'runbooks', 'with-ref.runbook.md'), parentContent);

      const childContent = createRunbook({
        steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

      const startResult = await runCliInProcess(
        'run --prompted runbooks/with-ref.runbook.md --text',
        workspace,
      );
      if (startResult.exitCode !== 0) {
        throw new Error(`setup run failed:\n${startResult.stdout}\n${startResult.stderr}`);
      }
    }

    it('rd delegate (no args) echoes the existing frontier token without re-issuing', async () => {
      await setupDelegationWithPendingDelegateRunbookRef();

      const before = await getActiveState(workspace);
      const issuedToken = before?.substepStates?.find((substep) => substep.id === '1')?.delegation
        ?.token;
      expect(issuedToken).toBeDefined();

      const result = await runCliInProcess(await withRunTarget(['delegate'], workspace), workspace);

      // Idempotent: echoes the pre-issued token rather than throwing RD-813.
      expect(result.exitCode).toBe(0);
      const envelope = parseCliJsonObject(result.stdout);
      expect(envelope).toEqual(
        expect.objectContaining({ kind: 'delegate', action: 'already-delegated', step: '2.1' }),
      );
      expect(envelope.token).toBe(issuedToken);

      // No duplication: the persisted delegation token is unchanged.
      const after = await getActiveState(workspace);
      const afterToken = after?.substepStates?.find((substep) => substep.id === '1')?.delegation
        ?.token;
      expect(afterToken).toBe(issuedToken);
    });

    it('rd delegate --step 1.1 does not infer after inline child launch takes scope', async () => {
      await setupActiveInlineRunbookRef();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('RD-813');
    });

    it('rd delegate --step 2.1 idempotently echoes the existing auto-issued delegation', async () => {
      await setupDelegationWithPendingDelegateRunbookRef();

      const before = await getActiveState(workspace);
      // Substep ids collide across steps (every step has a `1`). Scope the
      // lookup to step 2's active frame so a cross-step id collision cannot
      // satisfy the assertion. The setup `goto 2`s, so the cursor sits in
      // step 2's base frame (`2|`).
      const beforeFrame = before?.activeFrameKey ?? buildFrameKey('2');
      const issuedToken = before?.substepStates?.find(
        (substep) => substep.id === '1' && substep.frameKey === beforeFrame,
      )?.delegation?.token;
      expect(issuedToken).toBeDefined();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', '--step', '2.1'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const envelope = parseCliJsonObject(result.stdout);
      expect(envelope).toEqual(
        expect.objectContaining({ kind: 'delegate', action: 'already-delegated', step: '2.1' }),
      );
      expect(envelope.token).toBe(issuedToken);

      // No re-issue: the persisted delegation token is unchanged.
      const after = await getActiveState(workspace);
      const afterFrame = after?.activeFrameKey ?? buildFrameKey('2');
      const afterToken = after?.substepStates?.find(
        (substep) => substep.id === '1' && substep.frameKey === afterFrame,
      )?.delegation?.token;
      expect(afterToken).toBe(issuedToken);
    });

    it('backward compat: explicit rd delegate child.runbook.md --step 1.1 still works', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
    });

    it('rejects a no-step positional runbook that differs from the authored target (RD-822)', async () => {
      await setupDelegation();
      const childBContent = createRunbook({
        steps: [{ title: 'Child B step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child-b.runbook.md'), childBContent);

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child-b.runbook.md'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-822' }));
      expect(JSON.stringify(envelope)).not.toMatch(/rdtk_/);
    });

    it('accepts a no-step positional runbook that matches the authored target', async () => {
      await setupDelegation();
      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md'], workspace),
        workspace,
      );
      expect(result.exitCode).toBe(0);
      const json = parseCliJsonObject(result.stdout);
      expect(json).toMatchObject({ kind: 'delegate', action: 'delegated', step: '1.1' });
    });
  });

  describe('error cases', () => {
    it('fails for nonexistent step', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '99.1'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('Step not found');
    });

    it('errors on an unparsable --step paired with --index (does not validate the active step)', async () => {
      // `--index` requires `--step`, so a target is present. An unparsable `--step`
      // must surface INVALID_STEP for that target — not silently validate the
      // active step (which would emit a misleading INVALID_INDEX about a step the
      // operator never named, or fall through to a later RD-814).
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', '--step', '{N}', '--index', '2'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('INVALID_STEP');
      expect(combined).toContain('invalid --step value');
      // Not the misleading active-step INVALID_INDEX, nor a downstream RD-814.
      expect(combined).not.toContain('INVALID_INDEX');
      expect(combined).not.toContain('RD-814');
    });

    it('fails with delegationRunbookNotFound when the authored child is unresolvable on a fresh issue', async () => {
      // Covers the seam's issuable-path `delegationRunbookNotFound` branch via
      // `rd delegate`: a delegatable substep with no in-flight delegation whose
      // authored child no longer resolves on disk.
      await setupDelegation(); // auto-issues then aborts → substep 1.1 is issuable
      await rm(join(workspace.cwd, 'runbooks', 'child.runbook.md'));
      await rm(join(workspace.runbooksDir(), 'child.runbook.md'));

      const result = await runCliInProcess(
        await withRunTarget(['delegate', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-805' }));
      expect(JSON.stringify(envelope)).toMatch(/child runbook not found/i);
      expect(JSON.stringify(envelope)).not.toMatch(/rdtk_/);
    });

    it('rejects explicit child runbook delegation when a plain substep lacks DELEGATE', async () => {
      const childContent = createRunbook({
        steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);

      const parentContent = createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Main step',
            pass: 'CONTINUE',
            substeps: [{ title: 'Plain substep', content: 'Manual work.' }],
          },
          { title: 'Complete', pass: 'COMPLETE', command: 'rd echo --result pass' },
        ],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'plain-parent.runbook.md'), parentContent);

      const start = await runCliInProcess(
        'run --prompted runbooks/plain-parent.runbook.md --text',
        workspace,
      );
      expect(start.exitCode).toBe(0);

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-813' }));
      expect(JSON.stringify(envelope)).not.toMatch(/rdtk_/);
    });

    it('idempotently echoes a repeated matching delegation on the same substep', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(first.exitCode).toBe(0);
      const firstJson = parseCliJsonObject(first.stdout);
      const firstToken = firstJson.token;
      expect(typeof firstToken).toBe('string');

      const second = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(second.exitCode).toBe(0);
      const envelope = parseCliJsonObject(second.stdout);
      expect(envelope).toEqual(
        expect.objectContaining({ kind: 'delegate', action: 'already-delegated', step: '1.1' }),
      );
      expect(envelope.token).toBe(firstToken);
    });

    it('errors when an in-flight delegation targets a different runbook without exposing the raw token', async () => {
      await setupDelegation();

      const childBContent = createRunbook({
        steps: [{ title: 'Child B step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child-b.runbook.md'), childBContent);

      const first = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(first.exitCode).toBe(0);

      const second = await runCliInProcess(
        await withRunTarget(
          ['delegate', 'runbooks/child-b.runbook.md', '--step', '1.1'],
          workspace,
        ),
        workspace,
      );

      expect(second.exitCode).not.toBe(0);
      const envelope = parseCliJsonObject(second.stdout || second.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-804' }));
      expect(JSON.stringify(envelope)).toContain('in-flight delegation for a different runbook');
      expect(JSON.stringify(envelope)).toContain('runbooks/child-b.runbook.md');
      expect(JSON.stringify(envelope)).toContain('child.runbook.md');
      expect(JSON.stringify(envelope)).toContain('sha256:');
      expect(JSON.stringify(envelope)).not.toMatch(/rdtk_/);
    });

    it('rejects explicit child runbook delegation when the requested runbook differs from the authored target', async () => {
      await setupDelegation();

      const childBContent = createRunbook({
        steps: [{ title: 'Child B step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child-b.runbook.md'), childBContent);

      const result = await runCliInProcess(
        await withRunTarget(
          ['delegate', 'runbooks/child-b.runbook.md', '--step', '1.1'],
          workspace,
        ),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-822' }));
      expect(JSON.stringify(envelope)).toContain('runbooks/child-b.runbook.md');
      expect(JSON.stringify(envelope)).toContain('runbooks/child.runbook.md');
      expect(JSON.stringify(envelope)).not.toMatch(/rdtk_/);
    });

    it('rejects explicit child runbook delegation when the requested runbook is not authored', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(
          ['delegate', 'runbooks/made-up-child.runbook.md', '--step', '1.1'],
          workspace,
        ),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-822' }));
      expect(JSON.stringify(envelope)).toContain('runbooks/made-up-child.runbook.md');
      expect(JSON.stringify(envelope)).toContain('runbooks/child.runbook.md');
      expect(JSON.stringify(envelope)).not.toMatch(/rdtk_/);
    });

    it('rejects explicit child runbook delegation on a bare step', async () => {
      const childContent = createRunbook({
        steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);

      const parentContent = createRunbook({
        title: 'Parent',
        steps: [
          { title: 'Single step', pass: 'CONTINUE', content: 'Manual work.' },
          { title: 'Complete', pass: 'COMPLETE', command: 'rd echo --result pass' },
        ],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'simple-parent.runbook.md'), parentContent);

      const start = await runCliInProcess(
        'run --prompted runbooks/simple-parent.runbook.md --text',
        workspace,
      );
      expect(start.exitCode).toBe(0);

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-813' }));
      expect(JSON.stringify(envelope)).not.toMatch(/rdtk_/);
    });

    it('reports no active runbook when none is running', async () => {
      // Don't start any runbook
      const childContent = createRunbook({
        steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);

      const result = await runCliInProcess(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1'],
        workspace,
      );

      // The CLI exits 0 but outputs "no active runbook" per convention
      expect(result.stdout).toContain('No active runbook');
    });

    it('fails before manual delegation when the authored child runbook is unresolvable', async () => {
      const parentContent = createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Main step',
            pass: 'CONTINUE',
            substeps: [
              {
                title: 'Missing child',
                delegate: true,
                runbooks: ['nonexistent.runbook.md'],
              },
            ],
          },
        ],
      });
      await writeFile(
        join(workspace.cwd, 'runbooks', 'missing-child-parent.runbook.md'),
        parentContent,
      );
      const start = await runCliInProcess(
        'run --prompted runbooks/missing-child-parent.runbook.md --text',
        workspace,
      );

      expect(start.exitCode).not.toBe(0);
      expect(start.stdout + start.stderr).toMatch(/unable to resolve delegation runbook/i);
      expect(start.stdout + start.stderr).not.toMatch(/rdtk_/);
    });

    it('refuses nested delegation when active runbook is itself a claimed child', async () => {
      // Single-level delegation invariant: a claimed (delegated) child runbook
      // may not issue further delegations. Seed an active runbook with
      // `parentLinkage.kind === 'delegation'` (mirroring how `rd claim` writes
      // child state) and verify `rd delegate` is rejected with RD-819 before
      // any token is minted or persisted.
      await setupDelegation();

      const state = await getActiveState(workspace);
      if (!state) throw new Error('Expected active state');
      const stateFile = join(workspace.statePath(), `${state.id}.json`);
      await writeFile(
        stateFile,
        JSON.stringify(
          {
            ...state,
            parentLinkage: {
              kind: 'delegation',
              parentRunId: `rd_${'9'.repeat(32)}`,
              parentStepId: '1',
              parentStep: '1',
              parentFrameKey: '1|',
              parentEntry: 1,
              tokenHash: `sha256:${'a'.repeat(64)}`,
            },
          },
          null,
          2,
        ),
      );

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      // withErrorHandling -> toJSON envelope emits the formatted error code.
      expect(result.stdout + result.stderr).toMatch(/RD-819/);
      expect(result.stdout + result.stderr).toMatch(/nested delegation forbidden/i);

      // setupDelegation has already auto-issued the parent token before this
      // test injects child linkage; the failed nested delegate must not mint a
      // replacement token.
      const after = await getActiveState(workspace);
      const substepStates = after?.substepStates as Array<Record<string, unknown>> | undefined;
      const ss1 = substepStates?.find((ss) => ss.id === '1');
      expect(ss1?.delegation).toEqual(state.substepStates?.find((ss) => ss.id === '1')?.delegation);
    });
  });

  describe('rd delegate --retry', () => {
    it('token form: cancels old delegation and mints fresh token', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(first.exitCode).toBe(0);
      const firstOutput = JSON.parse(first.stdout) as Record<string, unknown>;
      const originalToken = firstOutput.token as string;
      const originalHash = firstOutput.token_hash as string;

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', originalToken], workspace),
        workspace,
      );

      expect(retry.exitCode).toBe(0);
      const retryOutput = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(retryOutput.action).toBe('retried');
      expect((retryOutput.token as string).startsWith('rdtk_')).toBe(true);
      expect(retryOutput.token).not.toBe(originalToken);
      expect(retryOutput.token_hash).not.toBe(originalHash);
      expect(retryOutput.step).toBe('1.1');
    });

    it('token form --text: renders the RETRIED / Token / RD_CLAIM_TOKEN lines', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(first.exitCode).toBe(0);
      const originalToken = (JSON.parse(first.stdout) as Record<string, unknown>).token as string;

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', originalToken, '--text'], workspace),
        workspace,
      );

      expect(retry.exitCode).toBe(0);
      // Human-readable retry envelope (the else-branch of the `retried` arm).
      expect(retry.stdout).toMatch(/RETRIED\s+step 1\.1 -> .*child\.runbook\.md/);
      expect(retry.stdout).toMatch(/Token:\s+rdtk_/);
      // The fresh token is echoed both as the summary Token line and as the
      // machine-consumable RD_CLAIM_TOKEN export line, and differs from the old.
      const claimTokenLine = retry.stdout
        .split('\n')
        .find((line) => line.startsWith('RD_CLAIM_TOKEN='));
      expect(claimTokenLine).toBeDefined();
      const mintedToken = claimTokenLine!.slice('RD_CLAIM_TOKEN='.length).trim();
      expect(mintedToken.startsWith('rdtk_')).toBe(true);
      expect(mintedToken).not.toBe(originalToken);
    });

    it('--step form: resolves active-frame substep and retries', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(first.exitCode).toBe(0);
      const firstOutput = JSON.parse(first.stdout) as Record<string, unknown>;
      const originalToken = firstOutput.token as string;

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', '--step', '1.1'], workspace),
        workspace,
      );

      expect(retry.exitCode).toBe(0);
      const retryOutput = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(retryOutput.action).toBe('retried');
      expect(retryOutput.token).not.toBe(originalToken);
      expect(retryOutput.step).toBe('1.1');
    });

    it('inferred form: retries the active substep delegation', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(first.exitCode).toBe(0);
      const firstOutput = JSON.parse(first.stdout) as Record<string, unknown>;
      const originalToken = firstOutput.token as string;

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry'], workspace),
        workspace,
      );

      expect(retry.exitCode).toBe(0);
      const retryOutput = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(retryOutput.action).toBe('retried');
      expect(retryOutput.token).not.toBe(originalToken);
    });

    it('refuses retry when the delegation has a linked child run', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(first.exitCode).toBe(0);
      const firstOutput = parseCliJsonObject(first.stdout);
      const token = firstOutput.token as string;

      const claim = await runCliInProcess(['claim', token], workspace);
      expect(claim.exitCode).toBe(0);

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', token], workspace),
        workspace,
      );

      expect(retry.exitCode).not.toBe(0);
      const envelope = parseCliJsonObject(retry.stdout || retry.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-823' }));
      expect(JSON.stringify(envelope)).toContain('abort');
      expect(JSON.stringify(envelope)).toContain('--force');

      const state = await getActiveState(workspace);
      const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
      const delegation = substepStates?.find((ss) => ss.id === '1')?.delegation as
        | Record<string, unknown>
        | undefined;
      expect(delegation?.tokenHash).toBe(firstOutput.token_hash);
      expect(delegation?.childRunId).not.toBeNull();
    });

    it('rejects ambiguity: token + --step both provided', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(first.exitCode).toBe(0);
      const firstOutput = JSON.parse(first.stdout) as Record<string, unknown>;
      const originalToken = firstOutput.token as string;

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', originalToken, '--step', '1.1'], workspace),
        workspace,
      );

      expect(retry.exitCode).not.toBe(0);
      expect(retry.stdout + retry.stderr).toMatch(/specify either a token or --step/);
    });

    it('errors when --step has no delegation', async () => {
      await runCliInProcess('run --prompted runbooks/substeps.runbook.md --text', workspace);

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', '--step', '1.1'], workspace),
        workspace,
      );

      expect(retry.exitCode).not.toBe(0);
      // Retry CLI now propagates the inner RundownError verbatim through
      // withErrorHandling — RD-801 is "Step not found", produced by
      // retryDelegation's not_found variant via Errors.delegationStepNotFound.
      expect(retry.stdout + retry.stderr).toMatch(/RD-801/);
    });

    it('prioritizes the retry precondition over --input-file validation (regression)', async () => {
      // No active runbook. A bad --input-file must NOT mask the retry-target
      // precondition: the locator resolves before --input* overrides are parsed,
      // so this surfaces NO_ACTIVE_RUNBOOK — not the missing-file (RD-101) error.
      const retry = await runCliInProcess(
        ['delegate', '--retry', '--step', '1.1', '--input-file', 'does-not-exist.yaml'],
        workspace,
      );

      expect(retry.exitCode).not.toBe(0);
      // The retry precondition surfaces (NO_ACTIVE_RUNBOOK), and the bad
      // --input-file is never even read — so the missing-file (RD-101) envelope
      // and the path never appear. (failRetry calls process.exit, so assert on
      // raw output rather than parsing the single JSON object, matching the
      // sibling --retry error-case tests.)
      const combined = retry.stdout + retry.stderr;
      expect(combined).toContain('NO_ACTIVE_RUNBOOK');
      expect(combined).toContain('--retry requires an active runbook');
      expect(combined).not.toContain('does-not-exist.yaml');
      expect(combined).not.toContain('RD-101');
    });

    it('errors when token is unknown', async () => {
      await setupDelegation();

      const retry = await runCliInProcess(
        await withRunTarget(
          ['delegate', '--retry', 'rdtk_unknown00000000000000000000000000'],
          workspace,
        ),
        workspace,
      );

      expect(retry.exitCode).not.toBe(0);
      expect(retry.stdout + retry.stderr).toMatch(/token .* not found/i);
    });

    it('prioritizes TOKEN_NOT_FOUND over --input-file validation on the token form (regression)', async () => {
      // The token form does not validate the token until the seam runs. A bad
      // --input-file must NOT mask that precondition: overrides are parsed lazily
      // (deferred into the seam, after the token lookup), so an unknown token
      // surfaces TOKEN_NOT_FOUND — not the missing-file (RD-101) envelope.
      await setupDelegation();

      const retry = await runCliInProcess(
        await withRunTarget(
          [
            'delegate',
            '--retry',
            'rdtk_unknown00000000000000000000000000',
            '--input-file',
            'does-not-exist.yaml',
          ],
          workspace,
        ),
        workspace,
      );

      expect(retry.exitCode).not.toBe(0);
      const combined = retry.stdout + retry.stderr;
      expect(combined).toMatch(/token .* not found/i);
      // The bad --input-file is never read — the missing-file envelope and the
      // path never appear.
      expect(combined).not.toContain('does-not-exist.yaml');
      expect(combined).not.toContain('RD-101');
    });

    it('errors when inferred form has no active runbook', async () => {
      // No runbook started — sessionService.getActive() returns null on the
      // inferred path, hitting the explicit fail() at delegate.ts:388-390.
      const retry = await runCliInProcess(['delegate', '--retry'], workspace);

      expect(retry.exitCode).not.toBe(0);
      expect(retry.stdout + retry.stderr).toContain(
        '--retry requires a token, --step <id>, or an active substep',
      );
    });

    it('errors when inferred form has no active substep', async () => {
      // Start a runbook whose active cursor sits on a step with no substeps
      // (single-step runbook, prompted mode) — state exists but
      // activeState.substep is undefined, hitting the fail() at
      // delegate.ts:392-394.
      const content = createRunbook({
        steps: [{ title: 'Only step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'single.runbook.md'), content);
      const start = await runCliInProcess(
        'run --prompted runbooks/single.runbook.md --text',
        workspace,
      );
      expect(start.exitCode).toBe(0);

      const retry = await runCliInProcess(['delegate', '--retry'], workspace);

      expect(retry.exitCode).not.toBe(0);
      expect(retry.stdout + retry.stderr).toContain(
        '--retry requires a token, --step <id>, or an active substep',
      );
    });

    it('errors when --step targets an off-frontier step', async () => {
      // setupDelegation starts at step '1'. Create a delegation on 1.1, then advance
      // the cursor past step 1 so a retry --step 1.1 sees a non-current step.
      await setupDelegation();
      const first = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(first.exitCode).toBe(0);

      // Move cursor off step 1 by goto'ing step 2.
      const goto = await runCliInProcess(await withRunTarget(['goto', '2'], workspace), workspace);
      expect(goto.exitCode).toBe(0);

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', '--step', '1.1'], workspace),
        workspace,
      );

      expect(retry.exitCode).not.toBe(0);
      // Retry CLI now propagates the inner RundownError verbatim through
      // withErrorHandling — RD-802 is "Step not at execution frontier",
      // produced by retryDelegation's not_current variant via
      // Errors.delegationStepNotCurrent.
      expect(retry.stdout + retry.stderr).toMatch(/RD-802/);
    });

    it('inherits extraVars from the prior delegation', async () => {
      await setupDelegation();

      const firstRetry = await runCliInProcess(
        await withRunTarget(
          ['delegate', '--retry', '--step', '1.1', '--input', 'environment=staging'],
          workspace,
        ),
        workspace,
      );
      expect(firstRetry.exitCode).toBe(0);

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', '--step', '1.1'], workspace),
        workspace,
      );
      expect(retry.exitCode).toBe(0);

      const state = await getActiveState(workspace);
      const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
      const ss1 = substepStates?.find((ss) => ss.id === '1');
      const delegation = ss1?.delegation as Record<string, unknown> | undefined;
      const extraVars = delegation?.extraVars as Record<string, unknown> | undefined;
      expect(extraVars).toEqual({ environment: 'staging' });
    });

    it('overrides inherited vars when --input is passed', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        await withRunTarget(
          [
            'delegate',
            'runbooks/child.runbook.md',
            '--step',
            '1.1',
            '--input',
            'environment=staging',
          ],
          workspace,
        ),
        workspace,
      );
      expect(first.exitCode).toBe(0);

      const retry = await runCliInProcess(
        await withRunTarget(
          ['delegate', '--retry', '--step', '1.1', '--input', 'environment=production'],
          workspace,
        ),
        workspace,
      );
      expect(retry.exitCode).toBe(0);

      const state = await getActiveState(workspace);
      const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
      const ss1 = substepStates?.find((ss) => ss.id === '1');
      const delegation = ss1?.delegation as Record<string, unknown> | undefined;
      const extraVars = delegation?.extraVars as Record<string, unknown> | undefined;
      expect(extraVars).toEqual({ environment: 'production' });
    });

    it('accepts retry on a non-failed delegation (result-agnostic per spec §4.4)', async () => {
      await setupDelegation();

      // Create a delegation; default substepState status is 'pending' (not failed).
      const first = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(first.exitCode).toBe(0);

      // Retry succeeds regardless of substep result.
      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', '--step', '1.1'], workspace),
        workspace,
      );
      expect(retry.exitCode).toBe(0);
      const retryOutput = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(retryOutput.action).toBe('retried');
      expect((retryOutput.token as string).startsWith('rdtk_')).toBe(true);
    });

    it('rejects --index on a non-FOR step with a clear error', async () => {
      // substeps.runbook.md step 1 has kind 'substeps', not 'for'.
      await setupDelegation();

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', '--step', '1.1', '--index', '3'], workspace),
        workspace,
      );

      expect(retry.exitCode).not.toBe(0);
      // Pin the full assertForStep message via the parsed JSON error field: it
      // names the target step ("1") and its actual kind ("substeps"), so a
      // mutated step name / kind interpolation is caught, not only the prefix.
      expect(findErrorEnvelope(retry.stdout || retry.stderr)).toEqual(
        expect.objectContaining({
          kind: 'error',
          code: 'INVALID_INDEX',
          error: '--index requires step "1" to be a FOR step, but it is "substeps"',
        }),
      );
    });

    it('rejects a non-token runbook positional on the --retry path', async () => {
      // `--retry <runbook.md>` (a positional that is NOT a delegation token, with
      // no --step) is a misuse: the guard `runbookArg && !tokenArg` rejects it
      // with the "does not accept a runbook positional" INVALID_SYNTAX envelope.
      await setupDelegation();

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', 'runbooks/child.runbook.md'], workspace),
        workspace,
      );

      expect(retry.exitCode).not.toBe(0);
      const combined = retry.stdout + retry.stderr;
      expect(combined).toContain('INVALID_SYNTAX');
      expect(combined).toMatch(/--retry does not accept a runbook positional/);
      expect(combined).toContain('runbooks/child.runbook.md');
    });

    it('rejects --index on a non-FOR step on the FRESH issue path too', async () => {
      // The fresh-issue path has its own assertForStep guard (independent of
      // --retry). substeps.runbook.md step 1 is kind 'substeps', so a fresh
      // `delegate --step 1.1 --index 2` must be rejected with INVALID_INDEX.
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', '--step', '1.1', '--index', '2'], workspace),
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      expect(findErrorEnvelope(result.stdout || result.stderr)).toEqual(
        expect.objectContaining({
          kind: 'error',
          code: 'INVALID_INDEX',
          error: '--index requires step "1" to be a FOR step, but it is "substeps"',
        }),
      );
    });

    it('FOR-iteration: --step with --index targets the right frame', async () => {
      // Write a FOR parent with a substep that can host delegations per iteration.
      const parentContent = createRunbook({
        title: 'FOR Parent',
        steps: [
          {
            title: 'Process items',
            for: { variable: 'i', start: 1, end: 2 },
            pass: 'CONTINUE',
            substeps: [
              {
                title: 'Handle item',
                delegate: true,
                runbooks: ['runbooks/child.runbook.md'],
                content: 'Handle item {{i}}.',
              },
            ],
          },
          { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'for-parent.runbook.md'), parentContent);

      // Create the child runbook used for delegation
      const childContent = createRunbook({
        steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

      // Start the parent in prompted mode
      const startResult = await runCliInProcess(
        'run --prompted runbooks/for-parent.runbook.md --text',
        workspace,
      );
      expect(startResult.exitCode).toBe(0);
      const stateAfterStart = await getActiveState(workspace);
      const autoTokens =
        stateAfterStart?.substepStates
          ?.map((substep) => substep.delegation?.token)
          .filter((token): token is string => typeof token === 'string') ?? [];
      for (const token of autoTokens) {
        const abort = await runCliInProcess(['abort', token], workspace);
        expect(abort.exitCode).toBe(0);
      }

      // Seed delegations in both FOR iteration frames (buildFrameKey('1', 1) and ('1', 2))
      const del1 = await runCliInProcess(
        await withRunTarget(
          ['delegate', 'runbooks/child.runbook.md', '--step', '1.1', '--index', '1'],
          workspace,
        ),
        workspace,
      );
      expect(del1.exitCode).toBe(0);
      const del1Output = JSON.parse(del1.stdout) as Record<string, unknown>;
      const _iter1Token = del1Output.token as string;
      const iter1Hash = del1Output.token_hash as string;

      const del2 = await runCliInProcess(
        await withRunTarget(
          ['delegate', 'runbooks/child.runbook.md', '--step', '1.1', '--index', '2'],
          workspace,
        ),
        workspace,
      );
      expect(del2.exitCode).toBe(0);
      const del2Output = JSON.parse(del2.stdout) as Record<string, unknown>;
      const iter2Token = del2Output.token as string;
      const iter2Hash = del2Output.token_hash as string;

      // Retry only iteration 2
      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', '--step', '1.1', '--index', '2'], workspace),
        workspace,
      );
      expect(retry.exitCode).toBe(0);
      const retryOutput = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(retryOutput.action).toBe('retried');

      // Iteration 2 got a fresh token
      expect(retryOutput.token).not.toBe(iter2Token);
      expect(retryOutput.token_hash).not.toBe(iter2Hash);

      // Verify frame isolation in persisted state: iteration 1 is untouched,
      // iteration 2 has the new hash.
      const state = await getActiveState(workspace);
      const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
      expect(substepStates).toBeDefined();

      const iter1Entry = substepStates?.find((ss) => ss.id === '1' && ss.frameKey === '1|1');
      const iter2Entry = substepStates?.find((ss) => ss.id === '1' && ss.frameKey === '1|2');
      expect(iter1Entry).toBeDefined();
      expect(iter2Entry).toBeDefined();

      const iter1Delegation = iter1Entry?.delegation as Record<string, unknown> | undefined;
      const iter2Delegation = iter2Entry?.delegation as Record<string, unknown> | undefined;

      // Iteration 1 preserved its original hash — frame isolation.
      expect(iter1Delegation?.tokenHash).toBe(iter1Hash);
      expect(iter1Delegation?.cancelledAt).toBeNull();

      // Iteration 2 has the fresh hash and the old one is gone.
      expect(iter2Delegation?.tokenHash).toBe(retryOutput.token_hash);
      expect(iter2Delegation?.tokenHash).not.toBe(iter2Hash);
    });
  });

  // `rd delegate` registers `--artifacts` / `--artifacts-json` (the spec keeps the
  // flag visible on delegate/claim) but delegation-inheritance of artifacts is
  // out of scope. Supplying an artifact must FAIL FAST with an explanatory error
  // rather than silently dropping the assignment — the prior behavior routed the
  // flags onto `options` but never forwarded them into `collectCliFlags`, so the
  // assignment vanished with no diagnostic (a no-op footgun).
  describe('--artifacts is an explanatory error, not a silent no-op', () => {
    it('rejects --artifacts on a fresh delegate issue with UNSUPPORTED_OPTION', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(
          [
            'delegate',
            'runbooks/child.runbook.md',
            '--step',
            '1.1',
            '--artifacts',
            'Plan=rd://artifacts/ctx-a/Plan',
          ],
          workspace,
        ),
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const raw = JSON.parse(result.stdout) as { code?: string; error?: string };
      expect(ErrorResponseSchema.safeParse(raw).success).toBe(true);
      expect(raw.code).toBe('UNSUPPORTED_OPTION');
      expect(raw.error).toMatch(/artifact/i);
      expect(raw.error).toMatch(/rundown claim/i);
      // Must NOT surface as an "unknown option" — the flag stays registered.
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/unknown option/i);
    });

    it('rejects --artifacts-json on a fresh delegate issue with UNSUPPORTED_OPTION', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(
          [
            'delegate',
            'runbooks/child.runbook.md',
            '--step',
            '1.1',
            '--artifacts-json',
            'Plan=["rd://artifacts/ctx-a/Plan"]',
          ],
          workspace,
        ),
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const raw = JSON.parse(result.stdout) as { code?: string };
      expect(raw.code).toBe('UNSUPPORTED_OPTION');
    });

    it('rejects --artifacts on the --retry path with UNSUPPORTED_OPTION', async () => {
      // The guard fires before retry target resolution, so a placeholder token
      // suffices: the point is that the retry path also refuses artifacts rather
      // than dropping them (it shares the second silent collectCliFlags site).
      const result = await runCliInProcess(
        [
          'delegate',
          '--retry',
          'rdtk_placeholder',
          '--artifacts',
          'Plan=rd://artifacts/ctx-a/Plan',
        ],
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const raw = JSON.parse(result.stdout) as { code?: string };
      expect(raw.code).toBe('UNSUPPORTED_OPTION');
    });

    it('leaves a bare delegate (no artifacts) unaffected', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const raw = JSON.parse(result.stdout) as { code?: string; action?: string };
      expect(raw.code).not.toBe('UNSUPPORTED_OPTION');
      expect(raw.action).toBe('delegated');
    });
  });

  // extraVars are applied to the child context only when a delegation is freshly
  // minted. On the echo (`already-delegated`) / conflict / no-active paths no
  // delegation is created, so extraVars are irrelevant there. Pre-migration the
  // CLI parsed extraVars only on the issuable path, AFTER the RD-804 echo/conflict
  // decision; coupling echo success (or its warnings) to extraVars validity
  // violates the seam's strong-idempotency design ("an echo never resolves the
  // authored child"). The seam now resolves extraVars lazily, so a bad
  // `--input-file` (or a reserved-name `--input` warning) only surfaces when a
  // delegation is actually minted.
  describe('echo-path extraVars purity', () => {
    it('echoes (exit 0) on the already-delegated path even with a missing --input-file', async () => {
      const autoToken = await setupAutoIssuedDelegation();

      const result = await runCliInProcess(
        await withRunTarget(
          ['delegate', '--step', '1.1', '--input-file', 'does-not-exist.yaml'],
          workspace,
        ),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const json = parseCliJsonObject(result.stdout);
      expect(json).toMatchObject({ kind: 'delegate', action: 'already-delegated', step: '1.1' });
      expect(json.token).toBe(autoToken);
    });

    it('still validates --input-file on the issuable (freshly-minted) path', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(
          [
            'delegate',
            'runbooks/child.runbook.md',
            '--step',
            '1.1',
            '--input-file',
            'does-not-exist.yaml',
          ],
          workspace,
        ),
        workspace,
      );

      // Validation is deferred to the issuable moment, not lost: a bad
      // --input-file on the path that actually mints a delegation still errors
      // — and with the specific missing-file envelope, not an unrelated failure.
      expect(result.exitCode).not.toBe(0);
      const json = parseCliJsonObject(result.stdout);
      expect(json).toMatchObject({ kind: 'error', code: 'RD-101' });
      expect(String(json.error)).toContain('does-not-exist.yaml');
    });

    it('emits no warning on the echo path for a reserved-name --input', async () => {
      // A reserved runtime variable name (`RunId`) makes routeExtraVars emit a
      // warning. On the echo path the thunk is never invoked, so no warning is
      // routed to stderr.
      await setupAutoIssuedDelegation();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', '--step', '1.1', '--input', 'RunId=foo'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const json = parseCliJsonObject(result.stdout);
      expect(json).toMatchObject({ kind: 'delegate', action: 'already-delegated', step: '1.1' });
      expect(result.stderr).not.toMatch(/Warning:/);
      expect(result.stderr).not.toMatch(/reserved runtime variable/i);
    });
  });

  // Closes the drift gap that let `already-delegated` / `retried` envelopes
  // diverge from the published DelegateResponseSchema: every emitted action must
  // round-trip through the schema consumers validate against.
  describe('schema conformance', () => {
    function assertConformsToSchema(json: Record<string, unknown>): void {
      const parsed = DelegateResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(
          `delegate output violates DelegateResponseSchema (action=${String(
            json.action,
          )}):\n${JSON.stringify(parsed.error.issues, null, 2)}`,
        );
      }
    }

    it('delegated envelope conforms to DelegateResponseSchema', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      assertConformsToSchema(parseCliJsonObject(result.stdout));
    });

    it('already-delegated envelope conforms to DelegateResponseSchema', async () => {
      await setupAutoIssuedDelegation();

      const result = await runCliInProcess(await withRunTarget(['delegate'], workspace), workspace);

      expect(result.exitCode).toBe(0);
      assertConformsToSchema(parseCliJsonObject(result.stdout));
    });

    it('retried envelope conforms to DelegateResponseSchema', async () => {
      await setupDelegation();
      const first = await runCliInProcess(
        await withRunTarget(['delegate', 'runbooks/child.runbook.md', '--step', '1.1'], workspace),
        workspace,
      );
      expect(first.exitCode).toBe(0);
      const firstToken = parseCliJsonObject(first.stdout).token as string;

      const retry = await runCliInProcess(
        await withRunTarget(['delegate', '--retry', firstToken], workspace),
        workspace,
      );

      expect(retry.exitCode).toBe(0);
      assertConformsToSchema(parseCliJsonObject(retry.stdout));
    });
  });
});
