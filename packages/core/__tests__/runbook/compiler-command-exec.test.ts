import { describe, expect, it } from '@jest/globals';
import { createActor } from 'xstate';
import { compileRunbookToMachine, type CommandExecutionServices } from '../../src/runbook/index.js';
import type { ResolvedStep } from '../../src/runbook/types.js';

const commandStep = {
  kind: 'command',
  name: '1',
  description: 'Build',
  command: { code: 'npm test', lang: 'bash' },
  outputs: [],
  transitions: {
    pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
    fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
  },
} as unknown as ResolvedStep;

function services(
  result: Awaited<ReturnType<CommandExecutionServices['runExternalCommand']>>,
): CommandExecutionServices {
  return {
    runExternalCommand: async () => result,
  };
}

async function waitForDone(actor: ReturnType<typeof createActor>): Promise<void> {
  await new Promise<void>((resolve) => {
    actor.subscribe((snapshot) => {
      if (snapshot.status === 'done') resolve();
    });
  });
}

describe('compiled machine command execution', () => {
  it('executes a command through the command actor and raises PASS through output capture', async () => {
    const machine = compileRunbookToMachine([commandStep], {
      commandServices: services({ success: true, exitCode: 0 }),
      evaluationOptions: { cwd: process.cwd() },
      templateVars: {
        RunId: 'rd_11111111111111111111111111111111',
        WorkPath: '.rundown/work',
        ContextId: 'ctx',
        RunbookRef: { source: 'project', path: 'workflow.runbook.md' },
      } as never,
    });
    const actor = createActor(machine).start();

    actor.send({
      type: 'EXECUTE_COMMAND',
      command: 'npm test',
      displayCommand: 'npm test',
      runbookPath: 'workflow.runbook.md',
      outputScope: { stepId: '1' },
      nakedOutputs: [],
      rdInjected: { RD_RUN_ID: 'rd_11111111111111111111111111111111' },
    });

    await waitForDone(actor);

    const snapshot = actor.getPersistedSnapshot() as unknown as {
      value: unknown;
      context: { lifecycle: string; lastAction?: { type: string } };
    };
    expect(snapshot.value).toBe('COMPLETE');
    expect(snapshot.context.lifecycle).toBe('completed');
    expect(snapshot.context.lastAction?.type).toBe('COMPLETE');
  });

  it('persists a normal command failure result from actor output', async () => {
    const machine = compileRunbookToMachine([commandStep], {
      commandServices: services({ success: false, exitCode: 2 }),
      evaluationOptions: { cwd: process.cwd() },
      templateVars: {
        RunId: 'rd_66666666666666666666666666666666',
        WorkPath: '.rundown/work',
        ContextId: 'ctx',
        RunbookRef: { source: 'project', path: 'workflow.runbook.md' },
      } as never,
    });
    const actor = createActor(machine).start();

    actor.send({
      type: 'EXECUTE_COMMAND',
      command: 'npm test',
      displayCommand: 'npm test',
      runbookPath: 'workflow.runbook.md',
      outputScope: { stepId: '1' },
      nakedOutputs: [],
      rdInjected: { RD_RUN_ID: 'rd_66666666666666666666666666666666' },
    });

    await waitForDone(actor);

    const snapshot = actor.getPersistedSnapshot() as unknown as {
      value: unknown;
      context: { lifecycle: string; lastAction?: { type: string } };
    };
    expect(snapshot.value).toBe('STOPPED');
    expect(snapshot.context.lifecycle).toBe('stopped');
    expect(snapshot.context.lastAction?.type).toBe('STOP');
  });

  it('stops with policy_denied without converting it to a normal FAIL transition', async () => {
    const machine = compileRunbookToMachine([commandStep], {
      commandServices: services({
        success: false,
        exitCode: 126,
        policyDenied: true,
        denialReason: 'blocked by test policy',
      }),
      evaluationOptions: { cwd: process.cwd() },
      templateVars: {
        RunId: 'rd_22222222222222222222222222222222',
        WorkPath: '.rundown/work',
        ContextId: 'ctx',
        RunbookRef: { source: 'project', path: 'workflow.runbook.md' },
      } as never,
    });
    const actor = createActor(machine).start();

    actor.send({
      type: 'EXECUTE_COMMAND',
      command: 'curl https://example.test',
      displayCommand: 'curl https://example.test',
      runbookPath: 'workflow.runbook.md',
      outputScope: { stepId: '1' },
      nakedOutputs: [],
      rdInjected: { RD_RUN_ID: 'rd_22222222222222222222222222222222' },
    });

    await waitForDone(actor);

    const snapshot = actor.getPersistedSnapshot() as unknown as {
      value: unknown;
      context: { lifecycle: string; lastAction?: { type: string; message?: string } };
    };
    expect(snapshot.value).toBe('STOPPED');
    expect(snapshot.context.lifecycle).toBe('stopped');
    expect(snapshot.context.lastAction).toEqual({
      type: 'POLICY_DENIED',
      message: 'blocked by test policy',
      origin: 'direct',
    });
  });

  it('stops with command_execution_failed when the command actor throws', async () => {
    const machine = compileRunbookToMachine([commandStep], {
      commandServices: {
        runExternalCommand: async () => {
          throw new Error('spawn subsystem unavailable');
        },
      },
      evaluationOptions: { cwd: process.cwd() },
      templateVars: {
        RunId: 'rd_77777777777777777777777777777777',
        WorkPath: '.rundown/work',
        ContextId: 'ctx',
        RunbookRef: { source: 'project', path: 'workflow.runbook.md' },
      } as never,
    });
    const actor = createActor(machine).start();

    actor.send({
      type: 'EXECUTE_COMMAND',
      command: 'npm test',
      displayCommand: 'npm test',
      runbookPath: 'workflow.runbook.md',
      outputScope: { stepId: '1' },
      nakedOutputs: [],
      rdInjected: { RD_RUN_ID: 'rd_77777777777777777777777777777777' },
    });

    await waitForDone(actor);

    const snapshot = actor.getPersistedSnapshot() as unknown as {
      value: unknown;
      context: { lifecycle: string; lastAction?: { type: string; message?: string } };
    };
    expect(snapshot.value).toBe('STOPPED');
    expect(snapshot.context.lifecycle).toBe('stopped');
    expect(snapshot.context.lastAction).toEqual({
      type: 'COMMAND_EXECUTION_FAILED',
      message: 'spawn subsystem unavailable',
      origin: 'direct',
    });
  });
});
