import { describe, expect, it } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
      rdInjected: { RD_RUN_ID: 'rd_22222222222222222222222222222222' },
    });

    await waitForDone(actor);

    const snapshot = actor.getPersistedSnapshot() as unknown as {
      value: unknown;
      context: {
        lifecycle: string;
        lastAction?: { type: string; message?: string };
        lastResult?: string;
      };
    };
    expect(snapshot.value).toBe('STOPPED');
    expect(snapshot.context.lifecycle).toBe('stopped');
    expect(snapshot.context.lastResult).toBeUndefined();
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
      rdInjected: { RD_RUN_ID: 'rd_77777777777777777777777777777777' },
    });

    await waitForDone(actor);

    const snapshot = actor.getPersistedSnapshot() as unknown as {
      value: unknown;
      context: {
        lifecycle: string;
        lastAction?: { type: string; message?: string };
        lastResult?: string;
      };
    };
    expect(snapshot.value).toBe('STOPPED');
    expect(snapshot.context.lifecycle).toBe('stopped');
    expect(snapshot.context.lastResult).toBeUndefined();
    expect(snapshot.context.lastAction).toEqual({
      type: 'COMMAND_EXECUTION_FAILED',
      message: 'spawn subsystem unavailable',
      origin: 'direct',
    });
  });
});

describe('compiled machine OUTPUTS derivation', () => {
  // The scope and the naked declarations used to be derived by the CLI and
  // shipped on EXECUTE_COMMAND. They are now derived behind the machine: the
  // declarations are compile-time-bound from the leaf's own definition, and
  // the scope is built from the leaf's identity. `RD_OUTPUTS_*` is where both
  // become observable, since the channel path encodes every scope tier.
  const substepOutputsStep = {
    kind: 'substeps',
    name: '1',
    description: 'Release',
    outputs: [{ name: 'ParentOnly' }],
    substeps: [
      {
        id: '1',
        description: 'Capture version',
        command: { code: 'printf v1', lang: 'bash' },
        outputs: [{ name: 'Version' }],
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
      },
    ],
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
  } as unknown as ResolvedStep;

  it('scopes channels to the executing substep and captures only its declarations', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-outputs-scope-'));
    let injected: Record<string, string> = {};
    const runId = 'rd_22222222222222222222222222222222';

    try {
      const machine = compileRunbookToMachine([substepOutputsStep], {
        commandServices: {
          runExternalCommand: async (runnerInput) => {
            injected = runnerInput.rdInjected;
            return { success: true, exitCode: 0 };
          },
        },
        evaluationOptions: { cwd },
        templateVars: {
          RunId: runId,
          WorkPath: '.rundown/work',
          ContextId: 'ctx',
          RunbookRef: { source: 'project', path: 'workflow.runbook.md' },
        } as never,
      });
      const actor = createActor(machine).start();

      actor.send({
        type: 'EXECUTE_COMMAND',
        command: 'printf v1',
        displayCommand: 'printf v1',
        runbookPath: 'workflow.runbook.md',
        rdInjected: { RD_RUN_ID: runId },
      });

      await waitForDone(actor);

      // Substep tier present, from the leaf's own identity — not from a
      // cursor the sender reported.
      expect(injected.RD_OUTPUTS_Version).toBe(
        path.join(cwd, '.rundown', 'runs', runId, 'outputs', '1', '1', 'Version'),
      );
      // The parent step's OUTPUTS belong to a different channel path, so a
      // substep unit must not capture them.
      expect(injected).not.toHaveProperty('RD_OUTPUTS_ParentOnly');
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
