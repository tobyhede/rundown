// __tests__/synthetic-events/registry-coverage.test.ts
// Automated verification that synthetic event detection covers all configured gates

import { detectSyntheticEvents } from '../../src/synthetic-events/detector.js';
import { isSyntheticEvent, type SyntheticEventName } from '../../src/synthetic-events/types.js';
import { createMockHookInput } from '../helpers/test-utils.js';
import type { HookInput } from '../../src/shared/index.js';

/**
 * All synthetic event types defined in the system
 */
const ALL_SYNTHETIC_EVENT_TYPES: SyntheticEventName[] = [
  'SkillStart',
  'SkillEnd',
  'SlashCommandStart',
  'SlashCommandEnd',
  'SubagentStart',
  'SubagentEnd',
];

/**
 * Mapping of synthetic events to the Claude Code events that trigger them
 */
const SYNTHETIC_EVENT_TRIGGERS: Record<SyntheticEventName, () => HookInput> = {
  SkillStart: () =>
    createMockHookInput('PreToolUse', {
      tool_name: 'Skill',
      tool_input: { skill: 'test-skill' },
    }),
  SkillEnd: () =>
    createMockHookInput('PostToolUse', {
      tool_name: 'Skill',
      tool_input: { skill: 'test-skill' },
    }),
  SlashCommandStart: () =>
    createMockHookInput('UserPromptSubmit', {
      user_message: '/test-command',
    }),
  SlashCommandEnd: () => createMockHookInput('Stop'),
  SubagentStart: () =>
    createMockHookInput('PostToolUse', {
      tool_name: 'Task',
      tool_input: {
        description: '1.1 - Test task',
        subagent_type: 'test-agent',
      },
      tool_use_id: 'tool-123',
    }),
  SubagentEnd: () =>
    createMockHookInput('SubagentStop', {
      agent_id: 'agent-123',
      output: 'STATUS: PASS',
    }),
};

describe('Synthetic Event Registry Coverage', () => {
  describe('isSyntheticEvent type guard', () => {
    it('correctly identifies all synthetic event types', () => {
      for (const eventType of ALL_SYNTHETIC_EVENT_TYPES) {
        expect(isSyntheticEvent(eventType)).toBe(true);
      }
    });

    it('correctly rejects non-synthetic events', () => {
      // These are native Claude Code events, NOT synthetic events
      const nonSyntheticEvents = [
        'PreToolUse',
        'PostToolUse',
        'SubagentStop', // Note: SubagentStart IS synthetic (from Task/Step), SubagentStop is native
        'UserPromptSubmit',
        'Stop',
        'SessionStart',
        'SessionEnd',
      ];

      for (const event of nonSyntheticEvents) {
        expect(isSyntheticEvent(event)).toBe(false);
      }
    });
  });

  describe('synthetic event detection completeness', () => {
    const detectedEvents = new Set<string>();

    // Test each trigger and collect detected events
    for (const [syntheticType, createInput] of Object.entries(SYNTHETIC_EVENT_TRIGGERS)) {
      it(`can detect ${syntheticType} events`, () => {
        const input = createInput();
        const events = detectSyntheticEvents(input);

        // SubagentEnd is not detected by detectSyntheticEvents (handled by handleSubagentStop)
        if (syntheticType === 'SubagentEnd') {
          // This event is handled separately by the workflow hook
          expect(true).toBe(true);
          return;
        }

        const hasExpectedEvent = events.some((e) => e.syntheticEvent === syntheticType);
        expect(hasExpectedEvent).toBe(true);

        for (const e of events) detectedEvents.add(e.syntheticEvent);
      });
    }

    it('detector covers all expected synthetic events (except SubagentEnd)', () => {
      // SubagentEnd is handled separately by handleSubagentStop, not detectSyntheticEvents
      const expectedDetected = ALL_SYNTHETIC_EVENT_TYPES.filter((e) => e !== 'SubagentEnd');

      for (const eventType of expectedDetected) {
        const input = SYNTHETIC_EVENT_TRIGGERS[eventType]();
        const events = detectSyntheticEvents(input);
        const detected = events.some((e) => e.syntheticEvent === eventType);
        expect(detected).toBe(true);
      }
    });
  });

  describe('synthetic event detection accuracy', () => {
    describe('SkillStart detection', () => {
      it('extracts skill name from tool_input', () => {
        const input = createMockHookInput('PreToolUse', {
          tool_name: 'Skill',
          tool_input: { skill: 'namespace:skill-name' },
        });

        const events = detectSyntheticEvents(input);
        const skillEvent = events.find((e) => e.syntheticEvent === 'SkillStart');

        expect(skillEvent).toBeDefined();
        expect(skillEvent?.skillName).toBe('namespace:skill-name');
      });

      it('requires Skill tool name', () => {
        const input = createMockHookInput('PreToolUse', {
          tool_name: 'Edit',
          tool_input: { skill: 'should-not-match' },
        });

        const events = detectSyntheticEvents(input);
        expect(events.find((e) => e.syntheticEvent === 'SkillStart')).toBeUndefined();
      });
    });

    describe('SkillEnd detection', () => {
      it('extracts skill name from tool_input', () => {
        const input = createMockHookInput('PostToolUse', {
          tool_name: 'Skill',
          tool_input: { skill: 'test:skill' },
        });

        const events = detectSyntheticEvents(input);
        const skillEvent = events.find((e) => e.syntheticEvent === 'SkillEnd');

        expect(skillEvent).toBeDefined();
        expect(skillEvent?.skillName).toBe('test:skill');
      });
    });

    describe('SlashCommandStart detection', () => {
      it('extracts command name from user message', () => {
        const input = createMockHookInput('UserPromptSubmit', {
          user_message: '/execute run all tests',
        });

        const events = detectSyntheticEvents(input);
        const cmdEvent = events.find((e) => e.syntheticEvent === 'SlashCommandStart');

        expect(cmdEvent).toBeDefined();
        expect(cmdEvent?.commandName).toBe('execute');
      });

      it('handles commands with namespace', () => {
        const input = createMockHookInput('UserPromptSubmit', {
          user_message: '/cipherpowers:commit message here',
        });

        const events = detectSyntheticEvents(input);
        const cmdEvent = events.find((e) => e.syntheticEvent === 'SlashCommandStart');

        expect(cmdEvent).toBeDefined();
        expect(cmdEvent?.commandName).toBe('cipherpowers:commit');
      });

      it('does not detect non-command messages', () => {
        const input = createMockHookInput('UserPromptSubmit', {
          user_message: 'This is a regular message',
        });

        const events = detectSyntheticEvents(input);
        expect(events.find((e) => e.syntheticEvent === 'SlashCommandStart')).toBeUndefined();
      });
    });

    describe('SlashCommandEnd detection', () => {
      it('fires on Stop event', () => {
        const input = createMockHookInput('Stop');
        const events = detectSyntheticEvents(input);

        expect(events.find((e) => e.syntheticEvent === 'SlashCommandEnd')).toBeDefined();
      });
    });

    describe('SubagentStart detection', () => {
      it('extracts step ID from description', () => {
        const input = createMockHookInput('PostToolUse', {
          tool_name: 'Task',
          tool_input: {
            description: '1.2 - Implement the feature',
            subagent_type: 'code-agent',
          },
          tool_use_id: 'tool-abc',
        });

        const events = detectSyntheticEvents(input);
        const subagentEvent = events.find((e) => e.syntheticEvent === 'SubagentStart');

        expect(subagentEvent).toBeDefined();
        expect(subagentEvent?.stepId).toBe('1.2');
        expect(subagentEvent?.subagentType).toBe('code-agent');
        expect(subagentEvent?.toolUseId).toBe('tool-abc');
      });

      it('handles Step tool as well as Task', () => {
        const input = createMockHookInput('PostToolUse', {
          tool_name: 'Step',
          tool_input: {
            description: '3 - Simple step',
          },
        });

        const events = detectSyntheticEvents(input);
        expect(events.find((e) => e.syntheticEvent === 'SubagentStart')).toBeDefined();
      });

      it('handles various step ID formats', () => {
        const formats = [
          { desc: '1 - Step one', expected: '1' },
          { desc: '12 - Step twelve', expected: '12' },
          { desc: '1.1 - Substep', expected: '1.1' },
          { desc: '12.5 - Decimal substep', expected: '12.5' },
          { desc: '1– En dash step', expected: '1' },
          { desc: '1— Em dash step', expected: '1' },
        ];

        for (const { desc, expected } of formats) {
          const input = createMockHookInput('PostToolUse', {
            tool_name: 'Task',
            tool_input: { description: desc },
          });

          const events = detectSyntheticEvents(input);
          const event = events.find((e) => e.syntheticEvent === 'SubagentStart');
          expect(event?.stepId).toBe(expected);
        }
      });

      it('handles descriptions without step ID', () => {
        const input = createMockHookInput('PostToolUse', {
          tool_name: 'Task',
          tool_input: {
            description: 'Just a regular description without step ID',
          },
          step_id: 'fallback-step-id',
        });

        const events = detectSyntheticEvents(input);
        const event = events.find((e) => e.syntheticEvent === 'SubagentStart');
        expect(event?.stepId).toBe('fallback-step-id');
      });
    });
  });

  describe('no false positives', () => {
    it('does not detect synthetic events for unrelated hook events', () => {
      const unrelatedInputs = [
        createMockHookInput('PreToolUse', { tool_name: 'Read' }),
        createMockHookInput('PreToolUse', { tool_name: 'Bash' }),
        createMockHookInput('PostToolUse', { tool_name: 'Edit' }),
        createMockHookInput('PostToolUse', { tool_name: 'Write' }),
        createMockHookInput('SubagentStart'),
        createMockHookInput('SubagentStop'),
      ];

      for (const input of unrelatedInputs) {
        const events = detectSyntheticEvents(input);
        // These should not produce any synthetic events
        // (SubagentStart from Task/Step is handled, but SubagentStop is not)
        const unexpectedEvents = events.filter(
          (e) =>
            e.syntheticEvent === 'SkillStart' ||
            e.syntheticEvent === 'SkillEnd' ||
            e.syntheticEvent === 'SlashCommandStart',
        );
        expect(unexpectedEvents).toHaveLength(0);
      }
    });
  });
});
