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
/** Delegation dispatch gate for PreToolUse(Task) */
export * as onDelegationDispatch from './on-delegation-dispatch.js';
/** Delegated Bash guard for bare rd pass/fail in subagents */
export * as onDelegatedBashGuard from './on-delegated-bash-guard.js';
/** Subagent stop event gate */
export * as onSubagentStop from './on-subagent-stop.js';
/** Skill start event gate with runbook auto-execution */
export * as onSkillStart from './on-skill-start.js';
/** Command start event gate with runbook auto-execution */
export * as onCommandStart from './on-command-start.js';
