// plugin/core/src/synthetic-events/types.ts

// SubagentStart/SubagentStop are NOT synthetic: Claude Code provides native
// SubagentStart/SubagentStop hook events, making synthetic detection unnecessary.
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
 * Check if an event name is synthetic (not fired by Claude Code).
 *
 * @param eventName - The event name to check
 * @returns True if the event name is a {@link SyntheticEventName}
 */
export function isSyntheticEvent(eventName: string): eventName is SyntheticEventName {
  return ['SkillStart', 'SkillEnd', 'SlashCommandStart', 'SlashCommandEnd'].includes(eventName);
}
