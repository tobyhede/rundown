#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';
import { registerRundownTools, type RunCli } from './tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8')) as {
  version: string;
};
const VERSION: string = packageJson.version;

/**
 * Create the Rundown MCP server and register CLI-facade tools.
 *
 * @param runCliFn - CLI runner used by registered tool handlers.
 * @returns Configured MCP server instance.
 */
export function createServer(runCliFn: RunCli = runCli): McpServer {
  const server = new McpServer({ name: 'rundown', version: VERSION });
  registerRundownTools(server, runCliFn);
  return server;
}

/**
 * Start the MCP server over stdio.
 *
 * @returns Promise that resolves once the server is connected.
 */
export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('Rundown MCP Server running');
}

/**
 * Check whether the current module is the process entrypoint.
 *
 * npm package binaries are commonly invoked through `.bin` symlinks, so this
 * compares canonical filesystem paths rather than raw argv/module URLs.
 *
 * @param moduleUrl - URL for the current module.
 * @param argvPath - Entrypoint path from `process.argv[1]`.
 * @returns True when `argvPath` resolves to `moduleUrl`.
 */
export function isDirectRun(moduleUrl: string, argvPath: string | undefined): boolean {
  if (argvPath === undefined) return false;

  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(modulePath) === realpathSync(argvPath);
  } catch {
    return resolve(modulePath) === resolve(argvPath);
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
