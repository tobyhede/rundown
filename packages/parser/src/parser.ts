import { fromMarkdown } from 'mdast-util-from-markdown';
import { visit, SKIP } from 'unist-util-visit';
import type { Node } from 'unist';
import type { Code, Heading, List, ListItem, Paragraph, PhrasingContent } from 'mdast';
import type { Step, Substep, Command, ParsedForClause, ParseResult } from './ast.js';
import type { Transitions } from './schemas.js';
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
  validateLoopControlUsage,
  validateDEFERUsage,
  parseForClause,
} from './helpers.js';
import { validateRunbook } from './validator.js';
import { extractFrontmatter, nameFromFilename } from './frontmatter.js';

/** Default transitions for steps/substeps without explicit transitions: PASS CONTINUE, FAIL STOP. */
const DEFAULT_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

/** Transitions for substeps under aggregation or with runbook delegation: PASS DEFER, FAIL DEFER. */
const DEFER_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
};

/**
 * Type guard to narrow Node to Heading.
 *
 * @param node - The mdast node to check
 * @returns True if the node is a Heading with a depth property
 */
function isHeading(node: Node): node is Heading {
  return node.type === 'heading' && 'depth' in node;
}

/**
 * Type guard to narrow Node to Code.
 *
 * @param node - The mdast node to check
 * @returns True if the node is a Code block
 */
function isCode(node: Node): node is Code {
  return node.type === 'code';
}

/**
 * Type guard to narrow Node to Paragraph.
 *
 * @param node - The mdast node to check
 * @returns True if the node is a Paragraph
 */
function isParagraph(node: Node): node is Paragraph {
  return node.type === 'paragraph';
}

/**
 * Type guard to narrow Node to ListItem.
 *
 * @param node - The mdast node to check
 * @returns True if the node is a ListItem
 */
function isListItem(node: Node): node is ListItem {
  return node.type === 'listItem';
}

/**
 * Extract plain text from an mdast node, recursing into children.
 *
 * @param node - The mdast node to extract text from
 * @returns Concatenated plain text content of the node and its children
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
  forClause?: ParsedForClause;
  hasSeenForClause: boolean;
  forConditionals?: ParsedConditional[];
  stepConditionals?: ParsedConditional[];
  invalidH3s: Array<{ line: number; text: string }>;
}

/**
 * Mutable state threaded through all handler functions during AST walking.
 * Each handler receives and mutates this context to accumulate parsing results.
 * @see ActiveStepContext — narrowed variant where `currentStep` is guaranteed non-null
 */
interface VisitorContext {
  steps: Step[];
  title: string | undefined;
  preamble: string;
  currentStep: StepBuilder | null;
  pendingConditionals: ParsedConditional[];
  implicitText: string;
  inPreamble: boolean;
}

/** Narrowed context where a step is active. Handlers that require currentStep take this. */
interface ActiveStepContext extends VisitorContext {
  currentStep: StepBuilder;
}

function hasActiveStep(ctx: VisitorContext): ctx is ActiveStepContext {
  return ctx.currentStep !== null;
}

/** Node with optional source position for error reporting. */
interface Positioned {
  position?: { start: { line: number } };
}

/**
 * Format a node's source line number for error messages.
 *
 * @param node - An AST node with an optional position
 * @returns Formatted string like ` (line 42)`, or empty string if position is unavailable
 */
export function formatLineNum(node: Positioned): string {
  return node.position?.start.line ? ` (line ${String(node.position.start.line)})` : '';
}

function finalizePendingSubstep(ctx: VisitorContext): void {
  if (ctx.currentStep?.pendingSubstep) {
    const ps = ctx.currentStep.pendingSubstep;
    const runbooks = extractRunbookList(ps.content);

    // Validate NEXT usage before converting to transitions
    validateLoopControlUsage(ps.pendingConditionals, ctx.currentStep.forClause !== undefined);

    const converted = convertToTransitions(ps.pendingConditionals);

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

    // Substep transitions: explicit if authored, placeholder DEFAULT_TRANSITIONS if not.
    // finalizeStep will override DEFAULT_TRANSITIONS with context-aware defaults.
    const substep: Substep = {
      id: ps.id,
      description: ps.description,
      command: ps.command,
      prompt: promptText.trim() || undefined,
      transitions: converted?.transitions ?? DEFAULT_TRANSITIONS,
      runbooks: runbooks.length > 0 ? runbooks : undefined,
      line: ps.line,
    };
    ctx.currentStep.substeps.push(substep);
    ctx.currentStep.pendingSubstep = undefined;
  }
}

function handleH1Heading(node: Heading, ctx: VisitorContext): void {
  const headingText = extractText(node);
  const looksLikeStep = /^\d+[.:\-)\s]/.test(headingText);
  if (looksLikeStep) {
    throw new RunbookSyntaxError(
      `H1 headers (# ...) cannot be used as step headers. Use H2 (## ${headingText}) instead.`,
    );
  }
  ctx.title ??= headingText;
}

function handleH4PlusHeading(node: Heading): void {
  throw new RunbookSyntaxError(
    `H4+ headings are not allowed in runbooks. Found heading at depth ${String(node.depth)}. Use ## for steps and ### for substeps only.`,
  );
}

function handleH2Heading(node: Heading, ctx: VisitorContext): void {
  ctx.inPreamble = false;
  finalizePendingSubstep(ctx);

  if (ctx.currentStep) {
    ctx.steps.push(finalizeStep(ctx.currentStep, ctx.pendingConditionals, ctx.implicitText));
    ctx.pendingConditionals = [];
    ctx.implicitText = '';
  }

  const headingText = extractText(node);
  const parsed = extractStepHeader(headingText);
  if (parsed) {
    ctx.currentStep = {
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

function handleH3Heading(node: Heading, ctx: ActiveStepContext): void {
  ctx.inPreamble = false;
  if (ctx.currentStep.pendingSubstep) {
    // H3 #2+: flush inter-substep conditionals to preceding substep
    ctx.currentStep.pendingSubstep.pendingConditionals.push(...ctx.pendingConditionals);
    ctx.pendingConditionals = [];
  } else if (ctx.pendingConditionals.length > 0) {
    // First H3: save step-level conditionals separately
    ctx.currentStep.stepConditionals = [...ctx.pendingConditionals];
    ctx.pendingConditionals = [];
  }
  finalizePendingSubstep(ctx);

  const headingText = extractText(node);
  const parsed = extractSubstepHeader(headingText);

  if (parsed) {
    // Mark that parent step has seen content (substeps count as content)
    ctx.currentStep.hasSeenContent = true;
    if (parsed.stepRef !== undefined && parsed.stepRef !== ctx.currentStep.name) {
      throw new RunbookSyntaxError(
        `Substep ${headingText} does not belong to step ${ctx.currentStep.name}`,
      );
    }

    const duplicateId = ctx.currentStep.substeps.find((s) => s.id === parsed.id);
    if (duplicateId) {
      const stepLabel = ctx.currentStep.name;
      throw new RunbookSyntaxError(`Duplicate substep ID '${parsed.id}' in step ${stepLabel}`);
    }

    ctx.currentStep.pendingSubstep = {
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
    ctx.currentStep.invalidH3s.push({
      line: node.position?.start.line ?? 0,
      text: headingText,
    });
  }
}

function handleCodeBlock(node: Code, ctx: ActiveStepContext): void {
  // mdast splits the code fence info string on the first space:
  //   ```bash prompt  →  lang: "bash", meta: "prompt"
  // Reconstruct the full string so isExecutableCodeBlock/isPromptCodeBlock
  // can check multi-word patterns like "bash prompt".
  const fullLang = node.lang && node.meta ? `${node.lang} ${node.meta}` : node.lang;

  // Determine command based on code block type
  let cmd: Command | undefined;

  if (isExecutableCodeBlock(fullLang)) {
    // bash/sh/shell → direct command
    cmd = {
      code: node.value.trim(),
      lang: node.lang?.split(/\s+/)[0],
    };
  } else if (isPromptCodeBlock(fullLang)) {
    // prompt or non-executable tagged → rd prompt command (outputs with fences)
    const escaped = escapeForShellSingleQuote(node.value.trim());
    cmd = {
      code: `rd prompt '${escaped}'`,
      lang: 'prompt',
    };
  } else {
    // Bare code fence (no info string) — reject as invalid
    throw new RunbookSyntaxError(
      `Code block without language tag in Step ${ctx.currentStep.name}. ` +
        `Use a language tag (e.g., \`\`\`bash) or \`\`\`prompt for display-only blocks.`,
    );
  }

  if (ctx.currentStep.pendingSubstep) {
    if (ctx.currentStep.pendingSubstep.command) {
      throw new RunbookSyntaxError(
        `Multiple code blocks per substep not allowed in substep ${ctx.currentStep.pendingSubstep.id} (display-only fences like json/yaml count as code blocks)`,
      );
    }
    ctx.currentStep.pendingSubstep.command = cmd;
    ctx.currentStep.pendingSubstep.hasSeenContent = true;
  } else {
    if (ctx.currentStep.command) {
      const stepLabel = ctx.currentStep.name;
      throw new RunbookSyntaxError(
        `Multiple code blocks per step not allowed in Step ${stepLabel} (display-only fences like json/yaml count as code blocks).`,
      );
    }
    ctx.currentStep.command = cmd;
    ctx.currentStep.hasSeenContent = true;
  }
}

function handlePreambleParagraph(node: Paragraph, ctx: VisitorContext): void {
  const text = extractText(node);
  ctx.preamble += `${text}\n`;
}

function appendPromptToSubstep(
  line: string,
  substep: SubstepBuilder,
  stepName: string,
  lineNum: string,
): void {
  if (substep.hasSeenContent) {
    throw new RunbookSyntaxError(
      `Substep ${stepName}.${substep.id}${lineNum}: Prompt text must appear before code blocks or runbooks.`,
    );
  }
  substep.promptText += `${line.trim()}\n`;
  substep.hasSeenPromptText = true;
}

function appendPromptToStep(line: string, ctx: ActiveStepContext, lineNum: string): void {
  if (ctx.currentStep.hasSeenContent) {
    throw new RunbookSyntaxError(
      `Step ${ctx.currentStep.name}${lineNum}: Prompt text must appear before code blocks, substeps, or runbooks.`,
    );
  }
  ctx.implicitText += `${line.trim()}\n`;
  ctx.currentStep.hasSeenPromptText = true;
}

function handleStepParagraph(node: Paragraph, ctx: ActiveStepContext): void {
  const text = extractText(node);
  const lines = text.split('\n');

  for (const line of lines) {
    if (line.trim()) {
      // Paragraphs are always treated as prompt text — transitions must use bullet-prefix (list items)
      // Check ordering - text must come before content (code blocks, runbooks)
      if (ctx.currentStep.pendingSubstep) {
        appendPromptToSubstep(
          line,
          ctx.currentStep.pendingSubstep,
          ctx.currentStep.name,
          formatLineNum(node),
        );
      } else {
        appendPromptToStep(line, ctx, formatLineNum(node));
      }
    }
  }
}

function handleForClause(
  forClause: ParsedForClause,
  listItemNode: ListItem,
  ctx: ActiveStepContext,
): void {
  // Enforce: only one FOR per step
  if (ctx.currentStep.hasSeenForClause) {
    throw new RunbookSyntaxError(
      `Step "${ctx.currentStep.name}" has multiple FOR clauses; only one is allowed`,
    );
  }
  // Enforce ordering: FOR must appear before transitions and content
  if (ctx.currentStep.hasSeenTransitions) {
    throw new RunbookSyntaxError(
      `Step "${ctx.currentStep.name}": FOR clause must appear before transitions`,
    );
  }
  if (ctx.currentStep.hasSeenContent || ctx.currentStep.hasSeenPromptText) {
    throw new RunbookSyntaxError(
      `Step "${ctx.currentStep.name}": FOR clause must appear before content`,
    );
  }
  ctx.currentStep.forClause = forClause;
  ctx.currentStep.hasSeenForClause = true;

  // Check for nested list (FOR-level transitions)
  const nestedList = listItemNode.children.find((c): c is List => c.type === 'list');
  if (nestedList) {
    const forConditionals: ParsedConditional[] = [];
    for (const nestedItem of nestedList.children) {
      const nestedParagraph = nestedItem.children.find((c) => c.type === 'paragraph');
      if (!nestedParagraph) {
        throw new RunbookSyntaxError(
          `Invalid nested bullet under FOR clause in step "${ctx.currentStep.name}": only transitions (PASS/FAIL/DEFER) are allowed`,
        );
      }
      const nestedText = extractText(
        nestedParagraph as PhrasingContent | Heading | Paragraph | ListItem,
      );
      const cond = parseConditional(nestedText);
      if (!cond) {
        throw new RunbookSyntaxError(
          `Invalid nested bullet under FOR clause in step "${ctx.currentStep.name}": only transitions (PASS/FAIL/DEFER) are allowed`,
        );
      }
      if (Array.isArray(cond)) {
        forConditionals.push(...cond);
      } else {
        forConditionals.push(cond);
      }
    }
    if (forConditionals.length > 0) {
      ctx.currentStep.forConditionals = forConditionals;
    }
  }
}

function handleListItemTransition(
  conditionals: ParsedConditional[],
  node: Node,
  ctx: ActiveStepContext,
): void {
  const lineNum = formatLineNum(node);
  if (ctx.currentStep.pendingSubstep) {
    // Reject transitions after prompt text or content (header-adjacent requirement)
    if (
      ctx.currentStep.pendingSubstep.hasSeenPromptText ||
      ctx.currentStep.pendingSubstep.hasSeenContent
    ) {
      throw new RunbookSyntaxError(
        `Substep ${ctx.currentStep.name}.${ctx.currentStep.pendingSubstep.id}${lineNum}: Transitions must appear immediately after the substep header, before any content.`,
      );
    }
    ctx.currentStep.pendingSubstep.pendingConditionals.push(...conditionals);
    ctx.currentStep.pendingSubstep.hasSeenTransitions = true;
  } else {
    // Reject transitions after prompt text or content (header-adjacent requirement)
    if (ctx.currentStep.hasSeenPromptText || ctx.currentStep.hasSeenContent) {
      throw new RunbookSyntaxError(
        `Step ${ctx.currentStep.name}${lineNum}: Transitions must appear immediately after the step header, before any content.`,
      );
    }
    ctx.pendingConditionals.push(...conditionals);
    ctx.currentStep.hasSeenTransitions = true;
  }
}

function handleListItemContent(
  text: string,
  isRunbookRef: boolean,
  node: Node,
  ctx: ActiveStepContext,
): void {
  const lineNum = formatLineNum(node);
  if (ctx.currentStep.pendingSubstep) {
    // Check ordering BEFORE adding content
    // In substeps: text cannot appear after transitions
    if (ctx.currentStep.pendingSubstep.hasSeenTransitions && !isRunbookRef) {
      throw new RunbookSyntaxError(
        `Substep ${ctx.currentStep.name}.${ctx.currentStep.pendingSubstep.id}${lineNum}: Prompt text must appear before code blocks or runbooks.`,
      );
    }
    // Only add content after validation passes
    ctx.currentStep.pendingSubstep.content += ` - ${text}\n`;
    // Mark content seen if runbook list
    if (isRunbookRef) {
      ctx.currentStep.pendingSubstep.hasSeenContent = true;
    }
  } else {
    // Check ordering BEFORE adding content
    if (ctx.currentStep.hasSeenContent && !isRunbookRef) {
      throw new RunbookSyntaxError(
        `Step ${ctx.currentStep.name}${lineNum}: Prompt text must appear before code blocks, substeps, or runbooks.`,
      );
    }
    // Only add content after validation passes
    const itemText = ` - ${text}\n`;
    ctx.currentStep.content += itemText;
    if (!isRunbookRef) {
      ctx.implicitText += itemText;
    } else {
      // Mark content seen if runbook list
      ctx.currentStep.hasSeenContent = true;
    }
  }
}

/**
 * Process a list item node within an active step.
 *
 * @param node - The list item AST node
 * @param ctx - Active step context (currentStep guaranteed non-null)
 * @returns `SKIP` when a FOR clause is handled (prevents child traversal), `void` otherwise
 * @throws {RunbookSyntaxError} When a FOR clause is invalid or appears in a substep context
 */
function handleListItem(node: ListItem, ctx: ActiveStepContext): typeof SKIP | void {
  const firstParagraph = node.children.find((c) => c.type === 'paragraph');
  if (!firstParagraph) return;

  const text = extractText(firstParagraph as PhrasingContent | Heading | Paragraph | ListItem);

  // Check for FOR clause BEFORE conditionals
  const forResult = parseForClause(text);

  // Throw if text looks like a FOR clause but didn't parse,
  // unless it contains template variables ({{...}}) that need runtime expansion
  if (forResult === null && text.trim().startsWith('FOR ')) {
    throw new RunbookSyntaxError(`Invalid FOR clause: ${text.trim()}`);
  }

  if (forResult && !ctx.currentStep.pendingSubstep) {
    // FOR is only valid at step level, not substep level
    handleForClause(forResult, node, ctx);
    return SKIP; // Don't process this list item further
  }

  // If FOR text appears in a substep context, that's an error
  if (forResult && ctx.currentStep.pendingSubstep) {
    throw new RunbookSyntaxError(
      `FOR is only valid on steps (H2), not substeps (H3) (found on "${ctx.currentStep.name}.${ctx.currentStep.pendingSubstep.id}")`,
    );
  }

  const conditionalResult = parseConditional(text);
  if (conditionalResult) {
    const conditionals = Array.isArray(conditionalResult) ? conditionalResult : [conditionalResult];
    handleListItemTransition(conditionals, node, ctx);
  } else {
    const isRunbookRef = /^\S+\.runbook\.md$/.test(text.trim());
    handleListItemContent(text, isRunbookRef, node, ctx);
  }
}

function dispatchHeading(node: Heading, ctx: VisitorContext): void {
  if (node.depth === 1) {
    handleH1Heading(node, ctx);
    return;
  }
  if (node.depth >= 4) {
    handleH4PlusHeading(node);
    return;
  }
  if (node.depth === 2) {
    handleH2Heading(node, ctx);
    return;
  }
  if (node.depth === 3 && hasActiveStep(ctx)) {
    handleH3Heading(node, ctx);
  }
}

function visitNode(node: Node, parent: Node | undefined, ctx: VisitorContext): typeof SKIP | void {
  if (isHeading(node)) {
    dispatchHeading(node, ctx);
    return;
  }
  if (isCode(node) && hasActiveStep(ctx)) {
    handleCodeBlock(node, ctx);
    return;
  }
  if (isParagraph(node) && parent && parent.type !== 'listItem') {
    if (ctx.inPreamble) {
      handlePreambleParagraph(node, ctx);
      return;
    }
    if (hasActiveStep(ctx)) {
      handleStepParagraph(node, ctx);
      return;
    }
    return;
  }
  if (isListItem(node) && hasActiveStep(ctx)) return handleListItem(node, ctx);
}

/**
 * Mutable state threaded through all handler functions during AST walking.
 * Each handler receives and mutates this context to accumulate parsing results.
 * @see ActiveStepContext — narrowed variant where `currentStep` is guaranteed non-null
 */
interface VisitorContext {
  steps: Step[];
  title: string | undefined;
  preamble: string;
  currentStep: StepBuilder | null;
  pendingConditionals: ParsedConditional[];
  implicitText: string;
  inPreamble: boolean;
}

/** Narrowed context where a step is active. Handlers that require currentStep take this. */
interface ActiveStepContext extends VisitorContext {
  currentStep: StepBuilder;
}

function hasActiveStep(ctx: VisitorContext): ctx is ActiveStepContext {
  return ctx.currentStep !== null;
}

function finalizePendingSubstep(ctx: VisitorContext): void {
  if (ctx.currentStep?.pendingSubstep) {
    const ps = ctx.currentStep.pendingSubstep;
    const runbooks = extractRunbookList(ps.content);

    // Validate NEXT usage before converting to transitions
    validateLoopControlUsage(ps.pendingConditionals, ctx.currentStep.forClause !== undefined);

    const converted = convertToTransitions(ps.pendingConditionals);

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

    // Substep transitions: explicit if authored, placeholder DEFAULT_TRANSITIONS if not.
    // finalizeStep will override DEFAULT_TRANSITIONS with context-aware defaults.
    const substep: Substep = {
      id: ps.id,
      description: ps.description,
      command: ps.command,
      prompt: promptText.trim() || undefined,
      transitions: converted?.transitions ?? DEFAULT_TRANSITIONS,
      runbooks: runbooks.length > 0 ? runbooks : undefined,
      line: ps.line,
    };
    ctx.currentStep.substeps.push(substep);
    ctx.currentStep.pendingSubstep = undefined;
  }
}

function handleH1Heading(node: Heading, ctx: VisitorContext): void {
  const headingText = extractText(node);
  const looksLikeStep = /^\d+[.:\-)\s]/.test(headingText);
  if (looksLikeStep) {
    throw new RunbookSyntaxError(
      `H1 headers (# ...) cannot be used as step headers. Use H2 (## ${headingText}) instead.`,
    );
  }
  ctx.title ??= headingText;
}

function handleH4PlusHeading(node: Heading): void {
  throw new RunbookSyntaxError(
    `H4+ headings are not allowed in runbooks. Found heading at depth ${String(node.depth)}. Use ## for steps and ### for substeps only.`,
  );
}

function handleH2Heading(node: Heading, ctx: VisitorContext): void {
  ctx.inPreamble = false;
  finalizePendingSubstep(ctx);

  if (ctx.currentStep) {
    ctx.steps.push(finalizeStep(ctx.currentStep, ctx.pendingConditionals, ctx.implicitText));
    ctx.pendingConditionals = [];
    ctx.implicitText = '';
  }

  const headingText = extractText(node);
  const parsed = extractStepHeader(headingText);
  if (parsed) {
    ctx.currentStep = {
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

function handleH3Heading(node: Heading, ctx: ActiveStepContext): void {
  ctx.inPreamble = false;
  if (ctx.currentStep.pendingSubstep) {
    // H3 #2+: flush inter-substep conditionals to preceding substep
    ctx.currentStep.pendingSubstep.pendingConditionals.push(...ctx.pendingConditionals);
    ctx.pendingConditionals = [];
  } else if (ctx.pendingConditionals.length > 0) {
    // First H3: save step-level conditionals separately
    ctx.currentStep.stepConditionals = [...ctx.pendingConditionals];
    ctx.pendingConditionals = [];
  }
  finalizePendingSubstep(ctx);

  const headingText = extractText(node);
  const parsed = extractSubstepHeader(headingText);

  if (parsed) {
    // Mark that parent step has seen content (substeps count as content)
    ctx.currentStep.hasSeenContent = true;
    if (parsed.stepRef !== undefined && parsed.stepRef !== ctx.currentStep.name) {
      throw new RunbookSyntaxError(
        `Substep ${headingText} does not belong to step ${ctx.currentStep.name}`,
      );
    }

    const duplicateId = ctx.currentStep.substeps.find((s) => s.id === parsed.id);
    if (duplicateId) {
      const stepLabel = ctx.currentStep.name;
      throw new RunbookSyntaxError(`Duplicate substep ID '${parsed.id}' in step ${stepLabel}`);
    }

    ctx.currentStep.pendingSubstep = {
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
    ctx.currentStep.invalidH3s.push({
      line: node.position?.start.line ?? 0,
      text: headingText,
    });
  }
}

function handleCodeBlock(node: Code, ctx: ActiveStepContext): void {
  // mdast splits the code fence info string on the first space:
  //   ```bash prompt  →  lang: "bash", meta: "prompt"
  // Reconstruct the full string so isExecutableCodeBlock/isPromptCodeBlock
  // can check multi-word patterns like "bash prompt".
  const fullLang = node.lang && node.meta ? `${node.lang} ${node.meta}` : node.lang;

  // Determine command based on code block type
  let cmd: Command | undefined;

  if (isExecutableCodeBlock(fullLang)) {
    // bash/sh/shell → direct command
    cmd = {
      code: node.value.trim(),
      lang: node.lang?.split(/\s+/)[0],
    };
  } else if (isPromptCodeBlock(fullLang)) {
    // prompt or non-executable tagged → rd prompt command (outputs with fences)
    const escaped = escapeForShellSingleQuote(node.value.trim());
    cmd = {
      code: `rd prompt '${escaped}'`,
      lang: 'prompt',
    };
  } else {
    // Bare code fence (no info string) — reject as invalid
    throw new RunbookSyntaxError(
      `Code block without language tag in Step ${ctx.currentStep.name}. ` +
        `Use a language tag (e.g., \`\`\`bash) or \`\`\`prompt for display-only blocks.`,
    );
  }

  if (ctx.currentStep.pendingSubstep) {
    if (ctx.currentStep.pendingSubstep.command) {
      throw new RunbookSyntaxError(
        `Multiple code blocks per substep not allowed in substep ${ctx.currentStep.pendingSubstep.id} (display-only fences like json/yaml count as code blocks)`,
      );
    }
    ctx.currentStep.pendingSubstep.command = cmd;
    ctx.currentStep.pendingSubstep.hasSeenContent = true;
  } else {
    if (ctx.currentStep.command) {
      const stepLabel = ctx.currentStep.name;
      throw new RunbookSyntaxError(
        `Multiple code blocks per step not allowed in Step ${stepLabel} (display-only fences like json/yaml count as code blocks).`,
      );
    }
    ctx.currentStep.command = cmd;
    ctx.currentStep.hasSeenContent = true;
  }
}

function handlePreambleParagraph(node: Paragraph, ctx: VisitorContext): void {
  const text = extractText(node);
  ctx.preamble += `${text}\n`;
}

function handleStepParagraph(node: Paragraph, ctx: ActiveStepContext): void {
  const text = extractText(node);
  const lines = text.split('\n');

  for (const line of lines) {
    if (line.trim()) {
      // Paragraphs are always treated as prompt text — transitions must use bullet-prefix (list items)
      // Check ordering - text must come before content (code blocks, runbooks)
      if (ctx.currentStep.pendingSubstep) {
        // In substeps: text cannot appear after code blocks/runbooks
        if (ctx.currentStep.pendingSubstep.hasSeenContent) {
          const stepLabel = ctx.currentStep.name;
          // E17-R2: Include line number in error for better DX
          const lineNum = node.position?.start.line
            ? ` (line ${String(node.position.start.line)})`
            : '';
          throw new RunbookSyntaxError(
            `Substep ${stepLabel}.${ctx.currentStep.pendingSubstep.id}${lineNum}: Prompt text must appear before code blocks or runbooks.`,
          );
        }
        ctx.currentStep.pendingSubstep.promptText += `${line.trim()}\n`;
        ctx.currentStep.pendingSubstep.hasSeenPromptText = true;
      } else {
        if (ctx.currentStep.hasSeenContent) {
          const stepLabel = ctx.currentStep.name;
          // E17-R2: Include line number in error for better DX
          const lineNum = node.position?.start.line
            ? ` (line ${String(node.position.start.line)})`
            : '';
          throw new RunbookSyntaxError(
            `Step ${stepLabel}${lineNum}: Prompt text must appear before code blocks, substeps, or runbooks.`,
          );
        }
        ctx.implicitText += `${line.trim()}\n`;
        ctx.currentStep.hasSeenPromptText = true;
      }
    }
  }
}

function handleForClause(
  forClause: ParsedForClause,
  listItemNode: ListItem,
  ctx: ActiveStepContext,
): void {
  // Enforce: only one FOR per step
  if (ctx.currentStep.hasSeenForClause) {
    throw new RunbookSyntaxError(
      `Step "${ctx.currentStep.name}" has multiple FOR clauses; only one is allowed`,
    );
  }
  // Enforce ordering: FOR must appear before transitions and content
  if (ctx.currentStep.hasSeenTransitions) {
    throw new RunbookSyntaxError(
      `Step "${ctx.currentStep.name}": FOR clause must appear before transitions`,
    );
  }
  if (ctx.currentStep.hasSeenContent || ctx.currentStep.hasSeenPromptText) {
    throw new RunbookSyntaxError(
      `Step "${ctx.currentStep.name}": FOR clause must appear before content`,
    );
  }
  ctx.currentStep.forClause = forClause;
  ctx.currentStep.hasSeenForClause = true;

  // Check for nested list (FOR-level transitions)
  const nestedList = listItemNode.children.find((c): c is List => c.type === 'list');
  if (nestedList) {
    const forConditionals: ParsedConditional[] = [];
    for (const nestedItem of nestedList.children) {
      const nestedParagraph = nestedItem.children.find((c) => c.type === 'paragraph');
      if (!nestedParagraph) {
        throw new RunbookSyntaxError(
          `Invalid nested bullet under FOR clause in step "${ctx.currentStep.name}": only transitions (PASS/FAIL/DEFER) are allowed`,
        );
      }
      const nestedText = extractText(
        nestedParagraph as PhrasingContent | Heading | Paragraph | ListItem,
      );
      const cond = parseConditional(nestedText);
      if (!cond) {
        throw new RunbookSyntaxError(
          `Invalid nested bullet under FOR clause in step "${ctx.currentStep.name}": only transitions (PASS/FAIL/DEFER) are allowed`,
        );
      }
      if (Array.isArray(cond)) {
        forConditionals.push(...cond);
      } else {
        forConditionals.push(cond);
      }
    }
    if (forConditionals.length > 0) {
      ctx.currentStep.forConditionals = forConditionals;
    }
  }
}

function handleListItemTransition(
  conditionals: ParsedConditional[],
  node: Node,
  ctx: ActiveStepContext,
): void {
  if (ctx.currentStep.pendingSubstep) {
    // Reject transitions after prompt text or content (header-adjacent requirement)
    if (
      ctx.currentStep.pendingSubstep.hasSeenPromptText ||
      ctx.currentStep.pendingSubstep.hasSeenContent
    ) {
      const stepLabel = ctx.currentStep.name;
      const lineNum = node.position?.start.line
        ? ` (line ${String(node.position.start.line)})`
        : '';
      throw new RunbookSyntaxError(
        `Substep ${stepLabel}.${ctx.currentStep.pendingSubstep.id}${lineNum}: Transitions must appear immediately after the substep header, before any content.`,
      );
    }
    ctx.currentStep.pendingSubstep.pendingConditionals.push(...conditionals);
    ctx.currentStep.pendingSubstep.hasSeenTransitions = true;
  } else {
    // Reject transitions after prompt text or content (header-adjacent requirement)
    if (ctx.currentStep.hasSeenPromptText || ctx.currentStep.hasSeenContent) {
      const stepLabel = ctx.currentStep.name;
      const lineNum = node.position?.start.line
        ? ` (line ${String(node.position.start.line)})`
        : '';
      throw new RunbookSyntaxError(
        `Step ${stepLabel}${lineNum}: Transitions must appear immediately after the step header, before any content.`,
      );
    }
    ctx.pendingConditionals.push(...conditionals);
    ctx.currentStep.hasSeenTransitions = true;
  }
}

function handleListItemContent(
  text: string,
  isRunbookRef: boolean,
  node: Node,
  ctx: ActiveStepContext,
): void {
  if (ctx.currentStep.pendingSubstep) {
    // FIXED: Check ordering BEFORE adding content (C2 fix)
    // In substeps: text cannot appear after transitions
    if (ctx.currentStep.pendingSubstep.hasSeenTransitions && !isRunbookRef) {
      const stepLabel = ctx.currentStep.name;
      // E17-R2: Include line number in error for better DX
      const lineNum = node.position?.start.line
        ? ` (line ${String(node.position.start.line)})`
        : '';
      throw new RunbookSyntaxError(
        `Substep ${stepLabel}.${ctx.currentStep.pendingSubstep.id}${lineNum}: Prompt text must appear before code blocks or runbooks.`,
      );
    }
    // Only add content after validation passes
    ctx.currentStep.pendingSubstep.content += ` - ${text}\n`;
    // Mark content seen if runbook list
    if (isRunbookRef) {
      ctx.currentStep.pendingSubstep.hasSeenContent = true;
    }
  } else {
    // FIXED: Check ordering BEFORE adding content (C2 fix)
    if (ctx.currentStep.hasSeenContent && !isRunbookRef) {
      const stepLabel = ctx.currentStep.name;
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
    ctx.currentStep.content += itemText;
    if (!isRunbookRef) {
      ctx.implicitText += itemText;
    } else {
      // Mark content seen if runbook list
      ctx.currentStep.hasSeenContent = true;
    }
  }
}

/**
 * Process a list item node within an active step.
 *
 * @param node - The list item AST node
 * @param ctx - Active step context (currentStep guaranteed non-null)
 * @returns `SKIP` when a FOR clause is handled (prevents child traversal), `void` otherwise
 * @throws {RunbookSyntaxError} If text looks like a FOR clause but fails to parse, or if FOR appears in a substep context
 */
function handleListItem(node: ListItem, ctx: ActiveStepContext): typeof SKIP | void {
  const firstParagraph = node.children.find((c) => c.type === 'paragraph');
  if (!firstParagraph) return;

  const text = extractText(firstParagraph as PhrasingContent | Heading | Paragraph | ListItem);

  // Check for FOR clause BEFORE conditionals
  const forResult = parseForClause(text);

  // Throw if text looks like a FOR clause but didn't parse,
  // unless it contains template variables ({{...}}) that need runtime expansion
  if (forResult === null && text.trim().startsWith('FOR ')) {
    throw new RunbookSyntaxError(`Invalid FOR clause: ${text.trim()}`);
  }

  if (forResult && !ctx.currentStep.pendingSubstep) {
    // FOR is only valid at step level, not substep level
    handleForClause(forResult, node, ctx);
    return SKIP; // Don't process this list item further
  }

  // If FOR text appears in a substep context, that's an error
  if (forResult && ctx.currentStep.pendingSubstep) {
    throw new RunbookSyntaxError(
      `FOR is only valid on steps (H2), not substeps (H3) (found on "${ctx.currentStep.name}.${ctx.currentStep.pendingSubstep.id}")`,
    );
  }

  const conditionalResult = parseConditional(text);
  if (conditionalResult) {
    const conditionals = Array.isArray(conditionalResult) ? conditionalResult : [conditionalResult];
    handleListItemTransition(conditionals, node, ctx);
  } else {
    const isRunbookRef = /^\S+\.runbook\.md$/.test(text.trim());
    handleListItemContent(text, isRunbookRef, node, ctx);
  }
}

/**
 * Parse runbook markdown into Step array (compatibility wrapper).
 *
 * This is a simplified entry point that returns only the steps array,
 * discarding runbook metadata. For full document parsing including
 * title, description, and frontmatter, use {@link parseRunbookDocument}.
 *
 * Throws on error-severity diagnostics for backward compatibility.
 *
 * @param markdown - The raw markdown content to parse
 * @returns Array of parsed Step objects representing the runbook
 * @throws {RunbookSyntaxError} When validation produces error-severity diagnostics
 * @see parseRunbookDocument for full runbook parsing with metadata
 */
export function parseRunbook(markdown: string): Step[] {
  const { runbook, diagnostics } = parseRunbookDocument(markdown);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new RunbookSyntaxError(errors[0].message);
  }
  return [...runbook.steps];
}

/**
 * Parse entire runbook document including metadata.
 *
 * Parses a complete Rundown runbook markdown document, extracting:
 * - YAML frontmatter (name, version, author, tags)
 * - H1 title and preamble description
 * - H2 step definitions with commands, prompts, and transitions
 * - H3 substep definitions
 * - Runbook references (nested runbook lists)
 *
 * Structural validation issues (non-sequential steps, missing substeps) are
 * returned as diagnostics rather than thrown. True parse failures (malformed
 * markdown, H4+ headings, duplicate substep IDs) remain exceptions.
 *
 * @param markdown - The raw markdown content to parse
 * @param basename - Optional basename (e.g. "deploy.runbook.md") used to derive runbook name if not in frontmatter
 * @returns ParseResult containing the Runbook AST and validation diagnostics
 * @throws {RunbookSyntaxError} When the markdown contains invalid syntax,
 *   such as H4+ headings, duplicate substep IDs, multiple code blocks per step,
 *   or other specification violations
 * @see parseRunbook for simplified parsing returning only steps
 */
export function parseRunbookDocument(markdown: string, basename?: string): ParseResult {
  const { frontmatter, content } = extractFrontmatter(markdown);
  const tree = fromMarkdown(content);

  const ctx: VisitorContext = {
    steps: [],
    title: undefined,
    preamble: '',
    currentStep: null,
    pendingConditionals: [],
    implicitText: '',
    inPreamble: true,
  };

  visit(tree, (node: Node, _index, parent: Node | undefined) => visitNode(node, parent, ctx));

  finalizePendingSubstep(ctx);

  if (ctx.currentStep) {
    ctx.steps.push(finalizeStep(ctx.currentStep, ctx.pendingConditionals, ctx.implicitText));
  }

  const diagnostics = validateRunbook(ctx.steps);

  return {
    runbook: {
      title: ctx.title,
      description: ctx.preamble.trim() || undefined,
      name: frontmatter?.name ?? (basename ? nameFromFilename(basename) : undefined),
      version: frontmatter?.version,
      author: frontmatter?.author,
      tags: frontmatter?.tags,
      steps: ctx.steps,
    },
    frontmatter,
    diagnostics,
  };
}

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
  const effectiveConditionals = step.stepConditionals ?? pendingConditionals;
  validateLoopControlUsage(effectiveConditionals, step.forClause !== undefined);
  validateDEFERUsage(effectiveConditionals, false);

  const converted = convertToTransitions(effectiveConditionals);
  const stepTransitions = converted?.transitions ?? DEFAULT_TRANSITIONS;
  const stepAggregation = converted?.aggregation;

  if (step.forClause && step.forConditionals?.length) {
    const forConverted = convertToTransitions(step.forConditionals);
    if (forConverted) {
      step.forClause = {
        ...step.forClause,
        transitions: forConverted.transitions,
        aggregation: forConverted.aggregation,
      };
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

  // Resolve substep defaults based on context.
  // Substeps with explicit transitions (from authored conditionals) keep them as-is.
  // Substeps with placeholder DEFAULT_TRANSITIONS (no authored conditionals) get
  // context-aware defaults: DEFER under aggregation or with runbooks, DEFAULT otherwise.
  const resolveSubstepDefaults = (substeps: Substep[]): Substep[] =>
    substeps.map((sub) => {
      if (sub.transitions !== DEFAULT_TRANSITIONS) return sub; // explicit — keep as-is
      if (sub.runbooks?.length) return { ...sub, transitions: DEFER_TRANSITIONS }; // delegation
      if (stepAggregation) return { ...sub, transitions: DEFER_TRANSITIONS }; // under step aggregation
      if (step.forClause?.aggregation) return { ...sub, transitions: DEFER_TRANSITIONS }; // under iteration aggregation
      return sub; // DEFAULT_TRANSITIONS is correct for sequential
    });

  // Step-level runbook lists are syntax sugar for implicit substeps.
  if (runbooks.length > 0) {
    if (step.command || step.substeps.length > 0) {
      throw new RunbookSyntaxError(
        `Step ${step.name}: Violates Exclusivity Rule. A step must have exactly one of {Body, Substeps}.`,
      );
    }
    // Canonicalize each step-level runbook bullet into its own synthetic substep.
    // Synthetic substeps always DEFER (they delegate to runbooks).
    const syntheticSubsteps: Substep[] = runbooks.map((runbookPath, index) => ({
      id: String(index + 1),
      description: '',
      prompt: index === 0 ? prompt : undefined,
      runbooks: [runbookPath],
      transitions: DEFER_TRANSITIONS,
      line: step.line,
    }));

    const shared = {
      name: step.name,
      description: step.description,
      transitions: stepTransitions,
      line: step.line,
    };
    if (step.forClause) {
      return {
        ...shared,
        kind: 'for' as const,
        aggregation: stepAggregation,
        substepsDerivedFromRunbookList: true as const,
        forClause: step.forClause,
        substeps: syntheticSubsteps,
      };
    }
    return {
      ...shared,
      kind: 'substeps' as const,
      aggregation: stepAggregation,
      substepsDerivedFromRunbookList: true as const,
      substeps: syntheticSubsteps,
    };
  }

  // Resolve substep defaults
  const resolvedSubsteps = resolveSubstepDefaults(step.substeps);

  // Build shared fields once (aggregation excluded — only added to parent step kinds)
  const shared = {
    name: step.name,
    description: step.description,
    prompt,
    transitions: stepTransitions,
    line: step.line,
  };

  if (step.forClause) {
    return {
      ...shared,
      kind: 'for' as const,
      aggregation: stepAggregation,
      forClause: step.forClause,
      substeps: resolvedSubsteps.length > 0 ? resolvedSubsteps : [],
    };
  }

  if (resolvedSubsteps.length > 0) {
    return {
      ...shared,
      kind: 'substeps' as const,
      aggregation: stepAggregation,
      substeps: resolvedSubsteps,
    };
  }

  if (step.command) {
    return {
      ...shared,
      kind: 'command' as const,
      command: step.command,
    };
  }

  return {
    ...shared,
    kind: 'base' as const,
  };
}
