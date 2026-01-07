// packages/cli/src/commands/ls.ts
import { WorkflowStateManager, printNoWorkflows, printWorkflowListEntry, } from '@rundown/core';
import { discoverRunbooks } from '../services/discovery.js';
import { getCwd, getStepCount } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
export function registerLsCommand(program) {
    program
        .command('ls')
        .description('List workflows (active by default, --all for available)')
        .option('-a, --all', 'List all available workflow files')
        .option('--json', 'Output as JSON for programmatic use')
        .option('--tags <tags>', 'Filter available workflows by comma-separated tags')
        .action(async (options) => {
        await withErrorHandling(async () => {
            const cwd = getCwd();
            // MODE 1: List available workflows (--all)
            if (options.all) {
                let runbooks = await discoverRunbooks(cwd);
                // Filter by tags
                if (options.tags) {
                    const filterTags = options.tags.split(',').map((t) => t.trim().toLowerCase());
                    runbooks = runbooks.filter((w) => w.tags?.some((tag) => filterTags.includes(tag.toLowerCase())));
                }
                if (runbooks.length === 0) {
                    if (options.json) {
                        console.log('[]');
                    }
                    else {
                        console.log('No runbooks found.');
                    }
                    return;
                }
                if (options.json) {
                    const output = runbooks.map((w) => ({
                        name: w.name,
                        source: w.source,
                        description: w.description,
                        tags: w.tags,
                        path: w.path,
                    }));
                    console.log(JSON.stringify(output, null, 2));
                    return;
                }
                console.log('Available runbooks:\n');
                for (const workflow of runbooks) {
                    const displayName = workflow.source === 'plugin' ? `${workflow.name} [${workflow.source}]` : workflow.name;
                    const description = workflow.description ? ` - ${workflow.description}` : '';
                    console.log(`  ${displayName}${description}`);
                }
                console.log("\nUse 'tsv run <name>' to run a workflow.");
                return;
            }
            // MODE 2: List active workflows (default)
            const manager = new WorkflowStateManager(cwd);
            const states = await manager.list();
            const active = await manager.getActive();
            const stashedId = await manager.getStashedWorkflowId();
            if (states.length === 0) {
                if (options.json) {
                    console.log('[]');
                }
                else {
                    printNoWorkflows();
                }
                return;
            }
            if (options.json) {
                console.log(JSON.stringify(states, null, 2));
                return;
            }
            for (const state of states) {
                let status;
                if (active?.id === state.id) {
                    status = 'active';
                }
                else if (state.id === stashedId) {
                    status = 'stashed';
                }
                else if (state.variables.completed) {
                    status = 'complete';
                }
                else if (state.variables.stopped) {
                    status = 'stopped';
                }
                else {
                    status = 'inactive';
                }
                const totalSteps = await getStepCount(cwd, state.workflow);
                const stepStr = `${String(state.step)}/${String(totalSteps)}`;
                printWorkflowListEntry(state.id, status, stepStr, state.workflow, state.title);
            }
        });
    });
}
//# sourceMappingURL=ls.js.map