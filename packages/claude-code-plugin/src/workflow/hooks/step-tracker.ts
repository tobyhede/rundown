// src/workflow/hooks/step-tracker.ts
import type { HookInput } from '../../shared/index.js';
import { rundown } from './rundown.js';

export interface StepDispatchResult {
  violation?: string;
}

/**
 * Track Step tool dispatches in workflow state
 */
export function trackStepDispatch(input: HookInput): StepDispatchResult {
  // Handle both Step and Task tool (Task for backward compatibility/LLM training)
  if (input.tool_name !== 'Step' && input.tool_name !== 'Task') {
    return {};
  }

  try {
    const description = input.tool_input?.description ?? '';

    if (!description.trim()) {
      return {
        violation: 'Step description cannot be empty'
      };
    }

    try {
      rundown(`run --step "${description}"`, input.cwd);
      return {};
    } catch {
      return {};
    }
  } catch (error: unknown) {
    console.error('Failed to track step dispatch:', error);
    return {};
  }
}
