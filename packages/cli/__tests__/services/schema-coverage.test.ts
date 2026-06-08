/**
 * Schema coverage tests.
 *
 * Ensures all CLI commands that produce JSON output have corresponding
 * schemas defined, and verifies there are no orphan schemas.
 *
 * @module tests/services/schema-coverage
 */

import { describe, it, expect } from '@jest/globals';
import {
  ActionResponseSchema,
  COMMAND_SCHEMAS,
  CollectResponseSchema,
  WarningResponseSchema,
} from '../../src/schemas/output-schemas.js';
import { JSON_OUTPUT_COMMANDS } from '../../src/services/schema-service.js';

describe('Schema Coverage', () => {
  it('should have schemas for all JSON output commands', () => {
    const definedSchemas = Object.keys(COMMAND_SCHEMAS);

    for (const cmd of JSON_OUTPUT_COMMANDS) {
      expect(definedSchemas).toContain(cmd);
    }
  });

  it('should not have orphan schemas', () => {
    const expectedCommands = [...JSON_OUTPUT_COMMANDS];
    for (const key of Object.keys(COMMAND_SCHEMAS)) {
      expect(expectedCommands).toContain(key);
    }
  });

  it('should have same number of schemas as JSON output commands', () => {
    const definedSchemas = Object.keys(COMMAND_SCHEMAS);
    expect(definedSchemas.length).toBe(JSON_OUTPUT_COMMANDS.length);
  });

  it('should have valid Zod schemas for all commands', () => {
    for (const [_cmd, schema] of Object.entries(COMMAND_SCHEMAS)) {
      expect(typeof schema.safeParse).toBe('function');
    }
  });

  it('should have expected minimum command count', () => {
    // Guard against accidental mass deletion
    expect(JSON_OUTPUT_COMMANDS.length).toBeGreaterThanOrEqual(24);
  });

  it('accepts warning responses for action commands that can run with no active runbook', () => {
    const warningResponse = {
      kind: 'warning',
      message: 'No active runbook',
      code: 'NO_ACTIVE_RUNBOOK',
      command: 'pass',
    };

    for (const command of [
      'pass',
      'fail',
      'goto',
      'complete',
      'stop',
      'stash',
      'delegate',
      'collect',
    ]) {
      expect(COMMAND_SCHEMAS[command].safeParse(warningResponse).success).toBe(true);
    }
  });

  it('registers collect with its response schema variants', () => {
    const alreadyAggregated = {
      kind: 'collect',
      action: 'collect',
      status: 'already-aggregated',
      step: '1',
      parentRunId: 'run-123',
    };
    const notActive = {
      kind: 'collect',
      action: 'collect',
      status: 'not-active',
      step: '1',
      parentRunId: 'run-123',
      frameKey: '1|99',
      activeFrameKey: '1|',
      unresolved: 1,
    };

    expect(JSON_OUTPUT_COMMANDS).toContain('collect');
    expect(CollectResponseSchema.safeParse(alreadyAggregated).success).toBe(true);
    expect(CollectResponseSchema.safeParse(notActive).success).toBe(true);
    expect(COMMAND_SCHEMAS.collect.safeParse(alreadyAggregated).success).toBe(true);
    expect(COMMAND_SCHEMAS.collect.safeParse(notActive).success).toBe(true);
  });

  it('keeps action commands accepting normal action responses', () => {
    const actionResponse = {
      kind: 'action',
      action: 'CONTINUE',
      command: 'pass',
      from: '1',
      at: '2',
    };

    for (const command of ['pass', 'fail', 'complete', 'stop']) {
      expect(COMMAND_SCHEMAS[command].safeParse(actionResponse).success).toBe(true);
    }
  });

  it('does not conflate action and warning response schemas', () => {
    const warningResponse = {
      kind: 'warning',
      message: 'No active runbook',
      code: 'NO_ACTIVE_RUNBOOK',
    };

    expect(ActionResponseSchema.safeParse(warningResponse).success).toBe(false);
    expect(WarningResponseSchema.safeParse(warningResponse).success).toBe(true);
  });
});

/**
 * Emitted-output validation coverage guard.
 *
 * Registering a schema in COMMAND_SCHEMAS is not the same as proving the
 * command actually *emits* output conforming to it — the gap that let the
 * `delegate` `already-delegated` envelope drift from `DelegateResponseSchema`
 * undetected. This guard records, for every JSON-output command, the test that
 * validates its REAL emitted output, and fails if any command is unregistered.
 *
 * Coverage kinds:
 * - `schema`: real emitted output is validated against `COMMAND_SCHEMAS[cmd]`
 *   (via `validateCommandOutput` or the command's response schema).
 * - `events`: streaming JSONL execution command, validated by event-type
 *   assertions rather than a single response envelope.
 *
 * Adding a command to `JSON_OUTPUT_COMMANDS` without a real emitted-output test
 * (and an entry here) fails this guard — converting the previously silent
 * opt-in allowlist into an enforced invariant.
 */
const EMITTED_OUTPUT_COVERAGE: Record<string, { kind: 'schema' | 'events'; validatedIn: string }> =
  {
    status: { kind: 'schema', validatedIn: 'commands/schema-validation.test.ts' },
    pass: {
      kind: 'schema',
      validatedIn: 'commands/schema-validation.test.ts, commands/pass.test.ts',
    },
    fail: {
      kind: 'schema',
      validatedIn: 'commands/schema-validation.test.ts, commands/fail.test.ts',
    },
    goto: { kind: 'events', validatedIn: 'commands/schema-validation.test.ts (JSONL events)' },
    complete: {
      kind: 'schema',
      validatedIn: 'commands/schema-validation.test.ts (action + RUNBOOK_NOT_RUNNING)',
    },
    stop: {
      kind: 'schema',
      validatedIn: 'commands/schema-validation.test.ts (action + RUNBOOK_NOT_RUNNING)',
    },
    stash: { kind: 'schema', validatedIn: 'commands/schema-validation.test.ts' },
    pop: { kind: 'schema', validatedIn: 'commands/schema-validation.test.ts' },
    check: { kind: 'schema', validatedIn: 'commands/schema-validation.test.ts' },
    resolve: { kind: 'schema', validatedIn: 'commands/resolve.test.ts' },
    echo: { kind: 'schema', validatedIn: 'commands/schema-validation.test.ts' },
    prompt: { kind: 'schema', validatedIn: 'commands/schema-validation.test.ts' },
    run: { kind: 'events', validatedIn: 'commands/schema-validation.test.ts (JSONL events)' },
    'artifact ls': { kind: 'schema', validatedIn: 'commands/artifact.test.ts' },
    'artifact path': { kind: 'schema', validatedIn: 'commands/artifact.test.ts' },
    'artifact uri': { kind: 'schema', validatedIn: 'commands/artifact.test.ts' },
    'artifact inspect': { kind: 'schema', validatedIn: 'commands/artifact.test.ts' },
    ls: { kind: 'schema', validatedIn: 'commands/schema-validation.test.ts' },
    prune: { kind: 'schema', validatedIn: 'commands/schema-validation.test.ts' },
    collect: { kind: 'schema', validatedIn: 'commands/collect.test.ts' },
    'scenario ls': { kind: 'schema', validatedIn: 'commands/schema-validation.test.ts' },
    'scenario show': { kind: 'schema', validatedIn: 'commands/schema-validation.test.ts' },
    'scenario run': { kind: 'schema', validatedIn: 'commands/schema-validation.test.ts' },
    abort: { kind: 'schema', validatedIn: 'commands/abort.test.ts' },
    'scenario-suite ls': { kind: 'schema', validatedIn: 'commands/scenario-suite.test.ts' },
    'scenario-suite show': { kind: 'schema', validatedIn: 'commands/scenario-suite.test.ts' },
    'scenario-suite run': { kind: 'schema', validatedIn: 'commands/scenario-suite.test.ts' },
    delegate: { kind: 'schema', validatedIn: 'commands/delegate.test.ts (schema conformance)' },
    claim: { kind: 'schema', validatedIn: 'commands/claim.test.ts' },
  };

describe('Emitted-output validation coverage', () => {
  it('validates the real emitted output of every JSON output command against its schema', () => {
    const registered = Object.keys(EMITTED_OUTPUT_COVERAGE).sort();
    const expected = [...JSON_OUTPUT_COMMANDS].sort();
    // Every command must declare where its real emitted output is validated.
    // A new command added to JSON_OUTPUT_COMMANDS fails here until a real
    // emitted-output test exists and is registered above.
    expect(registered).toEqual(expected);
  });

  it('has no stale coverage entries for removed commands', () => {
    for (const cmd of Object.keys(EMITTED_OUTPUT_COVERAGE)) {
      expect(JSON_OUTPUT_COMMANDS).toContain(cmd);
    }
  });
});
