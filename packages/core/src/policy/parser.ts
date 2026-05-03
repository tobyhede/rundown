/**
 * Command parser for extracting executable names from shell commands.
 *
 * Purpose-built for policy extraction: identifies which programs a bash
 * command block will invoke so they can be checked against an allowlist.
 *
 * Uses a hand-crafted character-level tokenizer rather than shell-quote,
 * which correctly handles the following patterns that shell-quote mishandles:
 * - Newlines as statement separators (not whitespace)
 * - $VAR references: skipped without expansion (no phantom empty executables)
 * - Redirect targets (> >> < <<): not statement boundaries, never treated as executables
 *
 * @module
 */

import * as path from 'node:path';

/**
 * Parsed command with executable name and full command string.
 */
export interface ParsedCommand {
  /** The executable name (basename, e.g., 'git' from '/usr/bin/git') */
  executable: string;
  /** The original command string */
  original: string;
}

// ---------------------------------------------------------------------------
// Internal tokenizer
// ---------------------------------------------------------------------------

/** Word token — a command word (executable, argument, or redirect target). */
type WordToken = { kind: 'word'; value: string; dynamic?: boolean };
/** Op token — a statement boundary: ; \n && || | ( ) */
type OpToken = { kind: 'op' };
/** Redir token — a redirect operator that is NOT a statement boundary: > >> < << */
type RedirToken = { kind: 'redir' };
type Token = WordToken | OpToken | RedirToken;
type HeredocDelimiter = { value: string; stripLeadingTabs: boolean };

/** Shell executable names for sh -c wrapper detection. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'fish', 'csh', 'tcsh']);

/**
 * Sentinel executable emitted when a command word contains an embedded runtime
 * substitution (e.g. `git$(evil)`). The word's value is unknowable at parse time,
 * so no allowlist pattern can safely match it. The null-byte prefix is intentional —
 * it cannot appear in a Unix executable name and therefore never matches any real
 * allowlist entry, ensuring the policy evaluator denies the command unless
 * `--allow-all` is set.
 */
export const DYNAMIC_EXECUTABLE_SENTINEL = '\x00<dynamic>';

/**
 * Check whether the character at index is escaped by an odd-length backslash
 * run within the current scanning range.
 *
 * @param command - Full command string
 * @param index - Character index to inspect
 * @param floor - Lowest index that can contribute escaping backslashes
 * @returns True when an odd number of backslashes immediately precedes index
 */
function isOddBackslashEscaped(command: string, index: number, floor: number): boolean {
  let bs = 0;
  let k = index - 1;
  while (k >= floor && command[k] === '\\') {
    bs++;
    k--;
  }
  return bs % 2 === 1;
}

/**
 * Advance past a balanced $(...) block.
 *
 * startIdx is the position immediately after the opening '(' in '$('. Uses the
 * same balanced-parenthesis algorithm as extractDollarSubstitutions to handle
 * nesting and escaped parens consistently.
 *
 * @param command - Full command string
 * @param startIdx - Position immediately after the opening '('
 * @returns Index after the matching ')' or -1 if unbalanced
 */
function scanSubst(command: string, startIdx: number): number {
  let level = 1;
  let i = startIdx;
  let state: 'normal' | 'single' | 'double' = 'normal';

  while (i < command.length && level > 0) {
    const ch = command[i];

    if (state === 'single') {
      if (ch === "'") state = 'normal';
      i++;
      continue;
    }

    if (state === 'double') {
      if (ch === '"' && !isOddBackslashEscaped(command, i, startIdx)) {
        state = 'normal';
      }
      i++;
      continue;
    }

    if (ch === "'" && !isOddBackslashEscaped(command, i, startIdx)) {
      state = 'single';
    } else if (ch === '"' && !isOddBackslashEscaped(command, i, startIdx)) {
      state = 'double';
    } else if (ch === '(' || ch === ')') {
      if (!isOddBackslashEscaped(command, i, startIdx)) {
        if (ch === '(') level++;
        else level--;
      }
    }
    i++;
  }
  return level === 0 ? i : -1;
}

/**
 * Parse heredoc delimiter words from a command line.
 *
 * This intentionally covers the common heredoc forms the policy parser needs
 * to suppress safely: `<<EOF`, `<< EOF`, `<<'EOF'`, `<<"EOF"`, and `<<-EOF`.
 *
 * @param line - A single command line
 * @returns Heredoc delimiters in the order their bodies will appear
 */
function extractHeredocDelimiters(line: string): HeredocDelimiter[] {
  const delimiters: HeredocDelimiter[] = [];
  let state: 'normal' | 'single' | 'double' = 'normal';
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (state === 'single') {
      if (ch === "'") state = 'normal';
      i++;
      continue;
    }

    if (state === 'double') {
      if (ch === '"' && !isOddBackslashEscaped(line, i, 0)) state = 'normal';
      i++;
      continue;
    }

    if (ch === "'" && !isOddBackslashEscaped(line, i, 0)) {
      state = 'single';
      i++;
      continue;
    }

    if (ch === '"' && !isOddBackslashEscaped(line, i, 0)) {
      state = 'double';
      i++;
      continue;
    }

    if (ch !== '<' || line[i + 1] !== '<' || line[i + 2] === '<') {
      i++;
      continue;
    }

    i += 2;
    const stripLeadingTabs = line[i] === '-';
    if (stripLeadingTabs) i++;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

    let delimiter = '';
    let delimiterQuote: "'" | '"' | null = null;
    while (i < line.length) {
      const current = line[i];

      if (delimiterQuote === "'") {
        if (current === "'") delimiterQuote = null;
        else delimiter += current;
        i++;
        continue;
      }

      if (delimiterQuote === '"') {
        if (current === '"' && !isOddBackslashEscaped(line, i, 0)) {
          delimiterQuote = null;
        } else if (current === '\\') {
          const next = line[i + 1];
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            delimiter += next;
            i += 2;
            continue;
          }
          delimiter += current;
        } else {
          delimiter += current;
        }
        i++;
        continue;
      }

      if (current === "'") {
        delimiterQuote = "'";
        i++;
        continue;
      }

      if (current === '"' && !isOddBackslashEscaped(line, i, 0)) {
        delimiterQuote = '"';
        i++;
        continue;
      }

      if (current === '\\' && i + 1 < line.length) {
        delimiter += line[i + 1];
        i += 2;
        continue;
      }

      if (
        current === ' ' ||
        current === '\t' ||
        current === ';' ||
        current === '&' ||
        current === '|'
      ) {
        break;
      }

      delimiter += current;
      i++;
    }

    if (delimiter.length > 0) delimiters.push({ value: delimiter, stripLeadingTabs });
  }

  return delimiters;
}

/**
 * Remove heredoc body and terminator lines before command extraction.
 *
 * Heredoc bodies are data, not executable shell source. Keeping the initiating
 * line preserves the command that consumes the heredoc while preventing body
 * text and terminators from becoming phantom commands.
 *
 * @param command - Shell command string
 * @returns Command with heredoc body and terminator lines omitted
 */
function stripHeredocBodies(command: string): string {
  const lines = command.split('\n');
  const kept: string[] = [];
  const pendingDelimiters: HeredocDelimiter[] = [];

  for (const line of lines) {
    if (pendingDelimiters.length > 0) {
      const terminator = pendingDelimiters[0];
      const terminatorLine = terminator.stripLeadingTabs ? line.replace(/^\t+/, '') : line;
      if (terminatorLine === terminator.value) {
        pendingDelimiters.shift();
      }
      continue;
    }

    kept.push(line);
    pendingDelimiters.push(...extractHeredocDelimiters(line));
  }

  return kept.join('\n');
}

/**
 * Advance past a backtick block.
 *
 * @param command - Full command string
 * @param startIdx - Position immediately after the opening backtick
 * @returns Index after the closing backtick or -1 if unmatched
 */
function scanBacktick(command: string, startIdx: number): number {
  let i = startIdx;
  while (i < command.length) {
    if (command[i] === '\\') {
      i += 2;
      continue;
    }
    if (command[i] === '`') return i + 1;
    i++;
  }
  return -1;
}

/**
 * Advance past a $VAR or ${VAR} reference.
 *
 * @param command - Full command string
 * @param startIdx - Position immediately after the '$'
 * @returns Index after the variable reference
 */
function scanVar(command: string, startIdx: number): number {
  if (startIdx >= command.length) return startIdx;
  if (command[startIdx] === '{') {
    const end = command.indexOf('}', startIdx + 1);
    return end < 0 ? startIdx + 1 : end + 1;
  }
  let i = startIdx;
  while (i < command.length && /\w/.test(command[i])) i++;
  return i;
}

/**
 * Tokenize a shell command string into words, statement-boundary operators,
 * and redirect markers.
 *
 * Key design decisions vs. shell-quote:
 * - `\n` is a statement boundary (op), not whitespace
 * - `$VAR` references are skipped entirely — produce no token and no empty string
 * - `$(…)` and backtick bodies are skipped — their content is handled separately by
 *   extractDollarSubstitutions / extractBacktickCommands on the raw string
 * - `>`, `>>`, `<`, `<<` emit redir tokens (not op) so redirect targets stay in the
 *   same statement and are never mistaken for executables
 * - Empty word buffers are suppressed — no empty-string word tokens
 * - Words that contain an embedded substitution (e.g. `git$(evil)`) are marked
 *   `dynamic: true` — the value is unknowable at parse time and extractCommands will
 *   emit DYNAMIC_EXECUTABLE_SENTINEL rather than accepting the literal prefix as safe
 *
 * @param command - Shell command string to tokenize
 * @returns Array of tokens
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let wordBuf = '';
  let wordIsDynamic = false;
  let state: 'normal' | 'single' | 'double' = 'normal';
  let i = 0;

  const flushWord = (): void => {
    if (wordBuf.length > 0 || wordIsDynamic) {
      const token: WordToken = { kind: 'word', value: wordBuf };
      if (wordIsDynamic) token.dynamic = true;
      tokens.push(token);
      wordBuf = '';
      wordIsDynamic = false;
    }
  };

  while (i < command.length) {
    const ch = command[i];

    // ── Single-quote context: everything literal until closing ' ───────────
    if (state === 'single') {
      if (ch === "'") {
        state = 'normal';
        i++;
      } else {
        wordBuf += ch;
        i++;
      }
      continue;
    }

    // ── Double-quote context: $VAR and $(...) still active, spaces literal ─
    if (state === 'double') {
      if (ch === '"') {
        state = 'normal';
        i++;
        continue;
      }
      if (ch === '\\') {
        const next = command[i + 1] ?? '';
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          wordBuf += next;
        } else {
          wordBuf += ch + next;
        }
        i += 2;
        continue;
      }
      if (ch === '$') {
        const next = command[i + 1] ?? '';
        if (next === '(') {
          // $(…) inside double-quote: word value is now unknowable at parse time
          wordIsDynamic = true;
          const end = scanSubst(command, i + 2);
          i = end < 0 ? command.length : end;
        } else if (/[\w{]/.test(next)) {
          // Runtime parameter expansion can form the executable word. Preserve a
          // dynamic token so command position stays fail-closed, while argument
          // position remains harmless.
          wordIsDynamic = true;
          i = scanVar(command, i + 1);
        } else {
          wordBuf += ch;
          i++;
        }
        continue;
      }
      if (ch === '`') {
        // Backtick inside double-quote: word value is now unknowable at parse time
        wordIsDynamic = true;
        const end = scanBacktick(command, i + 1);
        i = end < 0 ? i + 1 : end;
        continue;
      }
      wordBuf += ch;
      i++;
      continue;
    }

    // ── Normal context ────────────────────────────────────────────────────
    if (ch === "'") {
      state = 'single';
      i++;
      continue;
    }
    if (ch === '"') {
      state = 'double';
      i++;
      continue;
    }
    if (ch === '\\') {
      const next = command[i + 1] ?? '';
      if (next === '\n') {
        i += 2; // line continuation — skip backslash + newline
      } else {
        wordBuf += next;
        i += 2;
      }
      continue;
    }
    // Comment — skip to end of line (only when at start of a new token)
    if (ch === '#' && wordBuf.length === 0) {
      while (i < command.length && command[i] !== '\n') i++;
      continue;
    }
    if (ch === '$') {
      const prev = i > 0 ? command[i - 1] : '';
      const next = command[i + 1] ?? '';
      if (next === '(' && prev !== '$') {
        // $(…) command substitution: marks the current word as dynamic — the word's
        // value is unknowable at parse time. Do NOT flush the prefix as a valid word;
        // the entire token (prefix + substitution + any suffix) is dynamic.
        wordIsDynamic = true;
        const end = scanSubst(command, i + 2);
        i = end < 0 ? command.length : end;
      } else if (/[\w{]/.test(next)) {
        // Runtime parameter expansion can form the executable word. Preserve a
        // dynamic token so command position stays fail-closed, while argument
        // position remains harmless.
        wordIsDynamic = true;
        i = scanVar(command, i + 1);
      } else {
        wordBuf += ch;
        i++;
      }
      continue;
    }
    if (ch === '`') {
      // Backtick substitution: marks the current word as dynamic (same as $(...)).
      wordIsDynamic = true;
      const end = scanBacktick(command, i + 1);
      i = end < 0 ? i + 1 : end;
      continue;
    }

    // Whitespace (space and tab — \n handled below as operator)
    if (ch === ' ' || ch === '\t') {
      flushWord();
      i++;
      continue;
    }

    // Multi-character operators (must check before single-char fallthrough)
    const next = command[i + 1] ?? '';
    if (ch === '&' && next === '&') {
      flushWord();
      tokens.push({ kind: 'op' });
      i += 2;
      continue;
    }
    if (ch === '|' && next === '|') {
      flushWord();
      tokens.push({ kind: 'op' });
      i += 2;
      continue;
    }
    if ((ch === '>' && (next === '&' || next === '|')) || (ch === '<' && next === '&')) {
      if (/^\d+$/.test(wordBuf)) {
        wordBuf = '';
      } else {
        flushWord();
      }
      tokens.push({ kind: 'redir' });
      i += 2;
      continue;
    }
    if (ch === '>' && next === '>') {
      if (/^\d+$/.test(wordBuf)) {
        wordBuf = '';
      } else {
        flushWord();
      }
      tokens.push({ kind: 'redir' });
      i += 2;
      continue;
    }
    if (ch === '<' && next === '<') {
      if (/^\d+$/.test(wordBuf)) {
        wordBuf = '';
      } else {
        flushWord();
      }
      tokens.push({ kind: 'redir' });
      i += 2;
      continue;
    }

    // Single-character statement boundaries
    if (ch === '\n' || ch === ';') {
      flushWord();
      tokens.push({ kind: 'op' });
      i++;
      continue;
    }
    if (ch === '|') {
      flushWord();
      tokens.push({ kind: 'op' });
      i++;
      continue;
    }
    if (ch === '&') {
      // Background execution (&) — treat as statement boundary
      flushWord();
      tokens.push({ kind: 'op' });
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      // Subshell delimiters — statement boundaries
      flushWord();
      tokens.push({ kind: 'op' });
      i++;
      continue;
    }

    // Redirect operators — NOT statement boundaries
    if (ch === '>') {
      if (/^\d+$/.test(wordBuf)) {
        wordBuf = '';
      } else {
        flushWord();
      }
      tokens.push({ kind: 'redir' });
      i++;
      continue;
    }
    if (ch === '<') {
      if (/^\d+$/.test(wordBuf)) {
        wordBuf = '';
      } else {
        flushWord();
      }
      tokens.push({ kind: 'redir' });
      i++;
      continue;
    }

    wordBuf += ch;
    i++;
  }

  flushWord();
  return tokens;
}

// ---------------------------------------------------------------------------
// Command extraction
// ---------------------------------------------------------------------------

/**
 * Check if a word is an environment variable assignment (KEY=VALUE).
 *
 * @param token - Token string to check
 * @returns True if the token is a KEY=VALUE assignment
 */
function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * Extract all executable names from a shell command string.
 *
 * Handles complex shell patterns including:
 * - Simple commands: `git status`
 * - Pipelines: `cat file | grep pattern`
 * - Shell wrappers: `sh -c 'git commit -m "msg"'`
 * - Logical operators: `npm test && npm run build`
 * - Multi-line blocks: each newline-separated statement parsed independently
 * - Subshells: `(cd dir && make)`
 * - Redirections: `echo hello > file.txt` — redirect target is never an executable
 *
 * @param command - The shell command string to parse
 * @returns Array of parsed commands with executable names
 *
 * @example
 * ```typescript
 * extractCommands('git status')
 * // => [{ executable: 'git', original: 'git status' }]
 *
 * extractCommands('sh -c "npm test && npm run build"')
 * // => [
 * //   { executable: 'sh', original: 'sh -c npm test && npm run build' },
 * //   { executable: 'npm', original: 'npm test' },
 * //   { executable: 'npm', original: 'npm run build' }
 * // ]
 * ```
 */
export function extractCommands(command: string): ParsedCommand[] {
  const commands: ParsedCommand[] = [];
  const normalizedCommand = stripHeredocBodies(command);
  const tokens = tokenize(normalizedCommand);

  let stmtTokens: WordToken[] = [];
  let skipNextWord = false;

  const flushStatement = (): void => {
    const words = stmtTokens;
    stmtTokens = [];
    skipNextWord = false;

    if (words.length === 0) return;

    // Skip leading KEY=VALUE assignments to find the actual executable
    let execIdx = 0;
    while (execIdx < words.length && isEnvAssignment(words[execIdx].value)) execIdx++;
    if (execIdx >= words.length) return;

    const firstWord = words[execIdx];

    // If the executable word contains an embedded substitution its value is
    // unknowable at parse time. Emit the sentinel so the policy evaluator
    // cannot match it against any allowlist entry.
    if (firstWord.dynamic) {
      commands.push({
        executable: DYNAMIC_EXECUTABLE_SENTINEL,
        original: words.map((w) => w.value).join(' '),
      });
      return;
    }

    const original = words.map((w) => w.value).join(' ');
    const executable = path.basename(firstWord.value);
    if (!executable) return;

    // sh -c detection: keep the wrapper executable and recursively parse the
    // -c script so policies must allow both the shell and nested commands.
    if (SHELLS.has(executable)) {
      let dashCIdx = -1;
      for (let k = 0; k < words.length; k++) {
        if (words[k].value === '-c') {
          dashCIdx = k;
          break;
        }
      }
      if (dashCIdx >= 0 && dashCIdx + 1 < words.length) {
        commands.push({ executable, original });
        const scriptWord = words[dashCIdx + 1];
        if (scriptWord.dynamic) {
          commands.push({
            executable: DYNAMIC_EXECUTABLE_SENTINEL,
            original: scriptWord.value,
          });
          return;
        }
        const nested = extractCommands(scriptWord.value);
        commands.push(...nested);
        return;
      }
    }

    commands.push({ executable, original });
  };

  for (const tok of tokens) {
    if (tok.kind === 'op') {
      flushStatement();
    } else if (tok.kind === 'redir') {
      // Next word is a redirect target — skip it, it is not an executable
      skipNextWord = true;
    } else {
      // word token — TypeScript narrows to WordToken here
      if (skipNextWord) {
        skipNextWord = false;
      } else {
        stmtTokens.push(tok);
      }
    }
  }
  flushStatement();

  return commands;
}

/**
 * Extract the primary executable from a command string.
 *
 * Returns just the first/main executable, useful for simple permission checks.
 *
 * @param command - The shell command string to parse
 * @returns The primary executable name or null if parsing fails
 *
 * @example
 * ```typescript
 * extractPrimaryExecutable('git status')  // => 'git'
 * extractPrimaryExecutable('sh -c "npm test"')  // => 'sh'
 * ```
 */
export function extractPrimaryExecutable(command: string): string | null {
  const commands = extractCommands(command);
  return commands.length > 0 ? commands[0].executable : null;
}

/**
 * Get all unique executable names from a command string.
 *
 * Combines direct command extraction with recursive scanning of command
 * substitutions ($(...) and backticks) to find all programs that will run.
 *
 * @param command - The shell command string to parse
 * @param depth - Internal recursion depth to prevent infinite loops (max 5)
 * @returns Array of unique executable names
 */
export function extractAllExecutables(command: string, depth = 0): string[] {
  if (depth > 5) {
    return [];
  }

  const commands = extractCommands(command);
  const executables = commands.map((c) => c.executable);

  // Also extract commands from backticks and $(...) substitution
  const substitutedExecutables = [
    ...extractBacktickCommands(command, depth + 1),
    ...extractDollarSubstitutions(command, depth + 1),
  ];

  return [...new Set([...executables, ...substitutedExecutables])];
}

/**
 * Extract commands hidden in backtick command substitution.
 *
 * Backticks (`) are used for command substitution in shell scripts.
 * This function extracts the commands inside backticks so they can be
 * checked against the policy.
 *
 * @param command - The shell command string to scan for backticks
 * @param depth - Current recursion depth
 * @returns Array of executable names found inside backticks
 */
export function extractBacktickCommands(command: string, depth = 0): string[] {
  const backtickRegex = /`(.+?)`/g;
  return extractRecursiveMatches(stripHeredocBodies(command), backtickRegex, depth);
}

/**
 * Extract commands hidden in $(...) command substitution.
 *
 * $(...) is the modern shell command substitution syntax.
 * This function extracts the commands inside $(...) so they can be
 * checked against the policy.
 *
 * @param command - The shell command string to scan for $(...)
 * @param depth - Current recursion depth
 * @returns Array of executable names found inside $(...)
 */
export function extractDollarSubstitutions(command: string, depth = 0): string[] {
  // Use balanced parenthesis counting instead of regex to avoid ReDoS
  // and correctly handle nested $(...) substitutions
  const executables: string[] = [];
  const normalizedCommand = stripHeredocBodies(command);
  let i = 0;
  while (i < normalizedCommand.length - 1) {
    // Match $( but not $$( — double-dollar is PID expansion, not command substitution.
    // Note: $((...)) arithmetic and $(...) inside single quotes are conservatively
    // detected as substitutions, producing safe false positives.
    if (
      normalizedCommand[i] === '$' &&
      normalizedCommand[i + 1] === '(' &&
      (i === 0 || normalizedCommand[i - 1] !== '$')
    ) {
      const end = scanSubst(normalizedCommand, i + 2);
      if (end >= 0) {
        const nestedContent = normalizedCommand.slice(i + 2, end - 1);
        // Recursively extract executables from the substitution content
        const nestedExecutables = extractAllExecutables(nestedContent, depth);
        executables.push(...nestedExecutables);
        i = end;
        continue;
      }
    }
    i++;
  }
  return executables;
}

/**
 * Helper to extract and recursively parse commands from regex matches.
 *
 * @param command - Command string to scan
 * @param regex - Regex with one capturing group for the nested command
 * @param depth - Current recursion depth
 * @returns Array of executable names
 */
function extractRecursiveMatches(command: string, regex: RegExp, depth: number): string[] {
  const executables: string[] = [];
  let match: RegExpExecArray | null = null;

  // Reset regex index for safety if it has the global flag
  if (regex.global) regex.lastIndex = 0;

  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = regex.exec(command)) !== null) {
    const nestedContent = match[1];
    const nestedExecutables = extractAllExecutables(nestedContent, depth);
    executables.push(...nestedExecutables);
  }

  return executables;
}
