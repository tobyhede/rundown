import {
  RunbookSyntaxError,
  type ParsedConditional,
  type AggregationModifier,
} from './types.js';
import {
  type Action,
  type Transitions,
} from './schemas.js';
import { MAX_STEP_NUMBER } from './schemas.js';
import { parseStepIdFromString, isReservedWord, NAMED_IDENTIFIER_PATTERN } from './step-id.js';
import type { ForClause } from './ast.js';

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
  /** Substep identifier: numeric string or named identifier */
  id: string;
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
 * - "ErrorHandler Description" (named)
 */
export interface ParsedStepHeader {
  /** Step identifier: numeric string like "1" or named identifier */
  name: string;
  /** Human-readable description from the header */
  description: string;
}

/**
 * Extract step number/name and description from H2 header text.
 *
 * Parses step headers in these formats:
 * - Numeric: "1. Description" or "1 Description"
 * - Named: "ErrorHandler Description" or just "ErrorHandler"
 *
 * @param text - The raw H2 header text (without the ## prefix)
 * @returns Parsed header data, or null if text is not a valid step header
 */
export function extractStepHeader(text: string): ParsedStepHeader | null {
  const trimmed = text.trim();

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

    return { name: numberStr, description };
  }

  // Check for named step: Name or Name Description
  const words = trimmed.split(/\s+/);
  const firstName = words[0];

  // Strip trailing separator characters (like '.', ':', etc.) from the name
  const strippedName = firstName.replace(/[.:—→\-)]+$/, '');

  if (!strippedName || !NAMED_IDENTIFIER_PATTERN.test(strippedName)) return null;
  if (isReservedWord(strippedName)) return null;

  const restWords = words.slice(1);
  const description = restWords.length > 0 ? restWords.join(' ') : strippedName;

  return { name: strippedName, description };
}

/**
 * Check if a string is a valid step reference.
 *
 * Valid step references:
 * - Positive integer: "1", "2", "99"
 * - Named identifier: "Setup", "my_step" (not a reserved word)
 *
 * @param s - The string to validate as a step reference
 * @returns True if the string is a valid step reference, false otherwise
 */
function isValidStepRef(s: string): boolean {
  if (/^\d+$/.test(s)) return parseInt(s, 10) > 0;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return !isReservedWord(s);
  return false;
}

/**
 * Check if a string is a valid substep identifier.
 *
 * Valid substep identifiers:
 * - Positive integer: "1", "2", "99"
 * - Named identifier: "Setup", "my_substep" (not a reserved word)
 *
 * @param s - The string to validate as a substep identifier
 * @returns True if the string is a valid substep identifier, false otherwise
 */
function isValidSubstepId(s: string): boolean {
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
  };
}

/**
 * Parse a FOR loop clause from bullet text.
 *
 * Recognizes these grammar variants:
 * - `FOR variable IN start TO end` (full form)
 * - `FOR start TO end` (unnamed, range)
 * - `FOR variable IN count` (named, count only — start defaults to 1)
 * - `FOR count` (unnamed, count only — start defaults to 1)
 *
 * Bounds must be positive integers. Unresolved template variables (e.g., `{{Count}}`)
 * cause the clause to be rejected (returns null).
 *
 * @param text - The bullet text (after `- ` prefix), e.g. "FOR batch IN 1 TO 10"
 * @returns Parsed ForClause, or null if text is not a valid FOR clause
 */
export function parseForClause(text: string): ForClause | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('FOR ')) return null;

  const rest = trimmed.slice(4).trim();
  if (!rest) return null;

  // Try to parse a bound value (positive integer only)
  const parseBound = (s: string): number | null => {
    const num = parseInt(s, 10);
    if (!isNaN(num) && String(num) === s && num > 0) return num;
    return null;
  };

  // Pattern 1: FOR variable IN start TO end
  // Pattern 2: FOR variable IN count (start defaults to 1)
  const namedMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s+IN\s+(.+)$/.exec(rest);
  if (namedMatch) {
    const variable = namedMatch[1];
    const rangeStr = namedMatch[2].trim();

    // Try "start TO end"
    const toMatch = /^(\S+)\s+TO\s+(\S+)$/.exec(rangeStr);
    if (toMatch) {
      const start = parseBound(toMatch[1]);
      const end = parseBound(toMatch[2]);
      if (start !== null && end !== null) {
        return { variable, start, end };
      }
      return null;
    }

    // Try single count value
    const end = parseBound(rangeStr);
    if (end !== null) {
      return { variable, start: 1, end };
    }
    return null;
  }

  // Pattern 3: FOR start TO end (unnamed)
  const rangeMatch = /^(\S+)\s+TO\s+(\S+)$/.exec(rest);
  if (rangeMatch) {
    const start = parseBound(rangeMatch[1]);
    const end = parseBound(rangeMatch[2]);
    if (start !== null && end !== null) {
      return { start, end };
    }
    return null;
  }

  // Pattern 4: FOR count (unnamed, count only)
  const end = parseBound(rest);
  if (end !== null) {
    return { start: 1, end };
  }

  return null;
}

/**
 * Parse an action string into an Action object.
 *
 * Recognizes these action formats:
 * - CONTINUE - Proceed to next step
 * - COMPLETE / COMPLETE "message" - Mark runbook complete
 * - STOP / STOP "message" - Abort runbook
 * - GOTO target - Jump to specified step/substep
 * - NEXT - First-class action for FOR loops (advance to next iteration)
 * - BREAK - First-class action for FOR loops (exit loop)
 *
 * @param text - The action string to parse (e.g., "GOTO 2.1", "CONTINUE")
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

  if (trimmed.startsWith('GOTO ')) {
    const targetStr = trimmed.slice(5).trim();
    const target = parseStepIdFromString(targetStr);
    if (!target) {
      return null;
    }
    return { type: 'GOTO', target };
  }

  if (trimmed === 'NEXT') {
    return { type: 'NEXT' };
  }

  if (trimmed === 'BREAK') {
    return { type: 'BREAK' };
  }

  return null;
}

/**
 * Parse RETRY syntax and extract retry count with fallback action.
 * Internal helper for parsing conditional strings with RETRY.
 *
 * @param rest - The string after "RETRY" keyword
 * @returns Object with retry count and fallback action, or null if invalid
 */
function parseRetryWithArgs(rest: string): { retry: number; action: Action } | null {
  let retry = 1;
  let remaining = rest;

  const numberMatch = /^(\d+)(?:\s+(.*))?$/.exec(remaining);
  if (numberMatch) {
    retry = parseInt(numberMatch[1], 10);
    remaining = (numberMatch[2] || '').trim();
  }

  if (!remaining) {
    return { retry, action: { type: 'STOP' } };
  }

  if (remaining.startsWith('"') && remaining.endsWith('"')) {
    const message = remaining.slice(1, -1);
    return { retry, action: { type: 'STOP', message } };
  }

  const action = parseAction(remaining);
  if (!action) {
    return null;
  }

  return { retry, action };
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

  // Try to parse as RETRY first
  let retry = 0;
  let action: Action | null = null;

  if (actionStr.startsWith('RETRY')) {
    if (actionStr === 'RETRY') {
      retry = 1;
      action = { type: 'STOP' };
    } else if (actionStr.startsWith('RETRY ')) {
      const retryResult = parseRetryWithArgs(actionStr.slice(6).trim());
      if (retryResult) {
        retry = retryResult.retry;
        action = retryResult.action;
      }
    }
  } else {
    action = parseAction(actionStr);
  }

  if (!action) {
    return null;
  }

  return { type, retry, action, modifier, raw: actionStr };
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
 * @throws {RunbookSyntaxError} If the line starts with PASS/FAIL/YES/NO but has invalid action
 */
export function parseConditional(text: string): ParsedConditional | null {
  const trimmed = text.trim();

  if (trimmed.startsWith('PASS')) {
    const result = parseConditionalPrefix(trimmed.slice(4), 'pass');
    if (!result) {
      throw new RunbookSyntaxError(`Invalid PASS transition: ${trimmed}`);
    }
    return result;
  }

  if (trimmed.startsWith('YES')) {
    const result = parseConditionalPrefix(trimmed.slice(3), 'yes');
    if (!result) {
      throw new RunbookSyntaxError(`Invalid YES transition: ${trimmed}`);
    }
    return result;
  }

  if (trimmed.startsWith('FAIL')) {
    const result = parseConditionalPrefix(trimmed.slice(4), 'fail');
    if (!result) {
      throw new RunbookSyntaxError(`Invalid FAIL transition: ${trimmed}`);
    }
    return result;
  }

  if (trimmed.startsWith('NO')) {
    const result = parseConditionalPrefix(trimmed.slice(2), 'no');
    if (!result) {
      throw new RunbookSyntaxError(`Invalid NO transition: ${trimmed}`);
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
    throw new RunbookSyntaxError(
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
 * Validate that first-class NEXT/BREAK are only used in FOR contexts.
 *
 * The first-class `NEXT` and `BREAK` actions are for FOR loop control flow
 * and are only valid within substeps of a FOR step.
 *
 * @param conditionals - Array of parsed conditionals to check for NEXT/BREAK usage
 * @param isForContext - Whether the current context is within a FOR step
 * @throws {RunbookSyntaxError} When NEXT/BREAK used outside FOR context
 */
export function validateNEXTUsage(
  conditionals: ParsedConditional[],
  isForContext: boolean
): void {
  for (const conditional of conditionals) {
    // Check first-class NEXT/BREAK — requires FOR context
    if (conditional.action.type === 'NEXT' || conditional.action.type === 'BREAK') {
      if (!isForContext) {
        throw new RunbookSyntaxError(
          `${conditional.action.type} is only valid within substeps of a FOR step`
        );
      }
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
  let passRetry = 0;
  let failAction: Action | null = null;
  let failRetry = 0;
  let passModifier: AggregationModifier = null;
  let failModifier: AggregationModifier = null;
  let passKind: 'pass' | 'yes' = 'pass';
  let failKind: 'fail' | 'no' = 'fail';

  for (const conditional of conditionals) {
    // 'pass' and 'yes' are equivalent (success conditions)
    // 'fail' and 'no' are equivalent (failure conditions)
    if (conditional.type === 'pass' || conditional.type === 'yes') {
      passAction = conditional.action;
      passRetry = conditional.retry;
      passModifier = conditional.modifier;
      passKind = conditional.type;
    } else {
      failAction = conditional.action;
      failRetry = conditional.retry;
      failModifier = conditional.modifier;
      failKind = conditional.type;
    }
  }

  const all = resolveAggregationMode(passModifier, failModifier);

  if (passAction && failAction) {
    return {
      all,
      pass: { kind: passKind, retry: passRetry, action: passAction },
      fail: { kind: failKind, retry: failRetry, action: failAction },
    };
  }

  if (passAction && !failAction) {
    return {
      all,
      pass: { kind: passKind, retry: passRetry, action: passAction },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    };
  }

  if (!passAction && failAction) {
    return {
      all,
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: failKind, retry: failRetry, action: failAction },
    };
  }

  return null;
}

/**
 * Extract runbook references from step/substep content.
 *
 * Scans content for list items referencing runbook files (*.runbook.md)
 * and returns an array of the referenced filenames.
 *
 * @param content - The raw content text to scan for runbook references
 * @returns Array of runbook filenames (e.g., ["setup.runbook.md", "cleanup.runbook.md"])
 */
export function extractRunbookList(content: string): string[] {
  const runbooks: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const match = /^\s*-\s+(\S+\.runbook\.md)\s*$/.exec(line);
    if (match) {
      runbooks.push(match[1]);
    }
  }

  return runbooks;
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
 * @returns String representation of the action (e.g., "GOTO 2", "COMPLETE", "STOP \"message\"")
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
    case 'NEXT':
      return 'NEXT';
    case 'BREAK':
      return 'BREAK';
    default:
      return 'UNKNOWN';
  }
}
