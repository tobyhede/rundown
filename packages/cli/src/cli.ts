#!/usr/bin/env node
// packages/cli/src/cli.ts

import { Command } from 'commander';
import { registerRunCommand } from './commands/run.js';
import { registerGotoCommand } from './commands/goto.js';
import { registerPassCommand } from './commands/pass.js';
import { registerFailCommand } from './commands/fail.js';
import { registerCompleteCommand } from './commands/complete.js';
import { registerStatusCommand } from './commands/status.js';
import { registerStopCommand } from './commands/stop.js';
import { registerLsCommand } from './commands/ls.js';
import { registerStashCommand } from './commands/stash.js';
import { registerPopCommand } from './commands/pop.js';
import { registerEchoCommand } from './commands/echo.js';
import { registerCheckCommand } from './commands/check.js';
import { registerPruneCommand } from './commands/prune.js';
import { registerPromptCommand } from './commands/prompt.js';
import { registerScenariosCommand } from './commands/scenarios.js';
import { setColorEnabled } from '@rundown/core';
import {
  initializePolicyContext,
  parsePolicyCliOptions,
} from './services/policy-context.js';

const program = new Command();

program.name('rundown').description('Runbook orchestration CLI').version('1.0.0');

// Display options
program.option('--no-color', 'Disable colored output');

// Policy options
program
  .option('--allow-run <commands>', 'Allow specific commands (comma-separated)')
  .option('--allow-read <paths>', 'Allow reading specific paths (comma-separated)')
  .option('--allow-write <paths>', 'Allow writing to specific paths (comma-separated)')
  .option('--allow-env <vars>', 'Allow specific environment variables (comma-separated)')
  .option('--allow-all', 'Allow all operations (bypass policy)')
  .option('--deny-all', 'Deny all operations')
  .option('--policy <file>', 'Path to policy configuration file')
  .option('-y, --yes', 'Skip confirmation prompts')
  .option('--non-interactive', 'Non-interactive mode (no prompts, CI-friendly)');

// Initialize policy before subcommands
program.hook('preSubcommand', async (thisCommand) => {
  const opts = thisCommand.opts();
  const policyOpts = parsePolicyCliOptions(opts);
  await initializePolicyContext(policyOpts, process.cwd());
});

program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.color === false) {
    setColorEnabled(false);
  }
});

registerRunCommand(program);
registerPassCommand(program);
registerFailCommand(program);
registerCompleteCommand(program);
registerGotoCommand(program);
registerStatusCommand(program);
registerStopCommand(program);
registerLsCommand(program);
registerStashCommand(program);
registerPopCommand(program);
registerEchoCommand(program);
registerCheckCommand(program);
registerPruneCommand(program);
registerPromptCommand(program);
registerScenariosCommand(program);

program.parse();
