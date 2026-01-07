import { z } from 'zod';
/**
 * Workflow frontmatter metadata
 */
export interface WorkflowFrontmatter {
    name: string;
    description?: string;
    version?: string;
    author?: string;
    tags?: string[];
}
/**
 * Zod schema for validating workflow frontmatter
 */
export declare const WorkflowFrontmatterSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    version: z.ZodOptional<z.ZodString>;
    author: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    name: string;
    description?: string | undefined;
    version?: string | undefined;
    author?: string | undefined;
    tags?: string[] | undefined;
}, {
    name: string;
    description?: string | undefined;
    version?: string | undefined;
    author?: string | undefined;
    tags?: string[] | undefined;
}>;
/**
 * Type derived from Zod schema
 */
export type WorkflowFrontmatterType = z.infer<typeof WorkflowFrontmatterSchema>;
/**
 * Extract frontmatter from markdown content
 * Returns frontmatter object and remaining content (with frontmatter stripped)
 *
 * Frontmatter must be:
 * - At the start of the file
 * - Enclosed in --- delimiters
 * - Valid YAML
 *
 * If frontmatter is missing or invalid, returns null for frontmatter and original content
 */
export declare function extractFrontmatter(markdown: string): {
    frontmatter: WorkflowFrontmatter | null;
    content: string;
};
/**
 * Extract workflow name from filename
 * Removes the .runbook.md extension
 *
 * Example: "my-runbook.runbook.md" -> "my-runbook"
 */
export declare function nameFromFilename(filename: string): string;
//# sourceMappingURL=frontmatter.d.ts.map