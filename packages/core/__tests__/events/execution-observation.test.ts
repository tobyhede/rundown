import { describe, expect, it } from '@jest/globals';
import type { CommandExecutionOutput } from '../../src/runbook/actors/command-exec-actor.js';
import {
  commandCompletedEffect,
  commandStartedEffect,
  createExecutionEffectCollector,
  deriveStepEnteredEffect,
} from '../../src/events/execution-observation.js';

const exactArtifact = {
  kind: 'artifact-record' as const,
  uri: 'rd://artifacts/ctx/rd_11111111111111111111111111111111/plan.md',
  runId: 'rd_11111111111111111111111111111111',
  contextId: 'ctx',
  runbook: { source: 'project' as const, path: 'workflow.runbook.md' },
  key: 'plan.md',
  path: '.rundown/work/ctx/plan.md',
  description: 'plan',
  timestamp: '2026-05-15T00:00:00.000Z',
};

const wildcardArtifacts = [
  {
    kind: 'artifact-record' as const,
    uri: 'rd://artifacts/ctx/rd_11111111111111111111111111111111/log-a.txt',
    runId: 'rd_11111111111111111111111111111111',
    contextId: 'ctx',
    runbook: { source: 'project' as const, path: 'workflow.runbook.md' },
    key: 'log-a.txt',
    path: '.rundown/work/ctx/log-a.txt',
    timestamp: '2026-05-15T00:00:00.000Z',
  },
  {
    kind: 'artifact-record' as const,
    uri: 'rd://artifacts/ctx/rd_11111111111111111111111111111111/log-b.txt',
    runId: 'rd_11111111111111111111111111111111',
    contextId: 'ctx',
    runbook: { source: 'project' as const, path: 'workflow.runbook.md' },
    key: 'log-b.txt',
    path: '.rundown/work/ctx/log-b.txt',
    timestamp: '2026-05-15T00:00:00.000Z',
  },
];

describe('execution observation projection', () => {
  it('derives STEP_ENTERED artifacts from enteredArtifacts exact entries', () => {
    expect(
      deriveStepEnteredEffect({
        snapshot: {
          context: {
            step: '1',
            enteredArtifacts: { PlanPath: exactArtifact },
            variables: { IgnoredArtifact: exactArtifact },
          },
        },
        entry: {
          stepId: '1',
          position: { current: '1', total: 2 },
          stepName: 'Build',
          description: 'Build for staging',
          prompt: 'Check output',
          commandCode: 'npm test',
          commandLang: 'bash',
          isSubstep: false,
          prompted: false,
          delegateFrontier: [{ id: '1.1', runbook: 'child', token: 'rdt_example' }],
        },
      }),
    ).toEqual({
      kind: 'execution_observation',
      event: {
        type: 'STEP_ENTERED',
        payload: {
          position: { current: '1', total: 2 },
          stepName: 'Build',
          description: 'Build for staging',
          prompt: 'Check output',
          hasCommand: true,
          commandCode: 'npm test',
          commandLang: 'bash',
          isSubstep: false,
          prompted: false,
          artifacts: { PlanPath: exactArtifact },
          delegateFrontier: [{ id: '1.1', runbook: 'child', token: 'rdt_example' }],
        },
      },
    });
  });

  it('preserves wildcard artifact arrays from enteredArtifacts', () => {
    const effect = deriveStepEnteredEffect({
      snapshot: {
        context: {
          step: '2',
          enteredArtifacts: { Logs: wildcardArtifacts },
        },
      },
      entry: {
        stepId: '2',
        position: { current: '2', total: 2 },
        stepName: 'Inspect',
        isSubstep: false,
        prompted: false,
      },
    });

    expect(effect.event.payload.artifacts).toEqual({ Logs: wildcardArtifacts });
  });

  it('projects parent-entry artifacts when the current execution unit is a substep', () => {
    const effect = deriveStepEnteredEffect({
      snapshot: {
        context: {
          step: '3',
          substep: '3.2',
          enteredArtifacts: { ParentPlan: exactArtifact },
        },
      },
      entry: {
        stepId: '3',
        substepId: '3.2',
        position: { current: '3.2', total: 3 },
        stepName: '3.2',
        isSubstep: true,
        prompted: false,
      },
    });

    expect(effect.event.payload.artifacts).toEqual({ ParentPlan: exactArtifact });
    expect(effect.event.payload.isSubstep).toBe(true);
  });

  it('rejects STEP_ENTERED when entry metadata does not match the current snapshot step', () => {
    expect(() =>
      deriveStepEnteredEffect({
        snapshot: { context: { step: '2', enteredArtifacts: {} } },
        entry: {
          stepId: '1',
          position: { current: '1', total: 1 },
          stepName: 'Build',
          isSubstep: false,
          prompted: false,
        },
      }),
    ).toThrow('Cannot observe STEP_ENTERED for step 1 while machine snapshot is at 2');
  });

  it('collects command output and failure observations in memory only', () => {
    const collector = createExecutionEffectCollector();
    const output: CommandExecutionOutput = {
      kind: 'completed',
      command: 'npm test',
      displayCommand: 'npm test',
      success: true,
      result: 'pass',
      exitCode: 0,
      policyDenied: false,
      channels: [],
    };

    collector.recordCommandOutput(output);
    collector.recordCommandFailure('spawn failed');

    expect(
      commandStartedEffect({
        command: 'npm test',
        displayCommand: 'npm test',
        position: { current: '1', total: 1 },
      }).event.type,
    ).toBe('COMMAND_STARTED');
    expect(
      commandCompletedEffect({
        ...output,
        position: { current: '1', total: 1 },
      }).event.type,
    ).toBe('COMMAND_COMPLETED');
    expect(collector.commandOutput).toEqual(output);
    expect(collector.commandFailureMessage).toBe('spawn failed');
  });
});
