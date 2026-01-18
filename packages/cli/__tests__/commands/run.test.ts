import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  readSession,
  getActiveState,
  listRunbookStates,
  readRunbookState,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('start command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('file mode', () => {
    it('creates runbook state from valid runbook file', async () => {
      const result = runCli('run --prompted runbooks/simple.runbook.md', workspace);

      if (result.exitCode !== 0) {
        console.log('Run failed:', result.stdout, result.stderr);
      }

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Action:   START');
      expect(result.stdout).toContain('simple.runbook.md');
    });

    it('sets runbook as active', async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);

      const session = await readSession(workspace);
      expect(session.active).toBeTruthy();
    });

    it('stores relative path in state', async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);

      const state = await getActiveState(workspace);
      expect(state).not.toBeNull();
      expect(state?.runbook).toBe('runbooks/simple.runbook.md');
    });

    it('initializes step=1 and retryCount=0', async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);

      const state = await getActiveState(workspace);
      expect(state?.step).toBe('1');
      expect(state?.retryCount).toBe(0);
    });

    it('outputs first step description', async () => {
      const result = runCli('run --prompted runbooks/simple.runbook.md', workspace);

      expect(result.stdout).toContain('## 1.');
      expect(result.stdout).toContain('First step');
    });

    it('fails if file does not exist', async () => {
      const result = runCli('run runbooks/nonexistent.md', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('fails if no file argument provided', async () => {
      const result = runCli('run', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('required');
    });

    it('creates state file on disk', async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);

      const stateFiles = await listRunbookStates(workspace);
      expect(stateFiles.length).toBe(1);
    });
  });

  describe('auto-execution mode', () => {
    it('executes commands and advances through runbook', async () => {
      const result = runCli('run runbooks/simple.runbook.md', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('$ rd echo --result pass');
      expect(result.stdout).toContain('Runbook:  COMPLETE');
    });

    it('completes runbook when all commands pass', async () => {
      runCli('run runbooks/simple.runbook.md', workspace);

      // Runbook completed, so active runbook is null
      const session = await readSession(workspace);
      expect(session.active).toBeNull();
    });
  });

  describe('step queueing mode (--step)', () => {
    beforeEach(async () => {
      // Start a runbook first (prompted mode to keep it active)
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('pushes step to pendingSteps queue', async () => {
      const result = runCli('run --step 2', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('queued');
    });

    it('accepts simple step number', async () => {
      const result = runCli('run --step 1', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Step 1 queued');
    });

    it('accepts substep format', async () => {
      const result = runCli('run --step 1.1', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1.1');
    });

    it('adds step to state pendingSteps array', async () => {
      runCli('run --step 2', workspace);

      const state = await getActiveState(workspace);
      expect(state?.pendingSteps).toHaveLength(1);
    });

    it('fails if no active runbook', async () => {
      // Stop current runbook
      runCli('stop', workspace);

      const result = runCli('run --step 2', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No active runbook');
    });

    it('fails if invalid step format', async () => {
      // Note: 'abc' is now a valid named step identifier
      // Use '123abc' which starts with digit but contains letters - invalid format
      const result = runCli('run --step 123abc', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid step ID');
    });

    it('should queue step with runbook file', async () => {
      const result = runCli('run --step 1.1 runbooks/simple.runbook.md', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('queued');
      expect(result.stdout).toContain('1.1');

      const state = await getActiveState(workspace);
      expect(state?.pendingSteps).toHaveLength(1);
      expect(state?.pendingSteps[0].runbook).toBe('runbooks/simple.runbook.md');
    });
  });

  describe('agent-scoped runbook start', () => {
    it('starts runbook in agent-specific stack', async () => {
      // Start parent in default stack (prompted to keep active)
      let result = runCli('run --prompted runbooks/simple.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Start child in agent-001 stack (prompted to keep active)
      result = runCli('run --prompted runbooks/retry.runbook.md --agent agent-001', workspace);
      expect(result.exitCode).toBe(0);

      // Default status should still show parent (simple.runbook.md)
      result = runCli('status', workspace);
      expect(result.stdout).toContain('simple.runbook.md');

      // Agent status should show child (retry.runbook.md)
      result = runCli('status --agent agent-001', workspace);
      expect(result.stdout).toContain('retry.runbook.md');
    });
  });

  describe('agent binding mode (--agent)', () => {
    beforeEach(async () => {
      // Start runbook (prompted mode to keep it active) and queue a step
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
      runCli('run --step 1', workspace);
    });

    it('pops step from pendingSteps queue', async () => {
      runCli('run --agent test-agent', workspace);

      const state = await getActiveState(workspace);
      expect(state?.pendingSteps).toHaveLength(0);
    });

    it('binds agent to popped step', async () => {
      runCli('run --agent test-agent', workspace);

      const state = await getActiveState(workspace);
      expect(state?.agentBindings).toHaveProperty('test-agent');
    });

    it('sets agent status to running', async () => {
      runCli('run --agent test-agent', workspace);

      const state = await getActiveState(workspace);
      const bindings = state?.agentBindings;
      const binding = (bindings as Record<string, unknown>)['test-agent'];
      expect((binding as Record<string, unknown>).status).toBe('running');
    });

    it('outputs binding info', async () => {
      const result = runCli('run --agent test-agent', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('test-agent');
      expect(result.stdout).toContain('bound');
    });

    it('fails if pendingSteps is empty', async () => {
      // Pop the queued step
      runCli('run --agent agent1', workspace);

      // Try to bind another agent
      const result = runCli('run --agent agent2', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No pending step');
    });

    it('fails if no active runbook', async () => {
      runCli('stop', workspace);

      const result = runCli('run --agent test-agent', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No active runbook');
    });

    it('should create child runbook linked to parent', async () => {
      // Pop the step without runbook
      runCli('run --agent temp-agent', workspace);

      // Now queue step 1 with a runbook
      runCli('run --step 1 runbooks/simple.runbook.md', workspace);

      // Bind agent - should create child runbook
      const result = runCli('run --agent test-agent-123', workspace);
      expect(result.exitCode).toBe(0);

      // Verify child runbook was created
      const stateFiles = await listRunbookStates(workspace);
      expect(stateFiles.length).toBe(2); // parent + child

      // Get session - child is in agent's stack (new architecture)
      const session = await readSession(workspace);
      const agentStack = session.stacks['test-agent-123'] ?? [];
      expect(agentStack.length).toBe(1); // Child is in agent's stack
      const childId = agentStack[0];

      const allStates = await Promise.all(
        stateFiles.map(file => readRunbookState(workspace, file.replace('.json', '')))
      );
      const parentState = allStates.find(state => {
        const bindings = state?.agentBindings;
        // bindings is either defined or undefined, not null
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        return Object.values((bindings as Record<string, unknown>) || {})
          .some((binding: unknown) =>
            typeof binding === 'object' &&
            binding !== null &&
            'childRunbookId' in binding &&
            (binding as Record<string, unknown>).childRunbookId === childId
          );
      });

      expect(parentState).toBeTruthy();
      const agentBindings = (parentState!.agentBindings) as Record<string, unknown>;
      const agentBinding = agentBindings['test-agent-123'];
      expect((agentBinding as Record<string, unknown>).childRunbookId).toBe(childId);
    });
  });
});