import type { Step } from '../types.js';
/**
 * Render step for CLI output.
 * Order: heading → prompts → command block → response prompt
 * Excludes: transitions details, substeps (not needed for CLI display)
 */
export declare function renderStepForCLI(step: Step): string;
//# sourceMappingURL=render.d.ts.map