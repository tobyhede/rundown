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
      { retry: true, step: '4.1', inputJson: ['vars={"mode":"fast"}'], inputFile: ['vars.yaml'] },
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
      { token: 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', inputJson: ['items=["a"]'] },
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

  it('renders CLI data as MCP text without interpreting runbook state', () => {
    expect(createMcpTextResponse({ data: { action: 'PASS', to: '2' } })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ action: 'PASS', to: '2' }, null, 2) }],
    });
  });

  it('renders explicit undefined data as JSON null per MCP envelope', () => {
    const response = createMcpTextResponse({ data: undefined });

    expect(response.content[0]?.text).toBe('null');
    expect(typeof response.content[0]?.text).toBe('string');
  });

  it('renders CLI errors as MCP text without replacing error shape', () => {
    expect(createMcpTextResponse({ error: 'No active runbook' })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ error: 'No active runbook' }, null, 2) }],
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
    expect(registered.get('delegate')).toMatchObject({
      config: {
        description: expect.stringContaining('Delegate'),
        inputSchema: expect.objectContaining({
          runbook: expect.any(Object),
          retry: expect.any(Object),
          input: expect.any(Object),
          inputJson: expect.any(Object),
          inputFile: expect.any(Object),
        }),
      },
    });
    expect(registered.get('claim')).toMatchObject({
      config: { inputSchema: expect.objectContaining({ token: expect.any(Object) }) },
    });
    expect(registered.get('collect')).toMatchObject({
      config: {
        inputSchema: expect.objectContaining({
          step: expect.any(Object),
          index: expect.any(Object),
          claimId: expect.any(Object),
        }),
      },
    });
    for (const tool of ['status', 'pass', 'fail', 'goto', 'complete', 'stop'] as const) {
      expect(registered.get(tool)).toMatchObject({
        config: { inputSchema: expect.objectContaining({ claimId: expect.any(Object) }) },
      });
    }
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
      .mockResolvedValue({ success: true, data: { delegated: true } });
    registerRundownTools(fakeServer, runCli);

    await expect(
      handlers.get('delegate')?.({ runbook: 'child.md', step: '1.1', input: ['env=prod'] }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ delegated: true }, null, 2) }],
    });
    expect(runCli).toHaveBeenCalledWith([
      'delegate',
      'child.md',
      '--step',
      '1.1',
      '--input',
      'env=prod',
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

    // `validate` requires `file: string`; missing it makes buildRundownCommand throw.
    await expect(handlers.get('validate')?.({})).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'validate.file must be a string' }, null, 2),
        },
      ],
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
      content: [{ type: 'text', text: JSON.stringify({ error: 'transport down' }, null, 2) }],
    });
  });
});
