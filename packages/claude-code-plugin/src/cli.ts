// cli.ts
import { parseHookInput, logger, getErrorMessage } from './shared/index.js';
import { dispatch } from './dispatcher.js';
import { buildHookOutput } from './hook-output.js';

async function main(): Promise<void> {
  // The plugin's only CLI mode is native hook dispatch over stdin.
  await handleHookDispatch();
}

/**
 * Read a native hook payload from stdin, dispatch it through the plugin gates,
 * and write the resulting hook output (context/block/stop) to stdout.
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
        stopReason: `Unexpected error: ${errorMessage}`,
      }),
    );
    process.exit(1);
  }
}

void main();
