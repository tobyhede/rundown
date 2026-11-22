import { z } from 'zod';
import type { RundownToolDefinition, RundownToolName } from './tool-types.js';

const repeatableInputShape = {
  input: z.array(z.string()).optional(),
  inputJson: z.array(z.string()).optional(),
  inputFile: z.array(z.string()).optional(),
} satisfies z.ZodRawShape;
// Owner Token (`rdo_…`) printed once on `runbook_started`. It is the sole
// mutation authority: every mutating tool requires it and maps it to
// `--token`. MCP checks string-ness only — the CLI resolves and refuses
// (`TOKEN_REQUIRED`, `UNKNOWN_TOKEN`, run-finished) so the gate lives in one
// place.
const tokenShape = { token: z.string() } satisfies z.ZodRawShape;
// Shared `index` validator so the step/index constraint stays consistent
// between `run`, `pass`/`fail` and `goto`.
const optionalIndex = z.number().int().nonnegative().optional();

/**
 * Tool descriptions and input schemas for the CLI-facade MCP surface.
 *
 * Mutating tools (`pass`, `fail`, `goto`, `complete`, `stop`, `collect`, `retry`) take
 * the Owner Token; `pass`/`fail` also require `step` (the current position)
 * and accept `index` for a FOR iteration. `claim` takes the Claim Ticket a
 * delegated step's `step_entered` listed, and its response carries the
 * child's own Owner Token (#904). `retry` takes the Owner Token and the
 * delegated substep, and its response carries the fresh child's ticket;
 * `release` takes the child run id and the claiming agent's id, never a
 * token (#905). Read-only tools stay bare; `status` narrows by `runId`.
 */
export const RUNDOWN_TOOL_DEFINITIONS: Record<RundownToolName, RundownToolDefinition> = {
  validate: {
    description: 'Check runbook syntax',
    inputSchema: z.object({ file: z.string() }),
  },
  list: {
    description: 'List runbooks',
    inputSchema: z.object({
      all: z.boolean().optional(),
      tags: z.string().optional(),
    }),
  },
  status: {
    description: 'Get runbook state: every run, or one run selected by runId',
    inputSchema: z.object({ runId: z.string().optional() }),
  },
  run: {
    description: 'Start a runbook. The response carries the owner token for later mutations.',
    inputSchema: z
      .object({
        file: z.string().optional(),
        prompted: z.boolean().optional(),
        step: z.string().optional(),
        index: optionalIndex,
        ...repeatableInputShape,
      })
      .superRefine((value, ctx) => {
        if (value.index !== undefined && value.step === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['index'],
            message: 'index requires step',
          });
        }
      }),
  },
  pass: {
    description:
      'Mark the current step passed. Requires the owner token and the current step position; index for a FOR iteration.',
    inputSchema: z.object({ ...tokenShape, step: z.string(), index: optionalIndex }),
  },
  fail: {
    description:
      'Mark the current step failed. Requires the owner token and the current step position; index for a FOR iteration.',
    inputSchema: z.object({ ...tokenShape, step: z.string(), index: optionalIndex }),
  },
  goto: {
    description: 'Jump to a step. Requires the owner token.',
    inputSchema: z.object({ ...tokenShape, step: z.string(), index: optionalIndex }),
  },
  complete: {
    description: 'Force runbook completion. Requires the owner token.',
    inputSchema: z.object({ ...tokenShape, message: z.string().optional() }),
  },
  stop: {
    description: 'Stop the runbook. Requires the owner token.',
    inputSchema: z.object({ ...tokenShape, message: z.string().optional() }),
  },
  claim: {
    description:
      'Claim a delegated child by the Claim Ticket its parent step listed, and start it. Pass your agentId: release is matched against it, and nothing stamps it for you. The response carries the child owner token.',
    inputSchema: z.object({ ticket: z.string(), agentId: z.string().optional() }),
  },
  collect: {
    description:
      "Collect the results of the run's current delegated children into the run. Requires the owner token.",
    inputSchema: z.object({ ...tokenShape }),
  },
  retry: {
    description:
      'Cancel the delegated child of a substep (a lost ticket, an unclaimed child, or a child whose owner token was lost) and reserve a fresh one. The response carries its new claim ticket, once. Requires the owner token.',
    inputSchema: z.object({ ...tokenShape, step: z.string(), index: optionalIndex }),
  },
  release: {
    description:
      'Abandon a delegated child you claimed but cannot finish; its parent collects it as a fail while it still counts it (the response says whether). Takes the child run id and the same agentId the claim recorded, never a token.',
    inputSchema: z.object({ runId: z.string(), agentId: z.string().optional() }),
  },
};

/**
 * Ordered list of Rundown MCP tool names.
 */
export const RUNDOWN_TOOL_NAMES = Object.keys(RUNDOWN_TOOL_DEFINITIONS) as RundownToolName[];
