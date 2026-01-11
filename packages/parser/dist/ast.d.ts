import { type StepNumber, type StepId, type Action, type Transitions } from './schemas.js';
export { type StepNumber, type StepId, type Action, type Transitions };
/**
 * Code block command - always executable (bash/sh/shell only)
 */
export interface Command {
    readonly code: string;
}
/**
 * A substep within a step (H3 header)
 */
export interface Substep {
    readonly id: string;
    readonly description: string;
    readonly agentType?: string;
    readonly isDynamic: boolean;
    readonly isNamed: boolean;
    readonly command?: Command;
    readonly prompt?: string;
    readonly transitions?: Transitions;
    readonly workflows?: readonly string[];
    readonly line?: number;
}
/**
 * A single step in a workflow
 */
export interface Step {
    readonly number?: StepNumber;
    readonly name?: string;
    readonly isDynamic: boolean;
    readonly isNamed: boolean;
    readonly description: string;
    readonly command?: Command;
    readonly prompt?: string;
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