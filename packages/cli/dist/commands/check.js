import * as fs from 'fs';
import * as path from 'path';
import { parseWorkflowDocument, validateWorkflow } from '@rundown/parser';
function formatErrors(errors) {
    return errors
        .map(e => e.line ? `Line ${String(e.line)}: ${e.message}` : e.message)
        .join('\n');
}
function countSubsteps(steps) {
    return steps.reduce((count, step) => {
        return count + (step.substeps?.length ?? 0);
    }, 0);
}
export function registerCheckCommand(program) {
    program
        .command('check <file>')
        .description('Check a workflow file for errors')
        .action((file) => {
        // Resolve file path
        const resolvedPath = path.resolve(file);
        if (!fs.existsSync(resolvedPath)) {
            console.error(`FAIL: File not found: ${file}`);
            process.exit(1);
        }
        try {
            const content = fs.readFileSync(resolvedPath, 'utf-8');
            const workflow = parseWorkflowDocument(content, path.basename(resolvedPath), { skipValidation: true });
            const errors = validateWorkflow(workflow.steps);
            if (errors.length > 0) {
                console.error(`FAIL: ${String(errors.length)} error${errors.length > 1 ? 's' : ''}\n`);
                console.error(formatErrors(errors));
                process.exit(1);
            }
            const stepCount = workflow.steps.length;
            const substepCount = countSubsteps(workflow.steps);
            if (substepCount > 0) {
                console.log(`PASS: ${String(stepCount)} step${stepCount > 1 ? 's' : ''}, ${String(substepCount)} substep${substepCount > 1 ? 's' : ''}`);
            }
            else {
                console.log(`PASS: ${String(stepCount)} step${stepCount > 1 ? 's' : ''}`);
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`FAIL: ${message}`);
            process.exit(1);
        }
    });
}
//# sourceMappingURL=check.js.map