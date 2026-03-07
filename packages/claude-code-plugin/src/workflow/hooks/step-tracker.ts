// src/workflow/hooks/step-tracker.ts
import type { HookInput } from '../../shared/index.js';
import { rundown } from './rundown.js';

/**
 * Result of processing a Step/Task tool dispatch for workflow tracking.
 */
export interface StepDispatchResult {
  violation?: string;
}

const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';
const NUMERIC = '[0-9]+';
const STEP_ID_PATTERN = `(?:${NUMERIC}|${IDENTIFIER})(?:\\.(?:${NUMERIC}|${IDENTIFIER}))?`;
const EXACT_STEP_ID = new RegExp(`^${STEP_ID_PATTERN}$`);
const PREFIXED_STEP_ID = new RegExp(`^\\s*(${STEP_ID_PATTERN})\\s*[-–—:]\\s+`);

/**
 * Extract a normalized step identifier from a Step/Task description.
 *
 * Accepted forms:
 * - "1.1"
 * - "NamedStep"
 * - "1.1 - Description"
 * - "NamedStep: Description"
 * @param description - Raw Step/Task tool description text
 * @returns Normalized step identifier, or null if no valid identifier found
 */
function extractStepId(description: string): string | null {
  const trimmed = description.trim();
  if (!trimmed) return null;

  if (EXACT_STEP_ID.test(trimmed)) {
    return trimmed;
  }

  const prefixed = PREFIXED_STEP_ID.exec(trimmed);
  if (prefixed?.[1]) {
    return prefixed[1];
  }

  return null;
}

/**
 * Track Step tool dispatches in workflow state
 * @param input - Hook input containing tool name and description
 * @returns Result with optional violation message if step identifier is invalid
 */
export function trackStepDispatch(input: HookInput): StepDispatchResult {
  // Handle both Step and Task tool (Task for backward compatibility/LLM training)
  if (input.tool_name !== 'Step' && input.tool_name !== 'Task') {
    return {};
  }

  try {
    const description = input.tool_input?.description ?? '';
    const stepId = extractStepId(description);

    if (!stepId) {
      return {
        violation:
          'Step description must include a valid step identifier (e.g. "1.1 - Do work" or "ErrorHandler: Recover").',
      };
    }

    try {
      // execFileSync passes args as an array — no shell interpretation, no escaping needed
      rundown(['run', '--step', stepId], input.cwd);
      return {};
    } catch {
      return {};
    }
  } catch (error: unknown) {
    console.error('Failed to track step dispatch:', error);
    return {};
  }
}
