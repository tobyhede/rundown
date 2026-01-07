import type { Step, Action } from './ast.js';
export interface ValidationError {
    readonly line?: number;
    readonly message: string;
}
/**
 * Validates a parsed workflow against Rundown specification rules.
 */
export declare function validateWorkflow(steps: readonly Step[]): ValidationError[];
/**
 * Validates a single action
 */
export declare function validateAction(action: Action, currentStepNum: number, currentSubstepId: string | undefined, steps: readonly Step[], currentStepObj: Step, errors: ValidationError[]): void;
//# sourceMappingURL=validator.d.ts.map