/**
 * Scenario placeholders for the in-browser demo runner.
 *
 * A scenario's mutating commands name their authority with a placeholder —
 * `rd pass --token ${TOKEN} --step 1` — because the Owner Token is minted by
 * that scenario's own `rd run` and cannot be written down ahead of time. The
 * CLI's scenario harness fills the placeholders from the output of the commands
 * it has already run (`packages/cli/src/helpers/command-sequence.ts`,
 * `CAPTURE_PLACEHOLDERS`). The demo steps through the same command lists one
 * click at a time, so it has to do the same carrying: read what `rd run`
 * printed, then substitute into the commands that follow.
 *
 * This is command plumbing, not runbook logic: the runner copies a value the
 * CLI printed into the next command line, exactly as a person at a terminal
 * would. Which step is current, and whether a token is accepted, stay the
 * CLI's call.
 *
 * The site cannot import the harness (a Node module in `@rundown-org/cli`), so
 * the two placeholder families are restated here. Unlike the harness, the demo
 * also runs commands with `--text`, so each family is read from both renderings
 * of `runbook_started`.
 */

/** Values captured so far, per placeholder family, in the order printed. */
export interface CapturedPlaceholders {
  /** Owner Tokens (`${TOKEN}`, `${TOKEN_2}`, …). */
  TOKEN: string[];
  /** Run ids (`${RUN_ID}`, `${RUN_ID_2}`, …). */
  RUN_ID: string[];
}

type PlaceholderName = keyof CapturedPlaceholders;

const PLACEHOLDER_NAMES: readonly PlaceholderName[] = ['TOKEN', 'RUN_ID'];

// `--text` rendering of `runbook_started`: aligned `Key: value` lines.
const TEXT_OWNER_TOKEN_RE = /^Owner token:\s+(rdo_[A-Za-z0-9_-]+)\s*$/;
const TEXT_RUN_ID_RE = /^Run:\s+(rd_[0-9a-f]+)\s*$/;

/**
 * Create an empty capture accumulator.
 *
 * @returns An accumulator with no captured values
 */
export function createCapturedPlaceholders(): CapturedPlaceholders {
  return { TOKEN: [], RUN_ID: [] };
}

/**
 * Record every placeholder value one command printed.
 *
 * Reads both output formats, line by line: the default JSON event stream
 * (`runbook_started.owner_token` / `.runbookId`) and the `--text` rendering
 * (`Owner token:` / `Run:` lines). Lines that are neither are ignored.
 *
 * @param captured - Accumulator to append to
 * @param output - One command's complete output, ANSI codes already stripped
 */
export function capturePlaceholders(captured: CapturedPlaceholders, output: string): void {
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('{')) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof event !== 'object' || event === null) continue;
      const record = event as Record<string, unknown>;
      if (record.type !== 'runbook_started') continue;
      if (typeof record.owner_token === 'string') captured.TOKEN.push(record.owner_token);
      if (typeof record.runbookId === 'string') captured.RUN_ID.push(record.runbookId);
      continue;
    }
    const token = TEXT_OWNER_TOKEN_RE.exec(line);
    if (token?.[1] !== undefined) captured.TOKEN.push(token[1]);
    const runId = TEXT_RUN_ID_RE.exec(line);
    if (runId?.[1] !== undefined) captured.RUN_ID.push(runId[1]);
  }
}

/**
 * Replace every `${NAME}` / `${NAME_n}` placeholder in a scenario command.
 *
 * `${TOKEN}` is the first captured Owner Token, `${TOKEN_2}` the second, and
 * so on (1-based), matching the CLI harness.
 *
 * @param command - A scenario command as written in the runbook's frontmatter
 * @param captured - Values captured from earlier commands' output
 * @returns The command with every placeholder replaced
 * @throws {Error} When a placeholder names a value no earlier command printed
 */
export function substitutePlaceholders(command: string, captured: CapturedPlaceholders): string {
  let out = command;
  for (const name of PLACEHOLDER_NAMES) {
    const values = captured[name];
    out = out.replace(
      new RegExp(`\\$\\{${name}(?:_(\\d+))?\\}`, 'g'),
      (match: string, position: string | undefined) => {
        const value = values[position === undefined ? 0 : Number.parseInt(position, 10) - 1];
        if (value === undefined) {
          throw new Error(
            `${match} has no value yet: no earlier command in this scenario printed one (have ${String(values.length)}).`,
          );
        }
        return value;
      },
    );
  }
  return out;
}
