import type { Step } from '../types.js';
import type { WorkflowMetadata, StepPosition, ActionBlockData } from './types.js';
/**
 * Format step position as n/N
 */
export declare function formatPosition(pos: StepPosition): string;
/**
 * Print separator line
 */
export declare function printSeparator(): void;
/**
 * Print metadata block
 */
export declare function printMetadata(meta: WorkflowMetadata): void;
/**
 * Print action block (Action, optional From, optional Result)
 */
export declare function printActionBlock(data: ActionBlockData): void;
/**
 * Print step block (position + content)
 */
export declare function printStepBlock(pos: StepPosition, step: Step): void;
/**
 * Print command execution prefix (default mode only)
 */
export declare function printCommandExec(command: string): void;
/**
 * Print workflow complete message
 */
export declare function printWorkflowComplete(): void;
/**
 * Print workflow stopped message
 */
export declare function printWorkflowStopped(): void;
/**
 * Print workflow stopped message with step position
 */
export declare function printWorkflowStoppedAtStep(pos: StepPosition): void;
/**
 * Print workflow stashed message (includes step position)
 */
export declare function printWorkflowStashed(pos: StepPosition): void;
/**
 * Print no active workflow message
 */
export declare function printNoActiveWorkflow(): void;
/**
 * Print no workflows message
 */
export declare function printNoWorkflows(): void;
/**
 * Print workflow list entry
 */
export declare function printWorkflowListEntry(id: string, status: string, step: string, file: string, title?: string): void;
//# sourceMappingURL=output.d.ts.map