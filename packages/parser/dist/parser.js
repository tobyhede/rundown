import { fromMarkdown } from 'mdast-util-from-markdown';
import { visit } from 'unist-util-visit';
import { WorkflowSyntaxError } from './types.js';
import { extractStepHeader, extractSubstepHeader, parseConditional, convertToTransitions, extractWorkflowList, isPromptedCodeBlock, validateNEXTUsage } from './helpers.js';
import { validateWorkflow } from './validator.js';
import { extractFrontmatter, nameFromFilename } from './frontmatter.js';
/**
 * Type guard to narrow Node to Heading
 */
function isHeading(node) {
    return node.type === 'heading' && 'depth' in node;
}
/**
 * Extract plain text from mdast node
 */
function extractText(node) {
    if (node.type === 'text') {
        return node.value;
    }
    if ('children' in node && Array.isArray(node.children)) {
        return node.children.map((child) => extractText(child)).join('');
    }
    return '';
}
/**
 * Parse workflow markdown into Step array (compatibility wrapper)
 */
export function parseWorkflow(markdown) {
    const doc = parseWorkflowDocument(markdown);
    return [...doc.steps];
}
/**
 * Parse entire workflow document including metadata
 */
export function parseWorkflowDocument(markdown, filename, options) {
    const { frontmatter, content } = extractFrontmatter(markdown);
    const tree = fromMarkdown(content);
    const steps = [];
    let title;
    let preamble = '';
    let currentStep = null;
    let pendingConditionals = [];
    let implicitText = '';
    let inPreamble = true;
    const finalizePendingSubstep = () => {
        if (currentStep?.pendingSubstep) {
            const ps = currentStep.pendingSubstep;
            const workflows = extractWorkflowList(ps.content);
            // Validate NEXT usage before converting to transitions
            validateNEXTUsage(ps.pendingConditionals, currentStep.isDynamic);
            const transitions = convertToTransitions(ps.pendingConditionals);
            const prompts = [...ps.prompts];
            if (ps.content.trim()) {
                const contentWithoutWorkflows = ps.content
                    .split('\n')
                    .filter(line => !line.trim().startsWith('-') || !line.includes('.runbook.md'))
                    .join('\n')
                    .trim();
                if (contentWithoutWorkflows) {
                    prompts.push({ text: contentWithoutWorkflows });
                }
            }
            const substep = {
                id: ps.id,
                description: ps.description,
                agentType: ps.agentType,
                isDynamic: ps.isDynamic,
                command: ps.command,
                prompts: prompts,
                transitions: transitions ?? undefined,
                workflows: workflows.length > 0 ? workflows : undefined,
                line: ps.line
            };
            currentStep.substeps.push(substep);
            currentStep.pendingSubstep = undefined;
        }
    };
    visit(tree, (node, _index, parent) => {
        if (isHeading(node) && node.depth === 1) {
            const headingText = extractText(node);
            const looksLikeStep = /^\d+[.:\-)\s]/.test(headingText);
            if (looksLikeStep) {
                throw new WorkflowSyntaxError(`H1 headers (# ...) cannot be used as step headers. Use H2 (## ${headingText}) instead.`);
            }
            title ??= headingText;
        }
        if (isHeading(node) && node.depth >= 4) {
            throw new WorkflowSyntaxError(`H4+ headings are not allowed in workflows. Found heading at depth ${String(node.depth)}. Use ## for steps and ### for substeps only.`);
        }
        if (isHeading(node) && node.depth === 2) {
            inPreamble = false;
            finalizePendingSubstep();
            if (currentStep) {
                steps.push(finalizeStep(currentStep, pendingConditionals, implicitText));
                pendingConditionals = [];
                implicitText = '';
            }
            const headingText = extractText(node);
            const parsed = extractStepHeader(headingText);
            if (parsed) {
                currentStep = {
                    number: parsed.number,
                    isDynamic: parsed.isDynamic,
                    description: parsed.description,
                    prompts: [],
                    substeps: [],
                    content: '',
                    line: node.position?.start.line
                };
            }
        }
        if (isHeading(node) && node.depth === 3 && currentStep) {
            inPreamble = false;
            if (currentStep.pendingSubstep) {
                currentStep.pendingSubstep.pendingConditionals.push(...pendingConditionals);
                pendingConditionals = [];
            }
            finalizePendingSubstep();
            const headingText = extractText(node);
            const parsed = extractSubstepHeader(headingText);
            if (parsed) {
                if (currentStep.isDynamic) {
                    if (parsed.stepRef !== '{N}') {
                        throw new WorkflowSyntaxError(`Substep ${headingText} uses numeric prefix but parent step is dynamic ({N})`);
                    }
                }
                else {
                    if (parsed.stepRef === '{N}') {
                        throw new WorkflowSyntaxError(`Substep ${headingText} uses {N} prefix but parent step ${String(currentStep.number)} is static`);
                    }
                    if (parsed.stepRef !== currentStep.number) {
                        throw new WorkflowSyntaxError(`Substep ${headingText} does not belong to step ${String(currentStep.number)}`);
                    }
                }
                const duplicateId = currentStep.substeps.find((s) => s.id === parsed.id);
                if (duplicateId) {
                    const stepLabel = currentStep.isDynamic ? '{N}' : String(currentStep.number);
                    throw new WorkflowSyntaxError(`Duplicate substep ID '${parsed.id}' in step ${stepLabel}`);
                }
                const hasStatic = currentStep.substeps.some((s) => !s.isDynamic);
                const hasDynamic = currentStep.substeps.some((s) => s.isDynamic);
                if ((hasStatic && parsed.isDynamic) || (hasDynamic && !parsed.isDynamic)) {
                    const stepLabel = currentStep.isDynamic ? '{N}' : String(currentStep.number);
                    throw new WorkflowSyntaxError(`Cannot mix static and dynamic substeps in step ${stepLabel}`);
                }
                currentStep.pendingSubstep = {
                    id: parsed.id,
                    description: parsed.description,
                    agentType: parsed.agentType,
                    isDynamic: parsed.isDynamic,
                    content: '',
                    command: undefined,
                    prompts: [],
                    pendingConditionals: [],
                    line: node.position?.start.line
                };
            }
        }
        if (node.type === 'code' && currentStep) {
            const codeNode = node;
            const prompted = isPromptedCodeBlock(codeNode.lang);
            if (prompted === null) {
                // Passive - preserve as prose with fences
                const promptText = '\n```' + (codeNode.lang ?? '') + '\n' + codeNode.value + '\n```\n';
                if (currentStep.pendingSubstep) {
                    currentStep.pendingSubstep.content += promptText;
                }
                else {
                    implicitText += promptText;
                }
            }
            else {
                // Command (executable or prompted)
                const cmd = prompted
                    ? { code: codeNode.value.trim(), prompted: true }
                    : { code: codeNode.value.trim() };
                if (currentStep.pendingSubstep) {
                    if (currentStep.pendingSubstep.command) {
                        throw new WorkflowSyntaxError(`Multiple code blocks per substep not allowed in substep ${currentStep.pendingSubstep.id}`);
                    }
                    currentStep.pendingSubstep.command = cmd;
                }
                else {
                    if (currentStep.command) {
                        const stepLabel = currentStep.isDynamic ? '{N}' : String(currentStep.number);
                        throw new WorkflowSyntaxError(`Multiple code blocks per step not allowed in Step ${stepLabel}.`);
                    }
                    currentStep.command = cmd;
                }
            }
        }
        if (node.type === 'paragraph' && parent && parent.type !== 'listItem') {
            const paragraphNode = node;
            const text = extractText(paragraphNode);
            if (inPreamble) {
                preamble += text + '\n';
                return;
            }
            if (currentStep) {
                const lines = text.split('\n');
                let hasConditional = false;
                for (const line of lines) {
                    const conditional = parseConditional(line);
                    if (conditional) {
                        if (currentStep.pendingSubstep) {
                            currentStep.pendingSubstep.pendingConditionals.push(conditional);
                        }
                        else {
                            pendingConditionals.push(conditional);
                        }
                        hasConditional = true;
                    }
                    else if (line.trim()) {
                        if (currentStep.pendingSubstep) {
                            currentStep.pendingSubstep.content += line.trim() + '\n';
                        }
                        else {
                            implicitText += line.trim() + '\n';
                        }
                    }
                }
                if (hasConditional) {
                    return;
                }
            }
        }
        if (node.type === 'listItem' && currentStep) {
            const listItemNode = node;
            const firstParagraph = listItemNode.children.find((c) => c.type === 'paragraph');
            if (firstParagraph) {
                const text = extractText(firstParagraph);
                const conditional = parseConditional(text);
                if (conditional) {
                    if (currentStep.pendingSubstep) {
                        currentStep.pendingSubstep.pendingConditionals.push(conditional);
                    }
                    else {
                        pendingConditionals.push(conditional);
                    }
                }
                else if (currentStep.pendingSubstep) {
                    currentStep.pendingSubstep.content += ' - ' + text + '\n';
                }
                else {
                    const itemText = ' - ' + text + '\n';
                    currentStep.content += itemText;
                    if (!/^\S+\.runbook\.md$/.test(text.trim())) {
                        implicitText += itemText;
                    }
                }
            }
        }
    });
    finalizePendingSubstep();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- currentStep changes in the loop
    if (currentStep) {
        steps.push(finalizeStep(currentStep, pendingConditionals, implicitText));
    }
    if (!options?.skipValidation) {
        const errors = validateWorkflow(steps);
        if (errors.length > 0) {
            // For backwards compatibility, throw the first error
            throw new WorkflowSyntaxError(errors[0].message);
        }
    }
    return {
        title,
        description: preamble.trim() || undefined,
        name: frontmatter?.name ?? (filename ? nameFromFilename(filename) : undefined),
        version: frontmatter?.version,
        author: frontmatter?.author,
        tags: frontmatter?.tags,
        steps
    };
}
function finalizeStep(step, pendingConditionals, implicitText) {
    const prompts = [...step.prompts];
    if (implicitText.trim()) {
        prompts.push({ text: implicitText.trim() });
    }
    // Validate NEXT usage before converting to transitions
    validateNEXTUsage(pendingConditionals, step.isDynamic);
    const transitions = convertToTransitions(pendingConditionals);
    const workflows = extractWorkflowList(step.content);
    return {
        number: step.number,
        isDynamic: step.isDynamic,
        description: step.description,
        command: step.command,
        prompts: prompts,
        transitions: transitions ?? undefined,
        substeps: step.substeps.length > 0 ? step.substeps : undefined,
        workflows: workflows.length > 0 ? workflows : undefined,
        line: step.line
    };
}
//# sourceMappingURL=parser.js.map