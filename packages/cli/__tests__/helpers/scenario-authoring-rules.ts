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

/** Strips a `!` negation prefix and any leading `FOO=bar` environment assignments. */
const COMMAND_PREFIX = /^(?:!\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/;

/**
 * Extract the executable a command segment invokes.
 *
 * @param segment - A single command segment, without shell operators
 * @returns The executable token, or an empty string when the segment is blank
 */
export function commandHead(segment: string): string {
  const withoutPrefix = segment.trim().replace(COMMAND_PREFIX, '');
  return /^\S*/.exec(withoutPrefix)?.[0] ?? '';
}

/**
 * Whether a scenario command invokes an interpreter, helper script, or package
 * runner — in any form, not only the inline `-e` / `-c` spellings.
 *
 * Checks each operator-separated segment, so a wrapper hidden behind `;` or `&&`
 * is caught too. Matching is anchored to the executable position rather than
 * applied to the whole string, so an incidental mention of `bash` inside a
 * quoted argument is not a violation.
 *
 * @param command - Scenario command string, as authored in `commands:`
 * @returns True when any segment invokes a wrapper
 */
export function usesOpaqueWrapper(command: string): boolean {
  return command
    .split(/[;|&]+/)
    .map((segment) => commandHead(segment))
    .some((head) => head !== '' && (WRAPPER_EXECUTABLES.has(head) || SCRIPT_FILE.test(head)));
}
