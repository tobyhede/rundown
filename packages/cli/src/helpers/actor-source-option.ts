// packages/cli/src/helpers/actor-source-option.ts

import type { ActorContextSource } from '@rundown-org/core';
import { parseActorSource } from './resolve-actor-context.js';

/**
 * Minimal structural view of the Commander command needed to read the
 * program-level `--actor-source` option (kept narrow so tests need no real
 * Commander instance).
 */
export interface ActorSourceReader {
  /**
   * Return this command's options merged with inherited program-level options.
   *
   * @returns Options object exposing the optional `actorSource` string
   */
  optsWithGlobals(): { actorSource?: string };
}

/**
 * Resolve the actor-context source tag from CLI ingress.
 *
 * Precedence: the `--actor-source` flag wins over the `RD_ACTOR_SOURCE` env var.
 * An empty-string env value is treated as unset. When neither is supplied this
 * returns `undefined`, deferring the `direct-cli` compatibility default to
 * {@link resolveActorContext}.
 *
 * @param command - Command exposing program-level options via `optsWithGlobals`
 * @param env - Environment to read `RD_ACTOR_SOURCE` from (defaults to `process.env`)
 * @returns The validated source tag, or `undefined` when none was supplied
 * @throws {InvalidActorSourceError} when a supplied flag/env value is invalid
 */
export function readActorSourceIngress(
  command: ActorSourceReader,
  env: NodeJS.ProcessEnv = process.env,
): ActorContextSource | undefined {
  const flagValue = command.optsWithGlobals().actorSource;
  if (flagValue !== undefined) {
    return parseActorSource(flagValue);
  }
  const envValue = env.RD_ACTOR_SOURCE;
  if (envValue !== undefined && envValue !== '') {
    return parseActorSource(envValue);
  }
  return undefined;
}
