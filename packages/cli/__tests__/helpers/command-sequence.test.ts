import { describe, it, expect } from '@jest/globals';
import {
  parseJsonLines,
  matchStepAssertions,
  formatStepAssertionDescription,
  substituteTokens,
  parseRdCommandWithEnv,
  extractRunbookReferences,
  extractInputFileReferences,
  substituteClaimIds,
} from '../../src/helpers/command-sequence.js';
import type { StepAssertion } from '../../src/schemas/scenarios.js';

describe('parseJsonLines', () => {
  it('extracts transition from step_transitioned event', () => {
    const stdout =
      '{"type":"step_transitioned","action":"CONTINUE","from":"1","at":"2","result":"PASS"}\n';
    const result = parseJsonLines(stdout);
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]).toEqual({
      action: 'CONTINUE',
      from: '1',
      at: '2',
      result: 'PASS',
      command: undefined,
      aggregated: undefined,
    });
  });

  it('detects COMPLETE from runbook_completed event', () => {
    const stdout = '{"type":"runbook_completed"}\n';
    const result = parseJsonLines(stdout);
    expect(result.terminal).toBe('COMPLETE');
  });

  it('detects STOP from runbook_stopped event', () => {
    const stdout = '{"type":"runbook_stopped"}\n';
    const result = parseJsonLines(stdout);
    expect(result.terminal).toBe('STOP');
  });

  it('detects COMPLETE from flushed object with complete: true', () => {
    const stdout = '{"complete":true,"action":"COMPLETE","result":true}\n';
    const result = parseJsonLines(stdout);
    expect(result.terminal).toBe('COMPLETE');
    expect(result.transitions).toHaveLength(0); // No transition from flushed object
  });

  it('detects STOP from flushed object with stopped: true', () => {
    const stdout = '{"stopped":true}\n';
    const result = parseJsonLines(stdout);
    expect(result.terminal).toBe('STOP');
    expect(result.transitions).toHaveLength(0);
  });

  it('handles mixed NDJSON events and flushed object without double-counting', () => {
    const stdout = [
      '{"type":"step_transitioned","action":"CONTINUE","from":"1","at":"2","result":"PASS"}',
      '{"type":"runbook_completed"}',
      '{"complete":true,"action":"COMPLETE → 2","result":true,"from":{"step":1}}',
    ].join('\n');
    const result = parseJsonLines(stdout);
    expect(result.transitions).toHaveLength(1); // Only from step_transitioned
    expect(result.terminal).toBe('COMPLETE');
  });

  it('skips non-JSON lines', () => {
    const stdout =
      'some text\n{"type":"step_transitioned","action":"STOP","from":"1","at":"1","result":"FAIL"}\nmore text\n';
    const result = parseJsonLines(stdout);
    expect(result.transitions).toHaveLength(1);
  });

  it('returns empty results for empty output', () => {
    const result = parseJsonLines('');
    expect(result.transitions).toHaveLength(0);
    expect(result.terminal).toBeNull();
  });

  it('captures command field when present', () => {
    const stdout =
      '{"type":"step_transitioned","action":"CONTINUE","from":"1","at":"2","result":"PASS","command":"rd echo --result pass"}\n';
    const result = parseJsonLines(stdout);
    expect(result.transitions[0].command).toBe('rd echo --result pass');
  });

  it('handles pretty-printed JSON (multi-line flushed object)', () => {
    const stdout = JSON.stringify(
      { action: 'complete', stepResult: 'PASS', from: '2', result: true, complete: true },
      null,
      2,
    );
    const result = parseJsonLines(stdout);
    expect(result.terminal).toBe('COMPLETE');
    expect(result.transitions).toHaveLength(0);
  });

  it('handles pretty-printed JSON with stopped: true', () => {
    const stdout = JSON.stringify({ action: 'stop', result: false, stopped: true }, null, 2);
    const result = parseJsonLines(stdout);
    expect(result.terminal).toBe('STOP');
  });

  it('extracts token from delegate response', () => {
    const stdout =
      '{"action":"delegated","step":"1.1","runbook":"child.runbook.md","token":"rdtk_abc123","token_hash":"sha256:xyz","parent_run_id":"run-1"}\n';
    const result = parseJsonLines(stdout);
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0]).toBe('rdtk_abc123');
  });

  it('extracts multiple tokens from NDJSON', () => {
    const stdout = [
      '{"action":"delegated","step":"1.1","runbook":"child-a.runbook.md","token":"rdtk_first","token_hash":"sha256:a","parent_run_id":"run-1"}',
      '{"action":"delegated","step":"1.2","runbook":"child-b.runbook.md","token":"rdtk_second","token_hash":"sha256:b","parent_run_id":"run-1"}',
    ].join('\n');
    const result = parseJsonLines(stdout);
    expect(result.tokens).toHaveLength(2);
    expect(result.tokens[0]).toBe('rdtk_first');
    expect(result.tokens[1]).toBe('rdtk_second');
  });

  it('extracts auto-issued tokens from step_entered delegateFrontier', () => {
    const stdout = JSON.stringify({
      type: 'step_entered',
      position: { current: '1.1', total: 2 },
      stepName: '1.1',
      hasCommand: false,
      isSubstep: true,
      prompted: false,
      delegateFrontier: [
        { id: '1.1', runbook: 'child-a.runbook.md', token: 'rdtk_auto1' },
        { id: '1.2', runbook: 'child-b.runbook.md', token: 'rdtk_auto2' },
      ],
    });
    const result = parseJsonLines(stdout);
    expect(result.tokens).toEqual(['rdtk_auto1', 'rdtk_auto2']);
  });

  it('ignores non-string delegateFrontier tokens', () => {
    const stdout = JSON.stringify({
      type: 'step_entered',
      delegateFrontier: [
        { id: '1.1', runbook: 'child.runbook.md', token: 'rdtk_ok' },
        { id: '1.2', runbook: 'child.runbook.md' }, // token missing
        { id: '1.3', runbook: 'child.runbook.md', token: 42 }, // token not a string
      ],
    });
    const result = parseJsonLines(stdout);
    expect(result.tokens).toEqual(['rdtk_ok']);
  });

  it('safely skips null / primitive entries in delegateFrontier', () => {
    const stdout = JSON.stringify({
      type: 'step_entered',
      delegateFrontier: [null, 'string-entry', 5, { token: 'rdtk_ok' }],
    });
    const result = parseJsonLines(stdout);
    expect(result.tokens).toEqual(['rdtk_ok']);
  });

  it('ignores delegateFrontier on non step_entered events', () => {
    const stdout = JSON.stringify({
      type: 'step_transitioned',
      action: 'CONTINUE',
      from: '1',
      at: '2',
      result: 'PASS',
      delegateFrontier: [{ id: '1.1', runbook: 'x.runbook.md', token: 'rdtk_ignored' }],
    });
    const result = parseJsonLines(stdout);
    expect(result.tokens).toHaveLength(0);
  });

  it('ignores non-array delegateFrontier field', () => {
    const stdout = JSON.stringify({
      type: 'step_entered',
      delegateFrontier: 'not an array',
    });
    const result = parseJsonLines(stdout);
    expect(result.tokens).toHaveLength(0);
  });

  it('extracts auto-issued tokens from NDJSON step_entered line', () => {
    const stdout = [
      JSON.stringify({
        type: 'step_entered',
        stepName: '1.1',
        isSubstep: true,
        hasCommand: false,
        prompted: false,
        delegateFrontier: [
          { id: '1.1', runbook: 'a.runbook.md', token: 'rdtk_first' },
          { id: '1.2', runbook: 'b.runbook.md', token: 'rdtk_second' },
        ],
      }),
      JSON.stringify({ type: 'runbook_completed' }),
    ].join('\n');
    const result = parseJsonLines(stdout);
    expect(result.tokens).toEqual(['rdtk_first', 'rdtk_second']);
    expect(result.terminal).toBe('COMPLETE');
  });

  it('extracts claim ids from claim responses', () => {
    const stdout = [
      '{"action":"claimed","token":"rdtk_first","claim_id":"rdclm_abcdefghijklmnopQRSTUV","run_id":"wf-child-1"}',
      '{"action":"claimed","token":"rdtk_second","claim_id":"rdclm_1234567890abcdefghijkl","run_id":"wf-child-2"}',
    ].join('\n');
    const result = parseJsonLines(stdout);
    expect(result.claimIds).toEqual([
      'rdclm_abcdefghijklmnopQRSTUV',
      'rdclm_1234567890abcdefghijkl',
    ]);
  });

  it('ignores objects without action=delegated', () => {
    const stdout = [
      '{"type":"step_transitioned","action":"CONTINUE","from":"1","at":"2","result":"PASS"}',
      '{"type":"runbook_completed"}',
      '{"complete":true,"action":"COMPLETE","result":true}',
    ].join('\n');
    const result = parseJsonLines(stdout);
    expect(result.tokens).toHaveLength(0);
  });

  it('falls through to line-by-line parsing when input is a JSON array', () => {
    const stdout =
      '[{"type":"step_transitioned","action":"CONTINUE","from":"1","at":"2","result":"PASS"}]\n';
    const result = parseJsonLines(stdout);
    // Array is not a valid single JSON object, so line-by-line parsing runs.
    // The array line parses as JSON but is an array, not an object with type/complete/stopped fields.
    expect(result.transitions).toHaveLength(0);
    expect(result.terminal).toBeNull();
  });

  it('captures runbook envelope field from step_transitioned event', () => {
    const stdout =
      '{"type":"step_transitioned","action":"COMPLETE","from":"1","at":"1","result":"PASS","runbook":{"path":"/abs/child.runbook.md","name":"child"}}\n';
    const result = parseJsonLines(stdout);
    expect(result.transitions[0].runbook).toEqual({ path: '/abs/child.runbook.md', name: 'child' });
  });

  it('captures parentStepId envelope field from step_transitioned event', () => {
    const stdout =
      '{"type":"step_transitioned","action":"COMPLETE","from":"1","at":"1","result":"PASS","parentStepId":"1.1"}\n';
    const result = parseJsonLines(stdout);
    expect(result.transitions[0].parentStepId).toBe('1.1');
  });

  it('leaves runbook and parentStepId undefined when absent', () => {
    const stdout =
      '{"type":"step_transitioned","action":"CONTINUE","from":"1","at":"2","result":"PASS"}\n';
    const result = parseJsonLines(stdout);
    expect(result.transitions[0].runbook).toBeUndefined();
    expect(result.transitions[0].parentStepId).toBeUndefined();
  });
});

describe('matchStepAssertions', () => {
  it('matches all assertions in order', () => {
    const events = [
      { action: 'CONTINUE', from: '1', at: '2', result: 'PASS' as const },
      { action: 'COMPLETE', from: '2', at: '2', result: 'PASS' as const },
    ];
    const assertions: StepAssertion[] = [{ at: '2', action: 'CONTINUE' }, { action: 'COMPLETE' }];
    const results = matchStepAssertions(assertions, events);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.matched)).toBe(true);
  });

  it('skips non-matching events to find match', () => {
    const events = [
      { action: 'CONTINUE', from: '1', at: '2', result: 'PASS' as const },
      { action: 'CONTINUE', from: '2', at: '3', result: 'PASS' as const },
      { action: 'COMPLETE', from: '3', at: '3', result: 'PASS' as const },
    ];
    const assertions: StepAssertion[] = [{ action: 'COMPLETE' }];
    const results = matchStepAssertions(assertions, events);
    expect(results[0].matched).toBe(true);
    expect(results[0].matchedEvent?.at).toBe('3');
  });

  it('returns unmatched when no event found', () => {
    const events = [{ action: 'CONTINUE', from: '1', at: '2', result: 'PASS' as const }];
    const assertions: StepAssertion[] = [{ action: 'STOP' }];
    const results = matchStepAssertions(assertions, events);
    expect(results[0].matched).toBe(false);
    expect(results[0].matchedEvent).toBeUndefined();
  });

  it('matches with partial fields (only action)', () => {
    const events = [{ action: 'GOTO', from: '1', at: 'ErrorHandler', result: 'FAIL' as const }];
    const assertions: StepAssertion[] = [{ action: 'GOTO' }];
    const results = matchStepAssertions(assertions, events);
    expect(results[0].matched).toBe(true);
  });

  it('matches with multiple fields on one assertion', () => {
    const events = [{ action: 'GOTO', from: '1', at: 'ErrorHandler', result: 'FAIL' as const }];
    const assertions: StepAssertion[] = [{ action: 'GOTO', at: 'ErrorHandler', result: 'FAIL' }];
    const results = matchStepAssertions(assertions, events);
    expect(results[0].matched).toBe(true);
  });

  it('returns empty for empty assertions', () => {
    const results = matchStepAssertions([], [{ action: 'CONTINUE' }]);
    expect(results).toHaveLength(0);
  });

  it('returns all unmatched for empty events', () => {
    const results = matchStepAssertions([{ action: 'CONTINUE' }], []);
    expect(results).toHaveLength(1);
    expect(results[0].matched).toBe(false);
  });

  it('preserves assertion order — later assertion cannot match earlier event', () => {
    const events = [
      { action: 'CONTINUE', at: '2' },
      { action: 'GOTO', at: 'ErrorHandler' },
    ];
    // Assertions in reverse order — GOTO first, CONTINUE second
    const assertions: StepAssertion[] = [
      { action: 'GOTO', at: 'ErrorHandler' },
      { action: 'CONTINUE', at: '2' },
    ];
    const results = matchStepAssertions(assertions, events);
    expect(results[0].matched).toBe(true); // GOTO matches second event
    expect(results[1].matched).toBe(false); // CONTINUE at position 2 already consumed
  });

  it('matches runbook filter by path suffix', () => {
    const events = [
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { path: '/abs/child.runbook.md' },
      },
    ];
    const results = matchStepAssertions(
      [{ runbook: 'child.runbook.md', action: 'COMPLETE' }],
      events,
    );
    expect(results[0].matched).toBe(true);
  });

  it('matches runbook filter by name suffix when path absent', () => {
    const events = [
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { name: 'child.runbook.md' },
      },
    ];
    const results = matchStepAssertions([{ runbook: 'child.runbook.md' }], events);
    expect(results[0].matched).toBe(true);
  });

  it('rejects runbook filter when path does not match', () => {
    const events = [
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { path: '/abs/parent.runbook.md' },
      },
    ];
    const results = matchStepAssertions([{ runbook: 'child.runbook.md' }], events);
    expect(results[0].matched).toBe(false);
  });

  it('rejects runbook filter when path does not match even if name matches', () => {
    // path takes precedence when present — name is not a fallback matcher alongside path
    const events = [
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { path: '/abs/parent.runbook.md', name: 'child.runbook.md' },
      },
    ];
    const results = matchStepAssertions([{ runbook: 'child.runbook.md' }], events);
    expect(results[0].matched).toBe(false);
  });

  it('runbook filter is a suffix match — handles subdirectory paths', () => {
    const events = [
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { path: '/abs/delegation/child.runbook.md' },
      },
    ];
    const results = matchStepAssertions([{ runbook: 'child.runbook.md' }], events);
    expect(results[0].matched).toBe(true);
  });

  it('assertion without runbook matches events regardless of their runbook field', () => {
    const events = [
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { path: '/abs/anything.runbook.md' },
      },
    ];
    const results = matchStepAssertions([{ action: 'COMPLETE' }], events);
    expect(results[0].matched).toBe(true);
  });

  it('runbook filter distinguishes child from parent when both at same step position', () => {
    const events = [
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { path: '/abs/child.runbook.md' },
      },
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { path: '/abs/parent.runbook.md' },
      },
    ];
    const assertions: StepAssertion[] = [
      { runbook: 'child.runbook.md', from: '1', action: 'COMPLETE' as const },
      { runbook: 'parent.runbook.md', from: '1', action: 'COMPLETE' as const },
    ];
    const results = matchStepAssertions(assertions, events);
    expect(results[0].matched).toBe(true);
    expect(results[1].matched).toBe(true);
  });
});

describe('formatStepAssertionDescription', () => {
  it('formats matched assertion with at and action', () => {
    const result = formatStepAssertionDescription({
      assertion: { at: '1.3.1', action: 'BREAK' },
      matched: true,
    });
    expect(result).toBe('step at=1.3.1 action=BREAK: matched');
  });

  it('formats unmatched assertion', () => {
    const result = formatStepAssertionDescription({
      assertion: { action: 'STOP' },
      matched: false,
    });
    expect(result).toBe('step action=STOP: no match');
  });

  it('handles empty assertion', () => {
    const result = formatStepAssertionDescription({
      assertion: {},
      matched: true,
    });
    expect(result).toBe('step (empty assertion): matched');
  });

  it('includes runbook first when present', () => {
    const result = formatStepAssertionDescription({
      assertion: { runbook: 'child.runbook.md', from: '1', action: 'COMPLETE' },
      matched: true,
    });
    expect(result).toBe('step runbook=child.runbook.md from=1 action=COMPLETE: matched');
  });
});

describe('substituteTokens', () => {
  it('${TOKEN} maps to first captured token', () => {
    expect(substituteTokens('rd claim ${TOKEN}', ['abc123'])).toBe('rd claim abc123');
  });

  it('${TOKEN_2} maps to second captured token', () => {
    expect(substituteTokens('rd claim ${TOKEN_2}', ['first', 'second'])).toBe('rd claim second');
  });

  it('handles multiple placeholders in one command', () => {
    expect(substituteTokens('${TOKEN} and ${TOKEN_2}', ['a', 'b'])).toBe('a and b');
  });

  it('throws for uncaptured token reference', () => {
    expect(() => substituteTokens('rd claim ${TOKEN_3}', ['only-one'])).toThrow(
      /references uncaptured token/,
    );
  });

  it('${TOKEN_0} throws (token numbering is 1-based)', () => {
    expect(() => substituteTokens('rd claim ${TOKEN_0}', ['abc'])).toThrow(
      /references uncaptured token/,
    );
  });

  it('returns original string unchanged when no placeholders', () => {
    expect(substituteTokens('rd pass', [])).toBe('rd pass');
  });
});

describe('substituteClaimIds', () => {
  it('${CLAIM_ID} maps to first captured claim id', () => {
    expect(substituteClaimIds('rd pass --claim-id ${CLAIM_ID}', ['rdclm_first'])).toBe(
      'rd pass --claim-id rdclm_first',
    );
  });

  it('${CLAIM_ID_2} maps to second captured claim id', () => {
    expect(
      substituteClaimIds('rd fail --claim-id ${CLAIM_ID_2}', ['rdclm_first', 'rdclm_second']),
    ).toBe('rd fail --claim-id rdclm_second');
  });

  it('throws for uncaptured claim id references', () => {
    expect(() => substituteClaimIds('rd pass --claim-id ${CLAIM_ID_2}', ['rdclm_first'])).toThrow(
      /Missing captured claim id/,
    );
  });
});

describe('parseRdCommandWithEnv', () => {
  it('parses plain rd commands', () => {
    expect(parseRdCommandWithEnv('rd pass --text')).toEqual({
      args: ['pass', '--text'],
      env: {},
    });
  });

  it('parses leading environment assignments for rd commands', () => {
    expect(
      parseRdCommandWithEnv("RD_AGENT_ID=agent-a RD_SESSION_ID='session a' rd claim rdtk_abc123"),
    ).toEqual({
      args: ['claim', 'rdtk_abc123'],
      env: {
        RD_AGENT_ID: 'agent-a',
        RD_SESSION_ID: 'session a',
      },
    });
  });

  it('returns null for non-rd shell commands', () => {
    expect(parseRdCommandWithEnv('echo hello')).toBeNull();
  });

  it('returns null for env-prefixed non-rd shell commands with operators', () => {
    expect(parseRdCommandWithEnv('FOO=bar echo ok && echo done')).toBeNull();
  });

  it('returns null when rd is a shell command argument before an operator', () => {
    expect(parseRdCommandWithEnv('echo rd && echo done')).toBeNull();
  });

  it('rejects env-prefixed rd commands with operators', () => {
    expect(() => parseRdCommandWithEnv('RD_AGENT_ID=agent-a rd pass && echo done')).toThrow(
      /Unsupported shell operators/,
    );
  });

  it('rejects rd tokens after shell operators', () => {
    expect(() => parseRdCommandWithEnv('echo setup && rd pass')).toThrow(
      /Unsupported shell operators/,
    );
  });

  it('rejects env-prefixed rd commands after shell operators', () => {
    expect(() => parseRdCommandWithEnv('echo setup && RD_AGENT_ID=agent-a rd pass')).toThrow(
      /Unsupported shell operators/,
    );
  });
});

describe('extractRunbookReferences', () => {
  it('extracts dot-prefixed relative path ./child.runbook.md', () => {
    const refs = extractRunbookReferences(['rd delegate ./child.runbook.md --step 1']);
    expect(refs).toContain('./child.runbook.md');
  });

  it('extracts dot-prefixed nested path ./path/to/child.runbook.md', () => {
    const refs = extractRunbookReferences(['rd run ./path/to/child.runbook.md']);
    expect(refs).toContain('./path/to/child.runbook.md');
  });

  it('still extracts bare filename (regression)', () => {
    const refs = extractRunbookReferences(['rd run child.runbook.md']);
    expect(refs).toContain('child.runbook.md');
  });
});

describe('extractInputFileReferences', () => {
  it('extracts --input-file=<path> (equals form)', () => {
    const commands = ['rd run my.runbook.md --input-file=data/sources.yaml'];
    const result = extractInputFileReferences(commands);
    expect(result).toEqual(['data/sources.yaml']);
  });

  it('extracts --input-file <path> (space form)', () => {
    const commands = ['rd run my.runbook.md --input-file data/sources.yaml'];
    const result = extractInputFileReferences(commands);
    expect(result).toEqual(['data/sources.yaml']);
  });

  it('extracts --input-file from expected-failure rd commands', () => {
    const commands = ['! rd run my.runbook.md --input-file data/sources.yaml'];
    const result = extractInputFileReferences(commands);
    expect(result).toEqual(['data/sources.yaml']);
  });
});
