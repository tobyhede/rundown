import { type ParsedConditional, type StepNumber } from './types.js';
import { type Action, type Transitions } from './schemas.js';
export interface ParsedSubstepHeader {
    stepRef: number | '{N}';
    id: string;
    description: string;
    agentType?: string;
    isDynamic: boolean;
}
/**
 * Strip common separators and whitespace
 */
export declare function stripSeparator(text: string): string;
export interface ParsedStepHeader {
    number?: StepNumber;
    isDynamic: boolean;
    description: string;
}
/**
 * Extract step number and description from header text
 */
export declare function extractStepHeader(text: string): ParsedStepHeader | null;
/**
 * Extract substep header from H3 text
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
export declare function convertToTransitions(conditionals: ParsedConditional[]): Transitions;
export declare function extractWorkflowList(content: string): string[];
/**
 * Classify code block by language tag
 * @returns false for executable, true for prompted, null for passive
 */
export declare function isPromptedCodeBlock(lang: string | null | undefined): boolean | null;
export declare function formatAction(action: Action): string;
//# sourceMappingURL=helpers.d.ts.map