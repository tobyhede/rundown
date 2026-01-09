import {
  createStepNumber,
  WorkflowSyntaxError,
  type ParsedConditional,
  type AggregationModifier,
  type StepNumber
} from './types.js';
import {
  type Action,
  type NonRetryAction,
  type Transitions
} from './schemas.js';
import { parseStepIdFromString } from './step-id.js';

export interface ParsedSubstepHeader {
  stepRef: number | '{N}';
  id: string; // "1", "2", or "{n}" for dynamic
  description: string;
  agentType?: string;
  isDynamic: boolean;
}

/**
 * Strip common separators and whitespace
 */
export function stripSeparator(text: string): string {
  return text.replace(/^[.:—→\-)\s]+/, '').trim();
}

export interface ParsedStepHeader {
  number?: StepNumber;
  isDynamic: boolean;
  description: string;
}

/**
 * Extract step number and description from header text
 */
export function extractStepHeader(text: string): ParsedStepHeader | null {
  const trimmed = text.trim();

  if (trimmed.startsWith('{N}')) {
    const rest = trimmed.slice(3);
    const description = stripSeparator(rest);
    if (!description) {
      return null;
    }
    return { isDynamic: true, description };
  }

  let numEnd = 0;
  while (numEnd < trimmed.length && /\d/.test(trimmed[numEnd])) {
    numEnd++;
  }

  if (numEnd === 0) {
    return null;
  }

  const number = parseInt(trimmed.slice(0, numEnd), 10);
  const stepNumber = createStepNumber(number);
  if (!stepNumber) {
    return null;
  }

  const description = stripSeparator(trimmed.slice(numEnd));
  if (!description) {
    return null;
  }

  return { number: stepNumber, isDynamic: false, description };
}

/**
 * Extract substep header from H3 text
 */
export function extractSubstepHeader(text: string): ParsedSubstepHeader | null {
  const trimmed = text.trim();

  const match = /^(\{N\}|\d+)\.(\{n\}|\d+)\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(trimmed);
  if (!match) return null;

  const [, stepPart, substepId, desc, agent] = match;

  let stepRef: number | '{N}';
  if (stepPart === '{N}') {
    stepRef = '{N}';
  } else {
    const stepNumber = parseInt(stepPart, 10);
    if (stepNumber <= 0) return null;
    stepRef = stepNumber;
  }

  const isDynamic = substepId === '{n}';

  return {
    stepRef,
    id: substepId,
    description: desc.trim(),
    agentType: agent ? agent.trim() : undefined,
    isDynamic
  };
}

/**
 * Parse an action string into an Action object
 */
export function parseAction(text: string): Action | null {
  const trimmed = text.trim();

  if (trimmed === 'CONTINUE') {
    return { type: 'CONTINUE' };
  }

  if (trimmed === 'COMPLETE') {
    return { type: 'COMPLETE' };
  }

  if (trimmed === 'STOP') {
    return { type: 'STOP' };
  }

  if (trimmed.startsWith('STOP ')) {
    let message = trimmed.slice(5).trim();
    if (message.startsWith('"') && message.endsWith('"')) {
      message = message.slice(1, -1);
    }
    return { type: 'STOP', message };
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

  if (trimmed === 'STOP') {
    return { type: 'STOP' };
  }

  if (trimmed.startsWith('STOP ')) {
    let rest = trimmed.slice(5).trim();
    if (rest.startsWith('"') && rest.endsWith('"')) {
      rest = rest.slice(1, -1);
    }
    return { type: 'STOP', message: rest };
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

function parseConditionalPrefix(rest: string, type: 'pass' | 'fail'): ParsedConditional | null {
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
    const result = parseConditionalPrefix(trimmed.slice(3), 'pass');
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
    const result = parseConditionalPrefix(trimmed.slice(2), 'fail');
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
    return action.target.step === 'NEXT';
  }
  if (action.type === 'RETRY' && 'then' in action) {
    return containsNEXT(action.then);
  }
  return false;
}

/**
 * Validate that NEXT is only used in dynamic step contexts
 */
export function validateNEXTUsage(conditionals: ParsedConditional[], isDynamicStep: boolean): void {
  if (isDynamicStep) {
    // NEXT is allowed in dynamic steps
    return;
  }

  for (const conditional of conditionals) {
    if (containsNEXT(conditional.action)) {
      throw new WorkflowSyntaxError(
        `NEXT action is only allowed in dynamic step contexts (steps with {N} prefix)`
      );
    }
  }
}

export function convertToTransitions(conditionals: ParsedConditional[]): Transitions | null {
  if (conditionals.length === 0) {
    return null;
  }

  let passAction: Action | null = null;
  let failAction: Action | null = null;
  let passModifier: AggregationModifier = null;
  let failModifier: AggregationModifier = null;

  for (const conditional of conditionals) {
    if (conditional.type === 'pass') {
      passAction = conditional.action;
      passModifier = conditional.modifier;
    } else {
      failAction = conditional.action;
      failModifier = conditional.modifier;
    }
  }

  const all = resolveAggregationMode(passModifier, failModifier);

  if (passAction && failAction) {
    return {
      all,
      pass: { kind: 'pass', action: passAction },
      fail: { kind: 'fail', action: failAction },
    };
  }

  if (passAction && !failAction) {
    return {
      all,
      pass: { kind: 'pass', action: passAction },
      fail: { kind: 'fail', action: { type: 'STOP' } },
    };
  }

  if (!passAction && failAction) {
    return {
      all,
      pass: { kind: 'pass', action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', action: failAction },
    };
  }

  return null;
}

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
 * Check if code block is executable (bash/sh/shell)
 */
export function isExecutableCodeBlock(lang: string | null | undefined): boolean {
  if (!lang) return false;
  const parts = lang.split(/\s+/);
  const tag = parts[0]?.toLowerCase();
  if (!tag) return false;
  return EXECUTABLE_TAGS.includes(tag);
}

/**
 * Check if code block is a prompt block
 */
export function isPromptCodeBlock(lang: string | null | undefined): boolean {
  if (!lang) return false;
  const tag = lang.split(/\s+/)[0]?.toLowerCase();
  return tag === 'prompt';
}

/**
 * Escape content for shell single-quoted string
 */
export function escapeForShellSingleQuote(content: string): string {
  // In single quotes, escape single quotes as: '\''
  return content.replace(/'/g, "'\\''");
}

export function formatAction(action: Action): string {
  switch (action.type) {
    case 'CONTINUE':
      return 'CONTINUE';
    case 'COMPLETE':
      return 'COMPLETE';
    case 'STOP':
      return action.message ? `STOP "${action.message}"` : 'STOP';
    case 'GOTO':
      return `GOTO ${String(action.target.step)}`;
    case 'RETRY':
      return action.max ? `RETRY ${String(action.max)}` : 'RETRY';
    default:
      return 'UNKNOWN';
  }
}
