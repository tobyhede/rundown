#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runCli } from './cli.js';

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8')) as {
  version: string;
};
const VERSION: string = packageJson.version;

interface McpResponse {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
}

const toResponse = (r: { data?: unknown; error?: string }): McpResponse => ({
  content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? { error: r.error }, null, 2) }],
});

function createServer(): McpServer {
  const server = new McpServer({ name: 'rundown', version: VERSION });

  server.registerTool(
    'validate',
    {
      description: 'Check runbook syntax',
      inputSchema: { file: z.string() },
    },
    async ({ file }) => toResponse(await runCli(['check', file])),
  );

  server.registerTool(
    'list',
    {
      description: 'List runbooks',
      inputSchema: { all: z.boolean().optional(), tags: z.string().optional() },
    },
    async (args) => {
      const cmd = ['ls'];
      if (args.all) cmd.push('--all');
      if (args.tags) cmd.push('--tags', args.tags);
      return toResponse(await runCli(cmd));
    },
  );

  server.registerTool(
    'status',
    {
      description: 'Get runbook state',
      inputSchema: {},
    },
    async () => {
      return toResponse(await runCli(['status']));
    },
  );

  server.registerTool(
    'run',
    {
      description: 'Start runbook',
      inputSchema: {
        file: z.string().optional(),
        prompted: z.boolean().optional(),
      },
    },
    async (args) => {
      const cmd = ['run'];
      if (args.file) cmd.push(args.file);
      if (args.prompted) cmd.push('--prompted');
      return toResponse(await runCli(cmd));
    },
  );

  server.registerTool(
    'pass',
    {
      description: 'Mark step passed',
      inputSchema: {},
    },
    async () => {
      return toResponse(await runCli(['pass']));
    },
  );

  server.registerTool(
    'fail',
    {
      description: 'Mark step failed',
      inputSchema: {},
    },
    async () => {
      return toResponse(await runCli(['fail']));
    },
  );

  server.registerTool(
    'goto',
    {
      description: 'Jump to step',
      inputSchema: { step: z.string() },
    },
    async ({ step }) => toResponse(await runCli(['goto', step])),
  );

  server.registerTool(
    'complete',
    {
      description: 'Mark runbook complete',
      inputSchema: { message: z.string().optional() },
    },
    async (args) => {
      const cmd = ['complete'];
      if (args.message) cmd.push(args.message);
      return toResponse(await runCli(cmd));
    },
  );

  server.registerTool(
    'stop',
    {
      description: 'Stop runbook',
      inputSchema: { message: z.string().optional() },
    },
    async (args) => {
      const cmd = ['stop'];
      if (args.message) cmd.push(args.message);
      return toResponse(await runCli(cmd));
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('Rundown MCP Server running');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
