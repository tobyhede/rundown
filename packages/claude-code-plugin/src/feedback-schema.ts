/**
 * Zod schema and validation for the JSON feedback format.
 *
 * Defines the structure for agent execution feedback on runbook and
 * skill quality. Feedback is authored as JSON and validated by `rdx`.
 *
 * @module feedback-schema
 */

import { z } from 'zod';

/** Rating scale from 1 (poor) to 5 (excellent). */
const Rating = z.number().int().min(1).max(5);

/** Feedback for a single runbook step. */
const StepFeedback = z
  .object({
    step: z.number().int().min(1).describe('Step number in the runbook'),
    name: z.string().min(1).describe('Step name as it appears in the runbook'),
    friction: z.enum(['none', 'low', 'medium', 'high']).describe('How much friction this step caused'),
    notes: z.string().describe('What caused friction or what worked well').optional(),
  })
  .strict();

/** Document metadata. */
const Meta = z
  .object({
    version: z.literal('1.0.0'),
  })
  .strict();

/** Overall quality ratings. */
const Overall = z
  .object({
    clarity: Rating.describe('Were instructions clear and unambiguous?'),
    completeness: Rating.describe('Were all necessary instructions provided?'),
    accuracy: Rating.describe('Did following instructions produce correct results?'),
  })
  .strict();

/**
 * Schema for agent execution feedback.
 *
 * Captures per-step friction ratings and overall quality assessment
 * for runbook and skill improvement.
 */
export const FeedbackSchema = z
  .object({
    $schema: z.literal('https://rundown.org/schemas/feedback.schema.json').optional(),
    meta: Meta,
    runbook: z.string().min(1).describe('Runbook name or identifier'),
    skill: z.string().min(1).describe('Skill name that orchestrated the runbook'),
    steps: z.array(StepFeedback).min(1),
    overall: Overall,
    suggestions: z
      .array(z.string().min(1))
      .describe('Specific improvements to the skill or runbook')
      .optional(),
    improvised: z
      .array(z.string().min(1))
      .describe('Actions taken that were not covered by instructions')
      .optional(),
  })
  .strict();

/** Validated feedback type inferred from FeedbackSchema. */
export type Feedback = z.infer<typeof FeedbackSchema>;

/** Validated step feedback type. */
export type FeedbackStep = z.infer<typeof StepFeedback>;

/** Validated overall rating type. */
export type FeedbackOverall = z.infer<typeof Overall>;

/**
 * Validate unknown data against the feedback schema.
 *
 * Convention export for generic rdx schema discovery.
 *
 * @param data - Unknown data to validate
 * @returns Typed Feedback object
 * @throws {ZodError} If data does not conform to FeedbackSchema
 */
export function validate(data: unknown): Feedback {
  return FeedbackSchema.parse(data);
}
