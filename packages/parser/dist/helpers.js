import { createStepNumber, WorkflowSyntaxError } from './types.js';
import { parseStepIdFromString, isReservedWord, NAMED_IDENTIFIER_PATTERN } from './step-id.js';
/**
 * Parse a quoted string or single-word identifier.
 * Used for STOP and COMPLETE messages ONLY.
 * NOT used for GOTO targets (GOTO uses parseStepIdFromString which accepts identifiers directly).
 *
 * Valid formats:
 * - Single word identifier: /^[A-Za-z_][A-Za-z0-9_]*$/
 * - Quoted string: "any text here"
 *
 * @throws Error if format is invalid
 */
export function parseQuotedOrIdentifier(text) {
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
    throw new Error(`Invalid format: "${trimmed}". Use a single-word identifier (letters, numbers, underscore) or a quoted string.`);
}
/**
 * Strip common separators and whitespace
 */
export function stripSeparator(text) {
    return text.replace(/^[.:—→\-)\s]+/, '').trim();
}
/**
 * Extract step number/name and description from header text
 */
export function extractStepHeader(text) {
    const trimmed = text.trim();
    // Check for dynamic step: {N} Description
    if (trimmed.startsWith('{N}')) {
        const rest = trimmed.slice(3);
        const description = stripSeparator(rest);
        if (!description) {
            return null;
        }
        return { isDynamic: true, isNamed: false, description };
    }
    // Check for numeric step: 1 Description
    let numEnd = 0;
    while (numEnd < trimmed.length && /\d/.test(trimmed[numEnd])) {
        numEnd++;
    }
    if (numEnd > 0) {
        const number = parseInt(trimmed.slice(0, numEnd), 10);
        const stepNumber = createStepNumber(number);
        if (!stepNumber) {
            return null;
        }
        const description = stripSeparator(trimmed.slice(numEnd));
        if (!description) {
            return null;
        }
        return { number: stepNumber, isDynamic: false, isNamed: false, description };
    }
    // Check for named step: Name or Name Description
    const words = trimmed.split(/\s+/);
    const firstName = words[0];
    if (!firstName || !NAMED_IDENTIFIER_PATTERN.test(firstName)) {
        return null;
    }
    // Reject reserved words
    if (isReservedWord(firstName)) {
        return null;
    }
    const restWords = words.slice(1);
    const description = restWords.length > 0 ? restWords.join(' ') : firstName;
    return {
        name: firstName,
        isDynamic: false,
        isNamed: true,
        description,
    };
}
/**
 * Extract substep header from H3 text
 *
 * Supports:
 * - Numeric: "1.2 Description"
 * - Dynamic: "{N}.1 Description", "1.{n} Description", "{N}.{n} Description"
 * - Named: "1.Cleanup Description", "ErrorHandler.Recover Description", "{N}.Recovery Description"
 */
export function extractSubstepHeader(text) {
    const trimmed = text.trim();
    // Pattern: StepRef.SubstepId Description [(agent)]
    // StepRef: number | {N} | Name
    // SubstepId: number | {n} | Name
    const match = /^(\{N\}|\d+|[A-Za-z_][A-Za-z0-9_]*)\.(\{n\}|\d+|[A-Za-z_][A-Za-z0-9_]*)\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(trimmed);
    if (!match)
        return null;
    const [, stepPart, substepId, desc, agent] = match;
    // Parse step reference
    let stepRef;
    if (stepPart === '{N}') {
        stepRef = '{N}';
    }
    else if (/^\d+$/.test(stepPart)) {
        const stepNumber = parseInt(stepPart, 10);
        if (stepNumber <= 0)
            return null;
        stepRef = stepNumber;
    }
    else {
        // Named parent step
        if (isReservedWord(stepPart))
            return null;
        stepRef = stepPart;
    }
    // Determine substep type
    const isDynamic = substepId === '{n}';
    const isNamed = !isDynamic && /^[A-Za-z_][A-Za-z0-9_]*$/.test(substepId);
    // Reject reserved words as substep names
    if (isNamed && isReservedWord(substepId)) {
        return null;
    }
    return {
        stepRef,
        id: substepId,
        description: desc.trim(),
        agentType: agent ? agent.trim() : undefined,
        isDynamic,
        isNamed,
    };
}
/**
 * Parse an action string into an Action object
 */
export function parseAction(text) {
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
        }
        catch {
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
        }
        catch {
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
        return { type: 'GOTO', target: { step: 'NEXT' } };
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
function parseRetryWithArgs(rest) {
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
function parseNonRetryAction(input) {
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
        }
        catch {
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
        }
        catch {
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
function parseConditionalPrefix(rest, type) {
    let modifier = null;
    let remaining = rest;
    const modifierMatch = /^\s+(ALL|ANY)[\s:→-]/.exec(remaining);
    if (modifierMatch) {
        modifier = modifierMatch[1];
        remaining = remaining.slice(modifierMatch[0].length);
    }
    const actionStr = stripSeparator(remaining);
    const action = parseAction(actionStr);
    if (!action) {
        return null;
    }
    return { type, action, modifier, raw: actionStr };
}
export function parseConditional(text) {
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
function resolveAggregationMode(passModifier, failModifier) {
    if (passModifier && failModifier) {
        if (passModifier === 'ALL' && failModifier === 'ANY')
            return true;
        if (passModifier === 'ANY' && failModifier === 'ALL')
            return false;
        throw new WorkflowSyntaxError(`Invalid aggregation combination: PASS ${passModifier} + FAIL ${failModifier}. ` +
            `Valid: PASS ALL + FAIL ANY (pessimistic) or PASS ANY + FAIL ALL (optimistic)`);
    }
    if (passModifier === 'ALL')
        return true;
    if (passModifier === 'ANY')
        return false;
    if (failModifier === 'ANY')
        return true;
    if (failModifier === 'ALL')
        return false;
    return true;
}
/**
 * Check if an action contains a NEXT target
 */
function containsNEXT(action) {
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
export function validateNEXTUsage(conditionals, isDynamicStep) {
    if (isDynamicStep) {
        // NEXT is allowed in dynamic steps
        return;
    }
    for (const conditional of conditionals) {
        if (containsNEXT(conditional.action)) {
            throw new WorkflowSyntaxError(`NEXT action is only allowed in dynamic step contexts (steps with {N} prefix)`);
        }
    }
}
export function convertToTransitions(conditionals) {
    if (conditionals.length === 0) {
        return null;
    }
    let passAction = null;
    let failAction = null;
    let passModifier = null;
    let failModifier = null;
    for (const conditional of conditionals) {
        if (conditional.type === 'pass') {
            passAction = conditional.action;
            passModifier = conditional.modifier;
        }
        else {
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
export function extractWorkflowList(content) {
    const workflows = [];
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
export function isExecutableCodeBlock(lang) {
    if (!lang)
        return false;
    const parts = lang.split(/\s+/);
    const tag = parts[0]?.toLowerCase();
    if (!tag)
        return false;
    return EXECUTABLE_TAGS.includes(tag);
}
/**
 * Check if code block is a prompt block
 * Returns true if tag is 'prompt', false if tag is executable (bash/sh/shell), null otherwise
 */
export function isPromptCodeBlock(lang) {
    if (!lang)
        return null;
    const trimmed = lang.trim();
    if (!trimmed)
        return null;
    const tag = trimmed.split(/\s+/)[0]?.toLowerCase();
    if (tag === 'prompt')
        return true;
    if (EXECUTABLE_TAGS.includes(tag))
        return false;
    return null;
}
/**
 * Escape content for shell single-quoted string
 */
export function escapeForShellSingleQuote(content) {
    // In single quotes, escape single quotes as: '\''
    return content.replace(/'/g, "'\\''");
}
export function formatAction(action) {
    switch (action.type) {
        case 'CONTINUE':
            return 'CONTINUE';
        case 'COMPLETE':
            return action.message ? `COMPLETE "${action.message}"` : 'COMPLETE';
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
//# sourceMappingURL=helpers.js.map