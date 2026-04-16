import type { TemplateVarValue } from '@rundown-org/core';

/**
 * Runtime value available during step execution.
 *
 * Execution-time variables include persisted template values plus transient
 * JSON scalars resolved from FOR iteration sources. Persisted runbook state
 * continues to use {@link TemplateVarValue}; only the in-memory execution
 * frame admits top-level booleans and nulls.
 */
export type ExecutionVarValue = TemplateVarValue | boolean | null;

/**
 * Runtime variable map used for prompt, command, and OUTPUTS expansion.
 */
export type StepVariables = Record<string, ExecutionVarValue>;

/**
 * Persisted template variables loaded from CLI flags, config, or frontmatter.
 */
export type TemplateVariables = Record<string, TemplateVarValue>;
