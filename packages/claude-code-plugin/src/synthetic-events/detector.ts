import type { HookInput } from '../shared/index.js';
import type { SyntheticEvent } from './types.js';

/**
 * Detect synthetic events from Claude Code primitive events.
 *
 * StepId Format:
 * - Must start with one or more digits (e.g., "1", "12")
 * - May have optional decimal substep (e.g., "1.1", "1.2", "12.3")
 * - Must be followed by a dash separator (-, –, or —)
 */
export function detectSyntheticEvents(input: HookInput): SyntheticEvent[] {
  const events: SyntheticEvent[] = [];
  const hookEvent = input.hook_event_name;
  const toolName = input.tool_name;

  // UserPromptSubmit → SlashCommandStart
  if (hookEvent === 'UserPromptSubmit' && input.user_message) {
    const cmdMatch = /^\/(\S+)/.exec(input.user_message);
    if (cmdMatch) {
      events.push({
        originalEvent: 'UserPromptSubmit',
        syntheticEvent: 'SlashCommandStart',
        commandName: cmdMatch[1]
      });
    }
  }

  // Stop → SlashCommandEnd
  if (hookEvent === 'Stop') {
    events.push({
      originalEvent: 'Stop',
      syntheticEvent: 'SlashCommandEnd'
    });
  }

  // PreToolUse Skill → SkillStart
  if (hookEvent === 'PreToolUse' && toolName === 'Skill') {
    const skillName = input.tool_input?.skill;
    events.push({
      originalEvent: 'PreToolUse',
      syntheticEvent: 'SkillStart',
      skillName
    });
  }

  // PostToolUse Skill → SkillEnd
  if (hookEvent === 'PostToolUse' && toolName === 'Skill') {
    const skillName = input.tool_input?.skill;
    events.push({
      originalEvent: 'PostToolUse',
      syntheticEvent: 'SkillEnd',
      skillName
    });
  }

  // PostToolUse Step/Task → SubagentStart
  if (hookEvent === 'PostToolUse' && (toolName === 'Step' || toolName === 'Task')) {
    const description = input.tool_input?.description;
    const subagentType = input.tool_input?.subagent_type;
    const toolUseId = input.tool_use_id;

    // Parse StepId: "1.1 - Description" → "1.1"
    const stepIdMatch = description ? /^(\d+(?:\.\d+)?)\s*[-–—]/.exec(description) : null;

    events.push({
      originalEvent: 'PostToolUse',
      syntheticEvent: 'SubagentStart',
      stepId: stepIdMatch?.[1] ?? input.step_id ?? input.task_id,
      toolUseId,
      subagentType
    });
  }

  return events;
}
