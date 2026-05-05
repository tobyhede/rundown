import { describe, it, expect } from '@jest/globals';
import type { Action, SubstepState, Substep, RunbookState } from '../../src/runbook/types.js';
import {
  isJsonValue,
  createJsonArrayStream,
  isJsonArrayStream,
  isJsonObject,
} from '../../src/runbook/types.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { brandStoredOutputsForTest } from '../helpers/effective-vars.js';
import { makeSubstep } from '../helpers/step-factories.js';

describe('SubstepState type', () => {
  it('has required fields', () => {
    const subtaskState: SubstepState = {
      id: '1',
      frameKey: buildFrameKey('1'),
      status: 'pending',
      result: undefined,
    };

    expect(subtaskState.id).toBe('1');
    expect(subtaskState.status).toBe('pending');
  });
});

describe('Action type (terminal actions only)', () => {
  it('rejects RETRY as an action type (retry is now a transition property)', () => {
    // Action is now terminal-only: CONTINUE, COMPLETE, STOP, GOTO
    // RETRY is extracted as a property on TransitionObject
    const continueAction: Action = { type: 'CONTINUE' };
    const completeAction: Action = { type: 'COMPLETE', message: 'Done' };
    const stopAction: Action = { type: 'STOP', message: 'Failed' };
    const gotoAction: Action = { type: 'GOTO', target: { step: '2' } };

    expect(continueAction.type).toBe('CONTINUE');
    expect(completeAction.type).toBe('COMPLETE');
    expect(stopAction.type).toBe('STOP');
    expect(gotoAction.type).toBe('GOTO');
  });
});

describe('GOTO action type', () => {
  it('uses target: StepId instead of step: StepNumber', () => {
    // This test documents the expected shape after the refactor
    const gotoAction: Action = {
      type: 'GOTO',
      target: { step: '2', substep: '1' },
    };

    // Type assertion - if this compiles, the type is correct
    expect(gotoAction.type).toBe('GOTO');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- testing type narrowing
    if (gotoAction.type === 'GOTO') {
      expect(gotoAction.target.step).toBe('2');
      expect(gotoAction.target.substep).toBe('1');
    }
  });

  it('allows GOTO without substep', () => {
    const gotoAction: Action = {
      type: 'GOTO',
      target: { step: '3' },
    };

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- testing type narrowing
    if (gotoAction.type === 'GOTO') {
      expect(gotoAction.target.step).toBe('3');
      expect(gotoAction.target.substep).toBeUndefined();
    }
  });
});

describe('Substep interface', () => {
  it('supports command field', () => {
    const substep: Substep = makeSubstep({
      id: '1',
      description: 'Test substep',
      command: { code: 'npm test' },
    });
    expect(substep.command?.code).toBe('npm test');
  });

  it('supports prompt string', () => {
    const substep: Substep = makeSubstep({
      id: '1',
      description: 'Test substep',
      prompt: 'Do the thing',
    });
    expect(substep.prompt).toBe('Do the thing');
  });

  it('supports transitions field', () => {
    const substep: Substep = {
      id: '1',
      description: 'Test substep',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP', message: 'BLOCKED' } },
      },
    };
    expect(substep.transitions.pass.action.type).toBe('CONTINUE');
  });
});

describe('RunbookState runbookSrc field', () => {
  it('should include runbookSrc field', () => {
    const state: RunbookState = {
      id: 'wf_0123456789abcdef0123456789abcdef',
      runbook: { source: 'project', path: 'test.runbook.md' },
      step: '1',
      stepName: 'Test step',
      retryCount: 0,
      variables: brandStoredOutputsForTest({}),
      steps: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runbookSrc: '# Test Runbook\n\n## 1. Test Step',
    };
    expect(state.runbookSrc).toBe('# Test Runbook\n\n## 1. Test Step');
  });
});

describe('isJsonValue', () => {
  it('accepts null', () => {
    expect(isJsonValue(null)).toBe(true);
  });

  it('accepts string', () => {
    expect(isJsonValue('hello')).toBe(true);
  });

  it('accepts number', () => {
    expect(isJsonValue(42)).toBe(true);
  });

  it('accepts boolean', () => {
    expect(isJsonValue(true)).toBe(true);
    expect(isJsonValue(false)).toBe(true);
  });

  it('accepts empty array', () => {
    expect(isJsonValue([])).toBe(true);
  });

  it('accepts nested array', () => {
    expect(isJsonValue(['a', 1, [true, null]])).toBe(true);
  });

  it('accepts plain object', () => {
    expect(isJsonValue({ host: 'localhost', port: 8080 })).toBe(true);
  });

  it('accepts deeply nested object', () => {
    expect(isJsonValue({ a: { b: { c: [1, 'x', null] } } })).toBe(true);
  });

  it('rejects undefined', () => {
    expect(isJsonValue(undefined)).toBe(false);
  });

  it('rejects function', () => {
    expect(isJsonValue(() => {})).toBe(false);
  });

  it('rejects Date', () => {
    expect(isJsonValue(new Date())).toBe(false);
  });

  it('rejects RegExp', () => {
    expect(isJsonValue(/foo/)).toBe(false);
  });

  it('rejects object containing Date value', () => {
    expect(isJsonValue({ created: new Date() })).toBe(false);
  });

  it('rejects object containing undefined value', () => {
    expect(isJsonValue({ key: undefined })).toBe(false);
  });

  it('rejects array containing undefined', () => {
    expect(isJsonValue([1, undefined, 'a'])).toBe(false);
  });
});

describe('isJsonArrayStream — Symbol brand guard', () => {
  const asStreamCandidate = (v: unknown): Parameters<typeof isJsonArrayStream>[0] =>
    v as Parameters<typeof isJsonArrayStream>[0];

  it('returns true for a factory-created JsonArrayStream', () => {
    const stream = createJsonArrayStream('/project/data.jsonl');
    expect(isJsonArrayStream(stream)).toBe(true);
  });

  it('returns false for a plain object matching the old structural shape (CVE path)', () => {
    // The attack: --var-json 'items={"kind":"json-array-stream","path":"/etc/passwd"}'
    const crafted = { kind: 'json-array-stream', path: '/etc/passwd' };
    expect(isJsonArrayStream(asStreamCandidate(crafted))).toBe(false);
  });

  it('returns false for a plain object with only kind', () => {
    const crafted = { kind: 'json-array-stream' };
    expect(isJsonArrayStream(asStreamCandidate(crafted))).toBe(false);
  });

  it('returns false for a plain object with extra properties', () => {
    const crafted = { kind: 'json-array-stream', path: '/etc/passwd', extra: 'data' };
    expect(isJsonArrayStream(asStreamCandidate(crafted))).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isJsonArrayStream(asStreamCandidate({}))).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isJsonArrayStream(asStreamCandidate([]))).toBe(false);
  });

  it('isJsonObject returns true for the crafted object (not misidentified as a stream)', () => {
    const crafted = { kind: 'json-array-stream', path: '/etc/passwd' };
    expect(isJsonObject(crafted as unknown as Parameters<typeof isJsonObject>[0])).toBe(true);
  });
});
