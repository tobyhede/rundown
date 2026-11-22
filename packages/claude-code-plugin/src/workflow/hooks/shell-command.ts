// src/workflow/hooks/shell-command.ts

/**
 * A small, conservative reader of the Bash commands an agent runs, for the
 * one thing the plugin needs from them (#907): finding the `rundown claim` /
 * `rundown release` invocations it can read with confidence, and the exact
 * source span of their words, so the Bash hook can stamp `--agent-id` without
 * disturbing anything else.
 *
 * It is not a shell. It splits on control operators (`;`, `&`, `|`, `&&`,
 * `||`, newlines, parentheses), honours single and double quotes and
 * backslash escapes, and drops redirections and comments. Anything whose
 * words it cannot know without running a shell — command substitution,
 * backticks, process substitution, a here-document, an unterminated quote —
 * makes the whole command `opaque`, and the hook leaves it untouched: the
 * CLI refuses a claim that reaches it unstamped inside Claude Code.
 *
 * @module workflow/hooks/shell-command
 */

/** One shell word: its unquoted value and where it sits in the source. */
export interface ShellWord {
  /** The word's value after quote removal. */
  readonly text: string;
  /** False when the word holds a `$` expansion the shell would rewrite. */
  readonly literal: boolean;
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
  | { readonly kind: 'opaque' };

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

/** A leading `NAME=value` assignment. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

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
  let literal = true;
  let start = -1;
  let redirectTarget = false;

  const endWord = (end: number): void => {
    if (start < 0) return;
    if (redirectTarget) redirectTarget = false;
    else words.push({ text, literal, start, end });
    text = '';
    literal = true;
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
    if (ch === '`' || (ch === '$' && next === '(')) return { kind: 'opaque' };
    if ((ch === '<' || ch === '>') && next === '(') return { kind: 'opaque' };
    if (ch === "'") {
      begin(i);
      const close = source.indexOf("'", i + 1);
      if (close < 0) return { kind: 'opaque' };
      text += source.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      begin(i);
      i += 1;
      while (i < source.length && source[i] !== '"') {
        const inner = source[i];
        if (inner === '`' || (inner === '$' && source[i + 1] === '(')) return { kind: 'opaque' };
        if (inner === '\\' && i + 1 < source.length && '"\\$`\n'.includes(source[i + 1])) {
          if (source[i + 1] !== '\n') text += source[i + 1];
          i += 2;
          continue;
        }
        if (inner === '$') literal = false;
        text += inner;
        i += 1;
      }
      if (i >= source.length) return { kind: 'opaque' };
      i += 1;
      continue;
    }
    if (ch === '\\') {
      if (next === '\n') {
        i += 2;
        continue;
      }
      begin(i);
      if (i + 1 < source.length) text += next;
      i += 2;
      continue;
    }
    if (ch === '#' && start < 0) {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '<' || ch === '>') {
      if (ch === '<' && next === '<') return { kind: 'opaque' };
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
    if (ch === '$') literal = false;
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
 * The literal text of a word.
 *
 * @param words - The command's words.
 * @param at - Index of the word.
 * @returns Its text, or undefined past the end or for a word holding an expansion.
 */
function literalAt(words: readonly ShellWord[], at: number): string | undefined {
  const word = words.at(at);
  return word?.literal === true ? word.text : undefined;
}

/**
 * Skip a `timeout [options] DURATION` prefix.
 *
 * @param words - The command's words.
 * @param at - Index of the first word after `timeout`.
 * @returns Index of the wrapped command, or -1 when not confident.
 */
function skipTimeout(words: readonly ShellWord[], at: number): number {
  let k = at;
  for (;;) {
    const word = literalAt(words, k);
    if (word === undefined) return -1;
    if (['--foreground', '--preserve-status', '-v', '--verbose'].includes(word)) k += 1;
    else if (word === '-s' || word === '-k') k += 2;
    else if (word.startsWith('--signal=') || word.startsWith('--kill-after=')) k += 1;
    else if (/^\d+(\.\d+)?(s|m|h|d)?$/.test(word)) return k + 1;
    else return -1;
  }
}

/**
 * Skip a `nice [options]` prefix.
 *
 * @param words - The command's words.
 * @param at - Index of the first word after `nice`.
 * @returns Index of the wrapped command, or -1 when not confident.
 */
function skipNice(words: readonly ShellWord[], at: number): number {
  let k = at;
  for (;;) {
    const word = literalAt(words, k);
    if (word === undefined) return -1;
    if (word === '-n') k += 2;
    else if (/^-\d+$/.test(word) || word.startsWith('--adjustment=')) k += 1;
    else if (word.startsWith('-')) return -1;
    else return k;
  }
}

/**
 * Find where the Rundown CLI's own arguments start: past assignments, the
 * wrappers `env`, `timeout`, `nice`, `pnpm exec` / `npm exec`, and the
 * binary itself — `rundown`, `rd`, `npx @rundown-org/cli` / `npx rundown`, or
 * the CLI package's `cli.js` run through `node`.
 *
 * @param words - The simple command's words.
 * @returns Index of the first word after the binary, or -1 when the command
 *   is not one the reader can name with confidence.
 */
function rundownArgumentsStart(words: readonly ShellWord[]): number {
  let at = 0;
  while (at < words.length && ASSIGNMENT.test(words[at].text)) at += 1;
  for (;;) {
    const word = literalAt(words, at);
    if (word === undefined) return -1;
    const base = baseName(word);
    if (base === 'rundown' || base === 'rd') return at + 1;
    if (base === 'env') {
      at += 1;
      while (at < words.length && ASSIGNMENT.test(words[at].text)) at += 1;
    } else if (base === 'timeout') {
      at = skipTimeout(words, at + 1);
    } else if (base === 'nice') {
      at = skipNice(words, at + 1);
    } else if ((base === 'pnpm' || base === 'npm') && literalAt(words, at + 1) === 'exec') {
      at += 2;
    } else if (base === 'npx') {
      at += 1;
      while (['-y', '--yes', '-q', '--quiet'].includes(literalAt(words, at) ?? '')) at += 1;
      const pkg = literalAt(words, at);
      const isCli =
        pkg === 'rundown' || pkg === '@rundown-org/cli' || pkg?.startsWith('@rundown-org/cli@');
      return isCli === true ? at + 1 : -1;
    } else if (base === 'node') {
      const script = literalAt(words, at + 1) ?? '';
      const isCli =
        /(^|\/)(rundown|rd)$/.test(script) ||
        /(@rundown-org\/cli|packages\/cli)\/(dist\/)?cli\.js$/.test(script);
      return isCli ? at + 2 : -1;
    } else {
      return -1;
    }
    if (at < 0) return -1;
  }
}

/**
 * Find a `rundown claim` / `rundown release` invocation in one simple command,
 * when the reader can name it with confidence: every word up to and including
 * the subcommand is literal, and the subcommand follows the binary directly.
 *
 * @param words - The simple command's words.
 * @returns The invocation, or undefined when the command is not one.
 */
export function rundownInvocationOf(words: readonly ShellWord[]): RundownInvocation | undefined {
  const at = rundownArgumentsStart(words);
  if (at < 0) return undefined;
  const subcommandWord = words.at(at);
  if (subcommandWord?.literal !== true) return undefined;
  const subcommand = subcommandWord.text;
  if (subcommand !== 'claim' && subcommand !== 'release') return undefined;
  const agentIds: { start: number; end: number }[] = [];
  for (let k = at + 1; k < words.length; k += 1) {
    const word = words[k];
    if (word.text === '--') break;
    if (word.text.startsWith('--agent-id=')) {
      agentIds.push({ start: word.start, end: word.end });
    } else if (word.text === '--agent-id') {
      const value = words.at(k + 1);
      agentIds.push({ start: word.start, end: value?.end ?? word.end });
      k += 1;
    }
  }
  return { subcommand, subcommandWord, agentIds };
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
