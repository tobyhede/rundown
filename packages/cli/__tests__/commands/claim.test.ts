import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  findActionOutput,
  getActiveState,
  readRunbookState,
  readSession,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorResponseSchema } from '@rundown-org/core';

describe('claim command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Helper: write parent runbook with substeps */
  async function writeParentRunbook(): Promise<void> {
    const content = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Review',
          pass: 'CONTINUE',
          substeps: [
            { title: 'Code review', content: 'Do code review.' },
            { title: 'Security review', content: 'Do security review.' },
          ],
        },
        { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
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

  /** Helper: extract token from output */
  function extractToken(stdout: string): string {
    // JSON output (default): delegate response is a JSON object with a token field
    const parsed = JSON.parse(stdout) as { token?: string };
    if (!parsed.token) throw new Error(`No token found in delegate output:\n${stdout}`);
    return parsed.token;
  }

  describe('basic claim functionality', () => {
    it('rejects claim with invalid token format', async () => {
      const result = await runCliInProcess('claim invalid-token --text', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/invalid.*token|rdtk_/i);
    });

    it('emits INVALID_TOKEN JSON envelope for invalid token format', async () => {
      const result = await runCliInProcess('claim invalid-token', workspace);

      expect(result.exitCode).toBe(1);
      const envelope = JSON.parse(result.stdout) as {
        kind?: string;
        code?: string;
        details?: Record<string, unknown>;
      };
      expect(envelope).toEqual(
        expect.objectContaining({
          kind: 'error',
          code: 'INVALID_TOKEN',
          details: expect.objectContaining({ token: 'invalid-token' }),
        }),
      );
      expect(ErrorResponseSchema.safeParse(envelope).success).toBe(true);
    });

    it('rejects claim with token missing prefix', async () => {
      // cspell:disable
      const result = await runCliInProcess(
        'claim AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH --text',
        workspace,
      );
      // cspell:enable
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/invalid.*token|rdtk_/i);
    });

    it('rejects claim with token that is too short', async () => {
      const result = await runCliInProcess('claim rdtk_ABC --text', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/not found|no active/i);
    });

    it('rejects claim with unknown token', async () => {
      // Valid format but no matching delegation
      const result = await runCliInProcess(
        // cspell:disable-next-line
        'claim rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
        workspace,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/not found|no active/i);
    });

    it('ignores unrelated env vars when claiming', async () => {
      const result = await runCliInProcess(
        // cspell:disable-next-line
        'claim rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
        workspace,
        {
          env: { RUNDOWN_TEST_ENV: 'session-without-agent' },
        },
      );

      expect(result.exitCode).toBe(1);
      const envelope = JSON.parse(result.stdout) as { kind?: string; code?: string };
      expect(envelope).toEqual(
        expect.objectContaining({
          kind: 'error',
          code: 'TOKEN_NOT_FOUND',
        }),
      );
      expect(ErrorResponseSchema.safeParse(envelope).success).toBe(true);
    });

    it('successfully claims valid delegation token', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Delegate substep 1.1
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // Claim should succeed
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
    });

    it('records a claim id and activates the claimed child runbook', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);
      const parentId = (await getActiveState(workspace))!.id;

      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const action = findActionOutput(result.stdout);
      const childRunId = String(action?.run_id);
      const claimId = String(action?.claim_id);
      expect(claimId).toMatch(/^rdclm_[A-Za-z0-9_-]{22}$/);

      const session = await readSession(workspace);
      expect(session.defaultStack).toEqual([parentId, childRunId]);
      expect(Object.values(session.claims)).toContainEqual(
        expect.objectContaining({
          kind: 'claim-record',
          claimId,
          childRunId,
          parentRunId: parentId,
          tokenHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
      );

      // Bare commands target the claimed child — `rd claim` activates it.
      const active = await getActiveState(workspace);
      expect(active?.id).toBe(childRunId);
    });

    it('returns the same claim_id when re-claiming the same token', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const first = findActionOutput(result.stdout);

      result = await runCliInProcess(`claim ${token}`, workspace);

      expect(result.exitCode).toBe(0);
      const second = findActionOutput(result.stdout);
      expect(second?.run_id).toBe(first?.run_id);
      expect(second?.claim_id).toBe(first?.claim_id);
    });

    it('does not pop the parent when an identified child auto-completes', async () => {
      await writeParentRunbook();
      const child = createRunbook({
        title: 'Auto Child',
        steps: [
          {
            title: 'Execute',
            pass: 'COMPLETE',
            fail: 'STOP',
            command: 'rd echo -r pass',
          },
        ],
      });
      await writeFile(join(workspace.cwd, 'child.runbook.md'), child);

      let result = await runCliInProcess('run parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);
      const parentId = (await getActiveState(workspace))!.id;

      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      const session = await readSession(workspace);
      expect(session.defaultStack).toEqual([parentId]);
      expect(Object.values(session.claims)).toEqual([]);

      const anonymousActive = await getActiveState(workspace);
      expect(anonymousActive?.id).toBe(parentId);
    });
  });

  describe('idempotent claim behavior', () => {
    it('allows re-claiming same token multiple times', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Delegate
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // First claim
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const firstClaim = findActionOutput(result.stdout);
      expect(typeof firstClaim?.run_id).toBe('string');
      expect(typeof firstClaim?.claim_id).toBe('string');

      // Second claim - should return same child
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const secondClaim = findActionOutput(result.stdout);
      expect(typeof secondClaim?.run_id).toBe('string');
      expect(typeof secondClaim?.claim_id).toBe('string');

      expect(secondClaim?.run_id).toBe(firstClaim?.run_id);
      expect(secondClaim?.claim_id).toBe(firstClaim?.claim_id);
    }, 15_000);

    it('third claim still returns same child', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // Claim three times
      await runCliInProcess(`claim ${token} --text`, workspace);
      await runCliInProcess(`claim ${token} --text`, workspace);
      result = await runCliInProcess(`claim ${token}`, workspace);

      expect(result.exitCode).toBe(0);
    }, 15_000);
  });

  describe('JSON output', () => {
    it('outputs structured JSON with flag', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const delegateOutput = JSON.parse(result.stdout);
      const token = delegateOutput.token as string;

      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      const jsonLines = result.stdout.trim().split('\n');
      const output = JSON.parse(jsonLines[jsonLines.length - 1]);
      expect(output.action).toBe('claimed');
      expect(output.token).toMatch(/^rdtk_.{3}\.\.\..{4}$/);
      expect(typeof output.claim_id).toBe('string');
      expect(typeof output.run_id).toBe('string');
      expect(typeof output.runbook).toBe('string');
      expect(typeof output.parent_run_id).toBe('string');
      expect(typeof output.parent_step).toBe('string');
    });

    it('outputs error for invalid token', async () => {
      const result = await runCliInProcess('claim bad-token', workspace);
      expect(result.exitCode).toBe(1);

      // In-process execution routes errors differently; verify error is surfaced
      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(/invalid.*token|rdtk_|error/i);
    });

    it('includes all required fields in success JSON', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      const token = JSON.parse(result.stdout).token as string;

      result = await runCliInProcess(`claim ${token}`, workspace);
      const jsonLines = result.stdout.trim().split('\n');
      const output = JSON.parse(jsonLines[jsonLines.length - 1]);

      // Verify all required fields
      expect(output).toHaveProperty('action');
      expect(output).toHaveProperty('token');
      expect(output).toHaveProperty('claim_id');
      expect(output).toHaveProperty('run_id');
      expect(output).toHaveProperty('runbook');
      expect(output).toHaveProperty('parent_run_id');
      expect(output).toHaveProperty('parent_step');
    });
  });

  describe('variable inheritance', () => {
    it('passes variables via --input flag to child', async () => {
      await writeParentRunbook();

      // Child that uses a variable
      const childContent = `## 1. Task
- PASS COMPLETE

Execute with {{Env}} environment.
`;
      await writeFile(join(workspace.cwd, 'var-child.runbook.md'), childContent);

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      result = await runCliInProcess('delegate var-child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      result = await runCliInProcess(`claim ${token} --input Env=staging --text`, workspace);
      expect(result.exitCode).toBe(0);
    });

    it('handles multiple --input flags', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      result = await runCliInProcess(
        `claim ${token} --input Env=staging --input Region=us-west --text`,
        workspace,
      );
      expect(result.exitCode).toBe(0);
    });

    it('preserves ContextId but generates a fresh RunId for claimed child runs', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess(
        'run --prompted parent.runbook.md --input ContextId=ctx-parent --text',
        workspace,
      );
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentTemplateVars = (parentState?.templateVars ?? {}) as Record<string, unknown>;

      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      const claimAction = findActionOutput(result.stdout);
      const childState = await readRunbookState(workspace, String(claimAction?.run_id));
      expect(childState).not.toBeNull();
      const childTemplateVars = (childState?.templateVars ?? {}) as Record<string, unknown>;

      expect(parentTemplateVars.ContextId).toBe('ctx-parent');
      expect(childTemplateVars.ContextId).toBe('ctx-parent');
      expect(typeof parentTemplateVars.RunId).toBe('string');
      expect(typeof childTemplateVars.RunId).toBe('string');
      expect(childTemplateVars.RunId).not.toBe(parentTemplateVars.RunId);
    });
  });

  describe('auto-propagation on claim', () => {
    /** Helper: write child that auto-completes via command */
    async function writeAutoCompleteChild(): Promise<void> {
      const content = `## 1. Execute
- PASS COMPLETE

\`\`\`bash
rd echo --result pass
\`\`\`
`;
      await writeFile(join(workspace.cwd, 'auto-child.runbook.md'), content);
    }

    it('propagates pass when child auto-completes during claim', async () => {
      await writeParentRunbook();
      await writeAutoCompleteChild();

      // Start parent in non-prompted mode
      let result = await runCliInProcess('run parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      // Delegate and claim
      result = await runCliInProcess('delegate auto-child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // After auto-propagation, parent is at substep 1.2 (1.1 resolved, advanced)
      // Complete substep 1.2 → aggregation → PASS ALL → CONTINUE → step 2
      result = await runCliInProcess('pass --text', workspace);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.step).toBe('2');
    });

    it('propagates fail when child auto-stops during claim', async () => {
      await writeParentRunbook();

      const failChild = `## 1. Execute
- FAIL STOP

\`\`\`bash
rd echo --result fail
\`\`\`
`;
      await writeFile(join(workspace.cwd, 'fail-child.runbook.md'), failChild);

      let result = await runCliInProcess('run parent.runbook.md --text', workspace);
      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      result = await runCliInProcess('delegate fail-child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      // Claim will trigger auto-fail — parent 1.1 DEFER fail, advance to 1.2
      result = await runCliInProcess(`claim ${token}`, workspace);

      // Complete parent substep 1.2 → aggregation → FAIL ANY: STOP
      result = await runCliInProcess('pass --text', workspace);

      // Parent should be stopped
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.lifecycle).toBe('stopped');
    });
  });

  describe('edge cases', () => {
    it('handles claim when parent runbook file is missing', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      // Delete parent runbook file (state still exists)
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), '');

      // Claim should still work (uses stored runbook content)
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
    });

    it('handles claim with empty token string', async () => {
      const result = await runCliInProcess(['claim', '', '--text'], workspace);
      expect(result.exitCode).toBe(1);
    });

    it('handles claim with whitespace token', async () => {
      const result = await runCliInProcess(['claim', '  ', '--text'], workspace);
      expect(result.exitCode).toBe(1);
    });

    it('handles cancelled delegation token', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      // Cancel the delegation (via stop command on parent)
      result = await runCliInProcess('stop --text', workspace);
      expect(result.exitCode).toBe(0);

      // Attempt to claim — parent is stopped, delegation cannot be claimed
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/not found|no active|stopped/i);
    });

    it('fails to claim aborted delegation token', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      // Abort the delegation
      result = await runCliInProcess(`abort ${token} --text`, workspace);
      expect(result.exitCode).toBe(0);

      // Attempt to claim aborted delegation
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/cancelled|RD-809/i);
    });

    it('rejects delegation to non-existent child runbook', async () => {
      await writeParentRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Delegate to non-existent file should fail
      result = await runCliInProcess('delegate missing-child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/not found/i);
    });
  });

  describe('successive claims', () => {
    it('handles rapid successive claims of same token', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      // Rapid succession claims
      const result1 = await runCliInProcess(`claim ${token} --text`, workspace);
      const result2 = await runCliInProcess(`claim ${token} --text`, workspace);
      const result3 = await runCliInProcess(`claim ${token} --text`, workspace);

      // All should succeed (idempotent)
      expect(result1.exitCode).toBe(0);
      expect(result2.exitCode).toBe(0);
      expect(result3.exitCode).toBe(0);
    }, 15_000);
  });

  describe('multi-claim targeting', () => {
    it('returns distinct claim ids for sibling delegated children', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      const tokenA = extractToken(result.stdout);
      result = await runCliInProcess('delegate child.runbook.md --step 1.2', workspace);
      const tokenB = extractToken(result.stdout);

      result = await runCliInProcess(`claim ${tokenA}`, workspace);
      expect(result.exitCode).toBe(0);
      const actionA = findActionOutput(result.stdout);
      const childAId = String(actionA?.run_id);
      const claimIdA = String(actionA?.claim_id);

      result = await runCliInProcess(`claim ${tokenB}`, workspace);
      expect(result.exitCode).toBe(0);
      const actionB = findActionOutput(result.stdout);
      const childBId = String(actionB?.run_id);
      const claimIdB = String(actionB?.claim_id);

      expect(claimIdA).toMatch(/^rdclm_[A-Za-z0-9_-]{22}$/);
      expect(claimIdB).toMatch(/^rdclm_[A-Za-z0-9_-]{22}$/);
      expect(claimIdA).not.toBe(claimIdB);
      expect(childAId).not.toBe(childBId);

      const session = await readSession(workspace);
      expect(Object.values(session.claims)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ childRunId: childAId, claimId: claimIdA }),
          expect.objectContaining({ childRunId: childBId, claimId: claimIdB }),
        ]),
      );
    });
  });

  describe('context inheritance', () => {
    it('child inherits parent context variables', async () => {
      // Parent with variables
      const parentWithVars = `---
PlanPath: .rundown/work/plan.md
Region: us-west
---

## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Code review
Review code.
`;
      await writeFile(join(workspace.cwd, 'parent-vars.runbook.md'), parentWithVars);

      // Child that references parent vars
      const childWithContext = `## 1. Task
- PASS COMPLETE

Parent region: {{context.parent.vars.Region}}
Plan: {{context.parent.vars.PlanPath}}
`;
      await writeFile(join(workspace.cwd, 'child-ctx.runbook.md'), childWithContext);

      let result = await runCliInProcess('run --prompted parent-vars.runbook.md --text', workspace);
      result = await runCliInProcess('delegate child-ctx.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
    });
  });
});
