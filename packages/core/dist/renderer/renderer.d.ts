import { type Step, type Action, type Transitions, type Substep, type Workflow } from '../types.js';
/**
 * Render an Action to its DSL string representation
 */
export declare function renderAction(action: Action): string;
/**
 * Render Transitions to Markdown list items
 */
export declare function renderTransitions(transitions: Transitions): string;
/**
 * Render a Substep to Markdown
 * @param substep - The substep to render
 * @param parentStepNumber - The parent step number (undefined for dynamic parent)
 */
export declare function renderSubstep(substep: Substep, parentStepNumber: number | undefined): string;
/**
 * Render a Step to its Markdown representation
 */
export declare function renderStep(step: Step): string;
/**
 * Render a full Workflow object to Markdown
 */
export declare function renderWorkflow(workflow: Workflow): string;
//# sourceMappingURL=renderer.d.ts.map