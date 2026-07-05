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
  const claimCapability = 'rdcc_abcdefghijklmnopqrstu1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const runCapability =
    'rdrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  it.each([
    ['validate', { file: 'workflow.md' }, ['check', 'workflow.md']],
    ['list', { all: true, tags: 'release,prod' }, ['ls', '--all', '--tags', 'release,prod']],
    ['status', { claimId: 'claim-1' }, ['status', '--claim-id', 'claim-1']],
    ['run', { file: 'workflow.md', prompted: true }, ['run', 'workflow.md', '--prompted']],
    [
      'pass',
      { step: '2.1', index: 3, claimCapability },
      ['pass', '--step', '2.1', '--index', '3', '--claim-capability', claimCapability],
    ],
    [
      'fail',
      { step: '2.1', index: 3, claimCapability },
      ['fail', '--step', '2.1', '--index', '3', '--claim-capability', claimCapability],
    ],
    [
      'goto',
      { step: '3.1', index: 2, claimCapability },
      ['goto', '3.1', '--index', '2', '--claim-capability', claimCapability],
    ],
    [
      'complete',
      { message: 'done', claimCapability },
      ['complete', 'done', '--claim-capability', claimCapability],
    ],
    [
      'stop',
      { message: 'blocked', claimCapability },
      ['stop', 'blocked', '--claim-capability', claimCapability],
    ],
    ['delegate', { step: '4.1', index: 2 }, ['delegate', '--step', '4.1', '--index', '2']],
    [
      'delegate',
      { runbook: 'child.md', step: '1', input: ['env=prod'] },
      ['delegate', 'child.md', '--step', '1', '--input', 'env=prod'],
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
      { step: '5', index: 2, claimCapability },
      ['collect', '--step', '5', '--index', '2', '--claim-capability', claimCapability],
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

  it('maps runCapability to --run-capability', () => {
    expect(buildRundownCommand('collect', { runCapability })).toEqual([
      'collect',
      '--run-capability',
      runCapability,
    ]);
  });

  it('maps claimCapability to --claim-capability', () => {
    expect(buildRundownCommand('pass', { claimCapability })).toEqual([
      'pass',
      '--claim-capability',
      claimCapability,
    ]);
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

describe('inputSchema enforces claimCapability/runCapability mutual exclusion', () => {
  // Every tool whose schema accepts both authority credentials. Run and claim
  // capabilities name two different authorities; the schema
  // must fail the conflict closed before the handler spawns anything.
  const dualAuthorityTools = ['pass', 'fail', 'goto', 'complete', 'stop', 'collect'] as const;
  const runCapability =
    'rdrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const claimCapability = 'rdcc_abcdefghijklmnopqrstu1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  // `goto` requires `step`; harmless extra field for the rest.
  const withStep = { step: '3.1' };

  describe.each(dualAuthorityTools)('%s', (tool) => {
    const schema = RUNDOWN_TOOL_DEFINITIONS[tool].inputSchema;

    it('accepts claimCapability alone', () => {
      expect(schema.safeParse({ ...withStep, claimCapability }).success).toBe(true);
    });

    it('accepts runCapability alone', () => {
      expect(schema.safeParse({ ...withStep, runCapability }).success).toBe(true);
    });

    it('rejects claimCapability + runCapability together with a clear conflict message', () => {
      const result = schema.safeParse({ ...withStep, claimCapability, runCapability });
      expect(result.success).toBe(false);
      if (!result.success) {
        const conflictIssue = result.error.issues.find(
          (issue) => issue.path.length === 1 && issue.path[0] === 'runCapability',
        );
        expect(conflictIssue).toBeDefined();
        expect(conflictIssue?.message).toMatch(
          /claimCapability and runCapability are mutually exclusive/,
        );
      }
    });
  });
});

describe('registerRundownTools', () => {
  const claimCapability = 'rdcc_abcdefghijklmnopqrstu1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const runCapability =
    'rdrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

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
        runCapability,
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
        claimCapability,
      }).success,
    ).toBe(true);
    expect(
      RUNDOWN_TOOL_DEFINITIONS.status.inputSchema.safeParse({ claimId: 'claim-1' }).success,
    ).toBe(true);
    for (const tool of ['pass', 'fail', 'complete', 'stop'] as const) {
      expect(
        RUNDOWN_TOOL_DEFINITIONS[tool].inputSchema.safeParse({
          claimCapability,
        }).success,
      ).toBe(true);
    }
    expect(RUNDOWN_TOOL_DEFINITIONS.goto.inputSchema.safeParse({ step: '3.1' }).success).toBe(true);
  });

  it('rejects claimCapability on the delegate tool schema', () => {
    const result = RUNDOWN_TOOL_DEFINITIONS.delegate.inputSchema.safeParse({
      runbook: 'child.md',
      claimCapability,
    });

    expect(result.success).toBe(false);
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

    await expect(handlers.get('collect')?.({ step: '1.1', claimCapability })).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ collected: true }, null, 2) }],
    });
    expect(runCli).toHaveBeenCalledWith([
      'collect',
      '--step',
      '1.1',
      '--claim-capability',
      claimCapability,
    ]);
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
    'collect',
  ] as const)('%s handler rejects claimCapability + runCapability together before invoking the CLI', async (tool) => {
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

    // Both authorities at once is always a conflict; it must fail closed at
    // schema validation, never reach a spawned CLI to be refused post-spawn.
    const res = await handlers.get(tool)?.({
      step: '3.1',
      claimCapability,
      runCapability,
    });
    expect(res).toMatchObject({
      content: [
        {
          type: 'text',
          text: expect.stringMatching(
            /runCapability: claimCapability and runCapability are mutually exclusive/,
          ),
        },
      ],
    });
    expect(runCli).not.toHaveBeenCalled();
  });
});

describe('subprocess trust boundary', () => {
  const claimCapability = 'rdcc_abcdefghijklmnopqrstu1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const runCapability =
    'rdrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

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

  it('advertises delegate as runCapability-gated: available WITH runCapability, withheld bare', () => {
    // Post-R1 the delegate tool is available with explicit run capability
    // targeting; a bare call is still withheld. The description must name both
    // the constraint and the honest paths (runCapability, or run
    // `rundown delegate` directly).
    const { description } = RUNDOWN_TOOL_DEFINITIONS.delegate;
    expect(description).toMatch(/runCapability/);
    expect(description).toMatch(/withheld bare/i);
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
    ['collect'],
  ] as const)('spawns a %s --claim-capability mutation through the boundary', async (tool) => {
    const runCli = jest.fn<RunCli>().mockResolvedValue({ success: true, data: { ok: true } });
    const handlers = registerWithHandlers(runCli);

    const res = await handlers.get(tool)?.({ claimCapability });
    expect(runCli).toHaveBeenCalledWith([tool, '--claim-capability', claimCapability]);
    // The pass-through path surfaces the CLI's data payload to the MCP client.
    expect(parseToolResponse(res)).toEqual({ ok: true });
  });

  describe('explicit runCapability targeting', () => {
    it.each([
      ['pass'],
      ['fail'],
      ['complete'],
      ['stop'],
      ['collect'],
    ] as const)('forwards runCapability as --run-capability argv on %s', async (tool) => {
      const runCli = jest.fn<RunCli>().mockResolvedValue({ success: true, data: { ok: true } });
      const handlers = registerWithHandlers(runCli);

      const res = await handlers.get(tool)?.({ runCapability });
      expect(runCli).toHaveBeenCalledWith([tool, '--run-capability', runCapability]);
      expect(parseToolResponse(res)).toEqual({ ok: true });
    });

    it('forwards runCapability as --run-capability argv on goto', async () => {
      const runCli = jest.fn<RunCli>().mockResolvedValue({ success: true, data: { ok: true } });
      const handlers = registerWithHandlers(runCli);

      await handlers.get('goto')?.({ step: '3', runCapability });
      expect(runCli).toHaveBeenCalledWith(['goto', '3', '--run-capability', runCapability]);
    });

    it('spawns delegate WITH runCapability and keeps withholding it bare', async () => {
      // The single most behavior-inverting MCP change in R1: delegate was
      // withheld-always; an explicit run capability names orchestrator
      // authority and spawns, while the bare form stays withheld.
      const runCli = jest.fn<RunCli>().mockResolvedValue({ success: true, data: { ok: true } });
      const handlers = registerWithHandlers(runCli);

      await handlers.get('delegate')?.({ runCapability });
      expect(runCli).toHaveBeenCalledWith(['delegate', '--run-capability', runCapability]);

      runCli.mockClear();
      const bare = await handlers.get('delegate')?.({});
      expect(parseToolResponse(bare)).toEqual({
        error: expect.stringContaining('subprocess front end'),
      });
      expect(runCli).not.toHaveBeenCalled();
    });
  });

  it('withholds delegate when a claim-capability-looking token is an input-file value', async () => {
    const runCli = jest.fn<RunCli>();
    const handlers = registerWithHandlers(runCli);

    await expect(
      handlers.get('delegate')?.({
        runbook: 'child.md',
        inputFile: ['--claim-capability=foo'],
      }),
    ).resolves.toMatchObject({
      content: [
        {
          type: 'text',
          text: expect.stringMatching(/does not accept claim authority/),
        },
      ],
    });
    expect(runCli).not.toHaveBeenCalled();
  });

  it('rejects delegate claimCapability input without spawning the CLI', async () => {
    const runCli = jest.fn<RunCli>();
    const handlers = registerWithHandlers(runCli);

    await expect(
      handlers.get('delegate')?.({
        runbook: 'child.md',
        claimCapability,
      }),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: expect.stringMatching(/claimCapability/) }],
    });
    expect(runCli).not.toHaveBeenCalled();
  });
});
