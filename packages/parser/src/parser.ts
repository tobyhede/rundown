import { fromMarkdown } from 'mdast-util-from-markdown';
import { visit } from 'unist-util-visit';
import type { Node } from 'unist';
import type {
  Code,
  Heading,
  ListItem,
  Paragraph,
  PhrasingContent
} from 'mdast';
import {
  type Step,
  type Substep,
  type Workflow,
  type Command
} from './ast.js';
import {
  type StepNumber,
  type ParsedConditional,
  WorkflowSyntaxError
} from './types.js';
import {
  extractStepHeader,
  extractSubstepHeader,
  parseConditional,
  convertToTransitions,
  extractWorkflowList,
  isExecutableCodeBlock,
  isPromptCodeBlock,
  escapeForShellSingleQuote,
  validateNEXTUsage
} from './helpers.js';
import { validateWorkflow } from './validator.js';
import { extractFrontmatter, nameFromFilename } from './frontmatter.js';

/**
 * Type guard to narrow Node to Heading
 */
function isHeading(node: Node): node is Heading {
  return node.type === 'heading' && 'depth' in node;
}

/**
 * Extract plain text from mdast node
 */
function extractText(node: PhrasingContent | Heading | Paragraph | ListItem): string {
  if (node.type === 'text') {
    return (node as { value: string }).value;
  }
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map((child) => extractText(child as PhrasingContent | Heading | Paragraph | ListItem)).join('');
  }
  return '';
}

interface SubstepBuilder {
  id: string;
  description: string;
  agentType?: string;
  isDynamic: boolean;
  content: string;
  command?: Command;
  promptText: string;  // Changed from prompts: Prompt[]
  hasSeenContent: boolean;  // New: track if we've seen code/runbooks
  pendingConditionals: ParsedConditional[];
  line?: number;
}

interface StepBuilder {
  number?: StepNumber;
  isDynamic: boolean;
  description: string;
  command?: Command;
  promptText: string;  // Changed from prompts: Prompt[]
  hasSeenContent: boolean;  // New: track if we've seen code/substeps/runbooks
  substeps: Substep[];
  pendingSubstep?: SubstepBuilder;
  content: string;
  line?: number;
}

/**
 * Parse workflow markdown into Step array (compatibility wrapper)
 */
export function parseWorkflow(markdown: string): Step[] {
  const doc = parseWorkflowDocument(markdown);
  return [...doc.steps];
}

export interface ParseOptions {
  /** If true, skip validation and don't throw on errors */
  skipValidation?: boolean;
}

/**
 * Parse entire workflow document including metadata
 */
export function parseWorkflowDocument(markdown: string, filename?: string, options?: ParseOptions): Workflow {
  const { frontmatter, content } = extractFrontmatter(markdown);
  const tree = fromMarkdown(content);

  const steps: Step[] = [];
  let title: string | undefined;
  let preamble = '';
  
  let currentStep: StepBuilder | null = null;
  let pendingConditionals: ParsedConditional[] = [];
  let implicitText = '';
  let inPreamble = true;

  const finalizePendingSubstep = (): void => {
    if (currentStep?.pendingSubstep) {
      const ps = currentStep.pendingSubstep;
      const workflows = extractWorkflowList(ps.content);

      // Validate NEXT usage before converting to transitions
      validateNEXTUsage(ps.pendingConditionals, currentStep.isDynamic);

      const transitions = convertToTransitions(ps.pendingConditionals);

      let prompt = ps.promptText;
      if (ps.content.trim()) {
        const contentWithoutWorkflows = ps.content
          .split('\n')
          .filter(line => !line.trim().startsWith('-') || !line.includes('.runbook.md'))
          .join('\n')
          .trim();
        if (contentWithoutWorkflows) {
          prompt = prompt ? prompt + '\n' + contentWithoutWorkflows : contentWithoutWorkflows;
        }
      }

      const substep: Substep = {
        id: ps.id,
        description: ps.description,
        agentType: ps.agentType,
        isDynamic: ps.isDynamic,
        command: ps.command,
        prompt: prompt || undefined,
        transitions: transitions ?? undefined,
        workflows: workflows.length > 0 ? workflows : undefined,
        line: ps.line
      };
      currentStep.substeps.push(substep);
      currentStep.pendingSubstep = undefined;
    }
  };

  visit(tree, (node: Node, _index, parent: Node | undefined) => {
    if (isHeading(node) && node.depth === 1) {
      const headingText = extractText(node);
      const looksLikeStep = /^\d+[.:\-)\s]/.test(headingText);
      if (looksLikeStep) {
        throw new WorkflowSyntaxError(
          `H1 headers (# ...) cannot be used as step headers. Use H2 (## ${headingText}) instead.`
        );
      }
      title ??= headingText;
    }

    if (isHeading(node) && node.depth >= 4) {
      throw new WorkflowSyntaxError(
        `H4+ headings are not allowed in workflows. Found heading at depth ${String(node.depth)}. Use ## for steps and ### for substeps only.`
      );
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
          promptText: '',
          hasSeenContent: false,
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

      // Mark that parent step has seen content (substeps count as content)
      currentStep.hasSeenContent = true;

      const headingText = extractText(node);
      const parsed = extractSubstepHeader(headingText);

      if (parsed) {
        if (currentStep.isDynamic) {
          if (parsed.stepRef !== '{N}') {
            throw new WorkflowSyntaxError(
              `Substep ${headingText} uses numeric prefix but parent step is dynamic ({N})`
            );
          }
        } else {
          if (parsed.stepRef === '{N}') {
            throw new WorkflowSyntaxError(
              `Substep ${headingText} uses {N} prefix but parent step ${String(currentStep.number)} is static`
            );
          }
          if (parsed.stepRef !== currentStep.number) {
            throw new WorkflowSyntaxError(
              `Substep ${headingText} does not belong to step ${String(currentStep.number)}`
            );
          }
        }

        const duplicateId = currentStep.substeps.find((s) => s.id === parsed.id);
        if (duplicateId) {
          const stepLabel = currentStep.isDynamic ? '{N}' : String(currentStep.number);
          throw new WorkflowSyntaxError(
            `Duplicate substep ID '${parsed.id}' in step ${stepLabel}`
          );
        }

        const hasStatic = currentStep.substeps.some((s) => !s.isDynamic);
        const hasDynamic = currentStep.substeps.some((s) => s.isDynamic);
        if ((hasStatic && parsed.isDynamic) || (hasDynamic && !parsed.isDynamic)) {
          const stepLabel = currentStep.isDynamic ? '{N}' : String(currentStep.number);
          throw new WorkflowSyntaxError(
            `Cannot mix static and dynamic substeps in step ${stepLabel}`
          );
        }

        currentStep.pendingSubstep = {
          id: parsed.id,
          description: parsed.description,
          agentType: parsed.agentType,
          isDynamic: parsed.isDynamic,
          content: '',
          command: undefined,
          promptText: '',
          hasSeenContent: false,
          pendingConditionals: [],
          line: node.position?.start.line
        };
      }
    }

    if (node.type === 'code' && currentStep) {
      const codeNode = node as Code;

      // Determine command based on code block type
      let cmd: Command | undefined;

      if (isExecutableCodeBlock(codeNode.lang)) {
        // bash/sh/shell → direct command
        cmd = { code: codeNode.value.trim() };
      } else if (isPromptCodeBlock(codeNode.lang)) {
        // prompt → rd prompt command (outputs with fences)
        const escaped = escapeForShellSingleQuote(codeNode.value.trim());
        cmd = { code: `rd prompt '${escaped}'` };
      }
      // Other code blocks (json, etc.) are ignored - not valid in runbooks

      if (cmd) {
        if (currentStep.pendingSubstep) {
          if (currentStep.pendingSubstep.command) {
            throw new WorkflowSyntaxError(
              `Multiple code blocks per substep not allowed in substep ${currentStep.pendingSubstep.id}`
            );
          }
          currentStep.pendingSubstep.command = cmd;
          currentStep.pendingSubstep.hasSeenContent = true;
        } else {
          if (currentStep.command) {
            const stepLabel = currentStep.isDynamic ? '{N}' : String(currentStep.number);
            throw new WorkflowSyntaxError(
              `Multiple code blocks per step not allowed in Step ${stepLabel}.`
            );
          }
          currentStep.command = cmd;
          currentStep.hasSeenContent = true;
        }
      }
    }

    if (node.type === 'paragraph' && parent && parent.type !== 'listItem') {
      const paragraphNode = node as Paragraph;
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
            } else {
              pendingConditionals.push(conditional);
            }
            hasConditional = true;
          } else if (line.trim()) {
            // NEW: Check ordering - text must come before content
            if (currentStep.pendingSubstep) {
              if (currentStep.pendingSubstep.hasSeenContent) {
                const stepLabel = currentStep.isDynamic ? '{N}' : String(currentStep.number);
                // E17-R2: Include line number in error for better DX
                const lineNum = node.position?.start.line ? ` (line ${node.position.start.line})` : '';
                throw new WorkflowSyntaxError(
                  `Substep ${stepLabel}.${currentStep.pendingSubstep.id}${lineNum}: Prompt text must appear before code blocks or runbooks.`
                );
              }
              currentStep.pendingSubstep.promptText += line.trim() + '\n';
            } else {
              if (currentStep.hasSeenContent) {
                const stepLabel = currentStep.isDynamic ? '{N}' : String(currentStep.number);
                // E17-R2: Include line number in error for better DX
                const lineNum = node.position?.start.line ? ` (line ${node.position.start.line})` : '';
                throw new WorkflowSyntaxError(
                  `Step ${stepLabel}${lineNum}: Prompt text must appear before code blocks, substeps, or runbooks.`
                );
              }
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
      const listItemNode = node as ListItem;
      const firstParagraph = listItemNode.children.find((c) => c.type === 'paragraph');
      if (firstParagraph) {
        const text = extractText(firstParagraph as PhrasingContent | Heading | Paragraph | ListItem);
        const conditional = parseConditional(text);
        if (conditional) {
          if (currentStep.pendingSubstep) {
            currentStep.pendingSubstep.pendingConditionals.push(conditional);
          } else {
            pendingConditionals.push(conditional);
          }
        } else if (currentStep.pendingSubstep) {
          currentStep.pendingSubstep.content += ' - ' + text + '\n';
        } else {
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

function finalizeStep(
  step: StepBuilder,
  pendingConditionals: ParsedConditional[],
  implicitText: string
): Step {
  let prompt = step.promptText;
  if (implicitText.trim()) {
    prompt = prompt ? prompt + '\n' + implicitText.trim() : implicitText.trim();
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
    prompt: prompt || undefined,
    transitions: transitions ?? undefined,
    substeps: step.substeps.length > 0 ? step.substeps : undefined,
    workflows: workflows.length > 0 ? workflows : undefined,
    line: step.line
  };
}
