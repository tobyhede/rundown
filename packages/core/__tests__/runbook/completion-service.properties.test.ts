import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { projectDelegationTerminalOutcome, type RunbookState } from '../../src/runbook/index.js';

const terminalInfrastructureAction = fc.constantFrom(
  {
    type: 'POLICY_DENIED' as const,
    origin: 'direct' as const,
    message: 'blocked by policy',
  },
  {
    type: 'COMMAND_EXECUTION_FAILED' as const,
    origin: 'direct' as const,
    message: 'Timeout of 30000 ms exceeded',
  },
);

function state(overrides: Partial<RunbookState>): RunbookState {
  return {
    id: 'rd_property000000000000000000000000' as RunbookState['id'],
    runbookPath: 'property.runbook.md',
    runbookSrc: '# Property\n\n## 1. Step\n',
    step: '1',
    lifecycle: 'running',
    variables: {} as RunbookState['variables'],
    startedAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  } as RunbookState;
}

describe('projectDelegationTerminalOutcome properties', () => {
  it('never infers delegated fail for command infrastructure stopped states', () => {
    fc.assert(
      fc.property(terminalInfrastructureAction, (lastAction) => {
        expect(
          projectDelegationTerminalOutcome(state({ lifecycle: 'stopped', lastAction })),
        ).toEqual(
          expect.objectContaining({
            kind: 'command_infrastructure',
          }),
        );
      }),
    );
  });

  it('always lets explicit operator results override inferred infrastructure state', () => {
    fc.assert(
      fc.property(
        terminalInfrastructureAction,
        fc.constantFrom<'pass' | 'fail'>('pass', 'fail'),
        (lastAction, explicitResult) => {
          expect(
            projectDelegationTerminalOutcome(
              state({ lifecycle: 'stopped', lastAction }),
              explicitResult,
            ),
          ).toEqual({ kind: 'outcome', result: explicitResult });
        },
      ),
    );
  });
});
