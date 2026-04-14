import { describe, it, expect } from '@jest/globals';
import {
  parseJsonLines,
  matchStepAssertions,
  formatStepAssertionDescription,
  substituteTokens,
  injectJsonFlag,
  extractRunbookReferences,
} from '../../src/helpers/command-sequence.js';

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
    const assertions = [{ at: '2', action: 'CONTINUE' }, { action: 'COMPLETE' }];
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
    const assertions = [{ action: 'COMPLETE' }];
    const results = matchStepAssertions(assertions, events);
    expect(results[0].matched).toBe(true);
    expect(results[0].matchedEvent?.at).toBe('3');
  });

  it('returns unmatched when no event found', () => {
    const events = [{ action: 'CONTINUE', from: '1', at: '2', result: 'PASS' as const }];
    const assertions = [{ action: 'STOP' }];
    const results = matchStepAssertions(assertions, events);
    expect(results[0].matched).toBe(false);
    expect(results[0].matchedEvent).toBeUndefined();
  });

  it('matches with partial fields (only action)', () => {
    const events = [{ action: 'GOTO', from: '1', at: 'ErrorHandler', result: 'FAIL' as const }];
    const assertions = [{ action: 'GOTO' }];
    const results = matchStepAssertions(assertions, events);
    expect(results[0].matched).toBe(true);
  });

  it('matches with multiple fields on one assertion', () => {
    const events = [{ action: 'GOTO', from: '1', at: 'ErrorHandler', result: 'FAIL' as const }];
    const assertions = [{ action: 'GOTO', at: 'ErrorHandler', result: 'FAIL' }];
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
    const assertions = [
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
    const assertions = [
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

describe('injectJsonFlag', () => {
  it('appends --json when not present', () => {
    expect(injectJsonFlag(['run', 'test.md'])).toEqual(['run', 'test.md', '--json']);
  });

  it('returns original array when --json already present', () => {
    const args = ['run', 'test.md', '--json'];
    expect(injectJsonFlag(args)).toBe(args);
  });

  it('works with various arg combinations', () => {
    expect(injectJsonFlag(['pass'])).toEqual(['pass', '--json']);
    expect(injectJsonFlag(['run', '--var', 'x=1'])).toEqual(['run', '--var', 'x=1', '--json']);
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
