/**
 * The authoring rules applied to scenario command sequences.
 *
 * Extracted from the lint suite so the predicates themselves are unit-tested
 * (`__tests__/schemas/scenario-authoring-rules.test.ts`) rather than only
 * exercised against whatever the repository happens to contain today. A rule
 * that silently stops matching would otherwise keep the suite green.
 *
 * Every rule takes a **scenario command string** — a parsed frontmatter value,
 * never file text. Selector syntax such as
 * `rd://artifacts/{{ ContextId }}/*\/plan.json` lives on `ARTIFACTS` directive
 * lines in runbook *bodies*, which never reach these predicates. That is why
 * these rules can be strict where a text search over the same repository cannot.
 *
 * @module __tests__/helpers/scenario-authoring-rules
 */

import { parse as shellParse } from 'shell-quote';

/** A fabrication rule: a scenario command must never match `pattern`. */
export interface FabricationRule {
  /** Human-readable description, used as the test name and failure context. */
  readonly id: string;
  /** Pattern whose match indicates fabricated artifact provenance. */
  readonly pattern: RegExp;
}

/**
 * Commands that fabricate artifact provenance. No allowlist: #498's invariant is
 * that provenance comes from a real producer's output, so there is no legitimate
 * reason for a scenario command to name an `rd://` URI, touch the manifest, or
 * re-derive the `.rd-<contextId>` directory by hand.
 */
export const FABRICATION_RULES: readonly FabricationRule[] = [
  { id: 'names an rd:// URI (capture it from a producer instead)', pattern: /rd:\/\// },
  { id: 'writes the artifact manifest (core owns manifest.jsonl)', pattern: /manifest\.jsonl/ },
  // Matches the `.rd-` prefix itself rather than requiring an alphanumeric after
  // it: a context id may begin with `_` or `-`, and a hand-derived path is just
  // as fabricated when the id arrives via a template (`.rd-{{ ContextId }}`).
  { id: 'hand-derives the .rd-<contextId> provenance directory', pattern: /\.rd-/ },
];

/**
 * Detects a subprocess spawn inside a scenario command.
 *
 * This is the "no hidden `rd` invocations" rule made objective. It deliberately
 * matches the *spawn*, not the token `rd`: a `\b(rd|rundown)\b` test matches the
 * path `.rundown/session.json` and would condemn fault-injection scenarios that
 * legitimately read state files without ever invoking the CLI.
 */
export const SPAWNS_SUBPROCESS = /child_process|execFileSync|execSync|spawnSync|\bspawn\(/;

/**
 * Executables that interpret code or scripts rather than driving the runbook.
 *
 * `rd`/`rundown` are the scenario vocabulary. `true` is the established staging
 * no-op (it makes a runbook reference visible to the harness without running
 * anything), and `printf` writes fixture text. Everything here can run arbitrary
 * logic, which is what takes a workflow step out of the runner's command model.
 */
const WRAPPER_EXECUTABLES = new Set([
  'node',
  'nodejs',
  'python',
  'python2',
  'python3',
  'ruby',
  'perl',
  'sh',
  'bash',
  'zsh',
  'dash',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'eval',
  'source',
]);

/** Script files that would be run directly, e.g. `./setup.sh`. */
const SCRIPT_FILE = /\.(sh|bash|zsh|js|cjs|mjs|py|rb|pl)$/;

/**
 * Operators after which the shell begins a new command.
 *
 * Redirections (`>`, `<`, `>>`) are deliberately absent: `rd echo > out.txt`
 * runs one command, and treating `>` as a boundary would read `out.txt` as an
 * executable.
 */
const COMMAND_SEPARATORS: ReadonlySet<string> = new Set([';', '&&', '||', '|', '&', '(', ')']);

/** An `FOO=bar` assignment prefix, which does not consume the command position. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Extract the text of every command substitution the shell would actually run.
 *
 * Quote-aware by necessity, not by preference: inside *single* quotes `$( … )`
 * and backticks are literal text. The since-deleted allowlisted fault injector
 * `delegate-claim-corruption.runbook.md` — whose shape is pinned in the unit
 * tests — passed a single-quoted `node -e` argument holding
 * JS template literals (`` `sha256:${"f".repeat(64)}` ``), which `shellParse`
 * rejects outright as a bad substitution. A quote-blind regex hands that inner
 * text to the parser and throws on a legitimate command, so scanning raw text
 * for `` ` `` is not merely imprecise, it is broken.
 *
 * `shellParse` cannot do this for us: it reports a token's text but not the
 * quote style that produced it, so an active `"$(node x)"` and a literal
 * `'$(node x)'` are indistinguishable once parsed.
 *
 * @param command - Raw scenario command text
 * @returns Inner text of each shell-active `$( … )` or backtick substitution
 */
function activeSubstitutions(command: string): string[] {
  const found: string[] = [];
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === '\\') {
      i++; // Escaped: the next character is literal whatever it is.
      continue;
    }
    if (quote === '"' && char === '"') {
      quote = undefined;
    } else if (quote === undefined && (char === "'" || char === '"')) {
      quote = char;
    } else if (char === '`') {
      const end = command.indexOf('`', i + 1);
      if (end === -1) break;
      found.push(command.slice(i + 1, end));
      i = end;
    } else if (char === '$' && command[i + 1] === '(') {
      let depth = 1;
      let end = i + 2;
      for (; end < command.length && depth > 0; end++) {
        if (command[end] === '(') depth++;
        else if (command[end] === ')') depth--;
      }
      if (depth !== 0) break;
      found.push(command.slice(i + 2, end - 1));
      i = end - 1;
    }
  }
  return found;
}

/**
 * Extract the executable of every command in one newline-free line of shell.
 *
 * @param line - Shell text containing no newlines
 * @returns The executable token of each command in the line, in order
 */
function headsOfLine(line: string): string[] {
  const heads: string[] = [];
  let atCommandStart = true;
  for (const token of shellParse(line)) {
    if (typeof token === 'string') {
      // `!` negates the following command and `FOO=bar` prefixes it; neither is
      // the executable, so the command position survives them.
      if (!atCommandStart || token === '!' || ENV_ASSIGNMENT.test(token)) continue;
      heads.push(token);
      atCommandStart = false;
    } else if ('op' in token) {
      if (token.op === 'glob') {
        if (atCommandStart) {
          heads.push(token.pattern);
          atCommandStart = false;
        }
      } else if (COMMAND_SEPARATORS.has(token.op)) {
        atCommandStart = true;
      }
    }
  }
  return heads;
}

/**
 * Extract the executable of every command a scenario command string invokes.
 *
 * Tokenizes with `shell-quote` — the same tokenizer
 * (`parseRdCommandWithEnv` → `shellParse`) the harness uses to *execute* these
 * commands — so the lint agrees with the executor by construction about where a
 * command begins. A hand-rolled `split(/[;|&]+/)` cannot: it splits on a `;`
 * inside a quoted argument, which both invents boundaries that the shell never
 * sees and lets a real one hide.
 *
 * @param command - Scenario command string, as authored in `commands:`
 * @returns Every executable token, including those inside command substitutions
 */
export function commandHeads(command: string): string[] {
  // `shellParse` treats a newline as ordinary whitespace, so a wrapper on a
  // second line would otherwise hide behind the first line's head.
  const heads = command.split('\n').flatMap((line) => headsOfLine(line));
  for (const inner of activeSubstitutions(command)) {
    // Each substitution is strictly shorter than `command`, so this terminates.
    heads.push(...commandHeads(inner));
  }
  return heads;
}

/**
 * Extract the executable a command segment invokes.
 *
 * @param segment - A single command segment
 * @returns The first executable token, or an empty string when none is found
 */
export function commandHead(segment: string): string {
  return commandHeads(segment)[0] ?? '';
}

/**
 * Whether a scenario command invokes an interpreter, helper script, or package
 * runner — in any form, not only the inline `-e` / `-c` spellings.
 *
 * Checks the executable position of every command, so a wrapper is caught behind
 * a shell operator, on a second line, or inside a `$( … )` substitution, while
 * an incidental mention of `bash` in a quoted argument is not a violation.
 *
 * @param command - Scenario command string, as authored in `commands:`
 * @returns True when any command invokes a wrapper
 */
export function usesOpaqueWrapper(command: string): boolean {
  return commandHeads(command).some(
    (head) => head !== '' && (WRAPPER_EXECUTABLES.has(head) || SCRIPT_FILE.test(head)),
  );
}
