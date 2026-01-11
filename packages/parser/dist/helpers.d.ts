import { type ParsedConditional, type StepNumber } from './types.js';
import { type Action, type Transitions } from './schemas.js';
/**
 * Parse a quoted string or single-word identifier.
 * Used for STOP and COMPLETE messages ONLY.
 * NOT used for GOTO targets (GOTO uses parseStepIdFromString which accepts identifiers directly).
 *
 * Valid formats:
 * - Single word identifier: /^[A-Za-z_][A-Za-z0-9_]*$/
 * - Quoted string: "any text here"
 *
 * @throws Error if format is invalid
 */
export declare function parseQuotedOrIdentifier(text: string): string;
export interface ParsedSubstepHeader {
    stepRef: number | string;
    id: string;
    description: string;
    agentType?: string;
    isDynamic: boolean;
    isNamed: boolean;
}
/**
 * Strip common separators and whitespace
 */
export declare function stripSeparator(text: string): string;
export interface ParsedStepHeader {
    number?: StepNumber;
    name?: string;
    isDynamic: boolean;
    isNamed: boolean;
    description: string;
}
/**
 * Extract step number/name and description from header text
 */
export declare function extractStepHeader(text: string): ParsedStepHeader | null;
/**
 * Extract substep header from H3 text
 *
 * Supports:
 * - Numeric: "1.2 Description"
 * - Dynamic: "{N}.1 Description", "1.{n} Description", "{N}.{n} Description"
 * - Named: "1.Cleanup Description", "ErrorHandler.Recover Description", "{N}.Recovery Description"
 */
export declare function extractSubstepHeader(text: string): ParsedSubstepHeader | null;
/**
 * Parse an action string into an Action object
 */
export declare function parseAction(text: string): Action | null;
export declare function parseConditional(text: string): ParsedConditional | null;
/**
 * Validate that NEXT is only used in dynamic step contexts
 */
export declare function validateNEXTUsage(conditionals: ParsedConditional[], isDynamicStep: boolean): void;
export declare function convertToTransitions(conditionals: ParsedConditional[]): Transitions | null;
export declare function extractWorkflowList(content: string): string[];
/**
 * Check if code block is executable (bash/sh/shell)
 */
export declare function isExecutableCodeBlock(lang: string | null | undefined): boolean;
/**
 * Check if code block is a prompt block
 * Returns true if tag is 'prompt', false if tag is executable (bash/sh/shell), null otherwise
 */
export declare function isPromptCodeBlock(lang: string | null | undefined): boolean | null;
/**
 * Escape content for shell single-quoted string
 */
export declare function escapeForShellSingleQuote(content: string): string;
export declare function formatAction(action: Action): string;
//# sourceMappingURL=helpers.d.ts.map