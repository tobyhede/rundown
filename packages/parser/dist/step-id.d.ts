import type { StepId } from './schemas.js';
/**
 * Reserved words that cannot be used as named step identifiers
 */
export declare const RESERVED_WORDS: Set<string>;
/**
 * Check if a string is a reserved word
 */
export declare function isReservedWord(word: string): boolean;
/**
 * Valid identifier pattern for named steps/substeps
 */
export declare const NAMED_IDENTIFIER_PATTERN: RegExp;
export interface ParseStepIdOptions {
    /** Require a separator after the step ID (space, dash, colon) */
    readonly requireSeparator?: boolean;
}
/**
 * Parse StepId from string
 *
 * Supports:
 * - Numeric: "1", "1.2"
 * - Dynamic: "{N}.1", "{N}.{n}", "{N}.Name"
 * - Named: "Cleanup", "ErrorHandler.1", "ErrorHandler.Recover"
 * - Special: "NEXT"
 *
 * Named steps/substeps must be valid identifiers (no spaces, no quotes).
 * Quoted strings are rejected - use identifiers only.
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