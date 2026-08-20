// @ts-check
import { ESLintUtils } from '@typescript-eslint/utils';

const BRAND_NAME = 'RenderedUnitCommand';
const BRAND_DECLARING_FILE_SUFFIX = 'runbook/execution-unit-entry.ts';

export const RENDERED_UNIT_COMMAND_PROVENANCE =
  'A RenderedUnitCommand is minted only by deriveExecutionUnitEntry. Reach it through RunbookActorService.enterExecutionUnit; asserting one anywhere else claims provenance the value does not have.';

const createRule = ESLintUtils.RuleCreator(
  () => 'https://github.com/tobyhede/rundown/blob/main/eslint.config.js',
);

/**
 * Does `tsType` name the RenderedUnitCommand interface — directly, through a
 * chain of `extends`, or as a member of a union/intersection?
 *
 * Resolved through the checker rather than through the syntax that named the
 * type, which is the property a `no-restricted-syntax` selector cannot have: a
 * selector matches an identifier's TEXT, so an import rename
 * (`RenderedUnitCommand as Local`) or a type alias produces a different
 * identifier at the assertion site and slips past every selector that
 * enumerates spellings. The checker instead resolves `Local` — or a base type,
 * or a union member — back to the same declared symbol, so identity is
 * checked once, structurally, rather than by re-deriving every path a name can
 * travel.
 *
 * `seen` guards a type graph that recurses through base types and union
 * members; nothing in this codebase's type graph is cyclic, but nothing about
 * the checker's API guarantees that in general.
 *
 * @param {import('typescript').Type} tsType - The resolved TypeScript type to test.
 * @param {Set<import('typescript').Symbol>} seen - Symbols already visited, to bound recursion.
 * @returns {boolean} True if `tsType` is, extends, or unions/intersects the
 *   branded interface.
 */
function namesRenderedUnitCommand(tsType, seen) {
  const symbol = tsType.getSymbol?.();
  if (symbol) {
    if (seen.has(symbol)) return false;
    seen.add(symbol);
    if (
      symbol.getName() === BRAND_NAME &&
      (symbol.getDeclarations() ?? []).some((declaration) =>
        declaration.getSourceFile().fileName.endsWith(BRAND_DECLARING_FILE_SUFFIX),
      )
    ) {
      return true;
    }
  }

  const baseTypes = tsType.getBaseTypes?.() ?? [];
  if (baseTypes.some((base) => namesRenderedUnitCommand(base, seen))) return true;

  if (tsType.isUnionOrIntersection?.()) {
    return tsType.types.some((member) => namesRenderedUnitCommand(member, seen));
  }

  return false;
}

/**
 * Bans every type-checker-resolvable way to assert a value into
 * `RenderedUnitCommand` outside its producing module.
 *
 * This replaces a `no-restricted-syntax` selector set that matched the
 * identifier `RenderedUnitCommand` by name. That approach has a hole by
 * construction: the set of SPELLINGS a selector must enumerate is unbounded
 * (an import rename, a re-exported alias, a type alias one hop further away),
 * while the set of underlying TYPES the checker can resolve those spellings to
 * is exactly one. Checking the resolved type closes the hole for every
 * spelling at once, including ones no selector was ever written for.
 *
 * Scoped to `TSAsExpression` and `TSTypeAssertion` because those are the two
 * syntaxes that can mint the brand — `deriveExecutionUnitEntry` is the only
 * code that legitimately produces a value of this type, so a cast anywhere
 * else materialises a value the runtime never verified.
 */
export const noRenderedUnitCommandCast = createRule({
  name: 'no-rendered-unit-command-cast',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow asserting a value to RenderedUnitCommand outside deriveExecutionUnitEntry.',
    },
    schema: [],
    messages: {
      forbidden: RENDERED_UNIT_COMMAND_PROVENANCE,
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);

    /**
     * @param {import('@typescript-eslint/utils').TSESTree.TypeNode} typeAnnotationNode
     */
    function check(typeAnnotationNode) {
      const tsTypeNode = services.esTreeNodeToTSNodeMap.get(typeAnnotationNode);
      const tsType = services.program.getTypeChecker().getTypeFromTypeNode(tsTypeNode);
      if (namesRenderedUnitCommand(tsType, new Set())) {
        context.report({ node: typeAnnotationNode, messageId: 'forbidden' });
      }
    }

    return {
      TSAsExpression(node) {
        check(node.typeAnnotation);
      },
      TSTypeAssertion(node) {
        check(node.typeAnnotation);
      },
    };
  },
});
