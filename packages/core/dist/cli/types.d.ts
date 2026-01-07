/**
 * Workflow metadata for display
 */
export interface WorkflowMetadata {
    file: string;
    state: string;
    prompted?: boolean;
}
/**
 * Step position (n/N format)
 */
export interface StepPosition {
    current: number;
    total: number;
    substep?: string;
}
/**
 * Action block data
 */
export interface ActionBlockData {
    action: string;
    from?: StepPosition;
    result?: 'PASS' | 'FAIL';
}
//# sourceMappingURL=types.d.ts.map