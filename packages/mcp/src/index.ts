#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runCli } from './cli.js';

const toResponse = (r: { data?: unknown; error?: string }) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? { error: r.error }, null, 2) }]
});

function createServer(): McpServer {
  const server = new McpServer({ name: 'rundown', version: '1.0.0' });

  server.tool('validate', 'Check runbook syntax',
    { file: z.string() },
    async ({ file }) => toResponse(await runCli(['check', file])));

  server.tool('list', 'List runbooks',
    { all: z.boolean().optional(), tags: z.string().optional() },
    async (args) => {
      const cmd = ['ls'];
      if (args.all) cmd.push('--all');
      if (args.tags) cmd.push('--tags', args.tags);
      return toResponse(await runCli(cmd));
    });

  server.tool('status', 'Get runbook state',
    { agent: z.string().optional() },
    async (args) => {
      const cmd = ['status'];
      if (args.agent) cmd.push('--agent', args.agent);
      return toResponse(await runCli(cmd));
    });

  server.tool('run', 'Start runbook',
    { file: z.string().optional(), step: z.string().optional(), agent: z.string().optional(), prompted: z.boolean().optional() },
    async (args) => {
      const cmd = ['run'];
      if (args.file) cmd.push(args.file);
      if (args.step) cmd.push('--step', args.step);
      if (args.agent) cmd.push('--agent', args.agent);
      if (args.prompted) cmd.push('--prompted');
      return toResponse(await runCli(cmd));
    });

  server.tool('pass', 'Mark step passed',
    { agent: z.string().optional() },
    async (args) => {
      const cmd = ['pass'];
      if (args.agent) cmd.push('--agent', args.agent);
      return toResponse(await runCli(cmd));
    });

  server.tool('fail', 'Mark step failed',
    { agent: z.string().optional() },
    async (args) => {
      const cmd = ['fail'];
      if (args.agent) cmd.push('--agent', args.agent);
      return toResponse(await runCli(cmd));
    });

  server.tool('goto', 'Jump to step',
    { step: z.string() },
    async ({ step }) => toResponse(await runCli(['goto', step])));

  server.tool('complete', 'Mark runbook complete',
    { message: z.string().optional() },
    async (args) => {
      const cmd = ['complete'];
      if (args.message) cmd.push(args.message);
      return toResponse(await runCli(cmd));
    });

  server.tool('stop', 'Stop runbook',
    { message: z.string().optional() },
    async (args) => {
      const cmd = ['stop'];
      if (args.message) cmd.push(args.message);
      return toResponse(await runCli(cmd));
    });

  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('Rundown MCP Server running');
}

main().catch(e => { console.error(e); process.exit(1); });
