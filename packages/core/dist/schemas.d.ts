import { z } from 'zod';
export * from '@rundown/parser';
/**
 * Zod schema for HookInput - validates external input at system boundary
 */
export declare const HookInputSchema: z.ZodObject<{
    hook_event_name: z.ZodString;
    cwd: z.ZodString;
    tool_name: z.ZodOptional<z.ZodString>;
    file_path: z.ZodOptional<z.ZodString>;
    tool_input: z.ZodOptional<z.ZodObject<{
        description: z.ZodOptional<z.ZodString>;
        subagent_type: z.ZodOptional<z.ZodString>;
        prompt: z.ZodOptional<z.ZodString>;
        skill: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        description?: string | undefined;
        subagent_type?: string | undefined;
        prompt?: string | undefined;
        skill?: string | undefined;
    }, {
        description?: string | undefined;
        subagent_type?: string | undefined;
        prompt?: string | undefined;
        skill?: string | undefined;
    }>>;
    agent_id: z.ZodOptional<z.ZodString>;
    agent_name: z.ZodOptional<z.ZodString>;
    subagent_name: z.ZodOptional<z.ZodString>;
    output: z.ZodOptional<z.ZodString>;
    agent_transcript_path: z.ZodOptional<z.ZodString>;
    user_message: z.ZodOptional<z.ZodString>;
    command: z.ZodOptional<z.ZodString>;
    skill: z.ZodOptional<z.ZodString>;
    tool_use_id: z.ZodOptional<z.ZodString>;
    tool_response: z.ZodOptional<z.ZodUnknown>;
    step_id: z.ZodOptional<z.ZodString>;
    task_id: z.ZodOptional<z.ZodString>;
    subagent_type: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    hook_event_name: string;
    cwd: string;
    subagent_type?: string | undefined;
    skill?: string | undefined;
    tool_name?: string | undefined;
    file_path?: string | undefined;
    tool_input?: {
        description?: string | undefined;
        subagent_type?: string | undefined;
        prompt?: string | undefined;
        skill?: string | undefined;
    } | undefined;
    agent_id?: string | undefined;
    agent_name?: string | undefined;
    subagent_name?: string | undefined;
    output?: string | undefined;
    agent_transcript_path?: string | undefined;
    user_message?: string | undefined;
    command?: string | undefined;
    tool_use_id?: string | undefined;
    tool_response?: unknown;
    step_id?: string | undefined;
    task_id?: string | undefined;
}, {
    hook_event_name: string;
    cwd: string;
    subagent_type?: string | undefined;
    skill?: string | undefined;
    tool_name?: string | undefined;
    file_path?: string | undefined;
    tool_input?: {
        description?: string | undefined;
        subagent_type?: string | undefined;
        prompt?: string | undefined;
        skill?: string | undefined;
    } | undefined;
    agent_id?: string | undefined;
    agent_name?: string | undefined;
    subagent_name?: string | undefined;
    output?: string | undefined;
    agent_transcript_path?: string | undefined;
    user_message?: string | undefined;
    command?: string | undefined;
    tool_use_id?: string | undefined;
    tool_response?: unknown;
    step_id?: string | undefined;
    task_id?: string | undefined;
}>;
export type HookInput = z.infer<typeof HookInputSchema>;
/**
 * Result type for parseHookInput
 */
export type ParseResult<T> = {
    success: true;
    data: T;
} | {
    success: false;
    error: string;
};
/**
 * Parse and validate HookInput from JSON string
 */
export declare function parseHookInput(json: string): ParseResult<HookInput>;
/**
 * Session State Schema - Runtime Validation for Persisted State
 */
export declare const SessionStateSchema: z.ZodObject<{
    session_id: z.ZodDefault<z.ZodString>;
    started_at: z.ZodDefault<z.ZodString>;
    active_command: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    active_skill: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    edited_files: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    file_extensions: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    metadata: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    session_id: string;
    started_at: string;
    active_command: string | null;
    active_skill: string | null;
    edited_files: string[];
    file_extensions: string[];
    metadata: Record<string, unknown>;
}, {
    session_id?: string | undefined;
    started_at?: string | undefined;
    active_command?: string | null | undefined;
    active_skill?: string | null | undefined;
    edited_files?: string[] | undefined;
    file_extensions?: string[] | undefined;
    metadata?: Record<string, unknown> | undefined;
}>;
export type ValidatedSessionState = z.infer<typeof SessionStateSchema>;
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
        status: "pending" | "running" | "complete" | "stopped";
        id: string;
        subagentType?: string | undefined;
        startedAt?: string | undefined;
        completedAt?: string | undefined;
    }, {
        status: "pending" | "running" | "complete" | "stopped";
        id: string;
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
        status: "running" | "done" | "stopped";
        stepId: {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        };
        result?: "pass" | "fail" | undefined;
        childWorkflowId?: string | undefined;
    }, {
        status: "running" | "done" | "stopped";
        stepId: {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        };
        result?: "pass" | "fail" | undefined;
        childWorkflowId?: string | undefined;
    }>>;
    substepStates: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        status: z.ZodEnum<["pending", "running", "done"]>;
        agentId: z.ZodOptional<z.ZodString>;
        result: z.ZodOptional<z.ZodEnum<["pass", "fail"]>>;
    }, "strip", z.ZodTypeAny, {
        status: "pending" | "running" | "done";
        id: string;
        agentId?: string | undefined;
        result?: "pass" | "fail" | undefined;
    }, {
        status: "pending" | "running" | "done";
        id: string;
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
    workflow: string;
    id: string;
    step: number & z.BRAND<"StepNumber">;
    stepName: string;
    retryCount: number;
    variables: Record<string, string | number | boolean>;
    steps: {
        status: "pending" | "running" | "complete" | "stopped";
        id: string;
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
        status: "running" | "done" | "stopped";
        stepId: {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        };
        result?: "pass" | "fail" | undefined;
        childWorkflowId?: string | undefined;
    }>;
    updatedAt: string;
    description?: string | undefined;
    agentId?: string | undefined;
    title?: string | undefined;
    substep?: string | undefined;
    substepStates?: {
        status: "pending" | "running" | "done";
        id: string;
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
    workflow: string;
    id: string;
    step: number;
    stepName: string;
    retryCount: number;
    variables: Record<string, string | number | boolean>;
    steps: {
        status: "pending" | "running" | "complete" | "stopped";
        id: string;
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
        status: "running" | "done" | "stopped";
        stepId: {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        };
        result?: "pass" | "fail" | undefined;
        childWorkflowId?: string | undefined;
    }>;
    updatedAt: string;
    description?: string | undefined;
    agentId?: string | undefined;
    title?: string | undefined;
    substep?: string | undefined;
    substepStates?: {
        status: "pending" | "running" | "done";
        id: string;
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