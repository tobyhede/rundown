export { parseRunbook, parseRunbookDocument, type ParseOptions } from './parser.js';
export {
  validateRunbook,
  validateAction,
} from './validator.js';
// eslint-disable-next-line @typescript-eslint/no-deprecated -- backward-compatible re-export
export type { ValidationError, ValidationDiagnostic } from './validator.js';
export { RunbookSyntaxError, MAX_STEP_NUMBER } from './types.js';
export type { ParsedConditional, ParseConditionalResult, AggregationModifier } from './types.js';
export type * from './ast.js';
export * from './schemas.js';
export {
  stripSeparator,
  extractStepHeader,
  parseAction,
  parseConditional,
  convertToTransitions,
  extractSubstepHeader,
  parseForClause,
  extractRunbookList,
  isExecutableCodeBlock,
  isPromptCodeBlock,
  escapeForShellSingleQuote,
  parseQuotedOrIdentifier,
  validateLoopControlUsage,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Re-exported for backward compatibility
  validateNEXTUsage,
  validateDEFERUsage,
} from './helpers.js';
export type { ParsedStepHeader, ParsedSubstepHeader } from './helpers.js';
export {
  parseStepIdFromString,
  stepIdToString,
  stepIdEquals,
  RESERVED_WORDS,
  isReservedWord,
  NAMED_IDENTIFIER_PATTERN,
} from './step-id.js';
export type { ParseStepIdOptions } from './step-id.js';
export {
  extractFrontmatter,
  nameFromFilename,
  RunbookFrontmatterSchema,
} from './frontmatter.js';
export type {
  RunbookFrontmatter,
  RunbookFrontmatterType,
} from './frontmatter.js';
export {
  hasPrompt,
  hasCommand,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- backward-compatible re-export
  hasSubsteps,
  hasRunbooks,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- backward-compatible re-export
  hasForClause,
  isSourced,
  isBaseStep,
  isStepWithCommand,
  isStepWithSubsteps,
  isStepWithFor,
  stepHasSubsteps,
} from './guards.js';
