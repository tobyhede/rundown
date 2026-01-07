import { z } from 'zod';
export * from '@rundown/parser';
/**
 * Workflow State Schema - Runtime Validation for Persisted WorkflowState
 */
export declare const WorkflowStateSchema: z.ZodObject<{
    id: z.ZodString;
    workflow: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    step: z.ZodBranded<z.ZodNumber, "StepNumber">;
    substep: z.ZodOptional<z.ZodString>;
    stepName: z.ZodString;
    retryCount: z.ZodNumber;
    variables: z.ZodRecord<z.ZodString, z.ZodUnion<[z.ZodBoolean, z.ZodNumber, z.ZodString]>>;
    steps: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        status: z.ZodEnum<["pending", "running", "complete", "stopped"]>;
        subagentType: z.ZodOptional<z.ZodString>;
        startedAt: z.ZodOptional<z.ZodString>;
        completedAt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        status: "running" | "stopped" | "pending" | "complete";
        subagentType?: string | undefined;
        startedAt?: string | undefined;
        completedAt?: string | undefined;
    }, {
        id: string;
        status: "running" | "stopped" | "pending" | "complete";
        subagentType?: string | undefined;
        startedAt?: string | undefined;
        completedAt?: string | undefined;
    }>, "many">;
    pendingSteps: z.ZodReadonly<z.ZodArray<z.ZodObject<{
        stepId: z.ZodEffects<z.ZodObject<{
            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
            substep: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        }, {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        }>, {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        }, {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        }>;
        workflow: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        stepId: {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        };
        workflow?: string | undefined;
    }, {
        stepId: {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        };
        workflow?: string | undefined;
    }>, "many">>;
    agentBindings: z.ZodRecord<z.ZodString, z.ZodObject<{
        stepId: z.ZodEffects<z.ZodObject<{
            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
            substep: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        }, {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        }>, {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        }, {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        }>;
        childWorkflowId: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<["running", "done", "stopped"]>;
        result: z.ZodOptional<z.ZodEnum<["pass", "fail"]>>;
    }, "strip", z.ZodTypeAny, {
        stepId: {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        };
        status: "running" | "done" | "stopped";
        result?: "pass" | "fail" | undefined;
        childWorkflowId?: string | undefined;
    }, {
        stepId: {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        };
        status: "running" | "done" | "stopped";
        result?: "pass" | "fail" | undefined;
        childWorkflowId?: string | undefined;
    }>>;
    substepStates: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        status: z.ZodEnum<["pending", "running", "done"]>;
        agentId: z.ZodOptional<z.ZodString>;
        result: z.ZodOptional<z.ZodEnum<["pass", "fail"]>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        status: "running" | "done" | "pending";
        agentId?: string | undefined;
        result?: "pass" | "fail" | undefined;
    }, {
        id: string;
        status: "running" | "done" | "pending";
        agentId?: string | undefined;
        result?: "pass" | "fail" | undefined;
    }>, "many">>;
    agentId: z.ZodOptional<z.ZodString>;
    parentWorkflowId: z.ZodOptional<z.ZodString>;
    parentStepId: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
        substep: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
        substep?: string | undefined;
    }, {
        step: number | "{N}" | "NEXT";
        substep?: string | undefined;
    }>, {
        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
        substep?: string | undefined;
    }, {
        step: number | "{N}" | "NEXT";
        substep?: string | undefined;
    }>>;
    nested: z.ZodOptional<z.ZodObject<{
        workflow: z.ZodString;
        instanceId: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        workflow: string;
        instanceId: string;
    }, {
        workflow: string;
        instanceId: string;
    }>>;
    startedAt: z.ZodString;
    updatedAt: z.ZodString;
    snapshot: z.ZodOptional<z.ZodUnknown>;
    prompted: z.ZodOptional<z.ZodBoolean>;
    lastResult: z.ZodOptional<z.ZodEnum<["pass", "fail"]>>;
}, "strip", z.ZodTypeAny, {
    retryCount: number;
    step: number & z.BRAND<"StepNumber">;
    id: string;
    workflow: string;
    variables: Record<string, string | number | boolean>;
    stepName: string;
    steps: {
        id: string;
        status: "running" | "stopped" | "pending" | "complete";
        subagentType?: string | undefined;
        startedAt?: string | undefined;
        completedAt?: string | undefined;
    }[];
    startedAt: string;
    pendingSteps: readonly {
        stepId: {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        };
        workflow?: string | undefined;
    }[];
    agentBindings: Record<string, {
        stepId: {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        };
        status: "running" | "done" | "stopped";
        result?: "pass" | "fail" | undefined;
        childWorkflowId?: string | undefined;
    }>;
    updatedAt: string;
    substep?: string | undefined;
    description?: string | undefined;
    agentId?: string | undefined;
    title?: string | undefined;
    substepStates?: {
        id: string;
        status: "running" | "done" | "pending";
        agentId?: string | undefined;
        result?: "pass" | "fail" | undefined;
    }[] | undefined;
    parentWorkflowId?: string | undefined;
    parentStepId?: {
        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
        substep?: string | undefined;
    } | undefined;
    nested?: {
        workflow: string;
        instanceId: string;
    } | undefined;
    snapshot?: unknown;
    prompted?: boolean | undefined;
    lastResult?: "pass" | "fail" | undefined;
}, {
    retryCount: number;
    step: number;
    id: string;
    workflow: string;
    variables: Record<string, string | number | boolean>;
    stepName: string;
    steps: {
        id: string;
        status: "running" | "stopped" | "pending" | "complete";
        subagentType?: string | undefined;
        startedAt?: string | undefined;
        completedAt?: string | undefined;
    }[];
    startedAt: string;
    pendingSteps: readonly {
        stepId: {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        };
        workflow?: string | undefined;
    }[];
    agentBindings: Record<string, {
        stepId: {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        };
        status: "running" | "done" | "stopped";
        result?: "pass" | "fail" | undefined;
        childWorkflowId?: string | undefined;
    }>;
    updatedAt: string;
    substep?: string | undefined;
    description?: string | undefined;
    agentId?: string | undefined;
    title?: string | undefined;
    substepStates?: {
        id: string;
        status: "running" | "done" | "pending";
        agentId?: string | undefined;
        result?: "pass" | "fail" | undefined;
    }[] | undefined;
    parentWorkflowId?: string | undefined;
    parentStepId?: {
        step: number | "{N}" | "NEXT";
        substep?: string | undefined;
    } | undefined;
    nested?: {
        workflow: string;
        instanceId: string;
    } | undefined;
    snapshot?: unknown;
    prompted?: boolean | undefined;
    lastResult?: "pass" | "fail" | undefined;
}>;
export type ValidatedWorkflowState = z.infer<typeof WorkflowStateSchema>;
//# sourceMappingURL=schemas.d.ts.map