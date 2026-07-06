import { describe, expect, it, jest } from '@jest/globals';
import {
  buildRundownCommand,
  createMcpTextResponse,
  registerRundownTools,
  RUNDOWN_TOOL_DEFINITIONS,
  type RunCli,
  type RundownToolName,
} from '../src/tools.js';

describe('buildRundownCommand', () => {
  it.each([
    ['validate', { file: 'workflow.md' }, ['check', 'workflow.md']],
    ['list', { all: true, tags: 'release,prod' }, ['ls', '--all', '--tags', 'release,prod']],
    ['status', { claimId: 'claim-1' }, ['status', '--claim-id', 'claim-1']],
    ['run', { file: 'workflow.md', prompted: true }, ['run', 'workflow.md', '--prompted']],
    [
      'pass',
      { step: '2.1', index: 3, claimId: 'claim-1' },
      ['pass', '--step', '2.1', '--index', '3', '--claim-id', 'claim-1'],
    ],
    [
      'fail',
      { step: '2.1', index: 3, claimId: 'claim-1' },
      ['fail', '--step', '2.1', '--index', '3', '--claim-id', 'claim-1'],
    ],
    [
      'goto',
      { step: '3.1', index: 2, claimId: 'claim-1' },
      ['goto', '3.1', '--index', '2', '--claim-id', 'claim-1'],
    ],
    [
      'complete',
      { message: 'done', claimId: 'claim-1' },
      ['complete', 'done', '--claim-id', 'claim-1'],
    ],
    [
      'stop',
      { message: 'blocked', claimId: 'claim-1' },
      ['stop', 'blocked', '--claim-id', 'claim-1'],
    ],
    ['delegate', { step: '4.1', index: 2 }, ['delegate', '--step', '4.1', '--index', '2']],
    [
      'delegate',
      { runbook: 'child.md', step: '1', claimId: 'claim-1', input: ['env=prod'] },
      ['delegate', 'child.md', '--step', '1', '--claim-id', 'claim-1', '--input', 'env=prod'],
    ],
    [
      'delegate',
      { retry: true, step: '4.1', input: ['mode=fast'] },
      ['delegate', '--retry', '--step', '4.1', '--input', 'mode=fast'],
    ],
    [
      'delegate',
      {
        retry: true,
        step: '4.1',
        inputJson: ['vars={"mode":"fast"}'],
        inputFile: ['vars.yaml'],
      },
      [
        'delegate',
        '--retry',
        '--step',
        '4.1',
        '--input-json',
        'vars={"mode":"fast"}',
        '--input-file',
        'vars.yaml',
      ],
    ],
    [
      'claim',
      {
        token: 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
        inputJson: ['items=["a"]'],
      },
      ['claim', 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', '--input-json', 'items=["a"]'],
    ],
    [
      'collect',
      { step: '5', index: 2, claimId: 'claim-1' },
      ['collect', '--step', '5', '--index', '2', '--claim-id', 'claim-1'],
    ],
  ] satisfies Array<
    [RundownToolName, Record<string, unknown>, string[]]
  >)('%s builds the matching CLI argv', (tool, input, expected) => {
    expect(buildRundownCommand(tool, input)).toEqual(expected);
  });

  it.each([
    ['validate', {}, 'validate.file must be a string'],
    ['goto', {}, 'goto.step must be a string'],
    ['claim', {}, 'claim.token must be a string'],
  ] satisfies Array<
    [RundownToolName, Record<string, unknown>, string]
  >)('%s rejects missing required string inputs', (tool, input, message) => {
    expect(() => buildRundownCommand(tool, input)).toThrow(message);
  });

  it('maps bare pass/fail to CLI argv without a frontend-specific guard', () => {
    expect(buildRundownCommand('pass', {})).toEqual(['pass']);
    expect(buildRundownCommand('fail', {})).toEqual(['fail']);
  });

  it.each([
    'pass',
    'fail',
    'goto',
    'complete',
    'stop',
    'delegate',
    'collect',
  ] as const)('%s rejects claimId + runId before building CLI argv', (tool) => {
    expect(() =>
      buildRundownCommand(tool, {
        step: '3.1',
        claimId: 'claim-1',
        runId: `rd_${'a'.repeat(32)}`,
      }),
    ).toThrow(/runId cannot be combined with claimId/);
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

describe('inputSchema enforces index requires step', () => {
  const stepIndexTools = ['run', 'pass', 'fail', 'delegate', 'collect'] as const;

  describe.each(stepIndexTools)('%s', (tool) => {
    const schema = RUNDOWN_TOOL_DEFINITIONS[tool].inputSchema;

    it('accepts step + index together', () => {
      expect(schema.safeParse({ step: '2.1', index: 3 }).success).toBe(true);
    });

    it('accepts step alone', () => {
      expect(schema.safeParse({ step: '2.1' }).success).toBe(true);
    });

    it('accepts neither step nor index', () => {
      expect(schema.safeParse({}).success).toBe(true);
    });

    it('rejects index without step', () => {
      const result = schema.safeParse({ index: 3 });
      expect(result.success).toBe(false);
      if (!result.success) {
        const indexIssue = result.error.issues.find(
          (issue) => issue.path.length === 1 && issue.path[0] === 'index',
        );
        expect(indexIssue).toBeDefined();
        expect(indexIssue?.message).toMatch(/index requires step/);
      }
    });
  });

  it('goto already requires step at the schema level', () => {
    const schema = RUNDOWN_TOOL_DEFINITIONS.goto.inputSchema;
    expect(schema.safeParse({ index: 3 }).success).toBe(false);
    expect(schema.safeParse({ step: '3.1', index: 2 }).success).toBe(true);
  });
});

describe('inputSchema rejects claimId and runId together', () => {
  const dualAuthorityTools = [
    'pass',
    'fail',
    'goto',
    'complete',
    'stop',
    'delegate',
    'collect',
  ] as const;
  const runId = `rd_${'a'.repeat(32)}`;
  const claimId =
    'rdclm_00000000000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  // `goto` requires `step`; harmless extra field for the rest.
  const withStep = { step: '3.1' };

  describe.each(dualAuthorityTools)('%s', (tool) => {
    const schema = RUNDOWN_TOOL_DEFINITIONS[tool].inputSchema;

    it('accepts claimId alone', () => {
      expect(schema.safeParse({ ...withStep, claimId }).success).toBe(true);
    });

    it('accepts runId alone', () => {
      expect(schema.safeParse({ ...withStep, runId }).success).toBe(true);
    });

    it('rejects claimId + runId together', () => {
      const result = schema.safeParse({ ...withStep, claimId, runId });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (schemaIssue) => schemaIssue.path.length === 1 && schemaIssue.path[0] === 'runId',
        );
        expect(issue).toBeDefined();
        expect(issue?.message).toMatch(/runId cannot be combined with claimId/);
      }
    });
  });
});

describe('registerRundownTools', () => {
  it('registers every parity tool with an input schema', () => {
    const registered = new Map<string, unknown>();
    const fakeServer = {
      registerTool: jest.fn((name: string, config: unknown, handler: unknown) => {
        registered.set(name, { config, handler });
      }),
    };
    const runCli = jest.fn<RunCli>();

    registerRundownTools(fakeServer, runCli);

    expect([...registered.keys()].sort()).toEqual(Object.keys(RUNDOWN_TOOL_DEFINITIONS).sort());

    // Probe registered schemas with representative valid inputs rather than
    // asserting the raw Zod object shape (the schema is now a composite
    // ZodType, not a plain shape record).
    expect(
      RUNDOWN_TOOL_DEFINITIONS.delegate.inputSchema.safeParse({
        runbook: 'child.md',
        retry: true,
        step: '4.1',
        input: ['env=prod'],
        inputJson: ['vars={"a":1}'],
        inputFile: ['vars.yaml'],
      }).success,
    ).toBe(true);
    expect(
      RUNDOWN_TOOL_DEFINITIONS.claim.inputSchema.safeParse({
        token: 'rdtk_X',
        input: ['env=prod'],
      }).success,
    ).toBe(true);
    expect(
      RUNDOWN_TOOL_DEFINITIONS.collect.inputSchema.safeParse({
        step: '5',
        index: 2,
        claimId: 'claim-1',
      }).success,
    ).toBe(true);
    for (const tool of ['status', 'pass', 'fail', 'complete', 'stop'] as const) {
      expect(
        RUNDOWN_TOOL_DEFINITIONS[tool].inputSchema.safeParse({
          claimId: 'claim-1',
        }).success,
      ).toBe(true);
    }
    expect(RUNDOWN_TOOL_DEFINITIONS.goto.inputSchema.safeParse({ step: '3.1' }).success).toBe(true);
  });

  it('accepts claimId on the delegate tool schema', () => {
    const result = RUNDOWN_TOOL_DEFINITIONS.delegate.inputSchema.safeParse({
      runbook: 'child.md',
      claimId: 'rdclm_abcdefghijklmnopqrstu1',
    });

    expect(result.success).toBe(true);
  });

  it('registered handlers invoke runCli with built argv and return CLI JSON', async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      registerTool: jest.fn(
        (
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) => {
          handlers.set(name, handler);
        },
      ),
    };
    const runCli = jest
      .fn<RunCli>()
      .mockResolvedValue({ success: true, data: { collected: true } });
    registerRundownTools(fakeServer, runCli);

    await expect(handlers.get('collect')?.({ step: '1.1', claimId: 'claim-1' })).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ collected: true }, null, 2) }],
    });
    expect(runCli).toHaveBeenCalledWith(['collect', '--step', '1.1', '--claim-id', 'claim-1']);
  });

  it('wraps handler throws as a structured MCP error response', async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      registerTool: jest.fn(
        (
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) => {
          handlers.set(name, handler);
        },
      ),
    };
    const runCli = jest.fn<RunCli>();
    registerRundownTools(fakeServer, runCli);

    // `validate` requires `file: string`; missing it fails schema.parse before
    // buildRundownCommand. The error envelope names the failing path.
    await expect(handlers.get('validate')?.({})).resolves.toMatchObject({
      content: [{ type: 'text', text: expect.stringMatching(/"error": "file: /) }],
    });
    expect(runCli).not.toHaveBeenCalled();
  });

  it('wraps runCli rejections as a structured MCP error response', async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      registerTool: jest.fn(
        (
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) => {
          handlers.set(name, handler);
        },
      ),
    };
    const runCli = jest.fn<RunCli>().mockRejectedValue(new Error('transport down'));
    registerRundownTools(fakeServer, runCli);

    await expect(handlers.get('status')?.({})).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'transport down' }, null, 2),
        },
      ],
    });
  });

  it.each([
    'run',
    'pass',
    'fail',
    'delegate',
    'collect',
  ] as const)('%s handler rejects index without step before invoking the CLI', async (tool) => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      registerTool: jest.fn(
        (
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) => {
          handlers.set(name, handler);
        },
      ),
    };
    const runCli = jest.fn<RunCli>();
    registerRundownTools(fakeServer, runCli);

    await expect(handlers.get(tool)?.({ index: 3 })).resolves.toMatchObject({
      content: [
        {
          type: 'text',
          text: expect.stringMatching(/index: index requires step/),
        },
      ],
    });
    expect(runCli).not.toHaveBeenCalled();
  });

  it.each([
    'pass',
    'fail',
    'goto',
    'complete',
    'stop',
    'delegate',
    'collect',
  ] as const)('%s handler rejects claimId + runId together before invoking the CLI', async (tool) => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      registerTool: jest.fn(
        (
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) => {
          handlers.set(name, handler);
        },
      ),
    };
    const runCli = jest.fn<RunCli>();
    registerRundownTools(fakeServer, runCli);

    const res = await handlers.get(tool)?.({
      step: '3.1',
      claimId: 'rdclm_00000000000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      runId: `rd_${'a'.repeat(32)}`,
    });
    expect(res).toMatchObject({
      content: [
        {
          type: 'text',
          text: expect.stringMatching(/runId cannot be combined with claimId/),
        },
      ],
    });
    expect(runCli).not.toHaveBeenCalled();
  });
});

describe('subprocess trust boundary', () => {
  function registerWithHandlers(runCli: RunCli) {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      registerTool: jest.fn(
        (
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) => {
          handlers.set(name, handler);
        },
      ),
    };
    registerRundownTools(fakeServer, runCli);
    return handlers;
  }

  // Parse the MCP text block back into its JSON payload so assertions pin the
  // structured envelope (e.g. `{ error }` / the success payload), not just a
  // substring of the rendered text.
  function parseToolResponse(res: unknown): unknown {
    const text = (res as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new Error('expected an MCP text response with a JSON text block');
    }
    return JSON.parse(text);
  }

  it('advertises delegate as claimId-gated with selector-only runId', () => {
    // Delegate needs bearer authority. runId is target selection only, so bare
    // and runId-only subprocess calls are withheld.
    const { description } = RUNDOWN_TOOL_DEFINITIONS.delegate;
    expect(description).toMatch(/claimId/);
    expect(description).toMatch(/runId/);
    expect(description).toMatch(/Bare or runId-only/i);
    expect(description).toMatch(/rundown delegate/);
  });

  it.each([
    ['pass'],
    ['fail'],
    ['delegate'],
    ['collect'],
  ] as const)('withholds a bare %s mutation without spawning the CLI', async (tool) => {
    const runCli = jest.fn<RunCli>();
    const handlers = registerWithHandlers(runCli);

    // A bare (no claim evidence) role-specific mutation spawned from the MCP
    // server would silently inherit direct-CLI trust. The handler must refuse
    // it with a structured `{ error }` envelope and never reach runCli.
    const res = await handlers.get(tool)?.({});
    expect(parseToolResponse(res)).toEqual({
      error: expect.stringContaining('subprocess front end'),
    });
    expect(runCli).not.toHaveBeenCalled();
  });

  it('withholds a --step-targeted bare pass (still direct-CLI trust)', async () => {
    const runCli = jest.fn<RunCli>();
    const handlers = registerWithHandlers(runCli);

    const res = await handlers.get('pass')?.({ step: '2.1' });
    expect(parseToolResponse(res)).toEqual({
      error: expect.stringContaining('subprocess front end'),
    });
    expect(runCli).not.toHaveBeenCalled();
  });

  it('withholds a --step-targeted bare collect (still direct-CLI trust)', async () => {
    const runCli = jest.fn<RunCli>();
    const handlers = registerWithHandlers(runCli);

    // --step scopes the aggregation but carries no evidence: a step-targeted
    // bare collect still mints orchestrator trust and must be withheld.
    const res = await handlers.get('collect')?.({ step: '1' });
    expect(parseToolResponse(res)).toEqual({
      error: expect.stringContaining('subprocess front end'),
    });
    expect(runCli).not.toHaveBeenCalled();
  });

  it.each([
    ['pass'],
    ['fail'],
    ['delegate'],
    ['collect'],
  ] as const)('spawns a %s --claim-id claim-evidence mutation through the boundary', async (tool) => {
    const runCli = jest.fn<RunCli>().mockResolvedValue({ success: true, data: { ok: true } });
    const handlers = registerWithHandlers(runCli);

    const res = await handlers.get(tool)?.({ claimId: 'claim-1' });
    expect(runCli).toHaveBeenCalledWith([tool, '--claim-id', 'claim-1']);
    // The pass-through path surfaces the CLI's data payload to the MCP client.
    expect(parseToolResponse(res)).toEqual({ ok: true });
  });

  describe('explicit runId targeting', () => {
    const runId = `rd_${'a'.repeat(32)}`;

    it.each([
      ['pass'],
      ['fail'],
      ['complete'],
      ['stop'],
      ['collect'],
    ] as const)('withholds runId-only %s because runId is target selection', async (tool) => {
      const runCli = jest.fn<RunCli>().mockResolvedValue({ success: true, data: { ok: true } });
      const handlers = registerWithHandlers(runCli);

      const res = await handlers.get(tool)?.({ runId });
      expect(parseToolResponse(res)).toEqual({
        error: expect.stringContaining('subprocess front end'),
      });
      expect(runCli).not.toHaveBeenCalled();
    });

    it('withholds runId-only goto because runId is target selection', async () => {
      const runCli = jest.fn<RunCli>().mockResolvedValue({ success: true, data: { ok: true } });
      const handlers = registerWithHandlers(runCli);

      const res = await handlers.get('goto')?.({ step: '3', runId });
      expect(parseToolResponse(res)).toEqual({
        error: expect.stringContaining('subprocess front end'),
      });
      expect(runCli).not.toHaveBeenCalled();
    });

    it('withholds delegate with runId and keeps withholding it bare', async () => {
      const runCli = jest.fn<RunCli>().mockResolvedValue({ success: true, data: { ok: true } });
      const handlers = registerWithHandlers(runCli);

      const withRun = await handlers.get('delegate')?.({ runId });
      expect(parseToolResponse(withRun)).toEqual({
        error: expect.stringContaining('subprocess front end'),
      });
      expect(runCli).not.toHaveBeenCalled();

      const bare = await handlers.get('delegate')?.({});
      expect(parseToolResponse(bare)).toEqual({
        error: expect.stringContaining('subprocess front end'),
      });
      expect(runCli).not.toHaveBeenCalled();
    });
  });

  it('withholds delegate when a claim-looking token is an input-file value', async () => {
    const runCli = jest.fn<RunCli>();
    const handlers = registerWithHandlers(runCli);

    await expect(
      handlers.get('delegate')?.({
        runbook: 'child.md',
        inputFile: ['--claim-id=foo'],
      }),
    ).resolves.toMatchObject({
      content: [
        {
          type: 'text',
          text: expect.stringMatching(/subprocess front end/),
        },
      ],
    });
    expect(runCli).not.toHaveBeenCalled();
  });

  it('spawns delegate claimId input through the CLI', async () => {
    const runCli = jest.fn<RunCli>();
    const handlers = registerWithHandlers(runCli);

    await expect(
      handlers.get('delegate')?.({
        runbook: 'child.md',
        claimId: 'rdclm_abcdefghijklmnopqrstu1',
      }),
    ).resolves.toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(runCli).toHaveBeenCalledWith([
      'delegate',
      'child.md',
      '--claim-id',
      'rdclm_abcdefghijklmnopqrstu1',
    ]);
  });
});
