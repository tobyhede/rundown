// plugin/core/src/synthetic-events/types.ts

// SubagentStart/SubagentEnd are NOT synthetic: Claude Code provides native
// SubagentStart/SubagentStop hook events, making synthetic detection unnecessary.
/** Synthetic event names inferred from tool-use patterns when Claude Code doesn't provide native events. */
export type SyntheticEventName =
  | 'SkillStart'
  | 'SkillEnd'
  | 'SlashCommandStart'
  | 'SlashCommandEnd';

export interface SyntheticEvent {
  /** The Claude Code event that triggered detection */
  originalEvent: string;

  /** The synthetic event to dispatch */
  syntheticEvent: SyntheticEventName;

  /** For SkillStart/End - full skill name with namespace */
  skillName?: string;

  /** For SlashCommandStart/End - full command with namespace */
  commandName?: string;
}

/**
 * Check if an event name is synthetic (not fired by Claude Code)
 */
export function isSyntheticEvent(eventName: string): eventName is SyntheticEventName {
  return ['SkillStart', 'SkillEnd', 'SlashCommandStart', 'SlashCommandEnd'].includes(eventName);
}
