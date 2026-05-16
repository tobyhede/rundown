#!/usr/bin/env node
// packages/cli/src/cli.ts

import { Command, Option } from 'commander';
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
import { registerResolveCommand } from './commands/resolve.js';
import { registerPruneCommand } from './commands/prune.js';
import { registerPromptCommand } from './commands/prompt.js';
import { registerScenariosCommand } from './commands/scenarios.js';
import { registerScenarioSuiteCommand } from './commands/scenario-suite.js';
import { registerDelegateCommand } from './commands/delegate.js';
import { registerClaimCommand } from './commands/claim.js';
import { registerAbortCommand } from './commands/abort.js';
import { registerCollectCommand } from './commands/collect.js';
import { PolicyConfigTrustRequiredError, isError, setColorEnabled } from '@rundown-org/core';
import {
  initializePolicyContext,
  parsePolicyCliOptions,
  getPolicyContext,
} from './services/policy-context.js';
import { loadHelperModules, setHelperRegistry } from './services/helper-registry.js';
import { outputCommandSchema } from './services/schema-service.js';

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

// Detect whether this module is the CLI entry point (vs imported for createProgram)
const isEntryPoint = (() => {
  try {
    const thisFile = realpathSync(fileURLToPath(import.meta.url));
    const mainFile = realpathSync(process.argv[1] ?? '');
    return thisFile === mainFile;
  } catch {
    return false;
  }
})();

// Handle --schema flag early, before Commander parses arguments
// This allows schema output without requiring command arguments
if (isEntryPoint && process.argv.includes('--schema')) {
  // Extract command name(s) from argv (skip node, script, and flags)
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const commandName = args.join(' ');
  if (commandName) {
    const success = outputCommandSchema(commandName);
    process.exit(success ? 0 : 1);
  } else {
    console.error('Usage: rd <command> --schema');
    console.error('Example: rd status --schema');
    process.exit(1);
  }
}

/**
 * Create and configure the Commander program with all commands and hooks.
 * Extracted as a factory for in-process test execution.
 *
 * @returns Configured Commander program (not yet parsed)
 */
export function createProgram(): Command {
  const program = new Command();

  program.name('rundown').description('Runbook orchestration CLI').version('1.0.0');

  // Display options
  program.option('--no-color', 'Disable colored output');
  program.option('--schema', "Output JSON schema for the command's JSON output");

  // Policy options
  program
    .addOption(
      new Option('--allow-run <commands>', 'Allow specific commands (comma-separated)').helpGroup(
        'Policy options:',
      ),
    )
    .addOption(
      new Option(
        '--allow-read <paths>',
        'Allow reading specific paths (comma-separated)',
      ).helpGroup('Policy options:'),
    )
    .addOption(
      new Option(
        '--allow-write <paths>',
        'Allow writing to specific paths (comma-separated)',
      ).helpGroup('Policy options:'),
    )
    .addOption(
      new Option(
        '--allow-env <vars>',
        'Allow specific environment variables (comma-separated)',
      ).helpGroup('Policy options:'),
    )
    .addOption(
      new Option('--allow-all', 'Allow all operations (bypass policy)').helpGroup(
        'Policy options:',
      ),
    )
    .addOption(new Option('--deny-all', 'Deny all operations').helpGroup('Policy options:'))
    .addOption(
      new Option('--policy <file>', 'Path to policy configuration file').helpGroup(
        'Policy options:',
      ),
    )
    .addOption(
      new Option('--trust-js-policy', 'Trust executable JavaScript policy config files').helpGroup(
        'Policy options:',
      ),
    )
    .addOption(new Option('-y, --yes', 'Skip confirmation prompts').helpGroup('Policy options:'))
    .addOption(
      new Option('--non-interactive', 'Non-interactive mode (no prompts, CI-friendly)').helpGroup(
        'Policy options:',
      ),
    )
    // Sandbox options
    .addOption(
      new Option('--sandbox', 'Enable OS-level sandbox for file access enforcement').helpGroup(
        'Policy options:',
      ),
    )
    .addOption(
      new Option('--no-sandbox', 'Disable sandbox enforcement (trust mode)').helpGroup(
        'Policy options:',
      ),
    )
    .addOption(
      new Option('--sandbox-strict', 'Fail if sandbox is unavailable (strict mode)').helpGroup(
        'Policy options:',
      ),
    )
    .addOption(
      new Option(
        '--helpers <paths>',
        'Helper module paths to load (comma-separated, relative to project root)',
      ).helpGroup('Policy options:'),
    );

  // Initialize policy before subcommands
  program.hook('preSubcommand', async (thisCommand) => {
    const opts = thisCommand.opts();
    const policyOpts = parsePolicyCliOptions(opts);
    const cwd = process.cwd();
    await initializePolicyContext(policyOpts, cwd);
    const configHelpers = getPolicyContext().policy.helpers ?? [];
    const cliHelpers = policyOpts.helpers ?? [];
    const trustedConfigHelpers = policyOpts.trustJsPolicy ? configHelpers : [];
    if (configHelpers.length > 0 && !policyOpts.trustJsPolicy) {
      console.warn(
        'Warning: Policy-configured helper modules require --trust-js-policy and were skipped.',
      );
    }
    const allHelperPaths = [...trustedConfigHelpers, ...cliHelpers];
    // Always reset both registries so in-process re-entry (tests, hosts that
    // boot the CLI multiple times) cannot leak helpers from a prior invocation.
    // When no helpers are configured, install an empty registry rather than
    // skipping the call.
    const registry =
      allHelperPaths.length > 0
        ? await loadHelperModules(allHelperPaths, cwd, cwd)
        : new Map<string, (value: string) => string>();
    setHelperRegistry(registry);
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
  registerResolveCommand(program);
  registerPruneCommand(program);
  registerPromptCommand(program);
  registerScenariosCommand(program);
  registerScenarioSuiteCommand(program);
  registerDelegateCommand(program);
  registerClaimCommand(program);
  registerAbortCommand(program);
  registerCollectCommand(program);

  return program;
}

// Only auto-run when invoked as entry point
if (isEntryPoint) {
  const program = createProgram();
  program.parseAsync().catch((error: unknown) => {
    if (error instanceof PolicyConfigTrustRequiredError) {
      console.error(error.message);
    } else if (isError(error)) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
    process.exit(1);
  });
}
