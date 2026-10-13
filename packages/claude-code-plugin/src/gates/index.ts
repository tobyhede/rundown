// gates/index.ts
/**
 * Built-in delegation gates. The plugin ships exactly three fixed gates wired
 * to native Claude Code hook events; no repository configuration alters them.
 */
export * as onBashCommand from './on-bash-command.js';
export * as onDelegationDispatch from './on-delegation-dispatch.js';
export * as onSubagentStop from './on-subagent-stop.js';
