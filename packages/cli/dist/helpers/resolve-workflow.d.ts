/**
 * Resolve runbook file from multiple sources.
 * Supports both path-based and name-based resolution:
 * - Path mode: .claude/runbooks/file.md, ./path/to/file.md, etc.
 * - Name mode: "verify", "my-runbook", etc.
 *
 * Search order for path mode:
 * 1. .claude/runbooks/ (project-local)
 * 2. $CLAUDE_PLUGIN_ROOT/runbooks/ (plugin directory)
 * 3. Relative to cwd
 *
 * Search order for name mode:
 * 1. Project runbooks directory
 * 2. Plugin runbooks directory
 *
 * @param cwd - Current working directory
 * @param identifier - Runbook filename or name to find
 * @returns Absolute path to runbook file, or null if not found
 */
export declare function resolveWorkflowFile(cwd: string, identifier: string): Promise<string | null>;
//# sourceMappingURL=resolve-workflow.d.ts.map