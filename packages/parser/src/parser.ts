import { fromMarkdown } from 'mdast-util-from-markdown';
import { visit, SKIP } from 'unist-util-visit';
import type { Node } from 'unist';
import type { Code, Heading, List, ListItem, Paragraph, PhrasingContent } from 'mdast';
import type {
  Step,
  ParsedSubstep,
  Command,
  ParsedForClause,
  ParseResult,
  OutputDeclaration,
  ArtifactDeclaration,
  RunbookEntry,
} from './ast.js';
import type { Transitions } from './schemas.js';
import { type ParsedConditional, RunbookSyntaxError } from './types.js';
import {
  extractStepHeader,
  extractSubstepHeader,
  parseConditional,
  convertToTransitions,
  extractRunbookList,
  TEMPLATE_VAR_REF_RE,
  isExecutableCodeBlock,
  isPromptCodeBlock,
  escapeForShellSingleQuote,
  validateLoopControlUsage,
  validateDEFERUsage,
  parseForClause,
  parseStepOutputDeclaration,
  parseArtifactDeclaration,
} from './helpers.js';
import { formatReservedTemplateNames, isReservedTemplateName } from './reserved.js';
import { validateRunbook } from './validator.js';
import type { ValidationDiagnostic } from './validator.js';
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
  /**
   * Tracks body content that is NOT a runbook-list entry (code blocks, prose bullets, etc.).
   * Unlike `hasSeenContent`, this flag is never set by runbook-list entries, so it correctly
   * preserves the "any non-runbook content blocks later transitions/directives" rule even
   * when a runbook bullet re-appears after a code block.
   */
  hasSeenNonRunbookContent: boolean;
  hasSeenTransitions: boolean;
  hasSeenPromptText: boolean;
  hasSeenDelegate: boolean;
  hasSeenRunbooks?: true;
  pendingConditionals: ParsedConditional[];
  line?: number;
  outputs?: readonly OutputDeclaration[];
  artifacts?: readonly ArtifactDeclaration[];
  runbooks: RunbookEntry[];
  /**
   * Marks a substep synthesized from a runbook list entry rather than an explicit H3 heading.
   * Not propagated to the ParsedSubstep AST node — runtime code must not read or depend on this field.
   *
   * @internal
   */
  isRunbookDerived?: true;
}

interface StepBuilder {
  name: string;
  description: string;
  command?: Command;
  promptText: string;
  hasSeenContent: boolean;
  hasSeenTransitions: boolean;
  hasSeenPromptText: boolean;
  hasSeenDelegate: boolean;
  substeps: ParsedSubstep[];
  pendingSubstep?: SubstepBuilder;
  content: string;
  line?: number;
  forClause?: ParsedForClause;
  hasSeenForClause: boolean;
  forConditionals?: ParsedConditional[];
  stepConditionals?: ParsedConditional[];
  invalidH3s: Array<{ line: number; text: string }>;
  outputs?: readonly OutputDeclaration[];
  artifacts?: readonly ArtifactDeclaration[];
  hasRunbookListSubsteps?: true;
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
  diagnostics: ValidationDiagnostic[];
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
 * Format a source line number for error messages.
 *
 * Accepts either an AST node with an optional position or a raw line number.
 *
 * @param nodeOrLine - An AST node with an optional position, or a line number
 * @returns Formatted string like ` (line 42)`, or empty string if position is unavailable
 */
export function formatLineNum(nodeOrLine: Positioned | number | undefined): string {
  const line = typeof nodeOrLine === 'number' ? nodeOrLine : nodeOrLine?.position?.start.line;
  return line ? ` (line ${String(line)})` : '';
}

function finalizePendingSubstep(ctx: VisitorContext): void {
  if (ctx.currentStep?.pendingSubstep) {
    const ps = ctx.currentStep.pendingSubstep;

    // Validate NEXT usage before converting to transitions
    validateLoopControlUsage(ps.pendingConditionals, ctx.currentStep.forClause !== undefined);

    // Enforce docs/spec/language.md §4.3: every DELEGATE substep must resolve
    // to an authored runbook target. A CLI positional runbook may confirm an
    // authored target, but it must never create one.
    if (ps.hasSeenDelegate && ps.runbooks.length === 0) {
      throw new RunbookSyntaxError(
        `Substep "${ctx.currentStep.name}.${ps.id}": DELEGATE requires a runbook target ` +
          `(a "- <name>.runbook.md" entry). Annotate DELEGATE only on substeps that reference a runbook.`,
      );
    }

    const converted = convertToTransitions(ps.pendingConditionals);

    // Build prompt from promptText and body content. Runbook-list entries are stored
    // in ps.runbooks (not ps.content), so no filtering of ps.content is needed.
    let promptText = ps.promptText;
    if (ps.content.trim()) {
      promptText += `${ps.content.trim()}\n`;
    }

    // Substep transitions: explicit if authored, placeholder DEFAULT_TRANSITIONS if not.
    // finalizeStep will override DEFAULT_TRANSITIONS with context-aware defaults.
    const substep: ParsedSubstep = {
      id: ps.id,
      description: ps.description,
      command: ps.command,
      prompt: promptText.trim() || undefined,
      transitions: converted?.transitions ?? DEFAULT_TRANSITIONS,
      runbooks: ps.runbooks.length > 0 ? ps.runbooks : undefined,
      line: ps.line,
      outputs: ps.outputs,
      artifacts: ps.artifacts,
      delegate: ps.hasSeenDelegate ? true : undefined,
    };
    ctx.currentStep.substeps.push(substep);
    ctx.currentStep.pendingSubstep = undefined;
  }
}

function getDirectiveTarget(ctx: ActiveStepContext): StepBuilder | SubstepBuilder {
  return ctx.currentStep.pendingSubstep ?? ctx.currentStep;
}

function formatDirectiveTarget(ctx: ActiveStepContext): string {
  const target = ctx.currentStep.pendingSubstep;
  return target
    ? `substep "${ctx.currentStep.name}.${target.id}"`
    : `step "${ctx.currentStep.name}"`;
}

function handleH1Heading(node: Heading, ctx: VisitorContext): void {
  const headingText = extractText(node);
  const looksLikeStep = /^\d+[.:\-)\s]/.test(headingText);
  if (looksLikeStep) {
    throw new RunbookSyntaxError(
      `H1 headers (# ...) cannot be used as step headers${formatLineNum(node)}. Use H2 (## ${headingText}) instead.`,
    );
  }
  ctx.title ??= headingText;
}

function handleH4PlusHeading(node: Heading): void {
  throw new RunbookSyntaxError(
    `H4+ headings are not allowed in runbooks${formatLineNum(node)}. Use ## for steps and ### for substeps only. Found heading at depth ${String(node.depth)}.`,
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
      hasSeenDelegate: false,
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

  // If step already has runbook-list substeps, mixing explicit H3 substeps violates exclusivity.
  if (ctx.currentStep.hasRunbookListSubsteps) {
    throw new RunbookSyntaxError(
      `Step ${ctx.currentStep.name}: Violates Exclusivity Rule. A step must have exactly one of {Body, Substeps}.`,
    );
  }

  const headingText = extractText(node);
  const parsed = extractSubstepHeader(headingText);

  if (parsed) {
    // Mark that parent step has seen content (substeps count as content)
    ctx.currentStep.hasSeenContent = true;
    if (parsed.stepRef !== undefined && parsed.stepRef !== ctx.currentStep.name) {
      throw new RunbookSyntaxError(
        `Substep ${headingText} does not belong to step ${ctx.currentStep.name}${formatLineNum(node)}`,
      );
    }

    const duplicateId = ctx.currentStep.substeps.find((s) => s.id === parsed.id);
    if (duplicateId) {
      const stepLabel = ctx.currentStep.name;
      throw new RunbookSyntaxError(
        `Duplicate substep ID '${parsed.id}' in step ${stepLabel}${formatLineNum(node)}`,
      );
    }

    ctx.currentStep.pendingSubstep = {
      id: parsed.id,
      description: parsed.description,
      content: '',
      command: undefined,
      promptText: '',
      hasSeenContent: false,
      hasSeenNonRunbookContent: false,
      hasSeenTransitions: false,
      hasSeenPromptText: false,
      hasSeenDelegate: false,
      pendingConditionals: [],
      line: node.position?.start.line,
      outputs: undefined,
      artifacts: undefined,
      runbooks: [],
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
      `Code block without language tag in Step ${ctx.currentStep.name}${formatLineNum(node)}. ` +
        `Use a language tag (e.g., \`\`\`bash) or \`\`\`prompt for display-only blocks.`,
    );
  }

  if (ctx.currentStep.pendingSubstep) {
    if (ctx.currentStep.pendingSubstep.command) {
      throw new RunbookSyntaxError(
        `Multiple code blocks per substep not allowed in substep ${ctx.currentStep.pendingSubstep.id}${formatLineNum(node)} (display-only fences like json/yaml count as code blocks)`,
      );
    }
    ctx.currentStep.pendingSubstep.command = cmd;
    ctx.currentStep.pendingSubstep.hasSeenContent = true;
    ctx.currentStep.pendingSubstep.hasSeenNonRunbookContent = true;
  } else {
    if (ctx.currentStep.command) {
      const stepLabel = ctx.currentStep.name;
      throw new RunbookSyntaxError(
        `Multiple code blocks per step not allowed in Step ${stepLabel}${formatLineNum(node)} (display-only fences like json/yaml count as code blocks).`,
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
      `Step "${ctx.currentStep.name}" has multiple FOR clauses; only one is allowed${formatLineNum(listItemNode)}`,
    );
  }
  // Enforce ordering: FOR must appear before transitions and content
  if (ctx.currentStep.hasSeenTransitions) {
    throw new RunbookSyntaxError(
      `Step "${ctx.currentStep.name}": FOR clause must appear before transitions${formatLineNum(listItemNode)}`,
    );
  }
  if (ctx.currentStep.hasSeenContent || ctx.currentStep.hasSeenPromptText) {
    throw new RunbookSyntaxError(
      `Step "${ctx.currentStep.name}": FOR clause must appear before content${formatLineNum(listItemNode)}`,
    );
  }
  // Enforce: FOR must appear before DELEGATE
  if (ctx.currentStep.hasSeenDelegate) {
    throw new RunbookSyntaxError(
      `Step "${ctx.currentStep.name}": FOR clause must appear before DELEGATE${formatLineNum(listItemNode)}`,
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
          `Invalid nested bullet under FOR clause in step "${ctx.currentStep.name}": only transitions (PASS/FAIL/DEFER) are allowed${formatLineNum(nestedItem)}`,
        );
      }
      const nestedText = extractText(nestedParagraph);
      const cond = parseConditional(nestedText);
      if (!cond) {
        throw new RunbookSyntaxError(
          `Invalid nested bullet under FOR clause in step "${ctx.currentStep.name}": only transitions (PASS/FAIL/DEFER) are allowed${formatLineNum(nestedItem)}`,
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
    const ps = ctx.currentStep.pendingSubstep;
    // Reject transitions after prompt text or non-runbook body content (header-adjacent
    // requirement). Runbook entries alone do not block — they are structural references,
    // not prose — but once any code block / prose bullet has been seen we must stay
    // blocked even if further runbook bullets follow. `hasSeenNonRunbookContent` is a
    // sticky flag that captures exactly that; the older `hasSeenContent && !hasSeenRunbooks`
    // gate failed the "runbook → code block → runbook → transition" case because
    // `hasSeenRunbooks` remained `true` indefinitely.
    const hasBlockingContent = ps.hasSeenPromptText || ps.hasSeenNonRunbookContent;
    if (hasBlockingContent) {
      throw new RunbookSyntaxError(
        `Substep ${ctx.currentStep.name}.${ps.id}${lineNum}: Transitions must appear immediately after the substep header, before any content.`,
      );
    }
    ps.pendingConditionals.push(...conditionals);
    ps.hasSeenTransitions = true;
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
  isRunbookListEntry: boolean,
  node: Node,
  ctx: ActiveStepContext,
): void {
  const lineNum = formatLineNum(node);
  if (ctx.currentStep.pendingSubstep) {
    // Check ordering BEFORE adding content
    // In substeps: text cannot appear after transitions
    if (ctx.currentStep.pendingSubstep.hasSeenTransitions && !isRunbookListEntry) {
      throw new RunbookSyntaxError(
        `Substep ${ctx.currentStep.name}.${ctx.currentStep.pendingSubstep.id}${lineNum}: Prompt text must appear before code blocks or runbooks.`,
      );
    }
    // Only add content after validation passes
    ctx.currentStep.pendingSubstep.content += ` - ${text}\n`;
    // Mark content seen for runbook list entries; mark prompt seen for non-runbook bullets
    if (isRunbookListEntry) {
      ctx.currentStep.pendingSubstep.hasSeenContent = true;
    } else {
      ctx.currentStep.pendingSubstep.hasSeenPromptText = true;
    }
  } else {
    // Check ordering BEFORE adding content
    if (ctx.currentStep.hasSeenContent && !isRunbookListEntry) {
      throw new RunbookSyntaxError(
        `Step ${ctx.currentStep.name}${lineNum}: Prompt text must appear before code blocks, substeps, or runbooks.`,
      );
    }
    // Only add content after validation passes
    const itemText = ` - ${text}\n`;
    ctx.currentStep.content += itemText;
    if (!isRunbookListEntry) {
      ctx.implicitText += itemText;
      // Non-runbook bullets are prompt text — mark so ordering guards fire correctly
      ctx.currentStep.hasSeenPromptText = true;
    } else {
      // Mark content seen if runbook list
      ctx.currentStep.hasSeenContent = true;
    }
  }
}

/**
 * Process an `- ARTIFACTS` directive list item.
 *
 * Reads the nested list under `- ARTIFACTS` and collects each item as an
 * ArtifactDeclaration. Returns `SKIP` to prevent double-traversal of the nested list.
 *
 * Ordering: ARTIFACTS must be the first directive after the heading. It is
 * rejected after OUTPUTS, FOR (step-level), DELEGATE, transitions, prompt,
 * or body content.
 *
 * @param node - The list item node whose first paragraph text is "ARTIFACTS"
 * @param ctx - Active step context
 * @returns `SKIP` to stop the visitor from descending into child nodes
 * @throws {RunbookSyntaxError} When the directive is misordered, duplicated,
 *   missing nested entries, or contains invalid declarations.
 */
function handleArtifactsDirective(node: ListItem, ctx: ActiveStepContext): typeof SKIP {
  const target = getDirectiveTarget(ctx);
  const targetLabel = formatDirectiveTarget(ctx);
  const lineNum = formatLineNum(node);

  if (target.outputs !== undefined) {
    throw new RunbookSyntaxError(
      `ARTIFACTS directive in ${targetLabel}${lineNum}: must appear before OUTPUTS`,
    );
  }
  if (!ctx.currentStep.pendingSubstep && ctx.currentStep.hasSeenForClause) {
    throw new RunbookSyntaxError(
      `ARTIFACTS directive in ${targetLabel}${lineNum}: must appear before FOR`,
    );
  }
  if (target.hasSeenDelegate) {
    throw new RunbookSyntaxError(
      `ARTIFACTS directive in ${targetLabel}${lineNum}: must appear before DELEGATE`,
    );
  }
  if (target.hasSeenTransitions) {
    throw new RunbookSyntaxError(
      `ARTIFACTS directive in ${targetLabel}${lineNum}: must appear before transitions`,
    );
  }

  let hasBlockingContent: boolean;
  if (ctx.currentStep.pendingSubstep) {
    const ps = ctx.currentStep.pendingSubstep;
    hasBlockingContent = ps.hasSeenPromptText || ps.hasSeenNonRunbookContent;
  } else {
    hasBlockingContent = target.hasSeenContent || target.hasSeenPromptText;
  }
  if (hasBlockingContent) {
    throw new RunbookSyntaxError(
      `ARTIFACTS directive in ${targetLabel}${lineNum}: must appear before prompt text and body content`,
    );
  }

  if (target.artifacts && target.artifacts.length > 0) {
    throw new RunbookSyntaxError(
      `Duplicate ARTIFACTS directive in ${targetLabel}${lineNum}: a target may declare ARTIFACTS at most once`,
    );
  }

  const nestedList = node.children.find((c): c is List => c.type === 'list');
  if (!nestedList || nestedList.children.length === 0) {
    throw new RunbookSyntaxError(
      `ARTIFACTS directive in ${targetLabel}${lineNum} requires at least one artifact declaration (e.g., "  - PlanPath \\"plan.json\\"")`,
    );
  }

  const declarations: ArtifactDeclaration[] = [];
  const seen = new Set<string>();
  for (const item of nestedList.children) {
    const paragraph = item.children.find((c) => c.type === 'paragraph');
    if (!paragraph) {
      throw new RunbookSyntaxError(
        `Invalid ARTIFACTS declaration in ${targetLabel}${formatLineNum(item)}: expected \`Name\` or \`Name "<token>"\``,
      );
    }
    const text = extractText(paragraph);
    const decl = parseArtifactDeclaration(text);
    if (!decl) {
      throw new RunbookSyntaxError(
        `Invalid ARTIFACTS declaration in ${targetLabel}${formatLineNum(item)}: "${text.trim()}" — expected \`Name\` (naked assertion) or \`Name "<token>"\` where the token is a quoted artifact key, glob, URI, or template`,
      );
    }
    if (isReservedTemplateName(decl.name)) {
      throw new RunbookSyntaxError(
        `Invalid ARTIFACTS declaration in ${targetLabel}${formatLineNum(item)}: "${decl.name}" is a reserved variable name (${formatReservedTemplateNames()} — case-insensitive)`,
      );
    }
    if (seen.has(decl.name)) {
      throw new RunbookSyntaxError(
        `Duplicate artifact alias "${decl.name}" in ${targetLabel}${formatLineNum(item)}: each alias must be unique within an ARTIFACTS block`,
      );
    }
    seen.add(decl.name);
    declarations.push(decl);
  }

  target.artifacts = declarations;
  return SKIP;
}

/**
 * Process an OUTPUTS directive list item.
 *
 * Reads the nested list under `- OUTPUTS` and collects each item as an
 * OutputDeclaration. Returns `SKIP` to prevent double-traversal of the nested list.
 *
 * @param node - The list item node whose first paragraph text is "OUTPUTS"
 * @param ctx - Active step context
 * @returns `SKIP` to stop the visitor from descending into child nodes
 * @throws {RunbookSyntaxError} When nested items are missing or have invalid syntax
 */
function handleOutputsDirective(node: ListItem, ctx: ActiveStepContext): typeof SKIP {
  const target = getDirectiveTarget(ctx);
  const targetLabel = formatDirectiveTarget(ctx);

  // OUTPUTS must precede FOR, DELEGATE, and body content. It is intentionally
  // interchangeable with transitions — see the "must not over-reach" test in
  // parser.test.ts, so there is deliberately no hasSeenTransitions gate here.
  // These gates mirror the before-FOR / before-DELEGATE checks in
  // handleArtifactsDirective. The FOR clause is step-level, so its gate only
  // constrains a step-level OUTPUTS; a substep OUTPUTS is structurally after
  // the parent FOR and is exempt.
  if (!ctx.currentStep.pendingSubstep && ctx.currentStep.hasSeenForClause) {
    throw new RunbookSyntaxError(
      `OUTPUTS directive in ${targetLabel}${formatLineNum(node)}: must appear before FOR`,
    );
  }
  if (target.hasSeenDelegate) {
    throw new RunbookSyntaxError(
      `OUTPUTS directive in ${targetLabel}${formatLineNum(node)}: must appear before DELEGATE`,
    );
  }

  // Gate mirrors handleDelegateAnnotation: on a pending substep, runbook-list
  // entries alone do not block subsequent structural directives on the same
  // synthesized substep. Only prose prompt text and non-runbook body content
  // block OUTPUTS. `hasSeenNonRunbookContent` stays sticky across later runbook
  // bullets so the gate still fires after "runbook → code block → runbook".
  let hasBlockingContent: boolean;
  if (ctx.currentStep.pendingSubstep) {
    const ps = ctx.currentStep.pendingSubstep;
    hasBlockingContent = ps.hasSeenPromptText || ps.hasSeenNonRunbookContent;
  } else {
    hasBlockingContent = target.hasSeenContent || target.hasSeenPromptText;
  }
  if (hasBlockingContent) {
    throw new RunbookSyntaxError(
      `OUTPUTS directive in ${targetLabel}${formatLineNum(node)}: must appear before prompt text and body content`,
    );
  }
  const nestedList = node.children.find((c): c is List => c.type === 'list');
  if (!nestedList || nestedList.children.length === 0) {
    throw new RunbookSyntaxError(
      `OUTPUTS directive in ${targetLabel}${formatLineNum(node)} requires at least one output declaration (e.g., "  - PlanPath {{ path \\"plan.json\\" }}")`,
    );
  }

  if (target.outputs && target.outputs.length > 0) {
    throw new RunbookSyntaxError(
      `Duplicate OUTPUTS directive in ${targetLabel}${formatLineNum(node)}: a target may declare OUTPUTS at most once`,
    );
  }

  const declarations: OutputDeclaration[] = [];
  const seen = new Set<string>();
  for (const item of nestedList.children) {
    const paragraph = item.children.find((c) => c.type === 'paragraph');
    if (!paragraph) {
      throw new RunbookSyntaxError(
        `Invalid OUTPUTS declaration in ${targetLabel}${formatLineNum(item)}: expected "Name value"`,
      );
    }
    const text = extractText(paragraph);
    const decl = parseStepOutputDeclaration(text);
    if (!decl) {
      const hasWhitespace = /\s/.test(text.trim());
      const reason = hasWhitespace
        ? 'expression-form step/substep OUTPUTS entries are not allowed; use the name-only form (e.g., "  - PlanPath") and pair with `- ARTIFACTS` if you need an artifact alias'
        : 'expected a name (e.g., "Version") matching the variable-name pattern';
      throw new RunbookSyntaxError(
        `Invalid OUTPUTS declaration in ${targetLabel}${formatLineNum(item)}: "${text.trim()}" — ${reason}`,
      );
    }
    if (isReservedTemplateName(decl.name)) {
      throw new RunbookSyntaxError(
        `Invalid OUTPUTS declaration in ${targetLabel}${formatLineNum(item)}: "${decl.name}" is a reserved variable name (${formatReservedTemplateNames()} — case-insensitive)`,
      );
    }
    if (seen.has(decl.name)) {
      throw new RunbookSyntaxError(
        `Duplicate output name "${decl.name}" in ${targetLabel}${formatLineNum(item)}: each output name must be unique within an OUTPUTS block`,
      );
    }
    seen.add(decl.name);
    declarations.push(decl);
  }

  target.outputs = declarations;
  return SKIP;
}

/**
 * Process a `- DELEGATE` annotation on a step or substep.
 *
 * DELEGATE marks a step or substep as a delegation dispatch point.
 * Valid ordering: DELEGATE must appear before transitions and content.
 * At step level, it may follow a FOR clause but not precede one.
 *
 * @param node - The list item node whose text is "DELEGATE"
 * @param ctx - Active step context
 * @throws {RunbookSyntaxError} When ordering is violated or DELEGATE is duplicated
 */
function handleDelegateAnnotation(node: ListItem, ctx: ActiveStepContext): void {
  const target = getDirectiveTarget(ctx);
  const targetLabel = formatDirectiveTarget(ctx);
  const lineNum = formatLineNum(node);

  if (target.hasSeenDelegate) {
    throw new RunbookSyntaxError(
      `Duplicate DELEGATE in ${targetLabel}${lineNum}: DELEGATE may only appear once`,
    );
  }
  if (target.hasSeenTransitions) {
    throw new RunbookSyntaxError(
      `DELEGATE in ${targetLabel}${lineNum}: DELEGATE must appear before transitions`,
    );
  }
  // For substeps with runbook entries, hasSeenContent is set by the runbook entry itself.
  // We only block DELEGATE after prose prompt text or non-runbook body content — runbook
  // references are structural, not prose, so per-entry annotations are always valid.
  // `hasSeenNonRunbookContent` remains sticky across later runbook bullets so the gate
  // fires correctly after "runbook → code block → runbook".
  let hasBlockingContent: boolean;
  if (ctx.currentStep.pendingSubstep) {
    const ps = ctx.currentStep.pendingSubstep;
    hasBlockingContent = ps.hasSeenPromptText || ps.hasSeenNonRunbookContent;
  } else {
    hasBlockingContent = target.hasSeenContent || target.hasSeenPromptText;
  }
  if (hasBlockingContent) {
    throw new RunbookSyntaxError(
      `DELEGATE in ${targetLabel}${lineNum}: DELEGATE must appear before prompt text and body content`,
    );
  }

  target.hasSeenDelegate = true;
}

/**
 * Process a list item node within an active step.
 *
 * @param node - The list item AST node
 * @param ctx - Active step context (currentStep guaranteed non-null)
 * @returns `SKIP` when a FOR clause is handled (prevents child traversal), `undefined` otherwise
 * @throws {RunbookSyntaxError} When a FOR clause is invalid or appears in a substep context
 */
function handleListItem(node: ListItem, ctx: ActiveStepContext): typeof SKIP | undefined {
  const firstParagraph = node.children.find((c) => c.type === 'paragraph');
  if (!firstParagraph) return;

  const text = extractText(firstParagraph);
  const trimmedText = text.trim();

  // Check for ARTIFACTS directive on the active execution unit (step or substep).
  if (trimmedText === 'ARTIFACTS') {
    return handleArtifactsDirective(node, ctx);
  }

  // Check for OUTPUTS directive on the active execution unit (step or substep)
  if (trimmedText === 'OUTPUTS') {
    return handleOutputsDirective(node, ctx);
  }

  // The - INPUTS step directive has been removed.
  // Exact match only — prose starting with "INPUTS" (e.g., "INPUTS are validated by…")
  // is not a directive and is not affected.
  if (trimmedText === 'INPUTS') {
    ctx.diagnostics.push({
      severity: 'error',
      message: 'INPUTS step directive has been removed — use frontmatter inputs: field instead',
    });
    return SKIP;
  }

  // Check for DELEGATE annotation (bare keyword, no arguments)
  if (trimmedText === 'DELEGATE') {
    handleDelegateAnnotation(node, ctx);
    return;
  }

  // Reject DELEGATE with arguments (syntax error). Uses /^DELEGATE\s/ so any
  // Unicode whitespace after the keyword — not just space / tab — triggers
  // the error message.
  if (/^DELEGATE\s/.test(trimmedText)) {
    throw new RunbookSyntaxError(
      `DELEGATE takes no arguments${formatLineNum(node)}; use bare "- DELEGATE" to mark a step for delegation. Found: "${trimmedText}"`,
    );
  }

  // Check for FOR clause BEFORE conditionals
  const forResult = parseForClause(text);

  // Throw if text looks like a FOR clause but didn't parse,
  // unless it contains template variables ({{...}}) that need runtime expansion
  if (forResult === null && text.trim().startsWith('FOR ')) {
    throw new RunbookSyntaxError(`Invalid FOR clause${formatLineNum(node)}: ${text.trim()}`);
  }

  if (forResult && !ctx.currentStep.pendingSubstep) {
    // FOR is only valid at step level, not substep level
    handleForClause(forResult, node, ctx);
    return SKIP; // Don't process this list item further
  }

  // If FOR text appears in a substep context, that's an error
  if (forResult && ctx.currentStep.pendingSubstep) {
    throw new RunbookSyntaxError(
      `FOR is only valid on steps (H2), not substeps (H3)${formatLineNum(node)}. Found on "${ctx.currentStep.name}.${ctx.currentStep.pendingSubstep.id}".`,
    );
  }

  const isRunbookListEntry =
    /^\S+\.runbook\.md$/.test(trimmedText) || TEMPLATE_VAR_REF_RE.test(trimmedText);

  if (isRunbookListEntry) {
    // Parse the single entry by reusing extractRunbookList with a single-line string.
    const entries = extractRunbookList(` - ${trimmedText}\n`);
    const entry = entries[0];

    if (ctx.currentStep.pendingSubstep && !ctx.currentStep.pendingSubstep.isRunbookDerived) {
      // H3 substep context: add the runbook reference directly to the substep.
      // Nested annotations (- DELEGATE, - PASS CONTINUE) will be visited by the
      // walker and land on this pendingSubstep via the existing handlers.
      ctx.currentStep.pendingSubstep.runbooks.push(entry);
      ctx.currentStep.pendingSubstep.hasSeenContent = true;
      ctx.currentStep.pendingSubstep.hasSeenRunbooks = true;
    } else {
      // Step-level (or successive runbook entry after a prior runbook-derived substep):
      // finalize the previous runbook-derived substep, then start a new one.
      if (ctx.currentStep.pendingSubstep?.isRunbookDerived) {
        finalizePendingSubstep(ctx);
      }
      // Runbook-list entries are pure delegation targets. Paragraph prose between
      // the step header and the list stays on the step (ctx.implicitText flows
      // through finalizeStep into step.prompt) — do not migrate it onto substep[0].
      ctx.currentStep.pendingSubstep = {
        id: String(ctx.currentStep.substeps.length + 1),
        description: '',
        content: '',
        command: undefined,
        promptText: '',
        hasSeenContent: true,
        // Runbook-derived substeps start with only the runbook bullet — no non-runbook
        // content has been seen yet, so directives/transitions are still valid on them.
        hasSeenNonRunbookContent: false,
        hasSeenTransitions: false,
        hasSeenPromptText: false,
        hasSeenDelegate: false,
        hasSeenRunbooks: true,
        pendingConditionals: [],
        line: node.position?.start.line,
        outputs: undefined,
        artifacts: undefined,
        runbooks: [entry],
        isRunbookDerived: true,
      };
      ctx.currentStep.hasRunbookListSubsteps = true;
      ctx.currentStep.hasSeenContent = true;
    }
    // Do NOT return SKIP. The AST walker visits the nested list items (- DELEGATE,
    // - PASS CONTINUE, etc.) as subsequent ListItem nodes. At that point
    // ctx.currentStep.pendingSubstep is set, so existing handlers apply correctly.
    return;
  }

  const conditionalResult = parseConditional(text);
  if (conditionalResult) {
    const conditionals = Array.isArray(conditionalResult) ? conditionalResult : [conditionalResult];
    handleListItemTransition(conditionals, node, ctx);
  } else {
    handleListItemContent(text, false, node, ctx);
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

function visitNode(
  node: Node,
  parent: Node | undefined,
  ctx: VisitorContext,
): typeof SKIP | undefined {
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
    const diag = errors[0];
    const msg = diag.line ? `${diag.message}${formatLineNum(diag.line)}` : diag.message;
    throw new RunbookSyntaxError(msg);
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
  const {
    frontmatter,
    content,
    diagnostics: frontmatterDiagnostics,
  } = extractFrontmatter(markdown);
  const tree = fromMarkdown(content);

  const ctx: VisitorContext = {
    steps: [],
    title: undefined,
    preamble: '',
    currentStep: null,
    pendingConditionals: [],
    implicitText: '',
    inPreamble: true,
    diagnostics: [],
  };

  visit(tree, (node: Node, _index, parent: Node | undefined) => visitNode(node, parent, ctx));

  finalizePendingSubstep(ctx);

  if (ctx.currentStep) {
    ctx.steps.push(finalizeStep(ctx.currentStep, ctx.pendingConditionals, ctx.implicitText));
  }

  const diagnostics = [
    ...frontmatterDiagnostics,
    ...ctx.diagnostics,
    ...validateRunbook(ctx.steps),
  ];

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

  const prompt = promptText.trim() || undefined;

  // Resolve substep defaults based on context.
  // Substeps with explicit transitions (from authored conditionals) keep them as-is.
  // Substeps with placeholder DEFAULT_TRANSITIONS (no authored conditionals) get
  // context-aware defaults: DEFER under aggregation or with runbooks, DEFAULT otherwise.
  const resolveSubstepDefaults = (substeps: ParsedSubstep[]): ParsedSubstep[] =>
    substeps.map((sub) => {
      if (sub.transitions !== DEFAULT_TRANSITIONS) return sub; // explicit — keep as-is
      if (sub.runbooks?.length) return { ...sub, transitions: DEFER_TRANSITIONS }; // delegation
      if (stepAggregation) return { ...sub, transitions: DEFER_TRANSITIONS }; // under step aggregation
      if (step.forClause?.aggregation) return { ...sub, transitions: DEFER_TRANSITIONS }; // under iteration aggregation
      return sub; // DEFAULT_TRANSITIONS is correct for sequential
    });

  // Propagate step-level delegate flag to all substeps.
  // Step-level DELEGATE is shorthand for DELEGATE on all substeps.
  const propagateDelegateToSubsteps = (substeps: ParsedSubstep[]): ParsedSubstep[] => {
    if (!step.hasSeenDelegate) return substeps;
    return substeps.map((sub) => (sub.delegate ? sub : { ...sub, delegate: true as const }));
  };

  // Runbook list entries are now finalized as individual substeps during parsing.
  // Validate exclusivity and fall through to the shared substep path below.
  if (step.hasRunbookListSubsteps) {
    if (step.command) {
      throw new RunbookSyntaxError(
        `Step ${step.name}: Violates Exclusivity Rule. A step must have exactly one of {Body, Substeps}.`,
      );
    }
    // step.substeps is already populated; fall through to the shared substep path below.
  }

  // Step-level DELEGATE requires at least one substep to propagate to.
  // Base steps (no body, no substeps) and command steps (body only) have
  // nothing to delegate — reject per docs/spec/language.md §4.3.
  if (step.hasSeenDelegate && step.substeps.length === 0) {
    throw new RunbookSyntaxError(
      `Step "${step.name}": DELEGATE requires at least one substep; ` +
        `base and command steps have no substep or runbook target to delegate to.`,
    );
  }

  // Step-level DELEGATE propagates to every substep. finalizePendingSubstep's
  // per-substep runbook-target guard only fires when `ps.hasSeenDelegate` is
  // set on the substep itself — propagation happens later, here, so an H3
  // substep without `.runbook.md` can slip through for step-level DELEGATE
  // unless we re-check at propagation time.
  if (step.hasSeenDelegate) {
    const missingRunbookTarget = step.substeps.find((sub) => !sub.runbooks?.length);
    if (missingRunbookTarget) {
      throw new RunbookSyntaxError(
        `Step "${step.name}": DELEGATE cannot propagate to substep ` +
          `"${step.name}.${missingRunbookTarget.id}" because it has no runbook target ` +
          `(add a "- <name>.runbook.md" entry, or remove step-level DELEGATE and ` +
          `annotate only the substeps that have runbook targets).`,
      );
    }
  }

  // Resolve substep defaults and propagate step-level DELEGATE flag
  const resolvedSubsteps = propagateDelegateToSubsteps(resolveSubstepDefaults(step.substeps));

  // Build shared fields once (aggregation excluded — only added to parent step kinds)
  const shared = {
    name: step.name,
    description: step.description,
    prompt,
    transitions: stepTransitions,
    line: step.line,
    outputs: step.outputs,
    artifacts: step.artifacts,
  };

  if (step.forClause) {
    return {
      ...shared,
      kind: 'for' as const,
      aggregation: stepAggregation,
      substepsDerivedFromRunbookList: step.hasRunbookListSubsteps,
      forClause: step.forClause,
      substeps: resolvedSubsteps.length > 0 ? resolvedSubsteps : [],
    };
  }

  if (resolvedSubsteps.length > 0) {
    return {
      ...shared,
      kind: 'substeps' as const,
      aggregation: stepAggregation,
      substepsDerivedFromRunbookList: step.hasRunbookListSubsteps,
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
