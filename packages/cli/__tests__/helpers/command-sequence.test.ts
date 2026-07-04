import { describe, it, expect } from '@jest/globals';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseJsonLines,
  matchStepAssertions,
  formatStepAssertionDescription,
  substituteTokens,
  parseRdCommandWithEnv,
  extractRunbookReferences,
  extractInputFileReferences,
  substituteClaimIds,
  substituteArtifactUris,
  substituteCapturedArtifacts,
  matchErrorAssertions,
  formatErrorAssertionDescription,
  matchWarningAssertions,
  findUnassertedWarnings,
  matchArtifactAssertions,
  formatArtifactAssertionDescription,
  executeCommandSequence,
  createInProcessCommandExecutor,
  substituteRunIds,
  captureRunIdFromJsonObject,
} from '../../src/helpers/command-sequence.js';
import type { InProcessCliRunner } from '../../src/helpers/command-sequence.js';
import type { ArtifactAssertion, StepAssertion } from '../../src/schemas/scenarios.js';
import { mockFn } from './typed-mocks.js';

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

  it('captures JSON error responses', () => {
    const stdout =
      '{"kind":"error","error":"Claim id rdclm_missing does not exist.","code":"CLAIMED_RUNBOOK_UNAVAILABLE","command":"pass"}\n';
    const result = parseJsonLines(stdout);
    expect(result.errors).toEqual([
      {
        code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
        error: 'Claim id rdclm_missing does not exist.',
        command: 'pass',
      },
    ]);
  });

  it('captures warning responses from single JSON object output', () => {
    const result = parseJsonLines(
      JSON.stringify({
        kind: 'warning',
        command: 'pass',
        code: 'NO_ACTIVE_RUNBOOK',
        message: 'No active runbook',
      }),
    );

    expect(result.warnings).toEqual([
      {
        command: 'pass',
        code: 'NO_ACTIVE_RUNBOOK',
        message: 'No active runbook',
      },
    ]);
  });

  it('captures warning responses from NDJSON output', () => {
    const result = parseJsonLines(
      [
        JSON.stringify({ type: 'step_entered', position: { current: '1' } }),
        JSON.stringify({
          kind: 'warning',
          command: 'pass',
          code: 'NO_ACTIVE_RUNBOOK',
          message: 'No active runbook',
        }),
      ].join('\n'),
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('NO_ACTIVE_RUNBOOK');
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

  it('captures artifacts from step_entered events', () => {
    const stdout = JSON.stringify({
      type: 'step_entered',
      position: { current: '1', total: 1 },
      artifacts: {
        PlanPath: {
          kind: 'artifact-record',
          uri: 'rd://artifacts/ctx1/rd_11111111111111111111111111111111/plan.json',
          path: '/tmp/project/.rundown/work/.rd-ctx1/rd_11111111111111111111111111111111/plan.json',
          runId: 'rd_11111111111111111111111111111111',
          contextId: 'ctx1',
          runbook: { source: 'project', path: '.rundown/runbooks/artifacts.runbook.md' },
          key: 'plan.json',
          timestamp: '2026-05-07T00:00:00.000Z',
        },
      },
      runbook: { source: 'project', path: '.rundown/runbooks/artifacts.runbook.md' },
    });
    const result = parseJsonLines(stdout);
    expect(result.artifactEntries).toEqual([
      {
        at: '1',
        artifacts: {
          PlanPath: expect.objectContaining({ key: 'plan.json' }),
        },
        runbook: { source: 'project', path: '.rundown/runbooks/artifacts.runbook.md' },
      },
    ]);
  });

  it('captures descriptions from step_entered events', () => {
    const stdout = JSON.stringify({
      type: 'step_entered',
      position: { current: '1', total: 1, substep: '1' },
      description: 'Runbook: child.runbook.md',
      runbook: { source: 'project', path: '.rundown/runbooks/parent.runbook.md' },
    });

    const result = parseJsonLines(stdout);

    expect(result.enteredSteps).toEqual([
      {
        at: '1.1',
        description: 'Runbook: child.runbook.md',
        runbook: { source: 'project', path: '.rundown/runbooks/parent.runbook.md' },
      },
    ]);
  });

  it('captures FOR iteration positions from step_entered artifact events', () => {
    const stdout = JSON.stringify({
      type: 'step_entered',
      position: { current: '1', total: 1, substep: '1', for: { index: 3 } },
      artifacts: {
        PlanPath: {
          kind: 'artifact-record',
          uri: 'rd://artifacts/ctx1/rd_11111111111111111111111111111111/plan.json',
          path: '/tmp/project/.rundown/work/.rd-ctx1/rd_11111111111111111111111111111111/plan.json',
          runId: 'rd_11111111111111111111111111111111',
          contextId: 'ctx1',
          runbook: { source: 'project', path: '.rundown/runbooks/artifacts.runbook.md' },
          key: 'plan.json',
          timestamp: '2026-05-07T00:00:00.000Z',
        },
      },
    });

    const result = parseJsonLines(stdout);

    expect(result.artifactEntries[0]?.at).toBe('1.3.1');
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

  it('captures valid runbook envelope field from step_transitioned event', () => {
    const stdout =
      '{"type":"step_transitioned","action":"COMPLETE","from":"1","at":"1","result":"PASS","runbook":{"source":"project","path":"child.runbook.md"}}\n';
    const result = parseJsonLines(stdout);
    expect(result.transitions[0].runbook).toEqual({
      source: 'project',
      path: 'child.runbook.md',
    });
  });

  it('drops malformed runbook envelope fields before assertion matching', () => {
    const stdout =
      '{"type":"step_transitioned","action":"COMPLETE","from":"1","at":"1","result":"PASS","runbook":{"path":"/abs/child.runbook.md","name":"child"}}\n';
    const result = parseJsonLines(stdout);

    expect(result.transitions[0].runbook).toBeUndefined();
    expect(() =>
      matchStepAssertions([{ runbook: 'child.runbook.md' }], result.transitions),
    ).not.toThrow();
    expect(
      matchStepAssertions([{ runbook: 'child.runbook.md' }], result.transitions)[0].matched,
    ).toBe(false);
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

describe('matchErrorAssertions', () => {
  it('matches errors by code, command, and error substring', () => {
    const result = matchErrorAssertions(
      [{ code: 'CLAIMED_RUNBOOK_UNAVAILABLE', command: 'pass', error: 'does not exist' }],
      [
        {
          code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
          command: 'pass',
          error: 'Claim id rdclm_missing does not exist.',
        },
      ],
    );

    expect(result).toEqual([
      {
        assertion: {
          code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
          command: 'pass',
          error: 'does not exist',
        },
        matched: true,
        matchedError: {
          code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
          command: 'pass',
          error: 'Claim id rdclm_missing does not exist.',
        },
      },
    ]);
  });

  it('formats unmatched error assertions for diagnostics', () => {
    const [result] = matchErrorAssertions([{ code: 'TOKEN_NOT_FOUND' }], []);

    expect(formatErrorAssertionDescription(result)).toBe('error code=TOKEN_NOT_FOUND: no match');
  });
});

describe('matchWarningAssertions', () => {
  it('matches warning assertions in order', () => {
    const results = matchWarningAssertions(
      [{ code: 'NO_ACTIVE_RUNBOOK', command: 'pass', message: 'No active' }],
      [{ code: 'NO_ACTIVE_RUNBOOK', command: 'pass', message: 'No active runbook' }],
    );

    expect(results).toHaveLength(1);
    expect(results[0].matched).toBe(true);
  });

  it('reports unasserted warnings after matched warnings are consumed', () => {
    const warnings = [
      { code: 'NO_ACTIVE_RUNBOOK', command: 'pass', message: 'No active runbook' },
      { code: 'OTHER_WARNING', command: 'status', message: 'Something else' },
    ];

    const results = matchWarningAssertions([{ code: 'NO_ACTIVE_RUNBOOK' }], warnings);
    expect(findUnassertedWarnings(warnings, results)).toEqual([warnings[1]]);
  });
});

describe('matchArtifactAssertions', () => {
  const record = {
    kind: 'artifact-record' as const,
    uri: 'rd://artifacts/ctx1/rd_11111111111111111111111111111111/plan.json',
    path: '/tmp/project/.rundown/work/.rd-ctx1/rd_11111111111111111111111111111111/plan.json',
    runId: 'rd_11111111111111111111111111111111',
    contextId: 'ctx1',
    runbook: { source: 'project' as const, path: '.rundown/runbooks/artifacts.runbook.md' },
    key: 'plan.json',
    timestamp: '2026-05-07T00:00:00.000Z',
  };

  it('matches artifact assertions by alias, key, at, and runbook', () => {
    const assertions: ArtifactAssertion[] = [
      {
        at: '1',
        alias: 'PlanPath',
        key: 'plan.json',
        runbook: 'artifacts.runbook.md',
      },
    ];
    const results = matchArtifactAssertions(assertions, [
      {
        at: '1',
        artifacts: { PlanPath: record },
        runbook: { source: 'project', path: '.rundown/runbooks/artifacts.runbook.md' },
      },
    ]);

    expect(results[0]).toEqual({
      assertion: assertions[0],
      matched: true,
      matchedEntry: {
        at: '1',
        artifacts: { PlanPath: record },
        runbook: { source: 'project', path: '.rundown/runbooks/artifacts.runbook.md' },
      },
      matchedRecords: [record],
    });
  });

  it('matches artifact arrays by count and key', () => {
    const assertions: ArtifactAssertion[] = [{ alias: 'Plans', count: 2, key: 'plan-b.json' }];
    const results = matchArtifactAssertions(assertions, [
      {
        artifacts: {
          Plans: [
            record,
            {
              ...record,
              key: 'plan-b.json',
              uri: record.uri.replace('plan.json', 'plan-b.json'),
              path: record.path.replace('plan.json', 'plan-b.json'),
            },
          ],
        },
      },
    ]);

    expect(results[0].matched).toBe(true);
    expect(results[0].matchedRecords?.map((r) => r.key)).toEqual(['plan.json', 'plan-b.json']);
  });

  it('uses file existence callback when exists is specified', () => {
    const assertions: ArtifactAssertion[] = [{ alias: 'PlanPath', exists: true }];
    const results = matchArtifactAssertions(
      assertions,
      [{ artifacts: { PlanPath: record } }],
      (uri) => uri.endsWith('/plan.json'),
    );

    expect(results[0].matched).toBe(true);
  });

  it('returns unmatched when file existence expectation fails', () => {
    const [result] = matchArtifactAssertions(
      [{ alias: 'PlanPath', exists: true }],
      [{ artifacts: { PlanPath: record } }],
      () => false,
    );

    expect(result.matched).toBe(false);
    expect(formatArtifactAssertionDescription(result)).toBe(
      'artifact alias=PlanPath exists=true: no match',
    );
  });

  it('returns unmatched when existence is asserted for an empty artifact array', () => {
    const [result] = matchArtifactAssertions(
      [{ alias: 'Plans', exists: true }],
      [{ artifacts: { Plans: [] } }],
      () => true,
    );

    expect(result.matched).toBe(false);
  });

  it('matches multiple artifact assertions against the same step entry', () => {
    const reviewRecord = {
      ...record,
      uri: record.uri.replace('plan.json', 'review.json'),
      path: record.path.replace('plan.json', 'review.json'),
      key: 'review.json',
    };
    const assertions: ArtifactAssertion[] = [
      { alias: 'PlanPath', key: 'plan.json' },
      { alias: 'ReviewPath', key: 'review.json' },
    ];

    const results = matchArtifactAssertions(assertions, [
      { at: '1', artifacts: { PlanPath: record, ReviewPath: reviewRecord } },
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.matched)).toBe(true);
    expect(results[0].matchedEntry).toBe(results[1].matchedEntry);
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
        runbook: { source: 'project' as const, path: '/abs/child.runbook.md' },
      },
    ];
    const results = matchStepAssertions(
      [{ runbook: 'child.runbook.md', action: 'COMPLETE' }],
      events,
    );
    expect(results[0].matched).toBe(true);
  });

  it('rejects runbook filter when path does not match', () => {
    const events = [
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { source: 'project' as const, path: '/abs/parent.runbook.md' },
      },
    ];
    const results = matchStepAssertions([{ runbook: 'child.runbook.md' }], events);
    expect(results[0].matched).toBe(false);
  });

  it('rejects runbook filter when canonical path does not match', () => {
    const events = [
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { source: 'project' as const, path: '/abs/parent.runbook.md' },
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
        runbook: { source: 'project' as const, path: '/abs/delegation/child.runbook.md' },
      },
    ];
    const results = matchStepAssertions([{ runbook: 'child.runbook.md' }], events);
    expect(results[0].matched).toBe(true);
  });

  it('rejects runbook suffix matches without a path segment boundary', () => {
    const events = [
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { source: 'project' as const, path: '/abs/my-child.runbook.md' },
      },
    ];
    const results = matchStepAssertions([{ runbook: 'child.runbook.md' }], events);
    expect(results[0].matched).toBe(false);
  });

  it('assertion without runbook matches events regardless of their runbook field', () => {
    const events = [
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { source: 'project' as const, path: '/abs/anything.runbook.md' },
      },
    ];
    const results = matchStepAssertions([{ action: 'COMPLETE' }], events);
    expect(results[0].matched).toBe(true);
  });

  it('scopes assertions without runbook to the default runbook when provided', () => {
    const events = [
      {
        action: 'COMPLETE',
        from: '1.1',
        result: 'PASS' as const,
        runbook: { source: 'project' as const, path: '/abs/grandchild.runbook.md' },
      },
      {
        action: 'DEFER',
        from: '1.1',
        result: 'PASS' as const,
        runbook: { source: 'project' as const, path: '/abs/child.runbook.md' },
      },
    ];

    const results = matchStepAssertions(
      [{ from: '1.1', action: 'DEFER', result: 'PASS' }],
      events,
      { defaultRunbook: 'child.runbook.md' },
    );

    expect(results[0].matched).toBe(true);
    expect(results[0].matchedEvent?.runbook?.path).toBe('/abs/child.runbook.md');
  });

  it('does not allow default-scoped assertions to match another runbook', () => {
    const events = [
      {
        action: 'DEFER',
        from: '1.1',
        result: 'PASS' as const,
        runbook: { source: 'project' as const, path: '/abs/grandchild.runbook.md' },
      },
    ];

    const results = matchStepAssertions(
      [{ from: '1.1', action: 'DEFER', result: 'PASS' }],
      events,
      { defaultRunbook: 'child.runbook.md' },
    );

    expect(results[0].matched).toBe(false);
  });

  it('runbook filter distinguishes child from parent when both at same step position', () => {
    const events = [
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { source: 'project' as const, path: '/abs/child.runbook.md' },
      },
      {
        action: 'COMPLETE',
        from: '1',
        result: 'PASS' as const,
        runbook: { source: 'project' as const, path: '/abs/parent.runbook.md' },
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

describe('substituteArtifactUris', () => {
  it('${ARTIFACT:Name} maps to the seeded URI', () => {
    expect(
      substituteArtifactUris('rd run x --artifacts PlanPath=${ARTIFACT:PlanPath}', {
        PlanPath: 'rd://artifacts/c/r/PlanPath',
      }),
    ).toBe('rd run x --artifacts PlanPath=rd://artifacts/c/r/PlanPath');
  });

  it('substitutes multiple distinct artifact placeholders', () => {
    expect(
      substituteArtifactUris('${ARTIFACT:A} ${ARTIFACT:B}', {
        A: 'rd://artifacts/c/r/A',
        B: 'rd://artifacts/c/r/B',
      }),
    ).toBe('rd://artifacts/c/r/A rd://artifacts/c/r/B');
  });

  it('throws for an unseeded artifact reference', () => {
    expect(() => substituteArtifactUris('${ARTIFACT:Missing}', {})).toThrow(
      /references an unseeded artifact/,
    );
  });

  it('returns the original string unchanged when no placeholders', () => {
    expect(substituteArtifactUris('rd pass', {})).toBe('rd pass');
  });
});

describe('substituteCapturedArtifacts', () => {
  it('${CAPTURE_ARTIFACT:key} resolves a scalar URI', async () => {
    const resolve = async (key: string, asArray: boolean) => {
      expect(asArray).toBe(false);
      expect(key).toBe('plan.json');
      return 'rd://artifacts/c/r/plan.json';
    };
    expect(
      await substituteCapturedArtifacts(
        'rd run x --artifacts Plan=${CAPTURE_ARTIFACT:plan.json}',
        resolve,
      ),
    ).toBe('rd run x --artifacts Plan=rd://artifacts/c/r/plan.json');
  });

  it('${CAPTURE_ARTIFACT_ARRAY:key} resolves an array form', async () => {
    const resolve = async (key: string, asArray: boolean) => {
      expect(asArray).toBe(true);
      expect(key).toBe('review.json');
      return '["rd://artifacts/c/r/review.json"]';
    };
    expect(
      await substituteCapturedArtifacts(
        'rd run x --artifacts-json Reviews=${CAPTURE_ARTIFACT_ARRAY:review.json}',
        resolve,
      ),
    ).toBe('rd run x --artifacts-json Reviews=["rd://artifacts/c/r/review.json"]');
  });

  it('resolves multiple placeholders in match order', async () => {
    const resolve = async (key: string) => `rd://artifacts/c/r/${key}`;
    expect(
      await substituteCapturedArtifacts(
        'rd run x --artifacts A=${CAPTURE_ARTIFACT:a.json} --artifacts B=${CAPTURE_ARTIFACT:b.json}',
        resolve,
      ),
    ).toBe(
      'rd run x --artifacts A=rd://artifacts/c/r/a.json --artifacts B=rd://artifacts/c/r/b.json',
    );
  });

  it('resolves a path-shaped key rather than leaking the raw placeholder', async () => {
    // The key class is `[^}]+`, not identifier-only, so a path-shaped artifact
    // token (e.g. a cross-run `*/` prefix or `/` separator) is routed to the
    // resolver instead of leaking a raw `${CAPTURE_ARTIFACT:...}` into the command.
    const resolve = async (key: string, asArray: boolean) => {
      expect(asArray).toBe(false);
      expect(key).toBe('*/plan.json');
      return 'rd://artifacts/c/r/plan.json';
    };
    expect(
      await substituteCapturedArtifacts(
        'rd run x --artifacts Plan=${CAPTURE_ARTIFACT:*/plan.json}',
        resolve,
      ),
    ).toBe('rd run x --artifacts Plan=rd://artifacts/c/r/plan.json');
  });

  it('leaves a command without placeholders unchanged', async () => {
    expect(await substituteCapturedArtifacts('rd pass', async () => 'unused')).toBe('rd pass');
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

describe('substituteRunIds', () => {
  const runA = `rd_${'a'.repeat(32)}`;
  const runB = `rd_${'b'.repeat(32)}`;

  it('${RUN_ID} maps to first captured run id', () => {
    expect(substituteRunIds('rd collect --run ${RUN_ID}', [runA])).toBe(`rd collect --run ${runA}`);
  });

  it('${RUN_ID_2} maps to second captured run id', () => {
    expect(substituteRunIds('rd pass --run ${RUN_ID_2}', [runA, runB])).toBe(
      `rd pass --run ${runB}`,
    );
  });

  it('throws for uncaptured run id references (fail closed)', () => {
    expect(() => substituteRunIds('rd collect --run ${RUN_ID}', [])).toThrow(
      /Missing captured run id/,
    );
    expect(() => substituteRunIds('rd pass --run ${RUN_ID_2}', [runA])).toThrow(
      /Missing captured run id/,
    );
  });

  it('leaves commands without placeholders untouched', () => {
    expect(substituteRunIds('rd pass --claim-id ${CLAIM_ID}', [])).toBe(
      'rd pass --claim-id ${CLAIM_ID}',
    );
  });
});

describe('captureRunIdFromJsonObject', () => {
  it('captures runbookId from runbook_started events in emission order', () => {
    const captured: string[] = [];
    captureRunIdFromJsonObject({ type: 'runbook_started', runbookId: 'rd_1' }, captured);
    captureRunIdFromJsonObject({ type: 'step_entered', runbookId: 'rd_x' }, captured);
    captureRunIdFromJsonObject({ type: 'runbook_started', runbookId: 'rd_2' }, captured);
    captureRunIdFromJsonObject({ type: 'runbook_started' }, captured);
    expect(captured).toEqual(['rd_1', 'rd_2']);
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
    expect(parseRdCommandWithEnv("FOO=agent-a BAR='session a' rd claim rdtk_abc123")).toEqual({
      args: ['claim', 'rdtk_abc123'],
      env: {
        FOO: 'agent-a',
        BAR: 'session a',
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
    expect(() => parseRdCommandWithEnv('FOO=agent-a rd pass && echo done')).toThrow(
      /Unsupported shell operators/,
    );
  });

  it('rejects rd tokens after shell operators', () => {
    expect(() => parseRdCommandWithEnv('echo setup && rd pass')).toThrow(
      /Unsupported shell operators/,
    );
  });

  it('rejects env-prefixed rd commands after shell operators', () => {
    expect(() => parseRdCommandWithEnv('echo setup && FOO=agent-a rd pass')).toThrow(
      /Unsupported shell operators/,
    );
  });
});

describe('executeCommandSequence timings', () => {
  async function writeFakeCli(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'rd-command-sequence-'));
    const cliPath = join(dir, 'fake-cli.js');
    await writeFile(
      cliPath,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        "if (args[0] === 'pass') {",
        '  console.log(JSON.stringify({ type: "runbook_completed" }));',
        '  process.exit(0);',
        '}',
        "if (args[0] === 'fail') {",
        '  console.log(JSON.stringify({ kind: "error", command: "fail", code: "EXPECTED" }));',
        '  process.exit(1);',
        '}',
        'process.exit(2);',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return cliPath;
  }

  it('returns command timings and invokes onCommandComplete for rd and shell commands', async () => {
    const cliPath = await writeFakeCli();
    const observed: unknown[] = [];

    const result = await executeCommandSequence({
      commands: ['rd pass', 'node -e "process.exit(0)"'],
      cwd: process.cwd(),
      cliPath,
      quiet: true,
      onCommandComplete: (timing) => observed.push(timing),
    });

    expect(result.terminalResult).toBe('COMPLETE');
    expect(result.commandTimings).toHaveLength(2);
    expect(observed).toEqual(result.commandTimings);
    expect(result.commandTimings[0]).toEqual(
      expect.objectContaining({
        command: 'rd pass',
        kind: 'rd',
        exitCode: 0,
        expectedFailure: false,
      }),
    );
    expect(result.commandTimings[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.commandTimings[1]).toEqual(
      expect.objectContaining({
        command: 'node -e "process.exit(0)"',
        kind: 'shell',
        exitCode: 0,
        expectedFailure: false,
      }),
    );
  });

  it('marks expected-failure command timings', async () => {
    const cliPath = await writeFakeCli();

    const result = await executeCommandSequence({
      commands: ['! rd fail'],
      cwd: process.cwd(),
      cliPath,
      quiet: true,
    });

    expect(result.commandTimings).toEqual([
      expect.objectContaining({
        command: 'rd fail',
        kind: 'rd',
        exitCode: 1,
        expectedFailure: true,
      }),
    ]);
  });

  it('hard-fails non-expected rd commands after a terminal result', async () => {
    const cliPath = await writeFakeCli();

    await expect(
      executeCommandSequence({
        commands: ['rd pass', 'rd pass'],
        cwd: process.cwd(),
        cliPath,
        quiet: true,
      }),
    ).rejects.toThrow('Scenario command ran after terminal result COMPLETE: rd pass');
  });

  it('hard-fails when a command references ${CAPTURE_ARTIFACT} but no resolver is provided', async () => {
    const calls: string[][] = [];

    await expect(
      executeCommandSequence({
        commands: ['rd run next.runbook.md --artifacts Plan=${CAPTURE_ARTIFACT:Plan}'],
        cwd: process.cwd(),
        cliPath: '/unused/cli.js',
        quiet: true,
        // No resolveCapturedArtifact supplied — the guard must fail fast rather
        // than leak the raw placeholder into the executed command.
        commandExecutor: {
          runRd: async (args) => {
            calls.push(args);
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        },
      }),
    ).rejects.toThrow(/no resolveCapturedArtifact resolver was provided/);
    // The guard fires before dispatch, so the executor is never reached.
    expect(calls).toEqual([]);
  });

  it('allows default-active rd commands after an inline child runbook completion', async () => {
    const calls: string[][] = [];

    const result = await executeCommandSequence({
      commands: ['rd run child.runbook.md --step 1.1', 'rd collect'],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      commandExecutor: {
        runRd: async (args) => {
          calls.push(args);
          if (args[0] === 'run') {
            return {
              stdout: `${JSON.stringify({ type: 'runbook_completed', runbookId: 'rd_child' })}\n`,
              stderr: '',
              exitCode: 0,
            };
          }
          return {
            stdout: `${JSON.stringify({ type: 'runbook_completed', runbookId: 'rd_parent' })}\n`,
            stderr: '',
            exitCode: 0,
          };
        },
      },
    });

    expect(calls).toEqual([['run', 'child.runbook.md', '--step', '1.1'], ['collect']]);
    expect(result.terminalResult).toBe('COMPLETE');
    expect(result.commandTimings).toEqual([
      expect.objectContaining({
        command: 'rd run child.runbook.md --step 1.1',
        kind: 'rd',
        exitCode: 0,
      }),
      expect.objectContaining({ command: 'rd collect', kind: 'rd', exitCode: 0 }),
    ]);
  });

  it('allows intentional expected-failure rd commands after a terminal result', async () => {
    const cliPath = await writeFakeCli();

    const result = await executeCommandSequence({
      commands: ['rd pass', '! rd fail'],
      cwd: process.cwd(),
      cliPath,
      quiet: true,
    });

    expect(result.terminalResult).toBe('COMPLETE');
    expect(result.errors).toEqual([expect.objectContaining({ code: 'EXPECTED', command: 'fail' })]);
    expect(result.commandTimings).toEqual([
      expect.objectContaining({ command: 'rd pass', kind: 'rd', exitCode: 0 }),
      expect.objectContaining({
        command: 'rd fail',
        kind: 'rd',
        exitCode: 1,
        expectedFailure: true,
      }),
    ]);
  });

  it('uses an injected rd executor while shell commands still use shell execution', async () => {
    const calls: string[][] = [];

    const result = await executeCommandSequence({
      commands: [
        'rd pass',
        'node -e "console.log(JSON.stringify({ type: \\"runbook_stopped\\" }))"',
      ],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      commandExecutor: {
        runRd: async (args) => {
          calls.push(args);
          return {
            stdout: `${JSON.stringify({ type: 'runbook_completed' })}\n`,
            stderr: '',
            exitCode: 0,
          };
        },
      },
    });

    expect(calls).toEqual([['pass']]);
    expect(result.terminalResult).toBe('STOP');
    expect(result.commandTimings).toEqual([
      expect.objectContaining({ command: 'rd pass', kind: 'rd', exitCode: 0 }),
      expect.objectContaining({
        command: 'node -e "console.log(JSON.stringify({ type: \\"runbook_stopped\\" }))"',
        kind: 'shell',
        exitCode: 0,
      }),
    ]);
  });
});

describe('createInProcessCommandExecutor', () => {
  it('returns undefined unless in-process scenario execution is enabled', () => {
    const originalValue = process.env.RUNDOWN_SCENARIO_IN_PROCESS;
    try {
      delete process.env.RUNDOWN_SCENARIO_IN_PROCESS;

      const executor = createInProcessCommandExecutor(mockFn<InProcessCliRunner>());

      expect(executor).toBeUndefined();
    } finally {
      if (originalValue === undefined) {
        delete process.env.RUNDOWN_SCENARIO_IN_PROCESS;
      } else {
        process.env.RUNDOWN_SCENARIO_IN_PROCESS = originalValue;
      }
    }
  });

  it('delegates rd commands to the supplied in-process runner', async () => {
    const originalValue = process.env.RUNDOWN_SCENARIO_IN_PROCESS;
    const runCli = mockFn<InProcessCliRunner>().mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    });
    try {
      process.env.RUNDOWN_SCENARIO_IN_PROCESS = '1';

      const executor = createInProcessCommandExecutor(runCli);
      const result = await executor?.runRd?.(['status'], {
        cwd: '/tmp/workspace',
        quiet: true,
        cliPath: '/tmp/cli.js',
        env: { NO_COLOR: '1' },
      });

      expect(result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
      expect(runCli).toHaveBeenCalledWith({
        args: ['status'],
        cwd: '/tmp/workspace',
        env: { NO_COLOR: '1' },
      });
    } finally {
      if (originalValue === undefined) {
        delete process.env.RUNDOWN_SCENARIO_IN_PROCESS;
      } else {
        process.env.RUNDOWN_SCENARIO_IN_PROCESS = originalValue;
      }
    }
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
