/**
 * Render step for CLI output.
 * Order: heading → prompts → command block → response prompt
 * Excludes: transitions details, substeps (not needed for CLI display)
 */
export function renderStepForCLI(step) {
    const lines = [];
    // Header
    lines.push(`## ${String(step.number)}. ${step.description}`);
    // Prompts (before command per spec)
    for (const prompt of step.prompts) {
        lines.push('');
        lines.push(prompt.text);
    }
    // Command block
    if (step.command) {
        lines.push('');
        lines.push('```bash');
        lines.push(step.command.code);
        lines.push('```');
    }
    // Response prompt based on transition kinds
    if (step.transitions) {
        const isYesNo = step.transitions.pass.kind === 'yes' || step.transitions.fail.kind === 'no';
        lines.push('');
        if (isYesNo) {
            lines.push('Yes/No? (tsv yes | tsv no)');
        }
        else {
            lines.push('Pass/Fail? (tsv pass | tsv fail)');
        }
    }
    return lines.join('\n');
}
//# sourceMappingURL=render.js.map