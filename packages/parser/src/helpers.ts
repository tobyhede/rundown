import {
  RunbookSyntaxError,
  type ParsedConditional,
  type ParseConditionalResult,
  type AggregationModifier,
} from './types.js';
import type {
  Action,
  AccumulatingAction,
  Aggregation,
  BreakAction,
  LoopControlAction,
  StepExitAction,
  TerminalAction,
  Transitions,
} from './schemas.js';
import { MAX_STEP_NUMBER, MAX_FOR_BOUND } from './schemas.js';
import {
  parseStepIdFromString,
  stepIdToString,
  isReservedWord,
  NAMED_IDENTIFIER_PATTERN,
} from './step-id.js';
import type { ParsedForClause, Bound } from './ast.js';
import { isBoundRef } from './guards.js';

/**
 * Check if an action accumulates results into parent aggregation (DEFER only).
 *
 * @param action - The action to check
 * @returns True if the action is an AccumulatingAction
 */
export function isAccumulatingAction(action: Action): action is AccumulatingAction {
  return action.type === 'DEFER';
}

/**
 * Check if an action is a FOR loop flow control action (NEXT or BREAK).
 *
 * @param action - The action to check
 * @returns True if the action is a LoopControlAction
 */
export function isLoopControlAction(action: Action): action is LoopControlAction {
  return action.type === 'NEXT' || action.type === 'BREAK';
}

/**
 * Check if an action is a step-exit action (CONTINUE only).
 *
 * @param action - The action to check
 * @returns True if the action is a StepExitAction
 */
export function isStepExitAction(action: Action): action is StepExitAction {
  return action.type === 'CONTINUE';
}

/**
 * Check if an action is a terminal action (STOP, COMPLETE, or GOTO).
 *
 * @param action - The action to check
 * @returns True if the action is a TerminalAction
 */
export function isTerminalAction(action: Action): action is TerminalAction {
  return action.type === 'STOP' || action.type === 'COMPLETE' || action.type === 'GOTO';
}

/**
 * Check if an action is a BREAK action (exits FOR loop without accumulation).
 *
 * @param action - The action to check
 * @returns True if the action is a BreakAction
 */
export function isBreakAction(action: Action): action is BreakAction {
  return action.type === 'BREAK';
}

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
    `Invalid format: "${trimmed}". Use a single-word identifier (letters, numbers, underscore) or a quoted string.`,
  );
}

/**
 * Parsed result from an H3 substep header.
 *
 * Represents the structured data extracted from substep headers like:
 * - "1.2 Description" (numeric)
 * - "ErrorHandler.Recover Description" (named)
 * - "ErrorHandler Handle the error" (bare named)
 */
export interface ParsedSubstepHeader {
  /** Reference to parent step: "1" or named identifier like "ErrorHandler". Undefined for short form (parent inferred from context). */
  stepRef?: string;
  /** Substep identifier: numeric string or named identifier */
  id: string;
  /** Human-readable description from the header */
  description: string;
}

/** Characters to strip from trailing position of named step identifiers. */
const TRAILING_SEPARATORS = new Set(['.', ':', '\u2014', '\u2192', ')', '-']);

/**
 * Strip common separators and whitespace from the beginning of text.
 *
 * Removes leading punctuation (periods, colons, dashes, arrows, parentheses)
 * and whitespace that commonly separate step numbers from descriptions.
 *
 * @param text - The text to strip leading separators from
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
 * Generate a default description for bare numeric step headers (e.g., "## 1" → "Step 1").
 *
 * @param stepNumber - The numeric step identifier to include in the description
 * @returns A default description string in the form "Step N"
 */
function defaultStepDescription(stepNumber: string): string {
  return `Step ${stepNumber}`;
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

    return { name: numberStr, description: description || defaultStepDescription(numberStr) };
  }

  // Check for named step: Name or Name Description
  const words = trimmed.split(/\s+/);
  const firstName = words[0];

  // Strip trailing separator characters (like '.', ':', etc.) from the name
  // Manual right-trim loop avoids polynomial regex backtracking (CodeQL alert)
  let end = firstName.length;
  while (end > 0 && TRAILING_SEPARATORS.has(firstName[end - 1])) end--;
  const strippedName = firstName.slice(0, end);

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
 * 1. Bare positive integer: "1", "2 Description" (parent inferred from context)
 * 2. Dot-qualified: "1.2", "ErrorHandler.Recover Description"
 * 3. Bare named: "ErrorHandler", "Cleanup: Handle it" (parent inferred from context)
 *
 * Description is optional per spec. Separator characters (`:`, `)`, `—`, `→`, `-`, `.`)
 * between the identifier and description are stripped.
 *
 * @param text - The raw H3 header text (without the ### prefix)
 * @returns Parsed substep header data, or null if text is not a valid substep header
 */
export function extractSubstepHeader(text: string): ParsedSubstepHeader | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const spaceIdx = trimmed.indexOf(' ');
  const firstTokenRaw = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);

  // Strip trailing separator chars (e.g., "1." → "1", "3)" → "3")
  let tokenEnd = firstTokenRaw.length;
  while (tokenEnd > 0 && TRAILING_SEPARATORS.has(firstTokenRaw[tokenEnd - 1])) tokenEnd--;
  const firstToken = firstTokenRaw.slice(0, tokenEnd);

  // Branch 1: Bare positive integer (e.g., "1", "2 Description", "1. Title", "3) Title")
  if (/^\d+$/.test(firstToken)) {
    const num = parseInt(firstToken, 10);
    if (num > 0) {
      const afterFirstToken = trimmed.slice(firstTokenRaw.length);
      const description = stripSeparator(afterFirstToken);
      return { id: firstToken, description };
    }
  }

  // Branch 2: Dot-qualified (e.g., "1.2", "ErrorHandler.Recover Description")
  const dotIndex = trimmed.indexOf('.');
  if (dotIndex > 0) {
    const stepPart = trimmed.slice(0, dotIndex);
    if (isValidStepRef(stepPart)) {
      const afterDot = trimmed.slice(dotIndex + 1);
      if (!afterDot) return null;

      const spaceIndex = afterDot.indexOf(' ');
      const substepId = spaceIndex === -1 ? afterDot : afterDot.slice(0, spaceIndex);
      if (!isValidSubstepId(substepId)) return null;

      const remainder = spaceIndex !== -1 ? afterDot.slice(spaceIndex) : '';
      const description = stripSeparator(remainder);

      return {
        stepRef: stepPart,
        id: substepId,
        description,
      };
    }
  }

  // Branch 3: Bare named (e.g., "ErrorHandler", "Cleanup: Handle it")
  // Strip trailing separator chars from firstToken
  let end = firstToken.length;
  while (end > 0 && TRAILING_SEPARATORS.has(firstToken[end - 1])) end--;
  const strippedName = firstToken.slice(0, end);

  if (
    strippedName &&
    NAMED_IDENTIFIER_PATTERN.test(strippedName) &&
    !isReservedWord(strippedName)
  ) {
    const afterFirstToken = spaceIdx !== -1 ? trimmed.slice(spaceIdx) : '';
    const description = stripSeparator(afterFirstToken);
    return { id: strippedName, description };
  }

  return null;
}

/**
 * Parse the "variable IN rest" prefix from a FOR clause without regex.
 *
 * Avoids ReDoS by using indexOf for whitespace boundaries instead of \s+ patterns.
 *
 * @param rest - The text after "FOR " (e.g., "batch IN 1 TO 10")
 * @returns Parsed variable and range string, or null if not a named FOR clause
 */
function parseNamedForPrefix(rest: string): { variable: string; rangeStr: string } | null {
  // Scan for first space or tab (indexOf(' ') misses tabs)
  let spaceIdx = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === ' ' || rest[i] === '\t') {
      spaceIdx = i;
      break;
    }
  }
  if (spaceIdx <= 0) return null;

  const candidate = rest.slice(0, spaceIdx);
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(candidate)) return null;

  // Skip whitespace after identifier
  let pos = spaceIdx;
  while (pos < rest.length && (rest[pos] === ' ' || rest[pos] === '\t')) pos++;

  // Check for 'IN' keyword
  if (rest.slice(pos, pos + 2) !== 'IN') return null;
  pos += 2;

  // Must be followed by whitespace
  if (pos >= rest.length || (rest[pos] !== ' ' && rest[pos] !== '\t')) return null;

  // Skip whitespace after IN
  while (pos < rest.length && (rest[pos] === ' ' || rest[pos] === '\t')) pos++;

  const rangeStr = rest.slice(pos);
  if (!rangeStr) return null;

  return { variable: candidate, rangeStr };
}

/**
 * Parse a FOR loop clause from bullet text.
 *
 * Recognizes these grammar variants:
 * - `FOR variable IN start TO end` (full form)
 * - `FOR start TO end` (unnamed, range)
 * - `FOR variable IN count` (named, count only — start defaults to 1)
 * - `FOR count` (unnamed, count only — start defaults to 1)
 * - `FOR variable IN {{ source }}` (all items from data source)
 * - `FOR variable IN start TO end OF {{ source }}` (windowed data source)
 *
 * Bounds must be positive integers or template variable references (`{{VarName}}`).
 * When any bound is a template reference, the returned clause is tagged with
 * `unresolved: true` and bounds may contain `BoundRef` values.
 *
 * @param text - The bullet text (after `- ` prefix), e.g. "FOR batch IN 1 TO 10"
 * @returns Parsed ForClause or unresolved variant, or null if text is not a valid FOR clause
 */
/** Regex fragment matching a bound token: positive integer or mustache variable reference. */
const BOUND_TOKEN = '(?:[1-9]\\d*|\\{\\{\\s*[a-zA-Z_][a-zA-Z0-9_]*\\s*\\}\\})';

/** Matches "start TO end" range patterns. */
const TO_RE = new RegExp(`^(${BOUND_TOKEN})\\s+TO\\s+(${BOUND_TOKEN})$`);

/** Matches "start TO end OF {{ source }}" windowed source patterns. */
const WINDOWED_SOURCE_RE = new RegExp(
  `^(${BOUND_TOKEN})\\s+TO\\s+(${BOUND_TOKEN})\\s+OF\\s+\\{\\{\\s*([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\}\\}$`,
);

/**
 * Parse a FOR clause header into a structured clause descriptor.
 *
 * @param text - Raw header text starting with "FOR ..."
 * @returns Parsed FOR clause (resolved or unresolved), or null if not a valid FOR clause
 */
export function parseForClause(text: string): ParsedForClause | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('FOR ')) return null;

  const rest = trimmed.slice(4).trim();
  if (!rest) return null;

  // Try to parse a bound value (positive integer only, capped at MAX_FOR_BOUND)
  const parseBound = (s: string): number | null => {
    const num = parseInt(s, 10);
    if (!Number.isNaN(num) && String(num) === s && num > 0 && num <= MAX_FOR_BOUND) return num;
    return null;
  };

  // Try to parse a bound or template variable reference
  const parseBoundOrRef = (s: string): Bound | null => {
    const num = parseBound(s);
    if (num !== null) return num;
    const refMatch = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/.exec(s);
    if (refMatch) return { ref: refMatch[1] };
    return null;
  };

  // Build numeric (no-source) result, marking unresolved if any bound is a BoundRef
  const buildNumericResult = (start: Bound, end: Bound, variable?: string): ParsedForClause => {
    if (isBoundRef(start) || isBoundRef(end)) {
      return variable
        ? { unresolved: true as const, variable, start, end }
        : { unresolved: true as const, start, end };
    }
    return variable ? { variable, start, end } : { start, end };
  };

  // Pattern 1: FOR variable IN start TO end
  // Pattern 2: FOR variable IN count (start defaults to 1)
  // Pattern 5: FOR variable IN {{ source }} (all items)
  // Pattern 6: FOR variable IN start TO end OF {{ source }} (windowed source)
  // Manual parsing to avoid ReDoS from \s+IN\s+ backtracking
  const namedParsed = parseNamedForPrefix(rest);
  if (namedParsed) {
    const variable = namedParsed.variable;
    if (isReservedWord(variable)) return null;
    const rangeStr = namedParsed.rangeStr;

    // Source pattern: {{ source }} (spaces optional)
    const sourceMatch = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/.exec(rangeStr);
    if (sourceMatch) {
      return { variable, start: 1, source: sourceMatch[1] };
    }

    // Windowed source pattern: start TO end OF {{ source }}
    const windowedSourceMatch = WINDOWED_SOURCE_RE.exec(rangeStr);
    if (windowedSourceMatch) {
      const start = parseBoundOrRef(windowedSourceMatch[1]);
      const end = parseBoundOrRef(windowedSourceMatch[2]);
      const source = windowedSourceMatch[3];
      if (start !== null && end !== null) {
        if (isBoundRef(start) || isBoundRef(end)) {
          return { unresolved: true as const, variable, start, end, source };
        }
        return { variable, start, end, source };
      }
      return null;
    }

    // Try "start TO end"
    const toMatch = TO_RE.exec(rangeStr);
    if (toMatch) {
      const start = parseBoundOrRef(toMatch[1]);
      const end = parseBoundOrRef(toMatch[2]);
      if (start !== null && end !== null) {
        return buildNumericResult(start, end, variable);
      }
      return null;
    }

    // Try single count value (or ref)
    const end = parseBoundOrRef(rangeStr);
    if (end !== null) {
      if (isBoundRef(end)) {
        return { unresolved: true as const, variable, start: 1, end };
      }
      return { variable, start: 1, end };
    }
    return null;
  }

  // Pattern 3: FOR start TO end (unnamed)
  const rangeMatch = TO_RE.exec(rest);
  if (rangeMatch) {
    const start = parseBoundOrRef(rangeMatch[1]);
    const end = parseBoundOrRef(rangeMatch[2]);
    if (start !== null && end !== null) {
      return buildNumericResult(start, end);
    }
    return null;
  }

  // Pattern 4: FOR count (unnamed, count only — or ref)
  const end = parseBoundOrRef(rest);
  if (end !== null) {
    if (isBoundRef(end)) {
      return { unresolved: true as const, start: 1, end };
    }
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

  if (trimmed === 'DEFER') {
    return { type: 'DEFER' };
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

  // Parse leading digits manually to avoid ReDoS from (\d+)(?:\s+(.*))? backtracking
  let digitEnd = 0;
  while (digitEnd < remaining.length && remaining[digitEnd] >= '0' && remaining[digitEnd] <= '9') {
    digitEnd++;
  }
  if (digitEnd > 0 && (digitEnd >= remaining.length || /\s/.test(remaining[digitEnd]))) {
    retry = parseInt(remaining.slice(0, digitEnd), 10);
    remaining = remaining.slice(digitEnd).trimStart();
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

function parseConditionalPrefix(
  rest: string,
  type: 'pass' | 'fail' | 'yes' | 'no',
): ParsedConditional | null {
  let modifier: AggregationModifier = null;
  let remaining = rest;

  const modifierMatch = /^\s+(ALL|ANY)\s/.exec(remaining);
  if (modifierMatch) {
    modifier = modifierMatch[1] as 'ALL' | 'ANY';
    remaining = remaining.slice(modifierMatch[0].length);
  }

  const actionStr = remaining.trimStart();

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
 * - PASS/YES: triggers on step success (e.g., "PASS CONTINUE", "YES GOTO 2")
 * - FAIL/NO: triggers on step failure (e.g., "FAIL STOP", "NO RETRY 3")
 * - With aggregation: "PASS ALL CONTINUE", "FAIL ANY STOP"
 * - Standalone DEFER: shorthand for PASS DEFER + FAIL DEFER
 *
 * @param text - The conditional line to parse
 * @returns Parsed conditional (single or array for DEFER shorthand), or null if not a conditional
 * @throws {RunbookSyntaxError} If the line starts with PASS/FAIL/YES/NO but has invalid action
 */
export function parseConditional(text: string): ParseConditionalResult {
  const trimmed = text.trim();

  // Standalone DEFER shorthand: expands to PASS DEFER + FAIL DEFER
  if (trimmed === 'DEFER') {
    return [
      { type: 'pass', retry: 0, action: { type: 'DEFER' }, modifier: null, raw: 'DEFER' },
      { type: 'fail', retry: 0, action: { type: 'DEFER' }, modifier: null, raw: 'DEFER' },
    ];
  }

  if (trimmed === 'PASS' || trimmed.startsWith('PASS ')) {
    const result = parseConditionalPrefix(trimmed.slice(4), 'pass');
    if (!result) {
      throw new RunbookSyntaxError(`Invalid PASS transition: ${trimmed}`);
    }
    return result;
  }

  if (trimmed === 'YES' || trimmed.startsWith('YES ')) {
    const result = parseConditionalPrefix(trimmed.slice(3), 'yes');
    if (!result) {
      throw new RunbookSyntaxError(`Invalid YES transition: ${trimmed}`);
    }
    return result;
  }

  if (trimmed === 'FAIL' || trimmed.startsWith('FAIL ')) {
    const result = parseConditionalPrefix(trimmed.slice(4), 'fail');
    if (!result) {
      throw new RunbookSyntaxError(`Invalid FAIL transition: ${trimmed}`);
    }
    return result;
  }

  if (trimmed === 'NO' || trimmed.startsWith('NO ')) {
    const result = parseConditionalPrefix(trimmed.slice(2), 'no');
    if (!result) {
      throw new RunbookSyntaxError(`Invalid NO transition: ${trimmed}`);
    }
    return result;
  }

  // Reject transition keywords followed by invalid separators (e.g., "PASS:", "FAIL:")
  if (/^(?:PASS|FAIL|YES|NO)[^a-zA-Z0-9\s]/.test(trimmed)) {
    throw new RunbookSyntaxError(
      `Invalid transition syntax: "${trimmed}". Use space-separated format (e.g., "PASS CONTINUE")`,
    );
  }

  return null;
}

function resolveAggregationMode(
  passModifier: AggregationModifier,
  failModifier: AggregationModifier,
): 'ALL' | 'ANY' | undefined {
  if (passModifier && failModifier) {
    if (passModifier === 'ALL' && failModifier === 'ANY') return 'ALL';
    if (passModifier === 'ANY' && failModifier === 'ALL') return 'ANY';
    throw new RunbookSyntaxError(
      `Invalid aggregation combination: PASS ${passModifier} + FAIL ${failModifier}. ` +
        `Valid: PASS ALL + FAIL ANY (pessimistic) or PASS ANY + FAIL ALL (optimistic)`,
    );
  }

  // One-sided modifier — require explicit pairing
  if (passModifier && !failModifier) {
    const expected = passModifier === 'ALL' ? 'ANY' : 'ALL';
    throw new RunbookSyntaxError(
      `PASS ${passModifier} requires explicit FAIL ${expected} — aggregation modifiers must appear on both sides`,
    );
  }
  if (failModifier && !passModifier) {
    const expected = failModifier === 'ALL' ? 'ANY' : 'ALL';
    throw new RunbookSyntaxError(
      `FAIL ${failModifier} requires explicit PASS ${expected} — aggregation modifiers must appear on both sides`,
    );
  }

  return undefined;
}

/**
 * Validate that loop control actions (NEXT/BREAK) are only used in FOR contexts.
 *
 * The first-class `NEXT` and `BREAK` actions are for FOR loop control flow
 * and are only valid within substeps of a FOR step.
 *
 * @param conditionals - Array of parsed conditionals to check for NEXT/BREAK usage
 * @param isForContext - Whether the current context is within a FOR step
 * @throws {RunbookSyntaxError} When NEXT/BREAK used outside FOR context
 */
export function validateLoopControlUsage(
  conditionals: ParsedConditional[],
  isForContext: boolean,
): void {
  for (const conditional of conditionals) {
    // Check first-class NEXT/BREAK — requires FOR context
    if (isLoopControlAction(conditional.action)) {
      if (!isForContext) {
        throw new RunbookSyntaxError(
          `${conditional.action.type} is only valid within substeps of a FOR step`,
        );
      }
    }
  }
}

/** @deprecated Use {@link validateLoopControlUsage} instead. */
export const validateNEXTUsage = validateLoopControlUsage;

/**
 * Validate that DEFER is only used in substep or FOR iteration-level contexts.
 *
 * DEFER propagates a result to a parent aggregation state (ALL/ANY). At step
 * level there is no parent aggregation, so DEFER is meaningless.
 *
 * @param conditionals - Array of parsed conditionals to check for DEFER usage
 * @param isSubstepContext - Whether the current context is within a substep or FOR iteration
 * @throws {RunbookSyntaxError} When DEFER used at step level
 */
export function validateDEFERUsage(
  conditionals: ParsedConditional[],
  isSubstepContext: boolean,
): void {
  for (const conditional of conditionals) {
    if (conditional.action.type === 'DEFER') {
      if (!isSubstepContext) {
        throw new RunbookSyntaxError(
          'DEFER is only valid within substeps or FOR iteration-level transitions, not at step level',
        );
      }
    }
  }
}

/**
 * Result of converting parsed conditionals into separated transitions and aggregation.
 *
 * Returned by {@link convertToTransitions} when at least one conditional was provided.
 * Transitions (pass/fail pair) are always present; aggregation is present only when
 * the author specified ALL or ANY modifiers.
 */
export type ConvertedTransitions = {
  /** The pass/fail transition pair. */
  transitions: Transitions;
  /** Aggregation strategy, present only when ALL/ANY was authored. */
  aggregation?: Aggregation;
};

/**
 * Convert an array of parsed conditionals into separated Transitions and Aggregation.
 *
 * Combines PASS and FAIL conditionals into a unified Transitions structure,
 * resolving aggregation mode (ALL vs ANY) and providing defaults for
 * missing conditions (PASS defaults to CONTINUE, FAIL defaults to STOP).
 *
 * @param conditionals - Array of parsed conditional objects from parseConditional
 * @returns ConvertedTransitions with transitions and optional aggregation, or null if no conditionals provided
 */
export function convertToTransitions(
  conditionals: ParsedConditional[],
): ConvertedTransitions | null {
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

  const strategy = resolveAggregationMode(passModifier, failModifier);

  let transitions: Transitions;
  if (passAction && failAction) {
    transitions = {
      pass: { kind: passKind, retry: passRetry, action: passAction },
      fail: { kind: failKind, retry: failRetry, action: failAction },
    };
  } else if (passAction) {
    transitions = {
      pass: { kind: passKind, retry: passRetry, action: passAction },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    };
  } else if (failAction) {
    transitions = {
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: failKind, retry: failRetry, action: failAction },
    };
  } else {
    return null;
  }

  if (strategy) {
    return { transitions, aggregation: { strategy } };
  }
  return { transitions };
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
  if (!EXECUTABLE_TAGS.includes(tag)) return false;
  if (parts.length > 1 && parts[1]?.toLowerCase() === 'prompt') return false;
  return true;
}

/**
 * Check if a code block language tag indicates a prompt block.
 *
 * Prompt blocks contain text to be displayed or sent to an agent.
 * Any non-executable tagged code block (json, yaml, typescript, etc.) is
 * treated as a prompt block. Bare fences (no tag) return null so the
 * caller can reject them as invalid.
 *
 * @param lang - The code block language tag
 * @returns True if prompt or non-executable tagged, false if executable (bash/sh/shell), null for bare fences (no tag)
 */
export function isPromptCodeBlock(lang: string | null | undefined): boolean | null {
  if (!lang) return null;
  const trimmed = lang.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  const tag = parts[0]?.toLowerCase();
  if (tag === 'prompt') return true;
  if (EXECUTABLE_TAGS.includes(tag)) {
    if (parts.length > 1 && parts[1]?.toLowerCase() === 'prompt') return true;
    return false;
  }
  return true;
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
    case 'DEFER':
      return 'DEFER';
    case 'COMPLETE':
      return action.message ? `COMPLETE "${action.message}"` : 'COMPLETE';
    case 'STOP':
      return action.message ? `STOP "${action.message}"` : 'STOP';
    case 'GOTO':
      return `GOTO ${stepIdToString(action.target)}`;
    case 'NEXT':
      return 'NEXT';
    case 'BREAK':
      return 'BREAK';
    default:
      return 'UNKNOWN';
  }
}
