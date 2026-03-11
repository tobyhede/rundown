// cli.ts
import {
  type SessionState,
  type SessionStateArrayKey,
  SESSION_STATE_KEYS,
  parseHookInput,
  logger,
  getErrorMessage,
} from './shared/index.js';
import { dispatch } from './dispatcher.js';
import { buildHookOutput } from './hook-output.js';
import { Session } from './session.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Check if first arg is "session" - session management mode
  if (args.length > 0 && args[0] === 'session') {
    await handleSessionCommand(args.slice(1));
    return;
  }

  // Check if first arg is "log-path" - return log file path for mise tasks
  if (args.length > 0 && args[0] === 'log-path') {
    console.log(logger.getLogFilePath());
    return;
  }

  // Check if first arg is "log-dir" - return log directory for mise tasks
  if (args.length > 0 && args[0] === 'log-dir') {
    console.log(logger.getLogDir());
    return;
  }

  // Otherwise, hook dispatch mode (existing behavior)
  await handleHookDispatch();
}

/**
 * Type guard for SessionState keys.
 * @param key - The string to check against known session state keys
 * @returns True if key is a valid SessionState key, narrowing type to keyof SessionState
 */
function isSessionStateKey(key: string): key is keyof SessionState {
  return (SESSION_STATE_KEYS as readonly string[]).includes(key);
}

/**
 * Type guard for array-valued session state keys.
 * @param key - The string to check against known array-typed session keys
 * @returns True if key is a SessionStateArrayKey, narrowing the type for array operations
 */
function isArrayKey(key: string): key is SessionStateArrayKey {
  return key === 'edited_files' || key === 'file_extensions';
}

/**
 * Handle session management commands with proper type safety
 * @param args - CLI arguments following the "session" subcommand
 */
async function handleSessionCommand(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: hooks-app session [get|set|append|contains|clear] ...');
    process.exit(1);
  }

  const [command, ...params] = args;

  // Helper to extract cwd - defaults to process.cwd() if not provided
  const getCwd = (expectedParams: number): string => {
    return params.length > expectedParams ? params[params.length - 1] : process.cwd();
  };

  try {
    switch (command) {
      case 'get': {
        // Usage: get <key> [cwd] - key is required, cwd is optional
        if (params.length < 1) {
          console.error('Usage: hooks-app session get <key> [cwd]');
          process.exit(1);
        }
        const [key] = params;
        const session = new Session(getCwd(1));
        if (!isSessionStateKey(key)) {
          console.error(`Invalid session key: ${key}`);
          process.exit(1);
        }
        const value = await session.get(key);
        console.log(value ?? '');
        break;
      }

      case 'set': {
        // Usage: set <key> <value> [cwd] - key and value are required, cwd is optional
        if (params.length < 2) {
          console.error('Usage: hooks-app session set <key> <value> [cwd]');
          process.exit(1);
        }
        const [key, value] = params;
        const session = new Session(getCwd(2));
        if (!isSessionStateKey(key)) {
          console.error(`Invalid session key: ${key}`);
          process.exit(1);
        }
        // Type-safe set with runtime validation
        if (key === 'active_command' || key === 'active_skill') {
          await session.set(key, value === 'null' ? null : value);
        } else if (key === 'metadata') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value);
          } catch (e) {
            const message = getErrorMessage(e);
            console.error(`Invalid JSON for metadata: ${message}`);
            process.exit(1);
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            console.error('Metadata must be a JSON object');
            process.exit(1);
          }
          await session.set(key, parsed as Record<string, unknown>);
        } else {
          console.error(`Cannot set ${key} via CLI (use get, append, or contains)`);
          process.exit(1);
        }
        break;
      }

      case 'append': {
        // Usage: append <key> <value> [cwd] - key and value are required, cwd is optional
        if (params.length < 2) {
          console.error('Usage: hooks-app session append <key> <value> [cwd]');
          process.exit(1);
        }
        const [key, value] = params;
        const session = new Session(getCwd(2));
        if (!isArrayKey(key)) {
          console.error(`Invalid array key: ${key} (must be edited_files or file_extensions)`);
          process.exit(1);
        }
        await session.append(key, value);
        break;
      }

      case 'contains': {
        // Usage: contains <key> <value> [cwd] - key and value are required, cwd is optional
        if (params.length < 2) {
          console.error('Usage: hooks-app session contains <key> <value> [cwd]');
          process.exit(1);
        }
        const [key, value] = params;
        const session = new Session(getCwd(2));
        if (!isArrayKey(key)) {
          console.error(`Invalid array key: ${key} (must be edited_files or file_extensions)`);
          process.exit(1);
        }
        const result = await session.contains(key, value);
        process.exit(result ? 0 : 1);
        break;
      }

      case 'clear': {
        // Usage: clear [cwd] - cwd is optional
        const session = new Session(getCwd(0));
        await session.clear();
        break;
      }

      default:
        console.error(`Unknown session command: ${command}`);
        process.exit(1);
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    await logger.error('Session command failed', { command, error: errorMessage });
    console.error(`Session error: ${errorMessage}`);
    process.exit(1);
  }
}

/**
 * Handle hook dispatch (existing behavior)
 */
async function handleHookDispatch(): Promise<void> {
  try {
    // Read stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const inputStr = Buffer.concat(chunks).toString('utf-8');

    // ALWAYS log hook invocation (unconditional - for debugging)
    await logger.always('HOOK_INVOKED', {
      input_length: inputStr.length,
      input_preview: inputStr.substring(0, 500),
    });

    // Log raw input at CLI entry point
    await logger.debug('CLI received hook input', {
      input_length: inputStr.length,
      input_preview: inputStr.substring(0, 200),
    });

    // Parse and validate input
    if (inputStr.length === 0) {
      await logger.error('CLI received empty input', {
        reason: 'stdin was empty - possible CLI race condition or cancelled operation',
      });
      console.error(
        JSON.stringify({
          continue: false,
          stopReason: 'Empty input received',
        }),
      );
      process.exit(1);
    }

    const parseResult = parseHookInput(inputStr);
    if (!parseResult.success) {
      await logger.error('CLI input validation failed', {
        input_length: inputStr.length,
        input_preview: inputStr.substring(0, 200),
        error: parseResult.error,
      });
      console.error(
        JSON.stringify({
          continue: false,
          stopReason: parseResult.error,
        }),
      );
      process.exit(1);
    }

    const input = parseResult.data;

    // Log parsed hook event
    await logger.info('CLI dispatching hook', {
      event: input.hook_event_name,
      cwd: input.cwd,
      tool: input.tool_name,
      agent: input.agent_type,
      command: input.command,
      skill: input.skill,
    });

    // Dispatch
    const result = await dispatch(input);

    // Build output
    const output = buildHookOutput(input, result);

    // Log result
    await logger.info('CLI hook completed', {
      event: input.hook_event_name,
      has_context: !!result.context,
      has_block: !!result.blockReason,
      has_stop: !!result.stopMessage,
      output_keys: Object.keys(output),
    });

    // Write output
    if (Object.keys(output).length > 0) {
      console.log(JSON.stringify(output));
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    await logger.error('Hook dispatch failed', { error: errorMessage });
    console.error(
      JSON.stringify({
        continue: false,
        stopReason: `Unexpected error: ${String(error)}`,
      }),
    );
    process.exit(1);
  }
}

void main();
