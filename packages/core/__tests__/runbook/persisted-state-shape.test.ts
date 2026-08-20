import { describe, it, expect } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { RunbookStateSchema, makeRunbookStateSchema } from '../../src/schemas.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/runbook/state.js';

/**
 * The pairing guard for #775.
 *
 * Three PRs (#746, #772, #827) each added a required field to the persisted run
 * state and left `CURRENT_SCHEMA_VERSION` at `1`. Nothing failed, because
 * nothing connected the two: the shape lives in `schemas.ts`, the version lives
 * in `persisted-state-guards.ts`, and every fixture hard-coded the version as a
 * literal that could not go stale because it was never derived from anything.
 *
 * This file is the connection. It renders the persisted run-state schema as a
 * canonical structural string and compares it against a fixture named for the
 * version that shape belongs to. Change the shape and this fails; the way to
 * make it pass is to move `CURRENT_SCHEMA_VERSION` and record the new shape
 * under the new version's name.
 *
 * What it does NOT do is force the bump — no test can. Editing
 * `schema-v<n>.txt` in place makes it green again while leaving the version
 * stationary, which is the exact defect. What the guard buys is that the moment
 * becomes unmissable and the remedy is named at the failure, instead of the
 * change landing in silence three times running. Rewriting a fixture named for
 * an already-shipped version is also a conspicuous thing to do in review, which
 * is the rest of the protection.
 */

/**
 * A Zod internal node, reached through `def`.
 *
 * Deliberately structural and loose: this walker reads Zod's own runtime
 * representation, which carries no public type. A Zod upgrade that renames
 * these fields fails this test loudly rather than degrading it silently — the
 * fingerprint would change, which is exactly the signal to re-derive it.
 */
type ZodNode = {
  readonly def?: Record<string, unknown>;
  readonly _def?: Record<string, unknown>;
};

/**
 * Render one schema node as a canonical structural string.
 *
 * Object keys are sorted and union options are sorted, so the output depends on
 * the shape and not on declaration order — a field reordered in source must not
 * read as a persisted-shape change. Cycle detection is path-scoped rather than
 * global: a sub-schema reused in two places expands at both, so a change to a
 * shared node cannot be hidden behind a `cycle` marker at the second use.
 *
 * @param node - The Zod node to render, or a non-schema value.
 * @param path - Ancestors on the current branch, for genuine recursion.
 * @returns A canonical description of the node's structure.
 */
function renderNode(node: unknown, path: Set<unknown>): string {
  if (node === undefined || node === null) {
    return 'none';
  }
  if (path.has(node)) {
    return 'cycle';
  }
  const def = (node as ZodNode).def ?? (node as ZodNode)._def;
  if (def === undefined) {
    return 'opaque';
  }

  const nextPath = new Set(path);
  nextPath.add(node);
  const sub = (child: unknown): string => renderNode(child, nextPath);
  const kind = String(def.type);

  switch (kind) {
    case 'object': {
      const shape = def.shape as Record<string, unknown>;
      const entries = Object.keys(shape)
        .sort()
        .map((key) => `${key}:${sub(shape[key])}`);
      return `object{${entries.join(',')}}catchall(${sub(def.catchall)})`;
    }
    case 'optional':
    case 'nullable':
    case 'readonly':
    case 'nonoptional':
    case 'default':
    case 'prefault':
    case 'catch':
      return `${kind}(${sub(def.innerType)})`;
    case 'array':
      return `array(${sub(def.element)})`;
    case 'record':
      return `record(${sub(def.keyType)},${sub(def.valueType)})`;
    case 'tuple': {
      const items = (def.items as unknown[] | undefined) ?? [];
      const rest = def.rest === undefined ? '' : `,...${sub(def.rest)}`;
      return `tuple(${items.map(sub).join(',')}${rest})`;
    }
    case 'union': {
      const options = (def.options as unknown[] | undefined) ?? [];
      return `union(${options.map(sub).sort().join('|')})`;
    }
    case 'intersection':
      return `intersection(${sub(def.left)},${sub(def.right)})`;
    case 'enum':
      return `enum(${Object.keys((def.entries as Record<string, unknown> | undefined) ?? {})
        .sort()
        .join('|')})`;
    case 'literal':
      return `literal(${((def.values as unknown[] | undefined) ?? [])
        .map((value) => String(value))
        .sort()
        .join('|')})`;
    case 'pipe':
      return `pipe(${sub(def.in)},${sub(def.out)})`;
    case 'lazy':
      return `lazy(${sub((def.getter as (() => unknown) | undefined)?.())})`;
    // A refinement or transform carries executable behaviour this walker cannot
    // read. Named by kind alone: adding one is not a persisted-shape change, and
    // rendering it as anything richer would make the fingerprint depend on
    // function identity, which differs between runs.
    default:
      return kind;
  }
}

/**
 * Render a schema's full structure as one canonical line.
 *
 * @param schema - The schema to fingerprint.
 * @returns The canonical structural description.
 */
function fingerprint(schema: z.ZodType): string {
  return renderNode(schema, new Set());
}

/**
 * Both persisted run-state schemas, because a shape change can land in either.
 *
 * `RunbookStateSchema` is the exported static schema. `makeRunbookStateSchema`
 * is the path-validated variant, and it is the one the two readers of persisted
 * state actually parse with (`RunbookStateManager.load` and
 * `RunbookStore.readRun`) — its nested `make*` schemas are parallel definitions
 * of the same shapes, so a field added to only one of the pair would be missed
 * by a fingerprint over only the other. #772 changed both.
 */
const SCHEMAS: readonly (readonly [string, z.ZodType])[] = [
  ['RunbookStateSchema', RunbookStateSchema],
  // A fixed project root: the value is only a path-boundary parameter and never
  // reaches the structure, but a real one keeps the rendering deterministic.
  ['makeRunbookStateSchema', makeRunbookStateSchema('/rundown-persisted-state-shape')],
];

/** Canonical text of the recorded shape for one version, as committed. */
function renderFixture(): string {
  return `${SCHEMAS.map(([name, schema]) => `${name}\n${fingerprint(schema)}`).join('\n\n')}\n`;
}

const fixturePath = (version: number): string =>
  fileURLToPath(
    new URL(`../fixtures/persisted-state-shape/schema-v${String(version)}.txt`, import.meta.url),
  );

describe('persisted run-state shape is pinned to CURRENT_SCHEMA_VERSION', () => {
  it('matches the shape recorded for the current version', async () => {
    let recorded: string;
    try {
      recorded = await readFile(fixturePath(CURRENT_SCHEMA_VERSION), 'utf8');
    } catch {
      throw new Error(
        `No persisted run-state shape is recorded for schema version ${String(CURRENT_SCHEMA_VERSION)}. ` +
          `Write the current shape to __tests__/fixtures/persisted-state-shape/schema-v${String(CURRENT_SCHEMA_VERSION)}.txt.`,
      );
    }

    // The whole rendered text, not a hash: the failure diff is then the list of
    // fields that changed, which is the fact a reviewer needs. A hash would say
    // only that something moved.
    expect(renderFixture()).toBe(recorded);
  });

  it('renders the same fingerprint twice, so a mismatch means the shape moved', () => {
    // The premise the test above rests on. Zod builds schema nodes at module
    // load, and the walker sorts keys and union options, so nothing in the
    // rendering may depend on iteration order, object identity, or a closure —
    // any of which would make the pin fail on an unchanged shape and train a
    // reader to re-record it reflexively.
    expect(renderFixture()).toBe(renderFixture());
  });

  it('fires on a required field added to the persisted shape', () => {
    // The regression class itself, exercised rather than asserted: #746, #772
    // and #827 each added a required field, and the guard is only worth having
    // if that is the edit it catches.
    const widened = RunbookStateSchema.def.shape;
    const withNewField = RunbookStateSchema.extend({
      inlineLaunchGeneration: (RunbookStateSchema.def.shape as { readonly step: z.ZodType }).step,
    });

    expect(Object.keys(widened)).not.toContain('inlineLaunchGeneration');
    expect(fingerprint(withNewField)).not.toBe(fingerprint(RunbookStateSchema));
  });
});
