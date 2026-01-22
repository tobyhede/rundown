// src/workflow/context.ts

/**
 * Get workflow context for injection into agent prompts
 * Note: Workflow state management is now delegated to rundown CLI
 */
export function getWorkflowContext(_cwd: string): string | null {
  // Context is now injected via hooks calling rundown CLI
  return null;
}
