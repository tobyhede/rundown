/**
 * Rundown Security Policy Layer
 *
 * Provides Deno-inspired, explicit allowlist policy for runbook execution.
 * Default-deny with prompt-driven grants and config-based policy management.
 *
 * @module
 *
 * @example
 * ```typescript
 * import {
 *   loadPolicy,
 *   PolicyEvaluator,
 *   PolicyPrompter,
 * } from '@rundown/core/policy';
 *
 * // Load policy from config file
 * const { policy } = await loadPolicy();
 *
 * // Create evaluator
 * const evaluator = new PolicyEvaluator(policy, {
 *   repoRoot: '/path/to/repo',
 * });
 *
 * // Check command permission
 * const decision = evaluator.checkCommand('npm install');
 *
 * if (!decision.allowed && decision.requiresPrompt) {
 *   const prompter = new PolicyPrompter({ evaluator });
 *   const result = await prompter.requestPermission('run', 'npm install');
 *   if (!result.granted) {
 *     throw new Error('Permission denied');
 *   }
 * }
 * ```
 */

// Schema types and utilities
export {
  type PolicyMode,
  type PermissionRules,
  type DefaultPolicy,
  type PolicyOverride,
  type PolicyGrant,
  type PolicyConfig,
  PolicyModeSchema,
  PermissionRulesSchema,
  DefaultPolicySchema,
  PolicyOverrideSchema,
  PolicyGrantSchema,
  PolicyConfigSchema,
  DEFAULT_POLICY,
  parsePolicy,
  safeParsePolicyConfig,
} from './schema.js';

// Command parser
export {
  type ParsedCommand,
  extractCommands,
  extractPrimaryExecutable,
  extractAllExecutables,
} from './parser.js';

// Policy loader
export {
  type PolicyLoadResult,
  type PolicyLoadOptions,
  loadPolicy,
  loadPolicyFromFile,
  loadPolicySync,
  loadPolicyFromFileSync,
  mergePolicies,
  writePolicyConfig,
} from './loader.js';

// Policy evaluator
export {
  type PolicyDecision,
  type PolicyEvaluatorOptions,
  PolicyEvaluator,
  createDefaultEvaluator,
} from './evaluator.js';

// Permission prompter
export {
  type PermissionType,
  type PromptResult,
  type PrompterOptions,
  PolicyPrompter,
  createNonInteractivePrompter,
  createAutoYesPrompter,
} from './prompter.js';
