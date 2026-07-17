import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  runCli,
  getActiveState,
  parseCliJsonObject,
  parseFinalCliJsonObject,
  issueRunControlClaim,
  readRunbookState,
  readSession,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertClaimId, claimKeyFromBearer, ErrorResponseSchema } from '@rundown-org/core';

describe('Delegation claim integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

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
            {
              title: 'Security review',
              delegate: true,
              content: 'Do security review.',
              runbooks: [childRunbook],
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
  }

  async function getAutoIssuedToken(substepId = '1'): Promise<string> {
    const state = await getActiveState(workspace);
    const token = state?.substepStates?.find((substep) => substep.id === substepId)?.delegation
      ?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    return token!;
  }

  it('rejects invalid token format', () => {
    const result = runCli('claim bad-token', workspace);
    expect(result.exitCode).toBe(1);
    const envelope = parseCliJsonObject(result.stdout || result.stderr);
    expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'INVALID_TOKEN' }));
    expect(ErrorResponseSchema.safeParse(envelope).success).toBe(true);
  });

  it('rejects unknown token', () => {
    // Token with correct format but no matching delegation
    // cspell:disable-next-line
    const result = runCli('claim rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', workspace);
    expect(result.exitCode).toBe(1);
    const envelope = parseCliJsonObject(result.stdout || result.stderr);
    expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'TOKEN_NOT_FOUND' }));
    expect(ErrorResponseSchema.safeParse(envelope).success).toBe(true);
  });

  it('delegate → claim end-to-end', async () => {
    await writeParentRunbook();
    await writeChildRunbook();

    // Start parent in prompted mode
    let result = runCli('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);

    const token = await getAutoIssuedToken();

    // Claim the token — should launch child runbook
    result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const claimOutput = parseFinalCliJsonObject(result.stdout) as {
      kind: string;
      action: string;
      token: string;
      claim_id: string;
      run_id: string;
      runbook: string;
      parent_run_id: string;
      parent_step: string;
    };
    expect(claimOutput).toEqual(
      expect.objectContaining({
        kind: 'claim',
        action: 'claimed',
        token: expect.stringMatching(/^rdtk_.{3}\.\.\..{4}$/),
        claim_id: expect.stringMatching(/^rdclm_/),
        run_id: expect.any(String),
        parent_run_id: expect.any(String),
        parent_step: expect.any(String),
      }),
    );
    expect(claimOutput.token).not.toMatch(/^rdtk_[A-Za-z0-9_-]{32}$/);
  });

  it('goto --claim-id moves the claimed child cursor without moving the parent', async () => {
    // Migrated from the `explicit-goto` scenario in
    // runbooks/delegation/delegate-claim-explicit-close.runbook.md, which
    // asserted this by reading .rundown/session.json and the run state files
    // inside a `node -e` one-liner. State-file inspection belongs in jest
    // (docs/internal/scenarios.md); the scenario retains the CLI interaction
    // sequence and asserts through the scenario schema.
    await writeParentRunbook('child-three-step.runbook.md');
    await writeFile(
      join(workspace.cwd, 'child-three-step.runbook.md'),
      createRunbook({
        title: 'Child Three Step',
        steps: [
          { title: 'One', pass: 'CONTINUE', content: 'Step one.' },
          { title: 'Two', pass: 'CONTINUE', content: 'Step two.' },
          { title: 'Three', pass: 'COMPLETE', content: 'Step three.' },
        ],
      }),
    );

    expect(runCli('run --prompted parent.runbook.md --text', workspace).exitCode).toBe(0);
    const parentRunId = (await getActiveState(workspace))?.id;
    expect(parentRunId).toEqual(expect.any(String));

    const token = await getAutoIssuedToken();
    const claimResult = runCli(`claim ${token}`, workspace);
    expect(claimResult.exitCode).toBe(0);
    const claimId = assertClaimId(
      (parseFinalCliJsonObject(claimResult.stdout) as { claim_id: string }).claim_id,
    );

    const goto = runCli(`goto 3 --claim-id ${claimId}`, workspace);
    expect(goto.exitCode).toBe(0);

    // The claim record resolves the bearer to the child run it controls, and
    // records the parent it was delegated from.
    const session = await readSession(workspace);
    const claim = session.claims[claimKeyFromBearer(claimId)] as
      | { controlledRunId: string; delegation: { parentRunId: string } }
      | undefined;
    expect(claim).toBeDefined();
    expect(claim?.delegation.parentRunId).toBe(parentRunId);

    const child = await readRunbookState(workspace, claim!.controlledRunId);
    const parent = await readRunbookState(workspace, parentRunId!);
    // The claimed child advanced to 3; the parent's own cursor never moved.
    expect(child?.step).toBe('3');
    expect(parent?.step).toBe('1');
  });

  it('claims a delegated child resolved from the bundled runbooks directory', async () => {
    const parentContent = `# Parent

## 1. Parent work
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Bundled child

- DELEGATE
- delegation-child-pass.runbook.md
`;
    await writeFile(join(workspace.cwd, 'parent-bundled-child.runbook.md'), parentContent);

    let result = runCli('run parent-bundled-child.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('delegation-child-pass.runbook.md');
    const tokenMatch = /"token":\s*"(rdtk_[^"]+)"/.exec(result.stdout);
    expect(tokenMatch).not.toBeNull();

    result = runCli(`claim ${tokenMatch![1]}`, workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(
      'Resolved runbook path escapes source root',
    );

    const claimOutput = parseFinalCliJsonObject(result.stdout) as {
      kind?: string;
      action?: string;
      runbook?: string;
    };
    expect(claimOutput.kind).toBe('claim');
    expect(claimOutput.action).toBe('claimed');
    expect(claimOutput.runbook).toContain('delegation-child-pass.runbook.md');
  });

  it('re-claiming a token is refused after the first claim', async () => {
    await writeParentRunbook();
    await writeChildRunbook();

    // Start parent, delegate
    let result = runCli('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);

    const token = await getAutoIssuedToken();

    // First claim
    result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);

    // Second claim is token replay and must be refused.
    result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(1);
    const replay = parseCliJsonObject(result.stdout) as {
      kind?: string;
      code?: string;
    };
    expect(replay.kind).toBe('error');
    expect(replay.code).toBe('DELEGATION_ALREADY_CLAIMED');
  });

  it('claim with outputs structured data', async () => {
    await writeParentRunbook();
    await writeChildRunbook();

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const claimToken = await getAutoIssuedToken();
    result = runCli(`claim ${claimToken}`, workspace);

    // Command should succeed
    expect(result.exitCode).toBe(0);

    // Parse last JSON line — claim output follows child-run JSON events
    const claimOutput = parseFinalCliJsonObject(result.stdout);
    expect(claimOutput.kind).toBe('claim');
    expect(claimOutput.action).toBe('claimed');
    expect(claimOutput.token).toMatch(/^rdtk_.{3}\.\.\..{4}$/);
    expect(typeof claimOutput.run_id).toBe('string');
    expect(typeof claimOutput.runbook).toBe('string');
    expect(typeof claimOutput.parent_run_id).toBe('string');
    expect(typeof claimOutput.parent_step).toBe('string');
  });

  it('claim with --input-file merges file variables into child context', async () => {
    await writeParentRunbook();

    // Child runbook echoes the variable to confirm it was received
    const childContent = `## 1. Execute
- PASS COMPLETE

Task uses {{ myVar }}.
`;
    await writeFile(join(workspace.cwd, 'child.runbook.md'), childContent);

    // Write a YAML var file
    await writeFile(join(workspace.cwd, 'vars.yaml'), 'myVar: fromFile\n');

    // Start parent, delegate
    let result = runCli('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);

    const token = await getAutoIssuedToken();

    // Claim with --input-file
    result = runCli(`claim ${token} --input-file vars.yaml`, workspace);
    expect(result.exitCode).toBe(0);

    // Verify the variable was rendered in child execution output
    expect(result.stdout).toContain('Task uses fromFile.');

    // Parse last JSON line for claimed output
    const claimOutput = parseFinalCliJsonObject(result.stdout);
    expect(claimOutput.kind).toBe('claim');
    expect(claimOutput.action).toBe('claimed');
  });

  it('claim outputs structured error for invalid token', () => {
    const result = runCli('claim bad-token', workspace);
    expect(result.exitCode).toBe(1);

    const output = parseCliJsonObject(result.stdout || result.stderr);
    expect(output).toEqual(expect.objectContaining({ kind: 'error', code: 'INVALID_TOKEN' }));
    expect(ErrorResponseSchema.safeParse(output).success).toBe(true);
  });

  it('rejects ${TOKEN_0} in scenario command sequence', async () => {
    // Write a runbook whose scenario uses the invalid ${TOKEN_0} placeholder
    const content = [
      '---',
      'scenarios:',
      '  bad-token:',
      '    description: TOKEN_0 is invalid (1-based indexing)',
      '    result: STOP',
      '    commands:',
      '      - rd run --prompted bad-token.runbook.md',
      '      - rd claim ${TOKEN_0}',
      '---',
      '',
      '## 1. Parent',
      '- PASS ALL COMPLETE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Delegated step',
      '- DELEGATE',
      '',
      'Do work.',
      '',
      '- child.runbook.md',
      '',
      '## 2. Done',
      '- PASS COMPLETE',
      '',
      'Finished.',
    ].join('\n');
    await writeFile(join(workspace.runbooksDir(), 'bad-token.runbook.md'), content);

    // Child runbook for the delegation
    const childContent = '## 1. Execute\n- PASS COMPLETE\n\nRun task.\n';
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

    const result = runCli('scenario run bad-token.runbook.md bad-token -q --text', workspace);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/TOKEN_0|references uncaptured token/);
  });

  describe('auto-propagation on claim', () => {
    /** Helper: write a child runbook that auto-completes (no prompting needed). */
    async function writeAutoCompleteChildRunbook(): Promise<void> {
      const content = `## 1. Execute
- PASS COMPLETE

\`\`\`bash
rd echo --result pass
\`\`\`
`;
      await writeFile(join(workspace.cwd, 'auto-child.runbook.md'), content);
    }

    it('auto-propagates when child completes during claim', async () => {
      await writeParentRunbook('auto-child.runbook.md');
      await writeAutoCompleteChildRunbook();

      // Start parent in non-prompted mode (so child will auto-complete)
      let result = runCli('run parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Verify parent is waiting at substep 1.1
      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      expect(parentState!.step).toBe('1');
      expect(parentState!.substep).toBe('1');
      const parentRunId = parentState!.id;
      const parentClaimId = await issueRunControlClaim(workspace, parentRunId);

      const token1 = await getAutoIssuedToken('1');
      const token2 = await getAutoIssuedToken('2');

      // Claim 1.1 — child auto-completes and REPORTS pass (report-only, Plan 5).
      // The delegating run is left collection pending; it does NOT advance on close.
      result = runCli(`claim ${token1} --text`, workspace);
      expect(result.exitCode).toBe(0);

      // Claim 1.2 — its child also auto-completes and reports pass.
      result = runCli(`claim ${token2} --text`, workspace);
      expect(result.exitCode).toBe(0);

      // Explicit collect aggregates both reported outcomes: PASS ALL → CONTINUE → step 2.
      result = runCli(`collect --text --claim-id ${parentClaimId}`, workspace);
      expect(result.exitCode).toBe(0);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.step).toBe('2');
    });

    it('auto-propagates fail when child stops during claim', async () => {
      await writeParentRunbook('fail-child.runbook.md');
      // Write a child that will fail/stop
      const failChildContent = `## 1. Execute
- FAIL STOP

\`\`\`bash
rd echo --result fail
\`\`\`
`;
      await writeFile(join(workspace.cwd, 'fail-child.runbook.md'), failChildContent);

      // Start parent
      let result = runCli('run parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;
      const parentClaimId = await issueRunControlClaim(workspace, parentRunId);

      const token1 = await getAutoIssuedToken('1');
      const token2 = await getAutoIssuedToken('2');

      // Claim 1.1 — child auto-fails and REPORTS fail (report-only, Plan 5).
      // Exit-code narrowing: the child's FAIL action is STOP, so the child
      // locally STOPs and claim exits 1 on the child's OWN lifecycle.
      result = runCli(`claim ${token1} --text`, workspace);
      expect(result.exitCode).toBe(1);

      // Claim 1.2 — its child also auto-fails and reports fail.
      result = runCli(`claim ${token2} --text`, workspace);
      expect(result.exitCode).toBe(1);

      // Explicit collect aggregates the reported outcomes: FAIL ANY → STOP.
      result = runCli(`collect --text --claim-id ${parentClaimId}`, workspace);
      expect(result.exitCode).toBe(1);

      // Parent should be stopped
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.lifecycle).toBe('stopped');
    });
  });
});
