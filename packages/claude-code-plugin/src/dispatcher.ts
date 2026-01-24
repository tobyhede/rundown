// dispatcher.ts
import {
  type HookInput,
  type HookConfig,
  type GateConfig,
  loadConfig,
  logger,
  isPathInside
} from './shared/index.js';
import { injectContext } from './context.js';
import { executeGate } from './gate-loader.js';
import { handleAction } from './action-handler.js';
import { Session } from './session.js';
import { getWorkflowContext } from './workflow/context.js';
import { minimatch } from 'minimatch';
import path from 'path';
import { detectSyntheticEvents } from './synthetic-events/detector.js';
import { isSyntheticEvent } from './synthetic-events/types.js';

export function shouldProcessHook(input: HookInput, hookConfig: HookConfig): boolean {
  const hookEvent = input.hook_event_name;

  // PostToolUse filtering
  if (hookEvent === 'PostToolUse') {
    if (hookConfig.enabled_tools && hookConfig.enabled_tools.length > 0) {
      return hookConfig.enabled_tools.includes(input.tool_name ?? '');
    }
  }

  // SubagentStop filtering
  if (hookEvent === 'SubagentStop') {
    if (hookConfig.enabled_agents && hookConfig.enabled_agents.length > 0) {
      const agentName = input.agent_name ?? input.subagent_name ?? '';
      return hookConfig.enabled_agents.includes(agentName);
    }
  }

  // No filtering or other events
  return true;
}

export interface DispatchResult {
  context?: string;
  blockReason?: string;
  stopMessage?: string;
}

/**
 * ERROR HANDLING: Circular gate chain prevention (max 10 gates per dispatch).
 * Prevents infinite loops from misconfigured gate chains.
 */
const MAX_GATES_PER_DISPATCH = 10;

// Built-in gates removed - context injection is the primary behavior
// Context injection happens via injectContext() which discovers .claude/context/ files

/**
 * Check if gate should run based on keyword matching (UserPromptSubmit only).
 * Gates without keywords always run (backwards compatible).
 *
 * Note: Uses substring matching, not word-boundary matching. This means "test"
 * will match "latest" or "contest". This is intentional for flexibility - users
 * can say "let's test this" or "testing the feature" and both will match.
 * If word-boundary matching is needed in the future, consider using regex like:
 * /\b${keyword}\b/i.test(message)
 */
export function gateMatchesKeywords(
  gateConfig: GateConfig,
  userMessage: string | undefined
): boolean {
  // No keywords = always run (backwards compatible)
  if (!gateConfig.keywords || gateConfig.keywords.length === 0) {
    return true;
  }

  // No user message = skip keyword gates
  if (!userMessage) {
    return false;
  }

  const lowerMessage = userMessage.toLowerCase();
  return gateConfig.keywords.some((keyword) => lowerMessage.includes(keyword.toLowerCase()));
}

/**
 * Check if gate should run based on file pattern matching (PostToolUse only).
 * Gates without patterns always run (backwards compatible).
 *
 * Uses glob patterns matched against relative paths from project root.
 * Multiple patterns use OR logic - gate runs if file matches ANY pattern.
 *
 * @param gateConfig - Gate configuration
 * @param filePath - Absolute path to file being modified (from HookInput.file_path)
 * @param cwd - Current working directory (project root)
 * @returns true if gate should run, false otherwise
 */
export async function gateMatchesFilePattern(
  gateConfig: GateConfig,
  filePath: string | undefined,
  cwd: string
): Promise<boolean> {
  // No patterns = always run (backwards compatible)
  if (!gateConfig.file_patterns || gateConfig.file_patterns.length === 0) {
    return true;
  }

  // No file path = skip pattern matching
  if (!filePath) {
    return false;
  }

  // FIX: Normalize relative paths to absolute paths before conversion
  // If filePath is already relative, path.relative may produce incorrect results
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

  // SECURITY: Path Jail - only match files inside project root
  if (!isPathInside(cwd, absolutePath)) {
    await logger.debug('File outside project root - gate skipped', { absolutePath, cwd });
    return false;
  }

  // Convert absolute path to relative path from cwd
  const relativePath = path.relative(cwd, absolutePath);

  // FIX: Keep .some() implementation from Task 3, add logging separately
  let matchedPattern: string | undefined;

  // Check if file matches ANY pattern (OR logic)
  try {
    const matches = gateConfig.file_patterns.some((pattern) => {
      const result = minimatch(relativePath, pattern, {
        matchBase: false, // Match full path, not just basename (packages/cts/** shouldn't match unrelated/cts/)
        dot: true // Allow patterns to match dotfiles like .config/settings.json
      });
      if (result) {
        matchedPattern = pattern;
      }
      return result;
    });

    // FIX: Use await logger.debug() pattern (consistent with existing code)
    if (matches && matchedPattern) {
      await logger.debug('File pattern matched', {
        relativePath,
        pattern: matchedPattern,
        absolutePath: filePath
      });
    }

    return matches;
  } catch (error) {
    // FIX: Invalid glob pattern - log warning and skip gate
    await logger.warn('Invalid file pattern - gate skipped', {
      pattern: gateConfig.file_patterns,
      error: error instanceof Error ? error.message : String(error),
      relativePath
    });
    return false;
  }
}

async function updateSessionState(input: HookInput): Promise<void> {
  const session = new Session(input.cwd);
  const event = input.hook_event_name;

  try {
    switch (event) {
      case 'SlashCommandStart':
        // command field set by synthetic dispatcher
        if (input.command) {
          await session.set('active_command', input.command); // Full name preserved
        }
        break;

      case 'SlashCommandEnd':
        await session.set('active_command', null);
        break;

      case 'SkillStart':
        // skill field set by synthetic dispatcher
        if (input.skill) {
          await session.set('active_skill', input.skill); // Full name preserved
        }
        break;

      case 'SkillEnd':
        await session.set('active_skill', null);
        break;

      case 'SubagentStart':
        // Store tool_use_id → stepId mapping for correlation
        if (input.tool_use_id && input.step_id) {
          const metadata = await session.get('metadata');
          const mapping = (metadata.toolUseIdToStepId ?? {}) as Record<string, string>;
          await session.set('metadata', {
            ...metadata,
            toolUseIdToStepId: {
              ...mapping,
              [input.tool_use_id]: input.step_id
            }
          });
        }
        break;

      case 'PostToolUse':
        if (input.file_path) {
          await session.append('edited_files', input.file_path);

          // Extract file extension using basename to handle paths with dots
          const baseName = path.basename(input.file_path);
          const ext = baseName.split('.').pop();
          if (ext && ext !== baseName) {
            await session.append('file_extensions', ext);
          }
        }
        break;
    }
  } catch (error) {
    // Session state is best-effort, don't fail the hook if it errors
    // Structured error logging for debugging
    const errorData = {
      error_type: error instanceof Error ? error.constructor.name : 'UnknownError',
      error_message: error instanceof Error ? error.message : String(error),
      hook_event: event,
      cwd: input.cwd,
      timestamp: new Date().toISOString()
    };
    console.error(`[Session Error] ${JSON.stringify(errorData)}`);
  }
}

export async function dispatch(input: HookInput): Promise<DispatchResult> {
  const hookEvent = input.hook_event_name;
  const cwd = input.cwd;
  const startTime = Date.now();

  await logger.event('debug', hookEvent, {
    tool: input.tool_name,
    agent: input.agent_name ?? input.subagent_name,
    file: input.file_path,
    cwd
  });

  // Update session state (best-effort)
  await updateSessionState(input);

  // 1. ALWAYS run context injection FIRST (primary behavior)
  // This discovers .claude/context/{name}-{stage}.md files
  const contextContent = await injectContext(hookEvent, input);
  let accumulatedContext = contextContent ?? '';

  // Inject workflow context if active
  const workflowContext = getWorkflowContext(input.cwd);
  if (workflowContext) {
    accumulatedContext = accumulatedContext
      ? accumulatedContext + '\n\n' + workflowContext
      : workflowContext;
  }

  // Synthetic event dispatch
  // SAFETY: isSyntheticEvent() prevents recursive synthetic detection.
  // If synthetic events are ever added to hooks.json, they would NOT
  // trigger additional synthetic detection because detectSyntheticEvents()
  // only maps real Claude Code events.
  if (!isSyntheticEvent(hookEvent)) {
    // Reuse single Session instance for synthetic dispatch
    const syntheticSession = new Session(input.cwd);

    // Special handling: Clear active_command on every UserPromptSubmit
    // BEFORE potentially setting new one via SlashCommandStart
    if (hookEvent === 'UserPromptSubmit') {
      await syntheticSession.set('active_command', null);
    }

    const syntheticEvents = detectSyntheticEvents(input);

    for (const synthetic of syntheticEvents) {
      // Special handling: SlashCommandEnd should only dispatch if there was an active command
      // and needs to pass the command name for context injection
      let slashCommandEndCommand: string | undefined;
      if (synthetic.syntheticEvent === 'SlashCommandEnd') {
        const activeCommand = await syntheticSession.get('active_command');
        if (!activeCommand) {
          continue; // Skip SlashCommandEnd if no active command
        }
        slashCommandEndCommand = activeCommand;
      }

      // Build synthetic input with event-specific fields
      const syntheticInput: HookInput = {
        ...input,
        hook_event_name: synthetic.syntheticEvent,
        // Add event-specific fields (slashCommandEndCommand for SlashCommandEnd, synthetic.commandName for others)
        ...(slashCommandEndCommand
          ? { command: slashCommandEndCommand }
          : synthetic.commandName && { command: synthetic.commandName }),
        ...(synthetic.skillName && { skill: synthetic.skillName }),
        ...(synthetic.stepId && { step_id: synthetic.stepId }),
        ...(synthetic.toolUseId && { tool_use_id: synthetic.toolUseId }),
        ...(synthetic.subagentType && { subagent_type: synthetic.subagentType })
      };

      // Recursive dispatch for synthetic event (full pipeline)
      const syntheticResult = await dispatch(syntheticInput);

      // Accumulate context from synthetic events (avoid leading newlines)
      if (syntheticResult.context) {
        accumulatedContext = accumulatedContext
          ? accumulatedContext + '\n\n' + syntheticResult.context
          : syntheticResult.context;
      }

      // Propagate blocks from synthetic events
      if (syntheticResult.blockReason) {
        return {
          context: accumulatedContext,
          blockReason: syntheticResult.blockReason
        };
      }
    }
  }

  // 2. Load config for additional gates (optional)
  const config = await loadConfig(cwd);
  if (!config) {
    await logger.debug('No rundown-plugin.json config found', { cwd });
    // Return context injection result even without rundown-plugin.json
    return accumulatedContext ? { context: accumulatedContext } : {};
  }

  // 3. Check if hook event has additional gates configured
  const hookConfig = config.hooks[hookEvent];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for external data structure
  if (!hookConfig) {
    await logger.debug('Hook event not configured in rundown-plugin.json', { event: hookEvent });
    // Return context injection result even if hook not in rundown-plugin.json
    return accumulatedContext ? { context: accumulatedContext } : {};
  }

  // 4. Filter by enabled lists
  if (!shouldProcessHook(input, hookConfig)) {
    await logger.debug('Hook filtered out by enabled list', {
      event: hookEvent,
      tool: input.tool_name,
      agent: input.agent_name
    });
    // Still return context injection result
    return accumulatedContext ? { context: accumulatedContext } : {};
  }

  // 5. Run additional gates in sequence (from rundown-plugin.json)
  const gates = hookConfig.gates ?? [];
  let gatesExecuted = 0;

  for (const gateName of gates) {
    // Circuit breaker: prevent infinite chains
    if (gatesExecuted >= MAX_GATES_PER_DISPATCH) {
      return {
        blockReason: `Exceeded max gate chain depth (${String(MAX_GATES_PER_DISPATCH)}). Check for circular references.`
      };
    }

    const gateConfig = config.gates[gateName];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for missing gate definition
    if (!gateConfig) {
      // Graceful degradation: skip undefined gates with warning
      accumulatedContext += `\nWarning: Gate '${gateName}' not defined, skipping`;
      continue;
    }

    // Keyword filtering for UserPromptSubmit
    if (hookEvent === 'UserPromptSubmit' && !gateMatchesKeywords(gateConfig, input.user_message)) {
      await logger.debug('Gate skipped - no keyword match', { gate: gateName });
      continue;
    }

    // File pattern filtering for PostToolUse
    if (
      hookEvent === 'PostToolUse' &&
      !(await gateMatchesFilePattern(gateConfig, input.file_path, input.cwd))
    ) {
      await logger.debug('Gate skipped - no file pattern match', { gate: gateName });
      continue;
    }

    gatesExecuted++;

    // Execute gate
    const gateStartTime = Date.now();
    const { passed, result } = await executeGate(gateName, gateConfig, input, []);
    const gateDuration = Date.now() - gateStartTime;

    await logger.event('info', hookEvent, {
      gate: gateName,
      passed,
      duration_ms: gateDuration,
      tool: input.tool_name
    });

    // Determine action
    const action = passed ? (gateConfig.on_pass ?? 'CONTINUE') : (gateConfig.on_fail ?? 'BLOCK');

    // Handle action
    const actionResult = handleAction(action, result, config, input);

    if (actionResult.context) {
      accumulatedContext += '\n' + actionResult.context;
    }

    if (!actionResult.continue) {
      await logger.event('warn', hookEvent, {
        gate: gateName,
        action,
        blocked: !!actionResult.blockReason,
        stopped: !!actionResult.stopMessage,
        duration_ms: Date.now() - startTime
      });
      return {
        context: accumulatedContext,
        blockReason: actionResult.blockReason,
        stopMessage: actionResult.stopMessage
      };
    }

    // Gate chaining
    if (actionResult.chainedGate) {
      gates.push(actionResult.chainedGate);
    }
  }

  await logger.event('debug', hookEvent, {
    status: 'completed',
    gates_executed: gatesExecuted,
    duration_ms: Date.now() - startTime
  });

  return {
    context: accumulatedContext
  };
}
