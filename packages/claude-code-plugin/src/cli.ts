// cli.ts
import { parseHookInput, logger, getErrorMessage } from './shared/index.js';
import { dispatch } from './dispatcher.js';
import { buildHookOutput } from './hook-output.js';
import {
  HOOK_REFUSAL_EXIT_CODE,
  type HookDispatchRefusal,
  refusalMessage,
} from './hook-refusal.js';

async function main(): Promise<void> {
  // The plugin's only CLI mode is native hook dispatch over stdin.
  await handleHookDispatch();
}

/**
 * Fail CLOSED: write the refusal to stderr and exit 2 — the universal blocking
 * channel of the Claude Code hook protocol. Never emits `continue: false` JSON
 * (ignored on PreToolUse/SubagentStop) and never exits 1 (non-blocking): both
 * were the #470 defect-3 fail-open paths.
 *
 * @param refusal - Typed refusal describing why dispatch was refused
 */
function failClosed(refusal: HookDispatchRefusal): never {
  process.stderr.write(`${refusalMessage(refusal)}\n`);
  process.exit(HOOK_REFUSAL_EXIT_CODE);
}

/**
 * Read a native hook payload from stdin, dispatch it through the plugin gates,
 * and write the resulting hook output (context/block/stop) to stdout. Any
 * failure to read, parse, validate, or dispatch the payload is a typed
 * fail-closed refusal (stderr + exit 2).
 */
async function handleHookDispatch(): Promise<void> {
  try {
    // Read stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const inputStr = Buffer.concat(chunks).toString('utf-8');

    // Allowlisted typed fields only — never log raw payload content
    // (delegation-lifecycle governing decision 2: no durable log may require
    // redacting captured input; log typed fields instead).
    await logger.always('HOOK_INVOKED', { input_length: inputStr.length });

    if (inputStr.length === 0) {
      await logger.error('CLI received empty input', {
        reason: 'stdin was empty - possible CLI race condition or cancelled operation',
      });
      failClosed({ kind: 'empty_input' });
    }

    const parseResult = parseHookInput(inputStr);
    if (!parseResult.success) {
      await logger.error('CLI input validation failed', {
        input_length: inputStr.length,
        error: parseResult.error,
      });
      failClosed({ kind: 'invalid_payload', detail: parseResult.error });
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

    // Write output (decisions are read from stdout on exit 0)
    if (Object.keys(output).length > 0) {
      console.log(JSON.stringify(output));
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    try {
      await logger.error('Hook dispatch failed', { error: errorMessage });
    } catch {
      // Logging must never bypass the fail-closed refusal.
    }
    failClosed({ kind: 'dispatch_failed', detail: errorMessage });
  }
}

void main();
