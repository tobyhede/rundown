import type { HookInput } from '../../shared/index.js';
import { rundown } from './rundown.js';

export interface SubagentStartResult {
  context?: string;
  violation?: string;
}

interface ExecSyncError extends Error {
  stderr?: Buffer | string;
}

function isExecSyncError(error: unknown): error is ExecSyncError {
  return error instanceof Error && 'status' in error && 'stderr' in error;
}

/**
 * Handle SubagentStart hook
 */
export function handleSubagentStart(input: HookInput): SubagentStartResult {
  if (input.hook_event_name !== 'SubagentStart') {
    return {};
  }

  const agentId = input.agent_id;
  if (!agentId) {
    return {};
  }

  try {
    const output = rundown(`run --agent ${agentId}`, input.cwd);

    const context = parseStartAgentOutput(output, agentId);
    return { context };
  } catch (error) {
    if (!isExecSyncError(error)) {
      return {};
    }
    const stderr = error.stderr?.toString() ?? '';
    if (stderr.includes('No pending step')) {
      return {
        violation: 'SubagentStart with no pending step. Step dispatch must precede agent start.'
      };
    }
    return {};
  }
}

function parseStartAgentOutput(output: string, agentId: string): string {
  const lines = ['## Workflow Agent Context', '', `AGENT_ID: ${agentId}`, ''];

  const stepMatch = /bound to step (\d+(?:\.\d+)?)/.exec(output);
  if (stepMatch) {
    lines.push(`STEP_ID: ${stepMatch[1]}`);
  }

  const workflowMatch = /Started child workflow: (.+)/.exec(output);
  if (workflowMatch) {
    lines.push(`WORKFLOW: ${workflowMatch[1]}`);
  }

  lines.push('', '## Commands', '');
  lines.push(`rundown pass --agent ${agentId}`);
  lines.push(`rundown fail --agent ${agentId}`);
  lines.push('');

  return lines.join('\n');
}
