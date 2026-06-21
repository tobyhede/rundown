// gates/index.ts
/**
 * Built-in delegation gates. The plugin ships exactly three fixed gates wired to
 * native Claude Code hook events; no repository configuration alters them.
 */
export * as onDelegationDispatch from './on-delegation-dispatch.js';
export * as onDelegatedBashGuard from './on-delegated-bash-guard.js';
export * as onSubagentStop from './on-subagent-stop.js';
