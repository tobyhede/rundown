import { TEMPLATE_VAR_PATTERN } from '@rundown-org/parser';
import { z } from 'zod';
import { FOR_RESOLUTION_FAILURE_CODES } from './actors/for-iterate-actor.js';
import type { LastAction } from './types.js';

const LastActionOriginSchema = z.enum(['direct', 'aggregation']);

const LastActionBaseSchema = z.object({
  origin: LastActionOriginSchema,
});

const GotoAtSchema = z
  .union([z.number().int().positive(), z.string().regex(TEMPLATE_VAR_PATTERN)])
  .transform((value) => value as number | `{{${string}}}`);

/**
 * Canonical Zod schema for persisted and runtime `LastAction` values.
 *
 * This is the single schema owner for action-origin metadata. Public execution
 * events still project aggregation-origin actions to `aggregated: true`.
 */
export const LastActionSchema: z.ZodType<LastAction> = z.discriminatedUnion('type', [
  LastActionBaseSchema.extend({ type: z.literal('START') }),
  LastActionBaseSchema.extend({ type: z.literal('CONTINUE') }),
  LastActionBaseSchema.extend({ type: z.literal('DEFER') }),
  LastActionBaseSchema.extend({
    type: z.literal('GOTO'),
    target: z.string(),
    substep: z.string().optional(),
    at: GotoAtSchema.optional(),
  }),
  LastActionBaseSchema.extend({ type: z.literal('COMPLETE') }),
  LastActionBaseSchema.extend({ type: z.literal('STOP') }),
  LastActionBaseSchema.extend({ type: z.literal('RETRY') }),
  LastActionBaseSchema.extend({ type: z.literal('NEXT') }),
  LastActionBaseSchema.extend({ type: z.literal('BREAK') }),
  LastActionBaseSchema.extend({
    type: z.literal('RETRY_ERROR'),
    code: z.string(),
    message: z.string(),
  }),
  LastActionBaseSchema.extend({
    type: z.literal('OUTPUT_CAPTURE_FAILED'),
    message: z.string(),
  }),
  LastActionBaseSchema.extend({
    type: z.literal('ARTIFACT_RESOLUTION_FAILED'),
    message: z.string(),
  }),
  LastActionBaseSchema.extend({
    type: z.literal('FOR_RESOLUTION_FAILED'),
    code: z.enum(FOR_RESOLUTION_FAILURE_CODES),
    message: z.string(),
  }),
  LastActionBaseSchema.extend({
    type: z.literal('POLICY_DENIED'),
    message: z.string(),
  }),
  LastActionBaseSchema.extend({
    type: z.literal('COMMAND_EXECUTION_FAILED'),
    message: z.string(),
  }),
  LastActionBaseSchema.extend({
    type: z.literal('DELEGATION_ISSUANCE_FAILED'),
    reason: z.enum(['delegation_resolution_failed', 'nested_delegation_forbidden']),
    message: z.string(),
  }),
]);

/**
 * Build a direct-origin `LastAction`.
 *
 * @param action - LastAction payload without origin
 * @returns LastAction with `origin: 'direct'`
 */
export function makeDirectLastAction<T extends Omit<LastAction, 'origin'>>(
  action: T,
): T & { readonly origin: 'direct' } {
  return { ...action, origin: 'direct' };
}

/**
 * Build an aggregation-origin `LastAction`.
 *
 * @param action - LastAction payload without origin
 * @returns LastAction with `origin: 'aggregation'`
 */
export function makeAggregationLastAction<T extends Omit<LastAction, 'origin'>>(
  action: T,
): T & { readonly origin: 'aggregation' } {
  return { ...action, origin: 'aggregation' };
}

/**
 * Test whether a `LastAction` was produced by parent aggregation.
 *
 * @param action - LastAction to inspect
 * @returns True when the action origin is aggregation
 */
export function isAggregationLastAction(
  action: LastAction | undefined,
): action is LastAction & { readonly origin: 'aggregation' } {
  return action?.origin === 'aggregation';
}

/**
 * Runtime type guard for canonical `LastAction` values.
 *
 * @param value - Unknown value to validate
 * @returns True when the value satisfies `LastActionSchema`
 */
export function isLastAction(value: unknown): value is LastAction {
  return LastActionSchema.safeParse(value).success;
}
