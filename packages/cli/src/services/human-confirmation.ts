/**
 * Whether a human is at the terminal, and their answer to a yes/no question
 * (#906, ADR 0005).
 *
 * The human escape hatch (`rundown stop --run <id>`) and pruning a running run
 * without its Owner Token need a person, not an agent: an agent's shell, a
 * pipe, a scenario harness and an MCP server all run without a terminal on
 * stdin. Reading the terminal is Category A — inherently external to the
 * runbook — so it lives here, and the commands take it as an injected
 * {@link HumanConfirmation} so tests drive both answers without a terminal.
 *
 * @module services/human-confirmation
 */

import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';

/** The human at the terminal, if there is one. */
export interface HumanConfirmation {
  /**
   * Whether a human can answer: stdin and stderr are both a terminal. The
   * prompt is written to stderr so stdout stays the command's JSON.
   */
  readonly interactive: boolean;
  /**
   * Ask a yes/no question. Resolves `true` only for an explicit yes; anything
   * else, an empty answer included, is no.
   *
   * @param question - The question, ending without the `[y/N]` suffix.
   * @returns Whether the human answered yes.
   */
  confirm(question: string): Promise<boolean>;
}

/** No human: every question is refused without being asked. */
export const NO_HUMAN: HumanConfirmation = {
  interactive: false,
  confirm: () => Promise.resolve(false),
};

/**
 * Whether an answer is an explicit yes.
 *
 * @param answer - The line the human typed.
 * @returns True for `y` or `yes`, in any case, surrounding space ignored.
 */
export function isYes(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

/**
 * The human at this process's terminal.
 *
 * @returns A confirmation that is interactive only when stdin and stderr are
 *   both terminals, and asks on stderr.
 */
export function terminalHumanConfirmation(): HumanConfirmation {
  const interactive = process.stdin.isTTY && process.stderr.isTTY;
  if (!interactive) return NO_HUMAN;
  return {
    interactive: true,
    async confirm(question: string): Promise<boolean> {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return isYes(await terminal.question(`${question} [y/N] `));
      } finally {
        terminal.close();
      }
    },
  };
}

/**
 * The human a command may ask, honouring the global `--non-interactive` flag.
 *
 * `--yes` is deliberately not honoured: it answers policy prompts, and a flag
 * an agent can type must never stand in for the human these questions are
 * for.
 *
 * @param command - The command being run, whose global options are read.
 * @param human - The human at the terminal, as injected.
 * @returns No human ({@link NO_HUMAN}) under `--non-interactive`, else `human`.
 */
export function humanAt(command: Command, human: HumanConfirmation): HumanConfirmation {
  return command.optsWithGlobals<{ nonInteractive?: boolean }>().nonInteractive === true
    ? NO_HUMAN
    : human;
}
