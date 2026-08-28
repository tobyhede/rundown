import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  findActionOutput,
  parseCliJsonObject,
  requireLatestFrontierToken,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorResponseSchema } from '@rundown-org/core';

describe('issue #834: claim envelopes validate against their own schema', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Helper: write parent runbook with delegated substeps */
  async function writeParentRunbook(childRunbook = 'child.runbook.md'): Promise<void> {
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
              runbooks: [childRunbook],
            },
          ],
        },
      ],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
  }

  /** Helper: write child runbook */
  async function writeChildRunbook(): Promise<void> {
    const content = createRunbook({
      title: 'Child',
      steps: [{ title: 'Execute', pass: 'COMPLETE', fail: 'STOP', content: 'Run the child task.' }],
    });
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
  }

  async function getAutoIssuedToken(substepId = '1'): Promise<string> {
    return requireLatestFrontierToken(workspace, `1.${substepId}`);
  }

  it('validates DELEGATION_ALREADY_CLAIMED envelope against ErrorResponseSchema', async () => {
    await writeParentRunbook();
    await writeChildRunbook();

    // Start parent in prompted mode
    let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const token = await getAutoIssuedToken();

    // First claim succeeds
    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const firstClaim = findActionOutput(result.stdout);
    expect(firstClaim?.run_id).toBeDefined();

    // Second claim fails with DELEGATION_ALREADY_CLAIMED
    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(1);

    const envelope = parseCliJsonObject(result.stdout);
    expect(envelope).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'DELEGATION_ALREADY_CLAIMED',
      }),
    );

    // THIS ASSERTION MUST PASS: the envelope validates against the schema.
    // If DELEGATION_ALREADY_CLAIMED is not registered in CLISymbolicErrorCodeValues,
    // this will fail with a safeParse error showing the unregistered code.
    const parseResult = ErrorResponseSchema.safeParse(envelope);
    expect(parseResult.success ? 'valid' : parseResult.error.toString()).toBe('valid');
  });

  it('validates claim envelope codes are all registered', async () => {
    // Direct registry check: ensure all codes that can be emitted by claim
    // are registered in the error code schema.
    // The specific codes pinned by issue #834:
    // - DELEGATION_ALREADY_CLAIMED (from delegation-already-claimed arm)
    // - PrepareFailure codes: POLICY_DENIED, MISSING_REQUIRED_VARS,
    //   RUNBOOK_REF_RESOLUTION_ERROR, PARSE_ERROR, VARIABLE_RESOLUTION_ERROR
    //   (from prepare-failed arm)

    // We test the schema directly: any code passed to ErrorResponseSchema
    // must be in the registered set.
    const testCodes = [
      'DELEGATION_ALREADY_CLAIMED',
      'POLICY_DENIED',
      'MISSING_REQUIRED_VARS',
      'RUNBOOK_REF_RESOLUTION_ERROR',
      'PARSE_ERROR',
      'VARIABLE_RESOLUTION_ERROR',
    ];

    const makeEnvelope = (code: string) => ({
      kind: 'error' as const,
      code,
      error: 'Test error message',
      command: 'claim',
    });

    // Control: a code the issue records as registered must accept this exact
    // envelope shape, so a failure below can only mean the code is unregistered.
    expect(ErrorResponseSchema.safeParse(makeEnvelope('VALIDATION_ERROR')).success).toBe(true);

    const failedCodes = testCodes.filter(
      (code) => !ErrorResponseSchema.safeParse(makeEnvelope(code)).success,
    );

    // This assertion must pass: every error code that claim can emit
    // must be registered in the error-code schema.
    expect(failedCodes).toEqual([]);
  });
});
