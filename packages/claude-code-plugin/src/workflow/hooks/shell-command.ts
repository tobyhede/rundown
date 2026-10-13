// src/workflow/hooks/shell-command.ts

/**
 * A small, conservative reader of the Bash commands an agent runs, for the
 * one thing the plugin needs from them (#907): finding `rundown claim` and
 * `rundown release` invocations and the exact source span of every word, so
 * the Bash hook can rewrite `--agent-id` without disturbing anything else.
 *
 * It is not a shell. It splits on control operators (`;`, `&`, `|`, `&&`,
 * `||`, newlines, parentheses), honours single and double quotes and
 * backslash escapes, drops redirections and comments, and skips the prefixes
 * agents put before a command (`VAR=value`, `env`, `command`, `exec`, `npx`,
 * `pnpm exec`, …). Anything whose words it cannot know without running a
 * shell — command substitution, backticks, process substitution, here-docs,
 * or a command handed to another interpreter (`sh -c`, `eval`, `xargs`) — is
 * reported `opaque`, and the hook fails closed on it when it may hide a claim.
 *
 * @module workflow/hooks/shell-command
 */

/** One shell word: its unquoted value and where it sits in the source. */
export interface ShellWord {
  /** The word's value after quote removal. */
  readonly text: string;
  /** Offset of the word's first character in the source. */
  readonly start: number;
  /** Offset just past the word's last character in the source. */
  readonly end: number;
}

/** The outcome of {@link scanShellCommand}. */
export type ShellScan =
  | {
      readonly kind: 'simple';
      /** Each simple command's words, redirections removed, in source order. */
      readonly commands: readonly (readonly ShellWord[])[];
    }
  | {
      readonly kind: 'opaque';
      /** The construct the scanner will not see through. */
      readonly construct: string;
    };

/** A Rundown subcommand the Bash hook stamps the agent id on. */
export type StampedSubcommand = 'claim' | 'release';

/** A `rundown claim` / `rundown release` invocation inside a command. */
export interface RundownInvocation {
  /** Which subcommand it is. */
  readonly subcommand: StampedSubcommand;
  /** The subcommand word; `--agent-id` is inserted right after it. */
  readonly subcommandWord: ShellWord;
  /** Every `--agent-id` the caller passed, each with the span to delete. */
  readonly agentIds: readonly { readonly start: number; readonly end: number }[];
}

/** Characters that end a word and the simple command it belongs to. */
const CONTROL = new Set([';', '&', '|', '\n', '(', ')']);

/** Interpreters that run another command line the scanner cannot see. */
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'eval', 'xargs', 'source', '.']);

/** Words that may lead a command without being it. */
const PREFIX_WORDS = new Set([
  '{',
  '}',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  'time',
  'command',
  'exec',
  'nohup',
  'npx',
  'bunx',
]);

/**
 * The program-level `rundown` options that take a value (`cli.ts`). A value
 * is skipped while looking for the subcommand; an option not listed is read
 * as a flag.
 */
const GLOBAL_VALUE_OPTIONS = new Set([
  '--allow-run',
  '--allow-read',
  '--allow-write',
  '--allow-env',
  '--policy',
  '--helpers',
]);

/** Package runners whose next word may be `exec` / `dlx` before the binary. */
const PACKAGE_RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);

/**
 * Split a Bash command into simple commands of words.
 *
 * @param source - The command string the Bash tool would run.
 * @returns The simple commands, or `opaque` when a construct hides words.
 */
export function scanShellCommand(source: string): ShellScan {
  const commands: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let text = '';
  let start = -1;
  let redirectTarget = false;

  const endWord = (end: number): void => {
    if (start < 0) return;
    if (redirectTarget) redirectTarget = false;
    else words.push({ text, start, end });
    text = '';
    start = -1;
  };
  const endCommand = (): void => {
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const begin = (at: number): void => {
    if (start < 0) start = at;
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '`' || (ch === '$' && next === '(')) {
      return { kind: 'opaque', construct: ch === '`' ? 'backticks' : 'command substitution' };
    }
    if ((ch === '<' || ch === '>') && next === '(') {
      return { kind: 'opaque', construct: 'process substitution' };
    }
    if (ch === "'") {
      begin(i);
      const close = source.indexOf("'", i + 1);
      if (close < 0) return { kind: 'opaque', construct: 'an unterminated quote' };
      text += source.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      begin(i);
      i += 1;
      while (i < source.length && source[i] !== '"') {
        const inner = source[i];
        if (inner === '`' || (inner === '$' && source[i + 1] === '(')) {
          return { kind: 'opaque', construct: 'command substitution' };
        }
        if (inner === '\\' && i + 1 < source.length && '"\\$`\n'.includes(source[i + 1])) {
          if (source[i + 1] !== '\n') text += source[i + 1];
          i += 2;
          continue;
        }
        text += inner;
        i += 1;
      }
      if (i >= source.length) return { kind: 'opaque', construct: 'an unterminated quote' };
      i += 1;
      continue;
    }
    if (ch === '\\') {
      if (next === '\n') {
        i += 2;
        continue;
      }
      begin(i);
      if (next !== undefined) text += next;
      i += 2;
      continue;
    }
    if (ch === '#' && start < 0) {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '<' || ch === '>') {
      if (ch === '<' && next === '<') return { kind: 'opaque', construct: 'a here-document' };
      // A file-descriptor number glued to the operator (`2>`) is not a word.
      if (start >= 0 && /^\d+$/.test(text) && source.slice(start, i) === text) {
        text = '';
        start = -1;
      } else {
        endWord(i);
      }
      i += 1;
      while (source[i] === '>' || source[i] === '&' || source[i] === '|') i += 1;
      redirectTarget = true;
      continue;
    }
    if (ch === '&' && next === '>') {
      endWord(i);
      i += 2;
      if (source[i] === '>') i += 1;
      redirectTarget = true;
      continue;
    }
    if (CONTROL.has(ch)) {
      endWord(i);
      redirectTarget = false;
      endCommand();
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord(i);
      i += 1;
      continue;
    }
    begin(i);
    text += ch;
    i += 1;
  }
  endWord(source.length);
  endCommand();
  return { kind: 'simple', commands };
}

/**
 * The base name of a command word (`/usr/local/bin/rundown` → `rundown`).
 *
 * @param word - The command word.
 * @returns Its last path segment.
 */
function baseName(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

/**
 * Whether a word names the Rundown CLI: `rundown`, `rd`, either by path, or
 * the CLI package's entry script run through `node`.
 *
 * @param words - The command's words.
 * @param at - Index of the candidate binary word.
 * @returns The index of the first word after the binary, or -1.
 */
function rundownBinaryEnd(words: readonly ShellWord[], at: number): number {
  const word = words[at]?.text;
  if (word === undefined) return -1;
  const base = baseName(word);
  if (base === 'rundown' || base === 'rd') return at + 1;
  if (base === 'node') {
    const script = words[at + 1]?.text ?? '';
    if (/(^|\/)(rundown|rd)$/.test(script) || /(@rundown-org\/cli|packages\/cli)\//.test(script)) {
      return at + 2;
    }
  }
  return -1;
}

/**
 * The index of the command word, past assignments and prefix words.
 *
 * @param words - The command's words.
 * @returns Index of the first word that is the command itself.
 */
function commandWordIndex(words: readonly ShellWord[]): number {
  let at = 0;
  while (at < words.length) {
    const word = words[at].text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || PREFIX_WORDS.has(word)) {
      at += 1;
      continue;
    }
    if (word === 'env' || word === 'sudo') {
      at += 1;
      while (at < words.length && /^-|^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at].text)) at += 1;
      continue;
    }
    if (PACKAGE_RUNNERS.has(word)) {
      at += 1;
      if (words[at]?.text === 'exec' || words[at]?.text === 'dlx' || words[at]?.text === 'x') {
        at += 1;
      }
      continue;
    }
    if (word.startsWith('-') && at > 0) {
      // A prefix's own flag, such as `npx --yes`.
      at += 1;
      continue;
    }
    return at;
  }
  return at;
}

/**
 * Find a `rundown claim` / `rundown release` invocation in one simple command.
 *
 * @param words - The simple command's words.
 * @returns The invocation, or undefined when the command is not one.
 */
export function rundownInvocationOf(words: readonly ShellWord[]): RundownInvocation | undefined {
  let at = rundownBinaryEnd(words, commandWordIndex(words));
  if (at < 0) return undefined;
  while (at < words.length) {
    const word = words[at].text;
    if (word === '--') {
      at += 1;
      break;
    }
    if (!word.startsWith('-')) break;
    at += GLOBAL_VALUE_OPTIONS.has(word) ? 2 : 1;
  }
  const subcommandWord = words[at];
  if (subcommandWord?.text !== 'claim' && subcommandWord?.text !== 'release') return undefined;
  const agentIds: { start: number; end: number }[] = [];
  for (let k = at + 1; k < words.length; k += 1) {
    const word = words[k];
    if (word.text === '--') break;
    if (word.text.startsWith('--agent-id=')) {
      agentIds.push({ start: word.start, end: word.end });
    } else if (word.text === '--agent-id') {
      const value = words[k + 1];
      agentIds.push({ start: word.start, end: value?.end ?? word.end });
      k += 1;
    }
  }
  return { subcommand: subcommandWord.text, subcommandWord, agentIds };
}

/**
 * Whether a simple command hands another command line to an interpreter
 * (`sh -c`, `eval`, `xargs`, …), whose words the scanner never sees.
 *
 * @param words - The simple command's words.
 * @returns True for an interpreter invocation.
 */
export function runsAnotherCommandLine(words: readonly ShellWord[]): boolean {
  const word = words[commandWordIndex(words)]?.text;
  return word !== undefined && INTERPRETERS.has(baseName(word));
}

/**
 * Quote a value as one single-quoted shell word.
 *
 * @param value - The raw value.
 * @returns The value, safe to splice into a Bash command as one word.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
