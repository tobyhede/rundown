import { fromMarkdown } from 'mdast-util-from-markdown';
import { visit, SKIP } from 'unist-util-visit';
import type { Node } from 'unist';
import type { Code, Heading, List, ListItem, Paragraph, PhrasingContent } from 'mdast';
import type { Step, Substep, Runbook, Command, ForClause } from './ast.js';
import { type ParsedConditional, RunbookSyntaxError } from './types.js';
import {
  extractStepHeader,
  extractSubstepHeader,
  parseConditional,
  convertToTransitions,
  extractRunbookList,
  isExecutableCodeBlock,
  isPromptCodeBlock,
  escapeForShellSingleQuote,
  validateNEXTUsage,
  parseForClause,
} from './helpers.js';
import { validateRunbook } from './validator.js';
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
  if (node.type === 'inlineCode') {
    const value = (node as { value: string }).value;
    // Use double-backtick wrapping per CommonMark spec for inline code containing backticks
    // This avoids the need to escape backticks and is more readable
    if (value.includes('`')) {
      return `\`\` ${value} \`\``;
    }
    return `\`${value}\``;
  }
  if ('children' in node && Array.isArray(node.children)) {
    return node.children
      .map((child) => extractText(child as PhrasingContent | Heading | Paragraph | ListItem))
      .join('');
  }
  return '';
}

interface SubstepBuilder {
  id: string;
  description: string;
  content: string;
  command?: Command;
  promptText: string;
  hasSeenContent: boolean;
  hasSeenTransitions: boolean;
  hasSeenPromptText: boolean;
  pendingConditionals: ParsedConditional[];
  line?: number;
}

interface StepBuilder {
  name: string;
  description: string;
  command?: Command;
  promptText: string;
  hasSeenContent: boolean;
  hasSeenTransitions: boolean;
  hasSeenPromptText: boolean;
  substeps: Substep[];
  pendingSubstep?: SubstepBuilder;
  content: string;
  line?: number;
  forClause?: ForClause;
  hasSeenForClause: boolean;
  forConditionals?: ParsedConditional[];
  invalidH3s: Array<{ line: number; text: string }>;
}

/**
 * Parse runbook markdown into Step array (compatibility wrapper).
 *
 * This is a simplified entry point that returns only the steps array,
 * discarding runbook metadata. For full document parsing including
 * title, description, and frontmatter, use {@link parseRunbookDocument}.
 *
 * @param markdown - The raw markdown content to parse
 * @returns Array of parsed Step objects representing the runbook
 * @see parseRunbookDocument for full runbook parsing with metadata
 */
export function parseRunbook(markdown: string): Step[] {
  const doc = parseRunbookDocument(markdown);
  return [...doc.steps];
}

/**
 * Options for controlling runbook parsing behavior.
 */
export interface ParseOptions {
  /** If true, skip validation and don't throw on errors */
  skipValidation?: boolean;
}

/**
 * Parse a Runbook markdown document into a Runbook object containing metadata and steps.
 *
 * @param filename - Optional filename used to derive the runbook `name` when frontmatter `name` is absent
 * @param options - Optional parsing options; if `options.skipValidation` is true, schema validation is not performed
 * @returns A Runbook containing extracted metadata (title, description, name, version, author, tags) and the parsed steps
 * @throws {RunbookSyntaxError} When the markdown violates runbook syntax (for example: H4+ headings, invalid H1/H2/H3 usage, duplicate substep IDs, ordering violations, or multiple disallowed code blocks)
 */
export function parseRunbookDocument(
  markdown: string,
  filename?: string,
  options?: ParseOptions,
): Runbook {
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
      const runbooks = extractRunbookList(ps.content);

      // Validate NEXT usage before converting to transitions
      validateNEXTUsage(ps.pendingConditionals, currentStep.forClause !== undefined);

      const transitions = convertToTransitions(ps.pendingConditionals);

      // Build prompt from promptText and remaining content
      let promptText = ps.promptText;
      if (ps.content.trim()) {
        const contentWithoutRunbooks = ps.content
          .split('\n')
          .filter((line) => !line.trim().startsWith('-') || !line.includes('.runbook.md'))
          .join('\n')
          .trim();
        if (contentWithoutRunbooks) {
          promptText += `${contentWithoutRunbooks}\n`;
        }
      }

      const substep: Substep = {
        id: ps.id,
        description: ps.description,
        command: ps.command,
        prompt: promptText.trim() || undefined,
        transitions: transitions ?? undefined,
        runbooks: runbooks.length > 0 ? runbooks : undefined,
        line: ps.line,
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
        throw new RunbookSyntaxError(
          `H1 headers (# ...) cannot be used as step headers. Use H2 (## ${headingText}) instead.`,
        );
      }
      title ??= headingText;
    }

    if (isHeading(node) && node.depth >= 4) {
      throw new RunbookSyntaxError(
        `H4+ headings are not allowed in runbooks. Found heading at depth ${String(node.depth)}. Use ## for steps and ### for substeps only.`,
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
          description: parsed.description,
          promptText: '',
          hasSeenContent: false,
          hasSeenTransitions: false,
          hasSeenPromptText: false,
          substeps: [],
          content: '',
          line: node.position?.start.line,
          hasSeenForClause: false,
          invalidH3s: [],
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
        // Mark that parent step has seen content (substeps count as content)
        currentStep.hasSeenContent = true;
        if (parsed.stepRef !== undefined && parsed.stepRef !== currentStep.name) {
          throw new RunbookSyntaxError(
            `Substep ${headingText} does not belong to step ${currentStep.name}`,
          );
        }

        const duplicateId = currentStep.substeps.find((s) => s.id === parsed.id);
        if (duplicateId) {
          const stepLabel = currentStep.name;
          throw new RunbookSyntaxError(`Duplicate substep ID '${parsed.id}' in step ${stepLabel}`);
        }

        currentStep.pendingSubstep = {
          id: parsed.id,
          description: parsed.description,
          content: '',
          command: undefined,
          promptText: '',
          hasSeenContent: false,
          hasSeenTransitions: false,
          hasSeenPromptText: false,
          pendingConditionals: [],
          line: node.position?.start.line,
        };
      } else {
        currentStep.invalidH3s.push({
          line: node.position?.start.line ?? 0,
          text: headingText,
        });
      }
    }

    if (node.type === 'code' && currentStep) {
      const codeNode = node as Code;

      // mdast splits the code fence info string on the first space:
      //   ```bash prompt  →  lang: "bash", meta: "prompt"
      // Reconstruct the full string so isExecutableCodeBlock/isPromptCodeBlock
      // can check multi-word patterns like "bash prompt".
      const fullLang =
        codeNode.lang && codeNode.meta ? `${codeNode.lang} ${codeNode.meta}` : codeNode.lang;

      // Determine command based on code block type
      let cmd: Command | undefined;

      if (isExecutableCodeBlock(fullLang)) {
        // bash/sh/shell → direct command
        cmd = {
          code: codeNode.value.trim(),
          lang: codeNode.lang?.split(/\s+/)[0],
        };
      } else if (isPromptCodeBlock(fullLang)) {
        // prompt → rd prompt command (outputs with fences)
        const escaped = escapeForShellSingleQuote(codeNode.value.trim());
        cmd = {
          code: `rd prompt '${escaped}'`,
          lang: 'prompt',
        };
      }

      if (cmd) {
        if (currentStep.pendingSubstep) {
          if (currentStep.pendingSubstep.command) {
            throw new RunbookSyntaxError(
              `Multiple code blocks per substep not allowed in substep ${currentStep.pendingSubstep.id}`,
            );
          }
          currentStep.pendingSubstep.command = cmd;
          currentStep.pendingSubstep.hasSeenContent = true;
        } else {
          if (currentStep.command) {
            const stepLabel = currentStep.name;
            throw new RunbookSyntaxError(
              `Multiple code blocks per step not allowed in Step ${stepLabel}.`,
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
        preamble += `${text}\n`;
        return;
      }

      if (currentStep) {
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.trim()) {
            // Paragraphs are always treated as prompt text — transitions must use bullet-prefix (list items)
            // Check ordering - text must come before content (code blocks, runbooks)
            if (currentStep.pendingSubstep) {
              // In substeps: text cannot appear after code blocks/runbooks
              if (currentStep.pendingSubstep.hasSeenContent) {
                const stepLabel = currentStep.name;
                // E17-R2: Include line number in error for better DX
                const lineNum = node.position?.start.line
                  ? ` (line ${String(node.position.start.line)})`
                  : '';
                throw new RunbookSyntaxError(
                  `Substep ${stepLabel}.${currentStep.pendingSubstep.id}${lineNum}: Prompt text must appear before code blocks or runbooks.`,
                );
              }
              currentStep.pendingSubstep.promptText += `${line.trim()}\n`;
              currentStep.pendingSubstep.hasSeenPromptText = true;
            } else {
              if (currentStep.hasSeenContent) {
                const stepLabel = currentStep.name;
                // E17-R2: Include line number in error for better DX
                const lineNum = node.position?.start.line
                  ? ` (line ${String(node.position.start.line)})`
                  : '';
                throw new RunbookSyntaxError(
                  `Step ${stepLabel}${lineNum}: Prompt text must appear before code blocks, substeps, or runbooks.`,
                );
              }
              implicitText += `${line.trim()}\n`;
              currentStep.hasSeenPromptText = true;
            }
          }
        }
      }
    }

    if (node.type === 'listItem' && currentStep) {
      const listItemNode = node as ListItem;
      const firstParagraph = listItemNode.children.find((c) => c.type === 'paragraph');
      if (firstParagraph) {
        const text = extractText(
          firstParagraph as PhrasingContent | Heading | Paragraph | ListItem,
        );

        // Check for FOR clause BEFORE conditionals
        const forClause = parseForClause(text);
        if (forClause && !currentStep.pendingSubstep) {
          // FOR is only valid at step level, not substep level
          // Enforce: only one FOR per step
          if (currentStep.hasSeenForClause) {
            throw new RunbookSyntaxError(
              `Step "${currentStep.name}" has multiple FOR clauses; only one is allowed`,
            );
          }
          // Enforce ordering: FOR must appear before transitions and content
          if (currentStep.hasSeenTransitions) {
            throw new RunbookSyntaxError(
              `Step "${currentStep.name}": FOR clause must appear before transitions`,
            );
          }
          if (currentStep.hasSeenContent || currentStep.hasSeenPromptText) {
            throw new RunbookSyntaxError(
              `Step "${currentStep.name}": FOR clause must appear before content`,
            );
          }
          currentStep.forClause = forClause;
          currentStep.hasSeenForClause = true;

          // Check for nested list (FOR-level transitions)
          const nestedList = listItemNode.children.find((c): c is List => c.type === 'list');
          if (nestedList) {
            const forConditionals: ParsedConditional[] = [];
            for (const nestedItem of nestedList.children) {
              const nestedParagraph = nestedItem.children.find((c) => c.type === 'paragraph');
              if (!nestedParagraph) {
                throw new RunbookSyntaxError(
                  `Invalid nested bullet under FOR clause in step "${currentStep.name}": only transitions (PASS/FAIL) are allowed`,
                );
              }
              const nestedText = extractText(
                nestedParagraph as PhrasingContent | Heading | Paragraph | ListItem,
              );
              const cond = parseConditional(nestedText);
              if (!cond) {
                throw new RunbookSyntaxError(
                  `Invalid nested bullet under FOR clause in step "${currentStep.name}": only transitions (PASS/FAIL) are allowed`,
                );
              }
              forConditionals.push(cond);
            }
            if (forConditionals.length > 0) {
              currentStep.forConditionals = forConditionals;
            }
          }
          return SKIP; // Don't process this list item further
        }

        // If FOR text appears in a substep context, that's an error
        if (forClause && currentStep.pendingSubstep) {
          throw new RunbookSyntaxError(
            `FOR is only valid on steps (H2), not substeps (H3) (found on "${currentStep.name}.${currentStep.pendingSubstep.id}")`,
          );
        }

        const conditional = parseConditional(text);
        if (conditional) {
          if (currentStep.pendingSubstep) {
            // Reject transitions after prompt text or content (header-adjacent requirement)
            if (
              currentStep.pendingSubstep.hasSeenPromptText ||
              currentStep.pendingSubstep.hasSeenContent
            ) {
              const stepLabel = currentStep.name;
              const lineNum = node.position?.start.line
                ? ` (line ${String(node.position.start.line)})`
                : '';
              throw new RunbookSyntaxError(
                `Substep ${stepLabel}.${currentStep.pendingSubstep.id}${lineNum}: Transitions must appear immediately after the substep header, before any content.`,
              );
            }
            currentStep.pendingSubstep.pendingConditionals.push(conditional);
            currentStep.pendingSubstep.hasSeenTransitions = true;
          } else {
            // Reject transitions after prompt text or content (header-adjacent requirement)
            if (currentStep.hasSeenPromptText || currentStep.hasSeenContent) {
              const stepLabel = currentStep.name;
              const lineNum = node.position?.start.line
                ? ` (line ${String(node.position.start.line)})`
                : '';
              throw new RunbookSyntaxError(
                `Step ${stepLabel}${lineNum}: Transitions must appear immediately after the step header, before any content.`,
              );
            }
            pendingConditionals.push(conditional);
            currentStep.hasSeenTransitions = true;
          }
        } else if (currentStep.pendingSubstep) {
          // FIXED: Check ordering BEFORE adding content (C2 fix)
          const isRunbookRef = /^\S+\.runbook\.md$/.test(text.trim());
          // In substeps: text cannot appear after transitions
          if (currentStep.pendingSubstep.hasSeenTransitions && !isRunbookRef) {
            const stepLabel = currentStep.name;
            // E17-R2: Include line number in error for better DX
            const lineNum = node.position?.start.line
              ? ` (line ${String(node.position.start.line)})`
              : '';
            throw new RunbookSyntaxError(
              `Substep ${stepLabel}.${currentStep.pendingSubstep.id}${lineNum}: Prompt text must appear before code blocks or runbooks.`,
            );
          }
          // Only add content after validation passes
          currentStep.pendingSubstep.content += ` - ${text}\n`;
          // Mark content seen if runbook list
          if (isRunbookRef) {
            currentStep.pendingSubstep.hasSeenContent = true;
          }
        } else {
          // FIXED: Check ordering BEFORE adding content (C2 fix)
          const isRunbookRef = /^\S+\.runbook\.md$/.test(text.trim());
          if (currentStep.hasSeenContent && !isRunbookRef) {
            const stepLabel = currentStep.name;
            // E17-R2: Include line number in error for better DX
            const lineNum = node.position?.start.line
              ? ` (line ${String(node.position.start.line)})`
              : '';
            throw new RunbookSyntaxError(
              `Step ${stepLabel}${lineNum}: Prompt text must appear before code blocks, substeps, or runbooks.`,
            );
          }
          // Only add content after validation passes
          const itemText = ` - ${text}\n`;
          currentStep.content += itemText;
          if (!isRunbookRef) {
            implicitText += itemText;
          } else {
            // Mark content seen if runbook list
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
    const diagnostics = validateRunbook(steps);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      // For backwards compatibility, throw the first error
      throw new RunbookSyntaxError(errors[0].message);
    }
  }

  return {
    title,
    description: preamble.trim() || undefined,
    name: frontmatter?.name ?? (filename ? nameFromFilename(filename) : undefined),
    version: frontmatter?.version,
    author: frontmatter?.author,
    tags: frontmatter?.tags,
    steps,
  };
}

/**
 * Finalizes a StepBuilder into a concrete Step, converting pending conditionals and runbook lists and enforcing syntactic rules.
 *
 * Combines the step's prompt text with any implicit text, validates NEXT usage, converts pending conditionals (and any FOR conditionals) into transitions, enforces H3/substep validity, and canonicalizes step-level runbook list entries into synthetic substeps when present.
 *
 * @param step - The mutable StepBuilder to finalize into an immutable Step
 * @param pendingConditionals - Parsed conditional clauses attached to the step that will be converted into transitions
 * @param implicitText - Additional prompt text collected implicitly (appended to the step's explicit prompt text)
 * @returns A finalized Step object suitable for inclusion in the Runbook model
 * @throws RunbookSyntaxError - If the step contains substeps but also has unrecognized H3 headers
 * @throws RunbookSyntaxError - If a step-level runbook list is present together with a body command or explicit substeps (violates exclusivity)
 */
function finalizeStep(
  step: StepBuilder,
  pendingConditionals: ParsedConditional[],
  implicitText: string,
): Step {
  // Build single prompt string
  let promptText = step.promptText;
  if (implicitText.trim()) {
    promptText += implicitText.trim();
  }

  // Validate NEXT usage before converting to transitions
  validateNEXTUsage(pendingConditionals, step.forClause !== undefined);

  const transitions = convertToTransitions(pendingConditionals);

  if (step.forClause && step.forConditionals?.length) {
    const forTrans = convertToTransitions(step.forConditionals);
    if (forTrans) {
      step.forClause = { ...step.forClause, transitions: forTrans };
    }
  }

  // Strict H3 validation: if a step has valid substeps, all H3s must be valid substep identifiers
  if (step.substeps.length > 0 && step.invalidH3s.length > 0) {
    const lines = step.invalidH3s.map((h) => `line ${String(h.line)}: "${h.text}"`).join(', ');
    throw new RunbookSyntaxError(
      `Step "${step.name}" has substeps but also has unrecognized H3 headers (${lines}). ` +
        `When a step contains substeps, all H3 headers must be valid substep identifiers.`,
    );
  }

  const runbooks = extractRunbookList(step.content);
  const prompt = promptText.trim() || undefined;

  // Step-level runbook lists are syntax sugar for implicit substeps.
  if (runbooks.length > 0) {
    if (step.command || step.substeps.length > 0) {
      throw new RunbookSyntaxError(
        `Step ${step.name}: Violates Exclusivity Rule. A step must have exactly one of {Body, Substeps}.`,
      );
    }
    // Canonicalize each step-level runbook bullet into its own synthetic substep.
    // To avoid repeating step-level prompt text for every synthetic substep, attach it
    // only to the first generated substep.
    const syntheticSubsteps: Substep[] = runbooks.map((runbookPath, index) => ({
      id: String(index + 1),
      description: '',
      prompt: index === 0 ? prompt : undefined,
      runbooks: [runbookPath],
      line: step.line,
    }));

    return {
      name: step.name,
      substepsDerivedFromRunbookList: true,
      deferred: true,
      forClause: step.forClause,
      description: step.description,
      transitions: transitions ?? undefined,
      substeps: syntheticSubsteps,
      line: step.line,
    };
  }

  return {
    name: step.name,
    deferred: step.forClause ? true : undefined,
    forClause: step.forClause,
    description: step.description,
    command: step.command,
    prompt,
    transitions: transitions ?? undefined,
    substeps: step.substeps.length > 0 ? step.substeps : undefined,
    line: step.line,
  };
}
