export { parseRunbook, parseRunbookDocument, formatLineNum } from './parser.js';
export {
  validateRunbook,
  validateAction,
} from './validator.js';
// eslint-disable-next-line @typescript-eslint/no-deprecated -- backward-compatible re-export
export type { ValidationError, ValidationDiagnostic } from './validator.js';
export { RunbookSyntaxError, MAX_STEP_NUMBER } from './types.js';
export type { ParsedConditional, ParseConditionalResult, AggregationModifier } from './types.js';
export type { ParseResult } from './ast.js';
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
  isRunbookListLine,
  isExecutableCodeBlock,
  isPromptCodeBlock,
  escapeForShellSingleQuote,
  parseQuotedOrIdentifier,
  validateLoopControlUsage,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Re-exported for backward compatibility
  validateNEXTUsage,
  validateDEFERUsage,
  isAccumulatingAction,
  isBreakAction,
  isLoopControlAction,
  isStepExitAction,
  isTerminalAction,
  parseOutputDeclaration,
  parseStepOutputDeclaration,
  parseFrontmatterOutputDeclaration,
  parseArtifactDeclaration,
} from './helpers.js';
export type { ConvertedTransitions, ParsedStepHeader, ParsedSubstepHeader } from './helpers.js';
export {
  classifyRawArtifactToken,
  classifyExpandedArtifactToken,
  formatArtifactTokenRejectReason,
} from './artifact-token.js';
export type {
  ArtifactTokenRejectReason,
  ParsedArtifactToken,
  ArtifactTokenClassificationResult,
} from './artifact-token.js';
export {
  parseStepIdFromString,
  stepIdToString,
  stepIdEquals,
  RESERVED_WORDS,
  isReservedWord,
  NAMED_IDENTIFIER_PATTERN,
} from './step-id.js';
export {
  IDENTITY_OWNED_BUILTINS,
  RESERVED_TEMPLATE_NAMES,
  isReservedTemplateName,
  BUILTIN_TEMPLATE_HELPER_NAMES,
  BUILTIN_TEMPLATE_HELPER_NAME_SET,
  isBuiltinTemplateHelperName,
} from './reserved.js';
export type { BuiltinTemplateHelperName } from './reserved.js';
export {
  TEMPLATE_IDENTIFIER_PATTERN,
  TEMPLATE_PATH_PATTERN,
  isTemplatePath,
  isBuiltinName,
  tokenizeTemplate,
  parseTemplateExpression,
} from './template.js';
export type {
  BuiltinName,
  ParseTemplateExpressionResult,
  TemplateArg,
  TemplateExpression,
  TemplateExpressionRejectReason,
  TemplateNode,
  TemplateToken,
} from './template.js';
export { parseOutputExpression } from './output-expression.js';
export type {
  OutputArtifactHelperName,
  OutputExpression,
  OutputExpressionRejectReason,
  ParseOutputExpressionResult,
} from './output-expression.js';
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
  isWindowed,
  isBaseStep,
  isStepWithCommand,
  isStepWithSubsteps,
  isStepWithFor,
  stepHasSubsteps,
  isBoundRef,
  isRunbookRef,
  hasUnresolvedRunbooks,
  isUnresolvedForClause,
  isResolvedForClause,
  isResolvedStep,
  resolvedStepHasSubsteps,
  isPromptedForStep,
  areAllStepsResolved,
} from './guards.js';
