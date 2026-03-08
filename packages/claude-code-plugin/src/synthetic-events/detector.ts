import type { HookInput } from '../shared/index.js';
import type { SyntheticEvent } from './types.js';

/**
 * Detect synthetic events from Claude Code primitive events.
 *
 * Emits derived SlashCommand and Skill lifecycle events.
 * @param input - Hook input containing the primitive event to analyze
 * @returns Array of synthetic events derived from the input event
 */
export function detectSyntheticEvents(input: HookInput): SyntheticEvent[] {
  const events: SyntheticEvent[] = [];
  const hookEvent = input.hook_event_name;
  const toolName = input.tool_name;
  const prompt = input.prompt;

  // UserPromptSubmit → SlashCommandStart
  if (hookEvent === 'UserPromptSubmit' && prompt) {
    const cmdMatch = /^\/(\S+)/.exec(prompt);
    if (cmdMatch) {
      events.push({
        originalEvent: 'UserPromptSubmit',
        syntheticEvent: 'SlashCommandStart',
        commandName: cmdMatch[1],
      });
    }
  }

  // Stop → SlashCommandEnd
  // NOTE: SlashCommandEnd is emitted unconditionally on Stop events.
  // The dispatcher (dispatcher.ts) filters this by checking session.active_command
  // before processing, so SlashCommandEnd only fires when a command was active.
  if (hookEvent === 'Stop') {
    events.push({
      originalEvent: 'Stop',
      syntheticEvent: 'SlashCommandEnd',
    });
  }

  // PreToolUse Skill → SkillStart
  if (hookEvent === 'PreToolUse' && toolName === 'Skill') {
    const skillName = input.tool_input?.skill;
    events.push({
      originalEvent: 'PreToolUse',
      syntheticEvent: 'SkillStart',
      skillName,
    });
  }

  // PostToolUse Skill → SkillEnd
  if (hookEvent === 'PostToolUse' && toolName === 'Skill') {
    const skillName = input.tool_input?.skill;
    events.push({
      originalEvent: 'PostToolUse',
      syntheticEvent: 'SkillEnd',
      skillName,
    });
  }

  return events;
}
