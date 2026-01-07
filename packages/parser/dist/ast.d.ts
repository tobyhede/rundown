import { type StepNumber, type StepId, type Action, type Transitions } from './schemas.js';
export { type StepNumber, type StepId, type Action, type Transitions };
/**
 * Code block command
 * - prompted: undefined (default) - executable, runs automatically (bash/sh/shell blocks)
 * - prompted: true - show to agent, don't run (prompt blocks)
 */
export interface Command {
    readonly code: string;
    readonly prompted?: boolean;
}
/**
 * Prompt for agent (implicit or explicit)
 */
export interface Prompt {
    readonly text: string;
}
/**
 * A substep within a step (H3 header)
 */
export interface Substep {
    readonly id: string;
    readonly description: string;
    readonly agentType?: string;
    readonly isDynamic: boolean;
    readonly command?: Command;
    readonly prompts: readonly Prompt[];
    readonly transitions?: Transitions;
    readonly workflows?: readonly string[];
    readonly line?: number;
}
/**
 * A single step in a workflow
 */
export interface Step {
    readonly number?: StepNumber;
    readonly isDynamic: boolean;
    readonly description: string;
    readonly command?: Command;
    readonly prompts: readonly Prompt[];
    readonly transitions?: Transitions;
    readonly substeps?: readonly Substep[];
    readonly workflows?: readonly string[];
    readonly line?: number;
    /** @deprecated Use workflows instead */
    readonly nestedWorkflow?: string;
}
/**
 * Parsed workflow definition
 */
export interface Workflow {
    readonly title?: string;
    readonly description?: string;
    readonly name?: string;
    readonly version?: string;
    readonly author?: string;
    readonly tags?: readonly string[];
    readonly steps: readonly Step[];
}
//# sourceMappingURL=ast.d.ts.map