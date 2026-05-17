import { describe, expect, it, jest } from '@jest/globals';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUNDOWN_TOOL_NAMES, type RunCli } from '../src/tools.js';

const mockConnect = jest.fn();
const mockRegisterTool = jest.fn();

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    registerTool: mockRegisterTool,
  })),
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn(),
}));

const { createServer, isDirectRun } = await import('../src/index.js');

describe('MCP server entrypoint', () => {
  it('does not connect stdio when imported for tests', () => {
    createServer(jest.fn<RunCli>());

    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockRegisterTool).toHaveBeenCalledTimes(RUNDOWN_TOOL_NAMES.length);
  });

  it('recognizes direct execution through an npm bin symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rundown-mcp-bin-'));
    try {
      const realEntrypoint = join(dir, 'dist', 'index.js');
      const binPath = join(dir, 'node_modules', '.bin', 'rundown-mcp');
      await mkdir(join(dir, 'dist'), { recursive: true });
      await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
      await writeFile(realEntrypoint, '');
      await symlink(realEntrypoint, binPath);

      expect(isDirectRun(pathToFileURL(realEntrypoint).href, binPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
