// packages/claude-code-plugin/__tests__/schemas.properties.test.ts
import fc from 'fast-check';
import { HookInputSchema, SessionStateSchema, parseHookInput } from '../src/shared/index.js';

describe('Schema Property Tests', () => {
  describe('HookInputSchema', () => {
    // Generator for valid hook event names
    const hookEventArb = fc.constantFrom(
      'PostToolUse',
      'PreToolUse',
      'SubagentStop',
      'UserPromptSubmit',
      'Stop',
      'Shutdown',
    );

    // Generator for valid tool names
    const toolNameArb = fc.constantFrom('Edit', 'Write', 'Read', 'Bash', 'Glob', 'Grep', 'Task');

    // Generator for valid tool_input object (includes arbitrary extra field to confirm passthrough)
    const toolInputArb = fc.option(
      fc
        .record(
          {
            description: fc.option(fc.string({ maxLength: 500 }), { nil: undefined }),
            subagent_type: fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
            prompt: fc.option(fc.string({ maxLength: 1000 }), { nil: undefined }),
            skill: fc.option(fc.string({ maxLength: 200 }), { nil: undefined }),
            file_path: fc.option(fc.string({ maxLength: 300 }), { nil: undefined }),
          },
          { requiredKeys: [] },
        )
        .chain((base) =>
          fc.record({ extra_field: fc.string({ maxLength: 100 }) }).map((extra) => ({
            ...base,
            ...extra,
          })),
        ),
      { nil: undefined },
    );

    // Generator for valid HookInput (PostToolUse variant)
    const postToolUseInputArb = fc.record({
      hook_event_name: fc.constant('PostToolUse'),
      cwd: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => !s.includes('\0')),
      tool_name: toolNameArb,
      tool_input: toolInputArb,
      tool_output: fc.option(fc.string({ maxLength: 1000 }), { nil: undefined }),
    });

    // Generator for minimal HookInput
    const minimalInputArb = fc.record({
      hook_event_name: hookEventArb,
      cwd: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => !s.includes('\0')),
    });

    it('accepts all valid PostToolUse inputs', () => {
      fc.assert(
        fc.property(postToolUseInputArb, (input) => {
          const result = HookInputSchema.safeParse(input);
          expect(result.success).toBe(true);
        }),
        { numRuns: 200 },
      );
    });

    it('accepts all minimal inputs with any hook event', () => {
      fc.assert(
        fc.property(minimalInputArb, (input) => {
          const result = HookInputSchema.safeParse(input);
          expect(result.success).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('rejects inputs missing required fields', () => {
      // Missing hook_event_name
      const missingEventArb = fc.record({
        cwd: fc.string({ minLength: 1, maxLength: 100 }),
      });

      fc.assert(
        fc.property(missingEventArb, (input) => {
          const result = HookInputSchema.safeParse(input);
          expect(result.success).toBe(false);
        }),
        { numRuns: 50 },
      );

      // Missing cwd
      const missingCwdArb = fc.record({
        hook_event_name: hookEventArb,
      });

      fc.assert(
        fc.property(missingCwdArb, (input) => {
          const result = HookInputSchema.safeParse(input);
          expect(result.success).toBe(false);
        }),
        { numRuns: 50 },
      );
    });

    it('rejects legacy top-level compatibility fields', () => {
      const legacyInputArb = fc.oneof(
        fc.record({
          hook_event_name: fc.constant('UserPromptSubmit'),
          cwd: fc.string({ minLength: 1, maxLength: 100 }),
          user_message: fc.string({ minLength: 1, maxLength: 100 }),
        }),
        fc.record({
          hook_event_name: fc.constant('SubagentStop'),
          cwd: fc.string({ minLength: 1, maxLength: 100 }),
          agent_name: fc.string({ minLength: 1, maxLength: 100 }),
        }),
        fc.record({
          hook_event_name: fc.constant('SubagentStop'),
          cwd: fc.string({ minLength: 1, maxLength: 100 }),
          subagent_name: fc.string({ minLength: 1, maxLength: 100 }),
        }),
        fc.record({
          hook_event_name: fc.constant('SubagentStop'),
          cwd: fc.string({ minLength: 1, maxLength: 100 }),
          output: fc.string({ minLength: 1, maxLength: 100 }),
        }),
        fc.record({
          hook_event_name: fc.constant('PostToolUse'),
          cwd: fc.string({ minLength: 1, maxLength: 100 }),
          file_path: fc.string({ minLength: 1, maxLength: 100 }),
        }),
      );

      fc.assert(
        fc.property(legacyInputArb, (input) => {
          const result = HookInputSchema.safeParse(input);
          expect(result.success).toBe(false);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('parseHookInput', () => {
    it('parseHookInput(JSON.stringify(valid)) succeeds', () => {
      const validInputArb = fc.record({
        hook_event_name: fc.constantFrom('PostToolUse', 'UserPromptSubmit'),
        cwd: fc
          .string({ minLength: 1, maxLength: 100 })
          .filter((s) => !s.includes('\0') && !s.includes('"')),
      });

      fc.assert(
        fc.property(validInputArb, (input) => {
          const json = JSON.stringify(input);
          const result = parseHookInput(json);
          expect(result.success).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('parseHookInput rejects malformed JSON', () => {
      // Generate strings that are definitely not valid JSON
      const invalidJsonArb = fc.oneof(
        fc.constant('{invalid}'),
        fc.constant('not json'),
        fc.constant('{'),
        fc.constant('{"unclosed": '),
        fc.string().filter((s) => {
          try {
            JSON.parse(s);
            return false;
          } catch {
            return true;
          }
        }),
      );

      fc.assert(
        fc.property(invalidJsonArb, (invalidJson) => {
          const result = parseHookInput(invalidJson);
          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toContain('Invalid JSON');
          }
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('SessionStateSchema defaults', () => {
    it('empty object gets all defaults applied', () => {
      const result = SessionStateSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data.session_id).toBe('string');
        expect(result.data.session_id.length).toBeGreaterThan(0);
        expect(typeof result.data.started_at).toBe('string');
        expect(result.data.active_command).toBeNull();
        expect(result.data.active_skill).toBeNull();
        expect(result.data.edited_files).toEqual([]);
        expect(result.data.file_extensions).toEqual([]);
        expect(result.data.metadata).toEqual({});
      }
    });

    it('session_id format is consistent', () => {
      // Run multiple times to check timestamp-based generation
      for (let i = 0; i < 10; i++) {
        const result = SessionStateSchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
          // Format: 2025-12-24T14-30-45 (no colons, no dots)
          expect(result.data.session_id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
        }
      }
    });
  });
});
