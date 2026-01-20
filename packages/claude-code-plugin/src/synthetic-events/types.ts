// plugin/core/src/synthetic-events/types.ts

export type SyntheticEventName =
  | 'SkillStart'
  | 'SkillEnd'
  | 'SlashCommandStart'
  | 'SlashCommandEnd'
  | 'SubagentStart'
  | 'SubagentEnd';

export interface SyntheticEvent {
  /** The Claude Code event that triggered detection */
  originalEvent: string;

  /** The synthetic event to dispatch */
  syntheticEvent: SyntheticEventName;

  /** For SkillStart/End - full skill name with namespace */
  skillName?: string;

  /** For SlashCommandStart/End - full command with namespace */
  commandName?: string;

  /** For SubagentStart - parsed StepId */
  stepId?: string;

  /** For SubagentStart - tool_use_id for correlation */
  toolUseId?: string;

  /** For SubagentStart - agent type from tool_input */
  subagentType?: string;
}

/**
 * Check if an event name is synthetic (not fired by Claude Code)
 */
export function isSyntheticEvent(eventName: string): eventName is SyntheticEventName {
  return [
    'SkillStart',
    'SkillEnd',
    'SlashCommandStart',
    'SlashCommandEnd',
    'SubagentStart',
    'SubagentEnd'
  ].includes(eventName);
}
