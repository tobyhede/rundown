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
  promptText: string;
  hasSeenContent: boolean;
  hasSeenTransitions: boolean;
  pendingConditionals: ParsedConditional[];
  line?: number;
}

interface StepBuilder {
  name: string;
  isDynamic: boolean;
  description: string;
  command?: Command;
  promptText: string;
  hasSeenContent: boolean;
  substeps: Substep[];
  pendingSubstep?: SubstepBuilder;
  content: string;
  line?: number;
}

/**
 * Parse workflow markdown into Step array (compatibility wrapper).
 *
 * This is a simplified entry point that returns only the steps array,
 * discarding workflow metadata. For full document parsing including
 * title, description, and frontmatter, use {@link parseWorkflowDocument}.
 *
 * @param markdown - The raw markdown content to parse
 * @returns Array of parsed Step objects representing the workflow
 * @see parseWorkflowDocument for full workflow parsing with metadata
 */
export function parseWorkflow(markdown: string): Step[] {
  const doc = parseWorkflowDocument(markdown);
  return [...doc.steps];
}

/**
 * Options for controlling workflow parsing behavior.
 */
export interface ParseOptions {
  /** If true, skip validation and don't throw on errors */
  skipValidation?: boolean;
}

/**
 * Parse entire workflow document including metadata.
 *
 * Parses a complete Rundown workflow markdown document, extracting:
 * - YAML frontmatter (name, version, author, tags)
 * - H1 title and preamble description
 * - H2 step definitions with commands, prompts, and transitions
 * - H3 substep definitions
 * - Workflow references (nested runbook lists)
 *
 * @param markdown - The raw markdown content to parse
 * @param filename - Optional filename used to derive workflow name if not in frontmatter
 * @param options - Optional parsing options (e.g., skipValidation)
 * @returns Complete Workflow object with metadata and steps
 * @throws {WorkflowSyntaxError} When the markdown contains invalid syntax,
 *   such as H4+ headings, duplicate substep IDs, multiple code blocks per step,
 *   or other specification violations
 * @see parseWorkflow for simplified parsing returning only steps
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
      validateNEXTUsage(ps.pendingConditionals, currentStep.isDynamic, ps.isDynamic);

      const transitions = convertToTransitions(ps.pendingConditionals);

      // Build prompt from promptText and remaining content
      let promptText = ps.promptText;
      if (ps.content.trim()) {
        const contentWithoutWorkflows = ps.content
          .split('\n')
          .filter(line => !line.trim().startsWith('-') || !line.includes('.runbook.md'))
          .join('\n')
          .trim();
        if (contentWithoutWorkflows) {
          promptText += contentWithoutWorkflows + '\n';
        }
      }

      const substep: Substep = {
        id: ps.id,
        description: ps.description,
        agentType: ps.agentType,
        isDynamic: ps.isDynamic,
        command: ps.command,
        prompt: promptText.trim() || undefined,
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
          name: parsed.name,
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
              `Substep ${headingText} uses {N} prefix but parent step ${currentStep.name} is static`
            );
          }
          if (parsed.stepRef !== currentStep.name) {
            throw new WorkflowSyntaxError(
              `Substep ${headingText} does not belong to step ${currentStep.name}`
            );
          }
        }

        const duplicateId = currentStep.substeps.find((s) => s.id === parsed.id);
        if (duplicateId) {
          const stepLabel = currentStep.name;
          throw new WorkflowSyntaxError(
            `Duplicate substep ID '${parsed.id}' in step ${stepLabel}`
          );
        }

        const hasStatic = currentStep.substeps.some((s) => !s.isDynamic);
        const hasDynamic = currentStep.substeps.some((s) => s.isDynamic);
        if ((hasStatic && parsed.isDynamic) || (hasDynamic && !parsed.isDynamic)) {
          const stepLabel = currentStep.name;
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
          hasSeenTransitions: false,
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
            const stepLabel = currentStep.name;
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
              // Mark that we've seen a transition in the substep
              currentStep.pendingSubstep.hasSeenTransitions = true;
            } else {
              pendingConditionals.push(conditional);
              // Mark that we've seen a transition in the step
              currentStep.hasSeenContent = true;
            }
            hasConditional = true;
          } else if (line.trim()) {
            // NEW: Check ordering - text must come before content
            if (currentStep.pendingSubstep) {
              // In substeps: text cannot appear after transitions, but CAN appear after code blocks
              if (currentStep.pendingSubstep.hasSeenTransitions) {
                const stepLabel = currentStep.name;
                // E17-R2: Include line number in error for better DX
                const lineNum = node.position?.start.line ? ` (line ${String(node.position.start.line)})` : '';
                throw new WorkflowSyntaxError(
                  `Substep ${stepLabel}.${currentStep.pendingSubstep.id}${lineNum}: Prompt text must appear before code blocks or runbooks.`
                );
              }
              currentStep.pendingSubstep.promptText += line.trim() + '\n';
            } else {
              if (currentStep.hasSeenContent) {
                const stepLabel = currentStep.name;
                // E17-R2: Include line number in error for better DX
                const lineNum = node.position?.start.line ? ` (line ${String(node.position.start.line)})` : '';
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
            // Mark that we've seen a transition in the substep
            currentStep.pendingSubstep.hasSeenTransitions = true;
          } else {
            pendingConditionals.push(conditional);
            // Mark that we've seen a transition in the step
            currentStep.hasSeenContent = true;
          }
        } else if (currentStep.pendingSubstep) {
          // FIXED: Check ordering BEFORE adding content (C2 fix)
          const isRunbookRef = /^\S+\.runbook\.md$/.test(text.trim());
          // In substeps: text cannot appear after transitions
          if (currentStep.pendingSubstep.hasSeenTransitions && !isRunbookRef) {
            const stepLabel = currentStep.name;
            // E17-R2: Include line number in error for better DX
            const lineNum = node.position?.start.line ? ` (line ${String(node.position.start.line)})` : '';
            throw new WorkflowSyntaxError(
              `Substep ${stepLabel}.${currentStep.pendingSubstep.id}${lineNum}: Prompt text must appear before code blocks or runbooks.`
            );
          }
          // Only add content after validation passes
          currentStep.pendingSubstep.content += ' - ' + text + '\n';
          // Mark content seen if workflow list
          if (isRunbookRef) {
            currentStep.pendingSubstep.hasSeenContent = true;
          }
        } else {
          // FIXED: Check ordering BEFORE adding content (C2 fix)
          const isRunbookRef = /^\S+\.runbook\.md$/.test(text.trim());
          if (currentStep.hasSeenContent && !isRunbookRef) {
            const stepLabel = currentStep.name;
            // E17-R2: Include line number in error for better DX
            const lineNum = node.position?.start.line ? ` (line ${String(node.position.start.line)})` : '';
            throw new WorkflowSyntaxError(
              `Step ${stepLabel}${lineNum}: Prompt text must appear before code blocks, substeps, or runbooks.`
            );
          }
          // Only add content after validation passes
          const itemText = ' - ' + text + '\n';
          currentStep.content += itemText;
          if (!isRunbookRef) {
            implicitText += itemText;
          } else {
            // Mark content seen if workflow list
            currentStep.hasSeenContent = true;
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
  // Build single prompt string
  let promptText = step.promptText;
  if (implicitText.trim()) {
    promptText += implicitText.trim();
  }

  // Validate NEXT usage before converting to transitions
  validateNEXTUsage(pendingConditionals, step.isDynamic);

  const transitions = convertToTransitions(pendingConditionals);
  const workflows = extractWorkflowList(step.content);

  return {
    name: step.name,
    isDynamic: step.isDynamic,
    description: step.description,
    command: step.command,
    prompt: promptText.trim() || undefined,
    transitions: transitions ?? undefined,
    substeps: step.substeps.length > 0 ? step.substeps : undefined,
    workflows: workflows.length > 0 ? workflows : undefined,
    line: step.line
  };
}
