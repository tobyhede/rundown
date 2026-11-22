import { describe, expect, it, jest } from '@jest/globals';
import {
  buildRundownCommand,
  createMcpTextResponse,
  registerRundownTools,
  RUNDOWN_TOOL_DEFINITIONS,
  RUNDOWN_TOOL_NAMES,
  type RunCli,
  type RundownToolName,
} from '../src/tools.js';

/** A syntactically plausible Owner Token; the MCP layer treats it as opaque. */
const TOKEN = `rdo_${'A'.repeat(43)}`;
const RUN_ID = `rd_${'a'.repeat(32)}`;
/** A syntactically plausible Claim Ticket; the MCP layer treats it as opaque. */
const TICKET = `rdt_${'B'.repeat(43)}`;

/**
 * Parse the MCP text block back into its JSON payload so assertions pin the
 * structured envelope (e.g. `{ error }` / the success payload), not just a
 * substring of the rendered text.
 */
function parseToolResponse(res: unknown): unknown {
  const text = (res as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('expected an MCP text response with a JSON text block');
  }
  return JSON.parse(text);
}

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function registerWithHandlers(runCli: RunCli): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    registerTool: jest.fn((name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    }),
  };
  registerRundownTools(fakeServer, runCli);
  return handlers;
}

describe('tool surface', () => {
  it('exposes exactly the one-writer tool set, with claim and collect (#904)', () => {
    expect([...RUNDOWN_TOOL_NAMES].sort()).toEqual(
      [
        'claim',
        'collect',
        'complete',
        'fail',
        'goto',
        'list',
        'pass',
        'run',
        'status',
        'stop',
        'validate',
      ].sort(),
    );
    expect(RUNDOWN_TOOL_NAMES).not.toContain('delegate');
  });
});

describe('buildRundownCommand', () => {
  it.each([
    ['validate', { file: 'workflow.md' }, ['check', 'workflow.md']],
    ['list', { all: true, tags: 'release,prod' }, ['ls', '--all', '--tags', 'release,prod']],
    ['status', {}, ['status']],
    ['status', { runId: RUN_ID }, ['status', '--run', RUN_ID]],
    ['run', { file: 'workflow.md', prompted: true }, ['run', 'workflow.md', '--prompted']],
    [
      'run',
      { file: 'workflow.md', step: '2', input: ['env=prod'], inputJson: ['items=["a"]'] },
      ['run', 'workflow.md', '--step', '2', '--input', 'env=prod', '--input-json', 'items=["a"]'],
    ],
    ['pass', { token: TOKEN, step: '2.1' }, ['pass', '--token', TOKEN, '--step', '2.1']],
    [
      'pass',
      { token: TOKEN, step: '2.1', index: 3 },
      ['pass', '--token', TOKEN, '--step', '2.1', '--index', '3'],
    ],
    [
      'fail',
      { token: TOKEN, step: '2.1', index: 3 },
      ['fail', '--token', TOKEN, '--step', '2.1', '--index', '3'],
    ],
    ['goto', { token: TOKEN, step: '3.1' }, ['goto', '3.1', '--token', TOKEN]],
    [
      'goto',
      { token: TOKEN, step: '3.1', index: 2 },
      ['goto', '3.1', '--token', TOKEN, '--index', '2'],
    ],
    ['complete', { token: TOKEN }, ['complete', '--token', TOKEN]],
    ['complete', { token: TOKEN, message: 'done' }, ['complete', 'done', '--token', TOKEN]],
    ['stop', { token: TOKEN, message: 'blocked' }, ['stop', 'blocked', '--token', TOKEN]],
    ['claim', { ticket: TICKET }, ['claim', TICKET]],
    ['claim', { ticket: TICKET, agentId: 'agent-1' }, ['claim', TICKET, '--agent-id', 'agent-1']],
    ['collect', { token: TOKEN }, ['collect', '--token', TOKEN]],
  ] satisfies Array<[RundownToolName, Record<string, unknown>, string[]]>)(
    '%s builds the matching CLI argv',
    (tool, input, expected) => {
      expect(buildRundownCommand(tool, input)).toEqual(expected);
    },
  );

  it.each([
    ['validate', {}, 'validate.file must be a string'],
    ['pass', { step: '1' }, 'pass.token must be a string'],
    ['pass', { token: TOKEN }, 'pass.step must be a string'],
    ['fail', { step: '1' }, 'fail.token must be a string'],
    ['fail', { token: TOKEN }, 'fail.step must be a string'],
    ['goto', { token: TOKEN }, 'goto.step must be a string'],
    ['goto', { step: '2' }, 'goto.token must be a string'],
    ['complete', {}, 'complete.token must be a string'],
    ['stop', { message: 'blocked' }, 'stop.token must be a string'],
    ['claim', {}, 'claim.ticket must be a string'],
    ['collect', {}, 'collect.token must be a string'],
  ] satisfies Array<[RundownToolName, Record<string, unknown>, string]>)(
    '%s rejects missing required string inputs',
    (tool, input, message) => {
      expect(() => buildRundownCommand(tool, input)).toThrow(message);
    },
  );

  it('never emits the retired authority flags', () => {
    const argv = buildRundownCommand('pass', {
      token: TOKEN,
      step: '1',
      claimId: 'claim-1',
      runId: RUN_ID,
    });
    expect(argv).toEqual(['pass', '--token', TOKEN, '--step', '1']);
    expect(argv).not.toContain('--claim-id');
    expect(argv).not.toContain('--run');
  });

  it('renders CLI data as MCP text without interpreting runbook state', () => {
    expect(createMcpTextResponse({ data: { action: 'PASS', to: '2' } })).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ action: 'PASS', to: '2' }, null, 2),
        },
      ],
    });
  });

  it('renders explicit undefined data as JSON null per MCP envelope', () => {
    const response = createMcpTextResponse({ data: undefined });

    expect(response.content[0]?.text).toBe('null');
    expect(typeof response.content[0]?.text).toBe('string');
  });

  it('renders CLI errors as MCP text without replacing error shape', () => {
    expect(createMcpTextResponse({ error: 'No active runbook' })).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'No active runbook' }, null, 2),
        },
      ],
    });
  });
});

describe('inputSchema: token and step are required on pass/fail', () => {
  describe.each(['pass', 'fail'] as const)('%s', (tool) => {
    const schema = RUNDOWN_TOOL_DEFINITIONS[tool].inputSchema;

    it('accepts token + step', () => {
      expect(schema.safeParse({ token: TOKEN, step: '2.1' }).success).toBe(true);
    });

    it('accepts token + step + index', () => {
      expect(schema.safeParse({ token: TOKEN, step: '2.1', index: 3 }).success).toBe(true);
    });

    it('rejects a missing token', () => {
      const result = schema.safeParse({ step: '2.1' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === 'token')).toBe(true);
      }
    });

    it('rejects a missing step', () => {
      const result = schema.safeParse({ token: TOKEN });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === 'step')).toBe(true);
      }
    });

    it('rejects an empty object', () => {
      expect(schema.safeParse({}).success).toBe(false);
    });

    it('rejects a negative or fractional index', () => {
      expect(schema.safeParse({ token: TOKEN, step: '1', index: -1 }).success).toBe(false);
      expect(schema.safeParse({ token: TOKEN, step: '1', index: 1.5 }).success).toBe(false);
    });
  });
});

describe('inputSchema: token is required on goto/complete/stop', () => {
  it('goto requires token and step', () => {
    const schema = RUNDOWN_TOOL_DEFINITIONS.goto.inputSchema;
    expect(schema.safeParse({ token: TOKEN, step: '3.1' }).success).toBe(true);
    expect(schema.safeParse({ token: TOKEN, step: '3.1', index: 2 }).success).toBe(true);
    expect(schema.safeParse({ step: '3.1' }).success).toBe(false);
    expect(schema.safeParse({ token: TOKEN }).success).toBe(false);
    expect(schema.safeParse({ token: TOKEN, index: 3 }).success).toBe(false);
  });

  it.each(['complete', 'stop'] as const)('%s requires token; message is optional', (tool) => {
    const schema = RUNDOWN_TOOL_DEFINITIONS[tool].inputSchema;
    expect(schema.safeParse({ token: TOKEN }).success).toBe(true);
    expect(schema.safeParse({ token: TOKEN, message: 'why' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ message: 'why' }).success).toBe(false);
  });
});

describe('inputSchema: read-only tools stay bare', () => {
  it('status accepts no args or a runId selector', () => {
    const schema = RUNDOWN_TOOL_DEFINITIONS.status.inputSchema;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ runId: RUN_ID }).success).toBe(true);
  });

  it('run keeps the step/index pairing (index requires step)', () => {
    const schema = RUNDOWN_TOOL_DEFINITIONS.run.inputSchema;
    expect(schema.safeParse({ step: '2.1', index: 3 }).success).toBe(true);
    expect(schema.safeParse({ step: '2.1' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    const result = schema.safeParse({ index: 3 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const indexIssue = result.error.issues.find(
        (issue) => issue.path.length === 1 && issue.path[0] === 'index',
      );
      expect(indexIssue?.message).toMatch(/index requires step/);
    }
  });
});

describe('registerRundownTools', () => {
  it('registers every tool with an input schema', () => {
    const registered = new Map<string, unknown>();
    const fakeServer = {
      registerTool: jest.fn((name: string, config: unknown, handler: unknown) => {
        registered.set(name, { config, handler });
      }),
    };
    const runCli = jest.fn<RunCli>();

    registerRundownTools(fakeServer, runCli);

    expect([...registered.keys()].sort()).toEqual(Object.keys(RUNDOWN_TOOL_DEFINITIONS).sort());
  });

  it('pass handler spawns the CLI with --token and --step and returns CLI JSON', async () => {
    const runCli = jest
      .fn<RunCli>()
      .mockResolvedValue({ success: true, data: { command: 'pass', to: '2' } });
    const handlers = registerWithHandlers(runCli);

    await expect(handlers.get('pass')?.({ token: TOKEN, step: '1' })).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ command: 'pass', to: '2' }, null, 2) }],
    });
    expect(runCli).toHaveBeenCalledWith(['pass', '--token', TOKEN, '--step', '1']);
  });

  it.each(['pass', 'fail', 'goto', 'complete', 'stop'] as const)(
    '%s handler refuses a call without token before spawning the CLI',
    async (tool) => {
      const runCli = jest.fn<RunCli>();
      const handlers = registerWithHandlers(runCli);

      const res = await handlers.get(tool)?.({ step: '1' });
      expect(parseToolResponse(res)).toEqual({ error: expect.stringContaining('token') });
      expect(runCli).not.toHaveBeenCalled();
    },
  );

  it.each(['pass', 'fail'] as const)(
    '%s handler refuses a call without step before spawning the CLI',
    async (tool) => {
      const runCli = jest.fn<RunCli>();
      const handlers = registerWithHandlers(runCli);

      const res = await handlers.get(tool)?.({ token: TOKEN });
      expect(parseToolResponse(res)).toEqual({ error: expect.stringContaining('step') });
      expect(runCli).not.toHaveBeenCalled();
    },
  );

  it('status handler stays bare and passes an optional runId selector through', async () => {
    const runCli = jest.fn<RunCli>().mockResolvedValue({ success: true, data: { runs: [] } });
    const handlers = registerWithHandlers(runCli);

    await handlers.get('status')?.({});
    expect(runCli).toHaveBeenLastCalledWith(['status']);

    await handlers.get('status')?.({ runId: RUN_ID });
    expect(runCli).toHaveBeenLastCalledWith(['status', '--run', RUN_ID]);
  });

  it('wraps handler throws as a structured MCP error response', async () => {
    const runCli = jest.fn<RunCli>();
    const handlers = registerWithHandlers(runCli);

    // `validate` requires `file: string`; missing it fails schema.parse before
    // buildRundownCommand. The error envelope names the failing path.
    await expect(handlers.get('validate')?.({})).resolves.toMatchObject({
      content: [{ type: 'text', text: expect.stringMatching(/"error": "file: /) }],
    });
    expect(runCli).not.toHaveBeenCalled();
  });

  it('wraps runCli rejections as a structured MCP error response', async () => {
    const runCli = jest.fn<RunCli>().mockRejectedValue(new Error('transport down'));
    const handlers = registerWithHandlers(runCli);

    await expect(handlers.get('status')?.({})).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'transport down' }, null, 2),
        },
      ],
    });
  });

  it('passes a CLI refusal through unchanged (the CLI, not MCP, is the authority gate)', async () => {
    const refusal = {
      success: false,
      error: 'Unknown token',
      data: { error: 'Unknown token', code: 'UNKNOWN_TOKEN', command: 'pass' },
    };
    const runCli = jest.fn<RunCli>().mockResolvedValue(refusal);
    const handlers = registerWithHandlers(runCli);

    const res = await handlers.get('pass')?.({ token: TOKEN, step: '1' });
    expect(parseToolResponse(res)).toEqual(refusal.data);
    expect(runCli).toHaveBeenCalledWith(['pass', '--token', TOKEN, '--step', '1']);
  });

  it('run handler rejects index without step before invoking the CLI', async () => {
    const runCli = jest.fn<RunCli>();
    const handlers = registerWithHandlers(runCli);

    await expect(handlers.get('run')?.({ index: 3 })).resolves.toMatchObject({
      content: [{ type: 'text', text: expect.stringMatching(/index: index requires step/) }],
    });
    expect(runCli).not.toHaveBeenCalled();
  });
});
