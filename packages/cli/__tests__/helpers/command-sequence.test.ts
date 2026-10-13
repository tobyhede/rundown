import { afterEach, describe, it, expect } from '@jest/globals';
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
  CAPTURE_PLACEHOLDERS,
  createCapturedPlaceholders,
  substitutePlaceholder,
  substitutePlaceholders,
  capturedValues,
  matchCollectedAssertions,
  type CapturedCollectedChild,
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

  // A composing parent's terminal is a run-scoped observation event; the trailing
  // action object is the command's own envelope for the run it targeted (an
  // inline child), per docs/spec/cli-output.md. Deriving the scenario terminal
  // positionally reads the child's `complete` and loses the parent's STOP.
  it('prefers the root run terminal over a trailing child action envelope', () => {
    const stdout = [
      '{"type":"step_transitioned","action":"STOP","from":"1.2","at":"1.2","result":"FAIL","aggregated":true,"runbookId":"rd_root"}',
      '{"type":"runbook_stopped","message":"Child failed","reason":"fail_transition","runbookId":"rd_root"}',
      '{"action":"complete","stepResult":"PASS","from":"1","at":"1","kind":"action","complete":true}',
    ].join('\n');
    const result = parseJsonLines(stdout, 'rd_root');
    expect(result.terminal).toBe('STOP');
  });

  it('prefers a root run completion over a trailing child action envelope', () => {
    const stdout = [
      '{"type":"step_transitioned","action":"CONTINUE","from":"1.2","at":"1.2","result":"PASS","aggregated":true,"runbookId":"rd_root"}',
      '{"type":"runbook_completed","runbookId":"rd_root"}',
      '{"action":"stop","stepResult":"FAIL","from":"1","at":"1","kind":"action","stopped":true}',
    ].join('\n');
    const result = parseJsonLines(stdout, 'rd_root');
    expect(result.terminal).toBe('COMPLETE');
  });

  it('keeps positional terminal detection when no root run event is present', () => {
    const stdout = [
      '{"type":"runbook_stopped","runbookId":"rd_child"}',
      '{"action":"complete","kind":"action","complete":true}',
    ].join('\n');
    expect(parseJsonLines(stdout, 'rd_root').terminal).toBe('COMPLETE');
    expect(parseJsonLines(stdout).terminal).toBe('COMPLETE');
  });

  // The caller has no root run id yet for the command that STARTS the root run,
  // and `rundown run` on an inline-composing runbook reaches both runs' terminals
  // inside that one payload. Root scoping must therefore adopt the payload's own
  // first `runbook_started`, or the very first command of every scenario falls
  // back to the positional rule these tests exist to replace.
  it('adopts the payload first runbook_started as root when the caller has none', () => {
    const stdout = [
      '{"type":"runbook_started","runbookId":"rd_root","owner_token":"rdo_root"}',
      '{"type":"runbook_started","runbookId":"rd_child","owner_token":"rdo_child"}',
      '{"type":"runbook_stopped","message":"Child failed","reason":"fail_transition","runbookId":"rd_root"}',
      '{"action":"complete","stepResult":"PASS","from":"1","at":"1","kind":"action","complete":true}',
    ].join('\n');
    const result = parseJsonLines(stdout);
    expect(result.terminal).toBe('STOP');
    expect(capturedValues(result.captured, 'RUN_ID')[0]).toBe('rd_root');
  });

  it('adopts the payload first runbook_started for a root completion too', () => {
    const stdout = [
      '{"type":"runbook_started","runbookId":"rd_root","owner_token":"rdo_root"}',
      '{"type":"runbook_started","runbookId":"rd_child","owner_token":"rdo_child"}',
      '{"type":"runbook_completed","runbookId":"rd_root"}',
      '{"action":"stop","stepResult":"FAIL","from":"1","at":"1","kind":"action","stopped":true}',
    ].join('\n');
    expect(parseJsonLines(stdout).terminal).toBe('COMPLETE');
  });

  // The adopted root is still a root: a child's own lifecycle terminal must not
  // win just because it arrived later in the same payload.
  it('ignores a child lifecycle terminal under the adopted root', () => {
    const stdout = [
      '{"type":"runbook_started","runbookId":"rd_root","owner_token":"rdo_root"}',
      '{"type":"runbook_started","runbookId":"rd_child","owner_token":"rdo_child"}',
      '{"type":"runbook_completed","runbookId":"rd_root"}',
      '{"type":"runbook_stopped","runbookId":"rd_child"}',
    ].join('\n');
    expect(parseJsonLines(stdout).terminal).toBe('COMPLETE');
  });

  // An explicitly supplied root always wins over the payload's own first start —
  // a later command in the sequence can start a fresh child run of its own.
  it('prefers the caller root id over the payload first runbook_started', () => {
    const stdout = [
      '{"type":"runbook_started","runbookId":"rd_child","owner_token":"rdo_child"}',
      '{"type":"runbook_stopped","runbookId":"rd_child"}',
      '{"action":"complete","kind":"action","complete":true}',
    ].join('\n');
    expect(parseJsonLines(stdout, 'rd_root').terminal).toBe('COMPLETE');
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

  it('extracts the owner token from runbook_started', () => {
    const stdout =
      '{"type":"runbook_started","prompted":false,"owner_token":"rdo_abc123","runbookId":"rd_1"}\n';
    const result = parseJsonLines(stdout);
    expect(capturedValues(result.captured, 'TOKEN')).toEqual(['rdo_abc123']);
    expect(capturedValues(result.captured, 'RUN_ID')).toEqual(['rd_1']);
  });

  it('captures JSON error responses', () => {
    const stdout =
      '{"kind":"error","error":"Run rd_missing has finished (completed); rundown pass cannot be applied.","code":"RD-303","command":"pass"}\n';
    const result = parseJsonLines(stdout);
    expect(result.errors).toEqual([
      {
        code: 'RD-303',
        error: 'Run rd_missing has finished (completed); rundown pass cannot be applied.',
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

  it('extracts multiple owner tokens from NDJSON in emission order', () => {
    const stdout = [
      '{"type":"runbook_started","owner_token":"rdo_first","runbookId":"rd_a"}',
      '{"type":"step_entered","position":{"current":"1","total":1}}',
      '{"type":"runbook_started","owner_token":"rdo_second","runbookId":"rd_b"}',
    ].join('\n');
    const result = parseJsonLines(stdout);
    expect(capturedValues(result.captured, 'TOKEN')).toEqual(['rdo_first', 'rdo_second']);
    expect(capturedValues(result.captured, 'RUN_ID')).toEqual(['rd_a', 'rd_b']);
  });

  it('ignores a non-string owner_token and owner_token on other events', () => {
    const stdout = [
      JSON.stringify({ type: 'runbook_started', owner_token: 42, runbookId: 'rd_a' }),
      JSON.stringify({ type: 'step_entered', owner_token: 'rdo_ignored' }),
      JSON.stringify({ type: 'runbook_started', runbookId: 'rd_b' }),
    ].join('\n');
    const result = parseJsonLines(stdout);
    expect(capturedValues(result.captured, 'TOKEN')).toHaveLength(0);
    expect(capturedValues(result.captured, 'RUN_ID')).toEqual(['rd_a', 'rd_b']);
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

  it('captures no token from objects that are not runbook_started', () => {
    const stdout = [
      '{"type":"step_transitioned","action":"CONTINUE","from":"1","at":"2","result":"PASS"}',
      '{"type":"runbook_completed"}',
      '{"complete":true,"action":"COMPLETE","result":true}',
    ].join('\n');
    const result = parseJsonLines(stdout);
    expect(capturedValues(result.captured, 'TOKEN')).toHaveLength(0);
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
      [{ code: 'RD-303', command: 'pass', error: 'has finished' }],
      [
        {
          code: 'RD-303',
          command: 'pass',
          error: 'Run rd_missing has finished (completed); rundown pass cannot be applied.',
        },
      ],
    );

    expect(result).toEqual([
      {
        assertion: {
          code: 'RD-303',
          command: 'pass',
          error: 'has finished',
        },
        matched: true,
        matchedError: {
          code: 'RD-303',
          command: 'pass',
          error: 'Run rd_missing has finished (completed); rundown pass cannot be applied.',
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
    expect(substituteTokens('rd pass --token ${TOKEN}', ['rdo_a'])).toBe('rd pass --token rdo_a');
  });

  it('${TOKEN_2} maps to second captured token', () => {
    expect(substituteTokens('rd stop --token ${TOKEN_2}', ['first', 'second'])).toBe(
      'rd stop --token second',
    );
  });

  it('handles multiple placeholders in one command', () => {
    expect(substituteTokens('${TOKEN} and ${TOKEN_2}', ['a', 'b'])).toBe('a and b');
  });

  it('throws for uncaptured token reference', () => {
    expect(() => substituteTokens('rd pass --token ${TOKEN_3}', ['only-one'])).toThrow(
      /\$\{TOKEN_3\} references an uncaptured owner token/,
    );
  });

  it('${TOKEN_0} throws (token numbering is 1-based)', () => {
    expect(() => substituteTokens('rd pass --token ${TOKEN_0}', ['abc'])).toThrow(
      /references an uncaptured owner token/,
    );
  });

  it('returns original string unchanged when no placeholders', () => {
    expect(substituteTokens('rd pass', [])).toBe('rd pass');
  });
});

describe('retired ${ARTIFACT:} grammar (#498)', () => {
  it('throws naming the retirement rather than passing the placeholder through', async () => {
    const calls: string[][] = [];

    await expect(
      executeCommandSequence({
        commands: ['rd run x.runbook.md --artifacts PlanPath=${ARTIFACT:PlanPath}'],
        cwd: process.cwd(),
        cliPath: '/unused/cli.js',
        quiet: true,
        commandExecutor: {
          runRd: async (args) => {
            calls.push(args);
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        },
      }),
    ).rejects.toThrow(/retired.*\$\{ARTIFACT:\}.*#498/s);
    // The tombstone fires before dispatch, so the executor is never reached.
    expect(calls).toEqual([]);
  });

  it('detects the retired grammar with an empty body, as the error message spells it', async () => {
    // Regression: the detector required a non-empty body, so the exact spelling
    // named in its own error message — ${ARTIFACT:} — passed through unnoticed.
    const calls: string[][] = [];

    await expect(
      executeCommandSequence({
        commands: ['rd run x.runbook.md --artifacts PlanPath=${ARTIFACT:}'],
        cwd: process.cwd(),
        cliPath: '/unused/cli.js',
        quiet: true,
        commandExecutor: {
          runRd: async (args) => {
            calls.push(args);
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        },
      }),
    ).rejects.toThrow(/retired.*\$\{ARTIFACT:\}.*#498/s);
    expect(calls).toEqual([]);
  });

  it('does not mistake the surviving ${CAPTURE_ARTIFACT:} grammar for the retired one', async () => {
    const resolved = await substituteCapturedArtifacts(
      'rd run x --artifacts Plan=${CAPTURE_ARTIFACT:plan.json}',
      async () => 'rd://artifacts/c/rd_1/plan.json',
    );
    expect(resolved).toBe('rd run x --artifacts Plan=rd://artifacts/c/rd_1/plan.json');
  });
});

describe('${CAPTURE_ARTIFACT_ARRAY:} shell-quoting guard (#498)', () => {
  it('rejects an unquoted array capture, naming the key and the fix', async () => {
    const calls: string[][] = [];

    await expect(
      executeCommandSequence({
        commands: ['rd run x.runbook.md --artifacts-json R=${CAPTURE_ARTIFACT_ARRAY:review.json}'],
        cwd: process.cwd(),
        cliPath: '/unused/cli.js',
        quiet: true,
        resolveCapturedArtifact: async () => '["rd://artifacts/c/rd_1/review.json"]',
        commandExecutor: {
          runRd: async (args) => {
            calls.push(args);
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        },
      }),
    ).rejects.toThrow(/review\.json.*single-quote/is);
    // The guard fires before dispatch, so the executor is never reached.
    expect(calls).toEqual([]);
  });

  it('accepts the real quoted call-site spelling, where the whole assignment is quoted', async () => {
    const calls: string[][] = [];

    await executeCommandSequence({
      commands: [
        "rd run x.runbook.md --artifacts-json 'Reviews=${CAPTURE_ARTIFACT_ARRAY:review.json}' --allow-all",
      ],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      resolveCapturedArtifact: async () => '["rd://artifacts/c/rd_1/review.json"]',
      commandExecutor: {
        runRd: async (args) => {
          calls.push(args);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
    });

    // The resolved JSON reaches argv intact, as a single byte-identical entry.
    expect(calls[0]).toContain('Reviews=["rd://artifacts/c/rd_1/review.json"]');
  });

  it('accepts a correctly quoted array capture even when the command already contains the probe text', async () => {
    // Regression: the guard substituted a fixed probe value and counted its
    // occurrences, so a command that already contained that literal text was
    // rejected for a collision with the guard's own instrument rather than for
    // anything the author did wrong.
    const calls: string[][] = [];

    await executeCommandSequence({
      commands: [
        "rd run x.runbook.md --artifacts-json 'R=${CAPTURE_ARTIFACT_ARRAY:review.json}' --input note='[\"rd://s\"]'",
      ],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      resolveCapturedArtifact: async () => '["rd://artifacts/c/rd_1/review.json"]',
      commandExecutor: {
        runRd: async (args) => {
          calls.push(args);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
    });

    expect(calls[0]).toContain('R=["rd://artifacts/c/rd_1/review.json"]');
  });

  it('does not fire on the scalar form, which needs no quoting', async () => {
    const calls: string[][] = [];

    await executeCommandSequence({
      commands: ['rd run x.runbook.md --artifacts P=${CAPTURE_ARTIFACT:plan.json}'],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      resolveCapturedArtifact: async () => 'rd://artifacts/c/rd_1/plan.json',
      commandExecutor: {
        runRd: async (args) => {
          calls.push(args);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
    });

    expect(calls[0]).toContain('P=rd://artifacts/c/rd_1/plan.json');
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

describe('substituteRunIds', () => {
  const runA = `rd_${'a'.repeat(32)}`;
  const runB = `rd_${'b'.repeat(32)}`;

  it('${RUN_ID} maps to first captured run id', () => {
    expect(substituteRunIds('rd status --run ${RUN_ID}', [runA])).toBe(`rd status --run ${runA}`);
  });

  it('${RUN_ID_2} maps to second captured run id', () => {
    expect(substituteRunIds('rd status --run ${RUN_ID_2}', [runA, runB])).toBe(
      `rd status --run ${runB}`,
    );
  });

  it('throws for uncaptured run id references (fail closed)', () => {
    expect(() => substituteRunIds('rd status --run ${RUN_ID}', [])).toThrow(
      /references an uncaptured run id/,
    );
    expect(() => substituteRunIds('rd status --run ${RUN_ID_2}', [runA])).toThrow(
      /references an uncaptured run id/,
    );
  });

  it('leaves commands without placeholders untouched', () => {
    expect(substituteRunIds('rd pass --token ${TOKEN}', [])).toBe('rd pass --token ${TOKEN}');
  });
});

describe('CAPTURE_PLACEHOLDERS', () => {
  it('names TOKEN and RUN_ID from a root run start, and the #904 delegation rows', () => {
    expect(CAPTURE_PLACEHOLDERS.map((row) => row.name)).toEqual([
      'TOKEN',
      'RUN_ID',
      'TICKET',
      'CHILD_TOKEN',
      'CHILD_RUN',
    ]);
    const started = { type: 'runbook_started', owner_token: 'rdo_x', runbookId: 'rd_x' };
    expect(CAPTURE_PLACEHOLDERS.map((row) => row.capture(started))).toEqual([
      ['rdo_x'],
      ['rd_x'],
      [],
      [],
      [],
    ]);
    expect(
      CAPTURE_PLACEHOLDERS.map((row) =>
        row.capture({ type: 'step_entered', owner_token: 'rdo_x' }),
      ),
    ).toEqual([[], [], [], [], []]);
  });

  it('captures a claimed child start as CHILD_TOKEN / CHILD_RUN, never TOKEN / RUN_ID', () => {
    const claimed = {
      type: 'runbook_started',
      owner_token: 'rdo_c',
      runbookId: 'rd_c',
      parent: { runId: 'rd_p', step: '1.1' },
    };
    expect(CAPTURE_PLACEHOLDERS.map((row) => row.capture(claimed))).toEqual([
      [],
      [],
      [],
      ['rdo_c'],
      ['rd_c'],
    ]);
  });

  it('captures every ticket a step entry lists, in order', () => {
    const entered = {
      type: 'step_entered',
      children: [{ ticket: 'rdt_1' }, { runId: 'rd_x' }, { ticket: 'rdt_2' }],
    };
    expect(CAPTURE_PLACEHOLDERS.find((row) => row.name === 'TICKET')?.capture(entered)).toEqual([
      'rdt_1',
      'rdt_2',
    ]);
  });

  it('createCapturedPlaceholders has one empty entry per row', () => {
    const captured = createCapturedPlaceholders();
    expect([...captured.keys()]).toEqual(['TOKEN', 'RUN_ID', 'TICKET', 'CHILD_TOKEN', 'CHILD_RUN']);
    expect([...captured.values()]).toEqual([[], [], [], [], []]);
  });

  it('substitutePlaceholders substitutes every row from the accumulator', () => {
    const captured = createCapturedPlaceholders();
    captured.get('TOKEN')?.push('rdo_a');
    captured.get('RUN_ID')?.push('rd_a', 'rd_b');
    expect(
      substitutePlaceholders('rd pass --token ${TOKEN} && rd status --run ${RUN_ID_2}', captured),
    ).toBe('rd pass --token rdo_a && rd status --run rd_b');
  });

  it('substitutePlaceholder names the placeholder and its meaning when uncaptured', () => {
    expect(() => substitutePlaceholder('${TOKEN_2}', CAPTURE_PLACEHOLDERS[0], ['one'])).toThrow(
      /\$\{TOKEN_2\} references an uncaptured owner token from runbook_started\.owner_token \(have 1\)/,
    );
  });
});

describe('parseJsonLines — TOKEN and RUN_ID capture', () => {
  it('captures owner_token and runbookId from runbook_started events only, in emission order', () => {
    const result = parseJsonLines(
      [
        { type: 'runbook_started', owner_token: 'rdo_1', runbookId: 'rd_1' },
        { type: 'step_entered', owner_token: 'rdo_x', runbookId: 'rd_x' },
        { type: 'runbook_started', owner_token: 'rdo_2', runbookId: 'rd_2' },
        { type: 'runbook_started' },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n'),
    );
    expect(capturedValues(result.captured, 'TOKEN')).toEqual(['rdo_1', 'rdo_2']);
    expect(capturedValues(result.captured, 'RUN_ID')).toEqual(['rd_1', 'rd_2']);
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

  it("fails a stale command on a finished run through the CLI's own refusal", async () => {
    const token = `rdo_${'A'.repeat(43)}`;
    const commandExecutor = {
      runRd: async (args: string[]) => {
        if (args[0] === 'run') {
          return {
            stdout: `${JSON.stringify({ type: 'runbook_started', runbookId: 'rd_a', owner_token: token })}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (args[0] === 'complete') {
          return {
            stdout: `${JSON.stringify({ type: 'runbook_completed', runbookId: 'rd_a' })}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        // The CLI refuses a token whose run already finished: RD-303, exit 1.
        return {
          stdout: `${JSON.stringify({ kind: 'error', code: 'RD-303', error: 'run finished', command: args[0] })}\n`,
          stderr: '',
          exitCode: 1,
        };
      },
    };
    const base = ['rundown run a.md', 'rundown complete --token ${TOKEN}'];

    await expect(
      executeCommandSequence({
        commands: [...base, 'rundown pass --token ${TOKEN}'],
        cwd: process.cwd(),
        cliPath: '/unused/cli.js',
        quiet: true,
        commandExecutor,
      }),
    ).rejects.toThrow('Command failed with exit code 1: rundown pass --token rdo_[redacted]');

    const negative = await executeCommandSequence({
      commands: [...base, '! rundown pass --token ${TOKEN}'],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      commandExecutor,
    });
    expect(negative.terminalResult).toBe('COMPLETE');
    expect(negative.errors).toEqual([expect.objectContaining({ code: 'RD-303', command: 'pass' })]);
  });

  it('drives a second run by its own token after the first run completes', async () => {
    const tokenA = `rdo_${'A'.repeat(43)}`;
    const tokenB = `rdo_${'B'.repeat(43)}`;
    const calls: string[][] = [];

    const result = await executeCommandSequence({
      commands: [
        'rundown run a.md',
        'rundown run b.md',
        'rundown complete --token ${TOKEN}',
        'rundown pass --token ${TOKEN_2} --step 1',
      ],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      commandExecutor: {
        runRd: async (args) => {
          calls.push(args);
          const started = (runbookId: string, ownerToken: string): string =>
            `${JSON.stringify({ type: 'runbook_started', runbookId, owner_token: ownerToken })}\n`;
          const stdoutFor: Record<string, string> = {
            'a.md': started('rd_a', tokenA),
            'b.md': started('rd_b', tokenB),
            complete: `${JSON.stringify({ type: 'runbook_completed', runbookId: 'rd_a' })}\n`,
            pass: `${JSON.stringify({ type: 'step_entered', runbookId: 'rd_b', position: { current: '2' } })}\n`,
          };
          const key = args[0] === 'run' ? args[1] : args[0];
          return { stdout: stdoutFor[key] ?? '', stderr: '', exitCode: 0 };
        },
      },
    });

    // The mutation against run B reached the CLI: run A finishing says
    // nothing about run B under one writer per run.
    expect(calls.at(-1)).toEqual(['pass', '--token', tokenB, '--step', '1']);
    expect(result.capturedRunIds).toEqual(['rd_a', 'rd_b']);
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

describe('executeCommandSequence — Owner Token redaction in observations', () => {
  const OWNER_TOKEN = `rdo_${'A'.repeat(43)}`;

  it('passes the real token to the command but never to an echo, timing or error', async () => {
    const executed: string[][] = [];
    const started: string[] = [];
    const timed: string[] = [];

    const run = executeCommandSequence({
      commands: ['rd run x.runbook.md --prompted', 'rd pass --token ${TOKEN} --step 1'],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      onCommandStart: (command) => started.push(command),
      onCommandComplete: (timing) => timed.push(timing.command),
      commandExecutor: {
        runRd: async (args) => {
          executed.push(args);
          return args[0] === 'run'
            ? {
                stdout: `${JSON.stringify({ type: 'runbook_started', runbookId: `rd_${'0'.repeat(32)}`, owner_token: OWNER_TOKEN })}\n`,
                stderr: '',
                exitCode: 0,
              }
            : { stdout: '', stderr: '', exitCode: 1 };
        },
      },
    });

    // The refused pass has no terminal result, so the sequence throws naming it.
    const error = await run.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String(error)).toContain('rd pass --token');
    expect(String(error)).not.toContain(OWNER_TOKEN);

    // The command itself must still receive the secret it authenticates with.
    expect(executed[1]).toContain(OWNER_TOKEN);
    expect(started).toHaveLength(2);
    expect(timed).toHaveLength(2);
    for (const observed of [...started, ...timed]) {
      expect(observed).not.toContain(OWNER_TOKEN);
    }
    expect(started[1]).toContain('rd pass --token rdo_');
  });
});

describe('collected children (#904)', () => {
  it('captures every child a children_collected event reports, and placeholders alongside', () => {
    const result = parseJsonLines(
      [
        JSON.stringify({
          type: 'step_entered',
          children: [{ step: '1.1', runId: 'rd_a', runbook: 'c.md', ticket: 'rdt_a' }],
        }),
        'not json',
        JSON.stringify({
          type: 'children_collected',
          children: [
            { step: '1.1', runId: 'rd_a', status: 'pending' },
            { step: '1.2', index: 2, runId: 'rd_b', status: 'collected', result: 'fail' },
          ],
        }),
      ].join('\n'),
    );
    expect(capturedValues(result.captured, 'TICKET')).toEqual(['rdt_a']);
    expect(result.collectedChildren).toEqual([
      { step: '1.1', runId: 'rd_a', status: 'pending' },
      { step: '1.2', index: 2, runId: 'rd_b', status: 'collected', result: 'fail' },
    ]);
  });

  it('matches assertions in order, skipping children between them', () => {
    const children: CapturedCollectedChild[] = [
      { step: '1.1', runId: 'rd_a', status: 'pending' },
      { step: '1.2', runId: 'rd_b', status: 'collected', result: 'pass' },
      { step: '1.1', runId: 'rd_a', status: 'collected', result: 'pass' },
    ];
    expect(
      matchCollectedAssertions(
        [
          { step: '1.1', status: 'pending' },
          { step: '1.1', status: 'collected', result: 'pass' },
          { step: '1.2', status: 'collected' },
        ],
        children,
      ).map((result) => result.matched),
    ).toEqual([true, true, false]);
  });
});

describe('executeCommandSequence — placeholder capture model (#904)', () => {
  const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;
  const claimedStart = line({
    type: 'runbook_started',
    runbookId: 'rd_child',
    owner_token: 'rdo_child',
    parent: { runId: 'rd_root', step: '1.1' },
  });
  const rootStart = line({
    type: 'runbook_started',
    runbookId: 'rd_root',
    owner_token: 'rdo_root',
  });

  it('never adopts a claimed child start as the root run, across commands', async () => {
    const calls: string[][] = [];
    const result = await executeCommandSequence({
      // The claim's output precedes the root's start, so a capture model that
      // counted the claimed start as a RUN_ID would scope the root to the child.
      commands: [
        'rundown claim rdt_x',
        'rundown run p.md',
        'rundown pass --token ${CHILD_TOKEN} --step 1',
        'rundown status --run ${RUN_ID} --child ${CHILD_RUN} --token ${TOKEN}',
      ],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      commandExecutor: {
        runRd: async (args) => {
          calls.push(args);
          const stdoutFor: Record<string, string> = {
            claim: claimedStart,
            run: rootStart,
            // NDJSON, so the payload reaches root scoping (a lone object does not).
            pass:
              line({ type: 'step_entered', runbookId: 'rd_child', position: { current: '2' } }) +
              line({ type: 'runbook_completed', runbookId: 'rd_child' }),
            status: '',
          };
          return { stdout: stdoutFor[args[0]] ?? '', stderr: '', exitCode: 0 };
        },
      },
    });

    expect(calls[2]).toEqual(['pass', '--token', 'rdo_child', '--step', '1']);
    expect(calls[3]).toEqual([
      'status',
      '--run',
      'rd_root',
      '--child',
      'rd_child',
      '--token',
      'rdo_root',
    ]);
    // The child completing is another run's terminal, not the scenario's.
    expect(result.terminalResult).toBe('UNKNOWN');
    expect(result.capturedTokens).toEqual(['rdo_root']);
    expect(result.capturedRunIds).toEqual(['rd_root']);
  });

  it('never adopts a claimed child start as the root run within one payload', async () => {
    const result = await executeCommandSequence({
      commands: ['rundown run p.md'],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      commandExecutor: {
        runRd: async () => ({
          stdout: [
            claimedStart,
            rootStart,
            line({ type: 'runbook_completed', runbookId: 'rd_child' }),
            line({ type: 'runbook_stopped', runbookId: 'rd_root' }),
          ].join(''),
          stderr: '',
          exitCode: 0,
        }),
      },
    });

    expect(result.terminalResult).toBe('STOP');
    expect(result.capturedRunIds).toEqual(['rd_root']);
  });

  it("never takes a child's lone lifecycle terminal as the scenario's terminal", async () => {
    const calls: string[][] = [];
    const result = await executeCommandSequence({
      commands: ['rundown run p.md', 'rundown claim rdt_x', 'rundown pass --token ${CHILD_TOKEN}'],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      commandExecutor: {
        runRd: async (args) => {
          calls.push(args);
          const stdoutFor: Record<string, string> = {
            run: rootStart,
            claim: claimedStart,
            // A lone object, not NDJSON: the child's run completing.
            pass: line({ type: 'runbook_completed', runbookId: 'rd_child' }),
          };
          return { stdout: stdoutFor[args[0]] ?? '', stderr: '', exitCode: 0 };
        },
      },
    });

    expect(calls[2]).toEqual(['pass', '--token', 'rdo_child']);
    expect(result.terminalResult).toBe('UNKNOWN');
  });

  it("takes the root's own lone lifecycle terminal as the scenario's terminal", async () => {
    const result = await executeCommandSequence({
      commands: ['rundown run p.md', 'rundown stop --token ${TOKEN}'],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      commandExecutor: {
        runRd: async (args) => ({
          stdout:
            args[0] === 'run' ? rootStart : line({ type: 'runbook_stopped', runbookId: 'rd_root' }),
          stderr: '',
          exitCode: 0,
        }),
      },
    });

    expect(result.terminalResult).toBe('STOP');
  });

  it('captures tickets, collected children and tokens from shell and rd output alike', async () => {
    const calls: string[][] = [];
    const entered = {
      type: 'step_entered',
      children: [{ step: '1.1', runId: 'rd_a', ticket: 'rdt_a' }],
    };
    const result = await executeCommandSequence({
      commands: [
        // A pretty-printed single object, as a flushed command envelope prints.
        `node -e "console.log(JSON.stringify(${JSON.stringify(entered).replaceAll('"', '\\"')}, null, 2))"`,
        'rundown claim ${TICKET}',
        'rundown collect --token ${CHILD_TOKEN}',
      ],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      commandExecutor: {
        runRd: async (args) => {
          calls.push(args);
          const stdoutFor: Record<string, string> = {
            claim: claimedStart,
            collect: line({
              type: 'children_collected',
              children: [
                { step: '1.1', runId: 'rd_a', status: 'collected', result: 'pass' },
                { step: '1.2', runId: 7, status: 'pending' },
              ],
            }),
          };
          return { stdout: stdoutFor[args[0]] ?? '', stderr: '', exitCode: 0 };
        },
      },
    });

    expect(calls).toEqual([
      ['claim', 'rdt_a'],
      ['collect', '--token', 'rdo_child'],
    ]);
    expect(result.collectedChildren).toEqual([
      { step: '1.1', runId: 'rd_a', status: 'collected', result: 'pass' },
    ]);
    expect(result.capturedTokens).toEqual([]);
    expect(result.enteredSteps).toHaveLength(1);
  });
});

describe('Claude Code markers (#907)', () => {
  const saved = { CLAUDECODE: process.env.CLAUDECODE, ENTRY: process.env.CLAUDE_CODE_ENTRYPOINT };
  afterEach(() => {
    if (saved.CLAUDECODE === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = saved.CLAUDECODE;
    if (saved.ENTRY === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = saved.ENTRY;
  });

  it('runs scenario commands as from a plain shell, never inheriting a Claude Code session', async () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const seen: (Record<string, string | undefined> | undefined)[] = [];

    await executeCommandSequence({
      commands: ['rd claim rdt_x', 'CLAUDECODE=1 rd claim rdt_y'],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
      commandExecutor: {
        runRd: async (_args, options) => {
          seen.push(options.env);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
    });

    expect(seen[0]).toMatchObject({ CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined });
    expect(seen[0]).toHaveProperty('CLAUDECODE');
    expect(seen[1]?.CLAUDECODE).toBe('1');
  });
});
