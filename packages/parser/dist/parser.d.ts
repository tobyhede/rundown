import { type Step, type Workflow } from './ast.js';
/**
 * Parse workflow markdown into Step array (compatibility wrapper)
 */
export declare function parseWorkflow(markdown: string): Step[];
export interface ParseOptions {
    /** If true, skip validation and don't throw on errors */
    skipValidation?: boolean;
}
/**
 * Parse entire workflow document including metadata
 */
export declare function parseWorkflowDocument(markdown: string, filename?: string, options?: ParseOptions): Workflow;
//# sourceMappingURL=parser.d.ts.map