// src/workflow/hooks/subagent-stop.ts
import type { HookInput } from '../../shared/index.js';
import { rundown, setExecSync } from './rundown.js';

export interface SubagentStopResult {
  context?: string;
  violation?: string;
}

// Re-export for testing
export { setExecSync };

/**
 * Pattern for parsing STATUS field from agent output.
 * Expected format: STATUS: OK|PASS|BLOCKED|FAIL (case-insensitive)
 */
const STATUS_PATTERN = /STATUS:\s*(OK|PASS|BLOCKED|FAIL)/i;

/**
 * Parse STATUS field from subagent output
 */
function parseAgentStatus(output?: string): 'pass' | 'fail' {
  if (!output) return 'pass';

  const match = STATUS_PATTERN.exec(output);
  if (!match) return 'pass';

  const status = match[1].toUpperCase();
  return status === 'OK' || status === 'PASS' ? 'pass' : 'fail';
}

/**
 * Handle SubagentStop hook
 */
export function handleSubagentStop(input: HookInput): SubagentStopResult {
  if (input.hook_event_name !== 'SubagentStop') {
    return {};
  }

  const agentId = input.agent_id;
  if (!agentId) return {};

  const status = parseAgentStatus(input.last_assistant_message);
  const command = status === 'pass' ? 'pass' : 'fail';

  try {
    const output = rundown([command, '--agent', agentId], input.cwd);

    const context = formatCompletionContext(output, agentId, status);
    return { context };
  } catch (error: unknown) {
    const execError = error as { stderr?: Buffer | string };
    const stderr = execError.stderr?.toString() ?? '';
    if (stderr.includes('No binding for agent')) {
      return {
        violation: `SubagentStop for unknown agent: ${agentId}`,
      };
    }
    return {};
  }
}

function formatCompletionContext(
  cliOutput: string,
  agentId: string,
  result: 'pass' | 'fail',
): string {
  const lines: string[] = [];

  if (result === 'fail') {
    lines.push(`Agent ${agentId} FAILED.`);
  } else {
    lines.push(`Agent ${agentId} complete.`);
  }

  if (cliOutput.trim()) {
    lines.push(cliOutput);
  }

  return lines.join('\n');
}
