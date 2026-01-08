import type { Step } from '../workflow/types.js';
/**
 * Render step for CLI output.
 * Order: heading → prompts → command block
 * Excludes: transitions, substeps (not needed for CLI display)
 */
export declare function renderStepForCLI(step: Step): string;
//# sourceMappingURL=render.d.ts.map