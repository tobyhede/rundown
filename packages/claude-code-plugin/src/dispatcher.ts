// dispatcher.ts
import { type HookInput, type GateResult, logger, getErrorMessage } from './shared/index.js';
import * as onBashCommand from './gates/on-bash-command.js';

/** Dispatch pipeline result. */
export interface DispatchResult {
  /** Context to inject into the conversation. */
  context?: string;
  /** If set, the hook blocked execution with this reason. */
  blockReason?: string;
  /**
   * PreToolUse only: the complete tool input to run in place of the agent's
   * (the Bash hook's `--agent-id` stamp, the dispatch hook's claim
   * instructions). Never set together with {@link blockReason}.
   */
  updatedInput?: Record<string, unknown>;
  /**
   * If set, halts Claude with this message — bridged to the Claude Code
   * `continue: false` / `stopReason` hook protocol by {@link buildHookOutput}.
   * This is a supported output directive, not dead engine cruft: it is retained
   * as the stop surface and covered by hook-output tests. No fixed delegation
   * gate currently produces a stop, so {@link dispatch} never sets it today; a
   * future gate can opt in without re-plumbing the output layer.
   */
  stopMessage?: string;
}

type Gate = (input: HookInput) => Promise<GateResult>;

/** The fixed routes the plugin owns. Each key is a native event + (optional) tool. */
type Route = { event: 'PreToolUse'; tool: 'Agent' | 'Task' | 'Bash' } | { event: 'SubagentStop' };

/**
 * Resolve the native hook input to a typed route, or null if unhandled.
 *
 * @param input - Hook input from Claude Code
 * @returns The matched route, or null when no plugin gate applies
 */
function routeOf(input: HookInput): Route | null {
  if (input.hook_event_name === 'SubagentStop') return { event: 'SubagentStop' };
  if (input.hook_event_name === 'PreToolUse') {
    const tool = input.tool_name;
    if (tool === 'Agent' || tool === 'Task' || tool === 'Bash') {
      return { event: 'PreToolUse', tool };
    }
  }
  return null;
}

/**
 * Select the fixed, plugin-owned gates for a route.
 *
 * The Bash gate is imported statically: it runs on every Bash call and loads
 * nothing beyond a string prefix. The gates that need `@rundown-org/core`
 * (Agent/Task dispatch, SubagentStop) are imported only when their route
 * fires, so a Bash call never loads core (review finding H7).
 *
 * @param route - The matched route
 * @returns The ordered gates to run
 */
async function gatesFor(route: Route): Promise<Gate[]> {
  if (route.event === 'SubagentStop')
    return [(await import('./gates/on-subagent-stop.js')).execute];
  if (route.tool === 'Bash') return [onBashCommand.execute];
  return [(await import('./gates/on-delegation-dispatch.js')).execute]; // Agent | Task
}

/**
 * Run the fixed delegation-safety gates for a native hook event.
 *
 * Gates run in order; the first `decision: 'block'` short-circuits. Context from
 * non-blocking gates accumulates; the last gate's `updatedInput` stands (each
 * route has one gate today). No repository config, context files, or shell
 * gates are consulted.
 *
 * @param input - Hook input describing the event and its metadata
 * @returns Dispatch result with optional context and block directive
 */
export async function dispatch(input: HookInput): Promise<DispatchResult> {
  const route = routeOf(input);
  if (!route) return {};

  let context = '';
  let updatedInput: Record<string, unknown> | undefined;
  for (const gate of await gatesFor(route)) {
    let result: GateResult;
    try {
      result = await gate(input);
    } catch (error) {
      // Fail-open backstop: a throwing gate is logged and skipped. No gate
      // reaches it today: on-subagent-stop fails CLOSED on its own errors
      // (it blocks when it cannot ask the CLI which children hold the agent),
      // and the Bash stamp and the dispatch decision are pure functions of
      // the tool input with no error path.
      await logger.error('Gate execution failed', {
        event: input.hook_event_name,
        tool: input.tool_name,
        error: getErrorMessage(error),
      });
      continue;
    }
    if (result.additionalContext) {
      context = context ? `${context}\n\n${result.additionalContext}` : result.additionalContext;
    }
    if (result.decision === 'block') {
      return { context: context || undefined, blockReason: result.reason };
    }
    if (result.updatedInput) updatedInput = result.updatedInput;
  }
  return {
    ...(context ? { context } : {}),
    ...(updatedInput ? { updatedInput } : {}),
  };
}
