// packages/claude-code-plugin/__tests__/synthetic-events/detector.test.ts
import { detectSyntheticEvents } from '../../src/synthetic-events/detector.js';
import { isSyntheticEvent } from '../../src/synthetic-events/types.js';
import type { HookInput } from '../../src/shared/index.js';

describe('detectSyntheticEvents', () => {
  describe('SlashCommandStart (from UserPromptSubmit)', () => {
    it('detects command from prompt with namespace', () => {
      const input: HookInput = {
        hook_event_name: 'UserPromptSubmit',
        cwd: '/test',
        prompt: '/cipherpowers:verify check this',
      };

      const events = detectSyntheticEvents(input);

      expect(events).toContainEqual(
        expect.objectContaining({
          syntheticEvent: 'SlashCommandStart',
          commandName: 'cipherpowers:verify',
        }),
      );
    });

    it('detects command without namespace', () => {
      const input: HookInput = {
        hook_event_name: 'UserPromptSubmit',
        cwd: '/test',
        prompt: '/commit fix the bug',
      };

      const events = detectSyntheticEvents(input);

      expect(events).toContainEqual(
        expect.objectContaining({
          syntheticEvent: 'SlashCommandStart',
          commandName: 'commit',
        }),
      );
    });
  });

  describe('SlashCommandEnd (from Stop)', () => {
    it('emits SlashCommandEnd on Stop', () => {
      const input: HookInput = {
        hook_event_name: 'Stop',
        cwd: '/test',
      };

      const events = detectSyntheticEvents(input);

      expect(events).toContainEqual(expect.objectContaining({ syntheticEvent: 'SlashCommandEnd' }));
    });
  });

  describe('SkillStart/End (from PreToolUse/PostToolUse Skill)', () => {
    it('detects SkillStart with full namespace', () => {
      const input: HookInput = {
        hook_event_name: 'PreToolUse',
        cwd: '/test',
        tool_name: 'Skill',
        tool_input: { skill: 'rundown:verifying-by-consensus' },
      };

      const events = detectSyntheticEvents(input);

      expect(events).toContainEqual(
        expect.objectContaining({
          syntheticEvent: 'SkillStart',
          skillName: 'rundown:verifying-by-consensus',
        }),
      );
    });

    it('detects SkillEnd', () => {
      const input: HookInput = {
        hook_event_name: 'PostToolUse',
        cwd: '/test',
        tool_name: 'Skill',
        tool_input: { skill: 'cipherpowers:commit' },
      };

      const events = detectSyntheticEvents(input);

      expect(events).toContainEqual(
        expect.objectContaining({
          syntheticEvent: 'SkillEnd',
          skillName: 'cipherpowers:commit',
        }),
      );
    });
  });

  it('returns empty for non-triggering events', () => {
    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      cwd: '/test',
      tool_name: 'Edit',
    };

    expect(detectSyntheticEvents(input)).toEqual([]);
  });
});

describe('isSyntheticEvent', () => {
  it('returns true for synthetic events', () => {
    expect(isSyntheticEvent('SkillStart')).toBe(true);
    expect(isSyntheticEvent('SkillEnd')).toBe(true);
    expect(isSyntheticEvent('SlashCommandStart')).toBe(true);
    expect(isSyntheticEvent('SlashCommandEnd')).toBe(true);
  });

  it('returns false for real Claude Code events', () => {
    expect(isSyntheticEvent('PreToolUse')).toBe(false);
    expect(isSyntheticEvent('PostToolUse')).toBe(false);
    expect(isSyntheticEvent('UserPromptSubmit')).toBe(false);
    expect(isSyntheticEvent('Stop')).toBe(false);
    expect(isSyntheticEvent('SubagentStart')).toBe(false);
  });
});
