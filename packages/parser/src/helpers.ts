import {
  WorkflowSyntaxError,
  type ParsedConditional,
  type AggregationModifier,
} from './types.js';
import {
  type Action,
  type NonRetryAction,
  type Transitions
} from './schemas.js';
import { MAX_STEP_NUMBER } from './schemas.js';
import { parseStepIdFromString, isReservedWord, NAMED_IDENTIFIER_PATTERN } from './step-id.js';

/**
 * Parse a quoted string or single-word identifier.
 *
 * Used for STOP and COMPLETE messages ONLY.
 * NOT used for GOTO targets (GOTO uses parseStepIdFromString which accepts identifiers directly).
 *
 * Valid formats:
 * - Single word identifier: /^[A-Za-z_][A-Za-z0-9_]*$/
 * - Quoted string: "any text here"
 *
 * @param text - The text to parse, either a quoted string or identifier
 * @returns The extracted string content (quotes removed if present)
 * @throws {Error} If the format is invalid (unclosed quote or invalid identifier)
 */
export function parseQuotedOrIdentifier(text: string): string {
  const trimmed = text.trim();

  if (!trimmed) {
    throw new Error('Empty string is not a valid identifier or quoted string');
  }

  // Check for quoted string
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }

  // Check for unclosed quote
  if (trimmed.startsWith('"') || trimmed.endsWith('"')) {
    throw new Error(`Unclosed quote in: "${trimmed}"`);
  }

  // Check for valid identifier
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    return trimmed;
  }

  throw new Error(
    `Invalid format: "${trimmed}". Use a single-word identifier (letters, numbers, underscore) or a quoted string.`
  );
}

/**
 * Parsed result from an H3 substep header.
 *
 * Represents the structured data extracted from substep headers like:
 * - "1.2 Description" (numeric)
 * - "{N}.1 Description" (dynamic step, static substep)
 * - "ErrorHandler.Recover Description (agent)" (named with agent type)
 */
export interface ParsedSubstepHeader {
  /** Reference to parent step: "1", "{N}", or named identifier like "ErrorHandler" */
  stepRef: string;
  /** Substep identifier: numeric string, "{n}" for dynamic, or named identifier */
  id: string;
  /** True if substep uses dynamic placeholder {n} */
  isDynamic: boolean;
  /** Human-readable description from the header */
  description: string;
  /** Optional agent type specified in parentheses at end of header */
  agentType?: string;
}

/**
 * Strip common separators and whitespace from the beginning of text.
 *
 * Removes leading punctuation (periods, colons, dashes, arrows, parentheses)
 * and whitespace that commonly separate step numbers from descriptions.
 *
 * @param text - The text to strip separators from
 * @returns The text with leading separators and whitespace removed
 */
export function stripSeparator(text: string): string {
  return text.replace(/^[.:—→\-)\s]+/, '').trim();
}

/**
 * Parsed result from an H2 step header.
 *
 * Represents the structured data extracted from step headers like:
 * - "1. Description" (numeric)
 * - "{N}. Description" (dynamic)
 * - "ErrorHandler Description" (named)
 */
export interface ParsedStepHeader {
  /** Step identifier: numeric string like "1", dynamic "{N}", or named identifier */
  name: string;
  /** True if step uses dynamic placeholder {N} */
  isDynamic: boolean;
  /** Human-readable description from the header */
  description: string;
}

/**
 * Extract step number/name and description from H2 header text.
 *
 * Parses step headers in these formats:
 * - Numeric: "1. Description" or "1 Description"
 * - Dynamic: "{N}. Description" or "{N} Description"
 * - Named: "ErrorHandler Description" or just "ErrorHandler"
 *
 * @param text - The raw H2 header text (without the ## prefix)
 * @returns Parsed header data, or null if text is not a valid step header
 */
export function extractStepHeader(text: string): ParsedStepHeader | null {
  const trimmed = text.trim();

  // Check for dynamic step: {N} Description
  if (trimmed.startsWith('{N}')) {
    const rest = trimmed.slice(3);
    const description = stripSeparator(rest);
    if (!description) return null;
    return { name: '{N}', isDynamic: true, description };
  }

  // Check for numeric step: 1 Description
  let numEnd = 0;
  while (numEnd < trimmed.length && /\d/.test(trimmed[numEnd])) {
    numEnd++;
  }

  if (numEnd > 0) {
    const numberStr = trimmed.slice(0, numEnd);
    const number = parseInt(numberStr, 10);
    if (number <= 0 || number > MAX_STEP_NUMBER) return null;

    const description = stripSeparator(trimmed.slice(numEnd));
    if (!description) return null;

    return { name: numberStr, isDynamic: false, description };
  }

  // Check for named step: Name or Name Description
  const words = trimmed.split(/\s+/);
  const firstName = words[0];

  if (!firstName || !NAMED_IDENTIFIER_PATTERN.test(firstName)) return null;
  if (isReservedWord(firstName)) return null;

  const restWords = words.slice(1);
  const description = restWords.length > 0 ? restWords.join(' ') : firstName;

  return { name: firstName, isDynamic: false, description };
}

/**
 * Check if a string is a valid step reference.
 *
 * Valid step references:
 * - Positive integer: "1", "2", "99"
 * - Dynamic placeholder: "{N}"
 * - Named identifier: "Setup", "my_step" (not a reserved word)
 */
function isValidStepRef(s: string): boolean {
  if (s === '{N}') return true;
  if (/^\d+$/.test(s)) return parseInt(s, 10) > 0;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return !isReservedWord(s);
  return false;
}

/**
 * Check if a string is a valid substep identifier.
 *
 * Valid substep identifiers:
 * - Positive integer: "1", "2", "99"
 * - Dynamic placeholder: "{n}"
 * - Named identifier: "Setup", "my_substep" (not a reserved word)
 */
function isValidSubstepId(s: string): boolean {
  if (s === '{n}') return true;
  if (/^\d+$/.test(s)) return parseInt(s, 10) > 0;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return !isReservedWord(s);
  return false;
}

/**
 * Extract substep header from H3 text.
 *
 * Parses substep headers in these formats:
 * - Numeric: "1.2" or "1.2 Description"
 * - Dynamic: "{N}.1", "1.{n}", "{N}.{n}" (with optional description)
 * - Named: "1.Cleanup", "ErrorHandler.Recover" (with optional description)
 * - With agent: "1.2 Description (agent-type)" or "1.2 (agent-type)"
 *
 * Description is optional per spec.
 *
 * @param text - The raw H3 header text (without the ### prefix)
 * @returns Parsed substep header data, or null if text is not a valid substep header
 */
export function extractSubstepHeader(text: string): ParsedSubstepHeader | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Find the dot separating step reference from substep ID
  const dotIndex = trimmed.indexOf('.');
  if (dotIndex === -1 || dotIndex === 0) return null;

  const stepPart = trimmed.slice(0, dotIndex);
  if (!isValidStepRef(stepPart)) return null;

  const afterDot = trimmed.slice(dotIndex + 1);
  if (!afterDot) return null;

  // Find where substep ID ends (first space or end of string)
  const spaceIndex = afterDot.indexOf(' ');
  const substepId = spaceIndex === -1 ? afterDot : afterDot.slice(0, spaceIndex);
  if (!isValidSubstepId(substepId)) return null;

  // Parse optional description and agent from remainder
  let description: string | undefined;
  let agentType: string | undefined;

  if (spaceIndex !== -1) {
    const remainder = afterDot.slice(spaceIndex + 1).trim();
    if (remainder) {
      // Check for agent suffix: "description (agent-type)"
      const agentMatch = /^(.+?)\s+\(([^)]+)\)$/.exec(remainder);
      if (agentMatch) {
        description = agentMatch[1].trim() || undefined;
        agentType = agentMatch[2].trim();
      } else if (remainder.startsWith('(') && remainder.endsWith(')')) {
        // Just agent, no description: "(agent-type)"
        agentType = remainder.slice(1, -1).trim();
      } else {
        description = remainder;
      }
    }
  }

  return {
    stepRef: stepPart,
    id: substepId,
    description: description ?? '',
    agentType,
    isDynamic: substepId === '{n}',
  };
}

/**
 * Parse an action string into an Action object.
 *
 * Recognizes these action formats:
 * - CONTINUE - Proceed to next step
 * - COMPLETE / COMPLETE "message" - Mark workflow complete
 * - STOP / STOP "message" - Abort workflow
 * - GOTO target - Jump to specified step/substep
 * - NEXT - Shorthand for GOTO NEXT (dynamic steps only)
 * - RETRY / RETRY n / RETRY n action - Retry with optional max count and fallback
 *
 * @param text - The action string to parse (e.g., "GOTO 2.1", "RETRY 3 STOP")
 * @returns Parsed Action object, or null if text is not a recognized action
 */
export function parseAction(text: string): Action | null {
  const trimmed = text.trim();

  if (trimmed === 'CONTINUE') {
    return { type: 'CONTINUE' };
  }

  if (trimmed === 'COMPLETE') {
    return { type: 'COMPLETE' };
  }

  if (trimmed.startsWith('COMPLETE ')) {
    try {
      const message = parseQuotedOrIdentifier(trimmed.slice(9));
      return { type: 'COMPLETE', message };
    } catch {
      return null;
    }
  }

  if (trimmed === 'STOP') {
    return { type: 'STOP' };
  }

  if (trimmed.startsWith('STOP ')) {
    try {
      const message = parseQuotedOrIdentifier(trimmed.slice(5));
      return { type: 'STOP', message };
    } catch {
      return null;
    }
  }

  // Handle GOTO NEXT <target> (qualified NEXT)
  if (trimmed.startsWith('GOTO NEXT ')) {
    const targetStr = trimmed.slice(10).trim();
    if (targetStr) {
      const qualifier = parseStepIdFromString(targetStr);
      if (qualifier) {
        return { type: 'GOTO', target: { step: 'NEXT' as const, qualifier } };
      }
    }
    // Fall through to bare GOTO NEXT handling
  }

  if (trimmed.startsWith('GOTO ')) {
    const targetStr = trimmed.slice(5).trim();
    const target = parseStepIdFromString(targetStr);
    if (!target) {
      return null;
    }
    return { type: 'GOTO', target };
  }

  if (trimmed === 'NEXT') {
    return { type: 'GOTO', target: { step: 'NEXT' as const } };
  }

  if (trimmed === 'RETRY') {
    return { type: 'RETRY', max: 1, then: { type: 'STOP' } };
  }

  if (trimmed.startsWith('RETRY ')) {
    const rest = trimmed.slice(6).trim();
    return parseRetryWithArgs(rest);
  }

  return null;
}

function parseRetryWithArgs(rest: string): Action | null {
  let max = 1;
  let remaining = rest;

  const numberMatch = /^(\d+)(?:\s+(.*))?$/.exec(remaining);
  if (numberMatch) {
    max = parseInt(numberMatch[1], 10);
    remaining = (numberMatch[2] || '').trim();
  }

  if (!remaining) {
    return { type: 'RETRY', max, then: { type: 'STOP' } };
  }

  if (remaining.startsWith('"') && remaining.endsWith('"')) {
    const message = remaining.slice(1, -1);
    return { type: 'RETRY', max, then: { type: 'STOP', message } };
  }

  const thenAction = parseNonRetryAction(remaining);
  if (!thenAction) {
    return null;
  }

  return { type: 'RETRY', max, then: thenAction };
}

function parseNonRetryAction(input: string): NonRetryAction | null {
  const trimmed = input.trim();

  if (trimmed.startsWith('RETRY')) {
    throw new WorkflowSyntaxError('Recursion error: RETRY actions cannot contain another RETRY (Rule 5)');
  }

  if (trimmed === 'CONTINUE') {
    return { type: 'CONTINUE' };
  }

  if (trimmed === 'COMPLETE') {
    return { type: 'COMPLETE' };
  }

  if (trimmed.startsWith('COMPLETE ')) {
    try {
      const message = parseQuotedOrIdentifier(trimmed.slice(9));
      return { type: 'COMPLETE', message };
    } catch {
      return null;
    }
  }

  if (trimmed === 'STOP') {
    return { type: 'STOP' };
  }

  if (trimmed.startsWith('STOP ')) {
    try {
      const message = parseQuotedOrIdentifier(trimmed.slice(5));
      return { type: 'STOP', message };
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith('GOTO ')) {
    const targetStr = trimmed.slice(5).trim();
    const target = parseStepIdFromString(targetStr);
    if (!target) {
      return null;
    }
    return { type: 'GOTO', target };
  }

  return null;
}

function parseConditionalPrefix(rest: string, type: 'pass' | 'fail' | 'yes' | 'no'): ParsedConditional | null {
  let modifier: AggregationModifier = null;
  let remaining = rest;

  const modifierMatch = /^\s+(ALL|ANY)[\s:→-]/.exec(remaining);
  if (modifierMatch) {
    modifier = modifierMatch[1] as 'ALL' | 'ANY';
    remaining = remaining.slice(modifierMatch[0].length);
  }

  const actionStr = stripSeparator(remaining);
  const action = parseAction(actionStr);
  if (!action) {
    return null;
  }
  return { type, action, modifier, raw: actionStr };
}

/**
 * Parse a conditional transition line into a ParsedConditional object.
 *
 * Recognizes these formats:
 * - PASS/YES: triggers on step success (e.g., "PASS: CONTINUE", "YES → GOTO 2")
 * - FAIL/NO: triggers on step failure (e.g., "FAIL: STOP", "NO → RETRY 3")
 * - With aggregation: "PASS ALL: CONTINUE", "FAIL ANY: STOP"
 *
 * @param text - The conditional line to parse
 * @returns Parsed conditional with type, action, and optional modifier, or null if not a conditional
 * @throws {WorkflowSyntaxError} If the line starts with PASS/FAIL/YES/NO but has invalid action
 */
export function parseConditional(text: string): ParsedConditional | null {
  const trimmed = text.trim();

  if (trimmed.startsWith('PASS')) {
    const result = parseConditionalPrefix(trimmed.slice(4), 'pass');
    if (!result) {
      throw new WorkflowSyntaxError(`Invalid PASS transition: ${trimmed}`);
    }
    return result;
  }

  if (trimmed.startsWith('YES')) {
    const result = parseConditionalPrefix(trimmed.slice(3), 'yes');
    if (!result) {
      throw new WorkflowSyntaxError(`Invalid YES transition: ${trimmed}`);
    }
    return result;
  }

  if (trimmed.startsWith('FAIL')) {
    const result = parseConditionalPrefix(trimmed.slice(4), 'fail');
    if (!result) {
      throw new WorkflowSyntaxError(`Invalid FAIL transition: ${trimmed}`);
    }
    return result;
  }

  if (trimmed.startsWith('NO')) {
    const result = parseConditionalPrefix(trimmed.slice(2), 'no');
    if (!result) {
      throw new WorkflowSyntaxError(`Invalid NO transition: ${trimmed}`);
    }
    return result;
  }

  return null;
}

function resolveAggregationMode(
  passModifier: AggregationModifier,
  failModifier: AggregationModifier
): boolean {
  if (passModifier && failModifier) {
    if (passModifier === 'ALL' && failModifier === 'ANY') return true;
    if (passModifier === 'ANY' && failModifier === 'ALL') return false;
    throw new WorkflowSyntaxError(
      `Invalid aggregation combination: PASS ${passModifier} + FAIL ${failModifier}. ` +
        `Valid: PASS ALL + FAIL ANY (pessimistic) or PASS ANY + FAIL ALL (optimistic)`
    );
  }

  if (passModifier === 'ALL') return true;
  if (passModifier === 'ANY') return false;
  if (failModifier === 'ANY') return true;
  if (failModifier === 'ALL') return false;

  return true;
}

/**
 * Check if an action contains a NEXT target
 */
function containsNEXT(action: Action | NonRetryAction): boolean {
  if (action.type === 'GOTO' && 'target' in action) {
    // GOTO NEXT without a qualifier is a bare NEXT action
    // GOTO NEXT <target> (with qualifier) is allowed everywhere
    return action.target.step === 'NEXT' && !action.target.qualifier;
  }
  if (action.type === 'RETRY' && 'then' in action) {
    return containsNEXT(action.then);
  }
  return false;
}

/**
 * Validate that NEXT is only used in dynamic contexts.
 *
 * The NEXT action is a shorthand for advancing to the next dynamic instance.
 * It is valid within dynamic step templates (steps with {N} prefix) OR
 * within dynamic substeps (substeps with {n} suffix).
 *
 * @param conditionals - Array of parsed conditionals to check for NEXT usage
 * @param isDynamicStep - Whether the current step uses dynamic {N} prefix
 * @param isDynamicSubstep - Whether the current substep uses dynamic {n} suffix
 * @throws {WorkflowSyntaxError} When NEXT is used outside a dynamic context
 */
export function validateNEXTUsage(
  conditionals: ParsedConditional[],
  isDynamicStep: boolean,
  isDynamicSubstep: boolean = false
): void {
  if (isDynamicStep || isDynamicSubstep) {
    // NEXT is allowed in dynamic steps or dynamic substeps
    return;
  }

  for (const conditional of conditionals) {
    if (containsNEXT(conditional.action)) {
      throw new WorkflowSyntaxError(
        `NEXT action is only allowed in dynamic contexts (steps with {N} prefix or substeps with {n} suffix)`
      );
    }
  }
}

/**
 * Convert an array of parsed conditionals into a Transitions object.
 *
 * Combines PASS and FAIL conditionals into a unified Transitions structure,
 * resolving aggregation mode (ALL vs ANY) and providing defaults for
 * missing conditions (PASS defaults to CONTINUE, FAIL defaults to STOP).
 *
 * @param conditionals - Array of parsed conditional objects from parseConditional
 * @returns Transitions object with pass/fail handlers, or null if no conditionals provided
 */
export function convertToTransitions(conditionals: ParsedConditional[]): Transitions | null {
  if (conditionals.length === 0) {
    return null;
  }

  let passAction: Action | null = null;
  let failAction: Action | null = null;
  let passModifier: AggregationModifier = null;
  let failModifier: AggregationModifier = null;
  let passKind: 'pass' | 'yes' = 'pass';
  let failKind: 'fail' | 'no' = 'fail';

  for (const conditional of conditionals) {
    // 'pass' and 'yes' are equivalent (success conditions)
    // 'fail' and 'no' are equivalent (failure conditions)
    if (conditional.type === 'pass' || conditional.type === 'yes') {
      passAction = conditional.action;
      passModifier = conditional.modifier;
      passKind = conditional.type;
    } else {
      failAction = conditional.action;
      failModifier = conditional.modifier;
      failKind = conditional.type;
    }
  }

  const all = resolveAggregationMode(passModifier, failModifier);

  if (passAction && failAction) {
    return {
      all,
      pass: { kind: passKind, action: passAction },
      fail: { kind: failKind, action: failAction },
    };
  }

  if (passAction && !failAction) {
    return {
      all,
      pass: { kind: passKind, action: passAction },
      fail: { kind: 'fail', action: { type: 'STOP' } },
    };
  }

  if (!passAction && failAction) {
    return {
      all,
      pass: { kind: 'pass', action: { type: 'CONTINUE' } },
      fail: { kind: failKind, action: failAction },
    };
  }

  return null;
}

/**
 * Extract workflow references from step/substep content.
 *
 * Scans content for list items referencing runbook files (*.runbook.md)
 * and returns an array of the referenced filenames.
 *
 * @param content - The raw content text to scan for workflow references
 * @returns Array of runbook filenames (e.g., ["setup.runbook.md", "cleanup.runbook.md"])
 */
export function extractWorkflowList(content: string): string[] {
  const workflows: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const match = /^\s*-\s+(\S+\.runbook\.md)\s*$/.exec(line);
    if (match) {
      workflows.push(match[1]);
    }
  }

  return workflows;
}

const EXECUTABLE_TAGS = ['bash', 'sh', 'shell'];

/**
 * Check if a code block language tag indicates an executable block.
 *
 * Executable blocks (bash, sh, shell) are run as shell commands.
 *
 * @param lang - The code block language tag (e.g., "bash", "sh runme")
 * @returns True if the block should be executed as a shell command
 */
export function isExecutableCodeBlock(lang: string | null | undefined): boolean {
  if (!lang) return false;
  const parts = lang.split(/\s+/);
  const tag = parts[0]?.toLowerCase();
  if (!tag) return false;
  return EXECUTABLE_TAGS.includes(tag);
}

/**
 * Check if a code block language tag indicates a prompt block.
 *
 * Prompt blocks contain text to be displayed or sent to an agent.
 *
 * @param lang - The code block language tag
 * @returns True if "prompt", false if executable (bash/sh/shell), null for other/unknown types
 */
export function isPromptCodeBlock(lang: string | null | undefined): boolean | null {
  if (!lang) return null;
  const trimmed = lang.trim();
  if (!trimmed) return null;
  const tag = trimmed.split(/\s+/)[0]?.toLowerCase();
  if (tag === 'prompt') return true;
  if (EXECUTABLE_TAGS.includes(tag)) return false;
  return null;
}

/**
 * Escape content for use inside a shell single-quoted string.
 *
 * Single quotes in the content are escaped using the '\'' technique
 * (end quote, escaped quote, start quote).
 *
 * @param content - The raw string content to escape
 * @returns Escaped string safe for embedding in single quotes
 */
export function escapeForShellSingleQuote(content: string): string {
  // In single quotes, escape single quotes as: '\''
  return content.replace(/'/g, "'\\''");
}

/**
 * Format an Action object back into its string representation.
 *
 * Converts parsed Action objects into human-readable action strings
 * suitable for display or logging.
 *
 * @param action - The Action object to format
 * @returns String representation of the action (e.g., "GOTO 2", "RETRY 3", "COMPLETE", "STOP \"message\"")
 */
export function formatAction(action: Action): string {
  switch (action.type) {
    case 'CONTINUE':
      return 'CONTINUE';
    case 'COMPLETE':
      return action.message ? `COMPLETE "${action.message}"` : 'COMPLETE';
    case 'STOP':
      return action.message ? `STOP "${action.message}"` : 'STOP';
    case 'GOTO':
      return `GOTO ${action.target.step}`;
    case 'RETRY':
      return action.max ? `RETRY ${String(action.max)}` : 'RETRY';
    default:
      return 'UNKNOWN';
  }
}
