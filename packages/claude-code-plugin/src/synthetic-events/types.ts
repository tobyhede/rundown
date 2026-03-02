// plugin/core/src/synthetic-events/types.ts

/**
 * Names of synthetic events that Rundown derives from Claude Code hook events.
 *
 * These events are not fired directly by Claude Code. Instead, Rundown detects
 * them by pattern-matching on native hook event data (e.g. tool input containing
 * a Skill tool invocation triggers `SkillStart`).
 *
 * Note: `SubagentStart`/`SubagentStop` are NOT synthetic — Claude Code provides
 * native hook events for those, so synthetic detection is unnecessary.
 */
export type SyntheticEventName =
  | 'SkillStart'
  | 'SkillEnd'
  | 'SlashCommandStart'
  | 'SlashCommandEnd';

/**
 * A synthetic event derived from a Claude Code hook event.
 *
 * Produced by the synthetic event detector when a native hook event matches
 * a known pattern (e.g. a `ToolUse` event invoking the Skill tool).
 */
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
