import { describe, expect, it } from '@jest/globals';
import { ScenarioRunResponseSchema } from '../../src/output/zod-schemas.js';

describe('ScenarioRunResponseSchema aggregation metadata', () => {
  it('preserves aggregated markers on assertions and matched transition events', () => {
    const response = {
      kind: 'scenario_run',
      result: true,
      scenario: 'delegated-complete',
      expected: 'COMPLETE',
      actual: 'COMPLETE',
      stepAssertions: [
        {
          assertion: {
            action: 'COMPLETE',
            aggregated: true,
          },
          matched: true,
          matchedEvent: {
            action: 'COMPLETE',
            from: '1.2',
            at: '2',
            result: 'PASS',
            aggregated: true,
          },
        },
      ],
    };

    expect(ScenarioRunResponseSchema.parse(response)).toEqual(response);
  });
});
