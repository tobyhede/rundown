import type { StepId } from './schemas.js';
export interface ParseStepIdOptions {
    /** Require a separator after the step ID (space, dash, colon) */
    readonly requireSeparator?: boolean;
}
/**
 * Parse StepId from string
 */
export declare function parseStepIdFromString(input: string, options?: ParseStepIdOptions): StepId | null;
/**
 * Serialize StepId to string
 */
export declare function stepIdToString(stepId: StepId): string;
/**
 * Compare two StepIds for equality
 */
export declare function stepIdEquals(a: StepId, b: StepId): boolean;
//# sourceMappingURL=step-id.d.ts.map