// packages/cli/src/commands/ls.ts

import type { Command } from 'commander';
import { RunbookStateManager, SessionService } from '@rundown-org/core';
import { discoverRunbooks } from '../services/discovery.js';
import { getCwd, getStepTotal } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getStatus } from '../helpers/status.js';

/**
 * Registers the 'ls' command for listing runbooks.
 * @param program - Commander program instance to register the command on
 */
export function registerLsCommand(program: Command): void {
  program
    .command('ls')
    .description('List runbooks (active by default, --all for available)')
    .option('-a, --all', 'List all available runbook files')
    .option('--text', 'Output as human-readable text')
    .option('--tags <tags>', 'Filter available runbooks by comma-separated tags')
    .action(async (options: { all?: boolean; text?: boolean; tags?: string }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text, command: 'ls' });

          // MODE 1: List available runbooks (--all)
          if (options.all) {
            let runbooks = await discoverRunbooks(cwd);

            // Filter by tags
            if (options.tags) {
              const filterTags = options.tags.split(',').map((t) => t.trim().toLowerCase());
              runbooks = runbooks.filter((w) =>
                w.tags?.some((tag) => filterTags.includes(tag.toLowerCase())),
              );
            }

            // Use list() for both modes - JSONRenderer outputs raw arrays for list-only events
            output.list(
              runbooks,
              [
                {
                  header: 'NAME',
                  key: 'name',
                },
                {
                  header: 'SOURCE',
                  key: 'source',
                },
                {
                  header: 'DESCRIPTION',
                  key: (w) => w.description ?? '',
                },
                {
                  header: 'TAGS',
                  key: (w) => w.tags?.join(', ') ?? '',
                },
              ],
              {
                emptyMessage: 'No runbooks found.',
                jsonMapper: (w) => ({
                  name: w.name,
                  source: w.source,
                  description: w.description,
                  tags: w.tags,
                  path: w.path,
                }),
              },
            );
            output.flush();
            return;
          }

          // MODE 2: List active runbooks (default)
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const states = await manager.list();
          const active = await sessionService.getActive();
          const stashedId = await sessionService.getStashedRunbookId();

          // Pre-calculate derived data for table display
          const enrichedStates = await Promise.all(
            states.map(async (state) => {
              const status = getStatus(state, active, stashedId);

              const runbookPath = state.runbook.path;
              const totalSteps = await getStepTotal(cwd, state.runbook);
              const displayStep = state.step;

              return {
                ...state,
                runbook: runbookPath,
                _status: status,
                _displayStep: `${displayStep}/${String(totalSteps)}`,
                _step: displayStep,
                _total: totalSteps,
              };
            }),
          );

          // Use list() for both modes - JSONRenderer outputs raw arrays for list-only events
          output.list(
            enrichedStates,
            [
              { header: 'ID', key: (s) => s.id.slice(0, 8) },
              { header: 'STATUS', key: (s) => s._status },
              { header: 'STEP', key: (s) => s._displayStep },
              { header: 'RUNBOOK', key: 'runbook' },
              { header: 'TITLE', key: (s) => s.title ?? '' },
            ],
            {
              emptyMessage:
                'No active runbooks.\nRun "rundown ls --all" to see available runbooks.',
              jsonMapper: (s) => ({
                // Emit only the documented ActiveRunbookEntry fields
                // (docs/spec/cli-output.md). Spreading the enriched state
                // would leak internal RunbookState fields into JSON output.
                id: s.id,
                runbook: s.runbook,
                step: s._step,
                status: s._status,
                total: s._total,
                title: s.title,
              }),
            },
          );
          output.flush();
        },
        { text: options.text },
      );
    });
}
