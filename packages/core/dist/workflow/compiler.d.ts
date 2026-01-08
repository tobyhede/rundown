import { type Step } from './types.js';
import type { StepId } from './step-id.js';
export interface WorkflowContext {
    retryCount: number;
    substep?: string;
    nextInstance?: boolean;
    variables: Record<string, boolean | number | string>;
}
export type WorkflowEvent = {
    type: 'PASS';
} | {
    type: 'FAIL';
} | {
    type: 'RETRY';
} | {
    type: 'GOTO';
    target: StepId;
};
export declare function compileWorkflowToMachine(steps: Step[]): import("xstate").StateMachine<WorkflowContext, {
    type: "PASS";
} | {
    type: "FAIL";
} | {
    type: "RETRY";
} | {
    type: "GOTO";
    target: StepId;
}, {}, never, never, never, never, "COMPLETE" | "STOPPED", string, import("xstate").NonReducibleUnknown, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "workflow";
    states: {
        readonly COMPLETE: {};
        readonly STOPPED: {};
    };
}>;
//# sourceMappingURL=compiler.d.ts.map