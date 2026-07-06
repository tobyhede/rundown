import { z } from 'zod';
import {
  claimCapabilityShape,
  claimIdShape,
  claimRunExclusive,
  optionalIndex,
  repeatableInputShape,
  runCapabilityShape,
  stepIndexPair,
} from './tool-schema-helpers.js';
import type { RundownToolDefinition, RundownToolName } from './tool-types.js';

/**
 * Tool descriptions and input schemas for the CLI-facade MCP surface.
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
    description: 'Get current runbook state',
    inputSchema: z.object({ ...claimIdShape }),
  },
  run: {
    description: 'Start or enter a runbook',
    inputSchema: stepIndexPair({
      file: z.string().optional(),
      prompted: z.boolean().optional(),
      ...repeatableInputShape,
    }),
  },
  pass: {
    description: 'Mark a step passed',
    inputSchema: claimRunExclusive(
      stepIndexPair({ ...claimCapabilityShape, ...runCapabilityShape }),
    ),
  },
  fail: {
    description: 'Mark a step failed',
    inputSchema: claimRunExclusive(
      stepIndexPair({ ...claimCapabilityShape, ...runCapabilityShape }),
    ),
  },
  goto: {
    description: 'Jump to a step',
    inputSchema: claimRunExclusive(
      z.object({
        step: z.string(),
        index: optionalIndex,
        ...claimCapabilityShape,
        ...runCapabilityShape,
      }),
    ),
  },
  complete: {
    description: 'Force current runbook completion',
    inputSchema: claimRunExclusive(
      z.object({
        message: z.string().optional(),
        ...claimCapabilityShape,
        ...runCapabilityShape,
      }),
    ),
  },
  stop: {
    description: 'Stop current runbook',
    inputSchema: claimRunExclusive(
      z.object({
        message: z.string().optional(),
        ...claimCapabilityShape,
        ...runCapabilityShape,
      }),
    ),
  },
  delegate: {
    description: `Issue or retry a delegation for the run you control. Available WITH \`runCapability\` (explicit orchestrator credential mapped to \`--run-capability <capability>\`); withheld bare — a bare subprocess-spawned \`delegate\` would silently inherit direct-CLI trust over the active run, so it returns a withheld-mutation error without spawning the CLI. Supply the run capability from \`rundown run\` JSON output, or run \`rundown delegate\` directly in a trusted terminal.`,
    inputSchema: stepIndexPair(
      {
        runbook: z.string().optional(),
        retry: z.boolean().optional(),
        ...repeatableInputShape,
        ...runCapabilityShape,
      },
      { strict: true },
    ),
  },
  claim: {
    description: 'Claim a delegation token and launch the child runbook',
    inputSchema: z.object({ token: z.string(), ...repeatableInputShape }),
  },
  collect: {
    description: 'Aggregate a delegated step and advance through core',
    inputSchema: claimRunExclusive(
      stepIndexPair({ ...claimCapabilityShape, ...runCapabilityShape }),
    ),
  },
};

/**
 * Ordered list of Rundown MCP tool names.
 */
export const RUNDOWN_TOOL_NAMES = Object.keys(RUNDOWN_TOOL_DEFINITIONS) as RundownToolName[];
