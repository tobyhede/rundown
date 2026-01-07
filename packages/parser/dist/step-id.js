import { createStepNumber } from './types.js';
/**
 * Parse StepId from string
 */
export function parseStepIdFromString(input, options) {
    if (!input)
        return null;
    // Handle NEXT as special GOTO target
    if (input === 'NEXT') {
        return { step: 'NEXT' };
    }
    // Reject NEXT with substep notation
    if (input.startsWith('NEXT.')) {
        return null;
    }
    const requireSeparator = options?.requireSeparator ?? false;
    // Check for dynamic substep reference: {N}.M
    if (input.startsWith('{N}.')) {
        const dynamicMatch = /^\{N\}\.(\d+|\{n\})$/.exec(input);
        if (dynamicMatch) {
            if (dynamicMatch[1] !== '{n}') {
                const substepNum = parseInt(dynamicMatch[1], 10);
                if (substepNum < 1)
                    return null;
            }
            return { step: '{N}', substep: dynamicMatch[1] };
        }
        if (requireSeparator) {
            const sepMatch = /^\{N\}\.(\d+|\{n\})[\s\-:]/.exec(input);
            if (sepMatch) {
                return { step: '{N}', substep: sepMatch[1] };
            }
        }
        return null;
    }
    if (input === '{N}' || input.startsWith('{N}')) {
        return null;
    }
    const pattern = requireSeparator
        ? /^(\d+)(?:\.(\d+))?[\s\-:]/
        : /^(\d+)(?:\.(\d+))?$/;
    const match = input.match(pattern);
    if (!match)
        return null;
    const stepNum = parseInt(match[1], 10);
    const step = createStepNumber(stepNum);
    if (!step)
        return null;
    if (match[2]) {
        const substepNum = parseInt(match[2], 10);
        if (substepNum < 1)
            return null;
    }
    return {
        step,
        substep: match[2]
    };
}
/**
 * Serialize StepId to string
 */
export function stepIdToString(stepId) {
    const stepStr = stepId.step === '{N}' ? '{N}' : String(stepId.step);
    return stepId.substep ? `${stepStr}.${stepId.substep}` : stepStr;
}
/**
 * Compare two StepIds for equality
 */
export function stepIdEquals(a, b) {
    return a.step === b.step && a.substep === b.substep;
}
//# sourceMappingURL=step-id.js.map