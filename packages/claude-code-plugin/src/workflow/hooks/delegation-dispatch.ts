// src/workflow/hooks/delegation-dispatch.ts

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseRunbookDocument } from '@rundown-org/parser';
import type { HookInput } from '../../shared/index.js';
import { Session } from '../../session.js';
import { detectDelegationInToolInput } from './delegation-detector.js';
import { rundown } from './rundown.js';

/**
 * Compute the token hash used in delegation state for correlation.
 * Replicates the same algorithm as `hashDelegationToken` in `@rundown-org/core`.
 *
 * @param token - Raw delegation token string
 * @returns SHA-256 hash in `sha256:<hex>` format
 */
function hashToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

/**
 * Shell-safe quote a string value for use in a `--var key=value` flag.
 * Wraps in single quotes and escapes internal single quotes.
 *
 * @param value - The string value to quote
 * @returns Single-quoted shell-safe string
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Tool names that carry delegation context. */
type DelegationToolName = 'Agent' | 'Task';

/**
 * Type guard for tool names that support delegation dispatch.
 * @param toolName - Tool name from hook input
 * @returns True when the tool is Agent or Task
 */
function isDelegationToolName(toolName: HookInput['tool_name']): toolName is DelegationToolName {
  return toolName === 'Agent' || toolName === 'Task';
}

/**
 * Result from delegation dispatch handling.
 */
export interface DelegationDispatchResult {
  /** Context to inject into the subagent prompt */
  context?: string;
  /** Violation message if dispatch should be blocked */
  violation?: string;
}

/**
 * Build `--var key=value` flags for a child runbook from parent's live variable space.
 *
 * Reads the child runbook's frontmatter `inputs:` keys and, for each key that
 * exists in the parent's vars, produces a `--var key=value` flag. Non-fatal:
 * returns empty string on any error.
 *
 * @param childRunbookPath - Absolute or cwd-relative path to the child runbook
 * @param parentVars - Parent's live variable space from `rd status --json`
 * @param cwd - Current working directory for resolving relative paths
 * @returns Space-separated `--var` flags string, or empty string
 */
async function buildChildVarFlags(
  childRunbookPath: string,
  parentVars: Record<string, string>,
  cwd: string,
): Promise<string> {
  if (Object.keys(parentVars).length === 0) return '';
  try {
    const resolved = path.isAbsolute(childRunbookPath)
      ? childRunbookPath
      : path.resolve(cwd, childRunbookPath);
    const src = await fs.readFile(resolved, 'utf-8');
    const { frontmatter } = parseRunbookDocument(src);
    const inputKeys = Object.keys(frontmatter?.inputs ?? {});
    // Shell-quote values so spaces and special characters are preserved when the
    // claim command string is executed by Claude Code's task/agent tool.
    return inputKeys
      .filter((key) => Object.hasOwn(parentVars, key))
      .map((key) => `--var ${key}=${shellQuote(parentVars[key])}`)
      .join(' ');
  } catch {
    return '';
  }
}

/**
 * Detect delegation markers in a PreToolUse Agent/Task event, persist the delegation token in
 * session metadata for abort correlation, and produce a Markdown context instructing
 * the subagent to claim the token and report results.
 *
 * The context includes a claim command (`rd claim <token>`) and may include best-effort
 * runbook/step hints when available.
 *
 * @param input - Hook input received from Claude Code for the event
 * @returns A Dispatch result containing `context` with the delegation instructions when a token
 *          is found; an empty object when no delegation is detected or the event is not applicable.
 * @throws {Error} When session metadata cannot be read or written
 */
export async function handleDelegationDispatch(
  input: HookInput,
): Promise<DelegationDispatchResult> {
  if (input.hook_event_name !== 'PreToolUse' || !isDelegationToolName(input.tool_name)) {
    return {};
  }

  const detection = detectDelegationInToolInput(
    input.tool_input?.prompt,
    input.tool_input?.description,
  );

  if (!detection) {
    return {};
  }

  const { token } = detection;

  // Store token in session metadata for SubagentStop abort correlation
  const session = new Session(input.cwd);
  const meta = await session.get('metadata');
  await session.set('metadata', { ...meta, delegation_active_token: token });

  // Best-effort: enrich with current delegation status and inject child --var flags
  let claimCommand = `rd claim ${token}`;
  const statusLines: string[] = [];
  try {
    const statusOutput = rundown(['status'], input.cwd);
    const status = JSON.parse(statusOutput) as Record<string, unknown>;
    const file = typeof status.file === 'string' ? status.file : undefined;
    const step =
      status.step && typeof (status.step as Record<string, unknown>).name === 'string'
        ? ((status.step as Record<string, unknown>).name as string)
        : undefined;
    if (file) statusLines.push(`Active runbook: ${file}`);
    if (step) statusLines.push(`Current step: ${step}`);

    // Inject --var flags from child runbook's inputs: keys using parent's live vars.
    // Match the delegation entry by tokenHash to correctly identify the child runbook
    // when multiple delegations are pending simultaneously.
    const parentVars = (status as { vars?: Record<string, string> }).vars;
    const delegations = (
      status as {
        delegations?: Array<{ runbook: string; state: string; tokenHash: string }>;
      }
    ).delegations;
    const detectedTokenHash = hashToken(token);
    const pending = delegations?.find(
      (d) => d.state === 'pending' && d.tokenHash === detectedTokenHash,
    );
    const childRunbookPath = pending?.runbook;
    if (childRunbookPath && parentVars) {
      const varFlags = await buildChildVarFlags(childRunbookPath, parentVars, input.cwd);
      if (varFlags) claimCommand = `rd claim ${token} ${varFlags}`;
    }
  } catch {
    // Best-effort enrichment — continue without status
  }

  const lines = [
    '## Delegation Context',
    '',
    'This task is a delegated substep. Claim the delegation token before starting work:',
    '',
    '```',
    claimCommand,
    '```',
    '',
    ...statusLines,
    ...(statusLines.length > 0 ? [''] : []),
    'After completing the delegated work, use `rd pass` or `rd fail` to report the result.',
  ];

  return { context: lines.join('\n') };
}
