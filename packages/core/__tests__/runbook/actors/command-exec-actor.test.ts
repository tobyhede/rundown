import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createActor } from 'xstate';
import {
  commandExecActor,
  type CommandExecutionInput,
  type CommandExecutionOutput,
  type CommandExecutionServices,
} from '../../../src/runbook/actors/command-exec-actor.js';

function runActor(input: CommandExecutionInput): Promise<CommandExecutionOutput> {
  return new Promise((resolve, reject) => {
    const actor = createActor(commandExecActor, { input });
    actor.subscribe({
      next: (snapshot) => {
        if (snapshot.status === 'done') resolve(snapshot.output);
        if (snapshot.status === 'error') {
          const error = snapshot.error;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      error: reject,
    });
    actor.start();
  });
}

describe('commandExecActor', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-command-exec-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('runs an internal command before falling back to the external runner', async () => {
    const calls: string[] = [];
    const services: CommandExecutionServices = {
      runInternalCommand: async ({ command }) => {
        calls.push(`internal:${command}`);
        return { success: true, exitCode: 0 };
      },
      runExternalCommand: async ({ command }) => {
        calls.push(`external:${command}`);
        return { success: false, exitCode: 99 };
      },
    };

    await expect(
      runActor({
        services,
        command: 'rd echo -r pass',
        displayCommand: 'rd echo -r pass',
        cwd: tmp,
        runId: 'rd_11111111111111111111111111111111',
        runbookPath: 'workflow.runbook.md',
        runbook: { source: 'project', path: 'workflow.runbook.md' },
        outputScope: { stepId: '1' },
        nakedOutputs: [],
        rdInjected: { RD_RUN_ID: 'rd_11111111111111111111111111111111' },
      }),
    ).resolves.toMatchObject({
      kind: 'completed',
      result: 'pass',
      command: 'rd echo -r pass',
      displayCommand: 'rd echo -r pass',
      exitCode: 0,
      channels: [],
    });
    expect(calls).toEqual(['internal:rd echo -r pass']);
  });

  it('falls back to the external runner when the internal handler returns null', async () => {
    const calls: string[] = [];
    const services: CommandExecutionServices = {
      runInternalCommand: async ({ command }) => {
        calls.push(`internal:${command}`);
        return null;
      },
      runExternalCommand: async ({ command }) => {
        calls.push(`external:${command}`);
        return { success: false, exitCode: 2, sandboxed: true };
      },
    };

    await expect(
      runActor({
        services,
        command: 'npm test',
        displayCommand: 'npm test',
        cwd: tmp,
        runId: 'rd_22222222222222222222222222222222',
        runbookPath: 'workflow.runbook.md',
        runbook: { source: 'project', path: 'workflow.runbook.md' },
        outputScope: { stepId: '1' },
        nakedOutputs: [],
        rdInjected: { RD_RUN_ID: 'rd_22222222222222222222222222222222' },
      }),
    ).resolves.toMatchObject({
      kind: 'completed',
      result: 'fail',
      exitCode: 2,
      sandboxed: true,
    });
    expect(calls).toEqual(['internal:npm test', 'external:npm test']);
  });

  it('prepares naked OUTPUTS channels and injects their env vars before execution', async () => {
    let receivedEnv: Record<string, string> | undefined;
    const services: CommandExecutionServices = {
      runExternalCommand: async ({ rdInjected }) => {
        receivedEnv = rdInjected;
        return { success: true, exitCode: 0 };
      },
    };

    const output = await runActor({
      services,
      command: 'printf value > "$RD_OUTPUTS_Result"',
      displayCommand: 'printf value > "$RD_OUTPUTS_Result"',
      cwd: tmp,
      runId: 'rd_33333333333333333333333333333333',
      runbookPath: 'workflow.runbook.md',
      runbook: { source: 'project', path: 'workflow.runbook.md' },
      outputScope: { stepId: '1' },
      nakedOutputs: [{ name: 'Result' }],
      rdInjected: { RD_RUN_ID: 'rd_33333333333333333333333333333333' },
    });

    expect(output).toMatchObject({
      kind: 'completed',
      result: 'pass',
      channels: [{ name: 'Result' }],
    });
    expect(receivedEnv?.RD_RUN_ID).toBe('rd_33333333333333333333333333333333');
    expect(receivedEnv?.RD_OUTPUTS_Result).toContain(path.join('.rundown', 'runs'));
  });

  it('returns a policy-denied result without throwing', async () => {
    const services: CommandExecutionServices = {
      runExternalCommand: async () => ({
        success: false,
        exitCode: 126,
        policyDenied: true,
        denialReason: 'command blocked',
        sandboxed: false,
      }),
    };

    await expect(
      runActor({
        services,
        command: 'curl https://example.test',
        displayCommand: 'curl https://example.test',
        cwd: tmp,
        runId: 'rd_44444444444444444444444444444444',
        runbookPath: 'workflow.runbook.md',
        runbook: { source: 'project', path: 'workflow.runbook.md' },
        outputScope: { stepId: '1' },
        nakedOutputs: [],
        rdInjected: { RD_RUN_ID: 'rd_44444444444444444444444444444444' },
      }),
    ).resolves.toMatchObject({
      kind: 'policy_denied',
      command: 'curl https://example.test',
      displayCommand: 'curl https://example.test',
      exitCode: 126,
      denialReason: 'command blocked',
      sandboxed: false,
    });
  });

  it('lets catastrophic runner errors reject instead of converting them to policy denial', async () => {
    const services: CommandExecutionServices = {
      runExternalCommand: async () => {
        throw new Error('spawn subsystem unavailable');
      },
    };

    await expect(
      runActor({
        services,
        command: 'npm test',
        displayCommand: 'npm test',
        cwd: tmp,
        runId: 'rd_55555555555555555555555555555555',
        runbookPath: 'workflow.runbook.md',
        runbook: { source: 'project', path: 'workflow.runbook.md' },
        outputScope: { stepId: '1' },
        nakedOutputs: [],
        rdInjected: { RD_RUN_ID: 'rd_55555555555555555555555555555555' },
      }),
    ).rejects.toThrow('spawn subsystem unavailable');
  });
});
