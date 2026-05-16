import type { TemplateHelperRegistry } from './helper-invoke.js';

export const RESERVED_TEMPLATE_HELPER_NAMES: ReadonlySet<string> = new Set(['artifact', 'path']);

export function detectTemplateHelperCollisions(
  registry: TemplateHelperRegistry,
  variables: Readonly<Record<string, unknown>>,
): string[] {
  const collisions: string[] = [];
  for (const name of registry.keys()) {
    if (Object.hasOwn(variables, name)) {
      collisions.push(name);
    }
  }
  return collisions;
}
