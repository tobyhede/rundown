// gates/index.ts
/**
 * Built-in gates registry
 *
 * All TypeScript gates are exported here for easy discovery and import.
 */

/** Plugin path resolution gate */
export * as pluginPath from './plugin-path.js';
/** Step tracking gate for runbook state management */
export * as onStepTracker from './on-step-tracker.js';
/** Subagent start event gate */
export * as onSubagentStart from './on-subagent-start.js';
/** Subagent stop event gate */
export * as onSubagentStop from './on-subagent-stop.js';
/** Skill start event gate with runbook auto-execution */
export * as onSkillStart from './on-skill-start.js';
/** Command start event gate with runbook auto-execution */
export * as onCommandStart from './on-command-start.js';
