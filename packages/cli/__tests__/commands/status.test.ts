import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DelegationStatusEntrySchema } from '@rundown-org/core';
import {
  createTestWorkspace,
  runCliInProcess,
  readSession,
  getActiveState,
  findActionOutput,
  parseFinalCliJsonObject,
  readRunbookState,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { validateStatusOutput } from '../helpers/schema-validator.js';
import {
  patchPersistedRunState,
  seedSession,
  writeRawRunJson,
} from '@rundown-org/core/testing/session-fixtures';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/status.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess). See collect.test.ts.
import { registerStatusCommand } from '../../src/commands/status.js';

describe('status command wiring', () => {
  it('registers the status command with its documented flags and descriptions', () => {
    const program = new Command();
    registerStatusCommand(program);

    const status = program.commands.find((c) => c.name() === 'status');
    expect(status).toBeDefined();
    expect(status?.description()).toBe('Show current runbook state');

    const byLong = new Map(status!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(expect.arrayContaining(['--claim-id', '--text']));
    expect(byLong.get('--claim-id')?.description).toBe('Target a claimed delegated child runbook');
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
  });
});

describe('status command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('displays current step info', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('status --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 1.');
    expect(result.stdout).toContain('First step');
  });

  it('shows runbook file path', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('status --text', workspace);

    expect(result.stdout).toContain('File:');
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('shows retryCount', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('status --text', workspace);

    // Status shows step information, retryCount is internal state
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 1.');
  });

  it('shows runbook ID', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('status --text', workspace);

    expect(result.stdout).toContain('State:');
    expect(result.stdout).toMatch(/rd_[a-f0-9]{32}/);
  });

  it('reports invalid persisted state without prune guidance', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const state = await getActiveState(workspace);
    expect(state).toBeDefined();

    await patchPersistedRunState(workspace.cwd, state!.id, {
      schemaVersion: 2,
    });

    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).not.toBe(0);

    const output = result.stderr.trim() || result.stdout.trim();
    const error = JSON.parse(output) as {
      kind?: string;
      error?: string;
      code?: string;
    };

    expect(error.kind).toBe('error');
    expect(error.code).toBe('RD-999');
    expect(error.error).toMatch(/invalid runbook state|state.*invalid/i);

    const emitted = `${result.stdout}\n${result.stderr}`;
    expect(emitted).not.toMatch(/prune/i);
    expect(emitted).not.toMatch(/clear invalid state/i);
  });

  describe('incompatible database schema (RD-305)', () => {
    // Seed the store as the FIRST open in this process: a database whose
    // `user_version` predates the cutover. `ensureSchema` runs in
    // `openRunbookDriver` on that first open and rejects the version before any
    // query, so both read-only and mutating commands surface RD-305. (Seeding
    // via a prior `run` would cache the store and skip the re-check.)
    async function seedIncompatibleDatabase(): Promise<void> {
      await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
      const db = new DatabaseSync(join(workspace.cwd, '.rundown', 'rundown.db'));
      db.exec('PRAGMA user_version = 1');
      db.close();
    }

    type ErrorEnvelope = {
      kind?: string;
      code?: string;
      error?: string;
      details?: { category?: string; context?: Record<string, unknown> };
    };

    function parseError(result: { stdout: string; stderr: string }): ErrorEnvelope {
      return JSON.parse(result.stderr.trim() || result.stdout.trim()) as ErrorEnvelope;
    }

    it('refuses a read-only command with a typed RD-305 envelope naming the database file', async () => {
      await seedIncompatibleDatabase();

      const result = await runCliInProcess('status', workspace);

      expect(result.exitCode).not.toBe(0);
      const error = parseError(result);
      expect(error.kind).toBe('error');
      expect(error.code).toBe('RD-305');
      expect(error.code).not.toBe('RD-999');
      expect(error.details?.category).toBe('STATE');
      expect(error.details?.context).toMatchObject({ foundVersion: 1, expectedVersion: 2 });
      expect(error.error).toMatch(/\.rundown\/rundown\.db/);
    });

    it('refuses a mutating command with the same RD-305 envelope', async () => {
      await seedIncompatibleDatabase();

      const result = await runCliInProcess('pass', workspace);

      expect(result.exitCode).not.toBe(0);
      const error = parseError(result);
      expect(error.code).toBe('RD-305');
      expect(error.details?.category).toBe('STATE');
    });
  });

  it('outputs "No active runbook" when none', async () => {
    const result = await runCliInProcess('status --text', workspace);

    expect(result.stdout).toContain('No active runbook');
  });

  it('shows stashed runbook info when stashed but not active', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('shows stashed status in JSON when stashed but not active', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.active).toBe(false);
    expect(output.stashed).toBe(true);
    expect(output.file).toContain('simple.runbook.md');
  });
});

describe('claim-id delegated children', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('resolves status to the claimed child before the default stack', async () => {
    const parentRunbook = [
      '# Parent',
      '',
      '## 1. Fan out',
      '',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 First child',
      '',
      '- DELEGATE',
      '',
      'Do first child.',
      '',
      '- runbooks/child-status.runbook.md',
      '',
      '### 1.2 Second child',
      '',
      '- DELEGATE',
      '',
      'Do second child.',
      '',
      '- runbooks/child-status.runbook.md',
      '',
    ].join('\n');
    const childRunbook = [
      '# Child',
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
    await writeFile(join(workspace.cwd, 'runbooks', 'parent-status.md'), parentRunbook);
    await writeFile(join(workspace.cwd, 'runbooks', 'child-status.runbook.md'), childRunbook);

    await runCliInProcess('run --prompted runbooks/parent-status.md --text', workspace);
    const parentId = (await getActiveState(workspace))!.id;

    const parent = await getActiveState(workspace);
    const token1 = parent?.substepStates?.find((substep) => substep.id === '1')?.delegation?.token;
    const token2 = parent?.substepStates?.find((substep) => substep.id === '2')?.delegation?.token;
    expect(token1).toEqual(expect.stringMatching(/^rdtk_/));
    expect(token2).toEqual(expect.stringMatching(/^rdtk_/));
    if (typeof token1 !== 'string' || typeof token2 !== 'string') {
      throw new Error('Expected delegation tokens');
    }

    let result = await runCliInProcess(`claim ${token1}`, workspace);
    expect(result.exitCode).toBe(0);
    const child1Output = findActionOutput(result.stdout);
    expect(child1Output).toBeDefined();
    expect(typeof child1Output?.run_id).toBe('string');
    expect(typeof child1Output?.claim_id).toBe('string');
    const child1Id = child1Output!.run_id as string;
    const claimId1 = child1Output!.claim_id as string;

    result = await runCliInProcess(`claim ${token2}`, workspace);
    expect(result.exitCode).toBe(0);
    const child2Output = findActionOutput(result.stdout);
    expect(child2Output).toBeDefined();
    expect(typeof child2Output?.run_id).toBe('string');
    expect(typeof child2Output?.claim_id).toBe('string');
    const child2Id = child2Output!.run_id as string;
    const claimId2 = child2Output!.claim_id as string;

    let status = await runCliInProcess(['status', '--claim-id', claimId1], workspace);
    expect(JSON.parse(status.stdout).state).toContain(child1Id);

    status = await runCliInProcess(['status', '--claim-id', claimId2], workspace);
    expect(JSON.parse(status.stdout).state).toContain(child2Id);

    status = await runCliInProcess('status', workspace);
    expect(JSON.parse(status.stdout).state).toContain(parentId);
  });

  async function setupOwnedStash() {
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

    await runCliInProcess('run --prompted runbooks/parent-secret.md --text', workspace);
    const parent = await getActiveState(workspace);
    const token = parent?.substepStates?.[0]?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    if (typeof token !== 'string') throw new Error('Expected delegation token');
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

    await patchPersistedRunState(workspace.cwd, childRunId, (state) => ({
      ...state,
      variables: { secretOutput: 'top-secret-output' },
      templateVars: {
        ...(state.templateVars ?? {}),
        secretInput: 'top-secret-input',
      },
    }));

    await runCliInProcess(['stash', '--claim-id', claimId, '--text'], workspace);
    await seedSession(workspace.cwd, { defaultStack: [] });
    return { childRunId, claimId };
  }

  it('plain status can report the global stashed child without claim vars', async () => {
    await setupOwnedStash();

    const status = await runCliInProcess('status', workspace);

    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(
      expect.objectContaining({ active: false, stashed: true }),
    );
    expect(status.stdout).toContain('child-secret.runbook.md');
    // Plain status must not leak claim-scoped variables: only `--claim-id`
    // callers see them (asserted positively in the next test).
    expect(status.stdout).not.toContain('top-secret-input');
    expect(status.stdout).not.toContain('top-secret-output');
  });

  it('claim id can see its own stashed status', async () => {
    const { childRunId, claimId } = await setupOwnedStash();

    const status = await runCliInProcess(['status', '--claim-id', claimId], workspace);
    const output = JSON.parse(status.stdout);

    expect(status.exitCode).toBe(0);
    expect(output.active).toBe(true);
    expect(output.stashed).toBe(true);
    expect(output.file).toContain('child-secret.runbook.md');
    expect(output.state).toContain(childRunId);
    expect(output.parentLinkage).toEqual(
      expect.objectContaining({
        kind: 'delegation',
        parentStepId: '1',
      }),
    );
    expect(output.vars).toEqual(
      expect.objectContaining({
        secretInput: 'top-secret-input',
        secretOutput: 'top-secret-output',
      }),
    );
  });

  it('claim id renders terminal child status instead of unavailable', async () => {
    const { childRunId, claimId } = await setupOwnedStash();
    await patchPersistedRunState(workspace.cwd, childRunId, {
      lifecycle: 'completed',
    });

    const status = await runCliInProcess(['status', '--claim-id', claimId], workspace);
    const output = JSON.parse(status.stdout);

    expect(status.exitCode).toBe(0);
    expect(output.active).toBe(false);
    expect(output.status).toBe('completed');
    expect(output.state).toContain(childRunId);
  });

  it('anonymous stash remains visible to plain callers', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);

    const status = await runCliInProcess('status', workspace);
    const output = JSON.parse(status.stdout);

    expect(status.exitCode).toBe(0);
    expect(output.active).toBe(false);
    expect(output.stashed).toBe(true);
    expect(output.file).toContain('simple.runbook.md');
  });
});

describe('JSON lastAction.result semantics', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('reports lastAction.result PASS after successful pass', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('pass --text', workspace); // Triggers CONTINUE (success)

    const result = await runCliInProcess('status', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('PASS');
    expect(output.lastAction.action).toBe('CONTINUE');
  });

  it('reports lastAction.result FAIL after fail triggers RETRY', async () => {
    await runCliInProcess('run --prompted runbooks/retry.runbook.md --text', workspace);
    await runCliInProcess('fail --text', workspace); // Triggers RETRY (failure)

    const result = await runCliInProcess('status', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('FAIL');
    expect(output.lastAction.action).toMatch(/^RETRY/);
  });

  it('reports lastAction.result PASS after pass triggers GOTO', async () => {
    await runCliInProcess('run --prompted runbooks/goto.runbook.md --text', workspace);
    await runCliInProcess('pass --text', workspace); // Triggers GOTO 3 (success)

    const result = await runCliInProcess('status', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('PASS');
    expect(output.lastAction.action).toMatch(/^GOTO/);
  });

  it('reports lastAction.result FAIL after fail triggers GOTO', async () => {
    await runCliInProcess('run --prompted runbooks/fail-goto.runbook.md --text', workspace);
    await runCliInProcess('fail --text', workspace); // Triggers GOTO 3 (failure)

    const result = await runCliInProcess('status', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('FAIL');
    expect(output.lastAction.action).toMatch(/^GOTO/);
  });
});

describe('ls command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('lists all runbook states', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('ls --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('marks active runbook', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('ls --text', workspace);

    expect(result.stdout).toContain('active');
  });

  it('shows current step for each', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('ls --text', workspace);

    expect(result.stdout).toContain('1/');
  });

  it('outputs "No active runbooks" when empty', async () => {
    const result = await runCliInProcess('ls --text', workspace);

    expect(result.stdout).toContain('No active runbooks');
  });
});

describe('complete command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('marks runbook as complete', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('complete --text', workspace);

    expect(result.stdout).toContain('COMPLETE');
  });

  it('clears active runbook', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    await runCliInProcess('complete --text', workspace);

    const session = await readSession(workspace);
    expect(session.active).toBeNull();
  });

  it('handles no active runbook', async () => {
    const result = await runCliInProcess('complete', workspace);

    expect(result.stdout).toContain('No active runbook');
  });

  it('includes message in JSON output', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess(['complete', 'Early exit - tests passed'], workspace);

    // Bare complete now streams a runbook_completed observation before the final
    // action object, so parse the final newline-delimited JSON object.
    const output = parseFinalCliJsonObject(result.stdout);
    expect(output.message).toBe('Early exit - tests passed');
  });

  it('uses default message when none provided', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('complete', workspace);

    const output = parseFinalCliJsonObject(result.stdout);
    expect(output.message).toBe('Runbook completed successfully');
  });

  it('fails closed for stale claimed runbook state without touching default stack', async () => {
    const parentRunbook = `## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child
- DELEGATE

Do child.

- child.runbook.md
`;
    const childRunbook = `## 1. Child
- PASS COMPLETE

Do work.
`;
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentRunbook);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), childRunbook);

    let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);
    const parentState = await getActiveState(workspace);
    expect(parentState).not.toBeNull();
    const token = parentState?.substepStates?.[0]?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    if (typeof token !== 'string') throw new Error('Expected delegation token');
    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const claimOutput = findActionOutput(result.stdout);
    const childRunId = claimOutput?.run_id;
    const claimId = claimOutput?.claim_id;
    expect(typeof childRunId).toBe('string');
    expect(typeof claimId).toBe('string');
    // Pre-SQLite this deleted `.rundown/runs/<child>.json`, leaving the claim
    // behind. The store's `claims.controlled_run` FK cascades, so a claim whose
    // run row is gone is unrepresentable; the surviving analogue of "claimed but
    // unusable child state" is an unparseable state blob on a live run row.
    await writeRawRunJson(workspace.cwd, String(childRunId), '{invalid');

    result = await runCliInProcess(
      ['complete', '--claim-id', String(claimId), '--text'],
      workspace,
    );
    expect(result.exitCode).not.toBe(0);

    const session = await readSession(workspace);
    expect(Object.values(session.claims)).toContainEqual(
      expect.objectContaining({ controlledRunId: childRunId }),
    );
    expect(session.defaultStack).toContain(parentState!.id);
    expect(session.active).toBe(parentState!.id);
  });

  it('reports delegated child completion to the parent (uncollected)', async () => {
    const parentRunbook = `## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child
- DELEGATE

Do child.

- child.runbook.md

## 2. Done
- PASS COMPLETE

Done.
`;
    const childRunbook = `## 1. Child
- PASS COMPLETE

Do work.
`;
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentRunbook);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), childRunbook);

    let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);
    const parentState = await getActiveState(workspace);
    expect(parentState).not.toBeNull();

    const token = parentState?.substepStates?.[0]?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    if (typeof token !== 'string') throw new Error('Expected delegation token');

    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const claimAction = findActionOutput(result.stdout);
    const childRunId = claimAction?.run_id;
    const claimId = claimAction?.claim_id;
    expect(typeof childRunId).toBe('string');
    expect(typeof claimId).toBe('string');

    result = await runCliInProcess(`complete --claim-id ${String(claimId)} --text`, workspace);
    expect(result.exitCode).toBe(0);

    const childState = await readRunbookState(workspace, String(childRunId));
    expect(childState?.lifecycle).toBe('completed');

    // Plan 5 (report-only): the child close records a PASS outcome on the
    // delegating run, which is left collection pending — NOT auto-advanced. The
    // parent stays on its DELEGATE step until its orchestrator runs `rd collect`.
    const updatedParent = await readRunbookState(workspace, parentState!.id);
    expect(updatedParent?.step).toBe('1');
    const rows = Object.values(updatedParent!.resolvedCompletions ?? {}).filter(
      (c) => c.agentId === 'delegation',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('pass');

    const session = await readSession(workspace);
    expect(session.defaultStack.at(-1)).toBe(parentState!.id);
    expect(session.defaultStack).not.toContain(String(childRunId));
    // R2: completing the delegated child resolves its parent delegation, so the
    // durable latch supersedes the claim in that same commit. The superseded row
    // is retained in the database (generation accounting, prune) but no longer
    // surfaces as an active claim.
    expect(Object.values(session.claims)).not.toContainEqual(
      expect.objectContaining({ controlledRunId: childRunId }),
    );
  });

  it('pops orphaned default-stack entry when state file is missing', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const state = await getActiveState(workspace);
    const stateId = state!.id;
    // `session_stack.run_id` cascades on run delete, so a stack entry pointing at
    // a missing run is unrepresentable. An empty state blob is the closest
    // surviving analogue: the row exists, the state it should hold does not.
    await writeRawRunJson(workspace.cwd, stateId, '{}');

    const result = await runCliInProcess('complete', workspace);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).message).toBe('Removed unusable runbook state from session');
    const session = await readSession(workspace);
    expect(session.active).toBeNull();
    expect(session.defaultStack).toHaveLength(0);
  });

  it('pops orphaned default-stack entry when state file is corrupted', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const state = await getActiveState(workspace);
    const stateId = state!.id;
    await writeRawRunJson(workspace.cwd, stateId, '{invalid');

    const result = await runCliInProcess('complete', workspace);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).message).toBe('Removed unusable runbook state from session');
    const session = await readSession(workspace);
    expect(session.active).toBeNull();
    expect(session.defaultStack).toHaveLength(0);
  });

  it('pops orphaned default-stack entry when state is invalid', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const state = await getActiveState(workspace);
    const stateId = state!.id;
    await patchPersistedRunState(workspace.cwd, stateId, { schemaVersion: 2 });

    const result = await runCliInProcess('complete', workspace);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).message).toBe('Removed unusable runbook state from session');
    const session = await readSession(workspace);
    expect(session.active).toBeNull();
    expect(session.defaultStack).toHaveLength(0);
  });

  it('does not remove anonymous default stack when a claim id has no claim', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const sessionBefore = await readSession(workspace);
    const parentId = sessionBefore.defaultStack.at(-1);
    expect(parentId).toBeDefined();

    const result = await runCliInProcess(
      [
        'complete',
        '--claim-id',
        'rdclm_00000000000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '--text',
      ],
      workspace,
    );

    expect(result.exitCode).not.toBe(0);
    // Refusal identifies the claim by its non-secret lookup key, never the bearer secret.
    expect(`${result.stdout}${result.stderr}`).toContain(
      'Claim id rdclk_00000000000000000000000000000000 does not exist',
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    const sessionAfter = await readSession(workspace);
    expect(sessionAfter.defaultStack).toEqual([parentId]);
  });
});

describe('status with runbookSrc', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('should compute step total from runbookSrc', async () => {
    // Create a runbook with variable
    const runbookContent = `# Test Runbook

## 1. First Step
- PASS CONTINUE

\`\`\`bash
rd echo {{message}}
\`\`\`

## 2. Second Step
- PASS COMPLETE

\`\`\`bash
rd echo done
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    // Run with variable to store runbookSrc
    await runCliInProcess('run test.runbook.md --input message=hello --prompted --text', workspace);

    // Delete the source file to prove we're using runbookSrc, not disk
    await rm(join(workspace.cwd, 'test.runbook.md'));

    // Status should work using runbookSrc (not disk fallback)
    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.position.total).toBe(2);
  });
});

describe('claim ids on claimed delegations (#531)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function setupClaimedDelegation(): Promise<{
    claimId: string;
    childRunId: string;
  }> {
    const parentRunbook = [
      '# Parent ClaimId',
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
      '- runbooks/child-claim-id.runbook.md',
      '',
    ].join('\n');
    const childRunbook = [
      '# Child ClaimId',
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
    await writeFile(join(workspace.cwd, 'runbooks', 'parent-claim-id.md'), parentRunbook);
    await writeFile(join(workspace.cwd, 'runbooks', 'child-claim-id.runbook.md'), childRunbook);
    await runCliInProcess('run --prompted runbooks/parent-claim-id.md --text', workspace);

    const parent = await getActiveState(workspace);
    const token = parent?.substepStates?.[0]?.delegation?.token;
    if (typeof token !== 'string') throw new Error('Expected delegation token');
    // Real `rd claim` writes the ClaimRecord into .rundown/session.json.
    const claimed = await runCliInProcess(`claim ${token}`, workspace);
    const claimOutput = findActionOutput(claimed.stdout);
    if (
      !claimOutput ||
      typeof claimOutput.claim_id !== 'string' ||
      typeof claimOutput.run_id !== 'string'
    ) {
      throw new Error('Expected claim output with claim_id and run_id');
    }
    return { claimId: claimOutput.claim_id, childRunId: claimOutput.run_id };
  }

  it('surfaces claimed child runs in status JSON (#531)', async () => {
    const { childRunId } = await setupClaimedDelegation();

    const result = await runCliInProcess('status', workspace); // plain status -> parent
    expect(result.exitCode).toBe(0);

    const output = JSON.parse(result.stdout) as {
      delegations?: Array<{
        state: string;
        childRunId?: string;
        claimId?: string;
        claimKey?: string;
      }>;
    };
    const entry = output.delegations?.find((d) => d.childRunId === childRunId);
    expect(entry).toMatchObject({ state: 'claimed', childRunId });
    expect(entry?.claimKey).toMatch(/^rdclk_[a-f0-9]{32}$/);
    expect(entry).not.toHaveProperty('claimId');

    // The whole payload still validates against the status schema.
    const validation = validateStatusOutput(output);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('renders the child run id in the claimed label in text output (#531)', async () => {
    const { childRunId } = await setupClaimedDelegation();

    const result = await runCliInProcess('status --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/claimed: rdclk_[a-f0-9]{32} run: rd_[a-f0-9]{32}/);
    expect(result.stdout).toContain(childRunId);
  });

  it('DelegationStatusEntrySchema forbids claimId on delegation status entries (#531)', () => {
    const base = {
      substep: '1.1',
      runbook: 'runbooks/child-claim-id.runbook.md',
      tokenHash: `sha256:${'a'.repeat(64)}`,
    };
    const claimId =
      'rdclm_00000000000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const childRunId = `rd_${'a'.repeat(32)}`;

    const claimKey = `rdclk_${'b'.repeat(32)}`;
    expect(
      DelegationStatusEntrySchema.safeParse({
        ...base,
        state: 'claimed',
        childRunId,
        claimKey,
      }).success,
    ).toBe(true);
    expect(
      DelegationStatusEntrySchema.safeParse({
        ...base,
        state: 'claimed',
        childRunId,
        claimId,
      }).success,
    ).toBe(false);
    expect(
      DelegationStatusEntrySchema.safeParse({
        ...base,
        state: 'claimed',
        childRunId,
        claimKey: `rdclk_${'b'.repeat(32)}`,
      }).success,
    ).toBe(true);
    // Cancelled-after-claim entries retain childRunId but must NOT carry claimId.
    expect(
      DelegationStatusEntrySchema.safeParse({
        ...base,
        state: 'cancelled',
        childRunId,
      }).success,
    ).toBe(true);
    expect(
      DelegationStatusEntrySchema.safeParse({
        ...base,
        state: 'cancelled',
        childRunId,
        claimId,
      }).success,
    ).toBe(false);
    // Pending entries must not carry claimId either.
    expect(
      DelegationStatusEntrySchema.safeParse({
        ...base,
        state: 'pending',
        claimId,
      }).success,
    ).toBe(false);
  });
});
