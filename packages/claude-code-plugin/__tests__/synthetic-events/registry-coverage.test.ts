// __tests__/synthetic-events/registry-coverage.test.ts
// Automated verification that synthetic event detection covers all configured derived events

import { detectSyntheticEvents } from '../../src/synthetic-events/detector.js';
import { isSyntheticEvent, type SyntheticEventName } from '../../src/synthetic-events/types.js';
import { createMockHookInput } from '../helpers/test-utils.js';
import type { HookInput } from '../../src/shared/index.js';

const ALL_SYNTHETIC_EVENT_TYPES: SyntheticEventName[] = [
  'SkillStart',
  'SkillEnd',
  'SlashCommandStart',
  'SlashCommandEnd',
];

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
      prompt: '/test-command',
    }),
  SlashCommandEnd: () => createMockHookInput('Stop'),
};

describe('Synthetic Event Registry Coverage', () => {
  describe('isSyntheticEvent type guard', () => {
    it('correctly identifies all synthetic event types', () => {
      for (const eventType of ALL_SYNTHETIC_EVENT_TYPES) {
        expect(isSyntheticEvent(eventType)).toBe(true);
      }
    });

    it('correctly rejects non-synthetic events', () => {
      const nonSyntheticEvents = [
        'PreToolUse',
        'PostToolUse',
        'SubagentStart',
        'SubagentStop',
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
    for (const [syntheticType, createInput] of Object.entries(SYNTHETIC_EVENT_TRIGGERS)) {
      it(`can detect ${syntheticType} events`, () => {
        const input = createInput();
        const events = detectSyntheticEvents(input);
        const hasExpectedEvent = events.some((e) => e.syntheticEvent === syntheticType);
        expect(hasExpectedEvent).toBe(true);
      });
    }

    it('detector covers all expected synthetic events', () => {
      for (const eventType of ALL_SYNTHETIC_EVENT_TYPES) {
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
      it('extracts command name from prompt', () => {
        const input = createMockHookInput('UserPromptSubmit', {
          prompt: '/execute run all tests',
        });

        const events = detectSyntheticEvents(input);
        const cmdEvent = events.find((e) => e.syntheticEvent === 'SlashCommandStart');

        expect(cmdEvent).toBeDefined();
        expect(cmdEvent?.commandName).toBe('execute');
      });

      it('handles commands with namespace', () => {
        const input = createMockHookInput('UserPromptSubmit', {
          prompt: '/cipherpowers:commit message here',
        });

        const events = detectSyntheticEvents(input);
        const cmdEvent = events.find((e) => e.syntheticEvent === 'SlashCommandStart');

        expect(cmdEvent).toBeDefined();
        expect(cmdEvent?.commandName).toBe('cipherpowers:commit');
      });

      it('does not detect non-command prompts', () => {
        const input = createMockHookInput('UserPromptSubmit', {
          prompt: 'This is a regular message',
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
