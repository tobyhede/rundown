import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import {
  substituteCapturedArtifacts,
  parseRdCommandWithEnv,
} from '../../src/helpers/command-sequence.js';

/** A placeholder key: the shape `assertSafeId` admits, kept short for shrinking. */
const keyArb = fc.stringMatching(/^[A-Za-z0-9_.]{1,12}$/);

/**
 * Literal command text guaranteed to contain no placeholder. Mapping `$` away is
 * used rather than filtering so no generated value is ever rejected. Length 0 is
 * allowed on purpose — it is what produces adjacent placeholders and
 * placeholders at the very start/end of the command.
 */
const literalArb = fc
  .string({ maxLength: 12 })
  .map((s) => s.replaceAll('$', 'S').replaceAll('{', '(').replaceAll('}', ')'));

interface Placeholder {
  readonly key: string;
  readonly asArray: boolean;
}

interface Command {
  readonly placeholders: readonly Placeholder[];
  readonly literals: readonly string[];
}

/** N placeholders interleaved with exactly N+1 literal segments. */
const commandArb: fc.Arbitrary<Command> = fc
  .array(fc.record({ key: keyArb, asArray: fc.boolean() }), { maxLength: 5 })
  .chain((placeholders) =>
    fc
      .array(literalArb, {
        minLength: placeholders.length + 1,
        maxLength: placeholders.length + 1,
      })
      .map((literals) => ({ placeholders, literals })),
  );

function renderPlaceholder(p: Placeholder): string {
  return `\${CAPTURE_ARTIFACT${p.asArray ? '_ARRAY' : ''}:${p.key}}`;
}

function buildCommand({ placeholders, literals }: Command): string {
  return placeholders.reduce(
    (acc, p, i) => acc + renderPlaceholder(p) + literals[i + 1],
    literals[0],
  );
}

/**
 * The resolved value for the nth resolver call. Deliberately contains `}` and
 * `${` — if the implementation re-scanned its own output, these would be
 * re-parsed as placeholder syntax and the oracle would diverge.
 */
function resolvedValue(n: number, key: string, asArray: boolean): string {
  return `<${String(n)}:${key}:${asArray ? 'A' : 'S'}}\${>`;
}

/**
 * A resolved value the harness can really produce: a `rd://` URI whose segments
 * are `assertSafeId`-shaped (`paths.ts:34`), so the arbitrary generates exactly
 * the domain `resolveCapturedArtifactFromManifest` returns and no wider.
 */
const uriArb = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z0-9._-]{1,8}$/),
    fc.stringMatching(/^[A-Za-z0-9._-]{1,8}$/),
    fc.stringMatching(/^[A-Za-z0-9._-]{1,8}$/),
  )
  .map(([ctx, run, key]) => `rd://artifacts/${ctx}/rd_${run}/${key}`);

/** The array form's resolved value: `JSON.stringify` of URIs, per scenario-artifacts.ts:130. */
const arrayValueArb = fc.array(uriArb, { maxLength: 3 }).map((uris) => JSON.stringify(uris));

/** Count argv entries containing `value` after substitution + the real rd parse. */
async function argvEntriesContaining(cmd: string, value: string): Promise<number> {
  const substituted = await substituteCapturedArtifacts(cmd, async () => value);
  const parsed = parseRdCommandWithEnv(substituted);
  if (!parsed) throw new Error(`expected an rd command, got: ${substituted}`);
  return parsed.args.filter((arg) => arg.includes(value)).length;
}

describe('substituteCapturedArtifacts (properties)', () => {
  // ---------------------------------------------------------------------------
  // The load-bearing property: composed across the shellParse boundary that
  // substituteCapturedArtifacts hands off to. Its precondition — "accepted by
  // the quoting guard" — is expressed by only generating command shapes the
  // guard admits: scalars anywhere, arrays single-quoted. Without it the
  // property is unconditionally red (see the unquoted-array case below, which
  // is asserted as a *known* falsification rather than hidden).
  // ---------------------------------------------------------------------------
  it('a resolved SCALAR survives the rd parse as exactly one argv entry, byte-identical', async () => {
    await fc.assert(
      fc.asyncProperty(uriArb, async (uri) => {
        // Scalars are immune regardless of quoting, so both spellings hold.
        expect(
          await argvEntriesContaining(
            'rd run x.runbook.md --artifacts P=${CAPTURE_ARTIFACT:k}',
            uri,
          ),
        ).toBe(1);
        expect(
          await argvEntriesContaining(
            "rd run x.runbook.md --artifacts P='${CAPTURE_ARTIFACT:k}'",
            uri,
          ),
        ).toBe(1);
      }),
    );
  });

  it('a resolved ARRAY survives the rd parse byte-identically when the assignment is quoted', async () => {
    await fc.assert(
      fc.asyncProperty(arrayValueArb, async (value) => {
        // The real call-site spelling: the whole assignment is single-quoted
        // (artifact-variable-collate.runbook.md:13).
        expect(
          await argvEntriesContaining(
            "rd run x.runbook.md --artifacts-json 'R=${CAPTURE_ARTIFACT_ARRAY:k}' --allow-all",
            value,
          ),
        ).toBe(1);
      }),
    );
  });

  it('documents WHY the guard precondition is required: unquoted arrays falsify the property', async () => {
    // This is the defect Task 4's guard rejects. Pinned as a known falsification
    // so the precondition above is visibly non-arbitrary — and so this test goes
    // red (telling us to delete it) if the hazard is ever removed at the source.
    const value = JSON.stringify(['rd://artifacts/c/rd_1/plan.json']);
    const survived = await argvEntriesContaining(
      'rd run x.runbook.md --artifacts-json R=${CAPTURE_ARTIFACT_ARRAY:k}',
      value,
    );
    expect(survived).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Internals: cheap, and they pin the splice arithmetic against future edits.
  // These are NOT evidence that this change is correct — they were green before
  // it and are green after.
  // ---------------------------------------------------------------------------
  it('splices every placeholder at the right offset and preserves literals verbatim', async () => {
    await fc.assert(
      fc.asyncProperty(commandArb, async (command) => {
        const cmd = buildCommand(command);
        const calls: Placeholder[] = [];
        let n = 0;
        const resolve = async (key: string, asArray: boolean): Promise<string> => {
          calls.push({ key, asArray });
          return resolvedValue(n++, key, asArray);
        };

        const result = await substituteCapturedArtifacts(cmd, resolve);

        const expected = command.placeholders.reduce(
          (acc, p, i) => acc + resolvedValue(i, p.key, p.asArray) + command.literals[i + 1],
          command.literals[0],
        );
        // Offset correctness across every match, literal text preserved verbatim,
        // resolved values never re-scanned, adjacent placeholders handled.
        expect(result).toBe(expected);
        // N placeholders produce exactly N resolver calls, in match order, with
        // the array flag carried through.
        expect(calls).toEqual(
          command.placeholders.map((p) => ({ key: p.key, asArray: p.asArray })),
        );
      }),
    );
  });

  it('returns placeholder-free commands verbatim without calling the resolver', async () => {
    await fc.assert(
      fc.asyncProperty(literalArb, async (cmd) => {
        let calls = 0;
        const resolve = async (): Promise<string> => {
          calls++;
          return 'unused';
        };

        expect(await substituteCapturedArtifacts(cmd, resolve)).toBe(cmd);
        expect(calls).toBe(0);
      }),
    );
  });

  it('never re-scans a resolved value that itself looks like a placeholder', async () => {
    let calls = 0;
    const resolve = async (): Promise<string> => {
      calls++;
      return '${CAPTURE_ARTIFACT:injected}';
    };

    const result = await substituteCapturedArtifacts('a ${CAPTURE_ARTIFACT:real} b', resolve);

    expect(result).toBe('a ${CAPTURE_ARTIFACT:injected} b');
    expect(calls).toBe(1);
  });
});
