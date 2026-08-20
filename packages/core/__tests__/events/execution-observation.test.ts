import { describe, expect, it } from '@jest/globals';
import type { CommandExecutionOutput } from '../../src/runbook/actors/command-exec-actor.js';
import {
  commandCompletedEffect,
  commandStartedEffect,
  createExecutionEffectCollector,
  deriveStepEnteredEffect,
  policyDeniedEffect,
  projectDelegateFrontier,
} from '../../src/events/execution-observation.js';
import { brandEffectiveVarsForTest } from '../../src/testing/effective-vars.js';
import { assertClaimLookupKey } from '../../src/runbook/claim-id.js';
import {
  assertDelegationIssuanceNonce,
  hashDelegationToken,
} from '../../src/runbook/delegation-token.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { PersistedDelegateFrontierEntry } from '../../src/runbook/types.js';
const exactArtifact = {
  kind: 'artifact-record' as const,
  uri: 'rd://artifacts/ctx/rd_11111111111111111111111111111111/plan.md',
  runId: 'rd_11111111111111111111111111111111',
  contextId: 'ctx',
  runbook: { source: 'project' as const, path: 'workflow.runbook.md' },
  key: 'plan.md',
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
    timestamp: '2026-05-15T00:00:00.000Z',
  },
  {
    kind: 'artifact-record' as const,
    uri: 'rd://artifacts/ctx/rd_11111111111111111111111111111111/log-b.txt',
    runId: 'rd_11111111111111111111111111111111',
    contextId: 'ctx',
    runbook: { source: 'project' as const, path: 'workflow.runbook.md' },
    key: 'log-b.txt',
    timestamp: '2026-05-15T00:00:00.000Z',
  },
];

const ARTIFACT_PATH_OPTIONS = { cwd: '/tmp/project', workPath: '.rundown/work' } as const;

const publicExactArtifact = {
  kind: 'artifact-record' as const,
  uri: exactArtifact.uri,
  path: '/tmp/project/.rundown/work/.rd-ctx/rd_11111111111111111111111111111111/plan.md',
  runId: exactArtifact.runId,
  contextId: exactArtifact.contextId,
  runbook: exactArtifact.runbook,
  key: exactArtifact.key,
  timestamp: exactArtifact.timestamp,
};

const publicWildcardArtifacts = wildcardArtifacts.map((artifact) => ({
  kind: 'artifact-record' as const,
  uri: artifact.uri,
  path: `/tmp/project/.rundown/work/.rd-ctx/rd_11111111111111111111111111111111/${artifact.key}`,
  runId: artifact.runId,
  contextId: artifact.contextId,
  runbook: artifact.runbook,
  key: artifact.key,
  timestamp: artifact.timestamp,
}));

describe('execution observation projection', () => {
  it('projects descriptor-bearing frontier intents into public token entries', () => {
    const tokens = [`rdtk_${'A'.repeat(32)}`, `rdtk_${'B'.repeat(32)}`] as const;
    const frontier: readonly PersistedDelegateFrontierEntry[] = tokens.map((token, index) => ({
      id: `1.${String(index + 1)}`,
      runbook: `child-${String(index + 1)}.md`,
      credential: {
        version: 1,
        issuerClaimKey: assertClaimLookupKey(`rdclk_${'1'.repeat(32)}`),
        issuanceNonce: assertDelegationIssuanceNonce('A'.repeat(43)),
        parentRunId: assertRunId(`rd_${'2'.repeat(32)}`),
        parentStepId: `1.${String(index + 1)}`,
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
      },
      tokenHash: hashDelegationToken(token),
    }));

    expect(JSON.stringify(frontier)).not.toContain('rdtk_');
    expect(
      projectDelegateFrontier(
        frontier,
        (descriptor) => tokens[descriptor.parentStepId === '1.1' ? 0 : 1],
      ),
    ).toEqual([
      { id: '1.1', runbook: 'child-1.md', token: tokens[0] },
      { id: '1.2', runbook: 'child-2.md', token: tokens[1] },
    ]);
  });

  it('refuses to disclose a reconstructed frontier token that fails hash verification', () => {
    const persistedToken = `rdtk_${'A'.repeat(32)}`;
    const frontier: readonly PersistedDelegateFrontierEntry[] = [
      {
        id: '1.1',
        runbook: 'child.md',
        credential: {
          version: 1,
          issuerClaimKey: assertClaimLookupKey(`rdclk_${'1'.repeat(32)}`),
          issuanceNonce: assertDelegationIssuanceNonce('A'.repeat(43)),
          parentRunId: assertRunId(`rd_${'2'.repeat(32)}`),
          parentStepId: '1.1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
        },
        tokenHash: hashDelegationToken(persistedToken),
      },
    ];

    expect(() => projectDelegateFrontier(frontier, () => `rdtk_${'B'.repeat(32)}`)).toThrow(
      'Derived delegation credential does not match frontier 1.1',
    );
  });

  it('derives STEP_ENTERED artifacts from enteredArtifacts exact entries', () => {
    expect(
      deriveStepEnteredEffect({
        artifactPathOptions: ARTIFACT_PATH_OPTIONS,
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
          hasCommand: true,
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
          artifacts: { PlanPath: publicExactArtifact },
          delegateFrontier: [{ id: '1.1', runbook: 'child', token: 'rdt_example' }],
        },
      },
    });
  });

  it('preserves wildcard artifact arrays from enteredArtifacts', () => {
    const effect = deriveStepEnteredEffect({
      artifactPathOptions: ARTIFACT_PATH_OPTIONS,
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
        hasCommand: false,
        isSubstep: false,
        prompted: false,
      },
    });

    expect(effect.event.type).toBe('STEP_ENTERED');
    if (effect.event.type !== 'STEP_ENTERED') throw new Error('expected STEP_ENTERED');
    expect(effect.event.payload.artifacts).toEqual({ Logs: publicWildcardArtifacts });
  });

  it('projects parent-entry artifacts when the current execution unit is a substep', () => {
    const effect = deriveStepEnteredEffect({
      artifactPathOptions: ARTIFACT_PATH_OPTIONS,
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
        hasCommand: false,
        isSubstep: true,
        prompted: false,
      },
    });

    expect(effect.event.type).toBe('STEP_ENTERED');
    if (effect.event.type !== 'STEP_ENTERED') throw new Error('expected STEP_ENTERED');
    expect(effect.event.payload.artifacts).toEqual({ ParentPlan: publicExactArtifact });
    expect(effect.event.payload.isSubstep).toBe(true);
  });

  it('projects inline launch intent into STEP_ENTERED payload', () => {
    const inlineLaunch = {
      parentRunId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      parentStepId: '1',
      parentStep: '2',
      parentFrameKey: '2|',
      parentEntry: 3,
      childRunId: 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      childRunbookPath: 'runbooks/child.runbook.md',
      childRunbookRef: { source: 'project' as const, path: 'runbooks/child.runbook.md' },
      contextSnapshot: {
        vars: brandEffectiveVarsForTest({ env: 'prod' }),
        ancestors: [],
      },
    };

    const effect = deriveStepEnteredEffect({
      artifactPathOptions: ARTIFACT_PATH_OPTIONS,
      snapshot: { context: { step: '2', substep: '1' } },
      entry: {
        stepId: '2',
        substepId: '1',
        position: { current: '2.1', total: 3 },
        stepName: '1',
        hasCommand: false,
        isSubstep: true,
        prompted: false,
        inlineLaunch,
      },
    });

    expect(effect.event.type).toBe('STEP_ENTERED');
    if (effect.event.type !== 'STEP_ENTERED') throw new Error('expected STEP_ENTERED');
    expect(effect.event.payload.inlineLaunch).toEqual(inlineLaunch);
  });

  // The two cursor-mismatch guards that lived here are gone (#820). They refused
  // an entry whose `stepId` / `substepId` disagreed with the snapshot, which was
  // reachable only because the entry was a PARAMETER — any caller could supply
  // one describing a different cursor. It now has a single producer,
  // `deriveExecutionUnitEntry`, which reads the cursor and the snapshot off the
  // same `RunbookState`, so the mismatch is unrepresentable rather than merely
  // untested. `execution-unit-entry.test.ts` pins the derivation that replaced
  // them.

  it('collects command output and failure observations in memory only', () => {
    const collector = createExecutionEffectCollector();
    const output: CommandExecutionOutput = {
      kind: 'completed',
      command: 'npm test',
      displayCommand: 'npm test',
      success: true,
      result: 'pass',
      exitCode: 0,
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

  it('copies network sandbox fields into COMMAND_COMPLETED payload', () => {
    const effect = commandCompletedEffect({
      kind: 'completed',
      command: 'node -e "0"',
      displayCommand: 'node -e "0"',
      success: true,
      result: 'pass',
      exitCode: 0,
      sandboxed: true,
      landlockAbi: 3,
      enforcementDowngraded: false,
      networkPolicy: 'deny',
      networkSandboxed: true,
      channels: [],
      position: { current: '1', total: 1 },
    });

    expect(effect.event.type).toBe('COMMAND_COMPLETED');
    if (effect.event.type === 'COMMAND_COMPLETED') {
      expect(effect.event.payload.networkPolicy).toBe('deny');
      expect(effect.event.payload.networkSandboxed).toBe(true);
    }
  });

  it('copies network sandbox fields into POLICY_DENIED payload', () => {
    const effect = policyDeniedEffect({
      kind: 'policy_denied',
      command: 'node -e "0"',
      displayCommand: 'node -e "0"',
      success: false,
      exitCode: 126,
      policyDenied: true,
      denialReason: 'Sandbox unavailable',
      sandboxed: false,
      networkPolicy: 'deny',
      networkSandboxed: false,
      channels: [],
      position: { current: '1', total: 1 },
    });

    expect(effect.event.type).toBe('POLICY_DENIED');
    if (effect.event.type === 'POLICY_DENIED') {
      expect(effect.event.payload.networkPolicy).toBe('deny');
      expect(effect.event.payload.networkSandboxed).toBe(false);
    }
  });
});
