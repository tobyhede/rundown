import { DelegationActiveTokensMetadataSchema, type HookInput } from '../../shared/index.js';
import { Session } from '../../session.js';

/** Result of the delegated Bash preflight guard. */
export interface DelegatedBashGuardResult {
  /** Human-readable warning when a bare delegated transition is detected; absent when allowed. */
  readonly violation?: string;
}

const TRANSITION_COMMANDS = new Set(['pass', 'fail', 'yes', 'ok', 'no']);

function bashCommand(input: HookInput): string | null {
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return null;
  }
  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === 'string' ? command : null;
}

function isBareRundownTransition(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return false;
  }

  // KNOWN LIMITATION: this parses only the first token of the first line. A
  // chained command such as `echo x && rd pass` is NOT detected here, and a
  // bare transition hidden after `;`/`&&`/`|` slips through. That is acceptable
  // because this hook is a non-authoritative UX preflight only — core's
  // resolveTransitionTarget is the real correctness boundary and still refuses
  // the unsafe parent transition regardless of how the command was shaped.
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const parts = firstLine.split(/\s+/);
  const binary = parts[0];
  const subcommand = parts[1];

  if (binary !== 'rd' && binary !== 'rundown') {
    return false;
  }
  if (!subcommand || !TRANSITION_COMMANDS.has(subcommand)) {
    return false;
  }

  // Treat both `--claim-id <value>` and `--claim-id=<value>` as claim-targeted
  // so a legitimately scoped command is not flagged.
  const claimTargeted = parts.some(
    (part) => part === '--claim-id' || part.startsWith('--claim-id='),
  );
  return !claimTargeted;
}

async function agentHasActiveDelegation(input: HookInput): Promise<boolean> {
  const session = new Session(input.cwd);
  const meta = await session.get('metadata');

  if (input.agent_id) {
    const rawMap = meta.delegation_active_tokens;
    if (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
      const parsed = DelegationActiveTokensMetadataSchema.safeParse(rawMap);
      if (!parsed.success) {
        return false;
      }
      return Object.hasOwn(parsed.data, input.agent_id);
    }
  }

  return typeof meta.delegation_active_token === 'string';
}

/**
 * Optional plugin preflight warning for delegated subagent Bash calls.
 *
 * Correctness still lives in `@rundown-org/core` transition target resolution.
 * This hook exists only to catch an obvious mistake before Bash runs and to
 * produce a more local instruction for Claude Code users.
 *
 * @param input - Hook input from the Claude Code plugin dispatcher
 * @returns A violation when Bash is about to run a bare transition from delegated work
 */
export async function handleDelegatedBashGuard(
  input: HookInput,
): Promise<DelegatedBashGuardResult> {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
    return {};
  }

  const command = bashCommand(input);
  if (!command || !isBareRundownTransition(command)) {
    return {};
  }

  if (!(await agentHasActiveDelegation(input))) {
    return {};
  }

  return {
    violation:
      'This subagent has active delegated Rundown work. Do not run bare `rd pass` or `rd fail`; use `rd pass --claim-id <claim_id>` or `rd fail --claim-id <claim_id>`. Core Rundown also refuses unsafe bare parent transitions while claimed children are open.',
  };
}
